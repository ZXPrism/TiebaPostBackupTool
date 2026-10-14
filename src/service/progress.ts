import type { ActiveBackup } from '../shared/service-contract';
import type { Job, Progress } from './model';

function describe_progress(value: Progress): Pick<ActiveBackup, 'phase' | 'progress' | 'overall'> {
    const collection = value.collection;
    const phase = value.stage === '下载图片' ? 'images'
        : ['整理图片', '打包文件', '准备下载文件'].includes(value.stage) ? 'packaging'
        : collection?.pages.complete ? 'replies' : 'floors';
    const count = phase === 'floors' ? collection?.pages : phase === 'replies' ? collection?.replies
        : phase === 'images' ? { current: value.current ?? 0, total: value.total,
            complete: value.total !== undefined && (value.current ?? 0) >= value.total } : undefined;
    const progress = count ? { current: count.current, total: count.total, complete: count.complete } : undefined;
    const fraction = !progress ? 0 : progress.complete ? 1
        : progress.total ? Math.min(1, Math.max(0, progress.current / progress.total)) : 0;
    // Phase weights describe progress, not duration. Preparing downloads has no measurable fraction.
    const overall = Math.floor(({ floors: 0, replies: 25, images: 50, packaging: 75 }[phase]) + fraction * 25);
    return { phase, progress, overall };
}

/** Persist the measurement origin with the job, independently of when a visitor opens the page. */
export function record_progress(job: Job, progress: Progress, now = Date.now()): void {
    const previous = describe_progress(job.progress).progress;
    job.progress = { ...progress, collection: progress.collection ?? job.progress.collection };
    const current = describe_progress(job.progress);
    const timing = job.phase_timing;
    if (!current.progress) { job.phase_timing = undefined; return; }
    if (!timing || timing.phase !== current.phase || now < timing.started_at
        || current.progress.current < (previous?.current ?? timing.initial_current)) {
        job.phase_timing = { phase: current.phase, started_at: now, initial_current: current.progress.current };
    }
}

export function active_backup(job: Job, now = Date.now()): ActiveBackup {
    if (job.status === 'queued') { return { status: 'queued', phase: 'floors', overall: 0 }; }
    const result: ActiveBackup = { status: 'running', ...describe_progress(job.progress) };
    const { progress, phase } = result;
    const timing = job.phase_timing;
    if (!progress || progress.total === undefined) { return result; }
    if (progress.complete) { result.remaining_seconds = 0; return result; }
    if (!timing || timing.phase !== phase) { return result; }
    const elapsed = now - timing.started_at;
    const processed = progress.current - timing.initial_current;
    const remaining = progress.total - progress.current;
    // Include waits/retries and time since the last update. A stalled job must not count down to zero.
    if (elapsed >= 10000 && processed > 0 && remaining > 0) {
        result.remaining_seconds = Math.ceil(remaining * elapsed / processed / 1000);
    }
    return result;
}
