import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collect_api, render_api_content, type ApiRequest } from '../src/shared/api-collector';
import { finalize_post } from '../src/shared/post';
import { normalize_content_spaces, regression_report } from '../src/shared/regression';
import { create_api_request, RequestPacer, sign_form } from '../src/service/api';
import type { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { create_runner } from '../src/service/worker';
import { JobQueue } from '../src/service/queue';
import type { Post } from '../src/types';

const fixtures = JSON.parse(await readFile('test/api-responses.json', 'utf8')) as {
    path: string; parameters: Record<string, string>; response: Record<string, unknown>;
}[];
const baseline = JSON.parse(await readFile('test/post.json', 'utf8')) as Post;
const signal = new AbortController().signal;
const progress = async () => undefined;

function replay(records = structuredClone(fixtures)): { request: ApiRequest; calls: string[] } {
    const calls: string[] = [];
    const request: ApiRequest = async (path, parameters) => {
        const record = records.find(f => f.path === path && Object.entries(f.parameters).every(([key, value]) => parameters[key] === value));
        assert(record, `Unexpected request: ${path} ${JSON.stringify(parameters)}`);
        const key = JSON.stringify([path, record.parameters]);
        assert(!calls.includes(key), 'No duplicate request/retry');
        calls.push(key);
        return record.response.data || record.response;
    };
    return { request, calls };
}

test('recorded API responses: cursor pages, nested pages, complete content and strict regression evidence', async () => {
    const { request, calls } = replay();
    const result = await collect_api(baseline.id, request, progress, signal);
    assert.equal(calls.length, 5);
    assert.deepEqual(result.floors.map(f => f.index), baseline.floor_list.map(f => f.index));
    assert.deepEqual(result.floors.map(f => f.sub_comment_list?.length || 0), baseline.floor_list.map(f => f.sub_comment_list?.length || 0));
    assert.equal(result.floors.find(f => f.index === 21)?.sub_comment_list?.length, 18);
    const actual = finalize_post(result.metadata, result.floors);
    const report = regression_report(baseline, actual);
    assert.equal(report.strict_differences.length, 76);
    assert.equal(report.differences.length, 75, 'Unapproved differences must not disappear');
    assert.equal(report.accepted_space_differences.length, 1);
    assert.equal(report.accepted_space_differences[0].path, '$.floor_list[18].sub_comment_list[16].content');
    for (let i = 0; i < actual.floor_list.length; i++) {
        const left = baseline.floor_list[i], right = actual.floor_list[i];
        assert.equal(left.comment.date, right.comment.date);
        assert.equal(left.comment.ip_location, right.comment.ip_location);
        assert.deepEqual(left.sub_comment_list?.map(c => c.date), right.sub_comment_list?.map(c => c.date));
    }
    assert.equal(Object.keys(actual.image_map || {}).length, 24);
    assert.equal(result.warnings.length, 0);
});

test('space rule is narrow, auditable and reversible with strict mode', () => {
    const actual = structuredClone(baseline);
    const comment = actual.floor_list[18].sub_comment_list?.[16];
    assert(comment);
    comment.content = comment.content.replace('嗯   数据', '嗯 数据');
    assert.equal(regression_report(baseline, actual).differences.length, 0);
    assert.equal(regression_report(baseline, actual).strict_differences.length, 1);
    assert.equal(regression_report(baseline, actual, { strict: true }).differences.length, 1);
    for (const value of ['<img alt="a   b" src="x">', '<pre>a   b</pre>', '<code>a   b</code>', 'a\t\tb', 'a\n\nb', 'a　　b']) {
        assert.equal(normalize_content_spaces(value), value);
    }
    assert.equal(normalize_content_spaces('<a title="x >   y">a   b</a>'), '<a title="x >   y">a b</a>');
    comment.content += '!';
    assert.equal(regression_report(baseline, actual).differences.length, 1);
    actual.floor_list.reverse();
    assert(regression_report(baseline, actual).differences.length > 1);
});

test('API refuses truncated, duplicate, hidden or unknown data instead of returning complete', async () => {
    for (const [change, pattern] of [
        [(r: typeof fixtures) => { r[1].response.post_list = []; }, /楼层不完整/],
        [(r: typeof fixtures) => { r[1].response.post_list = r[0].response.post_list; }, /重复或乱序/],
        [(r: typeof fixtures) => { r[0].response.has_fold_comment = 1; }, /折叠内容/],
        [(r: typeof fixtures) => { (r[0].response.thread as Record<string, unknown>).is_partial_visible = 1; }, /部分内容可见/],
        [(r: typeof fixtures) => { (r[0].response.first_floor as Record<string, unknown>).content = [{ type: 99 }]; }, /第 1 楼.*type=99/],
        [(r: typeof fixtures) => {
            const record = r.find(f => f.parameters.post_id === '54651409834');
            assert(record);
            const d = record.response.data as Record<string, unknown>;
            d.page = { has_more: 1, offset: 0 };
        }, /offset|游标/],
    ] as const) {
        const records = structuredClone(fixtures);
        change(records);
        await assert.rejects(collect_api(baseline.id, replay(records).request, progress, signal), pattern);
    }
    assert.throws(() => render_api_content([{ type: 2, text: 'unknown_smiley' }]), /尚未支持/);
    assert.throws(() => render_api_content([{ type: 1, text: 'bad', link: 'javascript:alert(1)' }]), /HTTP/);
    assert.equal(render_api_content([{ type: 0, text: '<script>\n&' }]), '&lt;script&gt;<br>&amp;');
});

test('API service runner creates real JSON/viewer/TAR through the queue without navigating a page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-api-worker-'));
    const calls: string[] = [];
    let closed = 0;
    const context = {
        route: async () => undefined, routeWebSocket: async () => undefined,
        cookies: async () => [{ name: 'BDUSS', value: 'synthetic-session', expires: -1 }],
        newPage: async () => assert.fail('API backend must not navigate a page'),
        close: async () => { closed++; },
        request: { post: async (url: string, options: { form: Record<string, string> }) => {
            const path = new URL(url).pathname;
            const record = fixtures.find(f => f.path === path && Object.entries(f.parameters).every(([k, v]) => options.form[k] === v));
            assert(record);
            calls.push(path);
            return { status: () => 200, text: async () => JSON.stringify(record.response), dispose: async () => undefined };
        } },
    } as unknown as BrowserContext;
    let image_count = 0;
    const download = async (_context: BrowserContext, _url: string, _post: string, before?: () => Promise<void>) => {
        await before?.();
        image_count++;
        return new Blob(['synthetic-image'], { type: 'image/png' });
    };
    const queue = new JobQueue(root, create_runner(async () => context, download, 'api', new RequestPacer(0)));
    await queue.initialize();
    try {
        const job = await queue.submit(String(baseline.id));
        const deadline = Date.now() + 10000;
        while (!['complete', 'partial', 'failed'].includes(job.status) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(job.status, 'complete', job.error || 'Job did not complete');
        assert.equal(job.floor_count, 28);
        assert.equal(image_count, 24);
        assert.equal(calls.length, 5);
        assert.equal(closed, 1);
        const post = JSON.parse(await readFile(join(root, job.id, 'post.json'), 'utf8')) as Post;
        assert.equal(regression_report(baseline, post).differences.length, 75);
        const archive = await readFile(join(root, job.id, 'backup.tar'));
        const files = new Map<string, string>();
        for (let offset = 0; archive[offset];) {
            const name = archive.subarray(offset, offset + 100).toString().split('\0')[0];
            const size = parseInt(archive.subarray(offset + 124, offset + 135).toString(), 8);
            files.set(name, archive.subarray(offset + 512, offset + 512 + size).toString());
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        assert.deepEqual(JSON.parse(files.get('post.json') || ''), post);
        assert.match(files.get('viewer.html') || '', /能玩了/);
        assert.equal(JSON.parse(files.get('report.json') || '').backend, 'api');
        assert.equal(files.size, 27);
    } finally { await queue.close(); }

    let attempts = 0;
    const runner = create_runner(async () => context, async (_context, _url, _post, before) => {
        await before?.(); attempts++; throw new Error('HTTP 429');
    }, 'api', new RequestPacer(0));
    await assert.rejects(runner(queue.list()[0], root, progress, signal), /HTTP 429/);
    assert.equal(attempts, 1, 'Stop further image requests after the first failure');
});

