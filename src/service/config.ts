import { resolve } from 'node:path';

export const data_dir = resolve(process.env.TIEBA_DATA_DIR || '.data');
export const jobs_dir = resolve(data_dir, 'jobs');
export const project_dir = resolve(import.meta.dirname, '../..');
function interval(name: string, fallback: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1) { throw new Error(`${name} 必须为正整数（毫秒）`); }
    return value;
}
const base_path = (process.env.TIEBA_BASE_PATH || '').replace(/\/+$/, '');
if (base_path && !/^(?:\/[A-Za-z0-9_-]+)+$/.test(base_path)) {
    throw new Error('TIEBA_BASE_PATH 必须为以 / 开头的路径，各段仅支持字母、数字、下划线和连字符');
}
export const config = {
    base_path,
    api_request_interval_ms: interval('TIEBA_API_INTERVAL_MS', 1000),
    image_request_interval_ms: interval('TIEBA_IMAGE_INTERVAL_MS', 200),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    max_pending: 20,
    max_api_pages: 2000,
    job_timeout_ms: 60 * 60 * 1000,
};
