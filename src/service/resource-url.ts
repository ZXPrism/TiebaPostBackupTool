export function allowed_url(value: string): boolean {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && !url.port && ['baidu.com', 'bdimg.com', 'bdstatic.com', 'bcebos.com', 'baidustatic.com']
                .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    } catch { return false; }
}

