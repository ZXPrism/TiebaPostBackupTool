import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import COS from 'cos-nodejs-sdk-v5';
import { cos_config, CosArchiveStore, type ArchiveStore } from '../src/service/storage';
import { JobQueue } from '../src/service/queue';
import { create_app } from '../src/service/http';

const options = { bucket: 'example-1234567890', region: 'ap-guangzhou', secret_id: 'test-id', secret_key: 'test-key' };
test('COS is opt-in and incomplete configuration fails without revealing secrets', () => {
    assert.equal(cos_config({}), undefined);
    assert.throws(() => cos_config({ TIEBA_COS_SECRET_KEY: 'private-key' }), error =>
        error instanceof Error && error.message.includes('TIEBA_COS_BUCKET') && !error.message.includes('private-key'));
});

test('COS uploads private verified representations, signs downloads and preserves source on verification failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tieba-cos-'));
    await writeFile(join(directory, 'backup.tar'), 'archive content '.repeat(1000));
    const uploaded: COS.UploadFileParams[] = [];
    const client = {
        uploadFile(params: COS.UploadFileParams, callback: (error: unknown) => void) {
            uploaded.push(params);
            params.onTaskReady?.('task');
            callback(null);
        },
        async headObject() {
            const params = uploaded.at(-1);
            assert(params);
            return { headers: { 'content-length': String((await stat(params.FilePath)).size), 'content-encoding': params.ContentEncoding } };
        },
    } as unknown as COS;
    const store = new CosArchiveStore(options, client);
    const counts: number[] = [];
    const archive = await store.publish('test-job', directory, '测试.tar', async value => { counts.push(value.current ?? 0); }, new AbortController().signal);
    assert.equal(uploaded.length, 2);
    assert.deepEqual(uploaded.map(value => value.ContentEncoding), [undefined, 'gzip']);
    assert(uploaded.every(value => value.ACL === 'private' && value.ContentDisposition?.includes(encodeURIComponent('测试.tar'))));
    assert((counts.at(-1) ?? 0) > 0);
    const signing = new CosArchiveStore(options);
    const url = new URL(await signing.url(archive, 'gzip', 'GET'));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, '/backups/test-job/gzip');
    assert(url.searchParams.has('q-signature'));
    client.headObject = (() => Promise.resolve({ ETag: '', headers: { 'content-length': '0' } })) as typeof client.headObject;
    await assert.rejects(store.publish('bad', directory, 'backup.tar', async () => {}, new AbortController().signal), /校验失败/);
    await access(join(directory, 'backup.tar'));
});

test('COS cancellation stops upload and never publishes a successful result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tieba-cancel-'));
    await writeFile(join(directory, 'backup.tar'), 'archive');
    const controller = new AbortController();
    let cancelled = false;
    const client = {
        uploadFile(params: COS.UploadFileParams) { params.onTaskReady?.('upload'); controller.abort(new Error('cancelled')); },
        cancelTask(task: string) { assert.equal(task, 'upload'); cancelled = true; },
    } as unknown as COS;
    await assert.rejects(new CosArchiveStore(options, client).publish('job', directory, 'backup.tar', async () => {}, controller.signal), /cancelled/);
    assert(cancelled);
    await access(join(directory, 'backup.tar'));
});

