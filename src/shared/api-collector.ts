import type { Comment, Floor, Post } from '../types';
import type { CollectionProgress, Progress } from './progress';

export type ApiPath = '/c/f/pb/page_pc' | '/c/f/pb/nestedFloor';
export type ApiRequest = (path: ApiPath, parameters: Record<string, string>) => Promise<unknown>;
export interface Collection {
    metadata: Omit<Post, 'floor_list' | 'image_map'>;
    floors: Floor[];
    warnings: string[];
    notes: string[];
}
type RecordValue = Record<string, unknown>;

function object(value: unknown, field: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`接口字段 ${field} 应为对象`); }
    return value as RecordValue;
}
function array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) { throw new Error(`接口字段 ${field} 应为数组`); }
    return value;
}
function text(value: unknown, field: string): string {
    if (typeof value !== 'string') { throw new Error(`接口字段 ${field} 应为字符串`); }
    return value;
}
function integer(value: unknown, field: string, minimum = 0): number {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum) {
        throw new Error(`接口字段 ${field} 应为不小于 ${minimum} 的安全整数`);
    }
    return number;
}
function flag(value: unknown, field: string): boolean {
    const number = integer(value, field);
    if (number > 1) { throw new Error(`接口字段 ${field} 应为 0 或 1`); }
    return number === 1;
}
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
function link(value: unknown, field: string): string {
    const url = new URL(text(value, field));
    if (!['https:', 'http:'].includes(url.protocol)) { throw new Error(`接口字段 ${field} 不是 HTTP(S) 地址`); }
    return escape(url.href);
}

function emoticon_url(name: string): string {
    if (name === 'image_emoticon') { return 'https://tb3.bdstatic.com/emoji/image_emoticon@2x.png'; }
    if (/^image_emoticon\d+$/.test(name)) {
        return `https://gsp0.baidu.com/5aAHeD3nKhI2p27j8IqW0jdnxx1xbK/tb/editor/images/client/${name}.png`;
    }
    const shoubai = name.match(/^shoubai_emoji_face_(\d+)$/);
    if (shoubai) {
        const id = Number(shoubai[1]);
        // Match Tieba's getShoubaiEmojiSrc range and excluded IDs.
        if ((id > 0 && id <= 229 && ![107, 109, 204].includes(id)) || [367, 368, 369, 370].includes(id)) {
            return `https://tb3.bdstatic.com/shoubai_emoji/shoubai_emoji_face_${String(id).padStart(2, '0')}.webp`;
        }
    }
    throw new Error(`尚未支持的接口表情: ${name}`);
}

/** Render supported structured content. Unknown types fail rather than disappearing from a backup. */
export function render_api_content(value: unknown, note?: (message: string) => void): string {
    const items = array(value, 'content');
    const parts = items.map((value, index) => {
        const item = object(value, `content[${index}]`);
        const type = integer(item.type, 'content.type');
        switch (type) {
            case 0:
            case 9:
            case 40: // Keep keyword text without Tieba's added search link or decoration.
                return escape(text(item.text, 'content.text')).replace(/\r?\n/g, '<br>');
            case 1:
            case 18: return `<a href="${link(item.link, 'content.link')}" target="_blank">${escape(text(item.text, 'content.text'))}</a>`;
            case 2: {
                const name = text(item.text, 'content.text');
                // Verified on the actual legacy reply page (2026-10-14): the image is broken.
                // Preserve the known label and source in the report, without downloading a substitute.
                if (name === 'shoubai_emoji_face_365') {
                    note?.('表情 [好运] 的原图缺失（原网页图片地址已核实返回 HTTP 404），已保留文字；原图地址: https://gsp0.baidu.com/5aAHeD3nKhI2p27j8IqW0jdnxx1xbK/tb/editor/images/client/shoubai_emoji_face_365.png');
                    return '[好运]';
                }
                const url = emoticon_url(name);
                return `<img class="BDE_Smiley" width="30" height="30" changedsize="false" src="${url}">`;
            }
            case 3: {
                const dimensions = text(item.bsize, 'content.bsize').match(/^(\d+),(\d+)$/);
                if (!dimensions) { throw new Error('接口图片 bsize 格式无效'); }
                return `<img class="BDE_Image" src="${link(item.origin_src, 'content.origin_src')}" width="${dimensions[1]}" height="${dimensions[2]}">`;
            }
            case 4: return `<a href="https://tieba.baidu.com/home/main?id=${encodeURIComponent(text(item.portrait, 'content.portrait'))}" class="at">${escape(text(item.text, 'content.text'))}</a>`;
            default: throw new Error(`尚未支持的接口正文类型: type=${type}，已停止采集以避免丢失内容`);
        }
    });
    let html = '';
    let previous_image = false;
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!part) { continue; }
        const image = integer(object(items[index], 'content').type, 'content.type') === 3;
        // Ordinary pictures occupy their own line on Tieba. Emoji remain inline.
        // The structured API omits these layout breaks; preserve explicit breaks without doubling them.
        if (html && (image || previous_image) && !html.endsWith('<br>') && !part.startsWith('<br>')) { html += '<br>'; }
        html += part;
        previous_image = image;
    }
    return html;
}