test('API request signing, response validation, and no retries', async () => {
    const form = sign_form({ kz: '123', pn: '1' });
    assert.equal(form.sign, createHash('md5').update('_client_type=20kz=123pn=1subapp_type=pctbs=36770b1f34c9bbf2e7d1a99d2b82fa9e').digest('hex'));
    const cases = [
        { status: 403, body: '<title>百度安全验证</title>', error: /HTTP 403/ },
        { status: 429, body: '{}', error: /HTTP 429/ },
        { status: 302, body: '', error: /HTTP 302/ },
        { status: 200, body: '<title>百度安全验证</title>', error: /返回百度安全验证页面/ },
        { status: 200, body: '{', error: /不是 JSON/ },
        { status: 200, body: '{}', error: /缺少 error_code/ },
        { status: 200, body: '{"error_code":12,"error_msg":"测试错误"}', error: /error_code=12，测试错误/ },
        { status: 200, body: '{"error_code":0,"data":{"post_list":[]}}', error: undefined },
    ];
    for (const fixture of cases) {
        let requests = 0, disposed = 0;
        const context = { post: async (url: string, options: { form: unknown; maxRedirects: number; maxRetries: number }) => {
            requests++;
            assert.equal(url, 'https://tieba.baidu.com/c/f/pb/page_pc');
            assert.deepEqual(options.form, form);
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.maxRetries, 0);
            return { status: () => fixture.status, text: async () => fixture.body, dispose: async () => { disposed++; } } as APIResponse;
        } } as APIRequestContext;
        const result = create_api_request(context, 'https://tieba.baidu.com/p/123', new RequestPacer(0), signal)('/c/f/pb/page_pc', { kz: '123', pn: '1' });
        if (fixture.error) { await assert.rejects(result, fixture.error); }
        else { assert.deepEqual(await result, { post_list: [] }); }
        assert.equal(requests, 1);
        assert.equal(disposed, 1);
    }
});

test('pacer serializes concurrent callers, spaces requests across jobs and aborts waiting requests', async () => {
    let now = 0, active = 0, peak = 0;
    const starts: number[] = [];
    const pacer = new RequestPacer(30000, () => now, async ms => { now += ms; });
    const operation = async () => { starts.push(now); peak = Math.max(peak, ++active); await Promise.resolve(); now += 1000; active--; };
    await Promise.all([pacer.run(operation, signal), pacer.run(operation, signal), pacer.run(operation, signal)]);
    await pacer.run(operation, signal);
    assert.deepEqual(starts, [0, 30000, 60000, 90000]);
    assert.equal(peak, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pacer.run(operation, controller.signal), /abort/i);
    const waiting = new RequestPacer(30000);
    await waiting.run(async () => undefined, signal);
    const cancel = new AbortController();
    const request = waiting.run(async () => assert.fail('Should not issue a request'), cancel.signal);
    setTimeout(() => cancel.abort(), 10);
    await assert.rejects(request, /abort/i);
});
