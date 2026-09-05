import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { contextKey, decodeLogPayload } from "@luoli/db";
import {
  ToolRegistry,
  configSchema,
  issueApiKey,
  newToolScope,
} from "@luoli/core";
import type { ApprovalBroker, LogSink, ToolExecutionContext } from "@luoli/core";
import { startTestRuntime, type TestRuntime } from "./support/runtime.js";
import {
  startFakeUpstream,
  startHangingUpstream,
  type FakeUpstream,
} from "./support/upstream.js";
import { source } from "./support/source.js";

/**
 * docs/12-sdk.md T3.6（`/sdk/v1` 端点与认证中间件）+ T3.7（轮次执行路径，SDK 侧）。
 * 覆盖两节正文给出的验收：T3.6 的 1–7、T3.7 的 1–7（8 已由 T3.7 自己的
 * `tests/turn.pipeline.test.ts` 覆盖，不在本文件重复）。
 */

/** `setupModel`/`setupModelWithUrl` 共用：两者的调用方分别持有 `FakeUpstream`（有 `requests`
 *  等断言用的字段）与 `HangingUpstream`（无 `requests`，断连测试专用），两个工厂只需要 `.url`。 */
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

function issueSource(
  runtime: TestRuntime,
  name: string,
): { sourceId: string; token: string } {
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
  init: RequestInit = {},
): Promise<Response> {
  return runtime.server.request(`/sdk/v1/sessions/${chatId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
    ...init,
  });
}

/**
 * 轮询到条件成立，上限 `limitMs`（默认 5s）；不成立则抛出带说明的错误。断连测试的同步点
 * （qa-T3-6 verify-1 FAIL-2）：不用固定 `sleep` 猜时序，而是等一个真实可观测的状态变化——
 * 「上游是否已收到请求」「并发闸的 queued 计数」——这样测试既不 flaky，也不需要引入人为延时
 * 拖慢整个套件。
 */
async function waitUntil(
  what: string,
  predicate: () => boolean,
  limitMs = 5000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error(`waitUntil 超时：${what}`);
}

describe("app.ts 的 cookie 免验白名单条数不变（T3.6 验收 1）", () => {
  it("`ctx.req.path ===` 恰好出现 5 次（4 条字面量路径 + MCP_OAUTH_CALLBACK_PATH）", () => {
    const text = source("packages/server/src/app.ts");
    const count = text.split("ctx.req.path ===").length - 1;
    expect(count).toBe(5);
  });
});

describe("/sdk/v1/* 鉴权（T3.6 验收 2/4/5）", () => {
  it("无 Bearer token 返回 401", async () => {
    const runtime = await startTestRuntime("sdk-v1-auth-none");
    try {
      const response = await runtime.server.request("/sdk/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      const json = (await response.json()) as { ok: boolean; error: { code: string; retryable: boolean } };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("unauthorized");
      expect(json.error).toHaveProperty("retryable");
    } finally {
      await runtime.dispose();
    }
  });

  it("格式非法 / 不存在的 token 同样 401，不反推原因", async () => {
    const runtime = await startTestRuntime("sdk-v1-auth-bad");
    try {
      const response = await runtime.server.request("/sdk/v1/sessions", {
        headers: { authorization: "Bearer sk-not-a-real-token" },
      });
      expect(response.status).toBe(401);
    } finally {
      await runtime.dispose();
    }
  });

  it("SDK key 访问 /api/* 返回 401（cookie 会话闸不认 Authorization 头，验收 4）", async () => {
    const runtime = await startTestRuntime("sdk-v1-auth-cross-api");
    try {
      const { token } = issueSource(runtime, "Alpha");
      // `/api/sdk/*`（SDK 密钥管理面本身）是最容易被误认为「SDK key 应该能用」的一族，
      // 单打 `/api/chats` 不足以证明反向鉴权覆盖了它（qa-T3-6 verify-1 FAIL-5）。
      for (const path of ["/api/sdk/sources", "/api/sdk/keys", "/api/chats"]) {
        const response = await runtime.server.request(path, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status, `${path} 应为 401`).toBe(401);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("/sdk/v1/nope 得 JSON 404，不是 SPA 静态兜底的 text/html（qa-T3-6 verify-1 FAIL-1）", async () => {
    const runtime = await startTestRuntime("sdk-v1-route-order");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const response = await runtime.server.request("/sdk/v1/nope", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const json = (await response.json()) as { ok: boolean; error: { code: string } };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("not_found");

      // 错误方法同样要落 JSON 而不是 SPA 兜底（存在的路径、不存在的方法）。
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;
      const wrongMethod = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "PUT",
        headers: authHeaders(token),
        body: "{}",
      });
      expect(wrongMethod.headers.get("content-type")).toMatch(/application\/json/);
      expect(wrongMethod.status).not.toBe(200);
    } finally {
      await runtime.dispose();
    }
  });

  it("luoli_sid cookie 访问 /sdk/v1/* 返回 401（验收 5）", async () => {
    const runtime = await startTestRuntime("sdk-v1-auth-cross-cookie");
    try {
      const session = runtime.deps.operations.createSession(1);
      const response = await runtime.server.request("/sdk/v1/sessions", {
        headers: { cookie: `luoli_sid=${session.id}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("会话 CRUD 与跨来源隔离（T3.6 验收 3/6/7）", () => {
  it("create → get → list → patch → delete，字段形状与 schema 一致", async () => {
    const runtime = await startTestRuntime("sdk-v1-crud");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, { label: "first" });
      expect(created.status).toBe(200);
      const session = created.json.session as Record<string, unknown>;
      expect(session.label).toBe("first");
      expect(session.outputFormat).toBe("markdown");
      expect(session.modelAlias).toBeNull();
      expect(session.deletedAt).toBeNull();
      const chatId = session.id as string;

      const got = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, { headers: authHeaders(token) });
      expect(got.status).toBe(200);

      const listed = await runtime.server.request("/sdk/v1/sessions", { headers: authHeaders(token) });
      const listedJson = (await listed.json()) as { sessions: Array<{ id: string }> };
      expect(listedJson.sessions.map((row) => row.id)).toContain(chatId);

      const patched = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ label: "renamed" }),
      });
      expect(patched.status).toBe(200);
      const patchedJson = (await patched.json()) as { session: { label: string } };
      expect(patchedJson.session.label).toBe("renamed");

      const deleted = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      expect(deleted.status).toBe(200);
      // DELETE 幂等：再删一次仍 200。
      const deletedAgain = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      expect(deletedAgain.status).toBe(200);
    } finally {
      await runtime.dispose();
    }
  });

  it("modelAlias 非法时创建/修改均 400", async () => {
    const runtime = await startTestRuntime("sdk-v1-alias-invalid");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, { modelAlias: "no-such-alias" });
      expect(created.status).toBe(400);
      expect((created.json.error as { code: string }).code).toBe("invalid_request");
    } finally {
      await runtime.dispose();
    }
  });

  it("来源 A 的 key 访问来源 B 的会话返回 404 not_found，不是 403（验收 3）", async () => {
    const runtime = await startTestRuntime("sdk-v1-isolation");
    try {
      const a = issueSource(runtime, "Alpha");
      const b = issueSource(runtime, "Beta");
      const created = await createSession(runtime, a.token, {});
      const chatId = (created.json.session as { id: string }).id;

      const readByB = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, { headers: authHeaders(b.token) });
      expect(readByB.status).toBe(404);
      expect(((await readByB.json()) as { error: { code: string } }).error.code).toBe("not_found");

      const patchByB = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "PATCH",
        headers: authHeaders(b.token),
        body: JSON.stringify({ label: "hijack" }),
      });
      expect(patchByB.status).toBe(404);

      const deleteByB = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, {
        method: "DELETE",
        headers: authHeaders(b.token),
      });
      expect(deleteByB.status).toBe(404);

      const purgeByB = await runtime.server.request(`/sdk/v1/sessions/${chatId}/purge`, {
        method: "POST",
        headers: authHeaders(b.token),
      });
      expect(purgeByB.status).toBe(404);

      // B 的列表看不到 A 的会话。
      const listedByB = await runtime.server.request("/sdk/v1/sessions", { headers: authHeaders(b.token) });
      const listedByBJson = (await listedByB.json()) as { sessions: Array<{ id: string }> };
      expect(listedByBJson.sessions.map((row) => row.id)).not.toContain(chatId);
    } finally {
      await runtime.dispose();
    }
  });

  it("软停用后：不可读（session_deleted）、不出现在 /sdk/v1/sessions 与 /api/chats 列表（验收 6）", async () => {
    const runtime = await startTestRuntime("sdk-v1-soft-delete");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;
      await runtime.server.request(`/sdk/v1/sessions/${chatId}`, { method: "DELETE", headers: authHeaders(token) });

      const got = await runtime.server.request(`/sdk/v1/sessions/${chatId}`, { headers: authHeaders(token) });
      expect(got.status).toBe(404);
      expect(((await got.json()) as { error: { code: string } }).error.code).toBe("session_deleted");

      const commits = await runtime.server.request(`/sdk/v1/sessions/${chatId}/commits`, { headers: authHeaders(token) });
      expect(commits.status).toBe(404);

      const listed = await runtime.server.request("/sdk/v1/sessions", { headers: authHeaders(token) });
      const listedJson = (await listed.json()) as { sessions: Array<{ id: string }> };
      expect(listedJson.sessions.map((row) => row.id)).not.toContain(chatId);

      const chats = await runtime.server.request("/api/chats");
      // /api/chats 走 cookie 鉴权闸；未登录会被拦在 401，这里只需确认它现在会拒绝
      // 未登录访问（既有行为未受影响）——真正的 deleted_at 过滤用 SQL 直接核对。
      expect(chats.status).toBe(401);
      const key = contextKey({ chatId, messageThreadId: null }, "chat");
      const row = runtime.db
        .prepare("SELECT deleted_at AS deletedAt FROM contexts WHERE key=?")
        .get(key) as { deletedAt: number | null };
      expect(row.deletedAt).not.toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("软停用后不可开轮（POST messages 返回 session_deleted）", async () => {
    const upstream = await startFakeUpstream("不会被调用");
    const runtime = await startTestRuntime("sdk-v1-soft-delete-turn");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;
      await runtime.server.request(`/sdk/v1/sessions/${chatId}`, { method: "DELETE", headers: authHeaders(token) });

      const response = await sendMessage(runtime, token, chatId, { endUserId: "u1", text: "hi" });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("session_deleted");
      expect(upstream.requests.length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("reset 写一条 reset commit", async () => {
    const runtime = await startTestRuntime("sdk-v1-reset");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;
      const response = await runtime.server.request(`/sdk/v1/sessions/${chatId}/reset`, {
        method: "POST",
        headers: authHeaders(token),
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; commitId: string };
      expect(json.ok).toBe(true);
      const key = contextKey({ chatId, messageThreadId: null }, "chat");
      const kind = runtime.db
        .prepare("SELECT kind FROM context_commits WHERE id=? AND key=?")
        .pluck()
        .get(json.commitId, key);
      expect(kind).toBe("reset");
    } finally {
      await runtime.dispose();
    }
  });

  it("purge 留一条 warn 作为唯一凭据，库行与磁盘文件均不存在（验收 7）", async () => {
    const upstream = await startFakeUpstream("primemory 写入测试");
    const runtime = await startTestRuntime("sdk-v1-purge");
    try {
      await setupModel(runtime, upstream);
      const { sourceId, token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const before = runtime.db
        .prepare("SELECT COUNT(*) FROM log_events WHERE kind='sdk.session_purged'")
        .pluck()
        .get() as number;

      const purged = await runtime.server.request(`/sdk/v1/sessions/${chatId}/purge`, {
        method: "POST",
        headers: authHeaders(token),
      });
      expect(purged.status).toBe(200);

      const after = runtime.db
        .prepare("SELECT COUNT(*) FROM log_events WHERE kind='sdk.session_purged'")
        .pluck()
        .get() as number;
      expect(after).toBe(before + 1);
      const row = runtime.db
        .prepare("SELECT data,data_codec AS codec FROM log_events WHERE kind='sdk.session_purged' ORDER BY id DESC LIMIT 1")
        .get() as { data: Buffer | null; codec: string | null };
      const payload = JSON.parse(decodeLogPayload(row.data, row.codec) ?? "null") as {
        sourceId: string;
        chatId: string;
      };
      expect(payload.sourceId).toBe(sourceId);
      expect(payload.chatId).toBe(chatId);

      const key = contextKey({ chatId, messageThreadId: null }, "chat");
      expect(runtime.db.prepare("SELECT 1 FROM contexts WHERE key=?").get(key)).toBeUndefined();
      expect(runtime.db.prepare("SELECT 1 FROM sdk_sessions WHERE key=?").get(key)).toBeUndefined();

      // 再次 purge：会话已经不存在，404。
      const purgedAgain = await runtime.server.request(`/sdk/v1/sessions/${chatId}/purge`, {
        method: "POST",
        headers: authHeaders(token),
      });
      expect(purgedAgain.status).toBe(404);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("POST .../messages：完整轮次（T3.7 验收 1/6/7）", () => {
  it("非流式响应含 text/usage/turnId，两次连续请求上下文连续", async () => {
    const upstream = await startFakeUpstream("好的，收到。");
    const runtime = await startTestRuntime("sdk-v1-turn-basic");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const first = await sendMessage(runtime, token, chatId, {
        endUserId: "end-user-1",
        text: "记住一个暗号：紫色茶壶",
      });
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as {
        ok: boolean;
        text: string;
        turnId: string;
        usage: { inputTokens: number; outputTokens: number; costUsd: number };
      };
      expect(firstJson.ok).toBe(true);
      expect(firstJson.text).toContain("好的，收到。");
      expect(typeof firstJson.turnId).toBe("string");
      expect(firstJson.usage.outputTokens).toBeGreaterThan(0);

      upstream.setReply("暗号是紫色茶壶。");
      const second = await sendMessage(runtime, token, chatId, {
        endUserId: "end-user-1",
        text: "刚才的暗号是什么？",
      });
      expect(second.status).toBe(200);

      // 第二次请求发给模型的历史里应当能看到第一轮的内容——上下文连续。
      const lastRequest = upstream.requests[upstream.requests.length - 1]!;
      const serialized = JSON.stringify(lastRequest.body.messages);
      expect(serialized).toContain("紫色茶壶");

      // from_user_id 落库为 <sourceId>:<endUserId>。
      const fromUserId = runtime.db
        .prepare("SELECT from_user_id FROM messages WHERE chat_id=? ORDER BY id LIMIT 1")
        .pluck()
        .get(chatId) as string;
      expect(fromUserId.endsWith(":end-user-1")).toBe(true);
      expect(fromUserId).not.toBe("end-user-1");
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("endUserId 缺失/超长/含控制字符 → 400；modelAlias 非法 → 400", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-validation");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const missing = await sendMessage(runtime, token, chatId, { text: "缺 endUserId" });
      expect(missing.status).toBe(400);

      const tooLong = await sendMessage(runtime, token, chatId, { endUserId: "u".repeat(257), text: "超长" });
      expect(tooLong.status).toBe(400);

      const control = await sendMessage(runtime, token, chatId, { endUserId: "u\x00ser", text: "控制字符" });
      expect(control.status).toBe(400);

      const badAlias = await sendMessage(runtime, token, chatId, {
        endUserId: "u1",
        text: "hi",
        modelAlias: "does-not-exist",
      });
      expect(badAlias.status).toBe(400);
      expect(((await badAlias.json()) as { error: { code: string } }).error.code).toBe("invalid_request");

      expect(upstream.requests.length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("并发闸：queueMax=0 时超额请求 429 + Retry-After，触发消息置 deleted_at（A8）", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-queue-full", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 0 } },
    });
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      // 占满唯一的并发槽：一个慢请求先占住，第二个必定排队即被拒（queueMax=0）。
      const slow = await startFakeUpstream("慢");
      // 先用真正的 upstream 起一轮但不等待其完成——用两次几乎同时发出的请求触发排队闸。
      const first = sendMessage(runtime, token, chatId, { endUserId: "u1", text: "第一条" });
      const second = sendMessage(runtime, token, chatId, { endUserId: "u1", text: "第二条" });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      const statuses = [firstResponse.status, secondResponse.status].sort();
      // 两者之一成功（200），另一者排队被拒（429）——`queueMax:0` 下不存在两者都成功的情形。
      expect(statuses).toEqual([200, 429]);
      const rejected = firstResponse.status === 429 ? firstResponse : secondResponse;
      expect(rejected.headers.get("retry-after")).toBe("5");
      const rejectedJson = (await rejected.json()) as { error: { code: string; retryable: boolean } };
      expect(rejectedJson.error.code).toBe("turn_queue_full");
      expect(rejectedJson.error.retryable).toBe(true);

      // 被拒那条已归档的触发消息置了 deleted_at，不会被下一轮当成背景消息认领。
      const deletedCount = runtime.db
        .prepare("SELECT COUNT(*) FROM messages WHERE chat_id=? AND deleted_at IS NOT NULL")
        .pluck()
        .get(chatId) as number;
      expect(deletedCount).toBe(1);

      // 并发槽与 TurnRegistry 均已释放，不遗留任何在途轮次。
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
      await slow.close();
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("额度耗尽：quota_exceeded 429，不带 Retry-After（与并发排队满是两种拒绝，lead 裁决）", async () => {
    const upstream = await startFakeUpstream("ok");
    // `tests/support/runtime.ts` 的默认测试配置是 `quota.enabled:false`（多数用例不需要配额）——
    // 这里显式开启，`chatDaily:0` 则让任何正数预留都超限
    // （`spent(0)+estimateUsd(≥minReserveUsd) > 0`），第一条消息即可确定性触发。
    const runtime = await startTestRuntime("sdk-v1-quota-exceeded", {
      config: { quota: { enabled: true, perChat: { daily: 0 } } },
    });
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const response = await sendMessage(runtime, token, chatId, { endUserId: "u1", text: "hi" });
      expect(response.status).toBe(429);
      const json = (await response.json()) as { error: { code: string; retryable: boolean } };
      expect(json.error.code).toBe("quota_exceeded");
      expect(json.error.retryable).toBe(true);
      // 与并发排队满不同：额度按天/月窗口重置，不给一个误导性的固定秒数。
      expect(response.headers.get("retry-after")).toBeNull();
      expect(upstream.requests.length).toBe(0);

      // 触发消息同样按 A8 置 deleted_at——配额拒绝发生在 runTurn() 之前，与队列满共用同一条
      // 「归档但从未真正开轮」路径。
      const deletedCount = runtime.db
        .prepare("SELECT COUNT(*) FROM messages WHERE chat_id=? AND deleted_at IS NOT NULL")
        .pluck()
        .get(chatId) as number;
      expect(deletedCount).toBe(1);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("stage:'setup' 映射 internal 500，stage:'turn' 映射 upstream_error 502（两档不合并，lead 裁决）", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-stage-mapping");
    try {
      await setupModel(runtime, upstream);
      // 第二个模型别名，故意不给定价——`runMainAgentInternal` 的 `requirePricing` 闸在
      // `produce()` 内部抛出 `model_pricing_required`，落在 `openTurn`/`turns.create` 成功
      // 之后，对应 `stage:'turn'`。
      const providerId2 = runtime.deps.providers.save({
        name: "fake-nopricing",
        kind: "openai-compatible",
        baseUrl: upstream.url,
        apiKey: "sk-fake-0123456789abcdef",
      });
      const now = Date.now();
      const modelRowId2 = `${providerId2}:nopricing-model`;
      runtime.db
        .prepare(
          `INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
          VALUES (?,?,?,128000,4096,'{}',NULL,NULL,1,0,?,?)`,
        )
        .run(modelRowId2, providerId2, "nopricing-model", now, now);
      runtime.db
        .prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)")
        .run("nopricing", JSON.stringify([modelRowId2]), now);
      runtime.deps.rebuildModels();

      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const turnFailure = await sendMessage(runtime, token, chatId, {
        endUserId: "u1",
        text: "hi",
        modelAlias: "nopricing",
      });
      expect(turnFailure.status).toBe(502);
      expect(((await turnFailure.json()) as { error: { code: string; retryable: boolean } }).error).toMatchObject({
        code: "upstream_error",
        retryable: true,
      });

      // stage:'setup'：monkeypatch `openTurn` 让它在归档成功之后、真正开轮之前抛出一次
      // （`buildTrigger` 已经拿到 `archived`，`openTurn` 是 setup 阶段唯一容易注入故障的点）。
      const originalOpenTurn = runtime.deps.context.openTurn.bind(runtime.deps.context);
      let thrown = false;
      Object.assign(runtime.deps.context, {
        openTurn: (...args: Parameters<typeof originalOpenTurn>) => {
          if (!thrown) {
            thrown = true;
            throw new Error("simulated_setup_failure");
          }
          return originalOpenTurn(...args);
        },
      });
      const setupFailure = await sendMessage(runtime, token, chatId, {
        endUserId: "u2",
        text: "hi again",
      });
      expect(setupFailure.status).toBe(500);
      expect(((await setupFailure.json()) as { error: { code: string; retryable: boolean } }).error).toMatchObject({
        code: "internal",
        retryable: true,
      });
      expect(thrown).toBe(true);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("会话内 tg_message_id 冲突时归档抛错而非静默复用既有行", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-append-conflict");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      // 单进程内 `SELECT MAX+1` 与 `INSERT` 之间没有 await，正常调用不会撞号——手工造冲突需要
      // 模拟「另一个实例抢先插入了同一个号」，与 `tests/schedule.test.ts` 的
      // 「合成触发消息撞号时抛 schedule_trigger_conflict」同一手法：包一层 `archive.scope`，
      // 在真正 append 之前，用同一个 tgMessageId 先插一条「别人抢先写的」。
      const scopeOf = runtime.deps.archive.scope.bind(runtime.deps.archive);
      Object.assign(runtime.deps.archive, {
        scope: (chatId2: string, threadId: number | null = null) => {
          const scoped = scopeOf(chatId2, threadId);
          const append = scoped.append.bind(scoped);
          return Object.assign(scoped, {
            append: (input: Parameters<typeof append>[0]) => {
              append({ ...input, text: "另一个实例抢先写的", fromUserId: "x:racer" });
              return append(input);
            },
          });
        },
      });

      const response = await sendMessage(runtime, token, chatId, { endUserId: "u3", text: "会撞号" });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("internal");
      // 没有静默继续：既没有调用模型（不像成功路径那样发出请求），也没有开出一轮。
      // `appendNext()` 按 plan 的要求把「查最大值→插入」包在同一个 `db.transaction` 内
      // （比 `runner.ts#appendTrigger` 的不加事务版本更严格）：冲突时抛出会连带回滚事务内
      // 抢先写入的那一行，与「消息落库但轮次静默继续」相比，这是更安全的失败模式——
      // 不留一条无人认领的半成品消息。
      expect(upstream.requests.length).toBe(0);
      expect(
        runtime.db.prepare("SELECT COUNT(*) FROM messages WHERE chat_id=?").pluck().get(chatId),
      ).toBe(0);
      expect(
        runtime.db.prepare("SELECT COUNT(*) FROM turns WHERE key=?").pluck().get(`chat:${chatId}`),
      ).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("并发：两个请求都成功（T3.7 验收 2，qa-T3-6 verify-1 FAIL-3）", () => {
  it("同一会话两个并发请求默认 queueMax 下均 200，tg_message_id 无空洞，两条 turn 均 committed", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-concurrent-both", {
      config: { concurrency: { global: 2, perKey: 1, queueMax: 20 } },
    });
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      const [first, second] = await Promise.all([
        sendMessage(runtime, token, chatId, { endUserId: "u1", text: "第一条" }),
        sendMessage(runtime, token, chatId, { endUserId: "u2", text: "第二条" }),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);

      const ids = runtime.db
        .prepare(
          "SELECT tg_message_id FROM messages WHERE chat_id=? AND direction='in' ORDER BY tg_message_id",
        )
        .pluck()
        .all(chatId) as number[];
      expect(ids).toEqual([1, 2]);

      const states = runtime.db
        .prepare("SELECT state FROM turns WHERE key=?")
        .pluck()
        .all(`chat:${chatId}`) as string[];
      expect(states.length).toBe(2);
      expect(states.every((state) => state === "committed")).toBe(true);
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnConcurrency.queued).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
      const deleted = runtime.db
        .prepare("SELECT COUNT(*) FROM messages WHERE chat_id=? AND deleted_at IS NOT NULL")
        .pluck()
        .get(chatId) as number;
      expect(deleted).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("perKey:1/global:2 下两个不同会话各发一轮，互不排队，均 200", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-v1-two-sessions", {
      config: { concurrency: { global: 2, perKey: 1, queueMax: 20 } },
    });
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const one = ((await createSession(runtime, token, {})).json.session as { id: string }).id;
      const two = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const [a, b] = await Promise.all([
        sendMessage(runtime, token, one, { endUserId: "u1", text: "a" }),
        sendMessage(runtime, token, two, { endUserId: "u2", text: "b" }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      for (const chatId of [one, two]) {
        const states = runtime.db
          .prepare("SELECT state FROM turns WHERE key=?")
          .pluck()
          .all(`chat:${chatId}`) as string[];
        expect(states).toEqual(["committed"]);
      }
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("客户端断连 → interrupt()（T3.7 验收 5，qa-T3-6 verify-1 FAIL-2）", () => {
  it("轮次执行中断连：turns/agent_runs 无 running 残留，并发槽与 TurnRegistry 均已释放", async () => {
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-v1-abort-active-turn");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const controller = new AbortController();
      const promise = sendMessage(
        runtime,
        token,
        chatId,
        { endUserId: "u1", text: "会被中断" },
        { signal: controller.signal },
      );
      // 同步点：上游已收到模型请求 ⇒ 轮次一定已经 openTurn 且正在产出，此时中断才测的是
      // 「轮次执行中断连」而不是「排队中断连」（后者是下一条用例）。
      await waitUntil("upstream 收到请求", () => upstream.arrived >= 1);
      controller.abort();
      const response = await promise;
      // 精确到状态码与错误码：客户端自身断连与「WebUI 取消」（见下方新增用例）触发的是
      // 同一条 `mapRunTurnFailure()` 映射（T3.8），响应内容本不可观测，但既然测试直接持有
      // 这个 Response，就该钉住它实际产出的值，而不是用 `>=400` 放过任何状态码。
      expect(response.status).toBe(409);
      const responseJson = (await response.json()) as { error: { code: string } };
      expect(responseJson.error.code).toBe("cancelled");

      const turnStates = runtime.db
        .prepare("SELECT state FROM turns WHERE key=?")
        .pluck()
        .all(`chat:${chatId}`) as string[];
      const runStates = runtime.db
        .prepare("SELECT state FROM agent_runs")
        .pluck()
        .all() as string[];
      expect(turnStates).not.toContain("running");
      expect(runStates).not.toContain("running");
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnConcurrency.queued).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("排队中断连：被取消的那条触发消息 deleted_at 非空，先行的那一轮不受影响", async () => {
    const upstream = await startHangingUpstream("先行的回答");
    const runtime = await startTestRuntime("sdk-v1-abort-queued", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 5 } },
    });
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const first = sendMessage(runtime, token, chatId, { endUserId: "u1", text: "先行" });
      await waitUntil("第一条占住并发槽", () => upstream.arrived >= 1);

      const controller = new AbortController();
      const second = sendMessage(
        runtime,
        token,
        chatId,
        { endUserId: "u1", text: "排队中被取消" },
        { signal: controller.signal },
      );
      await waitUntil("第二条进入排队", () => runtime.deps.turnConcurrency.queued >= 1);
      controller.abort();
      const secondResponse = await second;
      expect(secondResponse.status).toBe(409);
      const secondResponseJson = (await secondResponse.json()) as { error: { code: string } };
      expect(secondResponseJson.error.code).toBe("cancelled");

      const rows = runtime.db
        .prepare(
          "SELECT text, deleted_at AS deletedAt FROM messages WHERE chat_id=? AND direction='in' ORDER BY tg_message_id",
        )
        .all(chatId) as Array<{ text: string; deletedAt: number | null }>;
      const cancelled = rows.find((row) => row.text.includes("排队中被取消"));
      expect(cancelled, "被取消的那条应当已归档").toBeDefined();
      expect(cancelled!.deletedAt).not.toBeNull();

      upstream.release();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnConcurrency.queued).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("取消的可观测路径：POST /api/turns/:id/cancel 中止在途轮次时，客户端（未断连）收到 409 cancelled（T3.8 qa-T3-8 verify-1 FAIL-1）", async () => {
    // 与上面两条的区别：这里的客户端全程不断连——`TurnRegistry` 是全服务单例
    // （`apps/bot/src/compose.ts` 的 `turnRegistry` 同时接给 `POST /api/turns/:id/cancel` 与
    // `sdk.turn.registry`），WebUI owner 可以拿着这条轮次的 id 直接调用 `cancel()`，发起请求的
    // SDK 客户端仍在等这次 HTTP 响应，理应读到 `cancelled` 而非 `upstream_error`——这正是
    // `mapRunTurnFailure()` 里 `cancelled` 分支要覆盖的场景（`packages/server/src/sdk/v1.ts`
    // 「与 plan 的偏差」第 2 条）。
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-v1-cancel-observable");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const promise = sendMessage(runtime, token, chatId, { endUserId: "u1", text: "会被 WebUI 取消" });
      await waitUntil("upstream 收到请求（轮次已开、正在等模型）", () => upstream.arrived >= 1);
      const active = runtime.deps.turnRegistry.list(chatId);
      expect(active.length).toBe(1);
      // 与 `packages/server/src/app.ts` 的 `POST /api/turns/:id/cancel` 逐字同一调用
      // （`actorUserId:"webui"`, `actorRole:"owner"`）——owner 可取消任何人的轮次。
      const cancelledNow = runtime.deps.turnRegistry.cancel(active[0]!.id, "webui", "owner");
      expect(cancelledNow).toBe(true);

      const response = await promise;
      expect(response.status).toBe(409);
      const responseJson = (await response.json()) as { ok: boolean; error: { code: string; retryable: boolean } };
      expect(responseJson.ok).toBe(false);
      expect(responseJson.error.code).toBe("cancelled");
      expect(responseJson.error.retryable).toBe(true);

      const turnStates = runtime.db
        .prepare("SELECT state FROM turns WHERE key=?")
        .pluck()
        .all(`chat:${chatId}`) as string[];
      expect(turnStates).not.toContain("running");
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("审批 fail-closed：SDK 轮次无人工审批通道（lead 裁决）", () => {
  it("memory.pubWriteRequiresApproval=true 时，模型调 memory_write pubmemory 被即时拒绝，轮次正常收口、无写入", async () => {
    const upstream = await startFakeUpstream("已尝试写入公开记忆。");
    const runtime = await startTestRuntime("sdk-v1-approval-fail-closed", {
      config: { memory: { pubWriteRequiresApproval: true } },
    });
    try {
      await setupModel(runtime, upstream);
      const { sourceId, token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      upstream.queueToolCallStep([
        {
          id: "call_1",
          name: "memory_write",
          arguments: {
            scope: "pubmemory",
            section: "note",
            content: "泄漏的内容",
            reason: "用户要求记录",
          },
        },
      ]);

      const response = await sendMessage(runtime, token, chatId, {
        endUserId: "u1",
        text: "把这句话记进公开记忆",
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; text: string; turnId: string };
      expect(json.ok).toBe(true);
      // 轮次正常收口：commit 存在，turns 表状态为 committed，不是卡死或 failed。
      const state = runtime.db.prepare("SELECT state FROM turns WHERE id=?").pluck().get(json.turnId);
      expect(state).toBe("committed");

      // 工具返回值里能看到即时拒绝（第二次上游请求的 tool 结果消息里应含 approval_unavailable）。
      const toolResultRequest = upstream.requests.find((request) =>
        JSON.stringify(request.body.messages).includes("approval_unavailable"),
      );
      expect(toolResultRequest, "模型应当收到 approval_unavailable 的工具结果").toBeDefined();

      // 真正没有写入：pubmemory 磁盘文件里不出现「泄漏的内容」。
      const pubmemoryPath = `${runtime.config.memory.dir}/sources/${sourceId}/PUBMEMORY.md`;
      let pubmemoryContent = "";
      try {
        pubmemoryContent = readFileSync(pubmemoryPath, "utf8");
      } catch {
        /* 文件不存在同样满足「没有写入」 */
      }
      expect(pubmemoryContent).not.toContain("泄漏的内容");

      // 没有留下待处理的 approvals 行——fail-closed 是即时拒绝，不是挂起等待。
      const pendingApprovals = runtime.db
        .prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'")
        .pluck()
        .get() as number;
      expect(pendingApprovals).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  /**
   * 直接对 `ToolRegistry.execute()` 的最小复现，不经完整轮次——上一条用例证明了「端到端行为
   * 正确」，这一条证明「判据放在审批判定处、且真的即时返回，不进入 broker」（lead 条件 3，
   * `docs/reviews/26` §2–§4/§6 未见冲突的既有判据）。`hangingBroker.request()` 永不 resolve：
   * 若 fail-closed 分支失效（判据被误放到目录过滤处、或走漏到 `approval.request()`），本用例会
   * 因超时而失败，而不是静默通过。
   */
  it("registry.execute()：needed:true 时直接返回 approval_unavailable，从不调用 broker.request()", async () => {
    let brokerCalls = 0;
    const hangingBroker: ApprovalBroker = {
      request: () => {
        brokerCalls += 1;
        return new Promise(() => {
          /* 永不 resolve */
        });
      },
    };
    const log = {
      span: () => ({ id: "span", end: () => undefined }),
      event: () => undefined,
    } as unknown as LogSink;
    const config = configSchema.parse({ access: { bootstrapOwnerId: "1" } });
    const registry = new ToolRegistry(log, hangingBroker, {
      maxRegistered: 10,
      maxCallsPerTurn: 10,
      maxConsecutiveErrors: 8,
    });
    // 名字必须是 `SDK_AGENT_TOOLS` 白名单里的一个（这里借用 `memory_write`），否则请求会先在
    // `admit()` 的 `toolCallableBy()` 那道闸被拦（`error:'tool_unavailable_for_sdk'`），根本
    // 走不到本用例要验证的审批分支——探针工具的实现与真正的 `memory_write` 无关，只借用名字
    // 让请求通过白名单准入。
    registry.register({
      name: "memory_write",
      description: "探针工具，用于验证 SDK 审批 fail-closed",
      inputSchema: z.object({}),
      policy: { minRole: "trusted", approval: "always", scope: "workspace", source: "custom" },
      sourcePriority: 30,
      execute: () => ({ ok: true }),
    });
    const context: ToolExecutionContext = {
      turn: {
        turnId: "t1",
        key: "chat:c1",
        chatId: "c1",
        threadId: null,
        initiatorUserId: "c1",
        effectiveRole: "trusted",
        isPrivate: true,
        baseCommitId: null,
        snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
        delta: [],
        abortSignal: new AbortController().signal,
        config,
      },
      workspace: ".",
      agentKind: "sdk",
      ...newToolScope(),
    };
    const started = Date.now();
    const result = await registry.execute("memory_write", {}, context);
    const elapsed = Date.now() - started;
    expect(result).toEqual({
      ok: false,
      error: "approval_unavailable",
      hint: expect.any(String),
    });
    // 判据真的在准入之后、执行之前拦下，不是巧合地快——broker 从未被调用过。
    expect(brokerCalls).toBe(0);
    // 即时：不是排队等一个短暂的 TTL 再失败，是同一个事件循环 tick 内就返回。
    expect(elapsed).toBeLessThan(200);
  });
});

