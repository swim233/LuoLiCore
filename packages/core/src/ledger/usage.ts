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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

export class UsageLedger {
  constructor(private readonly db: Sqlite) {}

  record(input: UsageRecord): number {
    const hasPricing = input.priceIn !== null && input.priceOut !== null;
    const cost = hasPricing
      ? (input.inputTokens * input.priceIn! + input.outputTokens * input.priceOut! + input.cacheReadTokens * (input.priceCacheRead ?? 0) + input.cacheWriteTokens * (input.priceCacheWrite ?? 0)) / 1_000_000
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

  report(from: number, to: number, groupBy: 'day' | 'chat' | 'user' | 'model' | 'alias' | 'agent'): unknown[] {
    const expressions: Record<typeof groupBy, string> = {
      day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')", chat: 'chat_id', user: 'user_id', model: 'model_id', alias: 'model_alias', agent: 'agent_run_id',
    };
    return this.db.prepare(`SELECT ${expressions[groupBy]} AS bucket,SUM(cost_usd) AS costUsd,SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,COUNT(*) AS calls,SUM(ok) AS successes FROM usage_ledger WHERE ts BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`).all(from, to);
  }
}
