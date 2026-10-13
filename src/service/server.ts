import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, data_dir, jobs_dir } from './config';
import { JobQueue } from './queue';
import { create_runner } from './worker';
import { create_app } from './http';

await mkdir(data_dir, { recursive: true, mode: 0o700 });
const lock_path = join(data_dir, 'server.lock');
const lock = await open(lock_path, 'wx').catch(() => {
    throw new Error('数据目录已被服务占用。如确认旧服务已经退出，请删除 .data/server.lock 后重试。');
});
await lock.writeFile(String(process.pid));
const queue = new JobQueue(jobs_dir, create_runner());
const server = create_app(queue);
let closing = false;
async function close(): Promise<void> {
    if (closing) { return; }
    closing = true;
    server.close();
    await queue.close();
    server.closeAllConnections();
    await lock.close();
    await unlink(lock_path);
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
    await queue.initialize();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : config.port;
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`贴吧备份服务: http://${host}:${port}（采集后端 ${config.backend}，Chromium headless，单任务执行）`);
    if (config.backend === 'api') { console.log(`接口及图片请求间隔至少 ${config.api_request_interval_ms / 1000} 秒，不自动重试`); }
} catch (error) {
    await close();
    throw error;
}
