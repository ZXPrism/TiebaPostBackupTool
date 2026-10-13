import type { Progress } from '../shared/progress';
export type { Progress } from '../shared/progress';

export type JobStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed';

export interface Job {
    id: string;
    post_id: number;
    url: string;
    status: JobStatus;
    created_at: string;
    updated_at: string;
    progress: Progress;
    warnings: string[];
    error?: string;
    filename?: string;
    floor_count?: number;
    image_count?: number;
}

export function parse_post_url(input: unknown): { id: number; url: string } {
    if (typeof input !== 'string' || input.length > 2048) {
        throw new Error('请输入贴吧帖子链接或帖子 ID');
    }
    const value = input.trim();
    const url = new URL(/^\d+$/.test(value) ? `https://tieba.baidu.com/p/${value}` : value);
    const match = url.pathname.match(/^\/p\/(\d+)\/?$/);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'tieba.baidu.com'
        || url.port || url.username || url.password || !match) {
        throw new Error('仅支持 https://tieba.baidu.com/p/帖子ID');
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) { throw new Error('帖子 ID 无效'); }
    return { id, url: `https://tieba.baidu.com/p/${id}` };
}
