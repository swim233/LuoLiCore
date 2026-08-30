import { ulid } from "ulid";
import type { OperationsRepository } from "@luoli/db";
import type { EventBus } from "../events.js";
import { redact } from "../secrets.js";

export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
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

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
/** 广播阈值与合并窗口刻意不设为配置项：这两个值一旦放宽（广播 debug、或把窗口调为 0），
 *  每条事件触发一次前端重拉将构成自我 DDoS（docs/21 §3 · G-SSE-01）。 */
const BROADCAST_MIN_LEVEL: LogEvent["level"] = "info";
const COALESCE_MS = 200;

export interface LogSinkOptions {
  level?: LogEvent["level"];
  console?: "pretty" | "json" | "off";
  events?: EventBus;
}

/** SSE 上 `log` 事件的载荷：只含摘要，不含 `data`。单条载荷可达几 MB
 *  （`model.call` 携带请求体），全量广播会压垮每个打开的 WebUI 连接。 */
export interface LogBroadcast {
  id: number;
  ts: number;
  level: LogEvent["level"];
  kind: string;
  traceId: string | null;
  summary: string;
  merged?: number;
}

/**
 * `end()` 中可改写的两列。`summary` 与 `level` 是列而非载荷（`span()` 用 `...input` 展开），
 * 因此开始时确定的值没有其他修改途径 —— 而开始时无法确定最终值是真实存在的情形：
 * `model.call` 的 span 在 `onStepStart` 开启，此时 AI SDK 报告的是链首，链内 fallback 更换的
 * 候选它不可见（`wrapLanguageModel` 使 SDK 始终只见链首）。此前该行因而记录失败的候选，
 * 同一次调用在日志与 `usage_ledger` 中指向两个不同的 provider（docs/28 · L-PROV-01），而
 * `docs/10 §7` 第 3 条要求摘要行可直接看出 provider/模型/别名。
 */
export interface SpanOverride {
  summary?: string;
  level?: LogEvent["level"];
}

export interface LogSpan {
  id: string;
  end: (data?: unknown, error?: unknown, override?: SpanOverride) => void;
}

/**
 * 日志只有一个落点：`log_events` 那一行，载荷就在它的 `data` 列上（docs/10 §3）。
 *
 * 此前有三个 —— 按天按类分的 `logs/<day>/*.jsonl`、超 `bodyMaxBytes` 时挪去的
 * `logs/<day>/blobs/*.json`、以及同一条再入一次库。实测 16 天摊成 841 个文件，而那些 jsonl
 * **生产代码零处读过**。随之删掉的还有文件轮转、按天目录的保留期删除、gzip，以及
 * 「库与目录来自两套部署」这一整类不一致。
 */
