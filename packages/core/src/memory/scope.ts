/**
 * 记忆作用域键计算——唯一实现点（`docs/12-sdk.md` T2.3）。
 *
 * 四个 scope 全部按来源分路径：`assist` / `character` / `pubmemory` 的 subject 即 sourceId
 * 本身；`primemory` 的 subject 是复合键 `<sourceId>:<sessionId>`（Telegram 的 session 是用户 id，
 * 批三 SDK 的 session 是会话 id）。复合 subject 只作 `memory_docs` 表里的键，不直接当目录名——
 * `MemoryStore.path()` 用 `splitPrimemorySubject` 拆回两段各自拼目录。
 *
 * `builtins.ts` 的 `memory_read` / `memory_write` 经此函数取 subject，不再把
 * `context.turn.initiatorUserId` 直传给 `MemoryStore`。
 */

/** 内建 Telegram 来源的 id。批二仅此一个来源，批三新增来源经 API 签发各自的 ulid（A3）。 */
export const TELEGRAM_SOURCE_ID = "telegram";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `sourceId` 兼作目录段（`memory/sources/<sourceId>/`）、`messages.from_user_id` 前缀、复合
 * subject 的前缀三重用途（A3），必须不含 `:` 与路径字符：含 `/` 或 `..` 能逃出来源目录，
 * 含 `:` 与复合 subject 的分隔符冲突，`splitPrimemorySubject` 会拆错位置。
 */
export function assertValidSourceId(sourceId: string): void {
  if (!SOURCE_ID_PATTERN.test(sourceId))
    throw new Error(`invalid_source_id: ${sourceId}`);
}

/**
 * sessionId 是 `primemory` 复合 subject 的第二段、拆开后直接落 `private/<sessionId>/` 目录段
 * （`MemoryStore.path()`）。A3 的校验范围原文只提 sourceId，但同一条「不含 `:` 与路径字符」的
 * 理由对 sessionId 同样成立——含 `:` 会让 `splitPrimemorySubject` 按错误位置切分，含 `/` 或
 * `..` 能逃出 `private/` 目录。生产调用点（Telegram 数字 id、批三服务端生成的 uuid）天然满足，
 * 这里是防线不是预期会触发的分支。
 */
const SESSION_ID_FORBIDDEN = /[:/\\]|\.\./;

export function assertValidSessionId(sessionId: string): void {
  if (!sessionId || SESSION_ID_FORBIDDEN.test(sessionId))
    throw new Error(`invalid_session_id: ${sessionId}`);
}

export interface MemoryScopeSubjects {
  /** `pubmemory`（以及 `assist` / `character`，不经此函数、按同一条规则直接取 sourceId）的 subject。 */
  pubmemory: string;
  /** `primemory` 的复合 subject，`<sourceId>:<sessionId>`。 */
  primemory: string;
}

/**
 * 入参为本轮的来源与会话：Telegram 传 `sourceId='telegram'`、`sessionId=`发起用户 id；
 * 批三 SDK 传各自的来源 id 与会话 id。出参为 `pubmemory` 与 `primemory` 两个 scope 的 subject。
 */
export function memoryScopeSubjects(
  sourceId: string,
  sessionId: string,
): MemoryScopeSubjects {
  assertValidSourceId(sourceId);
  assertValidSessionId(sessionId);
  return {
    pubmemory: sourceId,
    primemory: `${sourceId}:${sessionId}`,
  };
}

/**
 * 从 `primemory` 的复合 subject 反解出目录段，供 `MemoryStore.path()` 与访问闸使用。
 * 按首个 `:` 切分——sourceId 一侧已由 `assertValidSourceId` 排除 `:`，因此不会切错位置。
 */
export function splitPrimemorySubject(subject: string): {
  sourceId: string;
  sessionId: string;
} {
  const index = subject.indexOf(":");
  if (index < 0) throw new Error(`invalid_primemory_subject: ${subject}`);
  return {
    sourceId: subject.slice(0, index),
    sessionId: subject.slice(index + 1),
  };
}
