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
    phase: 'floors' | 'replies' | 'images' | 'packaging';
    /** Percentage estimated from four equally weighted phases, not elapsed time. */
    overall: number;
    progress?: ProgressCount;
}

export interface PostBackups {
    post_id: number;
    url: string;
    backups: BackupSummary[];
    active?: ActiveBackup;
    last_attempt_failed: boolean;
}

export interface Snapshot {
    floors: { index: number; author: string; date: string; content: string }[];
}
