import { Post, Floor, Comment, ParseState } from './types';
import { ImageHandler } from './image_handler';

export class Parser {
    private image_handler: ImageHandler;
    private base_url: string;
    private current_page: number;

    constructor() {
        this.image_handler = new ImageHandler();
        this.base_url = window.location.href.split('?')[0]; // Remove query params
        this.current_page = this._get_current_page_number();
    }

    /**
     * Get current page number from URL query parameter.
     */
    private _get_current_page_number(): number {
        const url_params = new URLSearchParams(window.location.search);
        const pn = url_params.get('pn');
        return pn ? parseInt(pn) : 1;
    }

    /**
     * Check if reset mode is active (don't auto-save state).
     */
    public is_reset_mode(): boolean {
        return GM_getValue<boolean>('reset_mode', false);
    }

    /**
     * Reset parsing state (clear all stored data).
     */
    public reset_parsing(): void {
        GM_deleteValue('parse_state');
    }

    /**
     * Save parsing state to GM storage (respects reset mode).
     */
    private _save_state(state: ParseState): void {
        if (!this.is_reset_mode()) {
            GM_setValue('parse_state', state);
        }
    }

    /**
     * Load parsing state from GM storage.
     */
    private _load_state(): ParseState | null {
        const state = GM_getValue<ParseState | undefined>('parse_state', undefined);
        return state || null;
    }

    /**
     * Clear parsing state from GM storage.
     */
    private _clear_state(): void {
        GM_deleteValue('parse_state');
    }

    /**
     * Check if state is stale (older than 30 minutes).
     */
    private _is_state_stale(state: ParseState): boolean {
        const THIRTY_MINUTES = 30 * 60 * 1000;
        return Date.now() - state.timestamp > THIRTY_MINUTES;
    }

    /**
     * Check if parsing is in progress for this post.
     */
    public is_parsing_in_progress(): boolean {
        const state = this._load_state();
        if (!state || !state.active) {
            return false;
        }

        // Check if state is stale
        if (this._is_state_stale(state)) {
            this._clear_state();
            return false;
        }

        // Check if state matches current post
        if (state.post_id !== this._parse_post_id()) {
            return false;
        }

        return true;
    }

    /**
     * Cancel ongoing parsing (user manually aborted).
     */
    public cancel_parsing(): void {
        const state = this._load_state();
        if (state && state.active) {
            this._clear_state();
        }
    }

    /**
     * Get the image handler instance (for accessing image_map and downloading).
     */
    public get_image_handler(): ImageHandler {
        return this.image_handler;
    }

    /**
     * Parse the complete post from current page DOM.
     * Automatically loads all content before parsing.
     * Handles multi-page posts with state persistence.
     */
    public async parse_post(): Promise<Post> {
        const post_id = this._parse_post_id();

        // Check if resuming existing parse
        const existing_state = this._load_state();
        if (existing_state && existing_state.active && existing_state.post_id === post_id) {
            if (this._is_state_stale(existing_state)) {
                this._clear_state();
            } else {
                return await this._resume_parse(existing_state);
            }
        }

        // Start new parse
        return await this._start_parse();
    }

    /**
     * Start a new parsing session.
     */
    private async _start_parse(): Promise<Post> {
        // Get metadata
        const post_id = this._parse_post_id();
        const page_cnt = this._parse_page_count();


        // If not on page 1, navigate to page 1 first
        if (this.current_page !== 1) {
            // Initialize state with current page info
            const state: ParseState = {
                active: true,
                post_id,
                current_page: 1,
                total_pages: page_cnt,
                collected_floors: [],
                timestamp: Date.now(),
            };
            this._save_state(state);
            this._navigate_to_page(1);
            throw new Error('NAVIGATING');
        }

        // Initialize state
        const state: ParseState = {
            active: true,
            post_id,
            current_page: this.current_page,
            total_pages: page_cnt,
            collected_floors: [],
            timestamp: Date.now(),
        };
        this._save_state(state);

        // Parse current page
        const page_floors = await this._parse_current_page();
        state.collected_floors = state.collected_floors.concat(page_floors);
        state.current_page = this.current_page + 1;
        this._save_state(state);

        // Navigate to next page or finish
        if (state.current_page <= state.total_pages) {
            this._navigate_to_page(state.current_page);
            throw new Error('NAVIGATING'); // Will be caught by main.ts
        } else {
            return await this._finalize_parse(state);
        }
    }

