import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ImageHandler } from '../src/image_handler';
import { compare_posts } from '../src/shared/regression';
import type { Post } from '../src/types';
import { create_runner } from '../src/service/worker';
import { JobQueue } from '../src/service/queue';
import { create_app } from '../src/service/http';
import { prepare_post_page } from '../src/service/page-readiness';
import { collect_api } from '../src/shared/api-collector';
import { finalize_post } from '../src/shared/post';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_CHROMIUM_EXECUTABLE_PATH }); });
after(async () => { await browser?.close(); });

test('service prepares legacy pages automatically and reports concrete HTTP/DOM failures', async () => {
    const page = await browser.newPage();
    let body = '<div class="pc-pb-title"><span class="pb-title">测试帖</span></div>';
    let status = 200;
    let switch_calls = 0;
    let switch_error = 0;
    try {
        await page.route('**/*', route => {
            if (new URL(route.request().url()).pathname === '/c/s/pc/updateSwitch') {
                switch_calls++;
                if (!switch_error) { body = '<div class="core_title_txt">旧版标题</div><div class="l_post l_post_bright">楼层</div>'; }
                return route.fulfill({ json: { error_code: switch_error } });
            }
            return route.fulfill({ status, contentType: 'text/html', body });
        });
        let response = await page.goto('https://tieba.baidu.com/p/1');
        await page.addScriptTag({ path: 'dist/service/page.js' });
        const plugin_error = await page.evaluate(() => {
            try { new window.TiebaPage.PageParser().metadata(); return ''; }
            catch (error) { return String(error); }
        });
        assert.match(plugin_error, /本插件仅支持旧版贴吧/);
        await prepare_post_page(page, response, 100);
        assert.equal(switch_calls, 1);
        assert.equal(await page.locator('.core_title_txt').count(), 1);
        await prepare_post_page(page, response, 100);
        assert.equal(switch_calls, 1, 'Legacy page should not call the switch endpoint');
        switch_error = 12;
        body = '<div class="pc-pb-title"><span class="pb-title">测试帖</span></div>';
        response = await page.goto('https://tieba.baidu.com/p/1');
        await assert.rejects(prepare_post_page(page, response, 100), /error_code=12/);
        status = 403;
        body = 'Forbidden';
        response = await page.goto('https://tieba.baidu.com/p/1');
        await assert.rejects(prepare_post_page(page, response, 100), /HTTP 403/);
        status = 200;
        body = '<div class="core_title_txt">旧版标题</div>';
        response = await page.goto('https://tieba.baidu.com/p/1');
        await assert.rejects(prepare_post_page(page, response, 100), error => {
            assert(error instanceof Error);
            assert.match(error.message, /仍缺少 \.l_post\.l_post_bright/);
            assert(!error.message.includes('仍缺少 .core_title_txt'));
            return true;
        });
        body += '<div class="l_post l_post_bright">楼层</div>';
        response = await page.goto('https://tieba.baidu.com/p/1');
        await prepare_post_page(page, response, 100);
    } finally { await page.close(); }
});

const post_id = 123456;
const base = `https://tieba.baidu.com/p/${post_id}`;
const avatar = 'https://himg.bdimg.com/avatar.jpg';
const photo = 'https://tiebapic.baidu.com/photo.png';
const metadata = { title: '测试帖子', tieba_name: '测试吧', tieba_url: 'https://tieba.baidu.com/f?kw=test', id: post_id, page_cnt: 2, comment_cnt: 4 };
function sub(author: string, content: string): string {
    return `<div class="lzl_single_post"><a class="at j_user_card" href="/home/main?id=${author}">${author}</a><span class="lzl_content_main">${content}</span><span class="lzl_time">2026-10-11 12:00</span></div>`;
}
function fixture(number: number, broken = false): string {
    const subs = number === 1 ? `<div id="subs">${sub('甲', '第一条')}</div><div class="j_pager"><span>1</span><a href="#2">2</a></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <h1 class="core_title_txt">测试帖子</h1><a class="card_title_fname" href="/f?kw=test">测试吧</a><div class="l_posts_num">4回复贴，共2页</div>
    <article class="l_post l_post_bright" data-field='{"content":{}}'>
        <a class="p_author_name" href="/home/main?id=author">楼主</a><div class="p_author_face"><img src="${avatar}"></div>
        <div class="core_reply_tail">2026-10-11 12:00</div><div class="p_tail"><span>${number}楼</span></div>
        <div class="d_post_content">第${number}页<img src="${photo}"></div>${subs}
    </article><article class="l_post l_post_bright" data-field="{}">广告</article>
    <script>document.querySelector('.j_pager a')?.addEventListener('click', event => {
        event.preventDefault();
        ${broken ? '' : `setTimeout(() => { document.getElementById('subs').innerHTML = ${JSON.stringify(sub('乙', '第二条'))}; document.querySelector('.j_pager').innerHTML = '<a href="#1">1</a><span>2</span>'; }, 1300);`}
    });</script></body></html>`;
}

