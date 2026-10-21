import { readFile } from 'node:fs/promises';
import { regression_report } from '../src/shared/regression';

const args = process.argv.slice(2);
const paths = args.filter(arg => !arg.startsWith('--'));
if (paths.length !== 2 || args.some(arg => arg.startsWith('--') && !['--normalize-images', '--strict'].includes(arg))) {
    console.error('用法: npm run regression -- tests/regression/post.json <实际post.json> [--normalize-images] [--strict]');
    process.exitCode = 2;
} else {
    const [expected, actual] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const report = regression_report(expected, actual, { normalize_images: args.includes('--normalize-images'), strict: args.includes('--strict') });
    const { differences } = report;
    console.log(`严格比较 ${report.strict_differences.length} 处差异；接受正文连续空格差异 ${report.accepted_space_differences.length} 处`);
    if (report.accepted_space_differences.length) { console.log(JSON.stringify({ accepted_space_differences: report.accepted_space_differences }, null, 2)); }
    if (report.accepted_backup_date_differences.length) { console.log(JSON.stringify({ accepted_backup_date_differences: report.accepted_backup_date_differences }, null, 2)); }
    if (report.accepted_url_time_differences.length) { console.log(JSON.stringify({ accepted_url_time_differences: report.accepted_url_time_differences }, null, 2)); }
    if (differences.length) {
        console.error(JSON.stringify(differences, null, 2));
        console.error(`回归失败: ${differences.length} 处差异`);
        process.exitCode = 1;
    } else {
        console.log('回归通过: 所有字段符合比较规则' + (args.includes('--normalize-images') ? '（按原始 URL 比较图片引用）' : ''));
    }
}
