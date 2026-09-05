export * from "./schema.js";

import {
  sdkCommitListResponseSchema,
  sdkErrorResponseSchema,
  sdkMessageResponseSchema,
  sdkOkResponseSchema,
  sdkResetResponseSchema,
  sdkSessionListResponseSchema,
  sdkSessionResponseSchema,
  sdkStreamEventSchema,
  type SdkCommitListResponse,
  type SdkCreateSessionInput,
  type SdkErrorCode,
  type SdkMessageResponse,
  type SdkPageQuery,
  type SdkSendMessageInput,
  type SdkSession,
  type SdkStreamErrorData,
  type SdkStreamEvent,
  type SdkUpdateSessionInput,
} from "./schema.js";

// `LuoliSdkClient`（T3.10）：`/sdk/v1` 的 HTTP 封装。请求/响应形状全部复用
// `./schema.js`（A5，服务端与客户端唯一共用的校验点）——响应体一律 `.parse()`，
// 入参不做客户端侧预校验：服务端已用同一份 schema `safeParse`，重复校验没有额外收益；
// 更重要的是「错误统一抛 SdkError」——本地 `.parse()` 失败会抛裸 `ZodError`，与服务端
// 拒收后映射出的 `SdkError(invalid_request)` 是两种类型，调用方的 `catch` 就得分别处理，
// 破坏了统一错误契约。入参类型仍由 `z.infer` 在编译期约束。本文件不依赖任何 `@luoli/*`，
// 运行时只依赖 zod + 全局 `fetch`（Node ≥ 18）。不做自动重试：错误统一抛出，是否重试、
// 何时重试由调用方决定。

/** `fetch` 的类型别名：真实进程用全局 `fetch`；测试用 `startTestRuntime` 的
 *  `server.request` 直接注入——两者签名兼容，Hono 的 `Hono.request()` 接受完整 URL
 *  字符串（`/^https?:\/\//` 判真时原样构造 `Request`，按路径路由，host 段不参与匹配），
 *  因此客户端统一拼 `${baseUrl}${path}` 传给注入的 `fetch`，无需对测试环境特殊分支。 */
export type SdkFetch = typeof fetch;

export interface SdkClientOptions {
  /** `/sdk/v1` 前缀之前的部分，例如 `http://127.0.0.1:8787`。末尾是否带斜杠不影响拼接。 */
  baseUrl: string;
  /** `sk-` 开头的 API key 明文，每次请求作为 `Authorization: Bearer <apiKey>` 发送。 */
  apiKey: string;
  /** 缺省取全局 `fetch`；测试注入 `startTestRuntime` 的 `server.request`。 */
  fetch?: SdkFetch;
}

/**
 * 错误码 → 规范状态码（服务端 `packages/server/src/sdk/{v1,errors}.ts` 的既定映射，逐条列出
 * 以借 TS 的 `Record<SdkErrorCode, number>` 做穷尽性检查——`sdkErrorCodeSchema` 未来再扩枚举时，
 * 这里漏一个键会直接编译失败，而不是悄悄少一个分支）。非流式响应优先使用 HTTP 真实状态码
 * （更权威，见 `toSdkError`），这张表只在 SSE `error` 事件（不经 HTTP 状态码传输）时启用。
 */
const STATUS_BY_CODE: Record<SdkErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  turn_queue_full: 429,
  upstream_error: 502,
  session_deleted: 404,
  not_implemented: 500,
  internal: 500,
  quota_exceeded: 429,
  cancelled: 409,
};

/** 队列满的退避固定 5 秒（A9：无更好的估计口径），仅用于 SSE 路径——HTTP 路径读真实 `Retry-After` 头。 */
const TURN_QUEUE_FULL_RETRY_AFTER_MS = 5000;

export interface SdkErrorParams {
  status: number;
  code: SdkErrorCode;
  message: string;
  retryable: boolean;
  /** 非必需但恒显式传入（`| undefined`而非可选 `?`——`exactOptionalPropertyTypes` 下两者不等价，
   *  调用方一律算出 `number | undefined` 后原样传入，不省略这个键）。 */
  retryAfterMs: number | undefined;
  /** 读流异常时保留的原始错误（`Error.cause`）；截断（EOF 前未见终结事件，无原始异常）时不传。 */
  cause?: unknown;
}

