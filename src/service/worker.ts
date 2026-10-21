import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { finalize_post } from '../shared/post';
import { ImageHandler } from '../image_handler';
import { allowed_url } from './resource-url';
import { config } from './config';
import { collect_api } from '../shared/api-collector';
import { create_api_request, RequestPacer } from './api';
import type { Job, Progress } from './model';
import { prepare_downloads } from './compression';
import type { Log } from './logging';
import { open_http_session, type HttpSession } from './transport';

export interface WorkerResult {
    title?: string;
    backup_date?: string;
    filename: string;
    floor_count: number;
    image_count: number;
    warnings: string[];
}

export type Runner = (job: Job, directory: string, progress: (value: Progress) => Promise<void>, signal: AbortSignal, log?: Log) => Promise<WorkerResult>;

async function fetch_image(context: HttpSession, original: string, post_url: string, before_request?: () => Promise<void>): Promise<Blob> {
    let url = new URL(original, post_url).href;
    for (let redirects = 0; redirects < 5; redirects++) {
        if (!allowed_url(url)) { throw new Error('图片地址不在允许的域名内'); }
        await before_request?.();
        const response = await context.request.get(url, {
            timeout: 30000, headers: { Referer: post_url },
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
    download: typeof fetch_image = fetch_image,
    pacer = new RequestPacer(config.api_request_interval_ms),
    image_pacer = new RequestPacer(config.image_request_interval_ms),
    http_session = open_http_session,
): Runner {
    return async (job, directory, progress, signal, log) => {
        signal.throwIfAborted();
        const context = await http_session(signal);
        const abort = () => { void context.close().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            signal.throwIfAborted();
            const { floors, warnings, notes, metadata } = await collect_api(job.post_id,
                create_api_request(context.request, job.url, pacer, signal, log), progress, signal, config.max_api_pages);
            let image_error: unknown;
            const images = new ImageHandler(async url => {
                signal.throwIfAborted();
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
            const post = finalize_post(metadata, floors, images);
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
                'report.json': JSON.stringify({ backend: 'api', warnings, notes, floor_count: floors.length, image_count }, null, 2),
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
            if (signal.aborted) { signal.throwIfAborted(); }
            throw error;
        } finally {
            signal.removeEventListener('abort', abort);
            await context.close().catch(() => undefined);
        }
    };
}
