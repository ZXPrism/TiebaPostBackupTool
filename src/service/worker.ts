import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { Floor, Post } from '../types';
import type { PageParser } from '../shared/page-parser';
import { finalize_post } from '../shared/post';
import { ImageHandler } from '../image_handler';
import { allowed_url, has_session, open_browser, restrict_browser } from './browser';
import { config, project_dir, type Backend } from './config';
import { collect_api } from '../shared/api-collector';
import { create_api_request, RequestPacer } from './api';
import type { Job, Progress } from './model';
import { prepare_post_page } from './page-readiness';
import { prepare_downloads } from './compression';

declare global {
    interface Window { TiebaPage: { PageParser: typeof PageParser } }
}

export interface WorkerResult {
    title?: string;
    backup_date?: string;
    filename: string;
    floor_count: number;
    image_count: number;
    warnings: string[];
}

export type Runner = (job: Job, directory: string, progress: (value: Progress) => Promise<void>, signal: AbortSignal) => Promise<WorkerResult>;

async function fetch_image(context: BrowserContext, original: string, post_url: string, before_request?: () => Promise<void>): Promise<Blob> {
    let url = new URL(original, post_url).href;
    for (let redirects = 0; redirects < 5; redirects++) {
        if (!allowed_url(url)) { throw new Error('图片地址不在允许的域名内'); }
        await before_request?.();
        const response = await context.request.get(url, {
            timeout: 30000, maxRedirects: 0, maxRetries: 0, headers: { Referer: post_url },
        });
        try {
            if ([301, 302, 303, 307, 308].includes(response.status())) {
                const location = response.headers().location;
                if (!location) { throw new Error('图片重定向缺少地址'); }
                url = new URL(location, url).href;
                continue;
            }
            if (!response.ok()) { throw new Error(`图片 HTTP ${response.status()}`); }
            const type = response.headers()['content-type'] || '';
            if (!type.startsWith('image/')) { throw new Error('图片响应不是图像'); }
            const bytes = await response.body();
            if (!bytes.length || bytes.length > 25 * 1024 * 1024) { throw new Error('图片为空或超过 25 MB'); }
            return new Blob([new Uint8Array(bytes)], { type });
        } finally { await response.dispose(); }
    }
    throw new Error('图片重定向次数过多');
}

