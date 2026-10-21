import type { ActiveBackup, BackupSummary, PostBackups, Snapshot } from '../shared/service-contract';
import type { ProgressCount } from '../shared/progress';

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) { throw new Error(`Missing element ${id}`); }
    return value as T;
}
const form = element<HTMLFormElement>('backup-form');
const input = element<HTMLInputElement>('post-url');
const start = element<HTMLButtonElement>('start-backup');
const message = element<HTMLParagraphElement>('message');
let selected: PostBackups | undefined;
let generation = 0;
let read_version = 0;
let starting = false;
let last_backups = '';
let submitted_here = false;
let show_failure = false;

function notify(text: string, error = false): void {
    message.textContent = text;
    message.className = error ? 'error' : '';
}

async function api(path: string, options: RequestInit = {}): Promise<Response> {
    let response: Response;
    try { response = await fetch(path, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('暂时无法连接服务，请稍后查询'); }
    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || '暂时无法完成请求，请稍后再试');
    }
    return response;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    result.textContent = text;
    result.className = className;
    return result;
}

function reset_selection(): void {
    generation++;
    selected = undefined;
    starting = false;
    last_backups = '';
    submitted_here = false;
    show_failure = false;
    element('results').hidden = true;
    render_active();
    notify('');
}
input.addEventListener('input', reset_selection);

async function query(value: string, token: number): Promise<void> {
    const version = ++read_version;
    const response = await api(`api/posts?url=${encodeURIComponent(value)}`);
    const result = await response.json() as PostBackups;
    if (token !== generation || version !== read_version) { return; }
    selected = result;
    render(result);
    element('connection').textContent = '';
}

form.addEventListener('submit', event => {
    event.preventDefault();
    reset_selection();
    const token = generation;
    notify('正在查询…');
    void query(input.value, token).then(() => { if (token === generation) { notify(''); } })
        .catch(error => { if (token === generation) { notify(error.message, true); } });
});