export class LogSink {
  #level: LogEvent["level"];
  readonly #console: "pretty" | "json" | "off";
  readonly #events: EventBus | null;
  readonly #pending = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      event: LogBroadcast;
      merged: number;
    }
  >();
  readonly #lastBroadcast = new Map<string, number>();
  private secrets: string[];
  constructor(
    private readonly repository: OperationsRepository,
    secrets: string[] = [],
    options: LogSinkOptions = {},
  ) {
    this.secrets = secrets;
    this.#level = options.level ?? "debug";
    this.#console = options.console ?? "off";
    this.#events = options.events ?? null;
  }

  setLevel(level: LogEvent["level"]): void {
    this.#level = level;
  }
  /** `logs.redactPatterns`：追加到内置脱敏规则上的正则源串。热更新时整体替换。 */
  redactPatterns: readonly string[] = [];

  setSecrets(secrets: readonly string[]): void {
    this.secrets = [...new Set(secrets.filter(Boolean))];
  }
  /** 装配方在此挂载告警（`alerts.on` 的 db_write_failed）。落库失败意味着日志本身已不可信，
   *  仅写 stderr 时运维通常无法察觉。设置它的调用方必须保证回调自身不抛出。 */
  onWriteFailure?: (error: unknown) => void;
  /** `onWriteFailure` 挂载的是 `alerts.fire('db_write_failed')`，而 `AlertDispatcher.raise()` 首先
   *  向库中写入一行 `alert.raised` —— 库故障时该路径会回到此处。当前 `dedupeMinutes` 也能中断循环
   *  （`#remember` 在那次 log.event 之前调用），但日志失败不循环这一性质不应依赖告警的去重窗口。 */
  #reporting = false;

  /**
   * @param line 已脱敏的整条事件。**写的是整行而不只是那句错误消息** —— 「库坏了至少内容还在」
   *   此前由 JSONL 兜着（`tests/log.pipeline.test.ts` 那条断言），删掉文件落点之后，唯一还留得住
   *   载荷的地方就是进程的 stderr（journald / `docker logs` 收得到）。这不是第二个落点：
   *   它只在写库失败这一条路径上有输出，正常运行时一个字节都不写。
   */
  #reportWriteFailure(error: unknown, line?: unknown): void {
    try {
      if (line !== undefined) {
        // 载荷可能带环（调用方传进来的任意对象），序列化失败不该盖掉下面那句错误。
        let text: string;
        try {
          text = JSON.stringify(line) ?? "";
        } catch {
          text = "";
        }
        if (text) process.stderr.write(`[log] ${text}\n`);
      }
      process.stderr.write(
        `[log] 写入失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {
      /* stderr 同样不可用 */
    }
    if (this.#reporting) return;
    this.#reporting = true;
    try {
      this.onWriteFailure?.(error);
    } catch {
      /* 告警链路自身故障时不得再次抛出 */
    } finally {
      this.#reporting = false;
    }
  }

  /** 结构化事件（`turn.*` / `usage` / `quota` / `task.updated`）与日志同属一条观测流，
   *  由已持有 LogSink 的调用点直接发出，而不是把 EventBus 再穿过六个构造函数 ——
   *  遗漏一处的表现是某类事件永不到达，这正是 G-SSE-01 的成因。不落库，只广播。 */
  publish(type: string, data: unknown): void {
    this.#events?.emit(type, data);
  }

  /** 同一 `kind` 在 COALESCE_MS 内只保留最后一条，并附带被合并的条数：工具密集调用时
   *  `tool.call` 可在几十毫秒内产生上百条，不合并则前端每条都要重拉一次数据。 */
  #broadcast(event: LogBroadcast): void {
    if (
      !this.#events ||
      LEVEL_RANK[event.level] < LEVEL_RANK[BROADCAST_MIN_LEVEL]
    )
      return;
    const pending = this.#pending.get(event.kind);
    if (pending) {
      pending.event = event;
      pending.merged += 1;
      return;
    }
    const wait =
      COALESCE_MS - (Date.now() - (this.#lastBroadcast.get(event.kind) ?? 0));
    if (wait <= 0) {
      this.#lastBroadcast.set(event.kind, Date.now());
      this.#events.emit("log", event);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.#pending.get(event.kind);
      this.#pending.delete(event.kind);
      if (!entry) return;
      this.#lastBroadcast.set(event.kind, Date.now());
      this.#events?.emit(
        "log",
        entry.merged > 1
          ? { ...entry.event, merged: entry.merged }
          : entry.event,
      );
    }, wait);
    // 尾包定时器不应阻止进程退出：CLI 与测试中 LogSink 常是最后一个存活的句柄。
    timer.unref?.();
    this.#pending.set(event.kind, { timer, event, merged: 1 });
  }

  /** 关停时丢弃尚未发出的 SSE 尾包。事件本身早已同步入库，没有缓冲要刷。 */
  close(): void {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
  }

  event(input: LogEvent): number {
    if (LEVEL_RANK[input.level] < LEVEL_RANK[this.#level]) return 0;
    const safe = redact(input, this.secrets, this.redactPatterns);
    const ts = Date.now();
    if (this.#console === "json")
      process.stdout.write(`${JSON.stringify({ ts, ...safe })}\n`);
    else if (this.#console === "pretty")
      // 打的是脱敏后的 summary。此前这一行用的是 `input.summary` —— 同一个方法里 json 那一路
      // 打脱敏后的、pretty 那一路打原文，而默认配置正是 pretty。
      process.stdout.write(
        `${new Date(ts).toISOString()} ${input.level.toUpperCase()} ${input.kind} ${safe.summary}\n`,
      );
    // 入库失败一律不向外抛出。本方法的调用点全部位于 catch 块、`.catch()` 回调以及
    // `main.ts` 的 crash handler 中 —— 抛出会把日志写入失败升级为轮次失败，
    // 再升级为 crash handler 自身抛出、`process.exit(1)` 无法执行。关停竞态下这必然发生：
    // `poller.drain()` 宽限期结束即返回，在途 handler 之后才 settle，此时 `closeDatabase`
    // 已执行完毕。返回 0 与级别不足那一条采用同一约定（见本方法开头），调用方本就不应
    // 将其视为真实 id。
    let id: number;
    try {
      id = this.repository.insertLog(safe);
    } catch (error) {
      this.#reportWriteFailure(error, { ts, ...safe });
      return 0;
    }
    // 广播必须在入库成功之后：前端用该 id 调 `/api/logs/:id` 拉取详情，广播 0 等于
    // 在日志页插入一条无法打开的行。
    this.#broadcast({
      id,
      ts,
      level: input.level,
      kind: input.kind,
      traceId: input.traceId ?? null,
      summary: safe.summary,
    });
    return id;
  }

  /**
   * 一个 span 只写一行，因此开始时的 `data` 与结束时的载荷必须合并而非相互覆盖。
   *
   * 此前 `end()` 中 `data:` 排在 `...input` 之后，开始那份被无条件覆盖：`tool.call` 传入的
   * `{input}` 从未写入库中（30/30 条只有 `{output}`），`model.call` 的
   * `stepNumber` / `provider` / `instructions` 同样丢失，而失败路径 `end(undefined, error)`
   * 会同时丢弃输入与输出 —— 排障时只剩某个工具报错这一信息。`docs/10 §2` 的字段集与
   * `docs/09 §3.10` 的可展开查看工具输入输出，描述的一直是合并后的结果。
   *
   * `end()` 的第三个参数只修改 `summary` / `level` 两列（载荷的合并契约不变），见 `SpanOverride`。
   */
  span(input: Omit<LogEvent, "spanId">): LogSpan {
    const id = ulid();
    const started = performance.now();
    let ended = false;
    return {
      id,
      end: (data?: unknown, error?: unknown, override?: SpanOverride) => {
        if (ended) return;
        ended = true;
        const level = override?.level ?? (error ? "error" : input.level);
        const merged = mergeSpanData(input.data, data, error);
        this.event({
          ...input,
          level,
          ...(override?.summary === undefined
            ? {}
            : { summary: override.summary }),
          spanId: id,
          data: merged,
          durationMs: Math.round(performance.now() - started),
        });
      },
    };
  }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 非对象的结束值挂在 `result` 下而非覆盖开始那份：调用方传入字符串或数组时，
 * 合并没有意义，但开始时的上下文（工具参数、step 号）仍是排障所需信息。
 */
function mergeSpanData(open: unknown, close: unknown, error: unknown): unknown {
  const head =
    open === undefined ? undefined : plain(open) ? open : { context: open };
  const tail =
    close === undefined ? undefined : plain(close) ? close : { result: close };
  const failure =
    error === undefined
      ? undefined
      : { error: error instanceof Error ? error.message : String(error) };
  if (!head && !tail && !failure) return undefined;
  return { ...(head ?? {}), ...(tail ?? {}), ...(failure ?? {}) };
}
