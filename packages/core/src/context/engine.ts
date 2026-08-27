import { ulid } from "ulid";
import type {
  ArchivedMessage,
  ArchiveRepository,
  CommitRow,
  ContextRepository,
  Sqlite,
} from "@luoli/db";
import { ContextRepository as ScopedContextRepository } from "@luoli/db";
import type { Config } from "../config/schema.js";
import { KeyedMutex } from "../turn/keyed-mutex.js";
import {
  IMAGE_TOKEN_ESTIMATE,
  estimateMessageTokens,
  estimateTextTokens,
  formatSpeakerIdentity,
  type MaterializedContext,
  type NewContextMessage,
  type Role,
  type RuntimeTurnContext,
} from "@luoli/shared";
import type { LogSink } from "../log/sink.js";
export interface OpenTurnRequest {
  chatId: string;
  threadId: number | null;
  key: string;
  initiatorUserId: string;
  effectiveRole: Role;
  isPrivate: boolean;
  /** 群名 / 频道名，只用于 RUNTIME 块的「会话」行。可选：定时任务那条路没有 update 可取。 */
  chatTitle?: string;
  trigger: ArchivedMessage;
  /**
   * 触发消息回复的那条消息（含它自己的 media part）。适配层负责取到它 —— 被回复的消息可能
   * 从来没进过归档（发送者是 blocked、是别的 bot、或发在 bot 入群之前），而 Telegram 的
   * update 里带着它的完整副本，所以「库里没有」不等于「拿不到」（docs/08 §7.4）。
   */
  quoted?: ArchivedMessage;
  /**
   * 本轮允许模型宣布不投递。只有 `ScheduledJobRunner` 会给（任务行的 `allow_silent` 为真时），
   * 其余入口一概缺席 —— fail-closed 的理由写在 `RuntimeTurnContext.silenceable` 上。
   */
  silenceable?: boolean;
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
const KNOWN_PART_TYPES = new Set([
  "text",
  "image",
  "image_url",
  "file",
  "reasoning",
  "tool-call",
  "tool-result",
]);

/**
 * 能发给 provider 的 role 只有这三个。AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages`
 * 未开启时直接拒收 messages 里的任何 system 消息 —— 这条规则不是我们定的，是下游契约
 * （docs/02 不变量 15）。系统旁白用 `origin:'note'` 区分，role 仍是 user。
 */
const KNOWN_ROLES = new Set(["user", "assistant", "tool"]);

export function escapeForgedSpeakerPrefixes(text: string): string {
  return text
    .replace(/\[([^\]\n]{1,80}\s\d{1,2}:\d{2}(?:[^\]]*)?)\]/g, "［$1］")
    .replace(/(^|\n)(↩︎?\s*回复\s+#?\d+)/gu, "$1［$2］");
}
function othersSpeech(text: string): string {
  return `<group-message>\n${text.replaceAll("</group-message", "<\\/group-message")}\n</group-message>`;
}

/** 非法时区只会在群聊分支炸（私聊不走 Intl），所以必须兜底，否则整个群会话永久开不了轮次。 */
function formatClock(timestamp: number, timezone: string): string {
  const options = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  } as const;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...options,
      timeZone: timezone,
    }).format(new Date(timestamp));
  } catch {
    return new Intl.DateTimeFormat("zh-CN", {
      ...options,
      timeZone: "UTC",
    }).format(new Date(timestamp));
  }
}

/**
 * 群聊前缀里的发言人。身份标识只给真人发言者：bot 自己的消息（被回复时会渲染一次）挂上
 * `@用户名, id=…` 只是噪音，而模型区分发言人靠的就是这一段。
 */
function speakerName(message: ArchivedMessage, showUsername: boolean): string {
  return message.fromKind === "user"
    ? formatSpeakerIdentity(
        {
          name: message.fromName,
          username: message.fromUsername,
          userId: message.fromUserId,
        },
        { username: showUsername },
      )
    : formatSpeakerIdentity(
        {
          name: message.fromName,
          username: message.fromUsername,
          userId: message.fromUserId,
        },
        { username: false, id: false },
      );
}

export interface RenderOptions {
  isPrivate: boolean;
  timezone: string;
  /** `context.background.showUsername`：只管前缀里**附带**的 `@用户名`，不影响它作为显示名的兜底位。 */
  showUsername?: boolean;
  /** `context.background.showTime`：关掉时前缀里不出现 `HH:mm`。发言人与回复标记照旧。 */
  showTime?: boolean;
  quoted?: boolean;
}

