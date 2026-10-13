import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { data_dir, config } from '../src/service/config';
import { create_runner } from '../src/service/worker';
import { regression_report } from '../src/shared/regression';
import { parse_post_url, type Job } from '../src/service/model';
import type { Post } from '../src/types';

const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('--') && !['--normalize-images', '--strict'].includes(arg))
    || args.filter(arg => !arg.startsWith('--')).length > 1) {
    throw new Error('用法: npm run regression:live -- [test/post.json] [--normalize-images] [--strict]；后端由 TIEBA_BACKEND 选择');
}
const baseline_path = args.find(arg => !arg.startsWith('--')) || 'test/post.json';
const baseline = JSON.parse(await readFile(baseline_path, 'utf8')) as Post;
const post = parse_post_url(String(baseline.id));
const now = new Date().toISOString();
const id = randomUUID();
const directory = join(data_dir, 'regression', id);
await mkdir(directory, { recursive: true });
const job: Job = {
    id, post_id: post.id, url: post.url, status: 'running',
    created_at: now, updated_at: now, progress: { stage: '开始回归' }, warnings: [],
};
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error(`回归运行超过 ${config.job_timeout_ms / 60000} 分钟，已中止`)), config.job_timeout_ms);
const interrupt = () => controller.abort(new Error('回归收到终端中断信号，已中止'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
    console.log(`采集后端: ${config.backend}`);
    const result = await create_runner()(job, directory, async progress => {
        console.log(progress.stage, progress.total ? `${progress.current}/${progress.total}` : '');
    }, controller.signal);
    const actual = JSON.parse(await readFile(join(directory, 'post.json'), 'utf8')) as Post;
    const report = regression_report(baseline, actual, { normalize_images: args.includes('--normalize-images'), strict: args.includes('--strict') });
    const { differences } = report;
    await writeFile(join(directory, 'diff.json'), JSON.stringify(differences, null, 2));
    await writeFile(join(directory, 'regression.json'), JSON.stringify(report, null, 2));
    console.log(`严格差异 ${report.strict_differences.length} 处；接受正文连续空格差异 ${report.accepted_space_differences.length} 处`);
    console.log(`采集结果与差异报告: ${directory}`);
    if (differences.length || result.warnings.length) {
        console.error(`回归未通过: ${differences.length} 处 JSON 差异，${result.warnings.length} 项采集警告`);
        process.exitCode = 1;
    } else { console.log('真实采集回归通过：所有字段符合比较规则，图片下载无失败。'); }
} finally {
    clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
}
