import type { Page, Response } from 'playwright';

const title_selector = '.core_title_txt';
const floor_selector = '.l_post.l_post_bright';
const modern_selector = '.pc-pb-title .pb-title, .pc-pb-comments';

function check_response(page: Page, response: Response | null): number {
    const location = page.url();
    if (!response) { throw new Error(`导航未返回主文档 HTTP 响应。页面：${location}`); }
    const status = response.status();
    if (status >= 400) {
        throw new Error(`帖子页面返回 HTTP ${status} ${response.statusText()}。页面：${location}`);
    }
    return status;
}

/** State only what the HTTP response and DOM establish; do not infer login failures. */
async function page_layout(page: Page, status: number, timeout: number): Promise<'legacy' | 'modern'> {
    try {
        await page.waitForFunction(({ title, floors, modern }) => {
            return Boolean(document.querySelector(modern))
                || Boolean(document.querySelector(title) && document.querySelector(floors));
        }, { title: title_selector, floors: floor_selector, modern: modern_selector }, { timeout });
    } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TimeoutError') { throw error; }
        const found = await page.evaluate(({ title, floors }) => ({
            title: Boolean(document.querySelector(title)),
            floors: Boolean(document.querySelector(floors)),
        }), { title: title_selector, floors: floor_selector });
        const missing = [!found.title && title_selector, !found.floors && floor_selector].filter(Boolean).join('、');
        throw new Error(`HTTP ${status}，等待旧版页面结构 ${timeout / 1000} 秒后仍缺少 ${missing}。页面：${page.url()}`, { cause: error });
    }
    return await page.locator(modern_selector).count() ? 'modern' : 'legacy';
}

/** The service prepares its own browser; its users never have to choose a Tieba UI version. */
export async function prepare_post_page(page: Page, response: Response | null, timeout = 30000): Promise<void> {
    const status = check_response(page, response);
    if (await page_layout(page, status, timeout) === 'legacy') { return; }

    // This is the endpoint used by Tieba's own “回旧版” action.
    const result = await page.evaluate(async () => {
        const response = await fetch('/c/s/pc/updateSwitch?status=0&_client_type=20', {
            credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        return { status: response.status, body: await response.text() };
    });
    if (result.status !== 200) {
        throw new Error(`贴吧后端页面配置请求失败：HTTP ${result.status}，接口 /c/s/pc/updateSwitch`);
    }
    let data: { error_code?: unknown; error_msg?: unknown };
    try { data = JSON.parse(result.body); }
    catch (error) { throw new Error('贴吧后端页面配置接口返回 HTTP 200，但响应不是 JSON', { cause: error }); }
    if (!data || ![0, '0'].includes(data.error_code as string | number)) {
        throw new Error(`贴吧后端页面配置请求被拒绝：error_code=${String(data?.error_code)}${typeof data?.error_msg === 'string' ? `，${data.error_msg}` : ''}`);
    }
    const reloaded = await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    const reload_status = check_response(page, reloaded);
    if (await page_layout(page, reload_status, timeout) !== 'legacy') {
        throw new Error('后端无法取得可解析的帖子内容：贴吧配置接口已返回成功，但重新加载后的页面结构仍不受支持');
    }
}
