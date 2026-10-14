import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
            assert(plugin_post.backup_date);
            assert(cloud_post.backup_date);
            for (const post of [plugin_post, cloud_post]) {
                assert.equal(new Date(post.backup_date).toISOString(), post.backup_date);
            }
            assert.deepEqual(compare_posts({ ...plugin_post, backup_date: cloud_post.backup_date }, cloud_post), []);
            const cloud_files = unpack(await readFile(join(root, job.id, 'backup.tar')));
            assert.deepEqual(JSON.parse(cloud_files.get('post.json') || ''), cloud_post);
            assert(!cloud_files.has('images/image_2.jpg'));
            assert.equal(cloud_files.get('images/image_1.png'), plugin_files.get('images/image_1.png'));
            // Each export has its own backup date; all other HTML must remain identical.
            const without_date = (html: string) => html.replace(/<time class="backup-date" datetime="[^"]+">[^<]+<\/time>/, '<time>backup date</time>');
            assert((cloud_files.get('viewer.html') || '').includes(`datetime="${cloud_post.backup_date}"`));
            assert((plugin_files.get('viewer.html') || '').includes(`datetime="${plugin_post.backup_date}"`));
            assert.equal(without_date(cloud_files.get('viewer.html') || ''),
                without_date(plugin_files.get('viewer.html') || '').replaceAll(plugin_post.backup_date, cloud_post.backup_date));
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

