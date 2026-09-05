import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeDatabase, migrateDatabase, openDatabase, type Sqlite } from "@luoli/db";
import { UsageLedger, issueApiKey, runMainAgent } from "@luoli/core";
import { startTestRuntime, type TestRuntime } from "./support/runtime.js";
import { startFakeUpstream, type FakeUpstream } from "./support/upstream.js";

/**
 * docs/12-sdk.md T3.9（`usage_ledger` 记来源）。验收（plan 第 496 行）：一次 SDK 轮次后能按
 * `source_id` 聚合出该次花费；`purge` 该会话后聚合值不变；Telegram 侧聚合值不变。
 */

async function setupModelWithUrl(runtime: TestRuntime, baseUrl: string): Promise<void> {
  const providerId = runtime.deps.providers.save({
    name: "fake",
    kind: "openai-compatible",
    baseUrl,
    apiKey: "sk-fake-0123456789abcdef",
  });
  const now = Date.now();
  const modelRowId = `${providerId}:fake-model`;
  runtime.db
    .prepare(
      `INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,128000,4096,'{}',1,2,1,0,?,?)`,
    )
    .run(modelRowId, providerId, "fake-model", now, now);
  runtime.db
    .prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)")
    .run("main", JSON.stringify([modelRowId]), now);
  runtime.deps.rebuildModels();
}

async function setupModel(runtime: TestRuntime, upstream: FakeUpstream): Promise<void> {
  return setupModelWithUrl(runtime, upstream.url);
}

