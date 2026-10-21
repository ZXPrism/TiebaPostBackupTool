export function validate_cookie(value: string): string {
    if (!value || /[^\x20-\x7e]/.test(value) || !value.split(';').some(pair => /^\s*BDUSS=[^;\s]+\s*$/.test(pair))) {
        throw new Error('登录 Cookie 无效：需要包含非空 BDUSS，且不能包含换行或非 ASCII 字符');
    }
    return value;
}
export async function load_cookie(): Promise<string> {
    if (process.env.TIEBA_COOKIE === undefined) { throw new Error('未设置 TIEBA_COOKIE 环境变量'); }
    return validate_cookie(process.env.TIEBA_COOKIE);
}