/**
 * 客户端统一的错误类型：HTTP 非 2xx 响应与 SSE `error` 事件都归一到这一种，调用方只需要写
 * 一套 `catch`。`code` 覆盖 `sdkErrorCodeSchema` 的全部 10 个值——响应体不符合契约（未匹配
 * 路由落到 SPA 兜底页等）时**复用**枚举里已有的 `"internal"` 值兜底，不额外引入第 11 个
 * 不在契约里的值（不伪造一个更精确的诊断）。
 *
 * `retryable` 原样转发服务端取值——`cancelled`（409）服务端标 `retryable:true`，语义是
 * 「可以发起新一轮」，不是「这次请求本身值得重放」。客户端本身不做任何自动重试（团队约定），
 * `autoRetryable` 是这条区分的类型化落点：`cancelled` 恒为 `false`，供调用方将来需要实现
 * 自动重试时不至于对着一次被人取消的轮次反复重发。
 */
export class SdkError extends Error {
  readonly status: number;
  readonly code: SdkErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(params: SdkErrorParams) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SdkError";
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
    if (params.retryAfterMs !== undefined) this.retryAfterMs = params.retryAfterMs;
  }

  /** `retryable && code !== "cancelled"`：见类文档注释。 */
  get autoRetryable(): boolean {
    return this.retryable && this.code !== "cancelled";
  }
}

function retryAfterMsFromHeader(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** 非 2xx 响应 → `SdkError`。响应体优先按 `sdkErrorResponseSchema` 解析；不符合契约时
 *  （未匹配路由落到 SPA 兜底页、反向代理注入的错误页等）不伪造精确诊断，`code` 兜底为
 *  `"internal"`，`retryable` 按状态码猜一个粗略但不离谱的值（5xx 猜可重试，4xx 猜不可）。 */
async function toSdkError(response: Response): Promise<SdkError> {
  const retryAfterMs = retryAfterMsFromHeader(response);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* 非 JSON 响应体，走下面的兜底分支 */
  }
  const parsed = sdkErrorResponseSchema.safeParse(body);
  if (parsed.success)
    return new SdkError({
      status: response.status,
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      retryable: parsed.data.error.retryable,
      retryAfterMs,
    });
  return new SdkError({
    status: response.status,
    code: "internal",
    message: `响应体不符合 SDK 错误契约（HTTP ${response.status}）`,
    retryable: response.status >= 500,
    retryAfterMs,
  });
}

/** SSE `error` 事件 → `SdkError`。事件本身已经过 `sdkStreamEventSchema.parse`，形状必然合法，
 *  这里只做码值 → 状态码/退避的换算。 */
function sdkErrorFromStreamEvent(data: SdkStreamErrorData): SdkError {
  return new SdkError({
    status: STATUS_BY_CODE[data.code],
    code: data.code,
    message: data.message,
    retryable: data.retryable,
    retryAfterMs: data.code === "turn_queue_full" ? TURN_QUEUE_FULL_RETRY_AFTER_MS : undefined,
  });
}

function authHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  return hasBody
    ? { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
    : { authorization: `Bearer ${apiKey}` };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, baseUrl);
  if (query)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * 一帧 SSE 原始字段（未经 `sdkStreamEventSchema` 校验）。`data` 允许多行（按 SSE 规范以 `\n`
 * 拼接）；本协议的写入端（`packages/server/src/sdk/v1.ts`）恒单行 `JSON.stringify`，这里按规范
 * 兼容多行只是不给未来的写法留坑，不是当前必需路径。
 */
interface RawSseFrame {
  event: string;
  data: unknown;
}

/** 解析一帧已按行切好的 SSE 字段（行终止符已在上一层剥离）；无 `data:` 字段的帧
 *  （心跳注释帧等）返回 `null`，调用方跳过。 */
function parseSseFrame(lines: string[]): RawSseFrame | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // `:` 开头是 SSE 注释
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // `id:`/`retry:` 等字段本协议未使用，读到即忽略——不是解析失败。
  }
  if (!dataLines.length) return null;
  return { event: eventName, data: JSON.parse(dataLines.join("\n")) };
}

/** 在 `buffer` 中找下一个行终止符（SSE / RFC 9110 承认的三种：`\r\n`、`\n`、`\r`）。
 *  `atEof` 为 true 时把落在缓冲区末尾的单个 `\r` 也判为终止符；为 false 时该情形返回
 *  `null`——此时无法判断这是一个独立的 `\r` 换行，还是被读切开的 `\r\n` 的前半段，
 *  需要等下一次 `read()` 补上后续字节再判断。 */
function findLineBreak(buffer: string, atEof: boolean): { lineEnd: number; next: number } | null {
  for (let i = 0; i < buffer.length; i++) {
    const code = buffer.charCodeAt(i);
    if (code === 10 /* \n */) return { lineEnd: i, next: i + 1 };
    if (code === 13 /* \r */) {
      if (i + 1 < buffer.length)
        return { lineEnd: i, next: buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1 };
      if (atEof) return { lineEnd: i, next: i + 1 };
      return null;
    }
  }
  return null;
}

