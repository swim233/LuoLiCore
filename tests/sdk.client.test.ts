import { describe, expect, it } from "vitest";
import { issueApiKey } from "@luoli/core";
import {
  SdkError,
  createSdkClient,
  type LuoliSdkClient,
  type SdkStreamEvent,
} from "@luoli/sdk-client";
import { startTestRuntime, type TestRuntime } from "./support/runtime.js";
import {
  startFakeUpstream,
  startHangingUpstream,
  type FakeUpstream,
} from "./support/upstream.js";

/**
 * docs/12-sdk.md T3.10（`@luoli/sdk-client` 客户端）验收 1 的进程内等价物：真实 `startTestRuntime`
 * （进程内装配的真实 app）+ `startFakeUpstream`/`startHangingUpstream`，客户端经注入的 `fetch`
 * 直接打 `runtime.server.request()`（Hono 的 `request()` 接受完整 URL 字符串，按路径路由，
 * host 段不参与匹配——客户端本身不知道自己在测试环境里，与打真实网络地址走的是同一段代码）。
 * 真实进程（`pnpm build && pnpm start`）下的等价覆盖见 `scripts/sdk-e2e.ts`（验收 3）。
 *
 * 与 `tests/sdk.v1.test.ts`/`tests/sdk.stream.test.ts` 同手法：不引入 mock 框架，
 * 断连/排队类同步点用轮询（`waitUntil`），不用固定 `sleep`。
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

function issueSource(runtime: TestRuntime, name: string): { sourceId: string; token: string } {
  const created = runtime.deps.sources.create(name);
  const issued = issueApiKey({
    apiKeys: runtime.deps.apiKeys,
    secrets: runtime.deps.secrets,
    sourceId: created.id,
  });
  return { sourceId: created.id, token: issued.token };
}

/** 客户端注入的 `fetch`：直接打进程内 app，不走真实网络。`baseUrl` 用一个假 host——
 *  Hono 的 `request()` 按路径路由，host 段本身从不参与匹配（见文件头注释）。 */
