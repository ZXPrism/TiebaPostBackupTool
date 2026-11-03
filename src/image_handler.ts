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

/** Apply deduplication only after every image has been saved successfully. */
export function remap_image_names(post: Post, aliases: ReadonlyMap<string, string>): void {
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
}
