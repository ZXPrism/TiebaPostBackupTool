import type { Comment, Floor, Post } from '../types';

export type ApiPath = '/c/f/pb/page_pc' | '/c/f/pb/nestedFloor';
export type ApiRequest = (path: ApiPath, parameters: Record<string, string>) => Promise<unknown>;
export interface Collection {
    metadata: Omit<Post, 'floor_list' | 'image_map'>;
    floors: Floor[];
    warnings: string[];
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

/** Render supported structured content. Unknown types fail rather than disappearing from a backup. */
export function render_api_content(value: unknown): string {
    return array(value, 'content').map((value, index) => {
        const item = object(value, `content[${index}]`);
        const type = integer(item.type, 'content.type');
        switch (type) {
            case 0:
            case 9:
            case 40: // Keep keyword text without Tieba's added search link or decoration.
                return escape(text(item.text, 'content.text')).replace(/\r?\n/g, '<br>');
            case 1: return `<a href="${link(item.link, 'content.link')}" target="_blank">${escape(text(item.text, 'content.text'))}</a>`;
            case 2: {
                const name = text(item.text, 'content.text');
                if (!/^image_emoticon\d*$/.test(name)) { throw new Error(`尚未支持的接口表情: ${name}`); }
                // The unnumbered 呵呵 emoticon has no PNG at the legacy client path.
                const url = name === 'image_emoticon' ? 'https://tb3.bdstatic.com/emoji/image_emoticon@2x.png'
                    : `https://gsp0.baidu.com/5aAHeD3nKhI2p27j8IqW0jdnxx1xbK/tb/editor/images/client/${name}.png`;
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
    }).join('');
}

function comment(raw: RecordValue, users: Map<number, RecordValue>, nested: boolean): Comment {
    const id = integer(raw.author_id, 'author_id', 1);
    const user = raw.author ? object(raw.author, 'author') : users.get(id);
    if (!user) { throw new Error(`接口缺少作者信息: author_id=${id}`); }
    if (integer(user.id, 'user.id', 1) !== id) { throw new Error(`接口作者 ID 不匹配: author_id=${id}`); }
    const date = new Date((integer(raw.time, 'time') + 8 * 3600) * 1000).toISOString();
    const day = nested ? date.slice(0, 10).replace(/-0/g, '-') : date.slice(0, 10);
    const raw_portrait = text(user.portrait, 'user.portrait');
    const portrait = nested ? raw_portrait.split('?')[0] : raw_portrait;
    const content = render_api_content(raw.content);
    const reply = content.match(/回复\s+<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*:/);
    return {
        author: text(nested ? user.name || user.name_show : user.name_show || user.name, 'user.name'),
        date: `${day} ${date.slice(11, 16)}`, content,
        ...(!nested && user.ip_address ? { ip_location: text(user.ip_address, 'user.ip_address') } : {}),
        avatar_url: `https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/${portrait}`,
        homepage_url: `https://tieba.baidu.com/home/main?id=${portrait}${nested ? '&ie=utf-8' : ''}&fr=pb`,
        ...(reply ? { reply_to_author: reply[2], reply_to_homepage_url: reply[1] } : {}),
    };
}

/** Transport-independent collector; no page navigation and no implicit retry/fallback. */
export async function collect_api(
    post_id: number, request: ApiRequest,
    progress: (value: { stage: string; current?: number; total?: number }) => Promise<void>,
    signal: AbortSignal, max_pages = 200,
): Promise<Collection> {
    const users = new Map<number, RecordValue>();
    const raw_floors: RecordValue[] = [];
    const seen = new Set<number>();
    const warnings: string[] = [];
    let metadata: Collection['metadata'] | undefined;
    let page_total: number | undefined;
    let last_pid: number | undefined;
    let finished = false;
    for (let number = 1; number <= max_pages; number++) {
        signal.throwIfAborted();
        await progress({ stage: '采集帖子', current: number, total: page_total });
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
        page_total = total;
        integer(thread.valid_post_num, 'thread.valid_post_num', 1);
        const reply_count = integer(thread.reply_num, 'thread.reply_num');
        if (!metadata) {
            const forum = object(result.forum, 'forum');
            const name = text(forum.name, 'forum.name');
            metadata = {
                id: post_id, title: text(thread.title, 'thread.title'), tieba_name: `${name}吧`,
                tieba_url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}&ie=utf-8`,
                page_cnt: total, comment_cnt: reply_count,
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
            seen.add(id);
            raw_floors.push(post);
        }
        if (!flag(page.has_more, 'page.has_more')) { finished = true; break; }
        if (!posts.length) { throw new Error('接口声明还有下一页，但当前楼层列表为空'); }
        if (raw_floors.length === previous_count) { throw new Error('接口楼层分页游标未前进'); }
        last_pid = integer(posts[posts.length - 1].id, 'last_pid', 1);
    }
    if (!finished || !metadata) { throw new Error(`接口分页未结束，已达到 ${max_pages} 页限制`); }
    const floors: Floor[] = [];
    for (const raw of raw_floors) {
        const index = integer(raw.floor, 'floor', 1);
        try {
            signal.throwIfAborted();
            const count = integer(raw.sub_post_number, 'sub_post_number');
            let replies = raw.sub_post_list
                ? array(object(raw.sub_post_list, 'sub_post_list').sub_post_list, 'sub_post_list.sub_post_list').map(value => object(value, 'sub_post')) : [];
            if (replies.length < count) {
                replies = [];
                const reply_ids = new Set<number>();
                let offset = 0;
                let done = false;
                for (let number = 1; number <= max_pages; number++) {
                    signal.throwIfAborted();
                    await progress({ stage: `采集第 ${index} 楼的楼中楼`, current: replies.length, total: count });
                    const result = object(await request('/c/f/pb/nestedFloor', { thread_id: String(post_id), post_id: String(raw.id), offset: String(offset) }), 'nestedFloor');
                    const page = object(result.page, 'nestedFloor.page');
                    const batch = array(result.post_list, 'nestedFloor.post_list').map(value => object(value, 'sub_post'));
                    const batch_ids = new Set<number>();
                    for (const reply of batch) {
                        const id = integer(reply.id, 'sub_post.id', 1);
                        if (batch_ids.has(id)) { throw new Error('楼中楼单次响应存在重复回复 ID'); }
                        batch_ids.add(id);
                        if (!reply_ids.has(id)) { reply_ids.add(id); replies.push(reply); }
                    }
                    if (!flag(page.has_more, 'nestedFloor.page.has_more')) { done = true; break; }
                    const next = integer(page.offset, 'nestedFloor.page.offset', 1);
                    if (!batch.length || next <= offset) { throw new Error('楼中楼分页游标未前进'); }
                    offset = next;
                }
                if (!done) { throw new Error(`楼中楼分页未结束，已达到 ${max_pages} 页限制`); }
            }
            if (new Set(replies.map(reply => integer(reply.id, 'sub_post.id', 1))).size !== replies.length) { throw new Error('楼中楼存在重复回复 ID'); }
            floors.push({ index, comment: comment(raw, users, false), ...(replies.length ? { sub_comment_list: replies.map(reply => comment(reply, users, true)) } : {}) });
        } catch (error) {
            if (signal.aborted) { signal.throwIfAborted(); }
            throw new Error(`第 ${index} 楼: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    return { metadata, floors, warnings };
}
