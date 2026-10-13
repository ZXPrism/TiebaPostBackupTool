import type { Post, Floor } from '../types';
import { ImageHandler } from '../image_handler';

/** Preserve the plugin's traversal order, image names, and JSON schema. */
export function finalize_post(
    metadata: Omit<Post, 'floor_list' | 'image_map'>,
    floors: Floor[],
    images = new ImageHandler(),
): Post {
    const avatars: string[] = [];
    let html = '';
    for (const floor of floors) {
        for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
            html += comment.content;
            if (comment.avatar_url) { avatars.push(comment.avatar_url); }
        }
    }
    const image_map = images.process_images(html, avatars);
    for (const floor of floors) {
        for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
            comment.content = images.replace_image_urls(comment.content);
        }
    }
    images.replace_avatar_urls(floors);
    return { ...metadata, floor_list: floors, image_map };
}