start.addEventListener('click', () => {
    if (!selected || selected.active || starting) { return; }
    const post = selected;
    const token = generation;
    starting = true;
    start.disabled = true;
    void api('api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: post.url }) })
        .then(async () => {
            if (token !== generation) { return; }
            submitted_here = true;
            notify('已提交。关闭页面后，可重新输入原链接查询。');
            await query(post.url, token);
        }).catch(error => { if (token === generation) { notify(error.message, true); } })
        .finally(() => {
            if (token === generation) { starting = false; start.disabled = false; }
        });
});

async function download(backup: BackupSummary): Promise<void> {
    const response = await api(`api/jobs/${backup.id}/download`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = backup.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let progress_view: {
    heading: HTMLHeadingElement;
    estimate: HTMLParagraphElement;
    bars: { label: HTMLSpanElement; detail: HTMLSpanElement; bar: HTMLProgressElement; fill: HTMLSpanElement }[];
} | undefined;

function render_active(active?: ActiveBackup): void {
    const container = element('active-backup');
    container.hidden = !active;
    if (!active) {
        container.replaceChildren();
        progress_view = undefined;
        return;
    }
    // No progress bars until the first page has actually been collected.
    if (active.phase === 'floors' && !active.progress?.current) {
        container.replaceChildren(node('h3', active.status === 'queued' ? '已进入队列，等待备份' : '正在检查贴子…'));
        progress_view = undefined;
        return;
    }
    // Keep the same elements between polls so the fill can transition from its current position.
    if (!progress_view) {
        container.replaceChildren();
        const heading = node('h3');
        container.append(heading, node('p', '关闭页面不会中断备份，稍后输入同一链接即可继续查看进度。', 'hint'));
        const bars = ['总进度', '当前阶段'].map(text => {
            const group = node('div', '', 'collection-progress');
            const caption = node('div', '', 'progress-caption');
            const detail = node('span');
            const label = node('span', text);
            caption.append(label, detail);
            const track = node('div', '', 'progress-track');
            const bar = node('progress');
            bar.setAttribute('aria-label', text);
            const fill = node('span', '', 'progress-fill');
            fill.setAttribute('aria-hidden', 'true');
            track.append(bar, fill);
            group.append(caption, track);
            container.append(group);
            return { label, detail, bar, fill };
        });
        const estimate = node('p', '', 'hint');
        container.append(estimate);
        progress_view = { heading, bars, estimate };
    }
    progress_view.heading.textContent = active.status === 'queued' ? '已进入队列，等待备份'
        : { floors: '正在采集贴子', replies: '正在采集楼中楼', images: '正在保存图片', packaging: '正在整理备份' }[active.phase];
    const bars = progress_view.bars;
    const update = (index: number, count?: ProgressCount) => {
        const { bar, fill } = bars[index];
        if (count?.total !== undefined) {
            bar.max = Math.max(count.total, 1);
            bar.value = count.complete ? bar.max : count.current;
        } else { bar.removeAttribute('value'); }
        fill.classList.toggle('indeterminate', bar.position < 0);
        // Numeric and accessible progress remain exact; only the visual fill is animated.
        fill.style.transform = `scaleX(${Math.max(0, bar.position)})`;
    };
    bars[0].detail.textContent = `${active.overall}%`;
    update(0, { current: active.overall, total: 100, complete: false });
    const [label, unit] = { floors: ['楼层分页', '页'], replies: ['全帖楼中楼', '条'],
        images: ['保存图片', '张'], packaging: ['整理备份', ''] }[active.phase];
    bars[1].label.textContent = label;
    bars[1].bar.setAttribute('aria-label', label);
    const count = active.progress;
    bars[1].detail.textContent = active.status === 'queued' ? '等待采集'
        : !count ? '处理中…' : count.total === undefined ? `已处理 ${count.current} ${unit}，总量待确认`
        : `${count.current} / ${count.complete || active.phase === 'images' ? '' : '约 '}${count.total} ${unit}${count.complete ? ' · 已完成' : ''}`;
    update(1, active.status === 'queued' ? { current: 0, total: 1, complete: false } : count);
    const seconds = active.remaining_seconds;
    const minutes = Math.ceil((seconds ?? 0) / 60);
    progress_view.estimate.hidden = active.status === 'queued' || count?.complete === true;
    progress_view.estimate.textContent = `本阶段预计剩余：${seconds === undefined
        ? active.phase === 'packaging' ? '暂无法估算' : '估算中…'
        : seconds < 60 ? '不足 1 分钟' : minutes < 60 ? `约 ${minutes} 分钟`
        : `约 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`}`;
}

/** Parse in an inert template and insert only text; no image or other resource enters the document. */
function snapshot_text(html: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script,style,iframe,object,embed,svg,math,link,meta,base').forEach(el => el.remove());
    template.content.querySelectorAll('img').forEach(img => img.replaceWith(img.getAttribute('alt') || '[图片]'));
    template.content.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    template.content.querySelectorAll('p,div,li').forEach(el => el.append('\n'));
    return template.content.textContent?.trim() || '（无文字内容）';
}

function preview(backup: BackupSummary): HTMLDetailsElement {
    const details = node('details', '', 'snapshot');
    details.append(node('summary', '文字预览'));
    const content = node('div');
    details.append(content);
    let loaded = false;
    let loading = false;
    details.addEventListener('toggle', () => {
        if (!details.open || loaded || loading) { return; }
        loading = true;
        content.textContent = '正在读取…';
        void api(`api/jobs/${backup.id}/snapshot`).then(async response => {
            const snapshot = await response.json() as Snapshot;
            content.replaceChildren(node('p', '正文节选 · 前 5 楼，不加载图片', 'hint'));
            for (const floor of snapshot.floors) {
                const section = node('section', '', 'snapshot-floor');
                section.append(node('p', `${floor.index} 楼 · ${floor.author} · ${floor.date}`, 'meta'),
                    node('p', snapshot_text(floor.content), 'snapshot-text'));
                content.append(section);
            }
            loaded = true;
        }).catch(() => { content.textContent = '暂时无法读取预览，请稍后重新展开。'; })
            .finally(() => { loading = false; });
    });
    return details;
}

function render(result: PostBackups): void {
    element('results').hidden = false;
    element('results-title').textContent = `贴子 ${result.post_id}`;
    start.hidden = Boolean(result.active);
    start.disabled = starting;
    if (!result.active) { show_failure = submitted_here && result.last_attempt_failed; }
    else if (!result.last_attempt_failed) { show_failure = false; }
    element('last-failure').hidden = !show_failure;
    element('failure-message').textContent = result.failure_reason === 'post_unavailable'
        ? '贴子无法访问，可能已被删除。请检查贴子链接或 ID。'
        : '未能完成备份，未生成新的备份结果。';
    if (show_failure) { notify(''); }
    render_active(show_failure ? undefined : result.active);
    const encoded = JSON.stringify(result.backups);
    if (encoded === last_backups) { return; }
    last_backups = encoded;
    const fragment = document.createDocumentFragment();
    if (!result.backups.length) { fragment.append(node('p', '暂无可下载的备份。', 'empty')); }
    for (const backup of result.backups) {
        const card = node('article', '', 'job');
        card.append(node('h3', backup.title));
        const date = node('time', `备份时间：${new Date(backup.backup_date).toLocaleString('zh-CN')}`, 'meta');
        date.dateTime = backup.backup_date;
        card.append(date);
        if (backup.partial) { card.append(node('p', '此份备份内容不完整。', 'hint')); }
        if (backup.floor_count !== undefined) { card.append(node('p', `${backup.floor_count} 个楼层 · ${backup.image_count ?? 0} 张图片`, 'meta')); }
        card.append(preview(backup));
        const actions = node('div', '', 'actions');
        const button = node('button', '下载备份');
        button.addEventListener('click', () => {
            button.disabled = true;
            void download(backup).catch(() => notify('暂时无法下载，请稍后再试', true))
                .finally(() => { button.disabled = false; });
        });
        actions.append(button);
        card.append(actions);
        fragment.append(card);
    }
    element('backups').replaceChildren(fragment);
}

async function poll(): Promise<void> {
    const token = generation;
    if (selected) {
        try { await query(selected.url, token); }
        catch {
            if (token === generation) { element('connection').textContent = '暂时无法更新，正在尝试恢复连接'; }
        }
    }
    setTimeout(() => { void poll(); }, 2000);
}
void poll();
