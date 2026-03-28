import { Post, ImageMap, Floor, Comment } from './types';

export class ImageHandler {
    private image_map: ImageMap = {};
    private image_counter: number = 1;

    /**
     * Extract all image URLs from post content and avatars.
     * Returns mapped image URLs.
     */
    public process_images(post_html: string, avatar_urls: string[]): ImageMap {
        this.image_map = {};
        this.image_counter = 1;


        // Extract images from content
        const img_tags = post_html.match(/<img[^>]+>/g) || [];
        img_tags.forEach(img_tag => {
            const src_match = img_tag.match(/src=["']([^"']+)["']/);
            if (src_match) {
                this._add_to_image_map(src_match[1]);
            }
        });

        // Add avatar URLs
        avatar_urls.forEach(url => {
            if (url) {
                this._add_to_image_map(url);
            }
        });

        return this.image_map;
    }

    /**
     * Add image URL to map with deduplication.
     */
    private _add_to_image_map(original_url: string): void {
        if (!this.image_map[original_url]) {
            const ext = this._get_extension(original_url);
            const new_name = `image_${this.image_counter++}.${ext}`;
            this.image_map[original_url] = new_name;
        }
    }

    /**
     * Get file extension from URL.
     */
    private _get_extension(url: string): string {
        // Handle Baidu tieba emoji URLs (usually .png)
        if (url.includes('static.tieba.baidu.com')) {
            return 'png';
        }

        // Extract extension from URL
        const match = url.match(/\.([a-z]{3,4})(?:\?|$)/i);
        return match ? match[1] : 'jpg';
    }

    /**
     * Replace image URLs in HTML content with new names.
     */
    public replace_image_urls(html_content: string): string {
        return html_content.replace(/src=["']([^"']+)["']/g, (match, url) => {
            const new_name = this.image_map[url];
            if (new_name) {
                return `src="./images/${new_name}"`;
            }
            return match;
        });
    }

    /**
     * Download all images as blobs with batching to prevent IP ban.
     * @param on_progress Callback for progress updates (current, total, filename)
     */
    public async download_images(on_progress?: (current: number, total: number, filename: string) => void): Promise<{ [filename: string]: Blob }> {
        const blobs: { [filename: string]: Blob } = {};
        const entries = Object.entries(this.image_map);
        const total = entries.length;
        let current = 0;


        const BATCH_SIZE = 5;
        const BATCH_DELAY = 1000; // 1 second between batches

        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, Math.min(i + BATCH_SIZE, entries.length));

            // Download batch in parallel
            await Promise.all(batch.map(async ([original_url, new_name]) => {
                try {
                    const blob = await this._fetch_image(original_url);
                    blobs[new_name] = blob;
                    current++;
                    if (on_progress) {
                        on_progress(current, total, new_name);
                    }
                } catch {
                    // Create a placeholder image for failed downloads
                    blobs[new_name] = this._create_placeholder(new_name);
                    current++;
                    if (on_progress) {
                        on_progress(current, total, new_name);
                    }
                }
            }));

            // Add delay between batches (except after the last batch)
            if (i + BATCH_SIZE < entries.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }

