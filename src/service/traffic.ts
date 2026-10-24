import { monitor } from 'tencentcloud-sdk-nodejs-monitor';
import type { GetMonitorDataResponse } from 'tencentcloud-sdk-nodejs-monitor/tencentcloud/services/monitor/v20180724/monitor_models';
import type { CosConfig } from './storage';
import type { ServiceConfig } from './config';

export class TrafficLimitError extends Error {
    constructor() { super('服务器日流量已达限额'); }
}
export class TrafficUnavailableError extends Error {
    constructor() { super('暂时无法核实服务器流量，请稍后再试'); }
}
export interface TrafficGate {
    check(): Promise<void>;
    /** Bound previously issued links to the current monitoring window and calendar day. */
    expires_seconds(requested: number): number;
}

const day_ms = 86400000;
const offset_ms = 8 * 3600000;
export function traffic_day(now: number): number {
    return Math.floor((now + offset_ms) / day_ms) * day_ms - offset_ms;
}

type UsageReader = (start: number, end: number) => Promise<number>;
type Log = (level: 'info' | 'error', event: string, detail: unknown) => Promise<void>;

/** Read-on-demand, shared by admission and downloads; no monitoring calls when idle. */
export class DailyTrafficGate implements TrafficGate {
    private cached?: { day: number; checked_at: number; bytes: number; failed: boolean };
    private pending?: Promise<void>;
    constructor(private readonly limit: number, private readonly interval: number,
        private readonly read: UsageReader, private readonly log: Log, private readonly now = Date.now) {}

    async check(): Promise<void> {
        for (;;) {
            const now = this.now();
            const day = traffic_day(now);
            const cached = this.cached;
            if (cached && cached.day === day && now >= cached.checked_at && now - cached.checked_at < this.interval) {
                if (cached.failed) { throw new TrafficUnavailableError(); }
                if (cached.bytes >= this.limit) { throw new TrafficLimitError(); }
                return;
            }
            if (!this.pending) {
                this.pending = this.refresh(day, now).finally(() => { this.pending = undefined; });
            }
            await this.pending;
            // A request crossing midnight must not reuse yesterday's allowance.
        }
    }

    private async refresh(day: number, checked_at: number): Promise<void> {
        try {
            const bytes = await this.read(day, checked_at);
            if (!Number.isFinite(bytes) || bytes < 0) { throw new Error('无效流量数据'); }
            const previous = this.cached?.day === day ? this.cached.bytes ?? 0 : 0;
            this.cached = { day, checked_at: this.now(), bytes: Math.max(previous, bytes), failed: false };
            await this.log('info', 'cos_daily_traffic', { bytes: this.cached.bytes, limit: this.limit,
                day: new Date(day + offset_ms).toISOString().slice(0, 10), limited: this.cached.bytes >= this.limit });
        } catch (error) {
            const previous = this.cached?.day === day ? this.cached.bytes : 0;
            this.cached = { day, checked_at: this.now(), bytes: previous, failed: true };
            // Never log raw SDK errors: they may carry credentials or signed headers.
            const code = (error as { code?: unknown })?.code;
            await this.log('error', 'cos_traffic_unavailable', {
                code: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'Unknown',
            });
        }
    }

    expires_seconds(requested: number): number {
        const now = this.now();
        const cached = this.cached;
        if (!cached || cached.failed || cached.day !== traffic_day(now)) { throw new TrafficUnavailableError(); }
        if (cached.bytes >= this.limit) { throw new TrafficLimitError(); }
        const expires = Math.min(cached.checked_at + this.interval, cached.day + day_ms);
        const seconds = Math.floor((expires - now) / 1000);
        if (seconds < 1) { throw new TrafficUnavailableError(); }
        return Math.min(requested, seconds);
    }
}

export function sum_traffic(data: GetMonitorDataResponse, bucket: string, start: number, end: number): number {
    if (data.MetricName !== 'InternetTraffic' || data.Period !== 300 || !Array.isArray(data.DataPoints)) {
        throw new Error('无效 COS 监控响应');
    }
    // A successful empty response means no published samples yet (including an idle bucket).
    if (data.DataPoints.length === 0) { return 0; }
    if (data.DataPoints.length !== 1) { throw new Error('COS 监控实例不匹配'); }
    const point = data.DataPoints[0];
    if (!point.Dimensions?.some(value => value.Name === 'bucket' && value.Value === bucket)
        || !Array.isArray(point.Timestamps) || !Array.isArray(point.Values)
        || point.Timestamps.length !== point.Values.length) { throw new Error('无效 COS 监控数据点'); }
    let total = 0;
    const seen = new Set<number>();
    for (let index = 0; index < point.Timestamps.length; index++) {
        const timestamp = point.Timestamps[index];
        const value = point.Values[index];
        if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value < 0 || seen.has(timestamp)) {
            throw new Error('无效 COS 监控数值');
        }
        seen.add(timestamp);
        if (timestamp * 1000 >= start && timestamp * 1000 <= end) { total += value; }
    }
    return total;
}

export function create_traffic_gate(options: CosConfig, settings: ServiceConfig['cos'], log: Log): DailyTrafficGate {
    const client = new monitor.v20180724.Client({
        credential: { secretId: options.secret_id, secretKey: options.secret_key },
        // COS monitoring is centralized in Guangzhou regardless of the bucket's region.
        region: 'ap-guangzhou', profile: { httpProfile: { reqTimeout: Math.min(10, settings.request_timeout_ms / 1000) } },
    });
    return new DailyTrafficGate(settings.daily_traffic_limit_bytes, settings.traffic_check_interval_ms, async (start, end) => {
        const data = await client.GetMonitorData({ Namespace: 'QCE/COS', MetricName: 'InternetTraffic', Period: 300,
            Instances: [{ Dimensions: [{ Name: 'bucket', Value: options.bucket }] }],
            StartTime: new Date(start).toISOString(), EndTime: new Date(end).toISOString(),
        });
        return sum_traffic(data, options.bucket, start, end);
    }, log);
}