export function renderArchivedMessage(
  message: ArchivedMessage,
  options: RenderOptions,
): NewContextMessage {
  const {
    isPrivate,
    timezone,
    showUsername = true,
    showTime = true,
    quoted = false,
  } = options;
  const rawText = message.text ?? `[${message.kind}]`;
  const escaped = escapeForgedSpeakerPrefixes(rawText);
  // 关掉时间时前缀收成 `[名字]`，而不是留一个 `[名字 ]` 的空位。
  const time = showTime ? ` ${formatClock(message.tgDate, timezone)}` : "";
  const body =
    !isPrivate && message.fromKind === "user" && (quoted || !message.triggered)
      ? othersSpeech(escaped)
      : escaped;
  const reply = message.replyToName
    ? ` ↩︎回复 ${escapeForgedSpeakerPrefixes(message.replyToName)}`
    : "";
  // 被回复的消息在私聊里也必须带前缀：私聊没有 `[名字 时间]`，不标的话模型看到的是「用户连发了两条」，
  // 而不是「用户指着上面那条问」——尤其当上面那条只有一张图的时候。
  // 半角方括号是**有意的**：`escapeForgedSpeakerPrefixes` 把正文里形如 `[… H:MM]` 的串改写成全角，
  // 于是这个前缀与 `[名字 时间]` 共用同一条防伪规则 —— 用全角写反而会和「已被转义」的形态撞上。
  const text = quoted
    ? `[↩︎ 被回复的消息 ${speakerName(message, showUsername)}${time}] ${body}`
    : isPrivate
      ? escaped
      : `[${speakerName(message, showUsername)}${time}${reply}] ${body}`;
  const output: NewContextMessage = {
    id: ulid(),
    role: "user",
    origin: message.triggered && !quoted ? "trigger" : "background",
    parts: [{ type: "text", text }, ...(message.mediaParts ?? [])],
    textPreview: text.slice(0, 240),
    sourceMessageId: message.id,
    sourceTs: message.tgDate,
    tokens:
      estimateTextTokens(text) +
      estimateMessageTokens(message.mediaParts ?? []),
    pruneLevel: 0,
  };
  if (message.fromName) output.speaker = message.fromName;
  if (message.fromUserId) output.speakerUserId = message.fromUserId;
  return output;
}

/**
 * 「这个 part 是一张图」的**唯一**判据。`capImages` 与 `runtime.ts` 那条 vision 别名自动切换
 * （docs/04 §5.2）共用它 —— 两处各写一遍的话，一边认得出、另一边认不出的 part 就是一次
 * 「图片进了上下文但没切成 vision 模型」。
 */
export function isImagePart(part: unknown): boolean {
  const typed = part as { type?: unknown; mediaType?: unknown } | null;
  // 废弃的 `image` part 也算：写入侧早就只产 `file` 了，但 parts 是持久化的，库里那些历史 part
  // 要到读出侧才被 `imageToFilePart` 转过来（`runtime.ts`）—— 判据在转换之前就要认得它。
  if (typed?.type === "image") return true;
  return (
    typed?.type === "file" &&
    typeof typed.mediaType === "string" &&
    typed.mediaType.startsWith("image/")
  );
}

/**
 * `media.maxImagesPerTurn`：一轮里最多带几张图进上下文，**从后往前**保留 —— 超限时留下的是
 * 触发消息与最近几条，而不是相册里最早的那几张。图片按 1500 token 估（`IMAGE_TOKEN_ESTIMATE`），
 * 一次 10 张的相册能顶掉整个窗口。
 *
 * 超出的那张换成占位文本而不是删掉整条消息：不透明 part「要么原样保留，要么整体换成占位文本」
 * 是 docs/02 的不变量之一，而删掉整条会让发言人与时间一起消失。
 */
function capImages(delta: NewContextMessage[], limit: number): void {
  const slots: Array<{ message: NewContextMessage; index: number }> = [];
  for (const message of delta) {
    for (const [index, part] of (
      message.parts as Array<Record<string, unknown>>
    ).entries()) {
      if (isImagePart(part)) slots.push({ message, index });
    }
  }
  if (slots.length <= limit) return;
  for (const slot of slots.slice(0, slots.length - limit)) {
    const parts = slot.message.parts as Array<Record<string, unknown>>;
    parts[slot.index] = {
      type: "text",
      text: `[图片已省略：本轮图片数超过 media.maxImagesPerTurn=${limit}]`,
    };
    if (slot.message.tokens !== undefined)
      slot.message.tokens = Math.max(
        0,
        slot.message.tokens - IMAGE_TOKEN_ESTIMATE,
      );
  }
}