function comment(raw: RecordValue, users: Map<number, RecordValue>, nested: boolean, note: (message: string) => void): Comment {
    const id = integer(raw.author_id, 'author_id', 1);
    const user = raw.author ? object(raw.author, 'author') : users.get(id);
    if (!user) { throw new Error(`接口缺少作者信息: author_id=${id}`); }
    if (integer(user.id, 'user.id', 1) !== id) { throw new Error(`接口作者 ID 不匹配: author_id=${id}`); }
    const date = new Date((integer(raw.time, 'time') + 8 * 3600) * 1000).toISOString();
    const day = nested ? date.slice(0, 10).replace(/-0/g, '-') : date.slice(0, 10);
    const raw_portrait = text(user.portrait, 'user.portrait');
    const portrait = nested ? raw_portrait.split('?')[0] : raw_portrait;
    const content = render_api_content(raw.content, note);
    const reply = content.match(/回复\s+<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*:/);
    return {
        author: text(user.name_show || user.name, 'user.name_show/name'),
        date: `${day} ${date.slice(11, 16)}`, content,
        ...(!nested && user.ip_address ? { ip_location: text(user.ip_address, 'user.ip_address') } : {}),
        avatar_url: `https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/${portrait}`,
        homepage_url: `https://tieba.baidu.com/home/main?id=${portrait}${nested ? '&ie=utf-8' : ''}&fr=pb`,
        ...(reply ? { reply_to_author: reply[2], reply_to_homepage_url: reply[1] } : {}),
    };
}

