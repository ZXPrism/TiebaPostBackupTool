/**
 * Create tar archive from files.
 */
export async function create_tar(files: { [filename: string]: string | Blob }): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();

    for (const [filename, content] of Object.entries(files)) {
        // Get file size and data
        let file_data: Uint8Array;
        let file_size: number;

        if (typeof content === 'string') {
            file_data = encoder.encode(content);
            file_size = file_data.length;
        } else {
            file_data = await blob_to_uint8array(content);
            file_size = file_data.length;
        }

        // Create tar header
        const header = create_tar_header(filename, file_size);
        chunks.push(header);

        // Add file data
        chunks.push(file_data);

        // Add padding to 512-byte boundary
        const padding_needed = (512 - (file_size % 512)) % 512;
        if (padding_needed > 0) {
            chunks.push(new Uint8Array(padding_needed));
        }

    }

    // Add end marker (two 512-byte zero blocks)
    chunks.push(new Uint8Array(1024));

    // Combine all chunks
    const total_size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(total_size);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }

    return new Blob([combined], { type: 'application/x-tar' });
}

/**
 * Convert blob to Uint8Array.
 */
async function blob_to_uint8array(blob: Blob): Promise<Uint8Array> {
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
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

