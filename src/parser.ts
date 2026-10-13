import { Post, ParseState } from './types';
import { PageParser } from './shared/page-parser';
import { finalize_post } from './shared/post';
import { ImageHandler } from './image_handler';

export class Parser {
    private page_parser = new PageParser();
    private image_handler: ImageHandler;
    private base_url: string;
    private current_page: number;
    private warnings: string[] = [];

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
        if (state.post_id !== Number(window.location.pathname.match(/\/p\/(\d+)/)?.[1])) {
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

    public get_warnings(): string[] { return [...this.warnings]; }

    /**
     * Parse the complete post from current page DOM.
     * Automatically loads all content before parsing.
     * Handles multi-page posts with state persistence.
     */
    public async parse_post(): Promise<Post> {
        const post_id = Number(window.location.pathname.match(/\/p\/(\d+)/)?.[1]);

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
        const post_id = Number(window.location.pathname.match(/\/p\/(\d+)/)?.[1]);
        const page_cnt = this.page_parser.metadata().page_cnt;


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
        const page_floors = await this.page_parser.parse_current_page();
        state.warnings = [...(state.warnings || []), ...this.page_parser.warnings];
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

        if (state.current_page > state.total_pages) { return this._finalize_parse(state); }
        if (state.current_page !== this.current_page) {
            this._navigate_to_page(state.current_page);
            throw new Error('NAVIGATING');
        }

        // Parse current page
        const page_floors = await this.page_parser.parse_current_page();
        state.warnings = [...(state.warnings || []), ...this.page_parser.warnings];
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

        const post = finalize_post({
            ...this.page_parser.metadata(),
            id: state.post_id,
            page_cnt: state.total_pages,
        }, state.collected_floors, this.image_handler);
        this.warnings = state.warnings || [];
        if (this.warnings.length) {
            console.warn('备份解析警告', this.warnings);
        }

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

}
