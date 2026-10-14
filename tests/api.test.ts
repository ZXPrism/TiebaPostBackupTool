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
import type { Progress } from '../src/shared/progress';

const fixtures = JSON.parse(await readFile('tests/regression/api-responses.json', 'utf8')) as {
    path: string; parameters: Record<string, string>; response: Record<string, unknown>;
}[];
const baseline = JSON.parse(await readFile('tests/regression/post.json', 'utf8')) as Post;
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

test('collection progress counts completed pages and all nested replies across floors', async () => {
    const updates: Progress[] = [];
    const { request, calls } = replay();
    await collect_api(baseline.id, request, async value => { updates.push(value); }, signal);
    assert.equal(calls.length, 5, 'Progress does not add content requests');
    assert.deepEqual(updates[0].collection, { pages: { current: 0, complete: false } });
    assert.deepEqual(updates[1].collection?.pages, { current: 1, total: 2, complete: false });
    const start21 = updates.find(p => p.stage === '采集第 21 楼的楼中楼' && p.current === 0);
    assert.deepEqual(start21?.collection, { pages: { current: 2, total: 2, complete: true }, replies: { current: 7, total: 36, complete: false } });
    const page21 = updates.find(p => p.stage === '采集第 21 楼的楼中楼' && p.current === 10);
    assert.equal(page21?.collection?.replies?.current, 17);
    const start26 = updates.find(p => p.stage === '采集第 26 楼的楼中楼' && p.current === 0);
    assert.deepEqual(start26?.collection?.replies, { current: 30, total: 36, complete: false });
    assert.deepEqual(updates.at(-1)?.collection?.replies, { current: 36, total: 36, complete: true });
});