/** `reader.read()` 本身抛错（上游 TCP reset、反代提前断连等）在生成器内部标记出来，
 *  与 `sdkStreamEventSchema` 校验失败（裸 `ZodError`，见 E 场景/O-4）区分：前者是传输层
 *  故障，由 `streamMessage()` 统一包装成 `SdkError`；后者是契约违反，不是本次修复范围。 */
class SseStreamReadError extends Error {
  constructor(cause: unknown) {
    super("SSE 流读取中断", { cause });
    this.name = "SseStreamReadError";
  }
}

/**
 * 自写 SSE 解析（无第三方依赖）：按行增量消费（`for await` 每读到一帧立即产出），排队场景
 * 需要在响应尚未结束时就读到 `queued` 事件，读到流末尾才整体返回数组无法覆盖这一判据（与
 * `tests/sdk.stream.test.ts` 的 `sseEvents()` 同一手法，独立实现——两处都只有几十行，抽公共
 * 模块的收益小于跨包共享一份测试专用代码带来的耦合）。
 *
 * 帧边界是「空行」（连续两个行终止符），不是固定的 `"\n\n"` 子串——`findLineBreak` 逐行识别
 * `\r\n`/`\n`/`\r` 三种终止符，因此 `\r\n\r\n`（CRLF 流）、`\n\n`（LF 流）、`\r\r` 均落在同一套
 * 逻辑里，不需要分别匹配三种子串。
 */
