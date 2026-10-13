import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { parse_post_url, type Job, type Progress } from './model';
import type { Runner } from './worker';

/** A single worker with durable job records. Interrupted jobs are never reported as complete. */
export class JobQueue {
    private readonly jobs = new Map<string, Job>();
    private running = false;
    private stopped = false;
    private current?: AbortController;
    private task?: Promise<void>;
    private writes = Promise.resolve();

    constructor(private readonly root: string, private readonly runner: Runner) {}

    async initialize(): Promise<void> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        for (const name of await readdir(this.root)) {
            if (!/^[a-f0-9-]{36}$/.test(name)) { continue; }
            try {
                const job = JSON.parse(await readFile(join(this.root, name, 'job.json'), 'utf8')) as Job;
                if (job.id !== name) { throw new Error('任务 ID 不匹配'); }
                if (job.status === 'running') {
                    job.status = 'failed';
                    job.error = '服务在任务完成前停止，请重新提交';
                    job.updated_at = new Date().toISOString();
                    await this.save(job);
                }
                this.jobs.set(job.id, job);
            } catch {
                console.warn(`忽略不可读取的任务记录: ${name}`);
            }
        }
        this.start();
    }

    get(id: string): Job | undefined { return this.jobs.get(id); }
    list(): Job[] { return [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
    directory(id: string): string { return join(this.root, id); }

    async submit(input: unknown): Promise<Job> {
        if (this.stopped) { throw new Error('服务正在停止'); }
        const post = parse_post_url(input);
        const pending = this.list().filter(job => job.status === 'queued' || job.status === 'running');
        const existing = pending.find(job => job.post_id === post.id);
        if (existing) { return existing; }
        if (pending.length >= config.max_pending) { throw new Error('任务队列已满，请稍后再试'); }
        const now = new Date().toISOString();
        const job: Job = {
            id: randomUUID(), post_id: post.id, url: post.url, status: 'queued',
            created_at: now, updated_at: now, progress: { stage: '排队中' }, warnings: [],
        };
        this.jobs.set(job.id, job);
        try { await this.save(job); }
        catch (error) { this.jobs.delete(job.id); throw error; }
        this.start();
        return job;
    }

    private save(job: Job): Promise<void> {
        const contents = JSON.stringify(job, null, 2);
        const write = this.writes.then(async () => {
            const dir = this.directory(job.id);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'job.json.tmp'), contents);
            await rename(join(dir, 'job.json.tmp'), join(dir, 'job.json'));
        });
        this.writes = write.catch(() => undefined);
        return write;
    }

    private start(): void {
        if (this.running || this.stopped) { return; }
        this.running = true;
        this.task = this.drain().catch(error => {
            console.error('任务队列停止:', error instanceof Error ? error.message : '未知错误');
            this.stopped = true;
        }).finally(() => {
            this.running = false;
            if (!this.stopped && this.list().some(job => job.status === 'queued')) { this.start(); }
        });
    }

    private async drain(): Promise<void> {
        while (!this.stopped) {
            const job = [...this.jobs.values()].filter(item => item.status === 'queued')
                .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
            if (!job) { return; }
            job.status = 'running';
            job.updated_at = new Date().toISOString();
            await this.save(job);
            const controller = new AbortController();
            this.current = controller;
            const timer = setTimeout(() => controller.abort(new Error(`任务运行超过 ${config.job_timeout_ms / 60000} 分钟，已中止`)), config.job_timeout_ms);
            try {
                const result = await this.runner(job, this.directory(job.id), async (progress: Progress) => {
                    job.progress = progress;
                    job.updated_at = new Date().toISOString();
                    await this.save(job);
                }, controller.signal);
                controller.signal.throwIfAborted();
                Object.assign(job, result);
                job.status = result.warnings.length ? 'partial' : 'complete';
                job.progress = { stage: job.status === 'partial' ? '部分完成' : '备份完成' };
            } catch (error) {
                job.status = 'failed';
                job.error = error instanceof Error ? error.message : String(error);
                job.progress = { stage: '备份失败' };
            } finally {
                clearTimeout(timer);
                this.current = undefined;
                job.updated_at = new Date().toISOString();
                await this.save(job);
            }
        }
    }

    async close(): Promise<void> {
        this.stopped = true;
        this.current?.abort(new Error('服务正在停止，任务已中止'));
        await this.task;
        await this.writes;
    }
}
