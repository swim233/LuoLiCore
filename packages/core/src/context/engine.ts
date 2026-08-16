import { ulid } from 'ulid';
import type { ArchivedMessage, ArchiveRepository, CommitRow, ContextRepository, Sqlite } from '@luoli/db';
import { ContextRepository as ScopedContextRepository } from '@luoli/db';
import type { Config } from '../config/schema.js';
import { KeyedMutex } from '../turn/keyed-mutex.js';
import { estimateMessageTokens, estimateTextTokens, formatSpeakerIdentity, type MaterializedContext, type NewContextMessage, type Role, type RuntimeTurnContext } from '@luoli/shared';
import type { LogSink } from '../log/sink.js';
export interface OpenTurnRequest {
  chatId: string;
  threadId: number | null;
  key: string;
  initiatorUserId: string;
  effectiveRole: Role;
  isPrivate: boolean;
  trigger: ArchivedMessage;
  /**
   * 触发消息回复的那条消息（含它自己的 media part）。适配层负责取到它 —— 被回复的消息可能
   * 从来没进过归档（发送者是 blocked、是别的 bot、或发在 bot 入群之前），而 Telegram 的
   * update 里带着它的完整副本，所以「库里没有」不等于「拿不到」（docs/08 §7.4）。
   */
  quoted?: ArchivedMessage;
  abortSignal: AbortSignal;
  config: Readonly<Config>;
}

export interface CommitResult {
  commit: CommitRow;
  rebased: boolean;
  pruned: { fromOrdinal: number; toOrdinal: number; levels: number[] } | null;
}

/**
 * part 的判别字段必须属于这个集合。任何"按字符串遍历改写 parts"的逻辑（分级裁剪、硬截断）
 * 一旦碰坏 type，产出的 ModelMessage 会被 provider 直接拒绝，且改写结果是持久化的。
 */
const KNOWN_PART_TYPES = new Set(['text', 'image', 'image_url', 'file', 'reasoning', 'tool-call', 'tool-result']);

/**
 * 能发给 provider 的 role 只有这三个。AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages`
 * 未开启时直接拒收 messages 里的任何 system 消息 —— 这条规则不是我们定的，是下游契约
 * （docs/02 不变量 15）。系统旁白用 `origin:'note'` 区分，role 仍是 user。
 */
const KNOWN_ROLES = new Set(['user', 'assistant', 'tool']);

export function escapeForgedSpeakerPrefixes(text: string): string {
  return text.replace(/\[([^\]\n]{1,80}\s\d{1,2}:\d{2}(?:[^\]]*)?)\]/g, '［$1］').replace(/(^|\n)(↩︎?\s*回复\s+#?\d+)/gu, '$1［$2］');
}
function othersSpeech(text: string): string {
  return `<group-message>\n${text.replaceAll('</group-message', '<\\/group-message')}\n</group-message>`;
}


/** 非法时区只会在群聊分支炸（私聊不走 Intl），所以必须兜底，否则整个群会话永久开不了轮次。 */
function formatClock(timestamp: number, timezone: string): string {
  const options = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
  try { return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: timezone }).format(new Date(timestamp)); }
  catch { return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(timestamp)); }
}

/**
 * 群聊前缀里的发言人。身份标识只给真人发言者：bot 自己的消息（被回复时会渲染一次）挂上
 * `@用户名, id=…` 只是噪音，而模型区分发言人靠的就是这一段。
 */
function speakerName(message: ArchivedMessage, showUsername: boolean): string {
  return message.fromKind === 'user'
    ? formatSpeakerIdentity({ name: message.fromName, username: message.fromUsername, userId: message.fromUserId }, { username: showUsername })
    : formatSpeakerIdentity({ name: message.fromName, username: message.fromUsername, userId: message.fromUserId }, { username: false, id: false });
}

export interface RenderOptions {
  isPrivate: boolean;
  timezone: string;
  /** `context.background.showUsername`：只管前缀里**附带**的 `@用户名`，不影响它作为显示名的兜底位。 */
  showUsername?: boolean;
  quoted?: boolean;
}