test('queue persists COS references before cleanup; snapshots and redirects survive restart; failed upload retains files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tieba-store-'));
    const post = await readFile('tests/regression/post.json', 'utf8');
    let fail = false;
    const storage: ArchiveStore = {
        async publish(_id, directory) {
            await access(join(directory, 'backup.tar'));
            if (fail) { throw new Error('upload failed'); }
            return { bucket: options.bucket, region: options.region, prefix: 'backups/example' };
        },
        async url(_archive, encoding, method) { return 'https://example.invalid/' + encoding + '?method=' + method; },
    };
    const runner = async (_job: unknown, directory: string) => {
        await writeFile(join(directory, 'backup.tar'), 'archive');
        await writeFile(join(directory, 'post.json'), post);
        return { filename: 'backup.tar', floor_count: 28, image_count: 20, warnings: [] };
    };
    const queue = new JobQueue(directory, runner, storage);
    await queue.initialize();
    const job = await queue.submit('3022463586');
    async function settled() {
        const deadline = Date.now() + 5000;
        while (queue.list().some(job => ['queued', 'running'].includes(job.status)) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    await settled();
    await queue.close();
    assert.equal(job.status, 'complete');
    const record = JSON.parse(await readFile(join(directory, job.id, 'job.json'), 'utf8'));
    assert(record.archive);
    await assert.rejects(access(join(directory, job.id, 'backup.tar')));
    await access(join(directory, job.id, 'post.json'));
    const restored = new JobQueue(directory, runner, storage);
    await restored.initialize();
    const server = create_app(restored, '/tpbt');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/tpbt/api/jobs/${job.id}`;
    try {
        const snapshot = await (await fetch(endpoint + '/snapshot')).json();
        assert.equal(snapshot.floors.length, 5);
        const response = await fetch(endpoint + '/download', { redirect: 'manual', headers: { 'Accept-Encoding': 'gzip' } });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://example.invalid/gzip?method=GET');
        const location = await (await fetch(endpoint + '/download-url', { headers: { 'Accept-Encoding': 'gzip' } })).json();
        assert.equal(location.url, 'https://example.invalid/gzip?method=GET');
        fail = true;
        const failed = await restored.submit('3022463586');
        const deadline = Date.now() + 5000;
        while (['queued', 'running'].includes(failed.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.equal(failed.status, 'failed');
        assert.equal(failed.archive, undefined);
        await access(join(directory, failed.id, 'backup.tar'));
    } finally {
        await restored.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('official SDK sends compressed bytes, MD5 and download headers over HTTP', async () => {
    const { createServer } = await import('node:http');
    const { createHash } = await import('node:crypto');
    const { gunzipSync } = await import('node:zlib');
    const objects = new Map<string, { body: Buffer; encoding: string; disposition: string }>();
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
        try {
            assert(request.headers.authorization?.includes('q-signature='));
            const key = new URL(request.url || '/', 'http://localhost').pathname;
            if (request.method === 'PUT') {
                const chunks: Buffer[] = [];
                for await (const chunk of request) { chunks.push(chunk); }
                const body = Buffer.concat(chunks);
                assert.equal(request.headers['content-md5'], createHash('md5').update(body).digest('base64'));
                assert.equal(request.headers['x-cos-acl'], 'private');
                objects.set(key, { body, encoding: String(request.headers['content-encoding'] || 'identity'),
                    disposition: String(request.headers['content-disposition']) });
                response.writeHead(200, { ETag: '"' + createHash('md5').update(body).digest('hex') + '"' });
            } else {
                assert.equal(request.method, 'HEAD');
                const object = objects.get(key);
                assert(object);
                response.writeHead(200, { 'Content-Length': object.body.length, ETag: '"test"',
                    ...(object.encoding === 'identity' ? {} : { 'Content-Encoding': object.encoding }) });
            }
            response.end();
        } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
        const directory = await mkdtemp(join(tmpdir(), 'tieba-sdk-'));
        const content = Buffer.from('archive content '.repeat(3000));
        await writeFile(join(directory, 'backup.tar'), content);
        const client = new COS({ SecretId: options.secret_id, SecretKey: options.secret_key, Domain: `127.0.0.1:${address.port}`,
            Protocol: 'http:', UploadCheckContentMd5: true, Timeout: 2000 });
        await new CosArchiveStore(options, client).publish('wire', directory, '备份.tar', async () => {}, new AbortController().signal);
        assert.deepEqual(errors, []);
        assert.equal(objects.size, 2);
        for (const object of objects.values()) {
            const decoded = object.encoding === 'gzip' ? gunzipSync(object.body) : object.body;
            assert.deepEqual(decoded, content);
            assert(object.disposition.includes(encodeURIComponent('备份.tar')));
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
