import { z } from "zod";

// `/sdk/v1` 全部请求/响应形状的唯一定义处（docs/12-sdk.md A5）：服务端用它做 `safeParse`
// 校验，客户端类型取 `z.infer`。不依赖任何 `@luoli/*`，字段名与 `usage_ledger` /
// `context_commits` 的列一一对应（camelCase），避免 T3.6 端点再长出一层改名映射。

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

export const sdkOutputFormatSchema = z.enum(["plain", "markdown"]);
export type SdkOutputFormat = z.infer<typeof sdkOutputFormatSchema>;

/** 发起人 id：落库前服务端加 `<sourceId>:` 前缀，此处只做长度与控制字符校验（plan T3.7 验收 6）。 */
export const sdkEndUserIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]*$/, "不得包含控制字符");
export type SdkEndUserId = z.infer<typeof sdkEndUserIdSchema>;

export const sdkModelAliasSchema = z.string().min(1).max(200);
export const sdkLabelSchema = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// 错误契约：{ ok:false, error:{ code, message, retryable } }。
// `code` 进契约（枚举），`message` 不进契约（任意字符串，不做形态校验）。
// ---------------------------------------------------------------------------

export const sdkErrorCodeSchema = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  "turn_queue_full",
  "upstream_error",
  "session_deleted",
  // 三个补充值（T3.6 落地端点时发现原六个不够覆盖依赖缺失、内部异常与配额拒绝）：
  // `not_implemented` 对应依赖未装配（沿用 `/api/sdk/*` 的既有先例，摘除比伪造安全）；
  // `internal` 对应未预期的内部异常（`buildTrigger`/`openTurn`/`turns.create` 抛出、db 约束
  // 冲突等）；`quota_exceeded` 对应额度拒绝（lead 裁决：与并发排队满是两种不同的「稍后再试」，
  // 前者按天/月窗口重置，`Retry-After` 给不出有意义的秒数，后者才适合固定 5 秒）。
  "not_implemented",
  "internal",
  "quota_exceeded",
  // 第十个值（T3.8）：轮次被 `TurnRegistry.cancel()` 中止，且客户端存在能收到这次响应的路径——
  // 与「客户端自身断连」（响应内容不可观测，沿用 `upstream_error`/`turn_queue_full` 无需区分）
  // 不同，`POST /api/turns/:id/cancel`（WebUI owner）与本次 SDK 请求共用同一个 `TurnRegistry`，
  // 排队态与已开轮态均可被外部取消，此时发起请求的 SDK 客户端仍连着，理应读到「轮次被取消」
  // 而非「上游模型服务出错」。
  "cancelled",
]);
export type SdkErrorCode = z.infer<typeof sdkErrorCodeSchema>;

export const sdkErrorSchema = z.object({
  code: sdkErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type SdkError = z.infer<typeof sdkErrorSchema>;

export const sdkErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: sdkErrorSchema,
});
export type SdkErrorResponse = z.infer<typeof sdkErrorResponseSchema>;

// ---------------------------------------------------------------------------
// 会话对象与增删改查入参
// ---------------------------------------------------------------------------

export const sdkSessionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  label: z.string().nullable(),
  modelAlias: z.string().nullable(),
  outputFormat: sdkOutputFormatSchema,
  createdAt: z.number(),
  deletedAt: z.number().nullable(),
});
export type SdkSession = z.infer<typeof sdkSessionSchema>;

export const sdkSessionResponseSchema = z.object({
  ok: z.literal(true),
  session: sdkSessionSchema,
});
export type SdkSessionResponse = z.infer<typeof sdkSessionResponseSchema>;

/** `POST /sdk/v1/sessions` 入参：三项均可选，缺省由服务端取默认值。 */
export const sdkCreateSessionInputSchema = z.object({
  modelAlias: sdkModelAliasSchema.optional(),
  outputFormat: sdkOutputFormatSchema.optional(),
  label: sdkLabelSchema.optional(),
});
export type SdkCreateSessionInput = z.infer<typeof sdkCreateSessionInputSchema>;

/** `PATCH /sdk/v1/sessions/:id` 入参：只改 modelAlias 与 label，outputFormat 建会话后不可改。 */
export const sdkUpdateSessionInputSchema = z.object({
  modelAlias: sdkModelAliasSchema.optional(),
  label: sdkLabelSchema.optional(),
});
export type SdkUpdateSessionInput = z.infer<typeof sdkUpdateSessionInputSchema>;

/** 列表分页入参。经查询字符串传入时 `limit` 为字符串，故用 `coerce`。 */
export const sdkPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type SdkPageQuery = z.infer<typeof sdkPageQuerySchema>;

export const sdkSessionListResponseSchema = z.object({
  ok: z.literal(true),
  sessions: z.array(sdkSessionSchema),
  nextCursor: z.string().nullable(),
});
export type SdkSessionListResponse = z.infer<typeof sdkSessionListResponseSchema>;

/** 软停用 / purge / reset 之外的通用成功响应（无额外载荷）。 */
export const sdkOkResponseSchema = z.object({ ok: z.literal(true) });
export type SdkOkResponse = z.infer<typeof sdkOkResponseSchema>;