export class ContextEngine {
  readonly #mutex = new KeyedMutex();
  readonly #cache = new Map<string, MaterializedContext>();

  constructor(
    private readonly db: Sqlite,
    private readonly archive: ArchiveRepository,
    private readonly log?: LogSink,
  ) {}

  /** 轮次级事件挂在 trace 根之下（`docs/10 §1`）。`rootSpanId` 缺失（预览、试跑造的假 turn）时什么都不加。 */
  #parent(turn: RuntimeTurnContext): { parentSpanId?: string } {
    return turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {};
  }

  async openTurn(request: OpenTurnRequest): Promise<RuntimeTurnContext> {
    return this.#mutex.run(request.key, async () => {
      const turnId = ulid();
      const repo = new ScopedContextRepository(this.db, request.key);
      const ctx = repo.ensure(
        request.chatId,
        request.threadId,
        request.config.context.scope,
      );
      let head = repo.head();
      // 活跃期是**滑动的空闲间隔**，不是从首次唤醒起算的固定截止：每一轮提交都把它顺延一次，
      // 所以只要对话在继续就永远不裁剪。固定截止会在一场长对话正中间作废热缓存，恰好是最不该裁
      // 的时刻（docs/02 §5.1.1）。空上下文视同活跃期 —— 本来就没有可裁的东西。
      const active = request.config.context.active;
      const idleMs = head ? Date.now() - head.createdAt : 0;
      const inActivePeriod =
        active.windowMs > 0 && (head === null || idleMs <= active.windowMs);
      if (active.windowMs > 0 && !inActivePeriod && head) {
        // 空闲超期补裁。久别重逢的那一轮上下文可能已经是常规上限的数倍，等到 commitTurn 再裁的话
        // 这一轮要按全价发一次超大请求；在开轮前裁回去，此时缓存早已过期，裁剪不损失任何命中。
        const caught = this.prune(repo, head, request.config);
        if (caught) {
          head = caught.commit;
          this.invalidate(request.key);
          this.log?.event({
            level: "info",
            kind: "ctx.prune",
            summary: `Pruned ${request.key} after idle`,
            key: request.key,
            data: { ...caught.result, idleMs, reason: "idle_expired" },
          });
        }
      }
      const scopedArchive = this.archive.scope(
        request.chatId,
        request.threadId,
      );
      const claim = request.config.context.background.enabled
        ? scopedArchive.claimBackground(
            ctx.claimWatermark,
            request.trigger.id,
            request.config.context.background.maxPerTurn,
            turnId,
          )
        : { rows: [], omitted: 0 };
      try {
        return this.buildTurn(
          request,
          turnId,
          repo,
          ctx,
          head,
          claim,
          inActivePeriod,
        );
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
  private alreadyVisible(
    quoted: ArchivedMessage,
    snapshot: NewContextMessage[],
    claimed: ArchivedMessage[],
  ): boolean {
    if (snapshot.some((message) => message.sourceMessageId === quoted.id))
      return true;
    if (claimed.some((row) => row.id === quoted.id)) return true;
    return (
      Boolean(quoted.turnId) &&
      snapshot.some(
        (message) => (message as { turnId?: string }).turnId === quoted.turnId,
      )
    );
  }

  /** trace 的根：`turn.start` 的 spanId，也是本轮其余事件的 `parentSpanId`（`docs/10 §1`）。 */
  private buildTurn(
    request: OpenTurnRequest,
    turnId: string,
    repo: ContextRepository,
    ctx: { tokenRatio: number },
    head: CommitRow | null,
    claim: { rows: ArchivedMessage[]; omitted: number },
    deferPrune: boolean,
  ): RuntimeTurnContext {
    {
      const scale = (message: NewContextMessage): NewContextMessage => {
        if (message.tokens !== undefined)
          message.tokens = Math.ceil(message.tokens * ctx.tokenRatio);
        return message;
      };
      const background = request.config.context.background;
      const render = {
        isPrivate: request.isPrivate,
        timezone: request.config.general.timezone,
        showUsername: background.showUsername,
        showTime: background.showTime,
      };
      // `includeNonText=false`：纯图片 / 文件 / 贴纸的**背景**发言不进上下文。触发消息与被回复的
      // 消息不受它管 —— 那两条是用户此刻在说的话和他指着的东西，不是背景噪音。
      // 被滤掉的条数并进 omitted 的那句提示：认领水位已经推过去了，不说的话它们等于凭空消失。
      const claimed = background.includeNonText
        ? claim.rows
        : claim.rows.filter((message) => (message.text ?? "") !== "");
      const omitted = claim.omitted + (claim.rows.length - claimed.length);
      const delta = claimed.map((message) =>
        scale(renderArchivedMessage(message, render)),
      );
      if (omitted) {
        const note = `（本轮省略了 ${omitted} 条更早的群聊消息，可用 read_messages / search_messages 工具查阅）`;
        delta.unshift({
          id: ulid(),
          role: "user",
          origin: "note",
          parts: [{ type: "text", text: note }],
          textPreview: note,
          tokens: estimateTextTokens(note),
          pruneLevel: 0,
        });
      }
      const stored = repo.messages(head);
      this.assertValidShape(request.key, stored);
      // 被回复的消息排在背景消息之后、触发消息之前：它是这一句话的直接语境。
      // 判据用 `claimed` 而不是 `claim.rows`：被 includeNonText 滤掉的那条并没有进 delta，
      // 拿它当「已经看得见」会让被回复的那张图整个消失。
      if (
        request.quoted &&
        !this.alreadyVisible(request.quoted, stored, claimed)
      ) {
        delta.push(
          scale(
            renderArchivedMessage(request.quoted, { ...render, quoted: true }),
          ),
        );
      }
      delta.push(scale(renderArchivedMessage(request.trigger, render)));
      capImages(delta, request.config.media.maxImagesPerTurn);
      const snapshot: MaterializedContext = {
        messages: stored,
        ordinals: stored.map((message) => message.ordinal),
        tokens: stored.reduce((sum, message) => sum + (message.tokens ?? 0), 0),
        windowStart: head?.windowStart ?? 1,
        headOrdinal: head?.headOrdinal ?? 0,
      };
      const rootSpanId = ulid();
      // traceId + parentSpanId：`ctx.open` 此前两个都没有，于是它压根不出现在
      // `GET /api/logs/trace/:id` 的结果里 —— `docs/10 §1` 那张图的第一个节点在实现里是游离的。
      this.log?.event({
        level: "debug",
        kind: "ctx.open",
        summary: `Opened context ${request.key}`,
        traceId: turnId,
        parentSpanId: rootSpanId,
        chatId: request.chatId,
        userId: request.initiatorUserId,
        key: request.key,
        data: {
          baseCommit: head?.id ?? null,
          claimed: claim.rows.length,
          quoted: request.quoted?.id ?? null,
          snapshotTokens: snapshot.tokens,
          snapshotMsgs: snapshot.messages.length,
        },
      });
      return {
        turnId,
        key: request.key,
        chatId: request.chatId,
        threadId: request.threadId,
        initiatorUserId: request.initiatorUserId,
        effectiveRole: request.effectiveRole,
        isPrivate: request.isPrivate,
        ...(request.chatTitle ? { chatTitle: request.chatTitle } : {}),
        ...(request.silenceable ? { silenceable: true } : {}),
        // 「上一件发生的事是有人清空了上下文」：HEAD 就是那条 reset 且窗口还是空的。提交过一轮之后
        // HEAD 变成 turn commit，这一位自动消失 —— 它说的是「这一轮之前刚清过」，不是「清过」。
        ...(head?.kind === "reset" && stored.length === 0
          ? { contextCleared: true }
          : {}),
        baseCommitId: head?.id ?? null,
        rootSpanId,
        claimThroughMessageId: request.trigger.id,
        initiator: {
          name: request.trigger.fromName ?? null,
          username: request.trigger.fromUsername ?? null,
        },
        triggerTgMessageId: request.trigger.tgMessageId,
        snapshot,
        delta,
        abortSignal: request.abortSignal,
        tokenRatio: ctx.tokenRatio,
        deferPrune,
        config: request.config,
      };
    }
  }

  appendDelta(turn: RuntimeTurnContext, message: NewContextMessage): void {
    if (turn.finalized) throw new Error("turn_delta_finalized");
    if (message.ordinal !== undefined)
      throw new Error("ordinal is assigned only during commit");
    // 校准系数要对整个窗口一视同仁：只缩放 buildTurn 那几条、不缩放工具调用与回复，
    // 窗口里就会同时存在两种量纲的 tokens，裁剪判定按它们求和的结果自然是错的。
    if (message.tokens === undefined)
      message.tokens = Math.ceil(
        estimateMessageTokens(message.parts) * (turn.tokenRatio ?? 1),
      );
    turn.delta.push(message);
  }

  async commitTurn(turn: RuntimeTurnContext): Promise<CommitResult> {
    if (turn.finalized) throw new Error("turn_already_finalized");
    turn.finalized = true;
    const delta = [...turn.delta];
    // 写入侧也断言一次：坏形状在产生它的那一轮就报错，而不是等到下一轮物化才暴露。
    this.assertValidShape(turn.key, [...turn.snapshot.messages, ...delta]);
    this.assertPairedToolCalls(turn.key, delta);
    return this.#mutex.run(turn.key, async () => {
      const config = turn.config as Readonly<Config>;
      const repo = new ScopedContextRepository(this.db, turn.key);
      const inserted = repo.insertTurn(
        turn.turnId,
        turn.baseCommitId,
        delta,
        config.context.rebase.injectNotice,
        turn.claimThroughMessageId,
        config.context.rebase.markMeta,
      );
      this.invalidate(turn.key);
      const pruned = this.prune(
        repo,
        inserted.commit,
        config,
        turn.deferPrune === true,
      );
      this.invalidate(turn.key);
      this.log?.event({
        level: "info",
        kind: "ctx.commit",
        summary: `Committed ${turn.turnId}`,
        traceId: turn.turnId,
        ...this.#parent(turn),
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        key: turn.key,
        data: {
          commitId: (pruned?.commit ?? inserted.commit).id,
          rebased: inserted.rebased,
        },
      });
      if (inserted.rebased)
        this.log?.event({
          level: "warn",
          kind: "ctx.rebase",
          summary: `Rebased ${turn.turnId}`,
          traceId: turn.turnId,
          ...this.#parent(turn),
          key: turn.key,
          data: { base: turn.baseCommitId, onto: inserted.commit.parentId },
        });
      if (pruned)
        this.log?.event({
          level: "info",
          kind: "ctx.prune",
          summary: `Pruned ${turn.key}`,
          traceId: turn.turnId,
          ...this.#parent(turn),
          key: turn.key,
          data: pruned.result,
        });
      return {
        commit: pruned?.commit ?? inserted.commit,
        rebased: inserted.rebased,
        pruned: pruned?.result ?? null,
      };
    });
  }

  /**
   * `cancel.commitPartial`：取消时把已经生成的那部分也提交进历史（默认 false —— 取消通常意味着
   * 「这轮不算」，docs/14 A24）。开着时**只对 `cancelled` 生效**：`failed` 提交半截产出会把一段
   * 模型自己都没说完的话变成历史事实，下一轮还得在它上面接着编。
   *
   * 提交走的是正常的 `commitTurn` 路径，所以 rebase / 裁剪 / 形状断言一条都不少；提交失败时
   * 退回原来的「释放认领」，不让一次取消把整轮的背景消息也一起卡住。
   */
  async abortTurn(
    turn: RuntimeTurnContext,
    reason: "failed" | "cancelled",
    _error?: unknown,
  ): Promise<void> {
    const config = turn.config as Readonly<Config>;
    if (
      reason === "cancelled" &&
      config.cancel?.commitPartial &&
      turn.delta.length &&
      !turn.finalized
    ) {
      try {
        await this.commitTurn(turn);
        this.log?.event({
          level: "warn",
          kind: "ctx.abort",
          summary: "Committed partial delta on cancel",
          traceId: turn.turnId,
          ...this.#parent(turn),
          key: turn.key,
          data: { messages: turn.delta.length },
        });
        return;
      } catch (error) {
        this.log?.event({
          level: "error",
          kind: "ctx.abort",
          summary: "Partial commit failed; releasing claims instead",
          traceId: turn.turnId,
          ...this.#parent(turn),
          key: turn.key,
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    turn.finalized = true;
    const released = this.archive
      .scope(turn.chatId, turn.threadId)
      .releaseClaims(turn.turnId);
    this.log?.event({
      level: "warn",
      kind: "ctx.abort",
      summary: `Released ${released} background claims (${reason})`,
      traceId: turn.turnId,
      ...this.#parent(turn),
      key: turn.key,
    });
  }

  /**
   * @param cacheCommits `context.cacheCommits`：物化结果最多缓存多少个 commit。0 表示不缓存
   *   （排查「读出来的窗口和库里对不上」时用得着）。此前这个上界是写死的 64，配置项从没接线。
   */
  materialize(
    key: string,
    commitId: string | null,
    cacheCommits = 64,
  ): MaterializedContext {
    const repo = new ScopedContextRepository(this.db, key);
    const commit = commitId ? repo.commit(commitId) : repo.head();
    const cacheKey = `${key}:${commit?.id ?? "empty"}`;
    const cached = cacheCommits > 0 ? this.#cache.get(cacheKey) : undefined;
    if (cached) return structuredClone(cached);
    const messages = repo.messages(commit);
    this.assertValidShape(key, messages);
    const materialized = {
      messages,
      ordinals: messages.map((message) => message.ordinal),
      tokens: messages.reduce((sum, message) => sum + (message.tokens ?? 0), 0),
      windowStart: commit?.windowStart ?? 1,
      headOrdinal: commit?.headOrdinal ?? 0,
    };
    if (cacheCommits > 0) {
      this.#cache.set(cacheKey, structuredClone(materialized));
      while (this.#cache.size > cacheCommits)
        this.#cache.delete(this.#cache.keys().next().value!);
    }
    return materialized;
  }

  /**
   * `/new` 与 WebUI 的「清空上下文窗口」：插一条 reset commit 把窗口起点推到最新 ordinal 之后。
   * 消息一条不删 —— 这是刻意的（`docs/09 §3.10`「两者都不删消息」），所以**清空只挡窗口，挡不住
   * 归档工具**：实测清空后模型第一步就 `read_messages({direction:'before',limit:20})` 把 20 条历史
   * 整段捞回来，那份工具结果又落进新窗口（logs/2026-08-19 · `01M0CKK6W018B5KS9613SNEX5J`）。
   *
   * 所以这里顺手记下清空那一刻的归档水位（`meta.archiveFloor`），交给 `context.recallBarrier`
   * 决定要不要真的挡。**水位无条件记**：开关是运行时的，而 commit 是不可变的历史 ——
   * 事后打开开关时，没记过水位的旧 reset 就再也补不上了。
   *
   * @param advanceClaims 隔断开着时为真：把背景认领水位也推到同一处。否则清空之后第一轮会把
   *   清空之前那些还没被认领的群发言重新带进新窗口（`claimBackground` 认的是 `claim_watermark`
   *   到触发消息之间那一段，与窗口无关），一扇门关了另一扇门还开着。
   */
  reset(
    key: string,
    actor: string,
    options: { advanceClaims?: boolean } = {},
  ): CommitRow {
    const repo = new ScopedContextRepository(this.db, key);
    const head = repo.head();
    const max = repo.maxOrdinal();
    const context = repo.context();
    // 没有 contexts 行 = 这个 key 还没开过任何一轮（`/new` 打在从没被唤醒过的会话里）。
    // 那时既没有窗口也没有认领过的东西，水位记 0 就是「不设限」。
    const archiveFloor = context
      ? this.archive.scope(context.chatId, context.threadId).maxMessageId()
      : 0;
    if (options.advanceClaims && archiveFloor > 0)
      repo.advanceWatermark(archiveFloor);
    this.invalidate(key);
    return repo.insertControl("reset", {
      windowStart: max + 1,
      headOrdinal: max,
      parentId: head?.id ?? null,
      meta: { archiveFloor, advancedClaims: options.advanceClaims === true },
      createdBy: actor,
    });
  }

  /**
   * 归档检索的下限（`context.recallBarrier`）。**开关不在这里判** —— 调用方（`builtins.ts` 的三个
   * 归档工具）按本轮配置决定要不要用它，这样同一份水位在开关关掉时不影响任何查询。
   */
  recallFloor(key: string): number {
    return new ScopedContextRepository(this.db, key).recallFloor();
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
    if (!target) throw new Error("commit not found for context key");
    const commit = repo.insertControl("manual", {
      windowStart: target.windowStart,
      headOrdinal: target.headOrdinal,
      parentId: repo.head()?.id ?? null,
      meta: { targetCommitId: commitId },
      createdBy: actor,
    });
    this.invalidate(key);
    return commit;
  }

  /**
   * @param options.timeline 是否带上「这个会话有史以来的每一条上下文消息及其 parts」加最近 100 个
   *   commit。**默认不带** —— `context_stats` 工具此前拿的就是整份：随后 `#normalizeOutput` 按
   *   `tools.exec.maxOutputBytes`（64 KiB）从中间截断，模型看到的是一段掐断的 JSON，前 32 KiB
   *   是最早的历史、后 32 KiB 是 commit 列表，既烧 token 又没有信息（docs/27 · R-03）。
   *   WebUI 的 `GET /api/chats/:key/commits` 要这份时间线，所以它显式传 true。
   */
  stats(
    key: string,
    options: { timeline?: boolean } = {},
  ): Record<string, unknown> {
    const repo = new ScopedContextRepository(this.db, key);
    const head = repo.head();
    const context = repo.context();
    const marker = (
      what: "prune" | "rebase",
    ): { seq: number; at: number } | null => {
      const row = repo.latestCommitOf(what);
      return row ? { seq: row.seq, at: row.createdAt } : null;
    };
    const summary = {
      key,
      commit: head,
      claimWatermark: context?.claimWatermark ?? 0,
      messageCount: head?.msgCount ?? 0,
      tokens: head?.tokensTotal ?? 0,
      lastPrune: marker("prune"),
      lastRebase: marker("rebase"),
    };
    if (!options.timeline) return summary;
    const messages = repo
      .messagesThrough(head?.headOrdinal ?? repo.maxOrdinal())
      .map((message) => ({
        ...message,
        inWindow: Boolean(
          head &&
          message.ordinal >= head.windowStart &&
          message.ordinal <= head.headOrdinal,
        ),
      }));
    return { ...summary, commits: repo.commits(100), messages };
  }

  calibrate(
    key: string,
    realTokens: number,
    estimatedTokens: number,
    alpha: number,
  ): number {
    return new ScopedContextRepository(this.db, key).updateTokenRatio(
      realTokens,
      estimatedTokens,
      alpha,
    );
  }

  /** 配额预留要按「这一轮大概会发出去多少」估，而不是按上限的固定分数（docs/17 · N-QUOTA-01）。 */
  windowTokens(key: string): number {
    return new ScopedContextRepository(this.db, key).head()?.tokensTotal ?? 0;
  }

  private assertValidShape(key: string, messages: NewContextMessage[]): void {
    const calls = new Set<string>();
    for (const message of messages) {
      const parts = message.parts as Array<{
        type?: string;
        toolCallId?: string;
      }>;
      if (!KNOWN_ROLES.has(message.role))
        this.invalidShape(
          key,
          `role ${JSON.stringify(message.role)} cannot be sent to the provider`,
        );
      if (
        message.role === "tool" &&
        !parts.some((part) => part?.type === "tool-result")
      )
        this.invalidShape(key, "tool message lacks tool-result part");
      for (const part of parts) {
        if (part?.type !== undefined && !KNOWN_PART_TYPES.has(part.type))
          this.invalidShape(
            key,
            `unknown part type ${JSON.stringify(part.type)}`,
          );
        if (part?.type === "tool-call" && part.toolCallId)
          calls.add(part.toolCallId);
        if (
          part?.type === "tool-result" &&
          (!part.toolCallId || !calls.has(part.toolCallId))
        )
          this.invalidShape(
            key,
            `orphan tool-result ${part.toolCallId ?? "(missing id)"}`,
          );
      }
    }
  }

  /**
   * **反方向也要挡：没有配对 tool-result 的 tool-call。**
   *
   * `assertValidShape` 只查 orphan tool-**result** 那一个方向。反过来这一种同样致命，只是晚
   * 一轮才暴露：畸形请求体让 provider 0 步返回，AI SDK 于是用 `NoOutputGeneratedError` reject
   * 结果 promise，而 parts 是持久化的 —— 该会话在 `/new` 之前每轮都重演。实测
   * logs/2026-08-18 22:17 / 23:19 两次进程崩溃，根因是 `tool-error` 部件没被追进 delta
   * （`step.toolResults` 把它滤掉了，见 `runtime.ts` 的 `stepToolResults`）。
   *
   * **只查 `delta`，不查 snapshot。** 已经落库的历史里可能就带着这种孤儿（本次事故那条还在
   * 库里），拿它去挡提交等于把整条会话彻底锁死，比现在更糟。读出侧的自愈在 `runtime.ts` 的
   * `contextMessages` 里 —— 写入侧只负责「不再产生新的」，与 `hydrateAttachment` 同一分工。
   */
  private assertPairedToolCalls(key: string, delta: NewContextMessage[]): void {
    const results = new Set<string>();
    for (const message of delta) {
      for (const part of message.parts as Array<{
        type?: string;
        toolCallId?: string;
      }>) {
        if (part?.type === "tool-result" && part.toolCallId)
          results.add(part.toolCallId);
      }
    }
    for (const message of delta) {
      for (const part of message.parts as Array<{
        type?: string;
        toolCallId?: string;
      }>) {
        if (part?.type === "tool-call" && !results.has(part.toolCallId ?? ""))
          this.invalidShape(
            key,
            `orphan tool-call ${part.toolCallId ?? "(missing id)"}`,
          );
      }
    }
  }

  private invalidShape(key: string, reason: string): never {
    this.log?.event({
      level: "error",
      kind: "ctx.invalid_shape",
      summary: reason,
      key,
    });
    throw new Error(`invalid_context_shape: ${reason}`);
  }

  private invalidate(key: string): void {
    for (const cacheKey of this.#cache.keys())
      if (cacheKey.startsWith(`${key}:`)) this.#cache.delete(cacheKey);
  }

  /**
   * `deferrable`：这一轮落在活跃期内吗（`openTurn` 按距上一轮提交的间隔算好后快照进 `turn.deferPrune`）。
   * 活跃期内把**触发阈值**抬到 `context.active.*`，但**裁剪目标**恒为 `context.limit.*` ——
   * 裁到天花板等于此后每一轮都要在天花板上再裁一次，每次都作废整段前缀缓存，正是这个特性
   * 要消灭的东西（docs/02 §5.1.1 与红线 19）。推迟的方向永远是多留，所以 turn 边界、tool 配对、
   * `minKeepTurns` 这些形状不变式不可能因为它被破坏。
   */
  private prune(
    repo: ContextRepository,
    commit: CommitRow,
    config: Readonly<Config>,
    deferrable = false,
  ): {
    commit: CommitRow;
    result: { fromOrdinal: number; toOrdinal: number; levels: number[] };
  } | null {
    const active = config.context.active;
    if (deferrable && active.windowMs > 0) {
      // 早退在 `repo.messages()` 之前：活跃期内绝大多数轮次都走这条路，没必要为了一个不会用到的
      // 判断把整个窗口物化一遍。天花板取 max(active, limit)：把 active 配得比 limit 还小是无意义
      // 配置，但不该因此变成「比不开活跃期裁得还狠」。
      const stats = repo.effectiveStats(commit.windowStart, commit.headOrdinal);
      if (
        stats.tokens <= Math.max(active.tokens, config.context.limit.tokens) &&
        stats.count <=
          Math.max(active.maxMessages, config.context.limit.maxMessages)
      )
        return null;
    }
    const messages = repo.messages(commit);
    let windowStart = commit.windowStart;
    const starts = repo.turnStartOrdinals(
      commit.windowStart,
      commit.headOrdinal,
    );
    let index = 0;
    const over = () => {
      const stats = repo.effectiveStats(windowStart, commit.headOrdinal);
      return (
        stats.tokens > config.context.limit.tokens ||
        stats.count > config.context.limit.maxMessages
      );
    };
    while (
      over() &&
      starts.length - index > config.context.limit.minKeepTurns
    ) {
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
      if (
        !repo.hardTruncateLargest(
          windowStart,
          commit.headOrdinal,
          config.context.limit.tokens,
        )
      )
        break;
      hardTruncated = true;
    }
    if (over())
      this.log?.event({
        level: "error",
        kind: "ctx.hardcap",
        summary: "Hard truncation exhausted while context remains above limit",
        key: commit.key,
        data: { windowStart, headOrdinal: commit.headOrdinal },
      });
    if (
      windowStart === commit.windowStart &&
      applied.length === 0 &&
      !hardTruncated &&
      messages.length <= config.context.limit.maxMessages
    )
      return null;
    const pruneCommit = repo.insertControl("prune", {
      windowStart,
      headOrdinal: commit.headOrdinal,
      parentId: commit.id,
      meta: {
        reason: "over_limit",
        from: commit.windowStart,
        to: windowStart,
        levels: applied,
        hardTruncated,
      },
      createdBy: "system",
    });
    return {
      commit: pruneCommit,
      result: {
        fromOrdinal: commit.windowStart,
        toOrdinal: windowStart,
        levels: applied,
      },
    };
  }
}