function issueSource(runtime: TestRuntime, name: string): { sourceId: string; token: string } {
  const created = runtime.deps.sources.create(name);
  const issued = issueApiKey({
    apiKeys: runtime.deps.apiKeys,
    secrets: runtime.deps.secrets,
    sourceId: created.id,
  });
  return { sourceId: created.id, token: issued.token };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createSession(
  runtime: TestRuntime,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await runtime.server.request("/sdk/v1/sessions", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function sendMessage(
  runtime: TestRuntime,
  token: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await runtime.server.request(`/sdk/v1/sessions/${chatId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * 「Telegram 侧轮次」按 `tests/runtime.turn.test.ts` 同一手法：`openTurn` 不传 `sourceId`
 * （该测试装置没有 `slots.bot`，走不了 `bot.ts`/`ScheduledJobRunner` 的完整入口），
 * `runMainAgent` 的依赖对象同样照抄 `apps/bot/src/compose.ts` 的 `runAgent` 闭包。
 * `turn.sourceId` 全程未被赋值，落 `usage_ledger` 时按 `TELEGRAM_SOURCE_ID` 回落——
 * 与生产环境里 `bot.ts`/`runner.ts` 触发的真实轮次同一条件（这两条路径本任务未改动）。
 */
async function runTelegramTurn(
  runtime: TestRuntime,
  chatId: string,
  text: string,
): Promise<string> {
  const key = `chat:${chatId}`;
  const scoped = runtime.deps.archive.scope(chatId, null);
  const trigger = scoped.append({
    chatId,
    messageThreadId: null,
    tgMessageId: 1,
    direction: "in",
    fromKind: "user",
    fromUserId: "u1",
    fromName: "阿离",
    fromUsername: null,
    kind: "text",
    text,
    tgDate: Date.now(),
    raw: {},
    triggered: false,
    triggerReason: null,
  });
  const turn = await runtime.deps.context.openTurn({
    chatId,
    threadId: null,
    key,
    initiatorUserId: "u1",
    effectiveRole: "trusted",
    isPrivate: true,
    trigger,
    abortSignal: new AbortController().signal,
    config: runtime.config,
  });
  runtime.deps.turns.create({
    id: turn.turnId,
    key,
    chatId,
    threadId: null,
    userId: "u1",
    role: "trusted",
    triggerMessageId: trigger.id,
    triggerReason: "trigger",
    baseCommitId: turn.baseCommitId,
  });
  const answer = await runMainAgent(turn, {
    config: runtime.config,
    db: runtime.db,
    registry: runtime.deps.modelRegistry,
    tools: runtime.deps.toolRegistry,
    prompts: runtime.deps.promptAssembler,
    documents: runtime.deps.promptDocuments,
    skills: runtime.deps.skills,
    plugins: runtime.deps.plugins,
    agents: runtime.deps.agents,
    customTools: runtime.deps.customTools,
    containers: runtime.deps.containers,
    ledger: runtime.deps.ledger,
    context: runtime.deps.context,
    quota: runtime.deps.quota,
    reservation: null,
    log: runtime.deps.log,
    turns: runtime.deps.turns,
    workspace: resolve(runtime.config.sandbox.workspaceDir, chatId),
  });
  runtime.deps.context.appendDelta(turn, {
    id: turn.turnId,
    role: "assistant",
    origin: "assistant",
    parts: [{ type: "text", text: answer }],
    textPreview: answer.slice(0, 240),
    pruneLevel: 0,
  });
  const committed = await runtime.deps.context.commitTurn(turn);
  runtime.deps.turns.finish(turn.turnId, {
    state: "committed",
    commitId: committed.commit.id,
    rebased: committed.rebased,
  });
  return turn.turnId;
}

describe("usage_ledger 记 source_id（T3.9，plan 第 492–496 行）", () => {
  it("SDK 轮次按 source_id 聚合出该次花费；purge 后聚合值/行数不变；Telegram 侧轮次隔离且不受影响", async () => {
    const upstream = await startFakeUpstream("好的，收到。");
    const runtime = await startTestRuntime("sdk-usage-source");
    try {
      await setupModel(runtime, upstream);
      const { sourceId, token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      expect(created.status).toBe(200);
      const chatId = (created.json.session as { id: string }).id;

      // ① 一次 SDK 轮次后，按 source_id 聚合出的花费与 turnUsage(turnId) 一致。
      const sent = await sendMessage(runtime, token, chatId, {
        endUserId: "end-user-1",
        text: "记住一个暗号：紫色茶壶",
      });
      expect(sent.status).toBe(200);
      const sentJson = sent.json as { ok: boolean; turnId: string };
      expect(sentJson.ok).toBe(true);
      const sdkTurnId = sentJson.turnId;

      const turnUsage = runtime.deps.ledger.turnUsage(sdkTurnId);
      expect(turnUsage.costUsd).toBeGreaterThan(0);
      const sdkAggregateBefore = runtime.deps.ledger.sourceUsage(sourceId);
      expect(sdkAggregateBefore).toEqual(turnUsage);
      // 与 plan 验收原文对应的裸 SQL 复核：按 source_id 聚合的 cost_usd 之和同样等于这次花费。
      const rawCost = runtime.db
        .prepare("SELECT COALESCE(SUM(cost_usd),0) AS value FROM usage_ledger WHERE source_id=?")
        .get(sourceId) as { value: number };
      expect(rawCost.value).toBeCloseTo(turnUsage.costUsd, 12);

      const rowCountBefore = runtime.db
        .prepare("SELECT COUNT(*) FROM usage_ledger WHERE source_id=?")
        .pluck()
        .get(sourceId) as number;
      expect(rowCountBefore).toBeGreaterThan(0);

      // ② purge 该会话后，同一聚合值与行数不变——usage_ledger 不在 purge 的删除面内（docs/03 §2.15）。
      const purged = await runtime.server.request(`/sdk/v1/sessions/${chatId}/purge`, {
        method: "POST",
        headers: authHeaders(token),
      });
      expect(purged.status).toBe(200);
      expect(runtime.db.prepare("SELECT 1 FROM contexts WHERE key=?").get(`chat:${chatId}`)).toBeUndefined();

      const sdkAggregateAfterPurge = runtime.deps.ledger.sourceUsage(sourceId);
      expect(sdkAggregateAfterPurge).toEqual(sdkAggregateBefore);
      const rowCountAfterPurge = runtime.db
        .prepare("SELECT COUNT(*) FROM usage_ledger WHERE source_id=?")
        .pluck()
        .get(sourceId) as number;
      expect(rowCountAfterPurge).toBe(rowCountBefore);

      // ③ 同库内跑一条 Telegram 侧轮次：source_id='telegram' 的聚合只含这条轮次，不含 SDK 那条；
      //    且 SDK 聚合值（purge 之后）仍然不变——两个来源互不污染。
      const tgTurnId = await runTelegramTurn(runtime, "tg-chat-1", "早上好");
      const tgTurnUsage = runtime.deps.ledger.turnUsage(tgTurnId);
      expect(tgTurnUsage.costUsd).toBeGreaterThan(0);

      const telegramAggregate = runtime.deps.ledger.sourceUsage("telegram");
      // 与 tgTurnUsage 逐字段相等即证明「只含这一条轮次」：SDK 那次花费若混进了 'telegram'
      // 桶，聚合值会比单条 tgTurnUsage 大，这个等值断言与下面的行数断言一起排除了污染。
      expect(telegramAggregate).toEqual(tgTurnUsage);
      const telegramRowCount = runtime.db
        .prepare("SELECT COUNT(*) FROM usage_ledger WHERE source_id='telegram'")
        .pluck()
        .get() as number;
      // Telegram 桶里只有这一条轮次产生的行，不多不少。
      const telegramTurnRowCount = runtime.db
        .prepare("SELECT COUNT(*) FROM usage_ledger WHERE turn_id=?")
        .pluck()
        .get(tgTurnId) as number;
      expect(telegramRowCount).toBe(telegramTurnRowCount);

      // SDK 聚合值仍然不受 Telegram 轮次影响。
      const sdkAggregateFinal = runtime.deps.ledger.sourceUsage(sourceId);
      expect(sdkAggregateFinal).toEqual(sdkAggregateBefore);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("UsageLedger.record() 不传 sourceId 时列为 NULL（不落 'telegram' 假值）", () => {
  function database(name: string): { db: Sqlite; close: () => void } {
    const path = `./data/${name}.test.db`;
    for (const suffix of ["", "-wal", "-shm", "-logs", "-logs-wal", "-logs-shm"])
      rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    return { db, close: () => closeDatabase(db) };
  }

  it("record() 省略 sourceId：usage_ledger.source_id 落 NULL，不猜测成 'telegram'", () => {
    const { db, close } = database("sdk-usage-record-null");
    db.prepare(
      "INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES (?,?,?,?,?,?)",
    ).run("turn-no-source", "chat:1", "1", "1", "owner", "running");
    const ledger = new UsageLedger(db);
    ledger.record({
      turnId: "turn-no-source",
      chatId: "1",
      userId: "1",
      providerId: "p",
      modelId: "m",
      modelAlias: "main",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      priceIn: 1,
      priceOut: 1,
      priceCacheRead: 0,
      priceCacheWrite: 0,
      latencyMs: 1,
      ok: true,
    });
    const row = db
      .prepare("SELECT source_id AS sourceId FROM usage_ledger WHERE turn_id=?")
      .get("turn-no-source") as { sourceId: string | null };
    expect(row.sourceId).toBeNull();
    close();
  });

  it("record() 传 sourceId：原样落库", () => {
    const { db, close } = database("sdk-usage-record-with-source");
    db.prepare(
      "INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES (?,?,?,?,?,?)",
    ).run("turn-with-source", "chat:1", "1", "1", "owner", "running");
    const ledger = new UsageLedger(db);
    ledger.record({
      turnId: "turn-with-source",
      chatId: "1",
      userId: "1",
      providerId: "p",
      modelId: "m",
      modelAlias: "main",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      priceIn: 1,
      priceOut: 1,
      priceCacheRead: 0,
      priceCacheWrite: 0,
      latencyMs: 1,
      ok: true,
      sourceId: "src-abc",
    });
    const row = db
      .prepare("SELECT source_id AS sourceId FROM usage_ledger WHERE turn_id=?")
      .get("turn-with-source") as { sourceId: string | null };
    expect(row.sourceId).toBe("src-abc");
    expect(ledger.sourceUsage("src-abc").inputTokens).toBe(10);
    close();
  });
});
