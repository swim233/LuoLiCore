import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ulid } from 'ulid';
import type { OperationsRepository } from '@luoli/db';
import type { EventBus } from '../events.js';
import { redact } from '../secrets.js';

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  summary: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  chatId?: string;
  userId?: string;
  key?: string;
  data?: unknown;
  durationMs?: number;
}

const CATEGORY_BY_PREFIX: Record<string, string> = {
  model: 'model', tool: 'tool', sandbox: 'tool', approval: 'tool', system: 'system',
  config: 'system', maintenance: 'system', webui: 'system', plugin: 'system', mcp: 'system',
};
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
/** 广播阈值与合并窗口刻意不做成配置项：这两个值一旦调松（广播 debug、或把窗口调到 0），
 *  「每来一条事件前端重拉一次」就会变成自我 DDoS（docs/21 §3 · G-SSE-01）。 */
const BROADCAST_MIN_LEVEL: LogEvent['level'] = 'info';
const COALESCE_MS = 200;

export interface LogSinkOptions {
  level?: LogEvent['level'];
  maxFileMb?: number;
  bodyMaxBytes?: number;
  console?: 'pretty' | 'json' | 'off';
  events?: EventBus;
}

/** SSE 上那条 `log` 事件的载荷：**只有摘要，没有 `data`**。单条载荷能到几百 KB
 *  （`model.call` 带请求体），全量广播会把每个开着的 WebUI 连接一起打爆。 */
export interface LogBroadcast {
  id: number;
  ts: number;
  level: LogEvent['level'];
  kind: string;
  traceId: string | null;
  summary: string;
  merged?: number;
}

export class LogSink {
  #level: LogEvent['level'];
  readonly #maxFileBytes: number;
  readonly #bodyMaxBytes: number;
  readonly #console: 'pretty' | 'json' | 'off';
  readonly #events: EventBus | null;
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; event: LogBroadcast; merged: number }>();
  readonly #lastBroadcast = new Map<string, number>();

  constructor(private readonly repository: OperationsRepository, private readonly directory: string, private readonly secrets: string[] = [], options: LogSinkOptions = {}) {
    this.#level = options.level ?? 'debug';
    this.#maxFileBytes = (options.maxFileMb ?? 128) * 1024 * 1024;
    this.#bodyMaxBytes = options.bodyMaxBytes ?? 262_144;
    this.#console = options.console ?? 'off';
    this.#events = options.events ?? null;
  }

  setLevel(level: LogEvent['level']): void {
    this.#level = level;
  }

  /** 结构化事件（`turn.*` / `usage` / `quota` / `task.updated`）与日志是同一条观测流，
   *  从已经持有 LogSink 的调用点直接发，而不是把 EventBus 再穿一遍六个构造函数 ——
   *  漏穿一个的表现就是某一类事件永远不到，而这正是 G-SSE-01 的成因。不落库，只广播。 */
  publish(type: string, data: unknown): void {
    this.#events?.emit(type, data);
  }

  /** 同一 `kind` 在 COALESCE_MS 内只留最后一条，并带上被合并的条数：一次工具风暴里
   *  `tool.call` 能在几十毫秒内来上百条，不合并的话前端每条都要重拉一次数据。 */
  #broadcast(event: LogBroadcast): void {
    if (!this.#events || LEVEL_RANK[event.level] < LEVEL_RANK[BROADCAST_MIN_LEVEL]) return;
    const pending = this.#pending.get(event.kind);
    if (pending) { pending.event = event; pending.merged += 1; return; }
    const wait = COALESCE_MS - (Date.now() - (this.#lastBroadcast.get(event.kind) ?? 0));
    if (wait <= 0) { this.#lastBroadcast.set(event.kind, Date.now()); this.#events.emit('log', event); return; }
    const timer = setTimeout(() => {
      const entry = this.#pending.get(event.kind);
      this.#pending.delete(event.kind);
      if (!entry) return;
      this.#lastBroadcast.set(event.kind, Date.now());
      this.#events?.emit('log', entry.merged > 1 ? { ...entry.event, merged: entry.merged } : entry.event);
    }, wait);
    // 尾部那一条不该把进程留住：CLI 与测试里 LogSink 常常是最后一个活着的句柄。
    timer.unref?.();
    this.#pending.set(event.kind, { timer, event, merged: 1 });
  }

  /** 关停时丢掉尚未发出的尾包。事件只在内存里，丢掉不影响已经落库的那份日志。 */
  close(): void {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
  }

  event(input: LogEvent): number {
    if (LEVEL_RANK[input.level] < LEVEL_RANK[this.#level]) return 0;
    const safe = redact(input, this.secrets);
    const prefix = input.kind.split('.')[0] ?? 'turn';
    const category = CATEGORY_BY_PREFIX[prefix] ?? 'turn';
    const day = new Date().toISOString().slice(0, 10);
    let data = safe.data;
    let fileRef: string | undefined;
    if (data !== undefined) {
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > this.#bodyMaxBytes) {
        fileRef = join(day, 'blobs', `${Date.now()}-${ulid()}.json`);
        const blobPath = resolve(this.directory, fileRef);
        mkdirSync(dirname(blobPath), { recursive: true, mode: 0o700 });
        writeFileSync(blobPath, serialized, { mode: 0o600 });
        data = { fileRef, bytes: Buffer.byteLength(serialized) };
      }
    }
    const path = join(this.directory, day, `${category}.jsonl`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size >= this.#maxFileBytes) {
      let suffix = 1;
      while (existsSync(`${path}.${suffix}`)) suffix += 1;
      renameSync(path, `${path}.${suffix}`);
    }
    const stored = { ...safe, data };
    const ts = Date.now();
    const line = JSON.stringify({ ts, ...stored, ...(fileRef ? { fileRef } : {}) });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
    if (this.#console === 'json') process.stdout.write(`${line}\n`);
    else if (this.#console === 'pretty') process.stdout.write(`${new Date().toISOString()} ${input.level.toUpperCase()} ${input.kind} ${input.summary}\n`);
    const id = this.repository.insertLog(stored);
    this.#broadcast({ id, ts, level: input.level, kind: input.kind, traceId: input.traceId ?? null, summary: safe.summary });
    return id;
  }

  span(input: Omit<LogEvent, 'spanId'>): { id: string; end: (data?: unknown, error?: unknown) => void } {
    const id = ulid();
    const started = performance.now();
    let ended = false;
    return {
      id,
      end: (data?: unknown, error?: unknown) => {
        if (ended) return;
        ended = true;
        const level = error ? 'error' : input.level;
        this.event({ ...input, level, spanId: id, data: error ? { error: error instanceof Error ? error.message : String(error), data } : data, durationMs: Math.round(performance.now() - started) });
      },
    };
  }
}