function clientFor(runtime: TestRuntime, token: string): LuoliSdkClient {
  return createSdkClient({
    baseUrl: "http://sdk.local",
    apiKey: token,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      runtime.server.request(input as string, init)) as typeof fetch,
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

/** 消费 `streamMessage()` 直到生成器自然结束（`done`）或抛出，事件按到达顺序收集。 */
async function collectStream(iterable: AsyncIterable<SdkStreamEvent>): Promise<SdkStreamEvent[]> {
  const events: SdkStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createSdkClient：create → send → stream → list → patch → reset → commits → delete → purge（T3.10 验收 1）", () => {
  it("单个会话走完整生命周期，每一步的响应体都经 schema 解析", async () => {
    const upstream = await startFakeUpstream("你好，我是假上游");
    const runtime = await startTestRuntime("sdk-client-lifecycle");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);

      const session = await client.createSession({ label: "demo", outputFormat: "plain" });
      expect(session.label).toBe("demo");
      expect(session.outputFormat).toBe("plain");
      expect(session.modelAlias).toBeNull();
      expect(session.deletedAt).toBeNull();
      expect(typeof session.id).toBe("string");

      const sent = await client.sendMessage(session.id, { endUserId: "u1", text: "你好" });
      expect(sent.text).toContain("你好，我是假上游");
      expect(typeof sent.turnId).toBe("string");
      expect(sent.turnId.length).toBeGreaterThan(0);
      expect(sent.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(sent.usage.costUsd).toBeGreaterThanOrEqual(0);

      const streamed = await collectStream(
        client.streamMessage(session.id, { endUserId: "u1", text: "第二轮" }),
      );
      expect(streamed.some((event) => event.event === "delta")).toBe(true);
      expect(streamed[streamed.length - 1]!.event).toBe("done");
      const done = streamed.find((event) => event.event === "done")!;
      expect(done.data.text).toContain("你好，我是假上游");
      expect(done.data.usage.costUsd).toBeGreaterThanOrEqual(0);

      const listed = await client.listSessions();
      expect(listed.sessions.some((row) => row.id === session.id)).toBe(true);
      expect(listed.nextCursor).toBeNull();

      const patched = await client.patchSession(session.id, { label: "renamed", modelAlias: "main" });
      expect(patched.label).toBe("renamed");
      expect(patched.modelAlias).toBe("main");

      const fetched = await client.getSession(session.id);
      expect(fetched.label).toBe("renamed");

      const commitsBeforeReset = await client.listCommits(session.id);
      expect(commitsBeforeReset.commits.filter((row) => row.kind === "turn").length).toBe(2);

      const reset = await client.resetSession(session.id);
      expect(typeof reset.commitId).toBe("string");
      expect(reset.commitId.length).toBeGreaterThan(0);

      const commitsAfterReset = await client.listCommits(session.id);
      // `context_commits` 按 `seq DESC` 排列（最新在前）——reset 是最后一次写入，理应在第一位。
      expect(commitsAfterReset.commits[0]!.kind).toBe("reset");
      expect(commitsAfterReset.commits[0]!.id).toBe(reset.commitId);

      await client.deleteSession(session.id);
      await expect(client.getSession(session.id)).rejects.toMatchObject({
        status: 404,
        code: "session_deleted",
      });

      await client.purgeSession(session.id);
      await expect(client.getSession(session.id)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("分页 cursor：不透明串，原样喂回可翻页", () => {
  it("listSessions：limit=1 时 nextCursor 原样传回取到不同的下一条", async () => {
    const runtime = await startTestRuntime("sdk-client-cursor-sessions");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const first = await client.createSession({ label: "one" });
      const second = await client.createSession({ label: "two" });

      const page1 = await client.listSessions({ limit: 1 });
      expect(page1.sessions.length).toBe(1);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await client.listSessions({ limit: 1, cursor: page1.nextCursor! });
      expect(page2.sessions.length).toBe(1);
      expect(page2.sessions[0]!.id).not.toBe(page1.sessions[0]!.id);
      const ids = [page1.sessions[0]!.id, page2.sessions[0]!.id].sort();
      expect(ids).toEqual([first.id, second.id].sort());
    } finally {
      await runtime.dispose();
    }
  });

  it("listCommits：limit=1 时 nextCursor 原样传回取到更早的一条提交", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-client-cursor-commits");
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});
      await client.sendMessage(session.id, { endUserId: "u1", text: "第一条" });
      await client.sendMessage(session.id, { endUserId: "u1", text: "第二条" });

      const page1 = await client.listCommits(session.id, { limit: 1 });
      expect(page1.commits.length).toBe(1);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await client.listCommits(session.id, { limit: 1, cursor: page1.nextCursor! });
      expect(page2.commits.length).toBe(1);
      expect(page2.commits[0]!.id).not.toBe(page1.commits[0]!.id);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("错误码分支：非流式（T3.10 验收「客户端错误码分支覆盖全部 10 值」）", () => {
  it("unauthorized：坏 token 抛 SdkError(401, unauthorized, retryable:false)", async () => {
    const runtime = await startTestRuntime("sdk-client-err-unauthorized");
    try {
      const client = clientFor(runtime, "sk-not-a-real-token-0000000000000000000000000000000");
      const error = await client.createSession().catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(401);
      expect(sdkError.code).toBe("unauthorized");
      expect(sdkError.retryable).toBe(false);
      expect(sdkError.autoRetryable).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("invalid_request：不可用的 modelAlias 抛 SdkError(400, invalid_request)", async () => {
    const runtime = await startTestRuntime("sdk-client-err-invalid-request");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const error = await client
        .createSession({ modelAlias: "no-such-alias" })
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(400);
      expect(sdkError.code).toBe("invalid_request");
    } finally {
      await runtime.dispose();
    }
  });

  it("not_found：不存在的会话 id 抛 SdkError(404, not_found)，不泄漏跨来源存在性", async () => {
    const runtime = await startTestRuntime("sdk-client-err-not-found");
    try {
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const error = await client.getSession("00000000-0000-0000-0000-000000000000").catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(404);
      expect(sdkError.code).toBe("not_found");
    } finally {
      await runtime.dispose();
    }
  });

  it("quota_exceeded：429，无 retryAfterMs，retryable 与 autoRetryable 均为 true", async () => {
    const upstream = await startFakeUpstream("ok");
    const runtime = await startTestRuntime("sdk-client-err-quota", {
      config: { quota: { enabled: true, perChat: { daily: 0 } } },
    });
    try {
      await setupModel(runtime, upstream);
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});
      const error = await client
        .sendMessage(session.id, { endUserId: "u1", text: "hi" })
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(429);
      expect(sdkError.code).toBe("quota_exceeded");
      expect(sdkError.retryable).toBe(true);
      expect(sdkError.autoRetryable).toBe(true);
      expect(sdkError.retryAfterMs).toBeUndefined();
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("turn_queue_full：429，`Retry-After` 头换算为 retryAfterMs=5000", async () => {
    const upstream = await startFakeUpstream("ok");
    const slow = await startHangingUpstream("慢");
    const runtime = await startTestRuntime("sdk-client-err-queue-full", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 0 } },
    });
    try {
      await setupModelWithUrl(runtime, slow.url, "main");
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});

      const first = client.sendMessage(session.id, { endUserId: "u1", text: "占住并发槽" });
      await waitUntil("第一条占住并发槽", () => slow.arrived >= 1);
      const error = await client
        .sendMessage(session.id, { endUserId: "u2", text: "必定排队被拒" })
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(429);
      expect(sdkError.code).toBe("turn_queue_full");
      expect(sdkError.retryable).toBe(true);
      expect(sdkError.autoRetryable).toBe(true);
      expect(sdkError.retryAfterMs).toBe(5000);

      slow.release();
      await first;
    } finally {
      await runtime.dispose();
      await upstream.close();
      await slow.close();
    }
  });

  it("cancelled：轮次被 TurnRegistry.cancel() 中止，409，retryable:true 但 autoRetryable:false", async () => {
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-client-err-cancelled");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});

      const pending = client.sendMessage(session.id, { endUserId: "u1", text: "会被取消" });
      await waitUntil("upstream 收到请求（轮次已开）", () => upstream.arrived >= 1);
      const active = runtime.deps.turnRegistry.list(session.id);
      expect(active.length).toBe(1);
      expect(runtime.deps.turnRegistry.cancel(active[0]!.id, "webui", "owner")).toBe(true);

      const error = await pending.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(409);
      expect(sdkError.code).toBe("cancelled");
      // 服务端 retryable:true（可发起新一轮），但客户端不做自动重试：`cancelled` 恒不可自动重试。
      expect(sdkError.retryable).toBe(true);
      expect(sdkError.autoRetryable).toBe(false);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});

describe("流式：queued → delta → done 顺序；error 事件转换为抛出的 SdkError", () => {
  it("排队时首个事件是 queued，随后正常流式收尾（delta…done）", async () => {
    const holding = await startHangingUpstream("先行的回答");
    const fast = await startFakeUpstream("排队后正常完成");
    const runtime = await startTestRuntime("sdk-client-stream-queued", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 5 } },
    });
    try {
      await setupModelWithUrl(runtime, holding.url, "main");
      await setupModelWithUrl(runtime, fast.url, "fast");
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});

      const first = client.sendMessage(session.id, { endUserId: "u1", text: "先行占位" });
      await waitUntil("第一条占住并发槽", () => holding.arrived >= 1);

      const events: SdkStreamEvent[] = [];
      let resolveFirstEvent: (() => void) | undefined;
      const firstEvent = new Promise<void>((resolve) => {
        resolveFirstEvent = resolve;
      });
      const streaming = (async () => {
        for await (const event of client.streamMessage(session.id, {
          endUserId: "u2",
          text: "会排队",
          modelAlias: "fast",
        })) {
          events.push(event);
          if (events.length === 1) resolveFirstEvent?.();
        }
      })();

      await firstEvent;
      expect(events[0]!.event).toBe("queued");

      holding.release();
      await first;
      await streaming;

      expect(events.some((event) => event.event === "delta")).toBe(true);
      expect(events[events.length - 1]!.event).toBe("done");
      const done = events.find((event) => event.event === "done")!;
      expect(done.data.text).toContain("排队后正常完成");
    } finally {
      await runtime.dispose();
      await holding.close();
      await fast.close();
    }
  });

  it("error 事件（cancelled）：不作为普通事件产出，而是从生成器抛出 SdkError", async () => {
    const upstream = await startHangingUpstream("不会被读到");
    const runtime = await startTestRuntime("sdk-client-stream-cancelled");
    try {
      await setupModelWithUrl(runtime, upstream.url);
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});

      const iterable = client.streamMessage(session.id, { endUserId: "u1", text: "会被取消" });
      const events: SdkStreamEvent[] = [];
      const consume = (async () => {
        for await (const event of iterable) events.push(event);
      })();

      await waitUntil("upstream 收到请求（轮次已开）", () => upstream.arrived >= 1);
      const active = runtime.deps.turnRegistry.list(session.id);
      expect(active.length).toBe(1);
      expect(runtime.deps.turnRegistry.cancel(active[0]!.id, "webui", "owner")).toBe(true);

      const error = await consume.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(409);
      expect(sdkError.code).toBe("cancelled");
      expect(sdkError.autoRetryable).toBe(false);
      // `error` 事件本身不产出为普通事件——生成器直接抛出，调用方不需要再判断 `event.event`。
      expect(events.every((event) => event.event !== "error")).toBe(true);
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });

  it("error 事件（turn_queue_full）：retryAfterMs 固定换算为 5000（SSE 无 Retry-After 头可读）", async () => {
    const holding = await startHangingUpstream("占位");
    const runtime = await startTestRuntime("sdk-client-stream-queue-full", {
      config: { concurrency: { global: 1, perKey: 1, queueMax: 0 } },
    });
    try {
      await setupModelWithUrl(runtime, holding.url, "main");
      const { token } = issueSource(runtime, "Alpha");
      const client = clientFor(runtime, token);
      const session = await client.createSession({});

      const first = client.sendMessage(session.id, { endUserId: "u1", text: "占住并发槽" });
      await waitUntil("第一条占住并发槽", () => holding.arrived >= 1);

      const error = await collectStream(
        client.streamMessage(session.id, { endUserId: "u2", text: "必定排队被拒" }),
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(SdkError);
      const sdkError = error as SdkError;
      expect(sdkError.status).toBe(429);
      expect(sdkError.code).toBe("turn_queue_full");
      expect(sdkError.retryAfterMs).toBe(5000);

      holding.release();
      await first;
    } finally {
      await runtime.dispose();
      await holding.close();
    }
  });
});

/**
 * SSE 解析健壮性（第 1 轮修复，F-1 / F-2）：不打真实进程，注入 `fetch` 返回自造
 * `Response` + 可控分块的 `ReadableStream`，直接驱动 `streamMessage`。三例分别对应
 * qa-T3-10 探针 `sse-probe.mts` 的 B（CRLF 行尾）、G（半路关闭无终结事件）、
 * H（读流抛错）。
 */
describe("SSE 解析健壮性：CRLF 行尾 / 流截断 / 读流异常（第 1 轮修复 F-1 / F-2）", () => {
  function streamFromChunks(
    chunks: string[],
    opts: { throwAt?: number } = {},
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opts.throwAt !== undefined && i === opts.throwAt) throw new Error("上游连接中断");
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      },
    });
  }

  function clientForStream(chunks: string[], opts: { throwAt?: number } = {}): LuoliSdkClient {
    return createSdkClient({
      baseUrl: "http://sdk.local",
      apiKey: "sk-probe",
      fetch: (async () =>
        new Response(streamFromChunks(chunks, opts), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    });
  }

  it("F-1：CRLF 帧（\\r\\n\\r\\n 收尾）与 LF 帧产出逐条相等的事件序列", async () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    };
    const lfChunks = [
      `event: delta\ndata: ${JSON.stringify({ text: "你" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "好" })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ text: "你好", usage })}\n\n`,
    ];
    const crlfChunks = lfChunks.map((chunk) => chunk.replace(/\n/g, "\r\n"));

    const lfEvents = await collectStream(
      clientForStream(lfChunks).streamMessage("s1", { endUserId: "u1", text: "hi" }),
    );
    const crlfEvents = await collectStream(
      clientForStream(crlfChunks).streamMessage("s1", { endUserId: "u1", text: "hi" }),
    );

    expect(lfEvents.map((event) => event.event)).toEqual(["delta", "delta", "done"]);
    expect(crlfEvents).toEqual(lfEvents);
  });

  it("F-2：流被截断（EOF 前未见 done/error）抛 SdkError(upstream_error, retryable:true)", async () => {
    const chunks = [
      `event: delta\ndata: ${JSON.stringify({ text: "半" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "截" })}\n\n`,
    ];
    const error = await collectStream(
      clientForStream(chunks).streamMessage("s1", { endUserId: "u1", text: "hi" }),
    ).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SdkError);
    const sdkError = error as SdkError;
    expect(sdkError.code).toBe("upstream_error");
    expect(sdkError.retryable).toBe(true);
  });

  it("F-2：读流过程中上游抛错，包装为 SdkError(upstream_error)，原始错误保留在 cause", async () => {
    const chunks = [
      `event: delta\ndata: ${JSON.stringify({ text: "先" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "后" })}\n\n`,
    ];
    const error = await collectStream(
      clientForStream(chunks, { throwAt: 1 }).streamMessage("s1", { endUserId: "u1", text: "hi" }),
    ).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SdkError);
    const sdkError = error as SdkError;
    expect(sdkError.code).toBe("upstream_error");
    expect(sdkError.retryable).toBe(true);
    expect(sdkError.cause).toBeInstanceOf(Error);
    expect((sdkError.cause as Error).message).toBe("上游连接中断");
  });
});

