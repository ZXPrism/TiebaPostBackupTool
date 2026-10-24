import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { load_config } from '../src/service/config';

test('configuration requires every field and rejects unknown fields and unsafe values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-config-'));
    const file = join(root, 'config.json');
    const template = JSON.parse(await readFile('config.json', 'utf8'));
    for (const key of Object.keys(template)) {
        const value = structuredClone(template);
        delete value[key];
        await writeFile(file, JSON.stringify(value));
        assert.throws(() => load_config(file), new RegExp('缺少配置项：config\\.' + key));
    }
    for (const key of Object.keys(template.cos)) {
        const value = structuredClone(template);
        delete value.cos[key];
        await writeFile(file, JSON.stringify(value));
        assert.throws(() => load_config(file), /缺少配置项：config.cos/);
    }
    for (const patch of [
        { min_free_disk_bytes: 1073741823 }, { min_free_disk_bytes: "2147483648" }, { max_pending: 0 }, { max_pending: '20' }, { max_pending: 1.5 }, { image_concurrency: 0 },
        { api_request_interval_ms: 0 }, { port: 65536 }, { api_max_retries: -1 },
        { job_timeout_ms: 2147483648 }, { base_path: '//bad' }, { data_dir: '' },
        { cos: { ...template.cos, daily_traffic_limit_bytes: 0 } },
        { cos: { ...template.cos, traffic_check_interval_ms: 0 } },
        { typo: 1 }, { cos: { ...template.cos, enabled: true } },
    ]) {
        await writeFile(file, JSON.stringify({ ...template, ...patch }));
        assert.throws(() => load_config(file), /配置项/);
    }
    await writeFile(file, '{invalid');
    assert.throws(() => load_config(file), /不是有效 JSON/);
    assert.throws(() => load_config(join(root, 'absent.json')), /无法读取配置文件/);
});

test('startup requires the selected JSON and reads explicit values instead of legacy environment overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-config-start-'));
    const file = join(root, 'config.json');
    const value = JSON.parse(await readFile('config.json', 'utf8'));
    Object.assign(value, { data_dir: join(root, 'data'), port: 0, max_pending: 7,
        api_request_interval_ms: 1234, image_request_interval_ms: 345, api_max_retries: 1, image_concurrency: 2 });
    await writeFile(file, JSON.stringify(value));
    const env = { ...process.env, TIEBA_CONFIG: file, TIEBA_COOKIE: 'BDUSS=synthetic',
        PORT: 'invalid', TIEBA_API_INTERVAL_MS: 'invalid', TIEBA_DATA_DIR: join(root, 'wrong') };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let output = '';
    try {
        await new Promise<void>((resolve, reject) => {
            child.stdout.on('data', chunk => { output += chunk; if (output.includes('接口任务上限')) { resolve(); } });
            child.once('error', reject);
            child.once('exit', () => reject(new Error('服务提前退出')));
        });
        assert.match(output, /间隔至少 1234 ms/);
        assert.match(output, /重试 1 次；图片最多 2 并发/);
        const log = await readFile(join(root, 'data/jobs/service.log'), 'utf8');
        assert(log.includes('"max_pending":7'));
        await assert.rejects(access(join(root, 'wrong')));
    } finally { child.kill('SIGTERM'); await closed; }

    for (const contents of [undefined, '{}', '{invalid']) {
        const path = join(root, 'invalid.json');
        if (contents !== undefined) { await writeFile(path, contents); }
        const failed = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
            env: { ...env, TIEBA_CONFIG: path }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        failed.stderr.on('data', chunk => { stderr += chunk; });
        const [code] = await once(failed, 'close');
        assert.notEqual(code, 0);
        assert.match(stderr, /无法读取配置文件|缺少配置项|不是有效 JSON/);
        await assert.rejects(access(join(root, 'data/server.lock')));
    }
});

test('API attempts and image batches honor configured retry, timeout and concurrency values', async () => {
    const { config } = await import('../src/service/config');
    const { create_api_request, RequestPacer } = await import('../src/service/api');
    const { ImageHandler } = await import('../src/image_handler');
    const previous = { retries: config.api_max_retries, timeout: config.request_timeout_ms };
    let attempts = 0;
    try {
        config.api_max_retries = 1;
        config.request_timeout_ms = 1234;
        const request = create_api_request({
            async post(_url, options) {
                attempts++;
                assert.equal(options.timeout, 1234);
                return { status: () => 503, ok: () => false, headers: () => ({}),
                    text: async () => '', body: async () => Buffer.alloc(0), dispose: async () => {} };
            },
            async get() { throw new Error('unexpected GET'); },
        }, 'https://tieba.baidu.com/p/123', new RequestPacer(0), new AbortController().signal);
        await assert.rejects(request('/c/f/pb/page_pc', {}), /已重试 1 次，共 2 次请求/);
        assert.equal(attempts, 2);
    } finally {
        config.api_max_retries = previous.retries;
        config.request_timeout_ms = previous.timeout;
    }

    let current = 0, peak = 0;
    const handler = new ImageHandler(async () => {
        peak = Math.max(peak, ++current);
        await new Promise(resolve => setTimeout(resolve, 5));
        current--;
        return new Blob(['image'], { type: 'image/png' });
    }, { 'https://example.com/1': '1.png', 'https://example.com/2': '2.png', 'https://example.com/3': '3.png' }, 2, 0);
    const result = await handler.download_images();
    assert.equal(peak, 2);
    assert.equal(Object.keys(result).length, 3);
});
