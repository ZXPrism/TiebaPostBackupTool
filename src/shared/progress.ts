export interface ProgressCount {
    current: number;
    total?: number;
    complete: boolean;
}

export interface CollectionProgress {
    pages: ProgressCount;
    replies?: ProgressCount;
}

export interface Progress {
    stage: string;
    current?: number;
    total?: number;
    collection?: CollectionProgress;
}

/** Keep short estimates useful instead of collapsing them into “less than a minute”. */
export function format_remaining_time(seconds: number): string {
    if (seconds < 60) { return `约 ${Math.ceil(seconds)} 秒`; }
    const minutes = Math.ceil(seconds / 60);
    return minutes < 60 ? `约 ${minutes} 分钟`
        : `约 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}
