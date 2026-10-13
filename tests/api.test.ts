import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collect_api, render_api_content, type ApiRequest } from '../src/shared/api-collector';
import { finalize_post } from '../src/shared/post';
import { normalize_content_spaces, regression_report } from '../src/shared/regression';
import { create_api_request, RequestPacer, sign_form } from '../src/service/api';
import type { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { create_runner } from '../src/service/worker';
import { JobQueue } from '../src/service/queue';
import { config } from '../src/service/config';
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

test('recorded unnumbered emoticon survives floor/reply collection and offline image mapping', async () => {
    // Content item from thread 11052619456, floor 85, nested offset 10.
    const { content } = JSON.parse(await readFile('test/api-unnumbered-emoticon.json', 'utf8'));
    const url = 'https://tb3.bdstatic.com/emoji/image_emoticon@2x.png';
    const html = `<img class="BDE_Smiley" width="30" height="30" changedsize="false" src="${url}">`;
    assert.equal(render_api_content(content), html);
    const records = structuredClone(fixtures);
    (records[0].response.first_floor as Record<string, unknown>).content = content;
    const nested = records[2].response.data as Record<string, unknown>;
    (nested.post_list as Record<string, unknown>[])[0].content = content;
    const result = await collect_api(baseline.id, replay(records).request, progress, signal);
    const reply = result.floors.find(f => f.index === 21)?.sub_comment_list?.[0];
    assert(reply);
    assert.equal(result.floors[0].comment.content, html);
    assert.equal(reply.content, html);
    const post = finalize_post(result.metadata, result.floors);
    const filename = post.image_map?.[url];
    assert.equal(filename, 'image_1.png');
    assert.equal(post.floor_list[0].comment.content, html.replace(url, `./images/${filename}`));
    assert.equal(reply.content, post.floor_list[0].comment.content);
    for (const name of ['image_emoticon.png', 'image_emoticon/../x', 'image_emoticon" onerror="x']) {
        assert.throws(() => render_api_content([{ type: 2, text: name }]), /尚未支持/);
    }
});

test('API accepts changing page and reply totals while keeping the initial thread metadata', async () => {
    for (const delta of [-1, 1]) {
        for (const field of ['total_page', 'valid_post_num', 'reply_num']) {
            const records = structuredClone(fixtures);
            const data = records[1].response;
            const summary = (field === 'total_page' ? data.page : data.thread) as Record<string, number>;
            summary[field] = Number(summary[field]) + delta;
            const { request, calls } = replay(records);
            const result = await collect_api(baseline.id, request, progress, signal);
            assert.equal(calls.length, 5);
            assert.equal(result.floors.length, 28);
            assert.equal(result.floors.flatMap(f => f.sub_comment_list || []).length, 36);
            assert.equal(result.metadata.page_cnt, 2);
            assert.deepEqual(result.warnings, []);
        }
    }
});

test('API accepts edits, overlapping pages and new floors without replacing collected content', async () => {
    const records = structuredClone(fixtures);
    const first = records[0].response.post_list as Record<string, unknown>[];
    const second = records[1].response.post_list as Record<string, unknown>[];
    const overlap = structuredClone(first[first.length - 1]);
    const original_content = render_api_content(overlap.content);
    overlap.content = [{ type: 0, text: 'edited after collection' }];
    second[0].content = [{ type: 0, text: 'edited before collection' }];
    const added = { ...structuredClone(second[second.length - 1]), id: 999999999999, floor: 31, content: [{ type: 0, text: 'new floor' }], sub_post_number: 0, sub_post_list: undefined };
    second.unshift(overlap);
    second.push(added);
    const { request, calls } = replay(records);
    const result = await collect_api(baseline.id, request, progress, signal);
    assert.equal(calls.length, 5);
    assert.equal(result.floors.length, 29);
    assert.equal(result.floors.find(f => f.index === Number(overlap.floor))?.comment.content, original_content);
    assert.equal(result.floors.find(f => f.index === Number(second[1].floor))?.comment.content, 'edited before collection');
    assert.equal(result.floors.at(-1)?.comment.content, 'new floor');
    assert.deepEqual(result.warnings, []);
});

test('API accepts a final page emptied by deletions', async () => {
    const records = structuredClone(fixtures);
    records[1].response.post_list = [];
    const { request, calls } = replay(records);
    const result = await collect_api(baseline.id, request, progress, signal);
    assert.equal(calls.length, 2);
    assert.equal(result.floors.length, 15);
    assert.deepEqual(result.warnings, []);
});

test('API follows nested pagination despite additions, deletions and overlapping replies', async () => {
    for (const scenario of ['added', 'deleted', 'empty', 'overlap']) {
        const records = structuredClone(fixtures);
        const pages = records.filter(f => f.parameters.post_id === '54651409834');
        const first = pages[0].response.data as Record<string, unknown>;
        const second = pages[1].response.data as Record<string, unknown>;
        const first_replies = first.post_list as Record<string, unknown>[];
        const second_replies = second.post_list as Record<string, unknown>[];
        const last_reply = first_replies[first_replies.length - 1];
        const original_content = render_api_content(last_reply.content);
        if (scenario === 'added') {
            second_replies.push({ ...structuredClone(second_replies[second_replies.length - 1]), id: 999999999999, content: [{ type: 0, text: 'new reply' }] });
        } else if (scenario === 'deleted') {
            second.post_list = [];
        } else if (scenario === 'empty') {
            first.post_list = [];
            first.page = { has_more: 0, offset: 0 };
        } else {
            second_replies.unshift({ ...structuredClone(last_reply), content: [{ type: 0, text: 'edited reply' }] });
        }
        const { request, calls } = replay(records);
        const result = await collect_api(baseline.id, request, progress, signal);
        const replies = result.floors.find(f => f.index === 21)?.sub_comment_list || [];
        assert.equal(replies.length, { added: 19, deleted: 10, empty: 0, overlap: 18 }[scenario]);
        assert.equal(calls.length, scenario === 'empty' ? 4 : 5);
        if (scenario === 'added') { assert.equal(replies.at(-1)?.content, 'new reply'); }
        if (scenario === 'overlap') { assert.equal(replies[9].content, original_content); }
        assert.deepEqual(result.warnings, []);
    }
});

test('API refuses stalled pagination, inconsistent individual responses, hidden or unknown data', async () => {
    for (const [change, pattern] of [
        [(r: typeof fixtures) => { r[0].response.post_list = []; }, /还有下一页.*列表为空/],
        [(r: typeof fixtures) => {
            r[1].response.post_list = r[0].response.post_list;
            (r[1].response.page as Record<string, unknown>).has_more = 1;
        }, /楼层分页游标未前进/],
        [(r: typeof fixtures) => {
            const posts = r[1].response.post_list as unknown[];
            posts.push(posts[0]);
        }, /单次响应.*重复或乱序/],
        [(r: typeof fixtures) => {
            const data = r[2].response.data as Record<string, unknown>;
            const posts = data.post_list as unknown[];
            posts.push(posts[0]);
        }, /第 21 楼.*单次响应.*重复回复 ID/],
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
    let image_count = 0, active_images = 0, peak_images = 0;
    const download = async (_context: BrowserContext, _url: string, _post: string, before?: () => Promise<void>) => {
        await before?.();
        image_count++;
        peak_images = Math.max(peak_images, ++active_images);
        await new Promise(resolve => setTimeout(resolve, 50));
        active_images--;
        return new Blob(['synthetic-image'], { type: 'image/png' });
    };
    const queue = new JobQueue(root, create_runner(async () => context, download, 'api', new RequestPacer(0), new RequestPacer(1)));
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
        assert(peak_images > 1 && peak_images <= 5, `Image concurrency: ${peak_images}`);
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
    }, 'api', new RequestPacer(0), new RequestPacer(5));
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
    const pacer = new RequestPacer(1000, () => now, async ms => { now += ms; });
    const operation = async () => { starts.push(now); peak = Math.max(peak, ++active); await Promise.resolve(); now += 100; active--; };
    await Promise.all([pacer.run(operation, signal), pacer.run(operation, signal), pacer.run(operation, signal)]);
    await pacer.run(operation, signal);
    assert.deepEqual(starts, [0, 1000, 2000, 3000]);
    assert.equal(peak, 1);
    const image_pacer = new RequestPacer(200, () => now, async ms => { now += ms; });
    const image_starts: number[] = [];
    for (let i = 0; i < 5; i++) { await image_pacer.run(async () => { image_starts.push(now); }, signal); }
    assert.deepEqual(image_starts, [3100, 3300, 3500, 3700, 3900]);
    await pacer.run(operation, signal);
    assert.equal(starts.at(-1), 4000, 'Image starts do not change the content pacer clock');
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

test('large synthetic thread covers 380 API pages and 20,000 nested replies without network access', async () => {
    // Hypothetical 190 legacy pages x 30 floors; this is not a measurement of the live target.
    const total_floors = 5700, total_replies = 20000, page_size = 15;
    const user = { id: 1, name: 'author', name_show: 'author', portrait: 'fixture' };
    const floor = (index: number) => ({
        id: 100000 + index, floor: index, author_id: 1, time: 1700000000,
        content: [{ type: 0, text: `floor ${index}` }], sub_post_number: index === 1 ? total_replies : 0,
    });
    let calls = 0, now = 0;
    const pacer = new RequestPacer(1000, () => now, async ms => { now += ms; });
    const request: ApiRequest = (path, parameters) => pacer.run(async () => {
        calls++;
        if (path === '/c/f/pb/page_pc') {
            const start = parameters.last_pid ? Number(parameters.last_pid) - 100000 + 1 : 1;
            const end = Math.min(start + page_size - 1, total_floors);
            const posts = Array.from({ length: end - start + 1 }, (_, i) => floor(start + i));
            return {
                thread: { id: 123, title: 'large fixture', reply_num: total_floors - 1 + total_replies, valid_post_num: total_floors, is_partial_visible: 0 },
                forum: { name: 'fixture' }, has_fold_comment: 0, user_list: [user],
                page: { total_page: Math.ceil(total_floors / page_size), has_more: end < total_floors ? 1 : 0 },
                ...(start === 1 ? { first_floor: posts.shift() } : {}), post_list: posts,
            };
        }
        const offset = Number(parameters.offset);
        return {
            page: { offset: offset + 10, has_more: offset + 10 < total_replies ? 1 : 0 },
            post_list: Array.from({ length: Math.min(10, total_replies - offset) }, (_, i) => ({
                id: 1000000 + offset + i, author_id: 1, author: user, time: 1700000000 + offset + i,
                content: [{ type: 0, text: `reply ${offset + i + 1}` }],
            })),
        };
    }, signal);
    const result = await collect_api(123, request, progress, signal, config.max_api_pages);
    assert.equal(result.floors.length, total_floors);
    assert.equal(result.floors[0].sub_comment_list?.length, total_replies);
    assert.equal(result.floors[0].sub_comment_list?.at(-1)?.content, 'reply 20000');
    assert.equal(result.floors.at(-1)?.index, total_floors);
    assert.equal(calls, 2380);
    assert.equal(now, 2379000, '39m39s of simulated request spacing; excludes real latency, images and packaging');
});

test('API startup configuration uses an hour budget and validates rate overrides', () => {
    const run = (overrides: Record<string, string>) => spawnSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e',
        "import { config } from './src/service/config.ts'; console.log(JSON.stringify(config));",
    ], { encoding: 'utf8', env: { ...process.env, TIEBA_BACKEND: 'api', TIEBA_API_INTERVAL_MS: '1000', TIEBA_IMAGE_INTERVAL_MS: '200', ...overrides } });
    const api = run({});
    assert.ifError(api.error);
    assert.equal(api.status, 0, api.stderr);
    const selected = JSON.parse(api.stdout);
    assert.equal(selected.job_timeout_ms, 3600000);
    assert.equal(selected.api_request_interval_ms, 1000);
    assert.equal(selected.image_request_interval_ms, 200);
    assert.equal(selected.max_api_pages, 2000);
    const browser = run({ TIEBA_BACKEND: 'browser' });
    assert.equal(JSON.parse(browser.stdout).job_timeout_ms, 1800000);
    const custom = run({ TIEBA_API_INTERVAL_MS: '1500', TIEBA_IMAGE_INTERVAL_MS: '300' });
    assert.equal(JSON.parse(custom.stdout).api_request_interval_ms, 1500);
    for (const value of ['0', '-1', '1.5', 'NaN', '']) {
        const invalid = run({ TIEBA_API_INTERVAL_MS: value });
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /TIEBA_API_INTERVAL_MS 必须为正整数/);
    }
});
