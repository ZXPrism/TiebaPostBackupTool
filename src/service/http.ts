import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { JobQueue } from './queue';
import { project_dir } from './config';

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
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        void handle(request, response).catch(error => {
            if (!response.headersSent) {
                json(response, 500, { error: error instanceof Error ? error.message : '服务器错误' });
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
            if (path === '/api/jobs' && request.method === 'GET') {
                json(response, 200, queue.list()); return;
            }
            if (path === '/api/jobs' && request.method === 'POST') {
                try {
                    const data = await body(request) as { url?: unknown } | null;
                    const job = await queue.submit(data?.url);
                    json(response, 202, job);
                } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : '请求无效' }); }
                return;
            }
            const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(download|post\.json))?$/);
            if (match && request.method === 'GET') {
                const job = queue.get(match[1]);
                if (!job) { json(response, 404, { error: '任务不存在' }); return; }
                if (!match[2]) { json(response, 200, job); return; }
                if (!['complete', 'partial'].includes(job.status)) {
                    json(response, 409, { error: '任务尚未生成可下载的备份' }); return;
                }
                const is_json = match[2] === 'post.json';
                const file = join(queue.directory(job.id), is_json ? 'post.json' : 'backup.tar');
                const info = await stat(file);
                const filename = is_json ? 'post.json' : job.filename || 'backup.tar';
                response.writeHead(200, {
                    'Content-Type': is_json ? 'application/json' : 'application/x-tar',
                    'Content-Length': info.size,
                    'Content-Disposition': `attachment; filename="${is_json ? 'post.json' : 'backup.tar'}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                    'Cache-Control': 'no-store',
                });
                await pipeline(createReadStream(file), response);
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