    /**
     * Resume an existing parsing session.
     */
    private async _resume_parse(state: ParseState): Promise<Post> {

        // Parse current page
        const page_floors = await this._parse_current_page();
        state.collected_floors = state.collected_floors.concat(page_floors);
        state.current_page = this.current_page + 1;
        this._save_state(state);

        // Navigate to next page or finish
        if (state.current_page <= state.total_pages) {
            this._navigate_to_page(state.current_page);
            throw new Error('NAVIGATING'); // Will be caught by main.ts
        } else {
            return await this._finalize_parse(state);
        }
    }

    /**
     * Finalize parsing and create the complete post.
     */
    private async _finalize_parse(state: ParseState): Promise<Post> {

        // Get metadata
        const title = this._parse_title();
        const tieba_name = this._parse_tieba_name();
        const tieba_url = this._parse_tieba_url();
        const post_id = state.post_id;
        const page_cnt = state.total_pages;
        const comment_cnt = this._parse_comment_count();

        // Process images from all pages
        const avatar_urls = this._extract_all_avatar_urls(state.collected_floors);
        const all_html = this._collect_all_html(state.collected_floors);
        const image_map = this.image_handler.process_images(all_html, avatar_urls);

        // Replace image URLs with new names
        this._replace_image_urls_in_floors(state.collected_floors);

        // Replace avatar URLs with mapped filenames
        this.image_handler.replace_avatar_urls(state.collected_floors);

        const post: Post = {
            title,
            tieba_name,
            tieba_url,
            id: post_id,
            page_cnt,
            comment_cnt,
            floor_list: state.collected_floors,
            image_map,
        };

        // Clear state
        this._clear_state();

        return post;
    }

    /**
     * Navigate to a specific page.
     */
    private _navigate_to_page(page_number: number): void {
        const page_url = `${this.base_url}?pn=${page_number}`;
        window.location.href = page_url;
    }

    /**
     * Parse the current page with full loading process.
     */
    private async _parse_current_page(): Promise<Floor[]> {
        // Save original zoom and set to small value for faster loading
        const original_zoom = this._save_original_zoom();
        this._set_zoom(0.3); // Zoom out to 30%

        // Give the browser time to apply zoom
        await new Promise(resolve => setTimeout(resolve, 500));

        // Stage 1: Load all floors via scrolling
        await this._scroll_to_load_floors();

        // Stage 2: Expand all sub-comments
        await this._expand_all_sub_comments();

        // Stage 3: Parse with pagination handling
        const floor_list = await this._parse_floors();

        // Restore original zoom
        this._set_zoom(original_zoom);

        return floor_list;
    }

    /**
     * Extract all avatar URLs from floor list.
     */
    private _extract_all_avatar_urls(floor_list: Floor[]): string[] {
        const avatar_urls: string[] = [];
        floor_list.forEach(floor => {
            if (floor.comment.avatar_url) {
                avatar_urls.push(floor.comment.avatar_url);
            }
            if (floor.sub_comment_list) {
                floor.sub_comment_list.forEach(sub => {
                    if (sub.avatar_url) {
                        avatar_urls.push(sub.avatar_url);
                    }
                });
            }
        });
        return avatar_urls;
    }

    /**
     * Collect all HTML content from floor list.
     */
    private _collect_all_html(floor_list: Floor[]): string {
        let all_html = '';
        floor_list.forEach(floor => {
            all_html += floor.comment.content;
            if (floor.sub_comment_list) {
                floor.sub_comment_list.forEach(sub => {
                    all_html += sub.content;
                });
            }
        });
        return all_html;
    }

    /**
     * Replace image URLs in all floor content.
     */
    private _replace_image_urls_in_floors(floor_list: Floor[]): void {
        floor_list.forEach(floor => {
            floor.comment.content = this.image_handler.replace_image_urls(floor.comment.content);
            if (floor.sub_comment_list) {
                floor.sub_comment_list.forEach(sub => {
                    sub.content = this.image_handler.replace_image_urls(sub.content);
                });
            }
        });
    }