/**
 * O-A：`describe("错误码分支：非流式…覆盖全部 10 值")` 实际只覆盖 7 值（缺
 * `upstream_error` / `not_implemented` / `internal`），标题自述与交付不符。这里补三条，
 * 不打真实进程——注入 `fetch` 直接返回固定错误体，与上一个 describe 同手法。
 */
describe("错误码分支：注入 fetch 补齐 upstream_error / not_implemented / internal（凑满全部 10 值）", () => {
  function clientWithFixedResponse(
    status: number,
    body: BodyInit,
    headers: Record<string, string> = { "content-type": "application/json" },
  ): LuoliSdkClient {
    return createSdkClient({
      baseUrl: "http://sdk.local",
      apiKey: "sk-probe",
      fetch: (async () => new Response(body, { status, headers })) as typeof fetch,
    });
  }

  it("upstream_error：服务端契约内的错误响应原样透传 code/retryable", async () => {
    const client = clientWithFixedResponse(
      502,
      JSON.stringify({ ok: false, error: { code: "upstream_error", message: "上游模型服务出错", retryable: true } }),
    );
    const error = await client.createSession().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SdkError);
    const sdkError = error as SdkError;
    expect(sdkError.status).toBe(502);
    expect(sdkError.code).toBe("upstream_error");
    expect(sdkError.retryable).toBe(true);
  });

  it("not_implemented：依赖未装配，retryable:false", async () => {
    const client = clientWithFixedResponse(
      500,
      JSON.stringify({ ok: false, error: { code: "not_implemented", message: "依赖未装配", retryable: false } }),
    );
    const error = await client.createSession().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SdkError);
    const sdkError = error as SdkError;
    expect(sdkError.status).toBe(500);
    expect(sdkError.code).toBe("not_implemented");
    expect(sdkError.retryable).toBe(false);
  });

  it("internal：响应体不符合错误契约时兜底为 internal，retryable 按状态码猜", async () => {
    const client = clientWithFixedResponse(500, "<html>not json</html>", {
      "content-type": "text/html",
    });
    const error = await client.createSession().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SdkError);
    const sdkError = error as SdkError;
    expect(sdkError.status).toBe(500);
    expect(sdkError.code).toBe("internal");
    expect(sdkError.retryable).toBe(true);
  });
});
