import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

type Encoding = 'gzip';
export type Representation = Encoding | 'identity';

/** Prefer compression when identity has no explicit preference; never override q=0. */
export function negotiate_encoding(header: string | undefined): Representation | undefined {
    if (!header?.trim()) { return 'identity'; }
    const weights = new Map<string, number>();
    for (const item of header.split(',')) {
        const [token, ...parameters] = item.trim().toLowerCase().split(';');
        const parameter = parameters.join(';').trim();
        const match = parameter.match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/);
        const quality = parameters.length ? (match ? Number(match[1]) : 0) : 1;
        weights.set(token.trim(), quality);
    }
    const quality = (encoding: Representation) => weights.get(encoding)
        ?? (encoding === 'identity' ? (weights.get('*') === 0 ? 0 : 0.001) : weights.get('*') ?? 0);
    return (['gzip', 'identity'] as const).filter(encoding => quality(encoding) > 0)
        .sort((a, b) => quality(b) - quality(a))[0];
}

const pending = new Map<string, Promise<string>>();

async function fingerprint(file: string): Promise<string> {
    const info = await stat(file, { bigint: true });
    // Version the recipe as well as the source, including same-size replacements and preserved mtimes.
    return `v1:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Cache files are private sidecars, never additions to the user's archive. */
export function compressed_file(file: string, encoding: Encoding, signal?: AbortSignal): Promise<string> {
    const target = `${file}.http.${encoding}`;
    const existing = pending.get(target);
    if (existing) { return existing; }
    const task = prepare().finally(() => { pending.delete(target); });
    pending.set(target, task);
    return task;

    async function prepare(): Promise<string> {
        signal?.throwIfAborted();
        const source = await fingerprint(file);
        try {
            const metadata = JSON.parse(await readFile(`${target}.json`, 'utf8')) as { source: string; size: number };
            if (metadata.source === source && (await stat(target)).size === metadata.size) { return target; }
        } catch (error) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
        try {
            const compressor = createGzip({ level: 6 });
            await pipeline(createReadStream(file), compressor, createWriteStream(`${target}.tmp`), { signal });
            signal?.throwIfAborted();
            if (await fingerprint(file) !== source) { throw new Error('生成压缩缓存期间源文件发生变化，请重试下载'); }
            const size = (await stat(`${target}.tmp`)).size;
            await writeFile(`${target}.json.tmp`, JSON.stringify({ source, size }));
            await rename(`${target}.tmp`, target);
            await rename(`${target}.json.tmp`, `${target}.json`);
            return target;
        } finally {
            await Promise.all([`${target}.tmp`, `${target}.json.tmp`].map(path => rm(path, { force: true })));
        }
    }
}

export async function prepare_downloads(directory: string, signal?: AbortSignal): Promise<void> {
    // Bound compression memory: the single collection worker prepares these one at a time.
    for (const name of ['backup.tar', 'post.json']) {
        await compressed_file(join(directory, name), 'gzip', signal);
    }
}
