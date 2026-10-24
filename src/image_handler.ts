import { Post, ImageMap, Floor, Comment } from './types';

export class ImageHandler {
    private image_map: ImageMap = {};
    private image_counter: number = 1;
    public readonly failed_images: string[] = [];

    constructor(
        private readonly fetch_image?: (url: string) => Promise<Blob>,
        image_map: ImageMap = {},
        private readonly concurrency = 5,
        private readonly batch_delay_ms = 1000,
    ) { this.image_map = { ...image_map }; }


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
    public async download_images(on_progress?: (current: number, total: number, filename: string) => void, signal?: AbortSignal): Promise<{ [filename: string]: Blob }> {
        this.failed_images.length = 0;
        const blobs: { [filename: string]: Blob } = {};
        const entries = Object.entries(this.image_map);
        const total = entries.length;
        let current = 0;


        const BATCH_SIZE = this.concurrency;
        const BATCH_DELAY = this.batch_delay_ms;

        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            signal?.throwIfAborted();
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
                    this.failed_images.push(new_name);
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

    /** Merge byte-identical downloads in source order, then update every local image reference. */
    public async deduplicate_images(post: Post, blobs: Record<string, Blob>, signal?: AbortSignal): Promise<Record<string, Blob>> {
        const aliases = new Map<string, string>();
        const hashes = new Map<string, string>();
        const unique: Record<string, Blob> = {};
        const failed = new Set(this.failed_images);
        for (const name of new Set(Object.values(post.image_map || {}))) {
            signal?.throwIfAborted();
            const blob = blobs[name];
            if (!blob) { throw new Error(`缺少已下载的图片: ${name}`); }
            // Failed downloads retain their own placeholder and diagnostic identity.
            if (!failed.has(name)) {
                const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
                const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                const existing = hashes.get(hash);
                if (existing) { aliases.set(name, existing); continue; }
                hashes.set(hash, name);
            }
            aliases.set(name, name);
            unique[name] = blob;
        }
        signal?.throwIfAborted();
        // Commit the new references only after hashing succeeds, so cancellation leaves post intact.
        const image_map = post.image_map || {};
        for (const [url, name] of Object.entries(image_map)) {
            image_map[url] = aliases.get(name) || name;
        }
        for (const floor of post.floor_list) {
            for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
                if (comment.avatar_url && aliases.has(comment.avatar_url)) {
                    comment.avatar_url = aliases.get(comment.avatar_url);
                }
                comment.content = comment.content.replace(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag =>
                    tag.replace(/(\s+)([\w:-]+)(\s*=\s*)(["'])(.*?)\4/g, (attribute, space, name, equals, quote, value: string) => {
                        if (name.toLowerCase() !== 'src' || !value.startsWith('./images/')) { return attribute; }
                        const target = aliases.get(value.slice('./images/'.length));
                        return target ? `${space}${name}${equals}${quote}./images/${target}${quote}` : attribute;
                    }));
            }
        }
        this.image_map = { ...post.image_map };
        return unique;
    }

    private async _fetch_image(url: string): Promise<Blob> {
        if (this.fetch_image) { return this.fetch_image(url); }
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
        return response.blob();
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

}
