import { sqliteTimezoneModifier } from '@luoli/shared';
import type { Sqlite } from '@luoli/db';

export interface UsageRecord {
  turnId: string;
  agentRunId?: string;
  spanId?: string;
  chatId: string;
  userId: string;
  providerId: string;
  modelId: string;
  modelAlias: string;
  /** **超集**：含 `cacheReadTokens`（Anthropic 那一路还含 `cacheWriteTokens`）。计价别用它。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 互斥的那份输入（AI SDK 的 `inputTokenDetails.noCacheTokens`）。缺失时按相减回落。 */
  noCacheTokens?: number | undefined;
  reasoningTokens: number;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
  latencyMs: number;
  finishReason?: string;
  ok: boolean;
  errorKind?: string;
}

/**
 * **计价的输入是 noCache 那一份，`inputTokens` 是超集。**
 *
 * AI SDK 的 `asLanguageModelUsage` 把 `step.usage.inputTokens` 统一成 `inputTokens.total`，
 * 而三家 provider 包都让 total 成为超集：`openai-compatible` 与 `openai` 的 total 是
 * `promptTokens`（含 `cached_tokens`），`anthropic` 则是把互斥的原始字段重新加成
 * `input + cacheCreation + cacheRead`。所以**不按 provider kind 分叉** —— `noCacheTokens`
 * 三家一致（`docs/10 §4.1`）。
 *
 * 此前这里把 `cacheReadTokens` 当成与 `inputTokens` 互斥的一份、在两者之上各收一次钱，
 * 而 cache read 通常便宜几十倍：一次 91% 前缀命中的调用高估 9.4 倍，生产库 342 条 ledger 里
 * 270 条有缓存命中，账面高估 44.4%。`quota.commit` 吃的就是这个数，于是前缀缓存做得越成功、
 * 用户越早撞上日额度（`docs/reviews/28 · L-COST-01`）。
 *
 * 缺失时回落到相减而不是回落到 `inputTokens`：SDK 换大版本让那个字段消失时，
 * 「少扣一次缓存」是账目偏高（可查），「按 total 计价」是账目翻倍。
 */
export function pricedInputTokens(input: Pick<UsageRecord, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'noCacheTokens'>): number {
  return input.noCacheTokens ?? Math.max(0, input.inputTokens - input.cacheReadTokens - input.cacheWriteTokens);
}

export class UsageLedger {
  constructor(private readonly db: Sqlite) {}

  record(input: UsageRecord): number {
    const hasPricing = input.priceIn !== null && input.priceOut !== null;
    const cost = hasPricing
      ? (pricedInputTokens(input) * input.priceIn! + input.outputTokens * input.priceOut! + input.cacheReadTokens * (input.priceCacheRead ?? 0) + input.cacheWriteTokens * (input.priceCacheWrite ?? 0)) / 1_000_000
      : 0;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO usage_ledger(ts,turn_id,agent_run_id,span_id,chat_id,user_id,provider_id,model_id,model_alias,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,finish_reason,ok,error_kind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(), input.turnId, input.agentRunId ?? null, input.spanId ?? null,
        input.chatId, input.userId, input.providerId, input.modelId, input.modelAlias, input.inputTokens, input.outputTokens,
        input.cacheReadTokens, input.cacheWriteTokens, input.reasoningTokens, cost, input.latencyMs, input.finishReason ?? null,
        input.ok ? 1 : 0, input.errorKind ?? (hasPricing ? null : 'no_pricing'));
      this.db.prepare('UPDATE turns SET cost_usd=cost_usd+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,model_calls=model_calls+1 WHERE id=?').run(cost, input.inputTokens, input.outputTokens, input.turnId);
    })();
    return cost;
  }

  turnCost(turnId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS value FROM usage_ledger WHERE turn_id=?').get(turnId) as { value: number };
    return row.value;
  }

  /**
   * @param timezone 按**本地日**分桶。此前这里是裸的 `strftime('%Y-%m-%d', ts/1000, 'unixepoch')`
   *   —— UTC —— 而总览趋势（`OperationsRepository.dashboard`）与配额窗口（`quotaBucket`）都按
   *   `general.timezone` 分日：东八区部署里「用量报表的 8 月 18 日」是本地 18 日 08:00 到 19 日
   *   08:00，两个页面对同一天给出两个数字，而这正是运维核对账单时会撞上的地方（docs/27 · C-02）。
   *   偏移取 `to` 那一刻的值，与 `dashboard` 共用 `sqliteTimezoneModifier`（DST 折中见那里）。
   */
  report(from: number, to: number, groupBy: 'day' | 'chat' | 'user' | 'model' | 'alias' | 'agent' | 'provider', timezone = 'UTC'): unknown[] {
    const expressions: Record<typeof groupBy, string> = {
      day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', ?)", chat: 'chat_id', user: 'user_id', model: 'model_id', alias: 'model_alias', agent: 'agent_run_id', provider: 'provider_id',
    };
    const parameters = groupBy === 'day' ? [sqliteTimezoneModifier(timezone, new Date(to)), from, to] : [from, to];
    // `cache_read_tokens` 一直在写，只是没人聚合过它 —— 而「这家上游的缓存到底是不是真的」
    // 只有 `cacheReadTokens / inputTokens` 这一个数能回答。缺它的时候这件事得靠翻 JSONL 反推
    // 请求体、逐轮对比前缀（那次翻了两小时），所以它和 provider 维度是一起加的。
    // **这个比值是 `input_tokens` 存 total（而不是存计价用的 noCache）的唯一理由**：
    // 计价口径与观测口径在这一列上是两件事，改存 noCache 会让命中率恒等于 0（`pricedInputTokens`）。
    return this.db.prepare(`SELECT ${expressions[groupBy]} AS bucket,SUM(cost_usd) AS costUsd,SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,SUM(cache_read_tokens) AS cacheReadTokens,SUM(cache_write_tokens) AS cacheWriteTokens,
      COUNT(*) AS calls,SUM(ok) AS successes FROM usage_ledger WHERE ts BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`).all(...parameters);
  }
}
