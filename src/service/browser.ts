import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';
import { profile_dir } from './config';

export async function open_browser(headless = true): Promise<BrowserContext> {
    await mkdir(profile_dir, { recursive: true, mode: 0o700 });
    return chromium.launchPersistentContext(profile_dir, {
        headless,
        viewport: { width: 1440, height: 1000 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        serviceWorkers: 'block',
        acceptDownloads: false,
    });
}

export function allowed_url(value: string): boolean {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && !url.port && ['baidu.com', 'bdimg.com', 'bdstatic.com', 'bcebos.com', 'baidustatic.com']
                .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    } catch { return false; }
}

export async function restrict_browser(context: BrowserContext): Promise<void> {
    await context.route('**/*', route => {
        return allowed_url(route.request().url()) ? route.fallback() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
}

export async function has_session(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies('https://tieba.baidu.com');
    return cookies.some(cookie => cookie.name === 'BDUSS' && cookie.value
        && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
}
