/**
 * `/sdk/v1/*`：第三方 SDK 接入端点（docs/12-sdk.md T3.6，A6）。
 *
 * 独立成文件，`app.ts` 只挂载 `mountSdkV1(app, dependencies)`——与 `mountSdkAdmin` 是姐妹文件，
 * 但服务对象、鉴权通道完全不同：这里没有 cookie 会话、没有 CSRF，鉴权走 `./auth.ts` 的
 * Bearer 中间件，错误契约是 `{ok:false,error:{code,message,retryable}}`（`./errors.ts`）
 * 而不是 `/api/*` 的 `{ok:false,error:{code,message}}`。
 *
 * `sourceId` 只有一个来源：Bearer 中间件从已认证密钥写入 `ctx.get("sourceId")`。任何端点都
 * 不接受请求体 / 查询串传入 sourceId 覆盖它——跨来源隔离的判据只在这一处成立。
 */
import type { Hono } from "hono";
import { resolve } from "node:path";
import {
  contextKey,
  modelAliasKey,
  readAppKv,
  writeAppKv,
  type AppendedMessage,
} from "@luoli/db";
import type { SdkSessionRow } from "@luoli/db";
import {
  perChatConfig,
  purgeSdkSession,
  runMainAgent,
  runTurn,
  streamMainAgent,
  type Config,
} from "@luoli/core";
import {
  sdkCreateSessionInputSchema,
  sdkPageQuerySchema,
  sdkSendMessageInputSchema,
  sdkUpdateSessionInputSchema,
  type SdkSession,
} from "@luoli/sdk-client/schema";
import type { ServerDependencies, ServerEnv } from "../app.js";
import { sdkBearerAuth } from "./auth.js";
import { sdkError } from "./errors.js";

/** zod issue 数组拼成一句人类可读的错误信息，与 `app.ts` 的 `invalidConfig` 同一思路。 */
function issuesToMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("；");
}

function currentConfig(dependencies: ServerDependencies): Readonly<Config> {
  return "snapshot" in dependencies.config
    ? dependencies.config.snapshot()
    : dependencies.config;
}

/** SSE 注释帧：解析器按规范忽略它，只用来让连接上有字节流动。 */
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** 请求方缺任一装配（Bearer 中间件已经在 sources/apiKeys/secrets 缺失时短路，这里覆盖轮次执行链）。 */
function requireSdk(
  dependencies: ServerDependencies,
): NonNullable<ServerDependencies["sdk"]> | null {
  return dependencies.sdk ?? null;
}

