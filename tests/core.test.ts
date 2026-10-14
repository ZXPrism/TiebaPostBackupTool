import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Post } from '../src/types';
import { compare_posts, regression_report } from '../src/shared/regression';
import { finalize_post } from '../src/shared/post';
import { ImageHandler } from '../src/image_handler';
import { parse_post_url } from '../src/service/model';
import { allowed_url } from '../src/service/browser';
import { JobQueue } from '../src/service/queue';

const bytes = await readFile('tests/regression/post.json');
const baseline = JSON.parse(bytes.toString()) as Post;

test('saved backup date drives the viewer and is explicitly accounted for in regression', () => {
    const post = { ...baseline, backup_date: '2026-10-13T16:44:55.728Z' };
    const html = new ImageHandler().create_viewer_html(post);
    assert(html.includes('<time class="backup-date" datetime="2026-10-13T16:44:55.728Z">备份日期：2026/10/14 00:44:55（UTC+8）</time>'));
    const report = regression_report(baseline, post);
    assert.deepEqual(report.differences, []);
    assert.deepEqual(report.accepted_backup_date_differences, [{ path: '$.backup_date', expected: undefined, actual: post.backup_date }]);
    assert.equal(report.strict_differences.length, 1);
    assert.equal(regression_report(baseline, post, { strict: true }).differences.length, 1);
    assert.deepEqual(regression_report(post, { ...post, backup_date: '2026-10-14T00:00:00.000Z' }).differences, []);
    for (const backup_date of ['', 'invalid', '2026-02-30T00:00:00.000Z']) {
        assert.equal(regression_report(baseline, { ...post, backup_date }).differences.length, 1);
    }
    assert.equal(regression_report(baseline, { ...post, title: 'changed' }).differences.length, 1);
    assert.equal(baseline.backup_date, undefined, 'Historical baseline stays unchanged');
});

test('reference JSON stays unchanged; image mapping round trip preserves every field', () => {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'e29101d807c27eddff57ec61e6c8b3c18b82f2ef857bf20ca96cb7420d2007f0');
    const raw = structuredClone(baseline);
    const reverse = new Map(Object.entries(raw.image_map || {}).map(([url, name]) => [name, url]));
    for (const floor of raw.floor_list) {
        for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
            comment.content = comment.content.replace(/\.\/images\/(image_\d+\.[a-z0-9]+)/g, (name, key) => reverse.get(key) || name);
            if (comment.avatar_url) { comment.avatar_url = reverse.get(comment.avatar_url) || comment.avatar_url; }
        }
    }
    const { floor_list, image_map: _map, ...metadata } = raw;
    assert.deepEqual(compare_posts(baseline, finalize_post(metadata, floor_list)), []);
});

test('regression catches omissions, content, ordering, and metadata changes', () => {
    const actual = structuredClone(baseline);
    actual.floor_list[0].comment.content += 'CHANGED';
    actual.floor_list[1].comment.author = 'CHANGED';
    actual.floor_list.pop();
    actual.comment_cnt++;
    const paths = compare_posts(baseline, actual).map(diff => diff.path);
    assert(paths.includes('$.floor_list[0].comment.content'));
    assert(paths.includes('$.floor_list[1].comment.author'));
    assert(paths.includes('$.floor_list.length'));
    assert(paths.includes('$.comment_cnt'));
    const reordered = structuredClone(baseline);
    reordered.floor_list.reverse();
    assert(compare_posts(baseline, reordered).length > 0);
});

test('image normalization is opt-in and never hides missing images or changed URLs', () => {
    const renamed = JSON.parse(JSON.stringify(baseline).replace(/image_(?=\d)/g, 'renamed_')) as Post;
    assert(compare_posts(baseline, renamed).length > 0);
    assert.deepEqual(compare_posts(baseline, renamed, true), []);
    const key = Object.keys(renamed.image_map || {})[0];
    if (!renamed.image_map) { throw new Error('No image map'); }
    renamed.image_map['https://tiebapic.baidu.com/changed.jpg'] = renamed.image_map[key];
    delete renamed.image_map[key];
    assert(compare_posts(baseline, renamed, true).length > 0);
});