async function routed_context(broken = false): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'BDUSS', value: 'synthetic-test-session', domain: '.baidu.com', path: '/' }]);
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/p/${post_id}`) {
            await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(Number(url.searchParams.get('pn') || 1), broken) });
        } else { await route.abort(); }
    });
    return context;
}

function unpack(bytes: Uint8Array): Map<string, string> {
    const files = new Map<string, string>();
    const decoder = new TextDecoder();
    for (let offset = 0; bytes[offset];) {
        const name = decoder.decode(bytes.slice(offset, offset + 100)).split('\0')[0];
        const length = parseInt(decoder.decode(bytes.slice(offset + 124, offset + 135)), 8);
        files.set(name, decoder.decode(bytes.slice(offset + 512, offset + 512 + length)));
        offset += 512 + Math.ceil(length / 512) * 512;
    }
    return files;
}

test('userscript and headless worker produce identical JSON across pages and delayed sub-comments', { timeout: 60000 }, async () => {
    const context = await routed_context();
    try {
        await context.addInitScript({ content: `
            Object.assign(window, {
                GM_getValue: (key, fallback) => {
                    const value = localStorage.getItem(key);
                    return value === null ? fallback : JSON.parse(value);
                },
                GM_setValue: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
                GM_deleteValue: key => localStorage.removeItem(key),
                GM_xmlhttpRequest: options => {
                    options.onload({ status: 200, response: new Blob(['test-image'], { type: 'image/png' }) });
                },
            });
        ` });
        await context.addInitScript({ path: 'dist/main.global.js' });
        const page = await context.newPage();
        const diagnostics: string[] = [];
        page.on('pageerror', error => diagnostics.push(error.message));
        page.on('console', entry => { if (entry.type() === 'warning' || entry.type() === 'error') { diagnostics.push(entry.text()); } });
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) { diagnostics.push(frame.url()); } });
        await page.goto(`${base}?pn=2`); // Plugin must navigate back to the first page.
        const downloading = page.waitForEvent('download', { timeout: 40000 });
        await page.locator('#tieba-backup-btn').click();
        const download = await downloading.catch(async error => {
            throw new Error(JSON.stringify({ diagnostics, page: await page.evaluate(() => ({ url: location.href, state: localStorage.getItem('parse_state'), error: localStorage.getItem('last_error'), button: document.getElementById('tieba-backup-btn')?.textContent })) }), { cause: error });
        });
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const plugin_files = unpack(Buffer.concat(chunks));
        const plugin_post = JSON.parse(plugin_files.get('post.json') || 'null') as Post;
        assert.deepEqual(plugin_post.floor_list.map(floor => floor.index), [1, 2]);
        assert.deepEqual(plugin_post.floor_list[0].sub_comment_list?.map(comment => comment.author), ['甲', '乙']);
        assert.equal(plugin_post.floor_list[0].comment.content, '第1页<img src="./images/image_1.png">');
        assert.equal(plugin_post.floor_list[0].comment.avatar_url, 'image_1.png');
        assert.deepEqual(plugin_post.image_map, { [photo]: 'image_1.png', [avatar]: 'image_1.png' });
        assert(!plugin_files.has('images/image_2.jpg'));
        assert.equal(JSON.parse(plugin_files.get('report.json') || '').image_count, 1);
        for (const [key, value] of Object.entries(metadata)) { assert.deepEqual(plugin_post[key as keyof Post], value); }

        const root = await mkdtemp(join(tmpdir(), 'tieba-browser-'));
        const queue = new JobQueue(root, create_runner(routed_context, async () => new Blob(['test-image'], { type: 'image/png' }), 'browser'));
        await queue.initialize();
        try {
            const job = await queue.submit(base);
            const deadline = Date.now() + 25000;
            while (!['complete', 'partial', 'failed'].includes(job.status) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.equal(job.status, 'complete', job.error || 'Job did not complete');
            assert.equal(job.image_count, 1);
            const cloud_post = JSON.parse(await readFile(join(root, job.id, 'post.json'), 'utf8'));
            assert.deepEqual(compare_posts(plugin_post, cloud_post), []);
            const cloud_files = unpack(await readFile(join(root, job.id, 'backup.tar')));
            assert.equal(cloud_files.get('post.json'), plugin_files.get('post.json'));
            assert(!cloud_files.has('images/image_2.jpg'));
            assert.equal(cloud_files.get('images/image_1.png'), plugin_files.get('images/image_1.png'));
            // Each export has its own backup date; all other HTML must remain identical.
            const without_date = (html: string) => html.replace(/<time class="backup-date" datetime="[^"]+">[^<]+<\/time>/, '<time>backup date</time>');
            assert.equal(without_date(cloud_files.get('viewer.html') || ''), without_date(plugin_files.get('viewer.html') || ''));
        } finally { await queue.close(); }
    } finally { await context.close(); }
});

test('stalled sub-comment pagination produces an explicit partial result', { timeout: 30000 }, async () => {
    const context = await routed_context(true);
    try {
        const page = await context.newPage();
        await page.goto(base);
        await page.addScriptTag({ path: 'dist/service/page.js' });
        const result = await page.evaluate(async () => {
            const parser = new window.TiebaPage.PageParser();
            return { floors: await parser.parse_current_page(), warnings: parser.warnings };
        });
        assert.equal(result.floors[0].sub_comment_list?.length, 1);
        assert(result.warnings.some(message => message.includes('内容未更新')));
    } finally { await context.close(); }
});

test('offline viewer renders baseline and cannot execute markup embedded in data', async () => {
    const baseline = JSON.parse(await readFile('tests/regression/post.json', 'utf8')) as Post;
    baseline.title = '</script><script>window.PWNED=true</script>';
    baseline.floor_list[0].comment.author = '<img src=x onerror="window.PWNED=true">';
    baseline.floor_list[0].comment.content += '<img src=x onerror="window.PWNED=true"><script>window.PWNED=true</script>';
    const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.abort());
        await page.setContent(new ImageHandler().create_viewer_html(baseline));
        assert.equal(await page.locator('.floor').count(), baseline.floor_list.length);
        assert.equal(await page.locator('h1').textContent(), baseline.title);
        assert.equal(await page.evaluate(() => 'PWNED' in window), false);
        assert.equal(await page.locator('.content [onerror]').count(), 0);
    } finally { await page.close(); }
});

test('API result renders all floors and nested replies in the shared offline viewer', async () => {
    const fixtures = JSON.parse(await readFile('tests/regression/api-responses.json', 'utf8')) as {
        path: string; parameters: Record<string, string>; response: { data?: unknown };
    }[];
    const result = await collect_api(3022463586, async (path, parameters) => {
        const record = fixtures.find(f => f.path === path && Object.entries(f.parameters).every(([key, value]) => parameters[key] === value));
        assert(record);
        return record.response.data || record.response;
    }, async () => undefined, new AbortController().signal);
    const post = finalize_post(result.metadata, result.floors);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.route('**/*', route => route.abort());
        await page.setContent(new ImageHandler().create_viewer_html(post));
        assert.equal(await page.locator('.floor').count(), 28);
        assert.equal(await page.locator('.sub-comment').count(), 36);
        assert.equal(await page.locator('.content img').count(), 12); // 11 distinct resources; one smiley appears twice.
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('offline viewer renders a large archive without reparsing previously rendered floors', async () => {
    const post = JSON.parse(await readFile('tests/regression/post.json', 'utf8')) as Post;
    const comment = { author: '测试作者', date: '2026-10-14 00:00', content: '楼中楼内容' };
    post.floor_list = Array.from({ length: 6000 }, (_, i) => ({
        index: i + 1,
        comment: { ...comment, content: `第 ${i + 1} 楼的正文` },
        sub_comment_list: Array.from({ length: 3 }, () => ({ ...comment })),
    }));
    const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.abort());
        await page.setContent(new ImageHandler().create_viewer_html(post), { timeout: 20000 });
        assert.equal(await page.locator('.floor').count(), 6000);
        assert.equal(await page.locator('.sub-comment').count(), 18000);
        assert.equal(await page.locator('.floor > .content').last().textContent(), '第 6000 楼的正文');
    } finally { await page.close(); }
});

test('HTTP API and frontend submit, poll, download without an access token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-http-'));
    let finish_collection = () => {};
    const collecting = new Promise<void>(resolve => { finish_collection = resolve; });
    const queue = new JobQueue(root, async (_job, directory, progress) => {
        await progress({ stage: '采集第 117 楼的楼中楼', current: 0, total: 5,
            collection: { pages: { current: 381, total: 381, complete: true }, replies: { current: 410, total: 20000, complete: false } } });
        await collecting;
        await writeFile(join(directory, 'post.json'), '{"ok":true}');
        await writeFile(join(directory, 'backup.tar'), 'archive');
        return { filename: '测试.tar', floor_count: 28, image_count: 24, warnings: ['模拟图片失败'] };
    });
    await queue.initialize();
    const server = create_app(queue);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('No address'); }
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage();
    try {
        assert.equal((await fetch(`${origin}/api/jobs`)).status, 200);
        const headers = { 'Content-Type': 'application/json' };
        assert.equal((await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{"url":"123"}' })).status, 403);
        assert.equal((await fetch(`${origin}/api/jobs`, { method: 'POST', headers, body: '{"url":"http://127.0.0.1"}' })).status, 400);
        await page.goto(origin);
        await page.locator('#post-url').fill(base);
        await page.locator('#submit').click();
        await page.getByRole('progressbar', { name: '全帖楼中楼' }).waitFor();
        assert.equal(await page.getByRole('progressbar').count(), 2);
        assert.equal(await page.getByRole('progressbar', { name: '楼层分页' }).getAttribute('value'), '381');
        const replies = page.getByRole('progressbar', { name: '全帖楼中楼' });
        assert.equal(await replies.getAttribute('value'), '410');
        assert.equal(await replies.getAttribute('max'), '20000');
        assert.match(await page.locator('.job').innerText(), /410 \/ 约 20000 条/);
        const saved = JSON.parse(await readFile(join(root, queue.list()[0].id, 'job.json'), 'utf8'));
        assert.equal(saved.progress.collection.replies.current, 410);
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: join(root, 'collection-progress.png'), fullPage: true });
        console.log(`Progress screenshot: ${join(root, 'collection-progress.png')}`);
        finish_collection();
        await page.locator('.badge.partial').waitFor();
        const downloading = page.waitForEvent('download');
        await page.getByRole('button', { name: '下载 JSON' }).click();
        const download = await downloading;
        assert.equal(download.suggestedFilename(), 'post.json');
        await page.screenshot({ path: join(root, 'frontend.png'), fullPage: true });
        console.log(`Frontend screenshot: ${join(root, 'frontend.png')}`);
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        const job = queue.list()[0];
        const response = await fetch(`${origin}/api/jobs/${job.id}/download`, { headers });
        assert.equal(await response.text(), 'archive');
        assert(response.headers.get('content-disposition')?.includes("filename*=UTF-8''"));
    } finally {
        finish_collection();
        await page.close();
        await queue.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
