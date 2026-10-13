import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { open_browser, has_session } from '../src/service/browser';

const importing = process.argv[2] === '--import';
const import_path = importing ? process.argv[3] : undefined;
if (importing && !import_path) { throw new Error('用法: npm run login:import -- /path/to/cookies.json'); }
const context = await open_browser(Boolean(import_path));
try {
    if (import_path) {
        // Accept a Playwright storageState file or a JSON cookie array. Never log its contents.
        const data = JSON.parse(await readFile(import_path, 'utf8'));
        const cookies: unknown = Array.isArray(data) ? data : data.cookies;
        if (!Array.isArray(cookies) || !cookies.length) { throw new Error('文件中没有 Cookie 数组'); }
        const normalized = cookies.map(cookie => {
            if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
                || typeof cookie.domain !== 'string'
                || !/(^|\.)baidu\.com$/.test(cookie.domain)) {
                throw new Error('Cookie 必须含 name、value、domain，且属于 baidu.com');
            }
            return {
                name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/',
                expires: cookie.expires ?? cookie.expirationDate ?? -1,
                httpOnly: Boolean(cookie.httpOnly), secure: Boolean(cookie.secure),
                sameSite: (['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'Lax') as 'Strict' | 'Lax' | 'None',
            };
        });
        await context.addCookies(normalized);
    } else {
        const page = context.pages()[0] || await context.newPage();
        await page.goto('https://tieba.baidu.com', { waitUntil: 'domcontentloaded' });
        const input = createInterface({ input: stdin, output: stdout });
        try { await input.question('请在打开的专用浏览器中登录百度，完成后回到此终端按 Enter 保存：'); }
        finally { input.close(); }
    }
    if (!await has_session(context)) { throw new Error('未检测到有效的 BDUSS Cookie，登录状态未就绪'); }
    console.log('登录 Cookie 已保存到专用浏览器配置目录。后续采集默认使用 headless 模式。');
} finally { await context.close(); }
