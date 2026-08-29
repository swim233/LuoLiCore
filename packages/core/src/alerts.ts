import type { Config } from "./config/schema.js";
import type { LogSink } from "./log/sink.js";
import { guardedFetch } from "./net/outbound.js";

/**
 * 六类告警（[10 §6](../../../docs/10-logging-and-observability.md)）。`alerts.on` 是这六个字符串
 * 的子集：写入其他值不会报错，只是永远匹配不上，因此写入端与文档都以这张表为准。
 */
export const ALERT_KINDS = [
  "quota_global_exceeded",
  "all_providers_down",
  "db_write_failed",
  "plugin_auto_disabled",
  "sandbox_unavailable",
  "consecutive_turn_failures",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertDelivery {
  /** 私聊 owner。装配方（apps/bot）仅在 Telegram 可用时提供，缺失时只剩 webhook 与日志。 */
  owner?(text: string): Promise<void> | void;
}

/** docs/10 §6 的原文即连续 5 个 turn 失败。 */
export const CONSECUTIVE_TURN_FAILURE_ALERT = 5;

/** `TurnFailureStreak` 只用到 `fire` 一个方法，声明成结构类型以便测试注入替身。 */
export interface TurnFailureAlertSink {
  fire(
    kind: "consecutive_turn_failures",
    summary: string,
    data?: Record<string, unknown>,
    key?: string,
  ): void;
}

/**
 * 连续失败计数（`consecutive_turn_failures`，docs/10 §6）。
 *
 * 跨会话计数：连续失败反映的是整个部署故障，而非单个群故障。成功一次即归零，
 * 达到阈值才 fire。计入判据由调用方决定，两条既有规则不能丢失（`docs/04 §5.3` 的三档）：
 * 超时属于故障、需计入；用户 `/cancel` 不计入。
 *
 * 从 `createTelegramBot` 的闭包中提出来，是因为它此前只存在于那里：定时轮次一次都不记，于是
 * 上游无响应、每次定时触发都超时这类故障在无人聊天的部署里一次告警都不会触发
 * （docs/28 · L-SCH-02）。装配方建一份实例传给所有开轮次的入口；每条入口各持一份时，
 * 两份各停在 3 次，而该部署实际已全线不可用。
 */
export class TurnFailureStreak {
  #count = 0;
  constructor(
    private readonly alerts?: TurnFailureAlertSink,
    private readonly threshold: number = CONSECUTIVE_TURN_FAILURE_ALERT,
  ) {}
  get count(): number {
    return this.#count;
  }
  succeeded(): void {
    this.#count = 0;
  }
  failed(lastError: string): void {
    this.#count += 1;
    if (this.#count >= this.threshold)
      this.alerts?.fire(
        "consecutive_turn_failures",
        `连续 ${this.#count} 个轮次失败`,
        { count: this.#count, lastError },
      );
  }
}

/**
 * 告警分发：去重 → 私聊 owner → webhook。
 *
 * 一律不抛异常。告警只在故障发生时才走，让它把调用方一并打断是最糟的形态：
 * 调用点全部位于 catch 块和失败分支中。
 *
 * webhook 走 `net/outbound.ts`：那是全仓库唯一一条出网路径（`docs/22 · V-SSRF-01` / `I-14`），
 * 在此另开一个裸 `fetch` 等于让运维可配的 URL 直接访问内网。
 */
export class AlertDispatcher {
  /** `${kind}:${key}` → 上一次实际发出的时刻。有界淘汰实现在 `#remember` 中。 */
  readonly #sent = new Map<string, number>();

  constructor(
    private readonly config: () => Readonly<Config["alerts"]>,
    private readonly log: LogSink,
    private readonly delivery: AlertDelivery = {},
    private readonly allowPrivateWebhook: () => boolean = () => false,
  ) {}

  /**
   * @param key 去重键的后缀。同类告警的不同对象（两个 plugin 分别被禁用）需要各发一次，
   *            因此默认按 kind 自身去重的行为必须可覆盖。
   */
  async raise(
    kind: AlertKind,
    summary: string,
    data?: Record<string, unknown>,
    key = "",
  ): Promise<void> {
    let config: Readonly<Config["alerts"]>;
    try {
      config = this.config();
    } catch {
      return;
    }
    if (!config.on.includes(kind)) return;
    const dedupeKey = `${kind}:${key}`;
    const now = Date.now();
    const last = this.#sent.get(dedupeKey) ?? 0;
    if (now - last < config.dedupeMinutes * 60_000) return;
    this.#remember(dedupeKey, now);
    this.#log({
      level: "error",
      kind: "alert.raised",
      summary,
      data: { alert: kind, ...data },
    });
    const text = `⚠️ ${summary}${data && Object.keys(data).length ? `\n${JSON.stringify(data)}` : ""}`;
    if (config.notifyOwner && this.delivery.owner) {
      try {
        await this.delivery.owner(text);
      } catch (error) {
        this.#log({
          level: "warn",
          kind: "alert.deliver_failed",
          summary: "owner notification failed",
          data: {
            alert: kind,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (config.webhookUrl) {
      try {
        // 告警 webhook 常架设在内网（Alertmanager、自建 bot），因此 `allowPrivate` 跟随
        // `provider.allowPrivateBaseUrl` 开关，由装配方传入，而不是在此写死。
        await guardedFetch(
          config.webhookUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind, summary, data: data ?? {}, at: now }),
          },
          {
            allowPrivate: this.allowPrivateWebhook(),
            maxBytes: 64 * 1024,
            timeoutMs: 10_000,
          },
        );
      } catch (error) {
        this.#log({
          level: "warn",
          kind: "alert.deliver_failed",
          summary: "webhook delivery failed",
          data: {
            alert: kind,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /**
   * 落库失败也要投递。`db_write_failed` 的触发源正是数据库写入失败
   * （`LogSink.onWriteFailure` → `fire`），因此落库绝不能挡在投递之前：挡住时，数据库故障下
   * 唯一该触发的告警必定不触发，而 `fire()` 的 `.catch()` 会把它静默吞掉。
   * 另外两处调用点位于 catch 块中，抛出会让类头声明的一律不抛失效。
   * `LogSink.event` 现已自身不抛，但这条不变量不应依赖那侧的实现（docs/10 §6）。
   */
  #log(event: Parameters<LogSink["event"]>[0]): void {
    try {
      this.log.event(event);
    } catch {
      /* 见上 */
    }
  }

  /** 同步版本：供不能 await 的调用点使用（事件回调、finally 块）。失败同样吞掉。 */
  fire(
    kind: AlertKind,
    summary: string,
    data?: Record<string, unknown>,
    key = "",
  ): void {
    void this.raise(kind, summary, data, key).catch(() => undefined);
  }

  #remember(key: string, at: number): void {
    this.#sent.set(key, at);
    if (this.#sent.size <= 512) return;
    // 去重表按 plugin 名、provider id 这类维度展开，不设上界即为一处慢泄漏。
    const cutoff = at - this.config().dedupeMinutes * 60_000;
    for (const [entry, when] of this.#sent)
      if (when < cutoff) this.#sent.delete(entry);
    while (this.#sent.size > 512)
      this.#sent.delete(this.#sent.keys().next().value!);
  }
}
