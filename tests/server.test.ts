import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const backend of ['browser', 'api']) {
    test(`service entry (${backend}) starts with a durable lock and releases it on SIGTERM`, { timeout: 15000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'tieba-server-'));
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
            env: { ...process.env, TIEBA_BACKEND: backend, TIEBA_DATA_DIR: directory, HOST: '127.0.0.1', PORT: '0' },
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
            assert.equal((await fetch(`${origin}/.data/browser/Default/Cookies`)).status, 404);
            if (backend === 'browser') {
                const failed_directory = await mkdtemp(join(tmpdir(), 'tieba-server-failed-'));
                const failed = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
                    env: { ...process.env, TIEBA_BACKEND: backend, TIEBA_DATA_DIR: failed_directory,
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
}
