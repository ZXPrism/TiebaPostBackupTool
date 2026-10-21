import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('service starts, holds a durable lock and releases it on SIGTERM', { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tieba-server-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
        env: { ...process.env, TIEBA_DATA_DIR: directory, HOST: '127.0.0.1', PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    try {
        const origin = await new Promise<string>((resolve, reject) => {
            let output = '';
            child.stdout.on('data', chunk => {
                output += String(chunk);
                const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (match) { resolve(match[0]); }
            });
            child.once('error', reject);
            child.once('close', () => reject(new Error(stderr || 'Service exited before listening')));
        });
        assert.equal(await readFile(join(directory, 'server.lock'), 'utf8'), String(child.pid));
        const initial_log = await readFile(join(directory, 'jobs/service.log'), 'utf8');
        assert.match(initial_log, /"level":"info","event":"service_starting"/);
        assert.match(initial_log, /"level":"debug","event":"service_configuration"/);
        assert.match(initial_log, /"event":"service_listening"/);
        const response = await fetch(`${origin}/api/posts?url=123`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { post_id: 123, url: 'https://tieba.baidu.com/p/123', backups: [], last_attempt_failed: false });
        assert.equal((await fetch(`${origin}/api/jobs`)).status, 404);
        assert.equal((await fetch(origin)).status, 200);
        assert.equal((await fetch(`${origin}/.data/session.json`)).status, 404);
        {
            const failed_directory = await mkdtemp(join(tmpdir(), 'tieba-server-failed-'));
            const failed = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
                env: { ...process.env, TIEBA_DATA_DIR: failed_directory,
                    HOST: '127.0.0.1', PORT: new URL(origin).port }, stdio: 'ignore',
            });
            const [code] = await once(failed, 'close');
            assert.notEqual(code, 0);
            const failed_log = await readFile(join(failed_directory, 'jobs/service.log'), 'utf8');
            assert.match(failed_log, /"level":"fatal","event":"service_startup_failed"/);
            assert.match(failed_log, /EADDRINUSE/);
            await assert.rejects(access(join(failed_directory, 'server.lock')));
        }
    } finally {
        child.kill('SIGTERM');
        await closed;
    }
    await assert.rejects(access(join(directory, 'server.lock')));
    assert.equal(stderr, '');
    const final_log = await readFile(join(directory, 'jobs/service.log'), 'utf8');
    assert.match(final_log, /"level":"trace","event":"http_request"/);
    assert.match(final_log, /"level":"info","event":"http_response"/);
    assert.match(final_log, /"level":"warn","event":"http_response"/);
    assert.match(final_log, /"level":"info","event":"service_stopped"/);
});


test('native HTTP sends signed forms and cookies over the wire and does not follow redirects', async () => {
    const { createServer } = await import('node:http');
    const { open_http_session } = await import('../src/service/transport');
    const { create_api_request, RequestPacer } = await import('../src/service/api');
    const previous = process.env.TIEBA_COOKIE;
    process.env.TIEBA_COOKIE = 'BDUSS=synthetic-session';
    let requests = 0;
    const server = createServer(async (request, response) => {
        requests++;
        if (request.url === '/redirect') {
            response.writeHead(302, { Location: '/unexpected' }); response.end(); return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) { chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error_code: 0, data: { method: request.method,
            cookie: request.headers.cookie, type: request.headers['content-type'],
            kz: form.get('kz'), sign: form.get('sign'), referer: request.headers.referer } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const signal = new AbortController().signal;
    const session = await open_http_session(signal, (url, options) => fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, options));
    try {
        const result = await create_api_request(session.request, 'https://tieba.baidu.com/p/123', new RequestPacer(0), signal)('/c/f/pb/page_pc', { kz: '123' }) as Record<string, unknown>;
        assert.equal(result.method, 'POST');
        assert.equal(result.cookie, 'BDUSS=synthetic-session');
        assert.match(String(result.type), /application\/x-www-form-urlencoded/);
        assert.equal(result.kz, '123');
        assert.match(String(result.sign), /^[a-f0-9]{32}$/);
        assert.equal(result.referer, 'https://tieba.baidu.com/p/123');
        const response = await session.request.get('https://tieba.baidu.com/redirect', {});
        assert.equal(response.status(), 302);
        await response.dispose();
        assert.equal(requests, 2);
    } finally {
        await session.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (previous === undefined) { delete process.env.TIEBA_COOKIE; } else { process.env.TIEBA_COOKIE = previous; }
    }
});
