import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config, type ServiceConfig } from './config';
import COS from 'cos-nodejs-sdk-v5';
import { stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compressed_file, type Representation } from './compression';
import type { Progress } from './model';

export interface StoredArchive {
    bucket: string;
    region: string;
    prefix: string;
}
export interface ArchiveStore {
    publish(id: string, directory: string, filename: string, progress: (value: Progress) => Promise<void>, signal: AbortSignal): Promise<StoredArchive>;
    url(archive: StoredArchive, encoding: Representation, method: 'GET' | 'HEAD'): Promise<string>;
}
export interface CosConfig { bucket: string; region: string; secret_id: string; secret_key: string }
export function cos_config(env: NodeJS.ProcessEnv = process.env, settings: ServiceConfig['cos'] = config.cos): CosConfig | undefined {
    if (!settings.enabled) { return undefined; }
    const names = ['TIEBA_COS_SECRET_ID', 'TIEBA_COS_SECRET_KEY'] as const;
    const missing = names.filter(name => !env[name]?.trim());
    if (missing.length) { throw new Error('COS 配置缺少环境变量：' + missing.join('、')); }
    return { bucket: settings.bucket, region: settings.region,
        secret_id: env.TIEBA_COS_SECRET_ID || '', secret_key: env.TIEBA_COS_SECRET_KEY || '' };
}

// SDK errors can contain signed request URLs or authorization headers. Log only safe identifiers.
function storage_error(action: string, error: unknown): Error {
    const value = error as { statusCode?: number; code?: string };
    const code = typeof value?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.code) ? value.code : 'Unknown';
    return new Error(`COS ${action}失败（HTTP ${Number(value?.statusCode) || 0}，${code}）`);
}

export class CosArchiveStore implements ArchiveStore {
    private readonly client: COS;
    constructor(private readonly options: CosConfig, client?: COS) {
        this.client = client ?? new COS({ SecretId: options.secret_id, SecretKey: options.secret_key,
            Protocol: 'https:', UploadCheckContentMd5: true, FileParallelLimit: 1, ChunkParallelLimit: config.cos.upload_concurrency,
            ChunkRetryTimes: config.cos.max_retries, Timeout: config.cos.request_timeout_ms });
    }

    async publish(id: string, directory: string, filename: string, progress: (value: Progress) => Promise<void>, signal: AbortSignal): Promise<StoredArchive> {
        const archive = { bucket: this.options.bucket, region: this.options.region, prefix: `backups/${id}` };
        const source = join(directory, 'backup.tar');
        const files = await Promise.all((['identity', 'gzip'] as const).map(async encoding => {
            const file = encoding === 'identity' ? source : await compressed_file(source, encoding, signal);
            return { encoding, file, size: (await stat(file)).size };
        }));
        const total = files.reduce((sum, file) => sum + file.size, 0);
        let completed = 0;
        let updates = Promise.resolve();
        let progress_error: unknown;
        const report = (current: number) => {
            updates = updates.then(() => progress({ stage: '上传备份', current, total }))
                .catch(error => { progress_error ??= error; });
        };
        report(0);
        try {
            for (const file of files) {
                signal.throwIfAborted();
                const params = { Bucket: archive.bucket, Region: archive.region, Key: `${archive.prefix}/${file.encoding}` };
                // The SDK cannot calculate MD5 for the small-file ReadStream created by uploadFile.
                // Multipart uploads calculate and verify each part separately.
                let md5: string | undefined;
                if (file.size <= 8 * 1024 * 1024) {
                    const hash = createHash('md5');
                    await pipeline(createReadStream(file.file), hash, { signal });
                    md5 = hash.digest('base64');
                }
                await new Promise<void>((resolve, reject) => {
                    let task: string | undefined;
                    const abort = () => {
                        if (task) { this.client.cancelTask(task); }
                        reject(signal.reason);
                    };
                    signal.addEventListener('abort', abort, { once: true });
                    this.client.uploadFile({ ...params, Headers: md5 ? { 'Content-MD5': md5 } : undefined, FilePath: file.file, SliceSize: 8 * 1024 * 1024,
                        ACL: 'private', ContentType: 'application/x-tar', ContentEncoding: file.encoding === 'identity' ? undefined : file.encoding,
                        ContentDisposition: `attachment; filename="backup.tar"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                        CacheControl: 'private, no-store',
                        onTaskReady: id => { task = id; if (signal.aborted) { abort(); } },
                        onProgress: value => report(completed + Math.min(file.size, value.loaded)),
                    }, error => {
                        signal.removeEventListener('abort', abort);
                        if (error) { reject(storage_error('上传', error)); } else { resolve(); }
                    });
                    if (signal.aborted) { abort(); }
                });
                signal.throwIfAborted();
                const head = await this.client.headObject(params).catch(error => { throw storage_error('校验', error); });
                if (Number(head.headers?.['content-length']) !== file.size
                    || (head.headers?.['content-encoding'] || 'identity') !== file.encoding) {
                    throw new Error('COS 上传后校验失败：文件长度或传输编码不一致');
                }
                completed += file.size;
                report(completed);
                await updates;
                if (progress_error) { throw progress_error; }
            }
            signal.throwIfAborted();
            return archive;
        } finally { await updates; }
    }

    async url(archive: StoredArchive, encoding: Representation, method: 'GET' | 'HEAD'): Promise<string> {
        return new Promise((resolve, reject) => {
            this.client.getObjectUrl({ Bucket: archive.bucket, Region: archive.region,
                Key: `${archive.prefix}/${encoding}`, Method: method as COS.GetObjectUrlParams['Method'], Sign: true, Expires: config.cos.signed_url_expires_seconds, Protocol: 'https:' },
            (error, data) => error ? reject(storage_error('生成下载链接', error)) : resolve(data.Url));
        });
    }
}

/** Called only after the remote archive reference has been durably saved. Keep post.json for queries. */
export async function remove_local_archive(directory: string): Promise<void> {
    for (const suffix of ['', '.http.gzip', '.http.gzip.json']) {
        await rm(join(directory, 'backup.tar' + suffix), { force: true });
    }
}
