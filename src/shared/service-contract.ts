import type { ProgressCount } from './progress';

export interface BackupSummary {
    id: string;
    title: string;
    backup_date: string;
    filename: string;
    floor_count?: number;
    image_count?: number;
    partial: boolean;
}

export interface ActiveBackup {
    status: 'queued' | 'running';
    phase: 'floors' | 'replies' | 'images' | 'packaging' | 'uploading';
    /** Percentage estimated from collection, packaging and optional upload phases, not elapsed time. */
    overall: number;
    progress?: ProgressCount;
    /** Estimated seconds remaining in this phase only; absent until measurable. */
    remaining_seconds?: number;
}

export interface PostBackups {
    post_id: number;
    url: string;
    backups: BackupSummary[];
    active?: ActiveBackup;
    last_attempt_failed: boolean;
    failure_reason?: 'post_unavailable';
}

export interface Snapshot {
    floors: { index: number; author: string; date: string; content: string }[];
}
