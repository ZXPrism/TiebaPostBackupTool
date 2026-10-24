import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyTrafficGate, TrafficLimitError, TrafficUnavailableError, sum_traffic, traffic_day } from '../src/service/traffic';
import { config } from '../src/service/config';
import { JobQueue } from '../src/service/queue';
import { create_app } from '../src/service/http';
import { CosArchiveStore, type ArchiveStore } from '../src/service/storage';

const no_log = async () => {};
const day = Date.parse('2026-10-24T00:00:00+08:00');

test('COS counts only this Beijing day using five-minute sums and validates monitoring data', () => {
    assert.equal(traffic_day(day + 86399999), day);
    assert.equal(traffic_day(day + 86400000), day + 86400000);
    assert.equal(traffic_day(day - 1), day - 86400000);
    const sample = { MetricName: 'InternetTraffic', Period: 300,
        DataPoints: [{ Dimensions: [{ Name: 'bucket', Value: 'test' }],
            Timestamps: [day / 1000 - 300, day / 1000, day / 1000 + 300], Values: [100, 10, 20] }] };
    assert.equal(sum_traffic(sample, 'test', day, day + 300000), 30);
    assert.equal(sum_traffic({ ...sample, DataPoints: [] }, 'test', day, day), 0);
    assert.throws(() => sum_traffic(sample, 'other', day, day));
    assert.throws(() => sum_traffic({ ...sample, Period: 60 }, 'test', day, day));
    assert.throws(() => sum_traffic({ ...sample, DataPoints: [{ ...sample.DataPoints[0], Values: [NaN] }] }, 'test', day, day));
    assert.throws(() => sum_traffic({ ...sample, DataPoints: [{ ...sample.DataPoints[0], Values: [1, -1, 1] }] }, 'test', day, day));
});

test('quota coalesces refreshes, rejects at equality, retains high-water mark and recovers next day', async () => {
    let now = day + 3600000;
    let bytes = 99, calls = 0;
    const gate = new DailyTrafficGate(100, 300000, async start => {
        assert.equal(start, traffic_day(now)); calls++; return bytes;
    }, no_log, () => now);
    await Promise.all(Array.from({ length: 10 }, () => gate.check()));
    assert.equal(calls, 1);
    assert.equal(gate.expires_seconds(900), 300);
    now += 299000;
    assert.equal(gate.expires_seconds(900), 1);
    now += 1000; bytes = 100;
    await assert.rejects(gate.check(), TrafficLimitError);
    assert.throws(() => gate.expires_seconds(900), TrafficLimitError);
    now += 300000; bytes = 0;
    await assert.rejects(gate.check(), TrafficLimitError);
    now = day + 86400000;
    await gate.check();
    assert.equal(calls, 4);
});

test('monitoring failures fail closed, are cached without leaking secrets, and can recover', async () => {
    let now = day + 1000, fail = true, calls = 0;
    const logs: unknown[] = [];
    const gate = new DailyTrafficGate(100, 300000, async () => {
        calls++;
        if (fail) { throw Object.assign(new Error('SECRET KEY'), { code: 'AuthFailure.UnauthorizedOperation', request: 'SECRET' }); }
        return 0;
    }, async (_level, _event, detail) => { logs.push(detail); }, () => now);
    await assert.rejects(gate.check(), TrafficUnavailableError);
    await assert.rejects(gate.check(), TrafficUnavailableError);
    assert.equal(calls, 1);
    assert(!JSON.stringify(logs).includes('SECRET'));
    assert(JSON.stringify(logs).includes('AuthFailure.UnauthorizedOperation'));
    now += 300000; fail = false;
    await gate.check();
    assert.equal(calls, 2);
});

test('midnight during refresh discards previous-day result and signed links do not cross midnight', async () => {
    let now = day + 86399000;
    let calls = 0;
    const gate = new DailyTrafficGate(100, 300000, async () => {
        calls++;
        if (calls === 1) { now += 1000; return 100; }
        return 0;
    }, no_log, () => now);
    await gate.check();
    assert.equal(calls, 2);
    now = day + 2 * 86400000 - 1000;
    await gate.check();
    assert.equal(gate.expires_seconds(900), 1);
});