test('user URL validation and downloaded resource allowlist', () => {
    for (const url of [
        'https://tieba.baidu.com/p/123',
        'https://tieba.baidu.com/p/123?pn=2&pid=456&see_lz=1#456',
        'https://tieba.baidu.com/p/123#reply',
        'https://tieba.baidu.com/p/123/?share=复制链接',
        'https://tieba.baidu.com/p/123/extra/path?pid=456#reply',
        '  http://tieba.baidu.com/p/123?redirect=https%3A%2F%2Fexample.com%2Fp%2F456  ',
        `https://tieba.baidu.com/p/123?share=${'x'.repeat(3000)}`,
    ]) { assert.deepEqual(parse_post_url(url), { id: 123, url: 'https://tieba.baidu.com/p/123' }); }
    assert.equal(parse_post_url('123').id, 123);
    for (const url of ['http://localhost/p/1', 'file:///etc/passwd', 'https://tieba.baidu.com.evil.test/p/1', 'https://user@tieba.baidu.com/p/1', 'https://tieba.baidu.com:9000/p/1', '0',
        'https://tieba.baidu.com/p/123abc?pn=2', 'https://tieba.baidu.com/p/?id=123',
        'https://example.com/?url=https://tieba.baidu.com/p/123', 'https://tieba.baidu.com/p/9007199254740992?pn=2']) {
        assert.throws(() => parse_post_url(url));
    }
    assert.throws(() => parse_post_url('not a URL'), /请输入贴吧帖子链接或帖子 ID/);
    assert(allowed_url('https://tiebapic.baidu.com/a.jpg'));
    for (const url of ['http://127.0.0.1/a', 'http://baidu.com.evil.test/a', 'https://baidu.com:3000/a', 'data:image/svg+xml,test']) {
        assert(!allowed_url(url));
    }
});

test('image content deduplication preserves references, source URLs and deterministic first filenames', async () => {
    const images = new ImageHandler();
    const post: Post = { ...baseline, image_map: {
        'https://tiebapic.baidu.com/first.png': 'image_1.png',
        'https://tiebapic.baidu.com/alias.jpg': 'image_2.jpg',
        'https://tiebapic.baidu.com/different.png': 'image_3.png',
    }, floor_list: [{ index: 1, comment: {
        author: '甲', date: '2026-10-14', avatar_url: 'image_2.jpg',
        content: `image_2.jpg src="./images/image_2.jpg" <img alt="src='./images/image_2.jpg'" SRC = './images/image_2.jpg'>`,
    }, sub_comment_list: [{ author: '乙', date: '2026-10-14', avatar_url: 'image_3.png', content: '<img src="./images/image_2.jpg"><img src="./images/image_3.png">' }] }] };
    assert(post.image_map);
    const original_urls = Object.keys(post.image_map);
    const blobs = {
        'image_3.png': new Blob(['different'], { type: 'image/png' }),
        'image_2.jpg': new Blob(['identical'], { type: 'image/jpeg' }),
        'image_1.png': new Blob(['identical'], { type: 'image/png' }),
    };
    const unique = await images.deduplicate_images(post, blobs);
    assert.deepEqual(Object.keys(unique), ['image_1.png', 'image_3.png']);
    assert.equal(unique['image_1.png'], blobs['image_1.png']);
    assert.deepEqual(Object.keys(post.image_map), original_urls);
    assert.equal(post.image_map[original_urls[1]], 'image_1.png');
    assert.equal(post.floor_list[0].comment.avatar_url, 'image_1.png');
    assert.equal(post.floor_list[0].comment.content, `image_2.jpg src="./images/image_2.jpg" <img alt="src='./images/image_2.jpg'" SRC = './images/image_1.png'>`);
    assert.equal(post.floor_list[0].sub_comment_list?.[0].content, '<img src="./images/image_1.png"><img src="./images/image_3.png">');
    assert.equal(post.floor_list[0].sub_comment_list?.[0].avatar_url, 'image_3.png');
    const saved = structuredClone(post);
    assert.deepEqual(await images.deduplicate_images(post, unique), unique);
    assert.deepEqual(post, saved);
    assert.equal(Object.keys(blobs).length, 3, 'Input blobs are not mutated');
});

