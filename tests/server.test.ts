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
            const response = await fetch(`${origin}/api/jobs`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), []);
            assert.equal((await fetch(origin)).status, 200);
            assert.equal((await fetch(`${origin}/.data/browser/Default/Cookies`)).status, 404);
        } finally {
            child.kill('SIGTERM');
            await closed;
        }
        await assert.rejects(access(join(directory, 'server.lock')));
        assert.equal(stderr, '');
    });
}
