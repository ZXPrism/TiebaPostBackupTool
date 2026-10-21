import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { data_dir } from './config';

export const session_path = join(data_dir, 'session.json');
interface SessionCookie { name: string; value: string; expires: number }
export function validate_cookie(value: string): string {
    if (!value || /[^\x20-\x7e]/.test(value) || !value.split(';').some(pair => /^\s*BDUSS=[^;\s]+\s*$/.test(pair))) {
        throw new Error('登录 Cookie 无效：需要包含非空 BDUSS，且不能包含换行或非 ASCII 字符');
    }
    return value;
}
export async function load_cookie(path = session_path): Promise<string> {
    if (process.env.TIEBA_COOKIE !== undefined) { return validate_cookie(process.env.TIEBA_COOKIE); }
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('未找到独立登录会话：请设置 TIEBA_COOKIE 环境变量', { cause: error });
        }
        throw new Error('读取独立登录会话文件失败', { cause: error });
    }
    let cookies: SessionCookie[];
    try { cookies = JSON.parse(text); }
    catch { throw new Error('独立登录会话不是有效 JSON，请检查会话文件或设置 TIEBA_COOKIE'); }
    if (!Array.isArray(cookies) || cookies.some(cookie => !cookie || typeof cookie.name !== 'string'
        || typeof cookie.value !== 'string' || typeof cookie.expires !== 'number'
        || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[;\r\n]/.test(cookie.value))) { throw new Error('独立登录会话格式无效，请检查会话文件或设置 TIEBA_COOKIE'); }
    return validate_cookie(cookies.filter(cookie => cookie.expires === -1 || cookie.expires > Date.now() / 1000)
        .map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
}
export async function save_session(cookies: SessionCookie[], path = session_path): Promise<void> {
    validate_cookie(cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    await mkdir(data_dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(cookies.map(({ name, value, expires }) => ({ name, value, expires }))), { mode: 0o600 });
    await chmod(path, 0o600);
}