async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameLines: string[] = [];

  function drainLines(atEof: boolean): RawSseFrame[] {
    const frames: RawSseFrame[] = [];
    for (;;) {
      const brk = findLineBreak(buffer, atEof);
      if (!brk) break;
      const line = buffer.slice(0, brk.lineEnd);
      buffer = buffer.slice(brk.next);
      if (line === "") {
        if (frameLines.length) {
          const parsed = parseSseFrame(frameLines);
          frameLines = [];
          if (parsed) frames.push(parsed);
        }
      } else {
        frameLines.push(line);
      }
    }
    return frames;
  }

  try {
    for (;;) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (cause) {
        throw new SseStreamReadError(cause);
      }
      if (value) buffer += decoder.decode(value, { stream: true });
      for (const frame of drainLines(false)) yield frame;
      if (done) {
        for (const frame of drainLines(true)) yield frame;
        // 末帧缺尾随空行（连接提前关闭等）时，缓冲区仍有一行残留内容——并入当前帧再解析
        // 一次，避免静默丢弃末尾事件。
        if (buffer) {
          frameLines.push(buffer);
          buffer = "";
        }
        if (frameLines.length) {
          const parsed = parseSseFrame(frameLines);
          if (parsed) yield parsed;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface SdkListSessionsResult {
  sessions: SdkSession[];
  nextCursor: string | null;
}

export type SdkListCommitsResult = Omit<SdkCommitListResponse, "ok">;

export interface SdkResetResult {
  commitId: string;
}

/**
 * 十个端点方法 + `LuoliSdkClient` 类型别名（供只想要类型、不想要值的调用方引用）。
 * `sendMessage`/`streamMessage` 的 `endUserId` 由调用方传入，服务端落库前统一加 `<sourceId>:`
 * 前缀（T3.6a 接口说明），客户端不重复这层拼接。
 */
export interface LuoliSdkClient {
  createSession(input?: SdkCreateSessionInput): Promise<SdkSession>;
  listSessions(query?: SdkPageQuery): Promise<SdkListSessionsResult>;
  getSession(id: string): Promise<SdkSession>;
  patchSession(id: string, input: SdkUpdateSessionInput): Promise<SdkSession>;
  deleteSession(id: string): Promise<void>;
  purgeSession(id: string): Promise<void>;
  resetSession(id: string): Promise<SdkResetResult>;
  listCommits(id: string, query?: SdkPageQuery): Promise<SdkListCommitsResult>;
  sendMessage(id: string, input: SdkSendMessageInput): Promise<SdkMessageResponse>;
  /** 返回已解析事件的 `AsyncIterable`：`delta`/`queued` 逐条产出；遇到 `error` 事件时
   *  抛出 `SdkError`（不作为普通事件产出，与其余三种失败路径共用同一套 `catch`）；
   *  遇到 `done` 事件产出后正常结束迭代（不再等待流关闭，服务端在 `done` 后立即 `close()`）。
   *  流在收到 `done`/`error` 之前即到达 EOF（连接半路关闭）时同样抛出 `SdkError`
   *  （`code: "upstream_error"`，说明流被截断）；读流过程本身抛错时一并包装为
   *  `SdkError`（同码，原始错误保留在 `cause`）——调用方对四类失败只需要写一套 `catch`。 */
  streamMessage(id: string, input: SdkSendMessageInput): AsyncIterable<SdkStreamEvent>;
}

export function createSdkClient(options: SdkClientOptions): LuoliSdkClient {
  const { baseUrl, apiKey } = options;
  const fetchImpl: SdkFetch = options.fetch ?? fetch;

  async function callJson<T>(
    method: string,
    path: string,
    schema: { parse(value: unknown): T },
    init: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const hasBody = init.body !== undefined;
    const response = await fetchImpl(buildUrl(baseUrl, path, init.query), {
      method,
      headers: authHeaders(apiKey, hasBody),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) throw await toSdkError(response);
    return schema.parse(await response.json());
  }

  return {
    async createSession(input = {}) {
      const parsed = await callJson("POST", "/sdk/v1/sessions", sdkSessionResponseSchema, {
        body: input,
      });
      return parsed.session;
    },

    async listSessions(query = {}) {
      const parsed = await callJson("GET", "/sdk/v1/sessions", sdkSessionListResponseSchema, {
        query: { cursor: query.cursor, limit: query.limit },
      });
      return { sessions: parsed.sessions, nextCursor: parsed.nextCursor };
    },

    async getSession(id) {
      const parsed = await callJson(
        "GET",
        `/sdk/v1/sessions/${encodeURIComponent(id)}`,
        sdkSessionResponseSchema,
      );
      return parsed.session;
    },

    async patchSession(id, input) {
      const parsed = await callJson(
        "PATCH",
        `/sdk/v1/sessions/${encodeURIComponent(id)}`,
        sdkSessionResponseSchema,
        { body: input },
      );
      return parsed.session;
    },

    async deleteSession(id) {
      await callJson(
        "DELETE",
        `/sdk/v1/sessions/${encodeURIComponent(id)}`,
        sdkOkResponseSchema,
      );
    },

    async purgeSession(id) {
      await callJson(
        "POST",
        `/sdk/v1/sessions/${encodeURIComponent(id)}/purge`,
        sdkOkResponseSchema,
      );
    },

    async resetSession(id) {
      const parsed = await callJson(
        "POST",
        `/sdk/v1/sessions/${encodeURIComponent(id)}/reset`,
        sdkResetResponseSchema,
      );
      return { commitId: parsed.commitId };
    },

    async listCommits(id, query = {}) {
      const parsed = await callJson(
        "GET",
        `/sdk/v1/sessions/${encodeURIComponent(id)}/commits`,
        sdkCommitListResponseSchema,
        { query: { cursor: query.cursor, limit: query.limit } },
      );
      return { commits: parsed.commits, nextCursor: parsed.nextCursor };
    },

    async sendMessage(id, input) {
      return callJson(
        "POST",
        `/sdk/v1/sessions/${encodeURIComponent(id)}/messages`,
        sdkMessageResponseSchema,
        { body: input },
      );
    },

    async *streamMessage(id, input) {
      const response = await fetchImpl(
        buildUrl(baseUrl, `/sdk/v1/sessions/${encodeURIComponent(id)}/messages/stream`),
        {
          method: "POST",
          headers: authHeaders(apiKey, true),
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw await toSdkError(response);
      if (!response.body)
        throw new SdkError({
          status: response.status,
          code: "internal",
          message: "流式响应无 body",
          retryable: false,
          retryAfterMs: undefined,
        });
      try {
        for await (const frame of parseServerSentEvents(response.body)) {
          const event = sdkStreamEventSchema.parse(frame);
          if (event.event === "error") throw sdkErrorFromStreamEvent(event.data);
          yield event;
          if (event.event === "done") return;
        }
      } catch (err) {
        // 读流本身抛错（TCP reset、反代提前断连）——包装为 SdkError，原始错误保留在 cause。
        // 其余错误（上面 throw 的 SdkError、`sdkStreamEventSchema.parse` 的裸 ZodError）原样透传。
        if (err instanceof SseStreamReadError)
          throw new SdkError({
            status: STATUS_BY_CODE.upstream_error,
            code: "upstream_error",
            message: "流式响应读取中断",
            retryable: true,
            retryAfterMs: undefined,
            cause: err.cause,
          });
        throw err;
      }
      // for-await 正常耗尽（EOF）却未经过 done/error 分支：流在收到终结事件前已被关闭，
      // 调用方无法凭空区分「完整结束」与「截断」，统一抛错而不是静默结束迭代。
      throw new SdkError({
        status: STATUS_BY_CODE.upstream_error,
        code: "upstream_error",
        message: "流在收到终结事件前已关闭（截断）",
        retryable: true,
        retryAfterMs: undefined,
      });
    },
  };
}
