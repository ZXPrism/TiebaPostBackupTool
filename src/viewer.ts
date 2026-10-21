import type { Post } from './types';

/**
 * Create viewer HTML file.
 */
export function create_viewer_html(post: Post, backup_date = new Date(post.backup_date ?? Date.now())): string {
    const json_data = JSON.stringify({ floor_list: post.floor_list }).replace(/</g, '\\u003c');
    const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
    const post_url = `https://tieba.baidu.com/p/${post.id}`;
    const formatted_date = backup_date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escape(post.title)} - Tieba Backup</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .header h1 {
            margin: 0 0 10px 0;
            color: #333;
        }
        .header .meta {
            color: #666;
            font-size: 14px;
        }
        .header .backup-date {
            display: block;
            margin-bottom: 10px;
            color: #888;
            font-size: 12px;
        }
        .header .original-post {
            margin-bottom: 10px;
            overflow-wrap: anywhere;
        }
        .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
        .pagination button, .pagination input { padding: 6px 10px; border: 1px solid #bbb; border-radius: 3px; background: white; color: #222; }
        .pagination button:disabled { color: #999; }
        .pagination input { width: 65px; }
        .pagination label { font-size: 14px; color: #666; }
        .floor {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .floor .author {
            font-weight: bold;
            color: #0055cc;
        }
        .floor .date {
            color: #999;
            font-size: 12px;
            margin-left: 10px;
        }
        .floor .ip {
            color: #999;
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
            color: #999;
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
            border-left: 2px solid #e0e0e0;
            margin-top: 10px;
        }
        .sub-comment {
            margin: 8px 0;
            padding: 8px;
            background: #f9f9f9;
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
            color: #0055cc;
            text-decoration: none;
            font-weight: bold;
        }
        .author-link:hover {
            text-decoration: underline;
        }
        .reply-to {
            color: #666;
            font-size: 12px;
        }
        .reply-to a {
            color: #0055cc;
            text-decoration: none;
        }
        .reply-to a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${escape(post.title)}</h1>
        <time class="backup-date" datetime="${backup_date.toISOString()}">备份日期：${escape(formatted_date)}（UTC+8）</time>
        <div class="meta original-post">原帖：<a class="author-link" href="${escape(post_url)}" target="_blank" rel="noopener noreferrer">${escape(post_url)}</a></div>
        <div class="meta">
            贴吧: <a class="author-link" href="${escape(post.tieba_url)}" target="_blank">${escape(post.tieba_name)}</a> |
            楼层: ${post.floor_list.length} |
            回复: ${post.comment_cnt}
        </div>
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
        const pageCount = Math.max(1, Math.ceil(post.floor_list.length / pageSize));
        let page = 0;
        function renderPage(nextPage, scroll = true) {
            page = Math.max(0, Math.min(pageCount - 1, nextPage));
            const floors = post.floor_list.slice(page * pageSize, (page + 1) * pageSize);
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