    /**
     * Save original zoom level.
     */
    private _save_original_zoom(): number {
        const current_zoom = (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom || '1';
        return parseFloat(current_zoom);
    }

    /**
     * Set zoom level.
     */
    private _set_zoom(level: number): void {
        (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = level.toString();
    }

    /**
     * Stage 1: Scroll to load all lazy-loaded floors.
     */
    private async _scroll_to_load_floors(): Promise<void> {
        return new Promise(resolve => {
            window.scrollTo(0, 0);

            const scroll_task = setInterval(() => {
                window.scrollBy(0, 100);
                const max_scroll = document.documentElement.scrollHeight - window.innerHeight;

                // Check if we've reached the bottom with some buffer
                if (window.scrollY + window.innerHeight >= max_scroll - 50) {
                    // Extra wait to ensure last floor loads
                    setTimeout(() => {
                        clearInterval(scroll_task);

                        // Final scroll to ensure we're at absolute bottom
                        window.scrollTo(0, document.documentElement.scrollHeight);

                        // Additional wait for lazy loading
                        setTimeout(() => {
                            resolve();
                        }, 1000);
                    }, 500);
                }
            }, 100); // Scroll every 100ms (moderate speed)
        });
    }

    /**
     * Stage 2: Expand all sub-comment sections.
     */
    private async _expand_all_sub_comments(): Promise<void> {
        // Find all "点击查看" buttons and click them
        const expand_buttons = document.querySelectorAll('.j_lzl_m');

        expand_buttons.forEach((button) => {
            try {
                (button as HTMLElement).click();
            } catch {
                // Ignore click errors
            }
        });

        // Wait for DOM to update after expanding
        await this._wait_for_dom_update();
    }

    /**
     * Parse post title from DOM.
     */
    private _parse_title(): string {
        const title_element = document.querySelector('.core_title_txt');
        if (!title_element) {
            throw new Error('Post title not found');
        }
        return title_element.textContent?.trim() || '';
    }

    /**
     * Parse tieba name from DOM.
     */
    private _parse_tieba_name(): string {
        const tieba_element = document.querySelector('.card_title_fname');
        if (!tieba_element) {
            throw new Error('Tieba name not found');
        }
        return tieba_element.textContent?.trim() || '';
    }

    /**
     * Parse tieba URL from DOM.
     */
    private _parse_tieba_url(): string {
        // Try to find the link from the card title
        const tieba_link = document.querySelector('.card_title_fname');
        if (tieba_link && tieba_link.tagName === 'A') {
            const href = tieba_link.getAttribute('href');
            if (href) {
                // Convert relative URL to absolute
                if (href.startsWith('/')) {
                    return 'https://tieba.baidu.com' + href;
                }
                return href;
            }
        }

        // Fallback: construct URL from tieba name
        const tieba_name = this._parse_tieba_name();
        return `https://tieba.baidu.com/f?kw=${encodeURIComponent(tieba_name)}&fr=index`;
    }

    /**
     * Parse post ID from URL.
     * URL format: tieba.baidu.com/p/{id}
     */
    private _parse_post_id(): number {
        const url_match = window.location.href.match(/\/p\/(\d+)/);
        if (!url_match) {
            throw new Error('Post ID not found in URL');
        }
        return parseInt(url_match[1]);
    }

    /**
     * Parse total page count from DOM.
     */
    private _parse_page_count(): number {
        const posts_num_element = document.querySelector('.l_posts_num');
        if (!posts_num_element) {
            throw new Error('Page count not found');
        }

        const text = posts_num_element.textContent || '';
        const page_match = text.match(/共(\d+)页/);
        if (!page_match) {
            throw new Error('Page count format not recognized');
        }

        return parseInt(page_match[1]);
    }

    /**
     * Parse total comment count from DOM.
     */
    private _parse_comment_count(): number {
        const posts_num_element = document.querySelector('.l_posts_num');
        if (!posts_num_element) {
            throw new Error('Comment count not found');
        }

        const text = posts_num_element.textContent || '';
        const comment_match = text.match(/(\d+)回复贴/);
        if (!comment_match) {
            throw new Error('Comment count format not recognized');
        }

        return parseInt(comment_match[1]);
    }

    /**
     * Parse all floors from DOM.
     */
    private async _parse_floors(): Promise<Floor[]> {
        const floors: Floor[] = [];
        const floor_elements = Array.from(document.querySelectorAll('.l_post.l_post_bright'));

        for (let i = 0; i < floor_elements.length; i++) {
            const floor_element = floor_elements[i];

            // Skip advertisement floors
            const data_field = floor_element.getAttribute('data-field');
            if (data_field === '{}') {
                continue;
            }

            try {
                const floor = await this._parse_floor(floor_element);
                floors.push(floor);
            } catch {
                // Skip floors that fail to parse
            }
        }

        return floors;
    }

    /**
     * Parse single floor from DOM element.
     */
    private async _parse_floor(floor_element: Element): Promise<Floor> {
        const comment = this._parse_main_comment(floor_element);
        const index = this._parse_floor_index(floor_element);
        const sub_comments = await this._parse_sub_comments(floor_element);

        return {
            comment,
            index,
            sub_comment_list: sub_comments.length > 0 ? sub_comments : undefined,
        };
    }

    /**
     * Parse main comment from floor element.
     */
    private _parse_main_comment(floor_element: Element): Comment {
        const author = this._parse_author_name(floor_element);
        const date = this._parse_date(floor_element);
        const content = this._parse_content(floor_element);
        const ip_location = this._parse_ip_location(floor_element);
        const avatar_url = this._parse_avatar_url(floor_element);
        const homepage_url = this._parse_homepage_url(floor_element);

        return {
            author,
            date,
            content,
            ip_location,
            avatar_url,
            homepage_url,
        };
    }

    /**
     * Parse author name from floor element.
     */
    private _parse_author_name(floor_element: Element): string {
        const author_element = floor_element.querySelector('.p_author_name');
        if (!author_element) {
            throw new Error('Author name not found');
        }
        return author_element.textContent?.trim() || '';
    }

    /**
     * Parse homepage URL from floor element.
     */
    private _parse_homepage_url(floor_element: Element): string | undefined {
        // Try to find the author link (usually .p_author_name is an <a> tag)
        const author_link = floor_element.querySelector('.p_author_name');
        if (author_link && author_link.tagName === 'A') {
            const href = author_link.getAttribute('href');
            if (href) {
                // Convert relative URL to absolute
                if (href.startsWith('/')) {
                    return 'https://tieba.baidu.com' + href;
                }
                return href;
            }
        }

        // Fallback: look for any link with /home/main in href
        const home_link = floor_element.querySelector('a[href*="/home/main"]');
        if (home_link) {
            const href = home_link.getAttribute('href');
            if (href) {
                if (href.startsWith('/')) {
                    return 'https://tieba.baidu.com' + href;
                }
                return href;
            }
        }

        return undefined;
    }

    /**
     * Parse avatar URL from floor element.
     */
    private _parse_avatar_url(floor_element: Element): string | undefined {
        // Try to find avatar image in the floor element
        const avatar_img = floor_element.querySelector('.p_author_face img');
        if (avatar_img) {
            return avatar_img.getAttribute('src') || undefined;
        }

        // Fallback: try other common avatar selectors
        const fallback_avatar = floor_element.querySelector('img[src*="static.tieba.baidu.com"]');
        if (fallback_avatar) {
            return fallback_avatar.getAttribute('src') || undefined;
        }

        return undefined;
    }

    /**
     * Parse date from floor element.
     * Handles both old and new Tieba DOM formats.
     */
    private _parse_date(floor_element: Element): string {
        // Try new format first
        const new_format_tail = floor_element.querySelector('.core_reply_tail');
        if (new_format_tail) {
            const text = new_format_tail.textContent || '';
            const date_match = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
            if (date_match) {
                return date_match[1];
            }
        }

        // Try old format
        const old_format_date = floor_element.querySelector('.tail-info');
        if (old_format_date) {
            const text = old_format_date.textContent || '';
            const date_match = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
            if (date_match) {
                return date_match[1];
            }
        }

        throw new Error('Date pattern not found in either old or new format');
    }

    /**
     * Parse content from floor element.
     */
    private _parse_content(floor_element: Element): string {
        const content_element = floor_element.querySelector('.d_post_content');
        if (!content_element) {
            throw new Error('Content element not found');
        }
        let content = content_element.innerHTML.trim();

        // Remove UI text that's not actual user content
        content = content.replace(/点击展开，查看完整图片。/g, '');
        content = content.replace(/点击展开，查看完整图片<\/a>/g, '');
        content = content.replace(/\s*点击展开，查看完整图片。?\s*/g, ''); // With surrounding whitespace
        content = content.replace(/\s*点击展开，查看完整图片<\/a>\s*/g, ''); // Link tag version

        return content;
    }

    /**
     * Parse IP location from floor element.
     * Returns undefined if IP location not present.
     * Handles both old and new Tieba DOM formats.
     */
    private _parse_ip_location(floor_element: Element): string | undefined {
        // Try new format first: "IP属地:浙江" in .ip-location span
        const ip_element = floor_element.querySelector('.ip-location span');
        if (ip_element) {
            const text = ip_element.textContent || '';
            const ip_match = text.match(/IP属地:(.+)/);
            if (ip_match) {
                return ip_match[1].trim();
            }
        }

        // Try old format: "IP属地:浙江" in various containers
        const ip_spans = floor_element.querySelectorAll('span');
        for (const span of Array.from(ip_spans)) {
            const text = span.textContent || '';
            const ip_match = text.match(/IP属地:(.+)/);
            if (ip_match) {
                return ip_match[1].trim();
            }
        }

        return undefined;
    }

    /**
     * Parse floor index from floor element.
     * Handles both old and new Tieba DOM formats.
     */
    private _parse_floor_index(floor_element: Element): number {
        // Try new format first
        const new_format_tail = floor_element.querySelector('.p_tail');
        if (new_format_tail) {
            const floor_span = new_format_tail.querySelector('span');
            if (floor_span) {
                const text = floor_span.textContent || '';
                const floor_match = text.match(/(\d+)楼/);
                if (floor_match) {
                    return parseInt(floor_match[1]);
                }
            }
        }

        // Try old format
        const tail_info_spans = Array.from(floor_element.querySelectorAll('.tail-info'));
        for (const span of tail_info_spans) {
            const text = span.textContent || '';
            const floor_match = text.match(/(\d+)楼/);
            if (floor_match) {
                return parseInt(floor_match[1]);
            }
        }

        throw new Error('Floor index pattern not found in either old or new format');
    }

    /**
     * Parse sub-comments from floor element.
     * Handles pagination by clicking through all pages.
     */
    private async _parse_sub_comments(floor_element: Element): Promise<Comment[]> {
        const all_sub_comments: Comment[] = [];

        try {
            // Check if this floor has pagination
            const pager = floor_element.querySelector('.j_pager');

            if (!pager) {
                return this._parse_current_sub_comments(floor_element);
            }

            // Check if pager is visible
            const pager_html = pager as HTMLElement;
            if (pager_html.style.display === 'none') {
                return this._parse_current_sub_comments(floor_element);
            }

            // Has pagination - need to click through pages

            let current_page = 1;
            while (true) {
                // Parse current page
                const page_comments = this._parse_current_sub_comments(floor_element);
                all_sub_comments.push(...page_comments);

                // Try to find next page button
                const next_page_link = this._find_next_page_button(floor_element, current_page);
                if (!next_page_link) {
                    break;
                }

                // Click next page
                next_page_link.click();

                // Wait for DOM to update
                await this._wait_for_dom_update();

                current_page++;
            }

        } catch {
            // Fallback to parsing whatever is currently visible
            return this._parse_current_sub_comments(floor_element);
        }

        return all_sub_comments;
    }

    /**
     * Parse sub-comments currently visible in DOM.
     */
    private _parse_current_sub_comments(floor_element: Element): Comment[] {
        const sub_comments: Comment[] = [];
        const sub_comment_elements = floor_element.querySelectorAll('.lzl_single_post, .j_lzl_s_p');

        sub_comment_elements.forEach((sub_element) => {
            try {
                const comment = this._parse_sub_comment(sub_element);
                sub_comments.push(comment);
            } catch {
                // Skip sub-comments that fail to parse
            }
        });

        return sub_comments;
    }

    /**
     * Find next page button for sub-comment pagination.
     */
    private _find_next_page_button(floor_element: Element, current_page: number): HTMLAnchorElement | null {
        const pager = floor_element.querySelector('.j_pager');
        if (!pager) { return null; }

        // Look for page link with index attribute = current_page + 1
        const next_page = current_page + 1;
        const page_links = pager.querySelectorAll<HTMLAnchorElement>(`a[index="${next_page}"]`);

        return page_links.length > 0 ? page_links[0] : null;
    }

    /**
     * Wait for DOM to update after pagination click.
     */
    private async _wait_for_dom_update(): Promise<void> {
        return new Promise(resolve => {
            setTimeout(resolve, 500); // Wait 500ms for DOM update
        });
    }

    /**
     * Parse single sub-comment from DOM element.
     */
    private _parse_sub_comment(sub_element: Element): Comment {
        const author = this._parse_sub_author(sub_element);
        const date = this._parse_sub_date(sub_element);
        const content = this._parse_sub_content(sub_element);
        const avatar_url = this._parse_sub_avatar_url(sub_element);
        const homepage_url = this._parse_sub_homepage_url(sub_element);

        // Parse reply-to information from content
        const reply_info = this._parse_reply_info(content);

        return {
            author,
            date,
            content,
            avatar_url,
            homepage_url,
            reply_to_author: reply_info.author,
            reply_to_homepage_url: reply_info.homepage_url,
        };
    }

    /**
     * Parse sub-comment avatar URL.
     */
    private _parse_sub_avatar_url(sub_element: Element): string | undefined {
        // Look for avatar in the lzl_p_p anchor tag
        const avatar_link = sub_element.querySelector('.lzl_p_p img');
        if (avatar_link) {
            const src = avatar_link.getAttribute('src');
            if (src) {
                // Convert protocol-relative URL to absolute
                if (src.startsWith('//')) {
                    return 'https:' + src;
                }
                return src;
            }
        }

        return undefined;
    }

    /**
     * Parse sub-comment homepage URL.
     */
    private _parse_sub_homepage_url(sub_element: Element): string | undefined {
        // Try the .at.j_user_card link first
        const user_card = sub_element.querySelector('.at.j_user_card');
        if (user_card && user_card.tagName === 'A') {
            const href = user_card.getAttribute('href');
            if (href && href.includes('/home/main')) {
                if (href.startsWith('/')) {
                    return 'https://tieba.baidu.com' + href;
                }
                return href;
            }
        }

        // Fallback: any link with /home/main
        const home_link = sub_element.querySelector('a[href*="/home/main"]');
        if (home_link) {
            const href = home_link.getAttribute('href');
            if (href) {
                if (href.startsWith('/')) {
                    return 'https://tieba.baidu.com' + href;
                }
                return href;
            }
        }

        return undefined;
    }

    /**
     * Parse reply-to information from sub-comment content.
     * Returns the author and homepage URL if this is a reply to another user.
     */
    private _parse_reply_info(content: string): { author?: string, homepage_url?: string } {
        // Pattern: 回复 <a href="...">username</a> : content
        const reply_pattern = /回复\s+<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*:/;
        const match = content.match(reply_pattern);

        if (match) {
            let href = match[1];
            const author = match[2];

            // Convert relative URL to absolute
            if (href.startsWith('/')) {
                href = 'https://tieba.baidu.com' + href;
            }

            return { author, homepage_url: href };
        }

        return {};
    }

    /**
     * Parse sub-comment author name.
     */
    private _parse_sub_author(sub_element: Element): string {
        // Try to get from data-field first (in the .at or .j_user_card element)
        const user_card = sub_element.querySelector('.at.j_user_card, .j_user_card');
        if (user_card) {
            const data_field = user_card.getAttribute('data-field');
            if (data_field) {
                try {
                    const parsed = JSON.parse(data_field.replace(/'/g, '"'));
                    if (parsed.showname) {
                        return parsed.showname;
                    }
                } catch {
                    // Fall through to text content method
                }
            }

            // Fallback to text content
            const text = user_card.textContent?.trim();
            if (text) {
                return text;
            }
        }

        // Last resort: try to find username in data-lzl-author attribute
        const author_span = sub_element.querySelector('[data-lzl-author]');
        if (author_span) {
            const username = author_span.getAttribute('data-lzl-author');
            if (username) {
                return username;
            }
        }

        // Ultimate fallback: look for any element with username attribute
        const any_user = sub_element.querySelector('[username]');
        if (any_user) {
            const username = any_user.getAttribute('username');
            if (username) {
                return username;
            }
        }

        return 'Unknown';
    }

    /**
     * Parse sub-comment date.
     * Format: "2026-3-28 11:02" (no zero-padding)
     */
    private _parse_sub_date(sub_element: Element): string {
        const time_element = sub_element.querySelector('.lzl_time');
        if (!time_element) {
            throw new Error('Sub-comment date not found');
        }

        // Replace &nbsp; with regular space
        const text = (time_element.textContent || '').replace(/\u00a0/, ' ');
        return text.trim();
    }

    /**
     * Parse sub-comment content.
     */
    private _parse_sub_content(sub_element: Element): string {
        const content_element = sub_element.querySelector('.lzl_content_main');
        if (!content_element) {
            throw new Error('Sub-comment content not found');
        }
        return content_element.innerHTML.trim();
    }
}
