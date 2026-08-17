import type { Config } from './config/schema.js';
import type { LogSink } from './log/sink.js';
import { guardedFetch } from './net/outbound.js';

/**
 * 六类告警（[10 §6](../../../docs/10-logging-and-observability.md)）。`alerts.on` 是这六个字符串
 * 的子集 —— 写别的进去不会报错，只是永远匹配不上，所以写入端与文档都按这张表说话。
 */
export const ALERT_KINDS = ['quota_global_exceeded', 'all_providers_down', 'db_write_failed',
  'plugin_auto_disabled', 'sandbox_unavailable', 'consecutive_turn_failures'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertDelivery {
  /** 私聊 owner。装配方（apps/bot）在 Telegram 可用时才给，缺它时只剩 webhook 与日志。 */
  owner?(text: string): Promise<void> | void;
}

/**
 * 告警分发：去重 → 私聊 owner → webhook。
 *
 * **一律不抛**。告警是「出事时才走的那条路」，让它自己把调用方炸掉是最糟的形态 ——
 * 调用点全在 catch 块和失败分支里。
 *
 * webhook 走 `net/outbound.ts`：那是全仓库唯一一条出网路径（`docs/22 · V-SSRF-01` / `I-14`），
 * 在这里另开一个裸 `fetch` 等于让运维可配的 URL 直接打内网。
 */
export class AlertDispatcher {
  /** `${kind}:${key}` → 上次真的发出去的时刻。有界淘汰在 `#remember` 里。 */
  readonly #sent = new Map<string, number>();

  constructor(private readonly config: () => Readonly<Config['alerts']>, private readonly log: LogSink,
    private readonly delivery: AlertDelivery = {}, private readonly allowPrivateWebhook: () => boolean = () => false) {}

  /**
   * @param key 去重键的后缀。同一类告警但不同对象（两个 plugin 各自被禁用）要能各发一次，
   *            所以默认拿 kind 自己去重的行为必须可以被覆盖。
   */
  async raise(kind: AlertKind, summary: string, data?: Record<string, unknown>, key = ''): Promise<void> {
    let config: Readonly<Config['alerts']>;
    try { config = this.config(); } catch { return; }
    if (!config.on.includes(kind)) return;
    const dedupeKey = `${kind}:${key}`;
    const now = Date.now();
    const last = this.#sent.get(dedupeKey) ?? 0;
    if (now - last < config.dedupeMinutes * 60_000) return;
    this.#remember(dedupeKey, now);
    this.log.event({ level: 'error', kind: 'alert.raised', summary, data: { alert: kind, ...data } });
    const text = `⚠️ ${summary}${data && Object.keys(data).length ? `\n${JSON.stringify(data)}` : ''}`;
    if (config.notifyOwner && this.delivery.owner) {
      try { await this.delivery.owner(text); }
      catch (error) { this.log.event({ level: 'warn', kind: 'alert.deliver_failed', summary: 'owner notification failed', data: { alert: kind, error: error instanceof Error ? error.message : String(error) } }); }
    }
    if (config.webhookUrl) {
      try {
        // 告警 webhook 常常就架在内网（Alertmanager、自建 bot）——`allowPrivate` 因此跟着
        // `provider.allowPrivateBaseUrl` 那个开关走，由装配方传进来，而不是在这里写死。
        await guardedFetch(config.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, summary, data: data ?? {}, at: now }) },
          { allowPrivate: this.allowPrivateWebhook(), maxBytes: 64 * 1024, timeoutMs: 10_000 });
      } catch (error) { this.log.event({ level: 'warn', kind: 'alert.deliver_failed', summary: 'webhook delivery failed', data: { alert: kind, error: error instanceof Error ? error.message : String(error) } }); }
    }
  }

  /** 同步版本：给不能 await 的调用点（事件回调、finally 块）。失败照样吞掉。 */
  fire(kind: AlertKind, summary: string, data?: Record<string, unknown>, key = ''): void {
    void this.raise(kind, summary, data, key).catch(() => undefined);
  }

  #remember(key: string, at: number): void {
    this.#sent.set(key, at);
    if (this.#sent.size <= 512) return;
    // 去重表按 plugin 名 / provider id 这类东西展开，不设上界就是一条慢泄漏。
    const cutoff = at - this.config().dedupeMinutes * 60_000;
    for (const [entry, when] of this.#sent) if (when < cutoff) this.#sent.delete(entry);
    while (this.#sent.size > 512) this.#sent.delete(this.#sent.keys().next().value!);
  }
}
