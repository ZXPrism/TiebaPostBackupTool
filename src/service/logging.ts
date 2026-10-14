import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type Log = (level: LogLevel, event: string, detail: unknown) => Promise<void>;

/** All levels go to the service log; job records are also copied to their job log. */
export class ServiceLogger {
    private writes = Promise.resolve();
    private ready = false;

    constructor(private readonly directory: string) {}

    write(level: LogLevel, event: string, detail: unknown, job_id?: string): Promise<void> {
        const line = JSON.stringify({ time: new Date().toISOString(), level, event, job_id, detail }, (_key, value: unknown) =>
            value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value) + '\n';
        this.writes = this.writes.then(async () => {
            if (!this.ready) {
                await mkdir(this.directory, { recursive: true, mode: 0o700 });
                this.ready = true;
            }
            await appendFile(join(this.directory, 'service.log'), line);
            if (job_id) { await appendFile(join(this.directory, job_id, 'job.log'), line); }
        }).catch(error => { console.error('日志写入失败', error, line); });
        return this.writes;
    }

    async flush(): Promise<void> { await this.writes; }
}
