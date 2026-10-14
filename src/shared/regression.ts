import type { Post } from '../types';

export interface Difference { path: string; expected: unknown; actual: unknown }

export interface RegressionOptions { normalize_images?: boolean; strict?: boolean }
export interface RegressionReport {
    differences: Difference[];
    strict_differences: Difference[];
    accepted_space_differences: Difference[];
}

/** Only collapse consecutive ASCII spaces in ordinary text, never HTML attributes or preformatted text. */
export function normalize_content_spaces(content: string): string {
    const tags = /<!--[\s\S]*?-->|<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g;
    const protected_tags = new Set(['pre', 'code', 'script', 'style', 'textarea']);
    const stack: string[] = [];
    let offset = 0;
    let result = '';
    for (const match of content.matchAll(tags)) {
        const start = match.index;
        const before = content.slice(offset, start);
        result += (stack.length ? before : before.replace(/ {2,}/g, ' ')) + match[0];
        const tag = match[0].match(/^<(\/?)([a-zA-Z]+)/);
        if (tag && protected_tags.has(tag[2].toLowerCase())) {
            if (tag[1] && stack.at(-1) === tag[2].toLowerCase()) { stack.pop(); }
            else if (!tag[1] && !match[0].endsWith('/>')) { stack.push(tag[2].toLowerCase()); }
        }
        offset = start + match[0].length;
    }
    const rest = content.slice(offset);
    return result + (stack.length ? rest : rest.replace(/ {2,}/g, ' '));
}

/** Approved space rule is applied only by the regression entry point; strict comparison remains available. */
export function regression_report(expected: Post, actual: Post, options: RegressionOptions = {}): RegressionReport {
    const strict_differences = compare_posts(expected, actual);
    const comparison = options.normalize_images ? compare_posts(expected, actual, true) : strict_differences;
    const accepted_space_differences = options.strict ? [] : comparison.filter(difference =>
        /^\$\.floor_list\[\d+\]\.(?:comment|sub_comment_list\[\d+\])\.content$/.test(difference.path)
        && typeof difference.expected === 'string' && typeof difference.actual === 'string'
        && normalize_content_spaces(difference.expected) === normalize_content_spaces(difference.actual));
    const accepted = new Set(accepted_space_differences);
    return { strict_differences, accepted_space_differences, differences: comparison.filter(diff => !accepted.has(diff)) };
}

function canonicalize(post: Post, normalize_images: boolean): unknown {
    const copy = JSON.parse(JSON.stringify(post)) as Post;
    if (!normalize_images) { return copy; }
    const sources = new Map<string, string[]>();
    for (const [url, filename] of Object.entries(copy.image_map || {})) {
        const urls = sources.get(filename) || [];
        urls.push(url);
        sources.set(filename, urls);
    }
    // Preserve alias groups: filename normalization must not silently approve merging different images.
    const reverse = new Map([...sources].map(([filename, urls]) => [filename,
        urls.length === 1 ? urls[0] : `image-sources:${encodeURIComponent(JSON.stringify(urls.sort()))}`]));
    for (const floor of copy.floor_list) {
        for (const comment of [floor.comment, ...(floor.sub_comment_list || [])]) {
            comment.content = comment.content.replace(/src=["']\.\/images\/([^"']+)["']/g, (_match, name: string) => {
                const url = reverse.get(name);
                if (!url) { throw new Error(`缺少图片映射: ${name}`); }
                return `src="${url}"`;
            });
            if (comment.avatar_url) {
                comment.avatar_url = reverse.get(comment.avatar_url) || comment.avatar_url;
            }
        }
    }
    // Keep the entire source URL set, including otherwise unreferenced images.
    return { ...copy, image_map: Object.keys(copy.image_map || {}).sort() };
}

/** Object key order is irrelevant. Array order and every field remain significant. */
export function compare_posts(expected: Post, actual: Post, normalize_images = false): Difference[] {
    const differences: Difference[] = [];
    function visit(left: unknown, right: unknown, path: string): void {
        if (Object.is(left, right)) { return; }
        if (Array.isArray(left) && Array.isArray(right)) {
            if (left.length !== right.length) {
                differences.push({ path: `${path}.length`, expected: left.length, actual: right.length });
            }
            for (let i = 0; i < Math.max(left.length, right.length); i++) {
                visit(left[i], right[i], `${path}[${i}]`);
            }
        } else if (left && right && typeof left === 'object' && typeof right === 'object'
            && !Array.isArray(left) && !Array.isArray(right)) {
            const a = left as Record<string, unknown>;
            const b = right as Record<string, unknown>;
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
                visit(a[key], b[key], `${path}.${key}`);
            }
        } else {
            differences.push({ path, expected: left, actual: right });
        }
    }
    visit(canonicalize(expected, normalize_images), canonicalize(actual, normalize_images), '$');
    return differences;
}
