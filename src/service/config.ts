import { resolve } from 'node:path';

export const data_dir = resolve(process.env.TIEBA_DATA_DIR || '.data');
export const profile_dir = resolve(data_dir, 'browser');
export const jobs_dir = resolve(data_dir, 'jobs');
export const project_dir = resolve(import.meta.dirname, '../..');
export const config = {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    max_pending: 20,
    max_pages: 200,
    job_timeout_ms: 30 * 60 * 1000,
};