function serializeSession(
  dependencies: ServerDependencies,
  row: SdkSessionRow,
): SdkSession {
  return {
    id: row.chatId,
    sourceId: row.sourceId,
    label: row.label,
    modelAlias: readAppKv<string>(dependencies.db, modelAliasKey(row.key)) ?? null,
    outputFormat: row.outputFormat,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

type Resolved =
  | { ok: true; session: SdkSessionRow }
  | { ok: false; status: 404; body: { ok: false; error: { code: string; message: string; retryable: boolean } } };

/**
 * 按 `chatId`（URL 段的裸 uuid）换算 `key` 后取会话，统一「跨来源」与「不存在」为同一响应
 * （plan T3.6 验收 3：404 不 403，不泄漏存在性）；额外区分「存在但已软停用」——`session_deleted`
 * 仍是 404，但携带一个更精确的 code，供客户端与「压根没这个会话」区分开（`@luoli/sdk-client/schema`
 * 预留的 `session_deleted` 枚举值正是为这里准备的）。用于「不可开轮 / 不可读」的端点；
 * DELETE（幂等软停用）与 purge（对已停用会话同样应生效）不经过本函数。
 */
function resolveSession(
  sdk: NonNullable<ServerDependencies["sdk"]>,
  sourceId: string,
  chatId: string,
): Resolved {
  const key = contextKey({ chatId, messageThreadId: null }, "chat");
  const session = sdk.sessions.getBySource(sourceId, key);
  if (!session)
    return {
      ok: false,
      status: 404,
      body: sdkError("not_found", "会话不存在", 404).body,
    };
  if (session.deletedAt !== null)
    return {
      ok: false,
      status: 404,
      body: sdkError("session_deleted", "会话已停用", 404).body,
    };
  return { ok: true, session };
}

/**
 * `runTurn()` 失败结果 → SDK 错误契约（lead 裁决，分档而非合并成一个 `upstream_error`）：
 * - `stage:'queue'` 且 `code:'turn_queue_full'`：并发闸拒绝，429 带 `Retry-After`。
 * - `stage:'queue'` 且 `code:'turn_queue_cancelled'` / `stage:'turn'` 且 `code:'cancelled'`：
 *   轮次被 `TurnRegistry.cancel()` 中止（排队态与已开轮态各一种取值）——映射独立的
 *   `cancelled` 409（T3.8 定案）。两种取消都可能来自客户端自身断连（此时响应内容不可观测，
 *   映射成什么都无所谓），也可能来自 `POST /api/turns/:id/cancel`（WebUI owner，
 *   与本请求共用同一个 `TurnRegistry`，参见 `apps/bot/src/compose.ts` 的单例装配）——后一种
 *   路径下发起请求的 SDK 客户端仍连着，不应把「轮次被取消」读成「上游模型服务出错」。
 * - `stage:'setup'`：`buildTrigger`/`openTurn`/`turns.create` 本身抛出，轮次从未真正开起来，
 *   属本服务内部状态异常（DB 约束、非法时区快照等），不是「上游模型服务」的故障——映射
 *   `internal` 500，与配额/归档失败等其余「内部原因」错误同一分类。
 * - `stage:'turn'` 其余取值（`code:'failed'`）：轮次已经开起来但产出/投递/提交失败，
 *   是模型调用链路上出的问题，映射 `upstream_error` 502。
 */
function mapRunTurnFailure(
  result: Extract<Awaited<ReturnType<typeof runTurn>>, { ok: false }>,
): ReturnType<typeof sdkError> {
  if (result.stage === "queue")
    return result.code === "turn_queue_full"
      ? sdkError("turn_queue_full", "当前排队已满，请稍后重试", 429, true)
      : sdkError("cancelled", "轮次已取消，可重新发送", 409, true);
  if (result.stage === "setup")
    return sdkError("internal", result.error, 500, true);
  if (result.code === "cancelled")
    return sdkError("cancelled", "轮次已取消，可重新发送", 409, true);
  return sdkError("upstream_error", result.error, 502, true);
}

export function mountSdkV1(app: Hono<ServerEnv>, dependencies: ServerDependencies): void {
  app.use("/sdk/v1/*", sdkBearerAuth(dependencies));

  app.post("/sdk/v1/sessions", async (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const body = await ctx.req.json().catch(() => ({}));
    const parsed = sdkCreateSessionInputSchema.safeParse(body);
    if (!parsed.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(parsed.error), 400).body,
        400,
      );
    if (
      parsed.data.modelAlias &&
      sdk.agent.registry.chain(parsed.data.modelAlias).length === 0
    )
      return ctx.json(
        sdkError(
          "invalid_request",
          `modelAlias 不可用：${parsed.data.modelAlias}`,
          400,
        ).body,
        400,
      );
    const session = sdk.sessions.createSession(sourceId, {
      label: parsed.data.label ?? null,
      outputFormat: parsed.data.outputFormat ?? "markdown",
    });
    if (parsed.data.modelAlias)
      writeAppKv(dependencies.db, modelAliasKey(session.key), parsed.data.modelAlias, "sdk");
    return ctx.json({ ok: true, session: serializeSession(dependencies, session) });
  });

  app.get("/sdk/v1/sessions", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const query = sdkPageQuerySchema.safeParse(
      Object.fromEntries(new URL(ctx.req.url).searchParams),
    );
    if (!query.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(query.error), 400).body,
        400,
      );
    const page = sdk.sessions.listBySource(sourceId, {
      cursor: query.data.cursor ?? null,
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    });
    return ctx.json({
      ok: true,
      sessions: page.items.map((row) => serializeSession(dependencies, row)),
      nextCursor: page.nextCursor,
    });
  });

  app.get("/sdk/v1/sessions/:id", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const resolved = resolveSession(sdk, ctx.get("sourceId")!, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    return ctx.json({ ok: true, session: serializeSession(dependencies, resolved.session) });
  });

  app.patch("/sdk/v1/sessions/:id", async (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const resolved = resolveSession(sdk, sourceId, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    const body = await ctx.req.json().catch(() => ({}));
    const parsed = sdkUpdateSessionInputSchema.safeParse(body);
    if (!parsed.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(parsed.error), 400).body,
        400,
      );
    if (parsed.data.modelAlias !== undefined) {
      if (sdk.agent.registry.chain(parsed.data.modelAlias).length === 0)
        return ctx.json(
          sdkError(
            "invalid_request",
            `modelAlias 不可用：${parsed.data.modelAlias}`,
            400,
          ).body,
          400,
        );
      writeAppKv(
        dependencies.db,
        modelAliasKey(resolved.session.key),
        parsed.data.modelAlias,
        "sdk",
      );
    }
    if (parsed.data.label !== undefined)
      sdk.sessions.update(sourceId, resolved.session.key, { label: parsed.data.label });
    const updated = sdk.sessions.getBySource(sourceId, resolved.session.key)!;
    return ctx.json({ ok: true, session: serializeSession(dependencies, updated) });
  });

  app.delete("/sdk/v1/sessions/:id", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const key = contextKey({ chatId: ctx.req.param("id"), messageThreadId: null }, "chat");
    // 软停用是幂等动词，不经 `resolveSession()` 的「已停用即 404」判据——DELETE 对一个已停用的
    // 会话再次调用应当成功而不是报错，这与 HTTP 语义、`SdkSessionRepository.softDelete()` 自身的
    // 幂等设计一致。跨来源 / 不存在时 `changes` 为 0，统一 404（不泄漏存在性）。
    if (!sdk.sessions.softDelete(sourceId, key))
      return ctx.json(sdkError("not_found", "会话不存在", 404).body, 404);
    return ctx.json({ ok: true });
  });

  app.post("/sdk/v1/sessions/:id/purge", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const chatId = ctx.req.param("id");
    const key = contextKey({ chatId, messageThreadId: null }, "chat");
    // 硬删不经 `resolveSession()`：已软停用的会话正是 purge 最常见的调用对象，「已停用即 404」
    // 那道闸只服务于「不可读/不可开轮」，不该拦住彻底删除。
    const result = purgeSdkSession(sdk.sessions, sourceId, key);
    if (!result)
      return ctx.json(sdkError("not_found", "会话不存在", 404).body, 404);
    // 唯一凭据（plan T3.6 验收 7）：purge 之后这条会话的库行与磁盘文件都不在了，这一行 warn
    // 是「它曾经存在、被谁在什么时候删掉」唯一留下的痕迹（先例 `schedule.purged`）。
    dependencies.log.event({
      level: "warn",
      kind: "sdk.session_purged",
      summary: `SDK 会话 ${chatId} 已彻底删除`,
      data: { sourceId, chatId },
    });
    return ctx.json({ ok: true });
  });

  app.post("/sdk/v1/sessions/:id/reset", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const resolved = resolveSession(sdk, sourceId, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    const commit = dependencies.context.reset(resolved.session.key, `sdk:${sourceId}`);
    return ctx.json({ ok: true, commitId: commit.id });
  });

  app.get("/sdk/v1/sessions/:id/commits", (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const resolved = resolveSession(sdk, sourceId, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    const query = sdkPageQuerySchema.safeParse(
      Object.fromEntries(new URL(ctx.req.url).searchParams),
    );
    if (!query.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(query.error), 400).body,
        400,
      );
    const limit = query.data.limit ?? 50;
    const before = query.data.cursor ? Number(query.data.cursor) : undefined;
    // 多取一行判断是否还有下一页，与 `SdkSessionRepository.listBySource` 同一手法。
    const rows = dependencies.context.listCommits(resolved.session.key, {
      limit: limit + 1,
      ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
    });
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(items[items.length - 1]!.seq) : null;
    return ctx.json({
      ok: true,
      commits: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        turnId: row.turnId,
        tokensTotal: row.tokensTotal,
        msgCount: row.msgCount,
        createdAt: row.createdAt,
      })),
      nextCursor,
    });
  });

  app.post("/sdk/v1/sessions/:id/messages", async (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const resolved = resolveSession(sdk, sourceId, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    const session = resolved.session;

    const body = await ctx.req.json().catch(() => ({}));
    const parsed = sdkSendMessageInputSchema.safeParse(body);
    if (!parsed.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(parsed.error), 400).body,
        400,
      );
    if (
      parsed.data.modelAlias &&
      sdk.agent.registry.chain(parsed.data.modelAlias).length === 0
    )
      return ctx.json(
        sdkError(
          "invalid_request",
          `modelAlias 不可用：${parsed.data.modelAlias}`,
          400,
        ).body,
        400,
      );

    const config = perChatConfig(currentConfig(dependencies), session.key);

    // 开轮前归档（plan T3.6/T3.7：会话内 `tg_message_id` 取 `MAX+1`，分配与插入同一事务）。
    // 在 `runTurn()` 之前完成，而不是塞进 `buildTrigger` 回调——A8 要求「排队中断连 / 队列满时
    // 已归档的那条消息置 deleted_at」，若归档发生在 `buildTrigger` 内（并发槽拿到之后才调用），
    // 队列满时 `buildTrigger` 根本不会执行，届时没有任何行可标记，A8 就无法落地。这与
    // Telegram 侧的先例一致：`bot.ts` 同样在配额 / 并发判定之前就已经 `archived` 好这条消息。
    let archived: AppendedMessage;
    try {
      archived = dependencies.archive.scope(session.chatId, null).appendNext({
        chatId: session.chatId,
        messageThreadId: null,
        direction: "in",
        fromKind: "user",
        fromUserId: `${sourceId}:${parsed.data.endUserId}`,
        fromName: null,
        fromUsername: null,
        kind: "text",
        text: parsed.data.text,
        tgDate: Date.now(),
        raw: parsed.data,
        triggered: true,
        triggerReason: "sdk",
      });
    } catch {
      return ctx.json(sdkError("internal", "消息归档失败", 500).body, 500);
    }

    // 额度：与 Telegram / 定时任务共用同一套全局配额系统（`docs/01 §3.1`：本次不新增按来源的
    // 维度，但不代表跳过既有的按会话/按用户/全局额度）。`userId` 取会话的 `chatId`——SDK 没有
    // Telegram 数字 id 意义上的「用户」，会话本身就是计费主体。
    const roleLimits = config.quota.perUser.byRole.trusted;
    const alias = parsed.data.modelAlias ?? config.agent.main.modelAlias;
    const estimatedTokens = Math.max(
      dependencies.context.windowTokens(session.key) + config.prompt.maxTokens,
      1000,
    );
    const estimateUsd = sdk.agent.registry.estimate(alias, estimatedTokens);
    const reservation = config.quota.enabled
      ? sdk.turn.quota.reserve({
          chatId: session.chatId,
          userId: session.chatId,
          estimateUsd: Math.max(
            config.quota.minReserveUsd,
            estimateUsd ?? config.quota.minReserveUsd,
          ),
          limits: {
            globalDaily: config.quota.global.daily,
            globalMonthly: config.quota.global.monthly,
            chatDaily: config.quota.perChat.daily,
            chatMonthly: config.quota.perChat.monthly,
            userDaily: roleLimits?.daily ?? config.quota.perUser.daily,
            userMonthly: roleLimits?.monthly ?? config.quota.perUser.monthly,
          },
        })
      : null;
    if (config.quota.enabled && !reservation) {
      dependencies.archive.scope(session.chatId, null).markDeleted(archived.id);
      // 不带 `Retry-After`（与并发排队满不同）：额度按天/月窗口重置，A9 固定 5 秒的依据
      // （「无更好的估计口径」）在这里不成立——给一个 5 秒的重试提示反而误导客户端在配额耗尽的
      // 当下持续轮询（lead 裁决）。
      return ctx.json(
        sdkError("quota_exceeded", "额度已用尽，请稍后重试", 429, true).body,
        429,
      );
    }

    // 客户端断连映射 `interrupt()`（plan T3.6/T3.7）：排队阶段用 `onPending` 记下的 pendingId
    // 取消，`openTurn` 之后改用真实 turnId——两者都要在 `registry.cancel()` 里，`actorUserId`
    // 传会话的 `chatId`（与 `initiatorUserId` 相同）才能通过 `TurnRegistry.cancel()` 的归属校验。
    let cancelId: string | null = null;
    const onAbort = (): void => {
      if (cancelId) sdk.turn.registry.cancel(cancelId, session.chatId, "trusted");
    };
    ctx.req.raw.signal.addEventListener("abort", onAbort);

    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({
        dependencies: sdk.turn,
        chatId: session.chatId,
        threadId: null,
        key: session.key,
        initiatorUserId: session.chatId,
        effectiveRole: "trusted",
        isPrivate: true,
        config,
        turnTimeoutMs: config.concurrency.turnTimeoutMs,
        triggerReason: "sdk",
        reservation,
        agentKind: "sdk",
        sourceId,
        onPending: (pendingId) => {
          cancelId = pendingId;
        },
        onOpened: (turn) => {
          cancelId = turn.turnId;
        },
        buildTrigger: () => archived,
        produce: (turn, turnReservation) => {
          if (parsed.data.modelAlias)
            Object.assign(turn, { modelAliasOverride: parsed.data.modelAlias });
          return runMainAgent(turn, {
            ...sdk.agent,
            config: turn.config as Readonly<Config>,
            workspace: resolve(sdk.workspaceRoot, turn.chatId),
            reservation: turnReservation,
            agentKind: "sdk",
            outputFormat: session.outputFormat,
          });
        },
      });
    } finally {
      ctx.req.raw.signal.removeEventListener("abort", onAbort);
    }

    if (!result.ok) {
      // `queue`（并发闸拒绝，含排队中被取消）与 `setup`（`buildTrigger`/`openTurn`/`turns.create`
      // 本身抛出）两种取值下，`archived` 从未真正进入一轮已提交的历史——按 A8 标记为已删除，
      // 客户端收到错误后可重发，不会让下一条请求把这条失败的消息当成背景历史。`stage:'turn'`
      // （轮次已开但产出/投递/提交失败，含开轮后才发生的客户端取消）不标记：`abortTurn` 已经
      // 拥有这段历史的解释权，这条触发消息是它的一部分。
      if (result.stage === "queue" || result.stage === "setup")
        dependencies.archive.scope(session.chatId, null).markDeleted(archived.id);
      const mapped = mapRunTurnFailure(result);
      if (mapped.status === 429) ctx.header("Retry-After", "5");
      return ctx.json(mapped.body, mapped.status);
    }

    const usage = sdk.agent.ledger.turnUsage(result.turn.turnId);
    return ctx.json({
      ok: true,
      text: result.answer,
      usage,
      turnId: result.turn.turnId,
    });
  });

  /**
   * `POST .../messages/stream`：SSE 四事件（plan T3.8：`delta`/`done`/`error`/`queued`）。
   * 鉴权/会话解析/入参校验/开轮前归档/配额预留与上面 `.../messages` 逐字相同——两个端点各自
   * 独立、完整地写一遍，而非抽出公共函数：产出消费方式（`runMainAgent` 一次性返回 vs.
   * `streamMainAgent` 逐块转发）与失败表达方式（HTTP 状态码 vs. SSE `error` 事件）差异较大，
   * 抽取公共段收益有限而先动两个已各自稳定的端点风险更高，留给后续需要时再做。
   *
   * SSE 帧手写在一个原生 `ReadableStream` 上返回，与 `app.ts` 的 `GET /api/events`
   * 同一手法（那是 WebUI 内部日志订阅，鉴权与消费模型都不同，这里只借用帧格式，不复用代码）。
   * 四类事件 `data` 字段的形状见 `@luoli/sdk-client/schema` 的 `sdkStreamEventSchema`。
   */
  app.post("/sdk/v1/sessions/:id/messages/stream", async (ctx) => {
    const sdk = requireSdk(dependencies);
    if (!sdk)
      return ctx.json(
        sdkError("not_implemented", "这个部署没有装配 SDK 轮次执行", 500).body,
        500,
      );
    const sourceId = ctx.get("sourceId")!;
    const resolved = resolveSession(sdk, sourceId, ctx.req.param("id"));
    if (!resolved.ok) return ctx.json(resolved.body, resolved.status);
    const session = resolved.session;

    const body = await ctx.req.json().catch(() => ({}));
    const parsed = sdkSendMessageInputSchema.safeParse(body);
    if (!parsed.success)
      return ctx.json(
        sdkError("invalid_request", issuesToMessage(parsed.error), 400).body,
        400,
      );
    if (
      parsed.data.modelAlias &&
      sdk.agent.registry.chain(parsed.data.modelAlias).length === 0
    )
      return ctx.json(
        sdkError(
          "invalid_request",
          `modelAlias 不可用：${parsed.data.modelAlias}`,
          400,
        ).body,
        400,
      );

    const config = perChatConfig(currentConfig(dependencies), session.key);

    // 开轮前归档，与非流式端点同一理由（A8：队列满/排队被拒时需要一条可标记 `deleted_at` 的行）。
    let archived: AppendedMessage;
    try {
      archived = dependencies.archive.scope(session.chatId, null).appendNext({
        chatId: session.chatId,
        messageThreadId: null,
        direction: "in",
        fromKind: "user",
        fromUserId: `${sourceId}:${parsed.data.endUserId}`,
        fromName: null,
        fromUsername: null,
        kind: "text",
        text: parsed.data.text,
        tgDate: Date.now(),
        raw: parsed.data,
        triggered: true,
        triggerReason: "sdk",
      });
    } catch {
      return ctx.json(sdkError("internal", "消息归档失败", 500).body, 500);
    }

    const roleLimits = config.quota.perUser.byRole.trusted;
    const alias = parsed.data.modelAlias ?? config.agent.main.modelAlias;
    const estimatedTokens = Math.max(
      dependencies.context.windowTokens(session.key) + config.prompt.maxTokens,
      1000,
    );
    const estimateUsd = sdk.agent.registry.estimate(alias, estimatedTokens);
    const reservation = config.quota.enabled
      ? sdk.turn.quota.reserve({
          chatId: session.chatId,
          userId: session.chatId,
          estimateUsd: Math.max(
            config.quota.minReserveUsd,
            estimateUsd ?? config.quota.minReserveUsd,
          ),
          limits: {
            globalDaily: config.quota.global.daily,
            globalMonthly: config.quota.global.monthly,
            chatDaily: config.quota.perChat.daily,
            chatMonthly: config.quota.perChat.monthly,
            userDaily: roleLimits?.daily ?? config.quota.perUser.daily,
            userMonthly: roleLimits?.monthly ?? config.quota.perUser.monthly,
          },
        })
      : null;
    if (config.quota.enabled && !reservation) {
      dependencies.archive.scope(session.chatId, null).markDeleted(archived.id);
      // 配额拒绝发生在响应头写出之前，仍能用普通 HTTP 错误体（不必打开 SSE 连接才报错）。
      return ctx.json(
        sdkError("quota_exceeded", "额度已用尽，请稍后重试", 429, true).body,
        429,
      );
    }

    // 走到这里之后响应头即确定为 200 + text/event-stream：此后任何失败（排队被拒、轮次失败、
    // 上游报错）都不能再改状态码，只能通过 `error` 事件表达（plan T3.8 验收 3「流正常关闭，
    // 不半开」）。客户端断连复用非流式端点同一套 `ctx.req.raw.signal` → `registry.cancel()` 机制。
    let cancelId: string | null = null;
    const onAbort = (): void => {
      if (cancelId) sdk.turn.registry.cancel(cancelId, session.chatId, "trusted");
    };
    ctx.req.raw.signal.addEventListener("abort", onAbort);

    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const send = (event: string, data: unknown): void => {
      if (closed || !controllerRef) return;
      controllerRef.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    };
    /**
     * 保活注释帧（`sdk.streamHeartbeatMs`，0 关闭）。
     *
     * 轮次执行期间这条流可能长时间没有任何数据（模型在想、工具在跑），而反向代理按自己的
     * 空闲超时算账：nginx 默认 `proxy_read_timeout` 60s，比本系统的 `turnTimeoutMs`（默认
     * 600s）早得多。被它掐断时客户端读到的是一次传输层中断，而不是一个 `error` 事件 ——
     * 两者在客户端的处理路径完全不同，前者只能靠截断语义兜底。
     *
     * 用 SSE 注释（`:` 开头）而不是新增一种事件：注释按规范被解析器忽略，既有客户端
     * （`@luoli/sdk-client` 的 `parseFrame` 跳过 `:` 开头的行）不必改一个字，`docs/12 §6`
     * 的顺序不变量也不受影响 —— 注释不是事件，不参与「末尾恰好 done 或 error 之一」。
     *
     * 定时器在 `close()` 里清掉：客户端断连（`ReadableStream.cancel`）与正常终结
     * （`done` / `error`）都经过它，没有第二条退出路径。
     */
    const heartbeat =
      config.sdk.streamHeartbeatMs > 0
        ? setInterval(() => {
            if (closed || !controllerRef) return;
            controllerRef.enqueue(encoder.encode(HEARTBEAT_FRAME));
          }, config.sdk.streamHeartbeatMs)
        : null;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      ctx.req.raw.signal.removeEventListener("abort", onAbort);
      try {
        controllerRef?.close();
      } catch {
        /* 已经关闭 */
      }
    };

    const run = async (): Promise<void> => {
      let result: Awaited<ReturnType<typeof runTurn>>;
      try {
        result = await runTurn({
          dependencies: sdk.turn,
          chatId: session.chatId,
          threadId: null,
          key: session.key,
          initiatorUserId: session.chatId,
          effectiveRole: "trusted",
          isPrivate: true,
          config,
          turnTimeoutMs: config.concurrency.turnTimeoutMs,
          triggerReason: "sdk",
          reservation,
          agentKind: "sdk",
          sourceId,
          // 排队时长可能长达数秒：必须在进入排队的那一刻就发（`onQueued` 的触发时机早于
          // `turnId` 产生），不能等 `runTurn()` 整体返回后再补发（docs/02 §10.6）。
          onQueued: () => send("queued", {}),
          onPending: (pendingId) => {
            cancelId = pendingId;
          },
          onOpened: (turn) => {
            cancelId = turn.turnId;
          },
          buildTrigger: () => archived,
          produce: async (turn, turnReservation) => {
            if (parsed.data.modelAlias)
              Object.assign(turn, { modelAliasOverride: parsed.data.modelAlias });
            const generated = await streamMainAgent(turn, {
              ...sdk.agent,
              config: turn.config as Readonly<Config>,
              workspace: resolve(sdk.workspaceRoot, turn.chatId),
              reservation: turnReservation,
              agentKind: "sdk",
              outputFormat: session.outputFormat,
            });
            // 优先用流中累积的全文而非 `generated.final`：与既定做法一致
            // （`packages/telegram/src/bot.ts` 的 `consumed.text` 优先于 `final`）——`final` 是
            // AI SDK 的 `result.text`，只是最后一步的正文，多步轮次以工具调用收尾时为空；
            // `done` 事件与归档写入的必须是已经发给客户端的 `delta` 拼接结果，两者不能是两份文本。
            let emitted = "";
            for await (const chunk of generated.stream) {
              emitted += chunk;
              send("delta", { text: chunk });
            }
            const final = await generated.final;
            return emitted.trim() ? emitted : final;
          },
        });
      } finally {
        ctx.req.raw.signal.removeEventListener("abort", onAbort);
      }

      if (!result.ok) {
        // 与非流式端点同一判据（A8）：`queue`/`setup` 两档下 `archived` 从未进入一轮已提交的
        // 历史，标记为已删除；`stage:'turn'`（含开轮后才发生的取消）不标记，`abortTurn` 已经
        // 拥有这段历史的解释权。
        if (result.stage === "queue" || result.stage === "setup")
          dependencies.archive.scope(session.chatId, null).markDeleted(archived.id);
        const mapped = mapRunTurnFailure(result);
        send("error", mapped.body.error);
        close();
        return;
      }

      const usage = sdk.agent.ledger.turnUsage(result.turn.turnId);
      send("done", { text: result.answer, usage });
      close();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        void run().catch((error: unknown) => {
          // `run()` 内部已把 `runTurn()` 的失败结果转成 `error` 事件；这里兜底的是它自身之外的
          // 异常（`send`/`JSON.stringify` 抛出等）——响应头已经发出，不能再改状态码，只能尽力
          // 发一个 `internal` 事件再关闭，避免连接半开。
          send("error", {
            code: "internal",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
          close();
        });
      },
      cancel() {
        close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // 反向代理默认会缓冲响应体，逐块转发的 `delta` 事件会被攒到轮次结束才一次性放出，
        // 与非流式端点等价——显式关闭缓冲（nginx 认这个头；无反代的部署里它无副作用）。
        "X-Accel-Buffering": "no",
      },
    });
  });

  /**
   * 未匹配的 `/sdk/v1/*`（不存在的路径、错误的方法）兜底（qa-T3-6 verify-1 FAIL-1）。
   * `sdkBearerAuth` 是中间件：鉴权通过后 `next()`，若上面全部路由都不匹配，请求会一路穿到
   * `app.use("/*", serveStatic(...))` / `app.get("*", documentResponse)`，返回 200 + `text/html`
   * ——与 `docs/22 · I-13` 修的那一半（`/api/*` 未匹配返回 SPA 页面）是同一个坑，
   * 客户端在 `.parse()` 处会拿到 HTML 而不是错误体。用 `app.all` 而非逐路由补，
   * 覆盖路径不存在与方法不对两种情形（`app.ts` 里 `/api/*` 的 `app.all("/api/*", ...)` 兜底
   * 是同一先例，注册顺序也一致——所有具体路由在前、通配兜底在最后）。
   */
  app.all("/sdk/v1/*", (ctx) =>
    ctx.json(
      sdkError(
        "not_found",
        `端点不存在：${ctx.req.method} ${new URL(ctx.req.url).pathname}`,
        404,
      ).body,
      404,
    ),
  );
}
