import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { JobQueue } from './queue';
import { project_dir } from './config';
import { compressed_file, negotiate_encoding } from './compression';
import { parse_post_url, type Job } from './model';
import type { ActiveBackup, PostBackups, Snapshot } from '../shared/service-contract';
import type { Post } from '../types';

function active_backup(job: Job): ActiveBackup {
    if (job.status === 'queued') { return { status: 'queued', phase: 'floors', overall: 0 }; }
    const collection = job.progress.collection;
    const phase = job.progress.stage === '下载图片' ? 'images'
        : ['整理图片', '打包文件', '准备下载文件'].includes(job.progress.stage) ? 'packaging'
        : collection?.pages.complete ? 'replies' : 'floors';
    const value = phase === 'floors' ? collection?.pages : phase === 'replies' ? collection?.replies
        : phase === 'images' ? { current: job.progress.current ?? 0, total: job.progress.total,
            complete: job.progress.total !== undefined && (job.progress.current ?? 0) >= job.progress.total } : undefined;
    const progress = value ? { current: value.current, total: value.total, complete: value.complete } : undefined;
    const fraction = !progress ? 0 : progress.complete ? 1
        : progress.total ? Math.min(1, Math.max(0, progress.current / progress.total)) : 0;
    // Reserve the last quarter for preparing the archive and download representations.
    // Those operations have no measurable fraction; never report an active job as finished.
    const overall = Math.floor(({ floors: 0, replies: 25, images: 50, packaging: 75 }[phase]) + fraction * 25);
    return { status: 'running', phase, overall, progress };
}

function post_backups(queue: JobQueue, post: { id: number; url: string }): PostBackups {
    const jobs = queue.list().filter(job => job.post_id === post.id);
    const active = jobs.find(job => job.status === 'queued' || job.status === 'running');
    const backups = jobs.filter(job => job.status === 'complete' || job.status === 'partial').map(job => ({
        id: job.id, title: job.title || `帖子 ${post.id}`, backup_date: job.backup_date || job.updated_at,
        filename: job.filename || 'backup.tar', floor_count: job.floor_count, image_count: job.image_count,
        partial: job.status === 'partial',
    })).sort((a, b) => b.backup_date.localeCompare(a.backup_date));
    return { post_id: post.id, url: post.url, backups, active: active ? active_backup(active) : undefined,
        last_attempt_failed: !active && jobs[0]?.status === 'failed' };
}

function json(response: ServerResponse, status: number, data: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<unknown> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of request) {
        size += part.length;
        if (size > 8192) { throw new Error('请求内容过大'); }
        parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export function create_app(queue: JobQueue) {
    return createServer((request, response) => {
        const started = Date.now();
        const request_info = { method: request.method, path: request.url?.split('?')[0] };
        void queue.log('trace', 'http_request', request_info);
        response.once('finish', () => {
            const level = response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info';
            void queue.log(level, 'http_response', { ...request_info, status: response.statusCode, duration_ms: Date.now() - started });
        });
        response.once('close', () => {
            if (!response.writableFinished) { void queue.log('warn', 'http_disconnected', { ...request_info, duration_ms: Date.now() - started }); }
        });
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        void handle(request, response).catch(async error => {
            await queue.log('error', 'http_error', { method: request.method, path: request.url?.split('?')[0], error });
            if (!response.headersSent) {
                json(response, 500, { error: '暂时无法完成请求，请稍后再试' });
            } else { response.destroy(); }
        });
    });

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url || '/', 'http://localhost');
        const path = url.pathname;
        if (path.startsWith('/api/')) {
            // Require a same-origin JSON request for mutations, including loopback operation.
            if (request.method === 'POST') {
                const origin = request.headers.origin;
                if ((origin && new URL(origin).host !== request.headers.host)
                    || !request.headers['content-type']?.startsWith('application/json')) {
                    json(response, 403, { error: '仅接受本站发起的 JSON 请求' }); return;
                }
            }
            if (path === '/api/posts' && request.method === 'GET') {
                let post;
                try { post = parse_post_url(url.searchParams.get('url')); }
                catch (error) { json(response, 400, { error: (error as Error).message }); return; }
                json(response, 200, post_backups(queue, post)); return;
            }
            if (path === '/api/jobs' && request.method === 'POST') {
                let data;
                try { data = await body(request) as { url?: unknown } | null; }
                catch { json(response, 400, { error: '请求内容无效' }); return; }
                let post;
                try { post = parse_post_url(data?.url); }
                catch (error) { json(response, 400, { error: (error as Error).message }); return; }
                try {
                    await queue.submit(post.url);
                    json(response, 202, post_backups(queue, post));
                } catch (error) {
                    await queue.log('error', 'submit_failed', { post_id: post.id, error });
                    json(response, 503, { error: '暂时无法开始备份，请稍后再试' });
                }
                return;
            }
            const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(download|post\.json|snapshot)$/);
            if (match && (request.method === 'GET' || request.method === 'HEAD')) {
                const job = queue.get(match[1]);
                if (!job) { json(response, 404, { error: '任务不存在' }); return; }
                if (!['complete', 'partial'].includes(job.status)) {
                    json(response, 409, { error: '任务尚未生成可下载的备份' }); return;
                }
                if (match[2] === 'snapshot') {
                    const post = JSON.parse(await readFile(join(queue.directory(job.id), 'post.json'), 'utf8')) as Post;
                    const snapshot: Snapshot = { floors: post.floor_list.slice(0, 5).map(floor => ({
                        index: floor.index, author: floor.comment.author, date: floor.comment.date, content: floor.comment.content,
                    })) };
                    json(response, 200, snapshot); return;
                }
                const is_json = match[2] === 'post.json';
                const file = join(queue.directory(job.id), is_json ? 'post.json' : 'backup.tar');
                const encoding = negotiate_encoding(request.headers['accept-encoding']);
                response.setHeader('Vary', 'Accept-Encoding');
                if (!encoding) { json(response, 406, { error: '不支持请求指定的传输编码，可使用 zstd、gzip 或 identity' }); return; }
                const sent_file = encoding === 'identity' ? file : await compressed_file(file, encoding);
                const info = await stat(sent_file);
                if (encoding !== 'identity') { response.setHeader('Content-Encoding', encoding); }
                const filename = is_json ? 'post.json' : job.filename || 'backup.tar';
                response.writeHead(200, {
                    'Content-Type': is_json ? 'application/json' : 'application/x-tar',
                    'Content-Length': info.size,
                    'Content-Disposition': `attachment; filename="${is_json ? 'post.json' : 'backup.tar'}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                    'Cache-Control': 'no-store',
                });
                if (request.method === 'HEAD') { response.end(); return; }
                await pipeline(createReadStream(sent_file), response);
                return;
            }
            json(response, 404, { error: '接口不存在' }); return;
        }
        const assets: Record<string, [string, string]> = {
            '/': ['src/web/index.html', 'text/html; charset=utf-8'],
            '/app.js': ['dist/web/app.js', 'text/javascript; charset=utf-8'],
            '/style.css': ['src/web/style.css', 'text/css; charset=utf-8'],
        };
        const asset = assets[path];
        if (request.method !== 'GET' || !asset) { json(response, 404, { error: '页面不存在' }); return; }
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
        response.setHeader('Content-Type', asset[1]);
        response.end(await readFile(join(project_dir, asset[0])));
    }
}
