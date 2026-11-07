import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArchiveFile } from './archive';
import { remap_image_names } from '../shared/image_handler';
import type { Post } from '../shared/types';
import { config } from './config';

export interface SavedImage extends ArchiveFile { sha256: string }

/** Hash while saving; an interrupted attempt leaves no bytes for the next retry. */
export async function save_image(source: AsyncIterable<Uint8Array>, path: string, signal: AbortSignal): Promise<SavedImage> {
    const hash = createHash('sha256');
    let size = 0;
    async function* chunks() {
        for await (const chunk of source) {
            signal.throwIfAborted();
            size += chunk.byteLength;
            if (size > config.max_image_bytes) { throw new Error(`图片为空或超过 ${config.max_image_bytes} 字节`); }
            hash.update(chunk);
            yield chunk;
        }
        if (!size) { throw new Error(`图片为空或超过 ${config.max_image_bytes} 字节`); }
    }
    try {
        await pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: 1024 * 1024 }),
            createWriteStream(path, { highWaterMark: 1024 * 1024 }), { signal });
        return { path, size, sha256: hash.digest('hex') };
    } catch (error) {
        await rm(path, { force: true });
        throw error;
    }
}

/** Keep the existing concurrency and pacing, and retain the first source name for identical bytes. */
export async function save_images(post: Post, directory: string,
    download: (url: string, path: string) => Promise<SavedImage>,
    progress: (current: number, total: number) => Promise<void>, signal: AbortSignal,
): Promise<Record<string, ArchiveFile>> {
    await mkdir(directory, { recursive: true });
    const entries = Object.entries(post.image_map || {});
    const aliases = new Map<string, string>();
    const hashes = new Map<string, string>();
    const files: Record<string, ArchiveFile> = {};
    let completed = 0;
    for (let offset = 0; offset < entries.length; offset += config.image_concurrency) {
        signal.throwIfAborted();
        const batch = entries.slice(offset, offset + config.image_concurrency);
        // Wait for every in-flight write before the worker removes its temporary directory.
        const results = await Promise.allSettled(batch.map(async ([url, name]) => {
            const image = await download(url, join(directory, name));
            await progress(++completed, entries.length);
            return image;
        }));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') { throw failure.reason; }
        for (let index = 0; index < batch.length; index++) {
            const result = results[index];
            if (result.status !== 'fulfilled') { continue; }
            const image = result.value, name = batch[index][1];
            const existing = hashes.get(image.sha256);
            aliases.set(name, existing || name);
            if (existing) { await rm(image.path); }
            else {
                hashes.set(image.sha256, name);
                files[name] = { path: image.path, size: image.size };
            }
        }
        if (offset + batch.length < entries.length) { await delay(config.image_batch_delay_ms, undefined, { signal }); }
    }
    signal.throwIfAborted();
    remap_image_names(post, aliases);
    return files;
}
