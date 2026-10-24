import type { Progress } from '../shared/progress';
import type { ActiveBackup } from '../shared/service-contract';
export type { Progress } from '../shared/progress';

export type JobStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed';

export interface Job {
    archive?: import('./storage').StoredArchive;
    id: string;
    post_id: number;
    url: string;
    status: JobStatus;
    created_at: string;
    updated_at: string;
    progress: Progress;
    phase_timing?: { phase: ActiveBackup['phase']; started_at: number; initial_current: number };
    warnings: string[];
    error?: string;
    failure_reason?: 'post_unavailable' | 'disk_space';
    filename?: string;
    floor_count?: number;
    image_count?: number;
    title?: string;
    backup_date?: string;
}

export function parse_post_url(input: unknown): { id: number; url: string } {
    if (typeof input !== 'string') {
        throw new Error('请输入贴吧贴子链接或贴子 ID');
    }
    const value = input.trim();
    let url: URL;
    try { url = new URL(/^\d+$/.test(value) ? `https://tieba.baidu.com/p/${value}` : value); }
    catch { throw new Error('请输入贴吧贴子链接或贴子 ID'); }
    // Only the complete ID path segment identifies the post; suffixes never affect collection.
    const match = url.pathname.match(/^\/p\/(\d+)(?:\/|$)/);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'tieba.baidu.com'
        || url.port || url.username || url.password || !match) {
        throw new Error('仅支持 https://tieba.baidu.com/p/贴子ID');
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) { throw new Error('贴子 ID 无效'); }
    return { id, url: `https://tieba.baidu.com/p/${id}` };
}
