import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { issueApiKey } from "@luoli/core";
import { sdkStreamEventSchema } from "@luoli/sdk-client/schema";
import { startTestRuntime, type TestRuntime } from "./support/runtime.js";
import {
  startFakeUpstream,
  startHangingUpstream,
  type FakeUpstream,
} from "./support/upstream.js";

/**
 * docs/12-sdk.md T3.8（流式协议，SSE 四事件）。覆盖正文给出的验收 1–4，外加 §5 的贯穿要求
 * （每个事件的 `data` 经 `sdkStreamEventSchema.parse` 通过）——后者不单列一条用例，而是在
 * 每条用例里对收到的全部事件逐条校验（`assertValidEvent`），确保断言覆盖的是本端点真实吐出的
 * 载荷，而不是另起一份与线上格式脱节的样例。
 *
 * 与 `tests/sdk.v1.test.ts` 同手法：真实 `startTestRuntime` + `startFakeUpstream` /
 * `startHangingUpstream`，断连/排队类同步点用轮询（`waitUntil`），不用固定 `sleep`。
 */

async function setupModelWithUrl(runtime: TestRuntime, baseUrl: string, alias = "main"): Promise<void> {
  const providerId = runtime.deps.providers.save({
    name: `fake-${alias}`,
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
    .run(alias, JSON.stringify([modelRowId]), now);
  runtime.deps.rebuildModels();
}

async function setupModel(runtime: TestRuntime, upstream: FakeUpstream): Promise<void> {
  return setupModelWithUrl(runtime, upstream.url);
}

/** 注册一个不带定价的模型别名——`requirePricing` 闸在 `produce()` 内部抛出
 *  `model_pricing_required`，落在 `openTurn`/`turns.create` 成功之后，天然是 `stage:'turn'`
 *  失败（与 `tests/sdk.v1.test.ts`「stage:'setup' 映射 internal 500，stage:'turn' 映射
 *  upstream_error 502」同一手法），用于确定性地制造一次「上游报错」。 */
async function setupNoPricingModel(runtime: TestRuntime, upstream: FakeUpstream, alias: string): Promise<void> {
  const providerId = runtime.deps.providers.save({
    name: `fake-nopricing-${alias}`,
    kind: "openai-compatible",
    baseUrl: upstream.url,
    apiKey: "sk-fake-0123456789abcdef",
  });
  const now = Date.now();
  const modelRowId = `${providerId}:nopricing-model`;
  runtime.db
    .prepare(
      `INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,128000,4096,'{}',NULL,NULL,1,0,?,?)`,
    )
    .run(modelRowId, providerId, "nopricing-model", now, now);
  runtime.db
    .prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)")
    .run(alias, JSON.stringify([modelRowId]), now);
  runtime.deps.rebuildModels();
}

interface MidStreamDropUpstream {
  url: string;
  close(): Promise<void>;
}

/**
 * 真实上游「已经吐出内容后失联」——验收 3 要求的是「上游报错」，且流式协议半开风险最高的正是
 * 「已经发出若干 delta 之后上游中断」这一支（qa-T3-8 verify-1 FAIL-2）。手写一个最小 SSE
 * 服务：写出恰一帧 `delta` 之后既不发 `finish_reason`/`[DONE]`，也不正常 `response.end()`，
 * 而是直接销毁底层 socket，模拟连接中途被掐断。60ms 延迟保证这一帧确实已经被客户端读到
 * （而不是与销毁竞态），不模拟 `startFakeUpstream`/`startHangingUpstream` 之外的第三套完整协议
 * （不解析请求体、不支持多次请求），只服务本条用例。
 */
async function startMidStreamDropUpstream(deltaText: string): Promise<MidStreamDropUpstream> {
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const created = Math.floor(Date.now() / 1000);
      response.write(
        `data: ${JSON.stringify({
          id: "mid-stream-drop",
          object: "chat.completion.chunk",
          created,
          model: "fake-model",
          choices: [{ index: 0, delta: { role: "assistant", content: deltaText }, finish_reason: null }],
        })}\n\n`,
      );
      setTimeout(() => request.socket.destroy(), 60);
    });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  };
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
): Promise<Response> {
  return runtime.server.request(`/sdk/v1/sessions/${chatId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function streamMessage(
  runtime: TestRuntime,
  token: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return runtime.server.request(`/sdk/v1/sessions/${chatId}/messages/stream`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function waitUntil(what: string, predicate: () => boolean, limitMs = 5000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error(`waitUntil 超时：${what}`);
}

interface StreamEvent {
  event: string;
  data: unknown;
}

/** 逐条通过 `sdkStreamEventSchema.parse`——验收 §5 的贯穿要求，每条用例收到的每一个事件都要过。 */
function assertValidEvent(event: StreamEvent): void {
  expect(() => sdkStreamEventSchema.parse(event)).not.toThrow();
}

/**
 * 把 SSE 响应体解析成 `{event,data}` 序列，边到达边产出（`for await` 增量消费）——
 * 排队场景需要在响应尚未结束时就读到首个事件，读到流末尾才返回数组无法覆盖这一判据。
 * `data:` 恒为单行：写入端用 `JSON.stringify` 序列化，字符串里的换行会被转义成 `\n`
 * 两个字符而非字面换行，因此按 `\n\n` 切帧、按行找 `event:`/`data:` 前缀是安全的。
 */
async function* sseEvents(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (eventLine && dataLine)
          yield { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectAll(response: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of sseEvents(response)) {
    assertValidEvent(event);
    events.push(event);
  }
  return events;
}

describe("POST .../messages/stream：SSE 四事件（plan T3.8 验收 1–4）", () => {
  it("验收 1：排队时收到的首个事件是 queued，占满并发槽位后才发起流式请求", async () => {
    const upstream = await startHangingUpstream("先行的回答");
    // 第二个别名指向一个普通（非 hanging）的假 upstream：`startHangingUpstream` 对
    // `stream:true` 请求同样回一段非 SSE 格式的固定 JSON（见 `tests/support/upstream.ts`
    // 顶部注释，它只为制造「轮次正卡着」这个窗口而设计），排队后真正执行的这一条改用
    // `fastUpstream`，使断言能覆盖到「排队之后正常流式收尾」而不必迁就 hanging upstream 的限制。
    const fastUpstream = await startFakeUpstream("排队后正常流式完成");
    const runtime = await startTestRuntime("sdk-stream-queued", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 5 } },
    });
    try {
      await setupModelWithUrl(runtime, upstream.url, "main");
      await setupModelWithUrl(runtime, fastUpstream.url, "fast");
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      // 占满唯一的并发槽：非流式请求先占住，不等待其完成（`bot.ts:1602` 的 `available(key)`
      // 判据同样用于本端点，占槽手法与 `tests/sdk.v1.test.ts` 的断连用例一致）。
      const first = sendMessage(runtime, token, chatId, { endUserId: "u1", text: "先行占位" });
      await waitUntil("第一条占住并发槽", () => upstream.arrived >= 1);

      const streamResponse = await streamMessage(runtime, token, chatId, {
        endUserId: "u2",
        text: "会排队",
        modelAlias: "fast",
      });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

      const reader = sseEvents(streamResponse);
      const firstEvent = (await reader.next()).value;
      expect(firstEvent).toBeDefined();
      assertValidEvent(firstEvent!);
      expect(firstEvent!.event).toBe("queued");
      expect(firstEvent!.data).toEqual({});

      // 放行第一条，第二条随即出队并对 fastUpstream 正常流式执行——确认排队之后连接仍会
      // 正常收尾且真的带上 delta，不是「首事件对但后续半开」。
      upstream.release();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);

      const rest: StreamEvent[] = [];
      for await (const event of reader) {
        assertValidEvent(event);
        rest.push(event);
      }
      expect(rest.some((event) => event.event === "delta")).toBe(true);
      expect(rest[rest.length - 1]?.event).toBe("done");
      const done = rest.find((event) => event.event === "done")!;
      expect((done.data as { text: string }).text).toContain("排队后正常流式完成");
    } finally {
      await runtime.dispose();
      await upstream.close();
      await fastUpstream.close();
    }
  });

  it("取消的可观测路径：POST /api/turns/:id/cancel 中止在途 SDK 流式轮次时，客户端收到 error(cancelled)", async () => {
    // 与「客户端断连」用例的区别：这里的客户端全程不断连——`TurnRegistry` 是全服务单例
    // （`apps/bot/src/compose.ts` 的 `turnRegistry` 同时接给 `/api/turns/:id/cancel` 与
    // `sdk.turn.registry`），WebUI owner 可以拿着这条轮次的 id 直接调用 `cancel()`，
    // 发起请求的 SDK 客户端仍在读这条 SSE 连接，理应读到 `cancelled` 而非 `upstream_error`——
    // 这正是 `mapRunTurnFailure()` 里新增 `cancelled` 分支要覆盖的场景（区别于「客户端自身
    // 断连」：那种取消响应内容本不可观测，映射成什么都无所谓）。
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-stream-cancel-observable");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const response = await streamMessage(runtime, token, chatId, {
        endUserId: "u1",
        text: "会被 WebUI 取消",
      });
      expect(response.status).toBe(200);

      await waitUntil("upstream 收到请求（轮次已开、正在等模型）", () => upstream.arrived >= 1);
      const active = runtime.deps.turnRegistry.list(chatId);
      expect(active.length).toBe(1);
      // 与 `packages/server/src/app.ts` 的 `POST /api/turns/:id/cancel` 逐字同一调用
      // （`actorUserId:"webui"`, `actorRole:"owner"`）——owner 可取消任何人的轮次。
      const cancelledNow = runtime.deps.turnRegistry.cancel(active[0]!.id, "webui", "owner");
      expect(cancelledNow).toBe(true);

      const events = await collectAll(response);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("error");
      const errorData = events[0]!.data as { code: string; retryable: boolean };
      expect(errorData.code).toBe("cancelled");
      expect(errorData.retryable).toBe(true);

      const turnStates = runtime.db.prepare("SELECT state FROM turns WHERE key=?").pluck().all(`chat:${chatId}`) as string[];
      expect(turnStates).not.toContain("running");
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("验收 2：done 的 text 与拼接的 delta 一致，usage 与 usage_ledger 按 turn_id 聚合一致", async () => {
    const upstream = await startFakeUpstream("流式回答的确定性正文");
    const runtime = await startTestRuntime("sdk-stream-done-usage");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const response = await streamMessage(runtime, token, chatId, { endUserId: "u1", text: "hi" });
      expect(response.status).toBe(200);
      const events = await collectAll(response);

      const deltas = events.filter((event) => event.event === "delta");
      const done = events.find((event) => event.event === "done");
      expect(done).toBeDefined();
      const deltaText = deltas.map((event) => (event.data as { text: string }).text).join("");
      const doneData = done!.data as { text: string; usage: Record<string, number> };
      expect(doneData.text).toBe(deltaText);
      expect(doneData.text).toContain("流式回答的确定性正文");

      const turnId = runtime.db
        .prepare("SELECT id FROM turns WHERE key=? ORDER BY started_at DESC LIMIT 1")
        .pluck()
        .get(`chat:${chatId}`) as string;
      expect(typeof turnId).toBe("string");
      const aggregated = runtime.db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
          COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
          COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, COALESCE(SUM(cost_usd),0) AS costUsd
          FROM usage_ledger WHERE turn_id=?`,
        )
        .get(turnId) as Record<string, number>;
      expect(doneData.usage).toEqual(aggregated);
      expect(doneData.usage.outputTokens).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("验收 3：上游中途中断（已发出至少一块 delta 后失联）时收到 error 事件，且响应体完整结束（读到流末尾，不半开）", async () => {
    // 真实上游故障，而不是模型调用前置闸（`requirePricing`）——qa-T3-8 verify-1 FAIL-2：
    // 半开风险最高的是「已经发出若干 delta 之后上游中断」这一支，用 `setTimeout(…, 60)` 保证
    // 第一帧确实先落地、客户端有机会读到它，再销毁连接（见 `startMidStreamDropUpstream` 注释）。
    const upstream = await startMidStreamDropUpstream("先吐出的这一块正文");
    const runtime = await startTestRuntime("sdk-stream-mid-drop");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const response = await streamMessage(runtime, token, chatId, { endUserId: "u1", text: "hi" });
      expect(response.status).toBe(200);
      // `collectAll` 读到 `reader.read()` 返回 `done:true` 才返回——若连接半开会一直挂在这里，
      // 直到 vitest 的用例超时；不需要额外包一层超时逻辑来断言「流正常关闭」。
      const events = await collectAll(response);

      const deltas = events.filter((event) => event.event === "delta");
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      expect(deltas[0]).toBeDefined();
      expect((deltas[0]!.data as { text: string }).text).toContain("先吐出的这一块正文");

      // 终结事件恰一个（`done`/`error` 互斥），且必须是最后一条——不是「先 error 又补了别的」。
      const terminal = events.filter((event) => event.event === "done" || event.event === "error");
      expect(terminal).toHaveLength(1);
      expect(events[events.length - 1]).toBe(terminal[0]);
      const errorData = terminal[0]!.data as { code: string; message: string; retryable: boolean };
      expect(terminal[0]!.event).toBe("error");
      expect(errorData.code).toBe("upstream_error");
      expect(errorData.retryable).toBe(true);
      expect(typeof errorData.message).toBe("string");
      expect(errorData.message.length).toBeGreaterThan(0);

      const turnStates = runtime.db.prepare("SELECT state FROM turns WHERE key=?").pluck().all(`chat:${chatId}`) as string[];
      expect(turnStates).toEqual(["failed"]);
      expect(runtime.deps.turnConcurrency.active).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("模型调用前置闸失败（零 delta）时同样收到 error 事件且不半开", async () => {
    // 与上一条互补：这里覆盖「produce() 内还没调用 streamMainAgent 的第一次 HTTP 请求就已经
    // 失败」这一支（`requirePricing` 闸），确认零 delta 的路径同样正确收尾——不是验收 3 的
    // 字面判据（那需要真实上游故障），但仍是本端点需要正确处理的一种失败形态。
    const upstream = await startFakeUpstream("不会被使用");
    const runtime = await startTestRuntime("sdk-stream-upstream-error");
    try {
      await setupModel(runtime, upstream);
      await setupNoPricingModel(runtime, upstream, "nopricing");
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const response = await streamMessage(runtime, token, chatId, {
        endUserId: "u1",
        text: "hi",
        modelAlias: "nopricing",
      });
      expect(response.status).toBe(200);
      const events = await collectAll(response);

      expect(events.some((event) => event.event === "delta")).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("error");
      const errorData = events[0]!.data as { code: string; message: string; retryable: boolean };
      expect(errorData.code).toBe("upstream_error");
      expect(errorData.retryable).toBe(true);
      expect(typeof errorData.message).toBe("string");
      expect(errorData.message.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("验收 4：非流式端点与流式端点对同一输入的最终文本一致", async () => {
    const upstream = await startFakeUpstream("两条端点应当一致的确定性正文");
    const runtime = await startTestRuntime("sdk-stream-parity");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      // 两个独立会话：upstream 的回复固定不随上下文变化，用两个会话避免「第二轮上下文里带着
      // 第一轮」这一无关变量，两条端点各自的输出完全对应同一次确定性输出。
      const chatIdNonStream = ((await createSession(runtime, token, {})).json.session as { id: string }).id;
      const chatIdStream = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const nonStreamResponse = await sendMessage(runtime, token, chatIdNonStream, {
        endUserId: "u1",
        text: "hi",
      });
      expect(nonStreamResponse.status).toBe(200);
      const nonStreamJson = (await nonStreamResponse.json()) as { text: string };

      const streamResponse = await streamMessage(runtime, token, chatIdStream, {
        endUserId: "u1",
        text: "hi",
      });
      expect(streamResponse.status).toBe(200);
      const events = await collectAll(streamResponse);
      const done = events.find((event) => event.event === "done")!;
      const doneText = (done.data as { text: string }).text;

      expect(doneText).toBe(nonStreamJson.text);
      expect(doneText).toContain("两条端点应当一致的确定性正文");
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("客户端断连（轮次执行中）：turns/agent_runs 无 running 残留，收到 error(cancelled) 后流正常关闭", async () => {
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-stream-abort");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const chatId = ((await createSession(runtime, token, {})).json.session as { id: string }).id;

      const controller = new AbortController();
      const responsePromise = runtime.server.request(`/sdk/v1/sessions/${chatId}/messages/stream`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ endUserId: "u1", text: "会被中断" }),
        signal: controller.signal,
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);

      await waitUntil("upstream 收到请求", () => upstream.arrived >= 1);
      controller.abort();

      const events = await collectAll(response);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("error");
      const errorData = events[0]!.data as { code: string };
      // 客户端自身断连：响应内容本不可观测，这里能读到是因为测试直接持有 `response.body`
      // 而不是真的断开 TCP 连接——`AbortController.abort()` 只使 `ctx.req.raw.signal` 触发，
      // 与真实断连触发同一条 `onAbort` 路径，映射结果与「WebUI 取消」共用同一个 `cancelled` 码。
      expect(errorData.code).toBe("cancelled");

      const turnStates = runtime.db.prepare("SELECT state FROM turns WHERE key=?").pluck().all(`chat:${chatId}`) as string[];
      const runStates = runtime.db.prepare("SELECT state FROM agent_runs").pluck().all() as string[];
      expect(turnStates).not.toContain("running");
      expect(runStates).not.toContain("running");
      expect(runtime.deps.turnConcurrency.active).toBe(0);
      expect(runtime.deps.turnRegistry.list(chatId).length).toBe(0);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});
