import { load_cookie } from './session';

export interface HttpResponse {
    status(): number;
    ok(): boolean;
    headers(): Record<string, string>;
    text(): Promise<string>;
    body(): Promise<Buffer>;
    dispose(): Promise<void>;
}
interface Options { headers?: Record<string, string>; form?: Record<string, string>; timeout?: number }
export interface HttpClient {
    post(url: string, options: Options): Promise<HttpResponse>;
    get(url: string, options: Options): Promise<HttpResponse>;
}
export interface HttpSession { request: HttpClient; close(): Promise<void> }

/** Cookie is scoped to Tieba, never forwarded to image hosts or redirects. */
export async function open_http_session(signal: AbortSignal, send: typeof fetch = fetch): Promise<HttpSession> {
    const cookie = await load_cookie();
    const controller = new AbortController();
    const request = async (url: string, options: Options, method: string): Promise<HttpResponse> => {
        const target = new URL(url);
        const headers = new Headers(options.headers);
        headers.set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
        if (target.origin === 'https://tieba.baidu.com') { headers.set('Cookie', cookie); }
        let response: Response;
        try {
            response = await send(url, { method, headers, redirect: 'manual',
                body: options.form ? new URLSearchParams(options.form) : undefined,
                signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(options.timeout ?? 30000)]) });
        } catch (error) {
            signal.throwIfAborted();
            // Keep only known transport codes; never retain an exception containing request headers.
            const cause = error instanceof Error ? error.cause : undefined;
            const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
            const reasons: Record<string, string> = { ENOTFOUND: 'DNS 解析失败', EAI_AGAIN: 'DNS 暂时不可用',
                ECONNREFUSED: '连接被拒绝', ECONNRESET: '连接被重置', ETIMEDOUT: '连接超时',
                UND_ERR_CONNECT_TIMEOUT: '连接超时', CERT_HAS_EXPIRED: 'TLS 证书已过期' };
            throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'HTTP 请求超时'
                : `HTTP 网络连接失败${reasons[code] ? `：${reasons[code]}` : ''}`,
            // eslint-disable-next-line preserve-caught-error -- Only sanitized diagnostics may enter persistent job logs.
            { cause: new Error(reasons[code] || '传输失败（原始错误已隐去，避免记录会话信息）') });
        }
        const response_headers: Record<string, string> = {};
        response.headers.forEach((value, name) => { response_headers[name] = value; });
        return { status: () => response.status, ok: () => response.ok,
            headers: () => response_headers, text: () => response.text(),
            body: async () => Buffer.from(await response.arrayBuffer()),
            dispose: async () => { if (!response.bodyUsed) { await response.body?.cancel(); } },
        };
    };
    return { request: { post: (url, options) => request(url, options, 'POST'), get: (url, options) => request(url, options, 'GET') },
        close: async () => { controller.abort(); } };
}