/** Transport-independent collector; request retries belong to the transport, with no page fallback. */
export async function collect_api(
    post_id: number, request: ApiRequest,
    progress: (value: Progress) => Promise<void>,
    signal: AbortSignal, max_pages = 200,
): Promise<Collection> {
    const users = new Map<number, RecordValue>();
    const raw_floors: RecordValue[] = [];
    const seen = new Set<number>();
    const warnings: string[] = [];
    const notes: string[] = [];
    let metadata: Collection['metadata'] | undefined;
    let last_pid: number | undefined;
    let finished = false;
    const collection: CollectionProgress = { pages: { current: 0, complete: false } };
    const report = (value: Omit<Progress, 'collection'>) => progress({
        ...value, collection: {
            pages: { ...collection.pages },
            ...(collection.replies ? { replies: { ...collection.replies } } : {}),
        },
    });
    for (let number = 1; number <= max_pages; number++) {
        signal.throwIfAborted();
        if (number === 1) { await report({ stage: '采集帖子', current: 0 }); }
        const result = object(await request('/c/f/pb/page_pc', {
            kz: String(post_id), ...(last_pid ? { last_pid: String(last_pid) } : { pn: '1' }),
            lz: '0', r: '0', mark_type: '0', back: '0', fr: '', session_request_times: '1',
        }), 'page_pc');
        const thread = object(result.thread, 'thread');
        const page = object(result.page, 'page');
        if (integer(thread.id, 'thread.id', 1) !== post_id) { throw new Error('接口返回的帖子 ID 不匹配'); }
        if (flag(thread.is_partial_visible, 'thread.is_partial_visible')) { throw new Error('接口标记帖子仅部分内容可见，无法完整备份'); }
        if (flag(result.has_fold_comment, 'has_fold_comment')) { throw new Error('接口标记存在折叠内容，当前采集器无法保证完整备份'); }
        for (const value of array(result.user_list, 'user_list')) {
            const user = object(value, 'user');
            const id = integer(user.id, 'user.id', 1);
            if (!users.has(id)) { users.set(id, user); }
        }
        const total = integer(page.total_page, 'page.total_page', 1);
        if (total > max_pages) { throw new Error(`接口页数 ${total} 超过 ${max_pages} 页限制`); }
        integer(thread.valid_post_num, 'thread.valid_post_num', 1);
        const reply_count = integer(thread.reply_num, 'thread.reply_num');
        if (!metadata) {
            const forum = object(result.forum, 'forum');
            const name = text(forum.name, 'forum.name');
            metadata = {
                id: post_id, title: text(thread.title, 'thread.title'), tieba_name: `${name}吧`,
                tieba_url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}&ie=utf-8`,
                // Tieba's PC reply header subtracts the opening post from thread.reply_num.
                page_cnt: total, comment_cnt: Math.max(0, reply_count - 1),
            };
        }
        const posts = array(result.post_list, 'post_list').map(value => object(value, 'post'));
        const batch = number === 1 ? [object(result.first_floor, 'first_floor'), ...posts] : posts;
        if (number === 1 && integer(batch[0].floor, 'first_floor.floor', 1) !== 1) { throw new Error('接口未返回第 1 楼，无法完整备份'); }
        const batch_ids = new Set<number>();
        let previous_floor = 0;
        const previous_count = raw_floors.length;
        for (const post of batch) {
            const id = integer(post.id, 'post.id', 1);
            const floor = integer(post.floor, 'post.floor', 1);
            if (batch_ids.has(id) || floor <= previous_floor) { throw new Error(`接口单次响应出现重复或乱序楼层: floor=${floor}, post_id=${id}`); }
            batch_ids.add(id);
            previous_floor = floor;
            if (post.is_fold !== undefined && flag(post.is_fold, 'post.is_fold')) { throw new Error(`第 ${floor} 楼已折叠，无法完整备份`); }
            // Live pages can overlap. Keep the version first collected without rescanning.
            if (seen.has(id)) { continue; }
            if (floor <= Number(raw_floors.at(-1)?.floor || 0)) { throw new Error(`接口出现乱序楼层: floor=${floor}, post_id=${id}`); }
            // Detect unsupported content on receipt, before fetching later pages.
            try {
                render_api_content(post.content);
                if (post.sub_post_list) {
                    const embedded = array(object(post.sub_post_list, 'sub_post_list').sub_post_list, 'sub_post_list.sub_post_list');
                    for (const reply of embedded) { render_api_content(object(reply, 'sub_post').content); }
                }
            } catch (error) {
                throw new Error(`第 ${floor} 楼: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            seen.add(id);
            raw_floors.push(post);
        }
        finished = !flag(page.has_more, 'page.has_more');
        collection.pages = { current: number, total: finished ? number : Math.max(total, number + 1), complete: finished };
        await report({ stage: '采集帖子', current: number, total: collection.pages.total });
        if (finished) { break; }
        if (!posts.length) { throw new Error('接口声明还有下一页，但当前楼层列表为空'); }
        if (raw_floors.length === previous_count) { throw new Error('接口楼层分页游标未前进'); }
        last_pid = integer(posts[posts.length - 1].id, 'last_pid', 1);
    }
    if (!finished || !metadata) { throw new Error(`接口分页未结束，已达到 ${max_pages} 页限制`); }
    let remaining_replies = raw_floors.reduce((sum, raw) => sum + integer(raw.sub_post_number, `第 ${raw.floor} 楼 sub_post_number`), 0);
    let completed_replies = 0;
    collection.replies = { current: 0, total: remaining_replies, complete: false };
    await report({ stage: '采集楼中楼' });
    const floors: Floor[] = [];
    for (const raw of raw_floors) {
        const index = integer(raw.floor, 'floor', 1);
        try {
            signal.throwIfAborted();
            const count = integer(raw.sub_post_number, 'sub_post_number');
            remaining_replies -= count;
            let replies = raw.sub_post_list
                ? array(object(raw.sub_post_list, 'sub_post_list').sub_post_list, 'sub_post_list.sub_post_list').map(value => object(value, 'sub_post')) : [];
            if (replies.length < count) {
                replies = [];
                const reply_ids = new Set<number>();
                let offset = 0;
                let done = false;
                for (let number = 1; number <= max_pages; number++) {
                    signal.throwIfAborted();
                    collection.replies = { current: completed_replies + replies.length,
                        total: completed_replies + remaining_replies + Math.max(count, replies.length + 1), complete: false };
                    await report({ stage: `采集第 ${index} 楼的楼中楼`, current: replies.length, total: Math.max(count, replies.length + 1) });
                    const result = object(await request('/c/f/pb/nestedFloor', { thread_id: String(post_id), post_id: String(raw.id), offset: String(offset) }), 'nestedFloor');
                    const page = object(result.page, 'nestedFloor.page');
                    const batch = array(result.post_list, 'nestedFloor.post_list').map(value => object(value, 'sub_post'));
                    const batch_ids = new Set<number>();
                    for (const reply of batch) {
                        const id = integer(reply.id, 'sub_post.id', 1);
                        if (batch_ids.has(id)) { throw new Error('楼中楼单次响应存在重复回复 ID'); }
                        batch_ids.add(id);
                        if (!reply_ids.has(id)) {
                            render_api_content(reply.content);
                            reply_ids.add(id);
                            replies.push(reply);
                        }
                    }
                    done = !flag(page.has_more, 'nestedFloor.page.has_more');
                    collection.replies = { current: completed_replies + replies.length,
                        total: completed_replies + remaining_replies + (done ? replies.length : Math.max(count, replies.length + 1)), complete: false };
                    await report({ stage: `采集第 ${index} 楼的楼中楼`, current: replies.length, total: done ? replies.length : Math.max(count, replies.length + 1) });
                    if (done) { break; }
                    const next = integer(page.offset, 'nestedFloor.page.offset', 1);
                    if (!batch.length || next <= offset) { throw new Error('楼中楼分页游标未前进'); }
                    offset = next;
                }
                if (!done) { throw new Error(`楼中楼分页未结束，已达到 ${max_pages} 页限制`); }
            }
            if (new Set(replies.map(reply => integer(reply.id, 'sub_post.id', 1))).size !== replies.length) { throw new Error('楼中楼存在重复回复 ID'); }
            const note = (message: string) => { notes.push(`第 ${index} 楼: ${message}`); };
            floors.push({ index, comment: comment(raw, users, false, note), ...(replies.length ? {
                sub_comment_list: replies.map(reply => comment(reply, users, true,
                    message => note(`楼中楼回复 ${reply.id}: ${message}`))),
            } : {}) });
            completed_replies += replies.length;
        } catch (error) {
            if (signal.aborted) { signal.throwIfAborted(); }
            throw new Error(`第 ${index} 楼: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    collection.replies = { current: completed_replies, total: completed_replies, complete: true };
    await report({ stage: '内容采集完成' });
    return { metadata, floors, warnings, notes };
}