test('real COS SDK signs links only after quota checks and bounds their lifetime', async () => {
    const options = { bucket: 'test-1234567890', region: 'ap-guangzhou', secret_id: 'synthetic-id', secret_key: 'synthetic-key' };
    const now = Date.now();
    const gate = new DailyTrafficGate(100, 300000, async () => 0, no_log, () => now);
    const store = new CosArchiveStore(options, undefined, gate);
    const url = new URL(await store.url({ ...options, prefix: 'backups/test' }, 'gzip', 'GET'));
    const sign_time = url.searchParams.get('q-sign-time');
    assert(sign_time);
    const times = sign_time.split(';').map(Number);
    assert(times[1] - times[0] <= 300);
    const blocked = new CosArchiveStore(options, undefined, new DailyTrafficGate(100, 300000, async () => 100, no_log));
    await assert.rejects(blocked.url({ ...options, prefix: 'backups/test' }, 'identity', 'GET'), TrafficLimitError);
});

test('quota blocks dispatch and every download route while current work and previews remain available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-traffic-'));
    let now = day + 3600000, usage = 0, calls = 0;
    const gate = new DailyTrafficGate(100, 1000, async () => usage, no_log, () => now);
    const storage: ArchiveStore = {
        traffic: gate,
        async publish() { return { bucket: 'test', region: 'test', prefix: 'backups/test' }; },
        async url() { return 'https://example.invalid/backup'; },
    };
    let release!: () => void, started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const queue = new JobQueue(root, async (_job, directory) => {
        calls++; started(); await hold;
        await writeFile(join(directory, 'post.json'), await readFile('tests/regression/post.json'));
        return { filename: 'backup.tar', floor_count: 1, image_count: 0, warnings: [] };
    }, storage);
    await queue.initialize();
    const server = create_app(queue);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const settled = async (status: () => boolean) => {
        const deadline = Date.now() + 3000;
        while (!status() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
        assert(status());
    };
    try {
        const first = await queue.submit('123');
        await running;
        const second = await queue.submit('124');
        now += 1000; usage = 100;
        const rejected = await fetch(origin + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"125"}' });
        assert.equal(rejected.status, 503);
        assert.deepEqual(await rejected.json(), { error: '服务器日流量已达限额' });
        assert.equal((await queue.submit('123')).id, first.id);
        release();
        await settled(() => second.status === 'failed');
        assert.equal(first.status, 'complete');
        assert.equal(second.failure_reason, 'traffic_limit');
        assert.equal(calls, 1);
        for (const path of ['download', 'download-url', 'post.json']) {
            for (const method of ['GET', 'HEAD']) {
                const response = await fetch(`${origin}/api/jobs/${first.id}/${path}`, { method, redirect: 'manual' });
                assert.equal(response.status, 503);
                assert.equal(response.headers.get('location'), null);
                if (method === 'GET') { assert.deepEqual(await response.json(), { error: '服务器日流量已达限额' }); }
            }
        }
        assert.equal((await fetch(`${origin}/api/jobs/${first.id}/snapshot`)).status, 200);
        assert.equal((await fetch(origin + '/api/posts?url=123')).status, 200);
        now = day + 86400000; usage = 0;
        assert.equal((await fetch(`${origin}/api/jobs/${first.id}/download`, { redirect: 'manual' })).status, 302);
        const next = await queue.submit('126');
        await settled(() => next.status === 'complete');
    } finally {
        release(); await queue.close(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('awaiting the traffic check cannot bypass pending-job deduplication or queue capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-admission-'));
    const original = config.max_pending;
    config.max_pending = 1;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const queue = new JobQueue(root, async () => {
        await hold; return { filename: 'test.tar', floor_count: 1, image_count: 0, warnings: [] };
    }, { traffic: { async check() { await new Promise(resolve => setTimeout(resolve, 5)); }, expires_seconds: value => value },
        async publish() { return { bucket: 'test', region: 'test', prefix: 'test' }; }, async url() { return ''; } });
    try {
        await queue.initialize();
        const results = await Promise.allSettled([queue.submit('123'), queue.submit('123'), queue.submit('124')]);
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'fulfilled');
        assert.equal(results[2].status, 'rejected');
        assert.equal(queue.list().length, 1);
    } finally { release(); await queue.close(); config.max_pending = original; }
});