export function renderArchivedMessage(message: ArchivedMessage, options: RenderOptions): NewContextMessage {
  const { isPrivate, timezone, showUsername = true, quoted = false } = options;
  const rawText = message.text ?? `[${message.kind}]`;
  const escaped = escapeForgedSpeakerPrefixes(rawText);
  const time = formatClock(message.tgDate, timezone);
  const body = !isPrivate && message.fromKind === 'user' && (quoted || !message.triggered) ? othersSpeech(escaped) : escaped;
  const reply = message.replyToName ? ` ↩︎回复 ${escapeForgedSpeakerPrefixes(message.replyToName)}` : '';
  // 被回复的消息在私聊里也必须带前缀：私聊没有 `[名字 时间]`，不标的话模型看到的是「用户连发了两条」，
  // 而不是「用户指着上面那条问」——尤其当上面那条只有一张图的时候。
  // 半角方括号是**有意的**：`escapeForgedSpeakerPrefixes` 把正文里形如 `[… H:MM]` 的串改写成全角，
  // 于是这个前缀与 `[名字 时间]` 共用同一条防伪规则 —— 用全角写反而会和「已被转义」的形态撞上。
  const text = quoted ? `[↩︎ 被回复的消息 ${speakerName(message, showUsername)} ${time}] ${body}`
    : isPrivate ? escaped : `[${speakerName(message, showUsername)} ${time}${reply}] ${body}`;
  const output: NewContextMessage = {
    id: ulid(), role: 'user', origin: message.triggered && !quoted ? 'trigger' : 'background',
    parts: [{ type: 'text', text }, ...(message.mediaParts ?? [])], textPreview: text.slice(0, 240), sourceMessageId: message.id,
    sourceTs: message.tgDate, tokens: estimateTextTokens(text) + estimateMessageTokens(message.mediaParts ?? []), pruneLevel: 0,
  };
  if (message.fromName) output.speaker = message.fromName;
  if (message.fromUserId) output.speakerUserId = message.fromUserId;
  return output;
}

export class ContextEngine {
  readonly #mutex = new KeyedMutex();
  readonly #cache = new Map<string, MaterializedContext>();

  constructor(private readonly db: Sqlite, private readonly archive: ArchiveRepository, private readonly log?: LogSink) {}