export function create_runner(
    launch: () => Promise<BrowserContext> = open_browser,
    download: typeof fetch_image = fetch_image,
    backend: Backend = config.backend,
    pacer = new RequestPacer(config.api_request_interval_ms),
    image_pacer = new RequestPacer(config.image_request_interval_ms),
): Runner {
    return async (job, directory, progress, signal) => {
        signal.throwIfAborted();
        const context = await launch();
        const abort = () => { void context.close().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        let page: Page | undefined;
        try {
            signal.throwIfAborted();
            await restrict_browser(context);
            if (!await has_session(context)) {
                throw new Error('未找到有效的 BDUSS 登录 Cookie。请先运行 npm run login 或 npm run login:import。');
            }
            let floors: Floor[] = [];
            let warnings: string[] = [];
            let notes: string[] = [];
            let metadata: Omit<Post, 'floor_list' | 'image_map'> | undefined;
            let total_pages = 1;
            if (backend === 'api') {
                const collection = await collect_api(job.post_id,
                    create_api_request(context.request, job.url, pacer, signal), progress, signal, config.max_api_pages);
                ({ floors, warnings, notes, metadata } = collection);
                total_pages = metadata.page_cnt;
            } else {
                page = await context.newPage();
                page.on('dialog', dialog => { void dialog.dismiss(); });
                let reply_count = 0;
                for (let number = 1; number <= total_pages; number++) {
                    signal.throwIfAborted();
                    await progress({ stage: '采集帖子', current: number, total: total_pages, collection: {
                        pages: { current: number - 1, total: metadata ? total_pages : undefined, complete: false },
                        replies: { current: reply_count, complete: false },
                    } });
                    const response = await page.goto(`${job.url}?pn=${number}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await prepare_post_page(page, response);
                    if (new URL(page.url()).pathname !== `/p/${job.post_id}`
                        || Number(new URL(page.url()).searchParams.get('pn') || '1') !== number) {
                        throw new Error(`第 ${number} 页地址不匹配：请求 ${job.url}?pn=${number}，实际 ${page.url()}`);
                    }
                    await page.addScriptTag({ path: join(project_dir, 'dist/service/page.js') });
                    const result = await page.evaluate(async () => {
                        const parser = new window.TiebaPage.PageParser();
                        const floors = await parser.parse_current_page();
                        return { metadata: parser.metadata(), floors, warnings: parser.warnings };
                    });
                    metadata = result.metadata;
                    if (metadata.id !== job.post_id) { throw new Error('页面帖子 ID 不匹配'); }
                    if (number === 1) {
                        total_pages = metadata.page_cnt;
                        if (!Number.isInteger(total_pages) || total_pages < 1 || total_pages > config.max_pages) {
                            throw new Error(`页数无效或超过 ${config.max_pages} 页限制`);
                        }
                    } else if (metadata.page_cnt !== total_pages) {
                        warnings.push(`第 ${number} 页显示的总页数发生变化，请重新备份确认内容`);
                    }
                    if (!result.floors.length) { throw new Error(`第 ${number} 页未解析到楼层`); }
                    const seen = new Set(floors.map(floor => floor.index));
                    if (result.floors.some(floor => seen.has(floor.index))) {
                        throw new Error(`第 ${number} 页出现重复楼层，停止采集`);
                    }
                    floors.push(...result.floors);
                    reply_count += result.floors.reduce((count, floor) => count + (floor.sub_comment_list?.length || 0), 0);
                    warnings.push(...result.warnings.map(message => `第 ${number} 页: ${message}`));
                    const complete = number === total_pages;
                    await progress({ stage: '采集帖子', current: number, total: total_pages, collection: {
                        pages: { current: number, total: total_pages, complete },
                        replies: { current: reply_count, total: complete ? reply_count : undefined, complete },
                    } });
                    if (number < total_pages) { await page.waitForTimeout(1000); }
                }
            }
            if (!metadata) { throw new Error('没有采集结果'); }
            let image_error: unknown;
            const images = new ImageHandler(async url => {
                signal.throwIfAborted();
                if (backend !== 'api') { return download(context, url, job.url); }
                try {
                    // ImageHandler caps in-flight downloads at five. Gate every start, including redirects.
                    return await download(context, url, job.url, () => image_pacer.run(async () => {
                        if (image_error) { throw image_error; }
                    }, signal));
                } catch (error) {
                    image_error ??= new Error(`图片 ${url}: ${error instanceof Error ? error.message : String(error)}`);
                    throw image_error;
                }
            });
            const post = finalize_post({ ...metadata, page_cnt: total_pages }, floors, images);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'post.json'), JSON.stringify(post, null, 2));
            const download_count = Object.keys(post.image_map || {}).length;
            await progress({ stage: '下载图片', current: 0, total: download_count });
            // Serialize asynchronous progress writes even though images are fetched in batches.
            let updates = Promise.resolve();
            let update_error: unknown;
            const downloaded_images = await images.download_images((current, total) => {
                updates = updates.then(() => progress({ stage: '下载图片', current, total }))
                    .catch(error => { update_error = error; });
            }, signal);
            await updates;
            if (update_error) { throw update_error; }
            if (image_error) { throw image_error; }
            signal.throwIfAborted();
            await progress({ stage: '整理图片' });
            const blobs = await images.deduplicate_images(post, downloaded_images, signal);
            const image_count = Object.keys(blobs).length;
            post.backup_date = new Date().toISOString();
            await writeFile(join(directory, 'post.json.tmp'), JSON.stringify(post, null, 2));
            await rename(join(directory, 'post.json.tmp'), join(directory, 'post.json'));
            warnings.push(...images.failed_images.map(name => `图片下载失败（已用占位图替代）: ${name}`));
            await progress({ stage: '打包文件' });
            const files: Record<string, string | Blob> = {
                'post.json': JSON.stringify(post, null, 2),
                'viewer.html': images.create_viewer_html(post),
                'report.json': JSON.stringify({ backend, warnings, notes, floor_count: floors.length, image_count }, null, 2),
            };
            for (const [name, blob] of Object.entries(blobs)) { files[`images/${name}`] = blob; }
            const archive = await images.create_tar(files);
            signal.throwIfAborted();
            await writeFile(join(directory, 'backup.tar.tmp'), new Uint8Array(await archive.arrayBuffer()));
            await rename(join(directory, 'backup.tar.tmp'), join(directory, 'backup.tar'));
            await progress({ stage: '准备下载文件' });
            await prepare_downloads(directory, signal);
            return {
                title: post.title, backup_date: post.backup_date,
                filename: `${post.tieba_name.replace(/[^\p{L}\p{N}_. -]/gu, '_')}_${post.id}.tar`,
                floor_count: floors.length, image_count, warnings,
            };
        } catch (error) {
            if (page && !page.isClosed()) {
                await page.screenshot({ path: join(directory, 'failure.png'), timeout: 5000 }).catch(() => undefined);
            }
            if (signal.aborted) { signal.throwIfAborted(); }
            throw error;
        } finally {
            signal.removeEventListener('abort', abort);
            await context.close().catch(() => undefined);
        }
    };
}
