import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, data_dir, jobs_dir } from './config';
import { JobQueue } from './queue';
import { create_runner } from './worker';
import { create_app } from './http';
import { load_cookie } from './session';

await mkdir(data_dir, { recursive: true, mode: 0o700 });
const queue = new JobQueue(jobs_dir, create_runner());
await queue.log('info', 'service_starting', { pid: process.pid, backend: 'api' });
await queue.log('debug', 'service_configuration', config);
try {
    await load_cookie();
} catch (error) {
    await queue.log('fatal', 'service_startup_failed', error);
    console.error(`服务启动失败：${(error as Error).message}`);
    process.exit(1);
}
const lock_path = join(data_dir, 'server.lock');
const lock = await open(lock_path, 'wx').catch(async error => {
    await queue.log('fatal', 'service_lock_failed', error);
    throw new Error('数据目录已被服务占用。如确认旧服务已经退出，请删除 .data/server.lock 后重试。');
});
await lock.writeFile(String(process.pid));
const server = create_app(queue);
let closing = false;
async function close(reason: string): Promise<void> {
    if (closing) { return; }
    closing = true;
    await queue.log('info', 'service_stopping', { reason });
    server.close();
    await queue.close();
    server.closeAllConnections();
    await lock.close();
    await unlink(lock_path);
    await queue.log('info', 'service_stopped', { reason });
}
process.once('SIGINT', () => { void close('SIGINT'); });
process.once('SIGTERM', () => { void close('SIGTERM'); });
try {
    await queue.initialize();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : config.port;
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    await queue.log('info', 'service_listening', { url: `http://${host}:${port}` });
    console.log(`贴吧备份服务: http://${host}:${port}（采集后端 API，原生 HTTP，无浏览器，单任务执行）`);
    console.log(`内容接口串行，间隔至少 ${config.api_request_interval_ms} ms，临时错误最多重试 3 次；图片最多 5 并发，启动间隔至少 ${config.image_request_interval_ms} ms，不自动重试`);
    console.log(`接口任务上限 ${config.job_timeout_ms / 60000} 分钟，楼层及每层楼中楼分别最多 ${config.max_api_pages} 个接口分页`);
} catch (error) {
    await queue.log('fatal', 'service_startup_failed', error);
    await close('startup_failed');
    throw error;
}
