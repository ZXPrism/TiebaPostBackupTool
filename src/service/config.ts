import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServiceConfig {
    host: string;
    port: number;
    base_path: string;
    data_dir: string;
    max_pending: number;
    min_free_disk_bytes: number;
    api_request_interval_ms: number;
    image_request_interval_ms: number;
    image_concurrency: number;
    image_batch_delay_ms: number;
    max_image_bytes: number;
    request_timeout_ms: number;
    api_max_retries: number;
    max_api_pages: number;
    job_timeout_ms: number;
    cos: {
        enabled: boolean;
        bucket: string;
        region: string;
        request_timeout_ms: number;
        max_retries: number;
        upload_concurrency: number;
        signed_url_expires_seconds: number;
    };
}

type Rule = (value: unknown) => boolean;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Rule =>
    value => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const nonempty: Rule = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const text: Rule = value => typeof value === 'string';

function fields(value: unknown, rules: Record<string, Rule>, name: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${name} 必须是 JSON 对象`); }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
        if (!Object.hasOwn(rules, key)) { throw new Error(`未知配置项：${name}.${key}`); }
    }
    for (const [key, valid] of Object.entries(rules)) {
        if (!Object.hasOwn(object, key)) { throw new Error(`缺少配置项：${name}.${key}`); }
        if (!valid(object[key])) { throw new Error(`配置项值无效：${name}.${key}`); }
    }
}

export function load_config(path: string): ServiceConfig {
    let contents: string;
    try { contents = readFileSync(path, 'utf8'); }
    catch { throw new Error(`无法读取配置文件：${path}`); }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch { throw new Error(`配置文件不是有效 JSON：${path}`); }
    fields(value, {
        host: nonempty, port: integer(0, 65535),
        base_path: v => typeof v === 'string' && (v === '' || /^(?:\/[A-Za-z0-9_-]+)+$/.test(v)),
        min_free_disk_bytes: integer(1073741824),
        data_dir: nonempty, max_pending: integer(1), api_request_interval_ms: integer(1, 2147483647),
        image_request_interval_ms: integer(1, 2147483647), image_concurrency: integer(1),
        image_batch_delay_ms: integer(0, 2147483647), max_image_bytes: integer(1),
        request_timeout_ms: integer(1, 2147483647), api_max_retries: integer(0),
        max_api_pages: integer(1), job_timeout_ms: integer(1, 2147483647),
        cos: v => !!v && typeof v === 'object' && !Array.isArray(v),
    }, 'config');
    fields(value.cos, {
        enabled: v => typeof v === 'boolean', bucket: text, region: text,
        request_timeout_ms: integer(1, 2147483647), max_retries: integer(0),
        upload_concurrency: integer(1), signed_url_expires_seconds: integer(1, 604800),
    }, 'config.cos');
    if (value.cos.enabled) {
        if (!/^[a-z0-9-]+-\d+$/.test(String(value.cos.bucket))) { throw new Error('配置项值无效：config.cos.bucket'); }
        if (!/^[a-z]+-[a-z]+(?:-\d+)?$/.test(String(value.cos.region))) { throw new Error('配置项值无效：config.cos.region'); }
    }
    return value as unknown as ServiceConfig;
}

export const project_dir = resolve(import.meta.dirname, '../..');
export const config_path = resolve(process.env.TIEBA_CONFIG || resolve(project_dir, 'config.json'));
export const config = load_config(config_path);
export const data_dir = resolve(project_dir, config.data_dir);
export const jobs_dir = resolve(data_dir, 'jobs');
