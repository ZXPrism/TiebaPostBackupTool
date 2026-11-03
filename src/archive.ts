import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ArchiveFile { path: string; size: number }
const BUFFER_SIZE = 1024 * 1024;

/** Write TAR sequentially with backpressure; image bytes never accumulate in memory. */
export async function write_tar(target: string, files: Record<string, string | ArchiveFile>, signal?: AbortSignal): Promise<void> {
    async function* chunks() {
        for (const [filename, content] of Object.entries(files)) {
            signal?.throwIfAborted();
            const text = typeof content === 'string' ? Buffer.from(content) : undefined;
            const size = text ? text.length : (content as ArchiveFile).size;
            yield create_tar_header(filename, size);
            if (text) { yield text; }
            else {
                let read = 0;
                for await (const chunk of createReadStream((content as ArchiveFile).path, { highWaterMark: BUFFER_SIZE, signal })) {
                    read += chunk.length;
                    if (read > size) { throw new Error(`打包期间文件大小发生变化: ${filename}`); }
                    yield chunk as Buffer;
                }
                if (read !== size) { throw new Error(`打包期间文件大小发生变化: ${filename}`); }
            }
            const padding = (512 - size % 512) % 512;
            if (padding) { yield Buffer.alloc(padding); }
        }
        yield Buffer.alloc(1024);
    }
    await pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: BUFFER_SIZE }),
        createWriteStream(target, { highWaterMark: BUFFER_SIZE }), { signal });
}

/**
 * Create tar header for a file.
 */
function create_tar_header(filename: string, file_size: number): Uint8Array {
    const header = new Uint8Array(512);
    const encoder = new TextEncoder();

    // File name (100 bytes)
    const name_bytes = encoder.encode(filename);
    header.set(name_bytes.subarray(0, Math.min(100, name_bytes.length)), 0);

    // File mode (8 bytes)
    encoder.encode('0000644 ').forEach((byte, i) => header[100 + i] = byte);

    // Owner ID (8 bytes)
    encoder.encode('0000000 ').forEach((byte, i) => header[108 + i] = byte);

    // Group ID (8 bytes)
    encoder.encode('0000000 ').forEach((byte, i) => header[116 + i] = byte);

    // File size (12 bytes) - octal
    const size_octal = file_size.toString(8).padStart(11, '0') + '\0';
    encoder.encode(size_octal).forEach((byte, i) => header[124 + i] = byte);

    // Modification time (12 bytes)
    const timestamp = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    encoder.encode(timestamp).forEach((byte, i) => header[136 + i] = byte);

    // Type flag (1 byte) - regular file
    header[156] = 48; // '0'

    // Calculate checksum (8 bytes) - spaces first
    encoder.encode('        ').forEach((byte, i) => header[148 + i] = byte);

    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
        checksum += header[i];
    }

    // Encode checksum in octal
    const checksum_str = checksum.toString(8).padStart(6, '0') + '\0 ';
    encoder.encode(checksum_str).forEach((byte, i) => header[148 + i] = byte);

    return header;
}