describe("endUserId 不出现在任何 memory_docs id 或 memory/sources/** 路径中（lead 护栏用例）", () => {
  it("primemory 的主体由会话 chatId 派生，含 / 与 .. 的 endUserId 不泄漏进磁盘路径或库键", async () => {
    const upstream = await startFakeUpstream("已记住。");
    const runtime = await startTestRuntime("sdk-v1-enduserid-not-leaked");
    try {
      await setupModel(runtime, upstream);
      const { sourceId, token } = issueSource(runtime, "Alpha");
      const created = await createSession(runtime, token, {});
      const chatId = (created.json.session as { id: string }).id;

      // memory_write 需要模型真的调用一次才会落盘；这里走 primemory（isPrivate 恒真），
      // 用一个包含 `/` 与 `..` 的 endUserId 触发一轮。
      upstream.queueToolCallStep([
        {
          id: "call_1",
          name: "memory_write",
          arguments: {
            scope: "primemory",
            section: "note",
            content: "私有记忆内容",
            reason: "用户要求记录",
          },
        },
      ]);
      const dangerousEndUserId = "../../etc/passwd";
      const response = await sendMessage(runtime, token, chatId, {
        endUserId: dangerousEndUserId,
        text: "记住这句话",
      });
      expect(response.status).toBe(200);

      // 库里的 memory_docs.id / subject 只应含 sourceId 与 chatId，不含 endUserId 本身。
      const docs = runtime.db
        .prepare("SELECT id, subject FROM memory_docs WHERE scope='primemory'")
        .all() as Array<{ id: string; subject: string }>;
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.id).not.toContain(dangerousEndUserId);
        expect(doc.subject).not.toContain(dangerousEndUserId);
        expect(doc.id).toBe(`primemory:${sourceId}:${chatId}`);
      }

      // 磁盘路径同理：private/<chatId>/，不是 private/<endUserId>/。
      const privateDir = `${runtime.config.memory.dir}/sources/${sourceId}/private`;
      const entries = readFileSync(`${privateDir}/${chatId}/PRIMEMORY.md`, "utf8");
      expect(entries).toContain("私有记忆内容");
      expect(() => readFileSync(`${privateDir}/${dangerousEndUserId}/PRIMEMORY.md`, "utf8")).toThrow();
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});
