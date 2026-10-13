import type { Job } from '../service/model';

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) { throw new Error(`Missing element ${id}`); }
    return value as T;
}
const form = element<HTMLFormElement>('backup-form');
const input = element<HTMLInputElement>('post-url');
const submit = element<HTMLButtonElement>('submit');
const message = element<HTMLParagraphElement>('message');
let last_jobs = '';

function notify(text: string, error = false): void {
    message.textContent = text;
    message.className = error ? 'error' : '';
}

async function api(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '请求失败');
    }
    return response;
}

async function submit_job(url: string): Promise<void> {
    await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    notify('任务已提交，备份完成后可在下方下载。');
    await refresh();
}

form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true;
    void submit_job(input.value).catch(error => notify(String(error.message), true)).finally(() => { submit.disabled = false; });
});
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    result.textContent = text;
    result.className = className;
    return result;
}

async function download(job: Job, json: boolean): Promise<void> {
    const response = await api(`/api/jobs/${job.id}/${json ? 'post.json' : 'download'}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = json ? 'post.json' : job.filename || 'backup.tar';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function render(jobs: Job[]): void {
    const container = element('jobs');
    const fragment = document.createDocumentFragment();
    if (!jobs.length) { fragment.append(node('p', '还没有备份任务。\n提交第一个帖子，开始保存。', 'empty')); }
    const labels: Record<Job['status'], string> = { queued: '排队中', running: '处理中', complete: '已完成', partial: '部分完成', failed: '失败' };
    for (const job of jobs) {
        const card = node('article', '', 'job');
        const heading = node('div', '', 'job-heading');
        heading.append(node('h3', `帖子 ${job.post_id}`), node('span', labels[job.status], `badge ${job.status}`));
        card.append(heading, node('p', new Date(job.created_at).toLocaleString('zh-CN'), 'meta'));
        const { stage, current, total } = job.progress;
        card.append(node('p', stage + (total ? ` · ${current || 0} / ${total}` : '')));
        if (job.status === 'running') {
            const progress = node('progress');
            progress.setAttribute('aria-label', stage);
            if (total) { progress.max = total; progress.value = current || 0; }
            card.append(progress);
        }
        if (job.floor_count !== undefined) { card.append(node('p', `${job.floor_count} 个楼层 · ${job.image_count} 张图片`, 'meta')); }
        if (job.error) { card.append(node('p', job.error, 'error')); }
        if (job.warnings.length) {
            const details = node('details');
            details.append(node('summary', `${job.warnings.length} 项未完整备份，查看原因`));
            for (const warning of job.warnings) { details.append(node('p', warning)); }
            card.append(details);
        }
        const actions = node('div', '', 'actions');
        if (['complete', 'partial'].includes(job.status)) {
            for (const is_json of [false, true]) {
                const button = node('button', is_json ? '下载 JSON' : '下载备份', is_json ? 'secondary' : '');
                button.addEventListener('click', () => {
                    button.disabled = true;
                    void download(job, is_json).catch(error => notify(String(error.message), true)).finally(() => { button.disabled = false; });
                });
                actions.append(button);
            }
        }
        if (['failed', 'partial'].includes(job.status)) {
            const retry = node('button', '重新备份', 'secondary');
            retry.addEventListener('click', () => {
                retry.disabled = true;
                void submit_job(job.url).catch(error => notify(String(error.message), true)).finally(() => { retry.disabled = false; });
            });
            actions.append(retry);
        }
        card.append(actions);
        fragment.append(card);
    }
    container.replaceChildren(fragment);
}

async function refresh(): Promise<void> {
    try {
        const response = await api('/api/jobs');
        const jobs = await response.json() as Job[];
        const encoded = JSON.stringify(jobs);
        if (encoded !== last_jobs) { render(jobs); last_jobs = encoded; }
        element('connection').textContent = '已连接 · 自动更新';
    } catch (error) {
        element('connection').textContent = '连接失败';
        notify(error instanceof Error ? error.message : '连接失败', true);
    }
}
async function poll(): Promise<void> {
    await refresh();
    setTimeout(() => { void poll(); }, 2000);
}
void poll();
