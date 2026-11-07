import { create_viewer_html } from '../shared/viewer';
import { write_tar, type ArchiveFile } from './archive';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { finalize_post } from '../shared/post';
import { ImageHandler } from '../shared/image_handler';
import { allowed_url } from './resource-url';
import { config } from './config';
import { collect_api } from '../shared/api-collector';
import { create_api_request, RequestPacer } from './api';
import type { Job, Progress } from './model';
import { prepare_downloads } from './compression';
import type { Log } from './logging';
import { HttpTransportError, open_http_session, type HttpSession } from './transport';
import { save_image, save_images } from './images';

export interface WorkerResult {
    title?: string;
    backup_date?: string;
    filename: string;
    floor_count: number;
    image_count: number;
    warnings: string[];
}

export type Runner = (job: Job, directory: string, progress: (value: Progress) => Promise<void>, signal: AbortSignal, log?: Log) => Promise<WorkerResult>;

async function* fetch_image(context: HttpSession, original: string, post_url: string, before_request?: () => Promise<void>): AsyncGenerator<Uint8Array> {
    let url = new URL(original, post_url).href;
    for (let redirects = 0; redirects < 5; redirects++) {
        if (!allowed_url(url)) { throw new Error('图片地址不在允许的域名内'); }
        await before_request?.();
        const response = await context.request.get(url, {
            timeout: config.request_timeout_ms, headers: { Referer: post_url },
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
            yield* response.stream();
            return;
        } finally { await response.dispose(); }
    }
    throw new Error('图片重定向次数过多');
}

export function create_runner(
    download: (context: HttpSession, original: string, post_url: string, before_request?: () => Promise<void>) => AsyncIterable<Uint8Array> = fetch_image,
    pacer = new RequestPacer(config.api_request_interval_ms),
    image_pacer = new RequestPacer(config.image_request_interval_ms),
    http_session = open_http_session,
): Runner {
    return async (job, directory, progress, signal, log) => {
        signal.throwIfAborted();
        const context = await http_session(signal);
        const image_directory = join(directory, 'images.tmp');
        const abort = () => { void context.close().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            signal.throwIfAborted();
            const { floors, warnings, notes, metadata } = await collect_api(job.post_id,
                create_api_request(context.request, job.url, pacer, signal, log), progress, signal, config.max_api_pages,
                async location => { await log?.('warn', 'api_content_empty', location); },
                async summary => { await log?.('warn', 'api_fold_summary_unresolved', { ...summary,
                    message: '接口标记存在折叠内容，但遍历楼层后未返回具体折叠楼层，继续备份已返回内容' }); });
            let image_error: unknown;
            const images = new ImageHandler();
            const post = finalize_post(metadata, floors, images);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'post.json'), JSON.stringify(post, null, 2));
            const download_count = Object.keys(post.image_map || {}).length;
            await progress({ stage: '下载图片', current: 0, total: download_count });
            let updates = Promise.resolve();
            const saved_images = await save_images(post, image_directory, async (url, path) => {
                signal.throwIfAborted();
                for (let retries = 0; ; retries++) {
                    try {
                        // Retried requests and redirects use the same image pacer as first attempts.
                        return await save_image(download(context, url, job.url, () => image_pacer.run(async () => {
                            if (image_error) { throw image_error; }
                        }, signal)), path, signal);
                    } catch (error) {
                        signal.throwIfAborted();
                        if (!image_error && error instanceof HttpTransportError && retries < 3) {
                            await log?.('warn', 'image_retry', { url, attempt: retries + 1, next_attempt: retries + 2,
                                reason: error.message });
                            continue;
                        }
                        const name = post.image_map?.[url];
                        const floors = name ? post.floor_list.filter(floor => [floor.comment, ...(floor.sub_comment_list || [])]
                            .some(comment => comment.avatar_url === name || comment.content.includes(`./images/${name}"`)))
                            .map(floor => floor.index) : [];
                        const location = floors.length ? `第 ${floors.join('、')} 楼: ` : '';
                        image_error ??= new Error(`${location}图片 ${url}: ${error instanceof Error ? error.message : String(error)}`);
                        throw image_error;
                    }
                }
            }, (current, total) => {
                updates = updates.then(() => progress({ stage: '下载图片', current, total }));
                return updates;
            }, signal);
            signal.throwIfAborted();
            await progress({ stage: '整理图片' });
            const image_count = Object.keys(saved_images).length;
            post.backup_date = new Date().toISOString();
            await writeFile(join(directory, 'post.json.tmp'), JSON.stringify(post, null, 2));
            await rename(join(directory, 'post.json.tmp'), join(directory, 'post.json'));
            await progress({ stage: '打包文件' });
            const files: Record<string, string | ArchiveFile> = {
                'post.json': JSON.stringify(post, null, 2),
                'viewer.html': create_viewer_html(post),
                'report.json': JSON.stringify({ backend: 'api', warnings, notes, floor_count: floors.length, image_count }, null, 2),
            };
            for (const [name, file] of Object.entries(saved_images)) { files[`images/${name}`] = file; }
            await write_tar(join(directory, 'backup.tar.tmp'), files, signal);
            signal.throwIfAborted();
            await rename(join(directory, 'backup.tar.tmp'), join(directory, 'backup.tar'));
            await rm(image_directory, { recursive: true, force: true });
            await progress({ stage: '准备下载文件' });
            await prepare_downloads(directory, signal);
            return {
                title: post.title, backup_date: post.backup_date,
                filename: `${post.tieba_name.replace(/[^\p{L}\p{N}_. -]/gu, '_')}_${post.id}.tar`,
                floor_count: floors.length, image_count, warnings,
            };
        } catch (error) {
            if (signal.aborted) { signal.throwIfAborted(); }
            throw error;
        } finally {
            signal.removeEventListener('abort', abort);
            await context.close().catch(() => undefined);
            await rm(image_directory, { recursive: true, force: true });
            await rm(join(directory, 'backup.tar.tmp'), { force: true });
        }
    };
}
