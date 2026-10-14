import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { get, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, gunzipSync, zstdDecompressSync } from 'node:zlib';
import { compressed_file, negotiate_encoding } from '../src/service/compression';
import { create_app } from '../src/service/http';
import { JobQueue } from '../src/service/queue';
import { ImageHandler } from '../src/image_handler';

const decode = (encoding: string, bytes: Buffer) => encoding === 'gzip' ? gunzipSync(bytes)
    : zstdDecompressSync(bytes, { params: { [constants.ZSTD_d_windowLogMax]: 23 } });

function raw(url: string, headers: Record<string, string> = {}, method = 'GET') {
    return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
        get(url, { headers, method }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('HTTP encoding negotiation respects quality, explicit refusals and identity', () => {
    for (const [header, expected] of [
        [undefined, 'identity'], ['', 'identity'], ['br', 'identity'], ['gzip, deflate, br, zstd', 'zstd'],
        ['zstd;q=0.5, gzip;q=1', 'gzip'], ['zstd;q=0, gzip', 'gzip'], ['gzip;q=0', 'identity'],
        ['identity;q=1, gzip;q=0.5', 'identity'], ['*', 'zstd'], ['*;q=0', undefined],
        ['*;q=0, gzip;q=0.2', 'gzip'], ['*;q=1, zstd;q=0', 'gzip'],
        ['identity;q=0, br', undefined], ['GZIP; Q=1', 'gzip'], ['gzip;q=invalid', 'identity'],
    ]) { assert.equal(negotiate_encoding(header), expected, String(header)); }
});

test('compression cache is lossless, shared, reusable and invalidated by source replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-compression-'));
    const file = join(root, 'backup.tar');
    const original = Buffer.from('原始备份内容\n'.repeat(10000));
    await writeFile(file, original);
    for (const encoding of ['zstd', 'gzip'] as const) {
        const first = compressed_file(file, encoding);
        assert.equal(compressed_file(file, encoding), first, 'Concurrent downloads share one compressor');
        const cached = await first;
        const bytes = await readFile(cached);
        assert(bytes.length < original.length);
        assert.deepEqual(decode(encoding, bytes), original);
        const before = await stat(cached, { bigint: true });
        assert.equal(await compressed_file(file, encoding), cached);
        assert.equal((await stat(cached, { bigint: true })).mtimeNs, before.mtimeNs);
        await writeFile(cached, 'incomplete');
        assert.deepEqual(decode(encoding, await readFile(await compressed_file(file, encoding))), original);
    }
    const old = await stat(file);
    const changed = Buffer.alloc(original.length, 65);
    await writeFile(file, changed);
    await utimes(file, old.atime, old.mtime);
    for (const encoding of ['zstd', 'gzip'] as const) {
        assert.deepEqual(decode(encoding, await readFile(await compressed_file(file, encoding))), changed);
    }
    assert(!(await readdir(root)).some(name => name.endsWith('.tmp')));
});

test('cancelled compression publishes no cache and can be retried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-compression-abort-'));
    const file = join(root, 'backup.tar');
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024, 65));
    const controller = new AbortController();
    const task = compressed_file(file, 'gzip', controller.signal);
    controller.abort(new Error('test cancellation'));
    await assert.rejects(task, /abort|cancellation/i);
    assert.deepEqual(await readdir(root), ['backup.tar']);
    assert.deepEqual(gunzipSync(await readFile(await compressed_file(file, 'gzip'))), await readFile(file));
});

test('download routes send cached encoded bytes while preserving filenames and content types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-compression-http-'));
    const json = JSON.stringify({ text: '测试内容'.repeat(10000) });
    const archive = Buffer.from(await (await new ImageHandler().create_tar({ 'post.json': json })).arrayBuffer());
    const queue = new JobQueue(root, async (_job, directory) => {
        await writeFile(join(directory, 'post.json'), json);
        await writeFile(join(directory, 'backup.tar'), archive);
        return { filename: '测试备份.tar', floor_count: 1, image_count: 0, warnings: [] };
    });
    await queue.initialize();
    const server = create_app(queue);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
        const job = await queue.submit('123');
        const deadline = Date.now() + 5000;
        while (job.status !== 'complete' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.equal(job.status, 'complete');
        // Simulate an existing archive: no cache was prepared by its runner.
        for (const endpoint of ['download', 'post.json']) {
            const url = `${origin}/api/jobs/${job.id}/${endpoint}`;
            const original = endpoint === 'download' ? archive : Buffer.from(json);
            for (const encoding of ['zstd', 'gzip']) {
                const headers = { 'Accept-Encoding': encoding };
                const response = await raw(url, headers);
                assert.equal(response.status, 200);
                assert.equal(response.headers['content-encoding'], encoding);
                assert.equal(response.headers.vary, 'Accept-Encoding');
                assert.equal(Number(response.headers['content-length']), response.bytes.length);
                assert(response.bytes.length < original.length);
                assert.deepEqual(decode(encoding, response.bytes), original);
                assert.equal(response.headers['content-type'], endpoint === 'download' ? 'application/x-tar' : 'application/json');
                assert(response.headers['content-disposition']?.includes(`filename="${endpoint === 'download' ? 'backup.tar' : 'post.json'}"`));
                const head = await raw(url, headers, 'HEAD');
                assert.equal(head.headers['content-length'], response.headers['content-length']);
                assert.equal(head.headers['content-encoding'], encoding);
                assert.equal(head.bytes.length, 0);
                assert.deepEqual((await raw(url, headers)).bytes, response.bytes);
            }
            for (const headers of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'gzip;q=0, zstd;q=0' }] as Record<string, string>[]) {
                const response = await raw(url, headers);
                assert.equal(response.headers['content-encoding'], undefined);
                assert.deepEqual(response.bytes, original);
            }
            assert.equal((await raw(url, { 'Accept-Encoding': '*;q=0' })).status, 406);
        }
        assert.equal((await raw(`${origin}/api/jobs/${job.id}/backup.tar.http.zstd`)).status, 404);
    } finally {
        await queue.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
