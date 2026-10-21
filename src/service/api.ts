import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HttpClient } from './transport';
import type { ApiRequest } from '../shared/api-collector';
import type { Log } from './logging';

/** A serial queue with a minimum start interval. Content and image starts use separate instances. */
export class RequestPacer {
    private tail: Promise<unknown> = Promise.resolve();
    private last_start = -Infinity;

    constructor(
        private readonly interval_ms: number,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); },
    ) {}

    run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
        const result = this.tail.then(async () => {
            signal.throwIfAborted();
            const wait = this.last_start + this.interval_ms - this.now();
            if (wait > 0) { await this.sleep(wait, signal); }
            signal.throwIfAborted();
            this.last_start = this.now();
            return operation();
        });
        this.tail = result.catch(() => undefined);
        return result;
    }
}

/** Same form/signature format as the PC site's own HTTP client. */
export function sign_form(parameters: Record<string, string>): Record<string, string> {
    const form = { ...parameters, tbs: '', subapp_type: 'pc', _client_type: '20' };
    const signature = Object.entries(form).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`).join('') + '36770b1f34c9bbf2e7d1a99d2b82fa9e';
    return { ...form, sign: createHash('md5').update(signature).digest('hex') };
}

export class PostUnavailableError extends Error {}

class RetryableApiError extends Error {
    constructor(message: string, readonly retry_after_ms = 0) { super(message); }
}

function retry_after(value: string | undefined): number {
    if (!value) { return 0; }
    const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

export function create_api_request(context: HttpClient, post_url: string, pacer: RequestPacer, signal: AbortSignal, log?: Log): ApiRequest {
    const attempt: ApiRequest = async (path, parameters) => {
        const transport_error = (error: unknown): never => {
            signal.throwIfAborted();
            // Keep transport diagnostics concise; never include request headers.
            const detail = error instanceof Error ? error.message.split('\n')[0] : '未知传输错误';
            throw new RetryableApiError(`${path}: 请求失败，${detail}`);
        };
        const response = await context.post(`https://tieba.baidu.com${path}`, {
            form: sign_form(parameters),
            headers: { Referer: post_url, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 30000,
        }).catch(transport_error);
        try {
            signal.throwIfAborted();
            if ([408, 429, 500, 502, 503, 504].includes(response.status())) {
                throw new RetryableApiError(`${path}: HTTP ${response.status()}`, retry_after(response.headers()['retry-after']));
            }
            if (response.status() !== 200) { throw new Error(`${path}: HTTP ${response.status()}`); }
            const body = await response.text().catch(transport_error);
            signal.throwIfAborted();
            let value: unknown;
            try { value = JSON.parse(body); }
            catch {
                const captcha = /<title[^>]*>\s*百度安全验证\s*<\/title>/.test(body);
                throw new Error(`${path}: ${captcha ? '返回百度安全验证页面' : '响应不是 JSON'}`);
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${path}: JSON 响应应为对象`); }
            const result = value as Record<string, unknown>;
            if (result.error_code === undefined) { throw new Error(`${path}: 响应缺少 error_code`); }
            if (result.error_code !== 0 && result.error_code !== '0') {
                const message = `${path}: error_code=${String(result.error_code)}${typeof result.error_msg === 'string' ? `，${result.error_msg}` : ''}`;
                if (path === '/c/f/pb/page_pc' && String(result.error_code) === '4') { throw new PostUnavailableError(message); }
                throw new Error(message);
            }
            return result.data ?? result;
        } finally { await response.dispose(); }
    };
    return async (path, parameters) => {
        for (let retries = 0; ; retries++) {
            try {
                // Every attempt uses the shared pacer; the transport does not retry.
                return await pacer.run(async () => {
                    // Start the request immediately at the paced boundary; disk writes must not shift it.
                    const [result] = await Promise.all([
                        attempt(path, parameters), log?.('debug', 'api_request', { path, attempt: retries + 1 }),
                    ]);
                    await log?.('debug', 'api_response', { path, attempt: retries + 1 });
                    return result;
                }, signal);
            } catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof RetryableApiError)) { throw error; }
                if (retries === 3) { throw new Error(`${error.message}（已重试 3 次，共 4 次请求）`, { cause: error }); }
                await log?.('warn', 'api_retry', { path, retry: retries + 1, retry_after_ms: error.retry_after_ms, error });
                // A server-requested delay is additional to the pacer's minimum start interval.
                let wait = error.retry_after_ms;
                while (wait > 0) {
                    const chunk = Math.min(wait, 2147483647);
                    await delay(chunk, undefined, { signal });
                    wait -= chunk;
                }
            }
        }
    };
}
