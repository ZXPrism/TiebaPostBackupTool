import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Post } from '../src/types';
import { compare_posts } from '../src/shared/regression';
import { finalize_post } from '../src/shared/post';
import { ImageHandler } from '../src/image_handler';
import { parse_post_url } from '../src/service/model';
import { allowed_url } from '../src/service/browser';
import { JobQueue } from '../src/service/queue';

const bytes = await readFile('tests/regression/post.json');
const baseline = JSON.parse(bytes.toString()) as Post;

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
    assert.deepEqual(parse_post_url('https://tieba.baidu.com/p/123?pn=2#reply'), { id: 123, url: 'https://tieba.baidu.com/p/123' });
    assert.equal(parse_post_url('123').id, 123);
    for (const url of ['http://localhost/p/1', 'file:///etc/passwd', 'https://tieba.baidu.com.evil.test/p/1', 'https://user@tieba.baidu.com/p/1', 'https://tieba.baidu.com:9000/p/1', '0']) {
        assert.throws(() => parse_post_url(url));
    }
    assert(allowed_url('https://tiebapic.baidu.com/a.jpg'));
    for (const url of ['http://127.0.0.1/a', 'http://baidu.com.evil.test/a', 'https://baidu.com:3000/a', 'data:image/svg+xml,test']) {
        assert(!allowed_url(url));
    }
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
