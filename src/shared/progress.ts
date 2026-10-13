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
