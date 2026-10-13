import { resolve } from 'node:path';

export const data_dir = resolve(process.env.TIEBA_DATA_DIR || '.data');
export const profile_dir = resolve(data_dir, 'browser');
export const jobs_dir = resolve(data_dir, 'jobs');
export const project_dir = resolve(import.meta.dirname, '../..');
export type Backend = 'browser' | 'api';
const backend = process.env.TIEBA_BACKEND || 'browser';
if (backend !== 'browser' && backend !== 'api') { throw new Error('TIEBA_BACKEND 仅支持 browser 或 api'); }
function interval(name: string, fallback: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1) { throw new Error(`${name} 必须为正整数（毫秒）`); }
    return value;
}
export const config = {
    backend: backend as Backend,
    api_request_interval_ms: interval('TIEBA_API_INTERVAL_MS', 1000),
    image_request_interval_ms: interval('TIEBA_IMAGE_INTERVAL_MS', 200),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    max_pending: 20,
    max_pages: 200,
    max_api_pages: 2000,
    job_timeout_ms: (backend === 'api' ? 60 : 30) * 60 * 1000,
};
