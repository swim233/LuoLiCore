import { sqliteTimezoneModifier } from "@luoli/shared";
import type { Sqlite } from "@luoli/db";

export interface UsageRecord {
  turnId: string;
  agentRunId?: string;
  spanId?: string;
  chatId: string;
  userId: string;
  providerId: string;
  modelId: string;
  modelAlias: string;
  /** 超集：含 `cacheReadTokens`（Anthropic 那一路还含 `cacheWriteTokens`）。不可用于计价。 */
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
 * 计价使用 noCache 那一份，`inputTokens` 是超集。
 *
 * AI SDK 的 `asLanguageModelUsage` 把 `step.usage.inputTokens` 统一成 `inputTokens.total`，
 * 而三家 provider 包都让 total 成为超集：`openai-compatible` 与 `openai` 的 total 是
 * `promptTokens`（含 `cached_tokens`），`anthropic` 则把互斥的原始字段重新加成
 * `input + cacheCreation + cacheRead`。因此不按 provider kind 分叉，`noCacheTokens`
 * 三家一致（`docs/10 §4.1`）。
 *
 * 此前这里把 `cacheReadTokens` 视为与 `inputTokens` 互斥的一份、在两者之上各计一次费，
 * 而 cache read 通常便宜数十倍：一次 91% 前缀命中的调用高估 9.4 倍，生产库 342 条 ledger 中
 * 270 条有缓存命中，账面高估 44.4%。`quota.commit` 消费的正是这个数，于是前缀缓存越有效、
 * 用户越早触及日额度（`docs/reviews/28 · L-COST-01`）。
 *
 * 缺失时回落到相减而非回落到 `inputTokens`：SDK 大版本更迭导致该字段消失时，
 * 少扣一次缓存表现为账目偏高（可排查），按 total 计价则是账目翻倍。
 */
export function pricedInputTokens(
  input: Pick<
    UsageRecord,
    "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "noCacheTokens"
  >,
): number {
  return (
    input.noCacheTokens ??
    Math.max(
      0,
      input.inputTokens - input.cacheReadTokens - input.cacheWriteTokens,
    )
  );
}

export class UsageLedger {
  constructor(private readonly db: Sqlite) {}