export const sdkResetResponseSchema = z.object({
  ok: z.literal(true),
  commitId: z.string(),
});
export type SdkResetResponse = z.infer<typeof sdkResetResponseSchema>;

// ---------------------------------------------------------------------------
// 提交历史（只读），字段对应 `context_commits` 的列（camelCase）。
// ---------------------------------------------------------------------------

export const sdkCommitKindSchema = z.enum(["turn", "prune", "reset", "manual", "revert"]);
export type SdkCommitKind = z.infer<typeof sdkCommitKindSchema>;

export const sdkCommitListItemSchema = z.object({
  id: z.string(),
  kind: sdkCommitKindSchema,
  turnId: z.string().nullable(),
  tokensTotal: z.number().int().nonnegative(),
  msgCount: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type SdkCommitListItem = z.infer<typeof sdkCommitListItemSchema>;

export const sdkCommitListResponseSchema = z.object({
  ok: z.literal(true),
  commits: z.array(sdkCommitListItemSchema),
  nextCursor: z.string().nullable(),
});
export type SdkCommitListResponse = z.infer<typeof sdkCommitListResponseSchema>;

// ---------------------------------------------------------------------------
// 消息：非流式 + 流式共用入参，字段对应 `usage_ledger` 的列（camelCase）。
// ---------------------------------------------------------------------------

/**
 * 流式端点上要不要额外的事件种类。**缺省不发**，这是必须的：`sdkStreamEventSchema` 是
 * `discriminatedUnion`，旧客户端 `.parse()` 到一个它不认识的事件会抛裸 `ZodError` —— 无条件
 * 发新事件等于破坏既有接入方。显式要了才发，因此这是一次加法而不是改动。
 *
 * 非流式端点忽略这个字段（那条路径上没有事件可言）。
 */
export const sdkStreamOptInEventSchema = z.enum(["tool"]);
export type SdkStreamOptInEvent = z.infer<typeof sdkStreamOptInEventSchema>;

export const sdkSendMessageInputSchema = z.object({
  endUserId: sdkEndUserIdSchema,
  text: z.string().min(1),
  modelAlias: sdkModelAliasSchema.optional(),
  events: z.array(sdkStreamOptInEventSchema).optional(),
});
export type SdkSendMessageInput = z.infer<typeof sdkSendMessageInputSchema>;

export const sdkUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type SdkUsage = z.infer<typeof sdkUsageSchema>;

/** `POST /sdk/v1/sessions/:id/messages` 非流式响应。 */
export const sdkMessageResponseSchema = z.object({
  ok: z.literal(true),
  text: z.string(),
  usage: sdkUsageSchema,
  turnId: z.string(),
});
export type SdkMessageResponse = z.infer<typeof sdkMessageResponseSchema>;

// ---------------------------------------------------------------------------
// 流式协议：四事件（plan T3.8）。`event` 字段做判别，`data` 为对应载荷。
// ---------------------------------------------------------------------------

export const sdkStreamDeltaDataSchema = z.object({ text: z.string() });
export type SdkStreamDeltaData = z.infer<typeof sdkStreamDeltaDataSchema>;

export const sdkStreamDoneDataSchema = z.object({ text: z.string(), usage: sdkUsageSchema });
export type SdkStreamDoneData = z.infer<typeof sdkStreamDoneDataSchema>;

// `message` 补于 T3.8（T3.6a qa 转入注记）：与 HTTP 错误体 `{code,message,retryable}` 同形，
// 客户端不必为 SSE `error` 事件另写一套「code → 文案」映射。
export const sdkStreamErrorDataSchema = z.object({
  code: sdkErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type SdkStreamErrorData = z.infer<typeof sdkStreamErrorDataSchema>;

/** 队列位次可选：进入排队时不一定能算出精确位次。 */
export const sdkStreamQueuedDataSchema = z.object({
  position: z.number().int().nonnegative().optional(),
});
export type SdkStreamQueuedData = z.infer<typeof sdkStreamQueuedDataSchema>;

/**
 * SSE `tool` 事件的载荷：这一轮开始执行哪个工具。
 *
 * 只有工具名，不带入参与结果。入参可能含敏感内容（文件路径、命令行），而这条流是给第三方
 * 后端看的进度信号，不是审计通道 —— 审计在 `tool.call` 那条 span 上，它不出网。
 */
export const sdkStreamToolDataSchema = z.object({
  name: z.string(),
});
export type SdkStreamToolData = z.infer<typeof sdkStreamToolDataSchema>;

export const sdkStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("delta"), data: sdkStreamDeltaDataSchema }),
  z.object({ event: z.literal("done"), data: sdkStreamDoneDataSchema }),
  z.object({ event: z.literal("error"), data: sdkStreamErrorDataSchema }),
  z.object({ event: z.literal("queued"), data: sdkStreamQueuedDataSchema }),
  z.object({ event: z.literal("tool"), data: sdkStreamToolDataSchema }),
]);
export type SdkStreamEvent = z.infer<typeof sdkStreamEventSchema>;