  async openTurn(request: OpenTurnRequest): Promise<RuntimeTurnContext> {
    return this.#mutex.run(request.key, async () => {
      const turnId = ulid();
      const repo = new ScopedContextRepository(this.db, request.key);
      const ctx = repo.ensure(request.chatId, request.threadId, request.config.context.scope);
      const head = repo.head();
      const scopedArchive = this.archive.scope(request.chatId, request.threadId);
      const claim = request.config.context.background.enabled
        ? scopedArchive.claimBackground(ctx.claimWatermark, request.trigger.id, request.config.context.background.maxPerTurn, turnId)
        : { rows: [], omitted: 0 };
      try {
        return this.buildTurn(request, turnId, repo, ctx, head, claim);
      } catch (error) {
        // 认领已经落库；这里不放行就等于把这批背景消息永久吞掉（水位还没推进，但 claimed_at 已非空）。
        if (claim.rows.length) scopedArchive.releaseClaims(turnId);
        throw error;
      }
    });
  }

  /**
   * 被回复的消息是否已经在模型眼前了。三种「已经看得到」：窗口里有它、本轮刚认领了它、
   * 或者它是 bot 自己某一轮的产出而那一轮的消息还在窗口里（bot 消息不带 sourceMessageId，
   * 只能靠 turn_id 反查）。判错的代价是每次「回复 bot」都把它上一句原样再贴一遍。
   */
  private alreadyVisible(quoted: ArchivedMessage, snapshot: NewContextMessage[], claimed: ArchivedMessage[]): boolean {
    if (snapshot.some((message) => message.sourceMessageId === quoted.id)) return true;
    if (claimed.some((row) => row.id === quoted.id)) return true;
    return Boolean(quoted.turnId) && snapshot.some((message) => (message as { turnId?: string }).turnId === quoted.turnId);
  }

  private buildTurn(request: OpenTurnRequest, turnId: string, repo: ContextRepository, ctx: { tokenRatio: number }, head: CommitRow | null, claim: { rows: ArchivedMessage[]; omitted: number }): RuntimeTurnContext {
    {
      const scale = (message: NewContextMessage): NewContextMessage => {
        if (message.tokens !== undefined) message.tokens = Math.ceil(message.tokens * ctx.tokenRatio);
        return message;
      };
      const render = { isPrivate: request.isPrivate, timezone: request.config.general.timezone, showUsername: request.config.context.background.showUsername };
      const delta = claim.rows.map((message) => scale(renderArchivedMessage(message, render)));
      if (claim.omitted) {
        const note = `（本轮省略了 ${claim.omitted} 条更早的群聊消息，可用 read_messages / search_messages 工具查阅）`;
        delta.unshift({ id: ulid(), role: 'user', origin: 'note', parts: [{ type: 'text', text: note }], textPreview: note, tokens: estimateTextTokens(note), pruneLevel: 0 });
      }
      const stored = repo.messages(head);
      this.assertValidShape(request.key, stored);
      // 被回复的消息排在背景消息之后、触发消息之前：它是这一句话的直接语境。
      if (request.quoted && !this.alreadyVisible(request.quoted, stored, claim.rows)) {
        delta.push(scale(renderArchivedMessage(request.quoted, { ...render, quoted: true })));
      }
      delta.push(scale(renderArchivedMessage(request.trigger, render)));
      const snapshot: MaterializedContext = {
        messages: stored,
        ordinals: stored.map((message) => message.ordinal),
        tokens: stored.reduce((sum, message) => sum + (message.tokens ?? 0), 0),
        windowStart: head?.windowStart ?? 1,
        headOrdinal: head?.headOrdinal ?? 0,
      };
      this.log?.event({ level: 'debug', kind: 'ctx.open', summary: `Opened context ${request.key}`, chatId: request.chatId, userId: request.initiatorUserId, key: request.key, data: { baseCommit: head?.id ?? null, claimed: claim.rows.length, quoted: request.quoted?.id ?? null, snapshotTokens: snapshot.tokens, snapshotMsgs: snapshot.messages.length } });
      return { turnId, key: request.key, chatId: request.chatId, threadId: request.threadId,
        initiatorUserId: request.initiatorUserId, effectiveRole: request.effectiveRole, isPrivate: request.isPrivate, baseCommitId: head?.id ?? null, claimThroughMessageId: request.trigger.id,
        initiator: { name: request.trigger.fromName ?? null, username: request.trigger.fromUsername ?? null },
        triggerTgMessageId: request.trigger.tgMessageId,
        snapshot, delta, abortSignal: request.abortSignal, tokenRatio: ctx.tokenRatio, config: request.config };
    }
  }

  appendDelta(turn: RuntimeTurnContext, message: NewContextMessage): void {
    if (turn.finalized) throw new Error('turn_delta_finalized');
    if (message.ordinal !== undefined) throw new Error('ordinal is assigned only during commit');
    // 校准系数要对整个窗口一视同仁：只缩放 buildTurn 那几条、不缩放工具调用与回复，
    // 窗口里就会同时存在两种量纲的 tokens，裁剪判定按它们求和的结果自然是错的。
    if (message.tokens === undefined) message.tokens = Math.ceil(estimateMessageTokens(message.parts) * (turn.tokenRatio ?? 1));
    turn.delta.push(message);
  }

  async commitTurn(turn: RuntimeTurnContext): Promise<CommitResult> {
    if (turn.finalized) throw new Error('turn_already_finalized');
    turn.finalized = true;
    const delta = [...turn.delta];
    // 写入侧也断言一次：坏形状在产生它的那一轮就报错，而不是等到下一轮物化才暴露。
    this.assertValidShape(turn.key, [...turn.snapshot.messages, ...delta]);
    return this.#mutex.run(turn.key, async () => {
      const config = turn.config as Readonly<Config>;
      const repo = new ScopedContextRepository(this.db, turn.key);
      const inserted = repo.insertTurn(turn.turnId, turn.baseCommitId, delta, config.context.rebase.injectNotice, turn.claimThroughMessageId);
      this.invalidate(turn.key);
      const pruned = this.prune(repo, inserted.commit, config);
      this.invalidate(turn.key);
      this.log?.event({ level: 'info', kind: 'ctx.commit', summary: `Committed ${turn.turnId}`, traceId: turn.turnId, chatId: turn.chatId, userId: turn.initiatorUserId, key: turn.key, data: { commitId: (pruned?.commit ?? inserted.commit).id, rebased: inserted.rebased } });
      if (inserted.rebased) this.log?.event({ level: 'warn', kind: 'ctx.rebase', summary: `Rebased ${turn.turnId}`, traceId: turn.turnId, key: turn.key, data: { base: turn.baseCommitId, onto: inserted.commit.parentId } });
      if (pruned) this.log?.event({ level: 'info', kind: 'ctx.prune', summary: `Pruned ${turn.key}`, traceId: turn.turnId, key: turn.key, data: pruned.result });
      return { commit: pruned?.commit ?? inserted.commit, rebased: inserted.rebased, pruned: pruned?.result ?? null };
    });
  }

  async abortTurn(turn: RuntimeTurnContext, reason: 'failed' | 'cancelled', _error?: unknown): Promise<void> {
    turn.finalized = true;
    const released = this.archive.scope(turn.chatId, turn.threadId).releaseClaims(turn.turnId);
    this.log?.event({ level: 'warn', kind: 'ctx.abort', summary: `Released ${released} background claims (${reason})`, traceId: turn.turnId, key: turn.key });
  }

  materialize(key: string, commitId: string | null): MaterializedContext {
    const repo = new ScopedContextRepository(this.db, key);
    const commit = commitId ? repo.commit(commitId) : repo.head();
    const cacheKey = `${key}:${commit?.id ?? 'empty'}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const messages = repo.messages(commit);
    this.assertValidShape(key, messages);
    const materialized = { messages, ordinals: messages.map((message) => message.ordinal),
      tokens: messages.reduce((sum, message) => sum + (message.tokens ?? 0), 0),
      windowStart: commit?.windowStart ?? 1, headOrdinal: commit?.headOrdinal ?? 0 };
    this.#cache.set(cacheKey, structuredClone(materialized));
    while (this.#cache.size > 64) this.#cache.delete(this.#cache.keys().next().value!);
    return materialized;
  }

  reset(key: string, actor: string): CommitRow {
    const repo = new ScopedContextRepository(this.db, key);
    const head = repo.head();
    const max = repo.maxOrdinal();
    this.invalidate(key);
    return repo.insertControl('reset', { windowStart: max + 1, headOrdinal: max, parentId: head?.id ?? null, createdBy: actor });
  }

  undo(key: string): CommitRow | null {
    const repo = new ScopedContextRepository(this.db, key);
    const head = repo.head();
    if (!head?.parentId) return null;
    repo.setHead(head.parentId);
    this.invalidate(key);
    return repo.head();
  }

  setHead(key: string, commitId: string, actor: string): CommitRow {
    const repo = new ScopedContextRepository(this.db, key);
    const target = repo.commit(commitId);
    if (!target) throw new Error('commit not found for context key');
    const commit = repo.insertControl('manual', { windowStart: target.windowStart, headOrdinal: target.headOrdinal,
      parentId: repo.head()?.id ?? null, meta: { targetCommitId: commitId }, createdBy: actor });
    this.invalidate(key);
    return commit;
  }

  stats(key: string): Record<string, unknown> {
    const repo = new ScopedContextRepository(this.db, key);
    const head = repo.head();
    const context = repo.context();
    const messages = repo.messagesThrough(head?.headOrdinal ?? repo.maxOrdinal()).map((message) => ({
      ...message, inWindow: Boolean(head && message.ordinal >= head.windowStart && message.ordinal <= head.headOrdinal),
    }));
    return { key, commit: head, claimWatermark: context?.claimWatermark ?? 0, messageCount: head?.msgCount ?? 0,
      tokens: head?.tokensTotal ?? 0, commits: repo.commits(100), messages };
  }

  calibrate(key: string, realTokens: number, estimatedTokens: number, alpha: number): number {
    return new ScopedContextRepository(this.db, key).updateTokenRatio(realTokens, estimatedTokens, alpha);
  }

  /** 配额预留要按「这一轮大概会发出去多少」估，而不是按上限的固定分数（docs/17 · N-QUOTA-01）。 */
  windowTokens(key: string): number {
    return new ScopedContextRepository(this.db, key).head()?.tokensTotal ?? 0;
  }

  private assertValidShape(key: string, messages: NewContextMessage[]): void {
    const calls = new Set<string>();
    for (const message of messages) {
      const parts = message.parts as Array<{ type?: string; toolCallId?: string }>;
      if (!KNOWN_ROLES.has(message.role)) this.invalidShape(key, `role ${JSON.stringify(message.role)} cannot be sent to the provider`);
      if (message.role === 'tool' && !parts.some((part) => part?.type === 'tool-result')) this.invalidShape(key, 'tool message lacks tool-result part');
      for (const part of parts) {
        if (part?.type !== undefined && !KNOWN_PART_TYPES.has(part.type)) this.invalidShape(key, `unknown part type ${JSON.stringify(part.type)}`);
        if (part?.type === 'tool-call' && part.toolCallId) calls.add(part.toolCallId);
        if (part?.type === 'tool-result' && (!part.toolCallId || !calls.has(part.toolCallId))) this.invalidShape(key, `orphan tool-result ${part.toolCallId ?? '(missing id)'}`);
      }
    }
  }

  private invalidShape(key: string, reason: string): never {
    this.log?.event({ level: 'error', kind: 'ctx.invalid_shape', summary: reason, key });
    throw new Error(`invalid_context_shape: ${reason}`);
  }

  private invalidate(key: string): void {
    for (const cacheKey of this.#cache.keys()) if (cacheKey.startsWith(`${key}:`)) this.#cache.delete(cacheKey);
  }

  private prune(repo: ContextRepository, commit: CommitRow, config: Readonly<Config>): { commit: CommitRow; result: { fromOrdinal: number; toOrdinal: number; levels: number[] } } | null {
    const messages = repo.messages(commit);
    let windowStart = commit.windowStart;
    const starts = repo.turnStartOrdinals(commit.windowStart, commit.headOrdinal);
    let index = 0;
    const over = () => {
      const stats = repo.effectiveStats(windowStart, commit.headOrdinal);
      return stats.tokens > config.context.limit.tokens || stats.count > config.context.limit.maxMessages;
    };
    while (over() && starts.length - index > config.context.limit.minKeepTurns) {
      index += 1;
      windowStart = starts[index]!;
    }
    const applied: number[] = [];
    for (const level of [2, 1]) {
      if (!over()) break;
      repo.markPruned(windowStart, commit.headOrdinal, level);
      applied.push(level);
    }
    let hardTruncated = false;
    for (let guard = 0; guard <= messages.length && over(); guard += 1) {
      if (!repo.hardTruncateLargest(windowStart, commit.headOrdinal, config.context.limit.tokens)) break;
      hardTruncated = true;
    }
    if (over()) this.log?.event({ level: 'error', kind: 'ctx.hardcap', summary: 'Hard truncation exhausted while context remains above limit', key: commit.key, data: { windowStart, headOrdinal: commit.headOrdinal } });
    if (windowStart === commit.windowStart && applied.length === 0 && !hardTruncated && messages.length <= config.context.limit.maxMessages) return null;
    const pruneCommit = repo.insertControl('prune', { windowStart, headOrdinal: commit.headOrdinal, parentId: commit.id,
      meta: { reason: 'over_limit', from: commit.windowStart, to: windowStart, levels: applied, hardTruncated }, createdBy: 'system' });
    return { commit: pruneCommit, result: { fromOrdinal: commit.windowStart, toOrdinal: windowStart, levels: applied } };
  }
}