        return blobs;
    }

    /**
     * Fetch single image as blob using GM_xmlhttpRequest to bypass CORS.
     */
    private async _fetch_image(url: string): Promise<Blob> {
        return new Promise((resolve, reject) => {
            // Check if GM_xmlhttpRequest is available (Tampermonkey)
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                interface GMResponse {
                    status: number;
                    response: Blob;
                }
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    onload: (response: GMResponse) => {
                        if (response.status === 200) {
                            resolve(response.response);
                        } else {
                            reject(new Error(`HTTP ${response.status}`));
                        }
                    },
                    onerror: (_error: unknown) => {
                        reject(new Error('GM_xmlhttpRequest error'));
                    },
                });
            } else {
                // Fallback to regular fetch (may fail due to CORS)
                fetch(url)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                        return response.blob();
                    })
                    .then(blob => resolve(blob))
                    .catch(error => reject(error));
            }
        });
    }

    /**
     * Create placeholder image for failed downloads.
     */
    private _create_placeholder(_filename: string): Blob {
        const svg = `
            <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
                <rect width="100" height="100" fill="#ccc"/>
                <text x="50" y="50" text-anchor="middle" dy=".3em" font-size="12">Failed</text>
            </svg>
        `;
        return new Blob([svg], { type: 'image/svg+xml' });
    }

    /**
     * Replace avatar URLs in floor list with mapped filenames.
     */
    public replace_avatar_urls(floor_list: Floor[]): void {
        floor_list.forEach(floor => {
            // Replace main comment avatar URL
            if (floor.comment.avatar_url && this.image_map[floor.comment.avatar_url]) {
                floor.comment.avatar_url = this.image_map[floor.comment.avatar_url];
            }

            // Replace sub-comment avatar URLs
            if (floor.sub_comment_list) {
                floor.sub_comment_list.forEach((sub: Comment) => {
                    if (sub.avatar_url && this.image_map[sub.avatar_url]) {
                        sub.avatar_url = this.image_map[sub.avatar_url];
                    }
                });
            }
        });
    }

    /**
     * Create viewer HTML file.
     */
    public create_viewer_html(post: Post): string {
        const json_data = JSON.stringify(post, null, 2);

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${post.title} - Tieba Backup</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .header h1 {
            margin: 0 0 10px 0;
            color: #333;
        }
        .header .meta {
            color: #666;
            font-size: 14px;
        }
        .floor {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .floor .author {
            font-weight: bold;
            color: #0055cc;
        }
        .floor .date {
            color: #999;
            font-size: 12px;
            margin-left: 10px;
        }
        .floor .ip {
            color: #999;
            font-size: 12px;
            margin-left: 10px;
        }
        .floor .content {
            margin: 10px 0;
            line-height: 1.6;
        }
        .floor .content img {
            max-width: 100%;
            height: auto;
        }
        .floor .avatar {
            width: 50px;
            height: 50px;
            border-radius: 4px;
            margin-right: 10px;
            vertical-align: middle;
            object-fit: cover;
        }
        .floor .avatar[alt] {
            display: inline-block;
        }
        .floor .floor-index {
            color: #999;
            font-size: 12px;
            margin-bottom: 5px;
        }
        .floor .author-line {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
        }
        .sub-comments {
            margin-left: 20px;
            padding-left: 15px;
            border-left: 2px solid #e0e0e0;
            margin-top: 10px;
        }
        .sub-comment {
            margin: 8px 0;
            padding: 8px;
            background: #f9f9f9;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sub-comment .content {
            flex: 1;
        }
        .sub-comment .author {
            font-size: 12px;
        }
        .sub-comment .date {
            font-size: 11px;
        }
        .sub-comment .sub-avatar {
            width: 30px;
            height: 30px;
            border-radius: 3px;
            margin-right: 8px;
            vertical-align: middle;
            object-fit: cover;
        }
        .author-link {
            color: #0055cc;
            text-decoration: none;
            font-weight: bold;
        }
        .author-link:hover {
            text-decoration: underline;
        }
        .reply-to {
            color: #666;
            font-size: 12px;
        }
        .reply-to a {
            color: #0055cc;
            text-decoration: none;
        }
        .reply-to a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${post.title}</h1>
        <div class="meta">
            贴吧: <a class="author-link" href="${post.tieba_url}" target="_blank">${post.tieba_name}</a> |
            楼层: ${post.floor_list.length} |
            回复: ${post.comment_cnt}
        </div>
    </div>
    <div id="content"></div>

    <script>
        try {
            const post = ${json_data};

            function renderFloor(floor) {
            let html = '<div class="floor">';

            // Floor index
            html += '<div class="floor-index">' + floor.index + '楼</div>';

            // Author with avatar
            html += '<div class="author-line">';
            if (floor.comment.avatar_url) {
                html += '<img class="avatar" src="./images/' + floor.comment.avatar_url + '" alt="">';
            }
            // Author as link if homepage exists
            if (floor.comment.homepage_url) {
                html += '<a class="author-link" href="' + floor.comment.homepage_url + '" target="_blank">' + floor.comment.author + '</a>';
            } else {
                html += '<span class="author">' + floor.comment.author + '</span>';
            }
            html += '<span class="date">' + floor.comment.date + '</span>';
            if (floor.comment.ip_location) {
                html += '<span class="ip">来自: ' + floor.comment.ip_location + '</span>';
            }
            html += '</div>';

            // Content
            html += '<div class="content">' + floor.comment.content + '</div>';

            // Sub-comments
            if (floor.sub_comment_list && floor.sub_comment_list.length > 0) {
                html += '<div class="sub-comments">';
                floor.sub_comment_list.forEach(sub => {
                    html += renderSubComment(sub);
                });
                html += '</div>';
            }

            html += '</div>';
            return html;
        }

        function renderSubComment(comment) {
            let html = '<div class="sub-comment">';

            // Avatar
            if (comment.avatar_url) {
                html += '<img class="sub-avatar" src="./images/' + comment.avatar_url + '" alt="">';
            }

            // Debug logging
            if (!comment.author || comment.author === 'Unknown') {
            }

            // Author with fallback for missing names, as link if homepage exists
            const author_name = comment.author || '未知用户';
            if (comment.homepage_url) {
                html += '<a class="author-link" href="' + comment.homepage_url + '" target="_blank">' + author_name + '</a>';
            } else {
                html += '<span class="author">' + author_name + '</span>';
            }
            html += '<span class="date">' + comment.date + '</span>';

            // Content with reply-to filtering
            let content = comment.content;
            // Remove the original "回复 <a>username</a>" pattern since we'll render it separately
            // Use string methods instead of regex to avoid escaping issues
            const replyIndex = content.indexOf('回复');
            if (replyIndex !== -1) {
                // Find the closing </a> and the colon after it
                const anchorEnd = content.indexOf('</a>', replyIndex);
                if (anchorEnd !== -1) {
                    const colonIndex = content.indexOf(':', anchorEnd);
                    if (colonIndex !== -1 && colonIndex < anchorEnd + 10) {
                        // Remove everything from "回复" to the colon
                        content = content.substring(0, replyIndex) + content.substring(colonIndex + 1);
                    }
                }
            }
            html += '<div class="content">' + content + '</div>';

            // Reply-to information
            if (comment.reply_to_author) {
                html += '<div class="reply-to">回复 ';
                if (comment.reply_to_homepage_url) {
                    html += '<a href="' + comment.reply_to_homepage_url + '" target="_blank">' + comment.reply_to_author + '</a>';
                } else {
                    html += comment.reply_to_author;
                }
                html += '</div>';
            }

            html += '</div>';
            return html;
        }

        // Render all floors
        const contentDiv = document.getElementById('content');
        if (!contentDiv) {
        } else {
            post.floor_list.forEach((floor, index) => {
                try {
                    contentDiv.innerHTML += renderFloor(floor);
                } catch (e) {
                }
            });
        }
        } catch (error) {
            document.getElementById('content').innerHTML = '<p style="color: red; padding: 20px;">Error rendering post: ' + error.message + '</p>';
        }
    </script>
</body>
</html>`;
    }

    /**
     * Create tar archive from files.
     */
    public async create_tar(files: { [filename: string]: string | Blob }): Promise<Blob> {
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
                file_data = await this._blob_to_uint8array(content);
                file_size = file_data.length;
            }

            // Create tar header
            const header = this._create_tar_header(filename, file_size);
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
    private async _blob_to_uint8array(blob: Blob): Promise<Uint8Array> {
        const buffer = await blob.arrayBuffer();
        return new Uint8Array(buffer);
    }

    /**
     * Create tar header for a file.
     */
    private _create_tar_header(filename: string, file_size: number): Uint8Array {
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

    /**
     * Download blob as file.
     */
    public download_blob(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