test('reply progress adjusts estimates for live additions and deletions without counting overlaps twice', async () => {
    for (const scenario of ['added', 'deleted', 'overlap', 'none']) {
        const records = structuredClone(fixtures);
        const last = records[3].response.data as Record<string, unknown>;
        const replies = last.post_list as Record<string, unknown>[];
        if (scenario === 'added') { replies.push({ ...replies[0], id: 999999999999 }); }
        if (scenario === 'deleted') { last.post_list = []; }
        if (scenario === 'overlap') {
            const first = (records[2].response.data as Record<string, unknown>).post_list as Record<string, unknown>[];
            replies.unshift(first[first.length - 1]);
        }
        if (scenario === 'none') {
            for (const record of records.slice(0, 2)) {
                for (const post of [record.response.first_floor, ...(record.response.post_list as unknown[])]) {
                    if (!post) { continue; }
                    Object.assign(post, { sub_post_number: 0, sub_post_list: undefined });
                }
            }
        }
        const updates: Progress[] = [];
        const result = await collect_api(baseline.id, replay(records).request, async value => { updates.push(value); }, signal);
        const total = result.floors.flatMap(f => f.sub_comment_list || []).length;
        assert.deepEqual(updates.at(-1)?.collection?.replies, { current: total, total, complete: true });
        let previous = 0;
        for (const update of updates) {
            const count = update.collection?.replies;
            if (!count) { continue; }
            assert(count.current >= previous);
            assert(count.total !== undefined && count.current <= count.total);
            previous = count.current;
        }
    }
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
    const { content } = JSON.parse(await readFile('tests/regression/api-unnumbered-emoticon.json', 'utf8'));
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

test('recorded Shoubai emoticon is preserved as an offline WebP image', async () => {
    const { content } = JSON.parse(await readFile('tests/regression/api-shoubai-emoticon.json', 'utf8'));
    const url = 'https://tb3.bdstatic.com/shoubai_emoji/shoubai_emoji_face_04.webp';
    const html = `<img class="BDE_Smiley" width="30" height="30" changedsize="false" src="${url}">`;
    assert.equal(render_api_content(content), html);
    const records = structuredClone(fixtures);
    (records[0].response.first_floor as Record<string, unknown>).content = content;
    const nested = records[2].response.data as Record<string, unknown>;
    (nested.post_list as Record<string, unknown>[])[0].content = content;
    const result = await collect_api(baseline.id, replay(records).request, progress, signal);
    const post = finalize_post(result.metadata, result.floors);
    assert.equal(post.image_map?.[url], 'image_1.webp');
    assert.equal(post.floor_list[0].comment.content, html.replace(url, './images/image_1.webp'));
    assert.equal(post.floor_list.find(f => f.index === 21)?.sub_comment_list?.[0].content, post.floor_list[0].comment.content);
});

test('unavailable original emoticon preserves text and reports its source once per saved comment', async () => {
    const { content, source } = JSON.parse(await readFile('tests/regression/api-unavailable-emoticon.json', 'utf8'));
    const records = structuredClone(fixtures);
    (records[0].response.first_floor as Record<string, unknown>).content = content;
    const nested = records[2].response.data as Record<string, unknown>;
    (nested.post_list as Record<string, unknown>[])[0].content = content;
    const replayed = replay(records);
    const result = await collect_api(baseline.id, replayed.request, progress, signal);
    const post = finalize_post(result.metadata, result.floors);
    assert.equal(post.floor_list[0].comment.content, '哦，长知识了[好运]');
    assert.equal(post.floor_list.find(f => f.index === 21)?.sub_comment_list?.[0].content, '哦，长知识了[好运]');
    assert.equal(result.warnings.length, 0, 'A verified missing original is not an incomplete backup');
    assert.equal(result.notes.length, 2, 'Early validation must not duplicate notes');
    assert.match(result.notes[0], /^第 1 楼:/);
    assert.match(result.notes[1], /^第 21 楼: 楼中楼回复 \d+:/);
    for (const note of result.notes) {
        assert(note.includes(source.web_image_url));
        assert.match(note, /\[好运\].*HTTP 404/);
    }
    assert(!Object.keys(post.image_map || {}).some(url => url.includes('shoubai_emoji_face_365')));
    assert.equal(replayed.calls.length, 5, 'Missing image does not prevent completing collection');
});

test('Shoubai family uses official number formatting, supported ranges and exclusions', () => {
    for (const [name, filename] of [['4', '04'], ['04', '04'], ['1', '01'], ['229', '229'], ['367', '367'], ['370', '370']]) {
        const html = render_api_content([{ type: 2, text: `shoubai_emoji_face_${name}` }]);
        assert(html.includes(`/shoubai_emoji_face_${filename}.webp"`));
    }
    for (const name of ['0', '107', '109', '204', '230', '366', '371', 'NaN', '../04', '04" onerror="x']) {
        assert.throws(() => render_api_content([{ type: 2, text: `shoubai_emoji_face_${name}` }]), /尚未支持/);
    }
});

test('unsupported content stops collection on the response containing it, before further requests', async () => {
    for (const location of ['floor', 'embedded', 'nested']) {
        const records = structuredClone(fixtures);
        const content = [{ type: 2, text: 'unknown_smiley' }];
        const first = records[0].response.first_floor as Record<string, unknown>;
        if (location === 'floor') { first.content = content; }
        if (location === 'embedded') { first.sub_post_list = { sub_post_list: [{ content }] }; }
        if (location === 'nested') {
            const data = records[2].response.data as Record<string, unknown>;
            (data.post_list as Record<string, unknown>[])[0].content = content;
        }
        const { request, calls } = replay(records);
        await assert.rejects(collect_api(baseline.id, request, progress, signal), location === 'nested' ? /第 21 楼.*unknown_smiley/ : /第 1 楼.*unknown_smiley/);
        assert.equal(calls.length, location === 'nested' ? 3 : 1);
    }
});

test('recorded search keywords retain only text and order in floors and nested replies', async () => {
    const { content } = JSON.parse(await readFile('tests/regression/api-search-link.json', 'utf8'));
    const html = '网球风云吧好像除了网球都聊';
    assert.equal(render_api_content(content), html);
    const records = structuredClone(fixtures);
    (records[0].response.first_floor as Record<string, unknown>).content = content;
    const nested = records[2].response.data as Record<string, unknown>;
    (nested.post_list as Record<string, unknown>[])[0].content = content;
    const result = await collect_api(baseline.id, replay(records).request, progress, signal);
    const post = finalize_post(result.metadata, result.floors);
    assert.equal(post.floor_list[0].comment.content, html);
    assert.equal(post.floor_list.find(f => f.index === 21)?.sub_comment_list?.[0].content, html);
    assert(!Object.keys(post.image_map || {}).includes(content[0].src), 'Search decoration is not a content image');
    assert.deepEqual(result.warnings, []);
    assert.equal(render_api_content([{ type: 40, text: '<b>&', link: 'https://tieba.baidu.com/?a=1&b=2' }]),
        '&lt;b&gt;&amp;');
    assert.equal(render_api_content([{ type: 40, text: '关键词', link: 'javascript:alert(1)' }]), '关键词');
    assert.equal(render_api_content([{ type: 40, text: '第一行\n第二行' }]), '第一行<br>第二行');
    assert.throws(() => render_api_content([{ type: 40, link: 'https://tieba.baidu.com/' }]), /content.text/);
    assert.equal(render_api_content([{ type: 1, text: '原有链接', link: 'https://tieba.baidu.com/' }]),
        '<a href="https://tieba.baidu.com/" target="_blank">原有链接</a>');
});

test('recorded topic links retain hashtag text and the original destination', async () => {
    const { content } = JSON.parse(await readFile('tests/regression/api-topic-link.json', 'utf8'));
    const html = render_api_content(content);
    assert(html.startsWith('<a href="https://tieba.baidu.com/mo/q/hotMessage?'));
    assert(html.endsWith('" target="_blank"># 王一涵六六 #</a>'));
    const href = html.match(/href="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
    assert(href);
    assert.equal(new URL(href).searchParams.get('topic_name'), ' 王一涵六六 ');
    assert.equal(new URL(href).searchParams.get('fid'), '3048214');
    assert.throws(() => render_api_content([{ type: 18, text: '#x#', link: 'javascript:alert(1)' }]), /HTTP/);
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
        assert.equal(job.image_count, 1, 'Identical downloads are stored only once');
        assert(peak_images > 1 && peak_images <= 5, `Image concurrency: ${peak_images}`);
        assert.equal(calls.length, 5);
        assert.equal(closed, 1);
        const post = JSON.parse(await readFile(join(root, job.id, 'post.json'), 'utf8')) as Post;
        assert.equal(Object.keys(post.image_map || {}).length, 24, 'All original URLs remain recorded');
        assert.equal(new Set(Object.values(post.image_map || {})).size, 1);
        for (const floor of post.floor_list) {
            for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
                assert.equal(comment.avatar_url, 'image_1.jpg');
                for (const match of comment.content.matchAll(/src="\.\/images\/([^"]+)"/g)) {
                    assert.equal(match[1], 'image_1.jpg');
                }
            }
        }
        const archive = await readFile(join(root, job.id, 'backup.tar'));
        const files = new Map<string, string>();
        for (let offset = 0; archive[offset];) {
            const name = archive.subarray(offset, offset + 100).toString().split('\0')[0];
            const size = parseInt(archive.subarray(offset + 124, offset + 135).toString(), 8);
            files.set(name, archive.subarray(offset + 512, offset + 512 + size).toString());
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        assert.deepEqual(JSON.parse(files.get('post.json') || ''), post);
        assert(post.backup_date);
        assert.equal(new Date(post.backup_date).toISOString(), post.backup_date);
        assert((files.get('viewer.html') || '').includes(`datetime="${post.backup_date}"`));
        assert.match(files.get('viewer.html') || '', /能玩了/);
        assert.equal(JSON.parse(files.get('report.json') || '').backend, 'api');
        assert.equal(JSON.parse(files.get('report.json') || '').image_count, 1);
        assert.equal(files.get('images/image_1.jpg'), 'synthetic-image');
        assert.equal(files.size, 4);
    } finally { await queue.close(); }

    let attempts = 0;
    const runner = create_runner(async () => context, async (_context, _url, _post, before) => {
        await before?.(); attempts++; throw new Error('HTTP 429');
    }, 'api', new RequestPacer(0), new RequestPacer(5));
    await assert.rejects(runner(queue.list()[0], root, progress, signal), /HTTP 429/);
    assert.equal(attempts, 1, 'Stop further image requests after the first failure');
});

test('verified unavailable original produces a complete job with a note in the archive', async () => {
    const { content, source } = JSON.parse(await readFile('tests/regression/api-unavailable-emoticon.json', 'utf8'));
    const response = structuredClone(fixtures[0].response);
    Object.assign(response.page as object, { has_more: 0, total_page: 1 });
    Object.assign(response.first_floor as object, { content, sub_post_number: 0, sub_post_list: { sub_post_list: [] } });
    response.post_list = [];
    const context = {
        route: async () => undefined, routeWebSocket: async () => undefined,
        cookies: async () => [{ name: 'BDUSS', value: 'synthetic-session', expires: -1 }],
        close: async () => undefined,
        request: { post: async () => ({ status: () => 200, text: async () => JSON.stringify(response), dispose: async () => undefined }) },
    } as unknown as BrowserContext;
    const root = await mkdtemp(join(tmpdir(), 'tieba-api-missing-original-'));
    const queue = new JobQueue(root, create_runner(async () => context, async (_context, url) => {
        assert(!url.includes('shoubai_emoji_face_365'), 'Do not download a known missing original');
        return new Blob(['synthetic-avatar'], { type: 'image/png' });
    }, 'api', new RequestPacer(0), new RequestPacer(0)));
    await queue.initialize();
    try {
        const job = await queue.submit(String(baseline.id));
        const deadline = Date.now() + 5000;
        while (!['complete', 'partial', 'failed'].includes(job.status) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(job.status, 'complete', job.error || 'Job did not complete');
        assert.deepEqual(job.warnings, []);
        const archive = await readFile(join(root, job.id, 'backup.tar'));
        let report;
        for (let offset = 0; archive[offset];) {
            const name = archive.subarray(offset, offset + 100).toString().split('\0')[0];
            const size = parseInt(archive.subarray(offset + 124, offset + 135).toString(), 8);
            if (name === 'report.json') { report = JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString()); }
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        assert(report);
        assert.deepEqual(report.warnings, []);
        assert.equal(report.notes.length, 1);
        assert(report.notes[0].includes(source.web_image_url));
    } finally { await queue.close(); }
});

test('API request signing and non-retryable response validation', async () => {
    const form = sign_form({ kz: '123', pn: '1' });
    assert.equal(form.sign, createHash('md5').update('_client_type=20kz=123pn=1subapp_type=pctbs=36770b1f34c9bbf2e7d1a99d2b82fa9e').digest('hex'));
    const cases = [
        { status: 403, body: '<title>百度安全验证</title>', error: /HTTP 403/ },
        { status: 400, body: '{}', error: /HTTP 400/ },
        { status: 404, body: '{}', error: /HTTP 404/ },
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

test('API retries temporary failures at most three times through the shared request interval', async () => {
    for (const path of ['/c/f/pb/page_pc', '/c/f/pb/nestedFloor'] as const) {
        for (const failure of ['timeout', 'connection', 'body', 408, 429, 500, 502, 503, 504]) {
            for (const recover of [false, true]) {
                let now = 0, calls = 0, disposed = 0;
                const starts: number[] = [];
                const pacer = new RequestPacer(1500, () => now, async ms => { now += ms; });
                const parameters = { thread_id: '123', post_id: '456', offset: '10' };
                const context = { post: async (url: string, options: { form: unknown; maxRetries: number }) => {
                    calls++;
                    starts.push(now);
                    now += 100;
                    assert.equal(url, `https://tieba.baidu.com${path}`);
                    assert.deepEqual(options.form, sign_form(parameters), 'Retry the same page/cursor');
                    assert.equal(options.maxRetries, 0, 'No hidden retries outside the pacer');
                    const failing = !recover || calls < 4;
                    if (failing && failure === 'timeout') { throw new Error('apiRequestContext.post: Timeout 30000ms exceeded\nCall log:\nCookie: private'); }
                    if (failing && failure === 'connection') { throw new Error('apiRequestContext.post: ECONNRESET'); }
                    return {
                        status: () => failing && typeof failure === 'number' ? failure : 200,
                        headers: () => ({}),
                        text: async () => {
                            if (failing && failure === 'body') { throw new Error('ECONNRESET\nCookie: private'); }
                            return '{"error_code":0,"data":{"post_list":[]}}';
                        },
                        dispose: async () => { disposed++; },
                    } as unknown as APIResponse;
                } } as unknown as APIRequestContext;
                const result = create_api_request(context, 'https://tieba.baidu.com/p/123', pacer, signal)(path, parameters);
                if (recover) { assert.deepEqual(await result, { post_list: [] }); }
                else {
                    await assert.rejects(result, error => {
                        assert(error instanceof Error);
                        assert.match(error.message, /已重试 3 次，共 4 次请求/);
                        assert(error.message.includes(path));
                        assert(error.message.includes(typeof failure === 'number' ? `HTTP ${failure}` : failure === 'timeout' ? 'Timeout' : 'ECONNRESET'));
                        assert(!error.message.includes('private'));
                        return true;
                    });
                }
                assert.equal(calls, 4);
                assert.deepEqual(starts, [0, 1500, 3000, 4500]);
                assert.equal(disposed, failure === 'timeout' || failure === 'connection' ? (recover ? 1 : 0) : 4);
                await pacer.run(async () => { starts.push(now); }, signal);
                assert.equal(starts.at(-1), 6000, 'Retries retain the shared interval for the next request');
            }
        }
    }
});

test('API stops retrying on a terminal response or cancellation during the interval', async () => {
    let calls = 0, disposed = 0;
    const context = { post: async () => {
        calls++;
        return { status: () => calls === 1 ? 503 : 403, headers: () => ({}), dispose: async () => { disposed++; } };
    } } as unknown as APIRequestContext;
    await assert.rejects(create_api_request(context, '', new RequestPacer(0), signal)('/c/f/pb/page_pc', {}), /HTTP 403/);
    assert.equal(calls, 2);
    assert.equal(disposed, 2);

    const controller = new AbortController();
    calls = 0;
    const pacer = new RequestPacer(1000, () => 0, async () => { controller.abort(new Error('停止测试任务')); });
    await assert.rejects(create_api_request(context, '', pacer, controller.signal)('/c/f/pb/page_pc', {}), /停止测试任务/);
    assert.equal(calls, 1, 'Cancellation while waiting prevents the next attempt');
});

test('API respects Retry-After and allows cancellation of server-requested waits', async () => {
    const starts: number[] = [];
    const context = { post: async () => {
        starts.push(Date.now());
        return {
            status: () => starts.length === 1 ? 429 : 200,
            headers: () => ({ 'retry-after': '1' }), text: async () => '{"error_code":0}', dispose: async () => undefined,
        };
    } } as unknown as APIRequestContext;
    await create_api_request(context, '', new RequestPacer(25), signal)('/c/f/pb/page_pc', {});
    assert.equal(starts.length, 2);
    assert(starts[1] - starts[0] >= 1000, 'Server wait also applies when it exceeds the collection interval');

    for (const header of ['60', new Date(Date.now() + 120000).toUTCString()]) {
        const controller = new AbortController();
        let calls = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const context = { post: async () => {
            calls++;
            timer = setTimeout(() => controller.abort(), 10);
            return { status: () => 503, headers: () => ({ 'retry-after': header }), dispose: async () => undefined };
        } } as unknown as APIRequestContext;
        try {
            await assert.rejects(create_api_request(context, '', new RequestPacer(0), controller.signal)('/c/f/pb/page_pc', {}), /abort/i);
            assert.equal(calls, 1);
        } finally { clearTimeout(timer); }
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