test('post lookup is read-only, explicit backup resumes across reloads and diagnostics stay in logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tieba-http-'));
    const history = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    const snapshot_content = '正文 &amp; 换行<br>第二行<img src="https://example.com/should-not-load.png" alt="[笑]">'
        + '<script>window.snapshotExecuted=true</script><iframe src="https://example.com/iframe"></iframe>';
    const make_post = (date: string) => ({ ...metadata, backup_date: date,
        floor_list: [{ index: 1, comment: { author: '作者', date: '2000-01-01', content: snapshot_content } }] });
    // Legacy records lack metadata: read their actual backup date/title from post.json, not job creation time.
    for (const [index, id] of history.entries()) {
        const directory = join(root, id);
        await mkdir(directory);
        await writeFile(join(directory, 'job.json'), JSON.stringify({ id, post_id, url: base, status: 'complete',
            created_at: `2005-01-0${2 - index}T00:00:00.000Z`, updated_at: '2005-01-01T00:00:00.000Z',
            progress: { stage: 'INTERNAL_STAGE' }, warnings: ['INTERNAL_WARNING'], filename: '历史.tar', floor_count: 1, image_count: 0 }));
        await writeFile(join(directory, 'post.json'), JSON.stringify(make_post(`2001-01-0${index + 1}T00:00:00.000Z`)));
        await writeFile(join(directory, 'backup.tar'), 'history archive');
    }
    let finish_collection = () => {};
    const collecting = new Promise<void>(resolve => { finish_collection = resolve; });
    let runs = 0;
    const latest_post = JSON.stringify(make_post('2026-01-01T00:00:00.000Z'));
    const queue = new JobQueue(root, async (_job, directory, progress) => {
        runs++;
        if (runs > 1) { throw new Error('INTERNAL_FAILURE: /private/path API attempt 3'); }
        await progress({ stage: 'INTERNAL_STAGE: 采集第 117 楼的楼中楼', current: 0, total: 5,
            collection: { pages: { current: 381, total: 381, complete: true }, replies: { current: 410, total: 20000, complete: false } } });
        await collecting;
        await writeFile(join(directory, 'post.json'), latest_post);
        await writeFile(join(directory, 'backup.tar'), 'archive');
        return { title: '最新结果', backup_date: '2026-01-01T00:00:00.000Z', filename: '测试.tar', floor_count: 28, image_count: 24, warnings: ['INTERNAL_WARNING'] };
    });
    await queue.initialize();
    const server = create_app(queue);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    const query = async (value = `${base}/?pn=30&pid=456&share=复制链接#456`) => {
        await page.locator('#post-url').fill(value);
        await page.getByRole('button', { name: '查询备份' }).click();
        await page.locator('#results').waitFor();
    };
    try {
        assert.equal((await fetch(`${origin}/api/jobs`)).status, 404);
        assert.equal((await fetch(`${origin}/api/jobs/${history[0]}`)).status, 404);
        const headers = { 'Content-Type': 'application/json' };
        assert.equal((await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{"url":"123"}' })).status, 403);
        assert.equal((await fetch(`${origin}/api/jobs`, { method: 'POST', headers, body: '{"url":"http://127.0.0.1"}' })).status, 400);
        await page.goto(origin);
        assert.equal(await page.locator('#results').isVisible(), false);
        assert.equal(requests.some(url => url.includes('/api/')), false, 'Opening the page does not enumerate jobs');
        await query('999999');
        assert.match(await page.locator('#backups').innerText(), /暂无可下载/);
        assert.equal(runs, 0);
        await query();
        assert.equal(await page.locator('#backups .job').count(), 2);
        assert.equal(await page.locator('#backups time').first().getAttribute('datetime'), '2001-01-02T00:00:00.000Z');
        assert.equal(runs, 0, 'Lookup never starts a backup, even when history exists');
        assert.equal(await page.getByRole('button', { name: '开始备份', exact: true }).isVisible(), true);
        await page.locator('.snapshot summary').first().click();
        await page.locator('.snapshot-text').first().waitFor();
        assert.equal(await page.locator('.snapshot-text').first().textContent(), '正文 & 换行\n第二行[笑]');
        assert.equal(await page.locator('img, iframe').count(), 0);
        assert(!requests.some(url => url.includes('example.com')));
        assert(!await page.evaluate(() => 'snapshotExecuted' in window));
        const polled = page.waitForResponse(response => response.url().includes('/api/posts?'));
        await polled;
        assert.equal(await page.locator('.snapshot').first().getAttribute('open'), '');
        await page.getByRole('button', { name: '开始备份', exact: true }).click();
        await page.getByRole('progressbar', { name: '全帖楼中楼' }).waitFor();
        const deadline = Date.now() + 5000;
        while (await page.getByRole('progressbar', { name: '全帖楼中楼' }).getAttribute('value') !== '410' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await page.getByRole('progressbar').count(), 2);
        assert.equal(await page.getByRole('progressbar', { name: '楼层分页' }).getAttribute('value'), '381');
        assert.equal(await page.getByRole('progressbar', { name: '全帖楼中楼' }).getAttribute('value'), '410');
        assert.equal(await page.getByRole('progressbar', { name: '全帖楼中楼' }).getAttribute('max'), '20000');
        assert.equal(await page.locator('#start-backup').isVisible(), false);
        assert.equal(await page.locator('#backups .job').count(), 2);
        const job = queue.list().find(job => job.status === 'running');
        assert(job);
        assert.equal(job.url, base);
        const lookup = await (await fetch(`${origin}/api/posts?url=${post_id}`)).json();
        assert(!JSON.stringify(lookup).includes('INTERNAL'));
        const duplicate = await fetch(`${origin}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ url: base }) });
        assert.equal(duplicate.status, 202);
        assert(!JSON.stringify(await duplicate.json()).includes('INTERNAL'));
        assert.equal(runs, 1);
        const queued_response = await fetch(`${origin}/api/jobs`, { method: 'POST', headers, body: '{"url":"999999"}' });
        const queued = await queued_response.json();
        assert.equal(queued.active.status, 'queued');
        await query('999999');
        assert.match(await page.locator('#active-backup').innerText(), /已进入队列/);
        assert.equal(await page.getByRole('progressbar').count(), 2);
        assert.equal(await page.locator('#start-backup').isVisible(), false);
        assert.equal(await page.locator('#backups .job').count(), 0, 'Other posts do not expose this post’s history');
        assert.equal(runs, 1, 'Querying a queued post does not start another worker');
        await page.reload();
        assert.equal(await page.locator('#results').isVisible(), false);
        await query();
        assert.equal(await page.getByRole('progressbar', { name: '全帖楼中楼' }).getAttribute('value'), '410');
        assert.equal(await page.locator('#start-backup').isVisible(), false);
        assert.equal(await page.locator('#backups .job').count(), 2);
        assert.equal(runs, 1);
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: join(root, 'collection-progress.png'), fullPage: true });
        console.log(`Progress screenshot: ${join(root, 'collection-progress.png')}`);
        finish_collection();
        await page.getByRole('heading', { name: '最新结果' }).waitFor();
        assert.equal(await page.locator('#backups .job').count(), 3);
        assert.equal(await page.locator('#start-backup').isVisible(), true);
        assert.equal(await page.getByRole('progressbar').count(), 0);
        assert(!await page.getByRole('button', { name: '重新备份' }).count());
        assert(!((await page.locator('body').innerText()).includes('INTERNAL')));
        assert.equal(await page.getByRole('button', { name: '下载 JSON' }).count(), 0);
        for (const encoding of ['gzip', 'zstd']) {
            await page.setExtraHTTPHeaders({ 'Accept-Encoding': encoding });
            const response = page.waitForResponse(value => value.url().endsWith('/download'));
            const saving = page.waitForEvent('download');
            await page.locator('#backups .job').first().getByRole('button', { name: '下载备份', exact: true }).click();
            assert.equal((await response).headers()['content-encoding'], encoding);
            const saved = await saving;
            assert.equal(saved.suggestedFilename(), '测试.tar');
            assert.equal(await readFile(await saved.path(), 'utf8'), 'archive');
        }
        await page.screenshot({ path: join(root, 'frontend.png'), fullPage: true });
        console.log(`Frontend screenshot: ${join(root, 'frontend.png')}`);
        await page.getByRole('button', { name: '开始备份', exact: true }).click();
        await page.locator('#last-failure').waitFor();
        assert.equal(await page.locator('#start-backup').isVisible(), true);
        assert.equal(await page.locator('#backups .job').count(), 3);
        assert(!((await page.locator('body').innerText()).includes('INTERNAL')));
        const failed = queue.list().find(job => job.status === 'failed' && job.post_id === post_id);
        assert(failed);
        assert.match(await readFile(join(root, failed.id, 'job.log'), 'utf8'), /INTERNAL_FAILURE/);
        const after_failure = await (await fetch(`${origin}/api/posts?url=${post_id}`)).json();
        assert.equal(after_failure.last_attempt_failed, true);
        assert(!JSON.stringify(after_failure).includes('INTERNAL'));
        assert.match(await readFile(join(root, job.id, 'job.log'), 'utf8'), /INTERNAL_STAGE/);
        assert.match(await readFile(join(root, job.id, 'job.log'), 'utf8'), /INTERNAL_WARNING/);
        await unlink(join(root, history[0], 'backup.tar'));
        const unavailable = await fetch(`${origin}/api/jobs/${history[0]}/download`);
        assert.equal(unavailable.status, 500);
        assert.deepEqual(await unavailable.json(), { error: '暂时无法完成请求，请稍后再试' });
        assert.match(await readFile(join(root, 'service.log'), 'utf8'), /ENOENT/);
        assert.equal((await fetch(`${origin}/api/jobs/${job.id}/job.log`)).status, 404);
    } finally {
        finish_collection();
        await page.close();
        await queue.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
