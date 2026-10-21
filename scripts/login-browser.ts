import { mkdir } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import { join } from 'node:path';
import { data_dir } from '../src/service/config';

const profile_dir = join(data_dir, 'browser');

export async function open_browser(headless = true): Promise<BrowserContext> {
    const { chromium } = await import('playwright');
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

export async function has_session(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies('https://tieba.baidu.com');
    return cookies.some(cookie => cookie.name === 'BDUSS' && cookie.value
        && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
}
