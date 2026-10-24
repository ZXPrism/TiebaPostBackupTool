import type { Comment, Post } from './types';

function author_identity(comment: Comment): string {
    try {
        const params = new URL(comment.homepage_url || '').searchParams;
        const id = params.get('id')?.split('?')[0];
        if (id) { return `id:${id}`; }
        if (params.get('un')) { return `un:${params.get('un')}`; }
    } catch { /* Older backups may only contain display names. */ }
    return `name:${comment.author}`;
}

/**
 * Create viewer HTML file.
 */
export function create_viewer_html(post: Post, backup_date = new Date(post.backup_date ?? Date.now())): string {
    const owner = post.floor_list.find(floor => floor.index === 1)?.comment;
    const owner_floor_indexes = owner ? post.floor_list.filter(floor => author_identity(floor.comment) === author_identity(owner))
        .map(floor => floor.index) : [];
    const json_data = JSON.stringify({ floor_list: post.floor_list, owner_floor_indexes }).replace(/</g, '\\u003c');
    const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
    const post_url = `https://tieba.baidu.com/p/${post.id}`;
    const formatted_date = backup_date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });

    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escape(post.title)} - Tieba Backup</title>
    <style>
        :root { color-scheme: light; --page: #f5f5f5; --surface: #fff; --reply: #f9f9f9; --text: #222; --heading: #333; --muted: #666; --subtle: #888; --border: #bbb; --divider: #e0e0e0; --link: #0055cc; }
        :root[data-theme="dark"] { color-scheme: dark; --page: #151515; --surface: #222; --reply: #2b2b2b; --text: #e6e6e6; --heading: #f0f0f0; --muted: #b5b5b5; --subtle: #aaa; --border: #666; --divider: #444; --link: #8ab4f8; }
        @media (prefers-color-scheme: dark) {
            :root[data-theme="auto"] { color-scheme: dark; --page: #151515; --surface: #222; --reply: #2b2b2b; --text: #e6e6e6; --heading: #f0f0f0; --muted: #b5b5b5; --subtle: #aaa; --border: #666; --divider: #444; --link: #8ab4f8; }
        }
        .theme-toggle { position: absolute; top: 14px; right: 14px; display: grid; place-items: center; width: 36px; height: 36px; padding: 6px; border: 0; border-radius: 4px; background: transparent; color: var(--text); cursor: pointer; }
        .theme-toggle:hover { background: var(--reply); }
        .theme-toggle:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
        .theme-toggle svg { display: none; fill: currentColor; }
        :root[data-theme="auto"] .theme-auto, :root[data-theme="light"] .theme-light, :root[data-theme="dark"] .theme-dark { display: block; }

        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: var(--page);
            color: var(--text);
        }
        .header {
            position: relative;
            background: var(--surface);
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .header h1 {
            padding-right: 38px;
            overflow-wrap: anywhere;
            margin: 0 0 10px 0;
            color: var(--heading);
        }
        .header .meta {
            color: var(--muted);
            font-size: 14px;
        }
        .header .backup-date {
            display: block;
            margin-bottom: 10px;
            color: var(--subtle);
            font-size: 12px;
        }
        .header .original-post {
            margin-bottom: 10px;
            overflow-wrap: anywhere;
        }
        .header .view-options { margin-top: 12px; }
        .owner-toggle { padding: 6px 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface); color: var(--text); cursor: pointer; }
        .owner-toggle[aria-pressed="true"] { background: var(--text); color: var(--surface); }
        .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
        .pagination button, .pagination input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface); color: var(--text); }
        .pagination button:disabled { color: var(--subtle); }
        .pagination input { width: 65px; }
        .pagination label { font-size: 14px; color: var(--muted); }
        .floor {
            background: var(--surface);
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .floor .author {
            font-weight: bold;
            color: var(--link);
        }
        .floor .date {
            color: var(--subtle);
            font-size: 12px;
            margin-left: 10px;
        }
        .floor .ip {
            color: var(--subtle);
            font-size: 12px;
            margin-left: 10px;
        }
        .floor .content {
            margin: 10px 0;
            line-height: 1.6;
        }
        .floor .content img {
            max-width: 100%;
            height: auto;
        }
        .floor .avatar {
            width: 50px;
            height: 50px;
            border-radius: 4px;
            margin-right: 10px;
            vertical-align: middle;
            object-fit: cover;
        }
        .floor .avatar[alt] {
            display: inline-block;
        }
        .floor .floor-index {
            color: var(--subtle);
            font-size: 12px;
            margin-bottom: 5px;
        }
        .floor .author-line {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
        }
        .sub-comments {
            margin-left: 20px;
            padding-left: 15px;
            border-left: 2px solid var(--divider);
            margin-top: 10px;
        }
        .sub-comment {
            margin: 8px 0;
            padding: 8px;
            background: var(--reply);
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sub-comment .content {
            flex: 1;
        }
        .sub-comment .author {
            font-size: 12px;
        }
        .sub-comment .date {
            font-size: 11px;
        }
        .sub-comment .sub-avatar {
            width: 30px;
            height: 30px;
            border-radius: 3px;
            margin-right: 8px;
            vertical-align: middle;
            object-fit: cover;
        }
        .author-link {
            color: var(--link);
            text-decoration: none;
            font-weight: bold;
        }
        .author-link:hover {
            text-decoration: underline;
        }
        .reply-to {
            color: var(--muted);
            font-size: 12px;
        }
        .reply-to a {
            color: var(--link);
            text-decoration: none;
        }
        .reply-to a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <!-- Material Icons by Google, Apache-2.0: https://github.com/google/material-design-icons -->
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="当前：自动（跟随系统）；切换到白天" title="自动（跟随系统） · 切换到白天">
            <svg class="theme-light" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24"><path d="M0 0h24v24H0z" fill="none"/><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>
            <svg class="theme-dark" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24"><path d="M0 0h24v24H0z" fill="none"/><path d="M10 2c-1.82 0-3.53.5-5 1.35C7.99 5.08 10 8.3 10 12s-2.01 6.92-5 8.65C6.47 21.5 8.18 22 10 22c5.52 0 10-4.48 10-10S15.52 2 10 2z"/></svg>
            <svg class="theme-auto" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24"><path d="M0 0h24v24H0z" fill="none"/><path d="M10.85 12.65h2.3L12 9l-1.15 3.65zM20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM14.3 16l-.7-2h-3.2l-.7 2H7.8L11 7h2l3.2 9h-1.9z"/></svg>
        </button>
        <h1>${escape(post.title)}</h1>
        <time class="backup-date" datetime="${backup_date.toISOString()}">备份日期：${escape(formatted_date)}（UTC+8）</time>
        <div class="meta original-post">原贴：<a class="author-link" href="${escape(post_url)}" target="_blank" rel="noopener noreferrer">${escape(post_url)}</a></div>
        <div class="meta">
            贴吧: <a class="author-link" href="${escape(post.tieba_url)}" target="_blank">${escape(post.tieba_name)}</a> |
            楼层: ${post.floor_list.length} |
            回复: ${post.comment_cnt}
        </div>
        <div class="view-options"><button id="owner-toggle" class="owner-toggle" type="button" aria-pressed="false">只看楼主</button></div>
    </div>
    <nav class="pagination" aria-label="顶部翻页">
        <button type="button" data-step="-1">上一页</button>
        <span class="page-status" aria-live="polite"></span>
        <button type="button" data-step="1">下一页</button>
        <label>跳至第 <input class="page-number" type="number" min="1" value="1" aria-label="页码"> 页</label>
        <button type="button" data-jump>跳转</button>
    </nav>
    <div id="content"></div>
    <nav class="pagination" aria-label="底部翻页">
        <button type="button" data-step="-1">上一页</button>
        <span class="page-status" aria-live="polite"></span>
        <button type="button" data-step="1">下一页</button>
    </nav>

    <script>
        const themeButton = document.getElementById('theme-toggle');
        const themes = ['auto', 'light', 'dark'];
        const themeNames = { auto: '自动（跟随系统）', light: '白天', dark: '黑夜' };
        themeButton.addEventListener('click', () => {
            const current = document.documentElement.dataset.theme;
            const next = themes[(themes.indexOf(current) + 1) % themes.length];
            const following = themes[(themes.indexOf(next) + 1) % themes.length];
            document.documentElement.dataset.theme = next;
            themeButton.title = themeNames[next] + ' · 切换到' + themeNames[following];
            themeButton.setAttribute('aria-label', '当前：' + themeNames[next] + '；切换到' + themeNames[following]);
        });
        try {
            const post = ${json_data};

            function escapeText(value) {
                const span = document.createElement('span');
                span.textContent = String(value ?? '');
                return span.innerHTML.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
            }

            function safeUrl(value) {
                try {
                    const url = new URL(value);
                    return ['https:', 'http:'].includes(url.protocol) ? url.href : '#';
                } catch { return '#'; }
            }

            function safeLink(value) { return escapeText(safeUrl(value)); }

            function safeContent(value) {
                const template = document.createElement('template');
                template.innerHTML = value;
                template.content.querySelectorAll('script,iframe,object,embed,svg,math,style,link,meta,base,form,input,button,textarea').forEach(el => el.remove());
                template.content.querySelectorAll('*').forEach(el => {
                    for (const attribute of Array.from(el.attributes)) {
                        if (!['href', 'src', 'alt', 'title', 'width', 'height'].includes(attribute.name)) {
                            el.removeAttribute(attribute.name);
                        }
                    }
                    if (el.hasAttribute('href')) { el.setAttribute('href', safeUrl(el.getAttribute('href'))); }
                    if (el.hasAttribute('src')) {
                        const src = el.getAttribute('src');
                        if (!src.startsWith('./images/') || src.includes('..', 2)) { el.removeAttribute('src'); }
                    }
                });
                template.content.querySelectorAll('img').forEach(img => {
                    img.setAttribute('loading', 'lazy');
                    img.setAttribute('decoding', 'async');
                });
                return template.innerHTML;
            }

            function renderFloor(floor) {
            let html = '<div class="floor">';

            // Floor index
            html += '<div class="floor-index">' + escapeText(floor.index) + '楼</div>';

            // Author with avatar
            html += '<div class="author-line">';
            if (floor.comment.avatar_url) {
                html += '<img class="avatar" loading="lazy" decoding="async" width="50" height="50" src="./images/' + escapeText(floor.comment.avatar_url) + '" alt="">';
            }
            // Author as link if homepage exists
            if (floor.comment.homepage_url) {
                html += '<a class="author-link" href="' + safeLink(floor.comment.homepage_url) + '" target="_blank">' + escapeText(floor.comment.author) + '</a>';
            } else {
                html += '<span class="author">' + escapeText(floor.comment.author) + '</span>';
            }
            html += '<span class="date">' + escapeText(floor.comment.date) + '</span>';
            if (floor.comment.ip_location) {
                html += '<span class="ip">来自: ' + escapeText(floor.comment.ip_location) + '</span>';
            }
            html += '</div>';

            // Content
            html += '<div class="content">' + safeContent(floor.comment.content) + '</div>';

            // Sub-comments
            if (floor.sub_comment_list && floor.sub_comment_list.length > 0) {
                html += '<div class="sub-comments">';
                floor.sub_comment_list.forEach(sub => {
                    html += renderSubComment(sub);
                });
                html += '</div>';
            }

            html += '</div>';
            return html;
        }

        function renderSubComment(comment) {
            let html = '<div class="sub-comment">';

            // Avatar
            if (comment.avatar_url) {
                html += '<img class="sub-avatar" loading="lazy" decoding="async" width="30" height="30" src="./images/' + escapeText(comment.avatar_url) + '" alt="">';
            }

            // Debug logging
            if (!comment.author || comment.author === 'Unknown') {
            }

            // Author with fallback for missing names, as link if homepage exists
            const author_name = comment.author || '未知用户';
            if (comment.homepage_url) {
                html += '<a class="author-link" href="' + safeLink(comment.homepage_url) + '" target="_blank">' + escapeText(author_name) + '</a>';
            } else {
                html += '<span class="author">' + escapeText(author_name) + '</span>';
            }
            html += '<span class="date">' + escapeText(comment.date) + '</span>';

            // Content with reply-to filtering
            let content = comment.content;
            // Remove the original "回复 <a>username</a>" pattern since we'll render it separately
            // Use string methods instead of regex to avoid escaping issues
            const replyIndex = content.indexOf('回复');
            if (replyIndex !== -1) {
                // Find the closing </a> and the colon after it
                const anchorEnd = content.indexOf('</a>', replyIndex);
                if (anchorEnd !== -1) {
                    const colonIndex = content.indexOf(':', anchorEnd);
                    if (colonIndex !== -1 && colonIndex < anchorEnd + 10) {
                        // Remove everything from "回复" to the colon
                        content = content.substring(0, replyIndex) + content.substring(colonIndex + 1);
                    }
                }
            }
            html += '<div class="content">' + safeContent(content) + '</div>';

            // Reply-to information
            if (comment.reply_to_author) {
                html += '<div class="reply-to">回复 ';
                if (comment.reply_to_homepage_url) {
                    html += '<a href="' + safeLink(comment.reply_to_homepage_url) + '" target="_blank">' + escapeText(comment.reply_to_author) + '</a>';
                } else {
                    html += escapeText(comment.reply_to_author);
                }
                html += '</div>';
            }

            html += '</div>';
            return html;
        }

        const contentDiv = document.getElementById('content');
        const pageSize = 30;
        const ownerIndexes = new Set(post.owner_floor_indexes);
        const ownerFloors = post.floor_list.filter(floor => ownerIndexes.has(floor.index));
        const ownerButton = document.getElementById('owner-toggle');
        let ownerOnly = false;
        let visibleFloors = post.floor_list;
        let pageCount = Math.max(1, Math.ceil(visibleFloors.length / pageSize));
        let page = 0;
        ownerButton.addEventListener('click', () => {
            ownerOnly = !ownerOnly;
            ownerButton.textContent = ownerOnly ? '取消只看楼主' : '只看楼主';
            ownerButton.setAttribute('aria-pressed', String(ownerOnly));
            visibleFloors = ownerOnly ? ownerFloors : post.floor_list;
            pageCount = Math.max(1, Math.ceil(visibleFloors.length / pageSize));
            renderPage(0, false);
        });
        function renderPage(nextPage, scroll = true) {
            page = Math.max(0, Math.min(pageCount - 1, nextPage));
            const floors = visibleFloors.slice(page * pageSize, (page + 1) * pageSize);
            contentDiv.innerHTML = floors.map(renderFloor).join('');
            const range = floors.length ? ' · ' + floors[0].index + '–' + floors[floors.length - 1].index + ' 楼' : '';
            document.querySelectorAll('.page-status').forEach(el => {
                el.textContent = (page + 1) + ' / ' + pageCount + ' 页' + range;
            });
            document.querySelectorAll('[data-step]').forEach(button => {
                button.disabled = Number(button.dataset.step) < 0 ? page === 0 : page === pageCount - 1;
            });
            const input = document.querySelector('.page-number');
            input.max = String(pageCount);
            input.value = String(page + 1);
            if (scroll) { window.scrollTo({ top: 0, behavior: 'instant' }); }
        }
        document.querySelectorAll('[data-step]').forEach(button => {
            button.addEventListener('click', () => renderPage(page + Number(button.dataset.step)));
        });
        function jump() {
            const value = Number(document.querySelector('.page-number').value);
            if (Number.isInteger(value) && value >= 1 && value <= pageCount) { renderPage(value - 1); }
        }
        document.querySelector('[data-jump]').addEventListener('click', jump);
        document.querySelector('.page-number').addEventListener('keydown', event => {
            if (event.key === 'Enter') { jump(); }
        });
        renderPage(0, false);
        } catch (error) {
            document.getElementById('content').innerHTML = '<p style="color: red; padding: 20px;">Error rendering post: ' + escapeText(error.message) + '</p>';
        }
    </script>
</body>
</html>`;
}