  record(input: UsageRecord): number {
    const hasPricing = input.priceIn !== null && input.priceOut !== null;
    const cost = hasPricing
      ? (pricedInputTokens(input) * input.priceIn! +
          input.outputTokens * input.priceOut! +
          input.cacheReadTokens * (input.priceCacheRead ?? 0) +
          input.cacheWriteTokens * (input.priceCacheWrite ?? 0)) /
        1_000_000
      : 0;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO usage_ledger(ts,turn_id,agent_run_id,span_id,chat_id,user_id,provider_id,model_id,model_alias,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,finish_reason,ok,error_kind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          Date.now(),
          input.turnId,
          input.agentRunId ?? null,
          input.spanId ?? null,
          input.chatId,
          input.userId,
          input.providerId,
          input.modelId,
          input.modelAlias,
          input.inputTokens,
          input.outputTokens,
          input.cacheReadTokens,
          input.cacheWriteTokens,
          input.reasoningTokens,
          cost,
          input.latencyMs,
          input.finishReason ?? null,
          input.ok ? 1 : 0,
          input.errorKind ?? (hasPricing ? null : "no_pricing"),
        );
      this.db
        .prepare(
          "UPDATE turns SET cost_usd=cost_usd+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,model_calls=model_calls+1 WHERE id=?",
        )
        .run(cost, input.inputTokens, input.outputTokens, input.turnId);
    })();
    return cost;
  }

  turnCost(turnId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd),0) AS value FROM usage_ledger WHERE turn_id=?",
      )
      .get(turnId) as { value: number };
    return row.value;
  }

  /**
   * 一个本地窗口内的合计，供 `/usage` 使用。与 `report()` 读同一张表、用同一个时区修饰符：
   * 此前 `/usage` 读的是 `turns`，而试跑（`agents.createDryRun()`）写 ledger 却不建 turns 行，
   * 于是只要在 WebUI 上试跑过一次，`/usage`、用量页与 ledger 聚合三者相等就永久不成立
   * （实测差 0.0001008 美元，精确对应两行 `turn_id=dryrun:…`，docs/29 · M-QUOTA-01）。
   *
   * 窗口两端都在 SQL 里用同一个表达式计算，不在 JS 侧折算出 from/to 再传入：那样日界要靠
   * 两份实现各自算对，正是 `report()` 上方那段注释所指的问题。
   */
  summary(
    window: "day" | "month",
    timezone: string,
    filter: { chatId?: string; userId?: string } = {},
  ): {
    costUsd: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  } {
    const format = window === "day" ? "%Y-%m-%d" : "%Y-%m";
    const modifier = sqliteTimezoneModifier(timezone);
    const conditions = [
      "strftime(?,ts/1000,'unixepoch',?)=strftime(?,'now',?)",
    ];
    const parameters: unknown[] = [format, modifier, format, modifier];
    if (filter.chatId !== undefined) {
      conditions.push("chat_id=?");
      parameters.push(filter.chatId);
    }
    if (filter.userId !== undefined) {
      conditions.push("user_id=?");
      parameters.push(filter.userId);
    }
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS costUsd,COUNT(DISTINCT turn_id) AS turns,
      COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens
      FROM usage_ledger WHERE ${conditions.join(" AND ")}`,
      )
      .get(...parameters) as {
      costUsd: number;
      turns: number;
      inputTokens: number;
      outputTokens: number;
    };
  }

  /**
   * @param timezone 按本地日分桶。此前这里是裸的 `strftime('%Y-%m-%d', ts/1000, 'unixepoch')`，
   *   即 UTC，而总览趋势（`OperationsRepository.dashboard`）与配额窗口（`quotaBucket`）都按
   *   `general.timezone` 分日：东八区部署中用量报表的 8 月 18 日实为本地 18 日 08:00 至 19 日
   *   08:00，两个页面对同一天给出两个数字，而这正是运维核对账单时会遇到的问题（docs/27 · C-02）。
   *   偏移取 `to` 时刻的值，与 `dashboard` 共用 `sqliteTimezoneModifier`（DST 折中见该处）。
   */
  report(
    from: number,
    to: number,
    groupBy: "day" | "chat" | "user" | "model" | "alias" | "agent" | "provider",
    timezone = "UTC",
  ): unknown[] {
    const expressions: Record<typeof groupBy, string> = {
      day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', ?)",
      chat: "chat_id",
      user: "user_id",
      model: "model_id",
      alias: "model_alias",
      agent: "agent_run_id",
      provider: "provider_id",
    };
    const parameters =
      groupBy === "day"
        ? [sqliteTimezoneModifier(timezone, new Date(to)), from, to]
        : [from, to];
    // `cache_read_tokens` 一直在写入，只是从未被聚合，而判断某家上游的缓存是否真实生效
    // 只有 `cacheReadTokens / inputTokens` 这一个指标能回答。缺少它时只能翻 JSONL 反推
    // 请求体、逐轮对比前缀（那次排查耗时两小时），因此它与 provider 维度是一并加入的。
    // 这个比值是 `input_tokens` 存 total 而非存计价用的 noCache 的唯一理由：
    // 计价口径与观测口径在这一列上是两件事，改存 noCache 会让命中率恒为 0（`pricedInputTokens`）。
    return this.db
      .prepare(
        `SELECT ${expressions[groupBy]} AS bucket,SUM(cost_usd) AS costUsd,SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,SUM(cache_read_tokens) AS cacheReadTokens,SUM(cache_write_tokens) AS cacheWriteTokens,
      COUNT(*) AS calls,SUM(ok) AS successes FROM usage_ledger WHERE ts BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`,
      )
      .all(...parameters);
  }
}