test('deduplication leaves failed placeholders distinct and does not mutate a post on missing data or cancellation', async () => {
    const images = new ImageHandler(async () => { throw new Error('offline'); }, {
        'https://tiebapic.baidu.com/a.png': 'image_1.png', 'https://tiebapic.baidu.com/b.png': 'image_2.png',
    });
    const post: Post = { ...baseline, floor_list: [], image_map: {
        'https://tiebapic.baidu.com/a.png': 'image_1.png', 'https://tiebapic.baidu.com/b.png': 'image_2.png',
    } };
    const original = structuredClone(post);
    const blobs = await images.download_images();
    assert.equal(Object.keys(await images.deduplicate_images(post, blobs)).length, 2);
    assert.deepEqual(images.failed_images.sort(), ['image_1.png', 'image_2.png']);
    assert.deepEqual(post, original);
    await assert.rejects(images.deduplicate_images(post, { 'image_1.png': blobs['image_1.png'] }), /缺少已下载的图片: image_2.png/);
    assert.deepEqual(post, original);
    const controller = new AbortController();
    const aborting = new Blob(['image']);
    aborting.arrayBuffer = async () => { controller.abort(new Error('cancel hashing')); return new ArrayBuffer(0); };
    await assert.rejects(new ImageHandler().deduplicate_images(post, { ...blobs, 'image_1.png': aborting }, controller.signal), /cancel hashing/);
    assert.deepEqual(post, original);
});

test('image normalization supports alias filenames without concealing changes to alias groups', () => {
    const post: Post = { ...baseline, image_map: { 'https://a.test/1': 'a.png', 'https://a.test/2': 'a.png' },
        floor_list: [{ index: 1, comment: { author: '甲', date: '2026-10-14', content: '<img src="./images/a.png">', avatar_url: 'a.png' } }] };
    const renamed = JSON.parse(JSON.stringify(post).replaceAll('a.png', 'renamed.png')) as Post;
    assert.deepEqual(compare_posts(post, renamed, true), []);
    assert(renamed.image_map);
    renamed.image_map['https://a.test/2'] = 'different.png';
    assert(compare_posts(post, renamed, true).length > 0, 'Splitting or merging alias groups remains visible');
});

test('image failures are reported, TAR has correct bytes and checksums', async () => {
    const images = new ImageHandler(async url => {
        if (url.endsWith('bad.png')) { throw new Error('offline'); }
        return new Blob(['image'], { type: 'image/png' });
    }, { 'https://tiebapic.baidu.com/ok.png': 'image_1.png', 'https://tiebapic.baidu.com/bad.png': 'image_2.png' });
    const results = await images.download_images();
    assert.deepEqual(images.failed_images, ['image_2.png']);
    assert.equal(await results['image_1.png'].text(), 'image');
    assert.equal(results['image_2.png'].type, 'image/svg+xml');
    const tar = new Uint8Array(await (await images.create_tar({ 'post.json': '测试内容', 'images/image_1.png': results['image_1.png'] })).arrayBuffer());
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(tar.slice(0, 9)), 'post.json');
    const length = parseInt(decoder.decode(tar.slice(124, 135)), 8);
    assert.equal(decoder.decode(tar.slice(512, 512 + length)), '测试内容');
    const sum = tar.slice(0, 512).reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0);
    assert.equal(parseInt(decoder.decode(tar.slice(148, 154)), 8), sum);
    assert(tar.slice(-1024).every(value => value === 0));
});

test('queue serializes jobs, deduplicates pending posts, persists and recovers interruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-queue-'));
    let active = 0;
    let peak = 0;
    const queue = new JobQueue(root, async (_job, _directory, progress) => {
        active++; peak = Math.max(peak, active);
        await progress({ stage: 'testing' });
        await new Promise(resolve => setTimeout(resolve, 30));
        active--;
        return { filename: 'test.tar', floor_count: 1, image_count: 0, warnings: [] };
    });
    await queue.initialize();
    const first = await queue.submit('123');
    assert.equal((await queue.submit('123')).id, first.id);
    const second = await queue.submit('124');
    const deadline = Date.now() + 3000;
    while (queue.get(second.id)?.status !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(queue.get(second.id)?.status, 'complete');
    assert.equal(peak, 1);
    await queue.close();
    await mkdir(join(root, first.id), { recursive: true });
    await writeFile(join(root, first.id, 'job.json'), JSON.stringify({ ...first, status: 'running' }));
    const restored = new JobQueue(root, async () => { throw new Error('Should not rerun interrupted job'); });
    await restored.initialize();
    assert.equal(restored.get(first.id)?.status, 'failed');
    assert.equal(restored.get(second.id)?.status, 'complete');
    await restored.close();
});
