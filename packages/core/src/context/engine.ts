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
  /** 群名或频道名，只用于 RUNTIME 块的会话行。可选：定时任务路径没有 update 可读取。 */
  chatTitle?: string;
  trigger: ArchivedMessage;
  /**
   * 触发消息所回复的那条消息（含其自身的 media part）。由适配层负责获取 —— 被回复的消息可能
   * 从未进入归档（发送者为 blocked、为其它 bot、或发送于 bot 入群之前），而 Telegram 的
   * update 中携带其完整副本，因此库中不存在不等于无法获取（docs/08 §7.4）。
   */
  quoted?: ArchivedMessage;
  /**
   * 本轮允许模型声明不投递。只有 `ScheduledJobRunner` 会传入（任务行的 `allow_silent` 为真时），
   * 其余入口一律不传 —— fail-closed 的理由记录在 `RuntimeTurnContext.silenceable` 上。
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
 * part 的判别字段必须属于该集合。任何按字符串遍历改写 parts 的逻辑（分级裁剪、硬截断）
 * 一旦破坏 type，产出的 ModelMessage 会被 provider 直接拒绝，且改写结果是持久化的。
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
 * 可发送给 provider 的 role 只有这三个。AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages`
 * 未开启时直接拒收 messages 中的任何 system 消息 —— 该规则并非本项目制定，属下游契约
 * （docs/02 不变量 15）。系统旁白用 `origin:'note'` 区分，role 仍为 user。
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

/** 非法时区只在群聊分支抛错（私聊不经 Intl），因此必须兜底，否则整个群会话永久无法开启轮次。 */
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
 * 群聊前缀中的发言人。身份标识只提供给真人发言者：bot 自身的消息（被回复时会渲染一次）附加
 * `@用户名, id=…` 只是噪音，而模型正是依据这一段区分发言人。
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
  /** `context.background.showUsername`：只控制前缀中附带的 `@用户名`，不影响它作为显示名的兜底作用。 */
  showUsername?: boolean;
  /** `context.background.showTime`：关闭时前缀中不出现 `HH:mm`。发言人与回复标记保持不变。 */
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
  // 关闭时间显示时前缀收缩为 `[名字]`，而不是保留 `[名字 ]` 的空位。
  const time = showTime ? ` ${formatClock(message.tgDate, timezone)}` : "";
  const body =
    !isPrivate && message.fromKind === "user" && (quoted || !message.triggered)
      ? othersSpeech(escaped)
      : escaped;
  const reply = message.replyToName
    ? ` ↩︎回复 ${escapeForgedSpeakerPrefixes(message.replyToName)}`
    : "";
  // 编辑过的消息必须自带标记。不标记的话它以裸 `[user]` 形态进入上下文，与一条刚发送的新消息
  // 完全无法区分 —— 实测模型将五分钟前被编辑的一句「早」当作刚说的话并作出回应
  // （docs/29 · `M-TG-02`）。时间戳字段是 `edit_date`，它只表明修改时间，无法表明这是编辑内容。
  const edited = (message.revision ?? 0) > 0 ? " · 已编辑" : "";
  // 被回复的消息在私聊中同样必须带前缀：私聊没有 `[名字 时间]`，不标记的话模型看到的是用户连发
  // 两条消息，而不是用户针对上一条提问 —— 尤其当上一条只有一张图片时。
  // 使用半角方括号是刻意的：`escapeForgedSpeakerPrefixes` 会将正文中形如 `[… H:MM]` 的串改写为
  // 全角，因此该前缀与 `[名字 时间]` 共用同一条防伪规则 —— 改用全角反而会与已转义的形态冲突。
  const text = quoted
    ? `[↩︎ 被回复的消息 ${speakerName(message, showUsername)}${time}${edited}] ${body}`
    : isPrivate
      ? // 私聊没有 `[名字 时间]` 字段，标记只能自行构造前缀 —— 而私聊正是该缺陷被实测发现的场景。
        `${edited ? "[已编辑] " : ""}${escaped}`
      : `[${speakerName(message, showUsername)}${time}${reply}${edited}] ${body}`;
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
 * 判定 part 是否为图片的唯一判据。`capImages` 与 `runtime.ts` 的 vision 别名自动切换
 * （docs/04 §5.2）共用它 —— 两处各写一份的话，一侧可识别而另一侧不可识别的 part 即构成
 * 图片进入上下文但未切换到 vision 模型的情形。
 */
export function isImagePart(part: unknown): boolean {
  const typed = part as { type?: unknown; mediaType?: unknown } | null;
  // 已废弃的 `image` part 同样计入：写入侧早已只产出 `file`，但 parts 是持久化的，库中的历史 part
  // 要到读出侧才由 `imageToFilePart` 转换（`runtime.ts`）—— 判据必须在转换之前即可识别它。
  if (typed?.type === "image") return true;
  return (
    typed?.type === "file" &&
    typeof typed.mediaType === "string" &&
    typed.mediaType.startsWith("image/")
  );
}

/**
 * `media.maxImagesPerTurn`：一轮内最多携带多少张图片进入上下文，从后向前保留 —— 超限时保留的是
 * 触发消息与最近的几条，而非相册中最早的几张。图片按 1500 token 估算（`IMAGE_TOKEN_ESTIMATE`），
 * 一次 10 张的相册即可占满整个窗口。
 *
 * 超出的图片替换为占位文本而非删除整条消息：不透明 part 要么原样保留、要么整体替换为占位文本，
 * 是 docs/02 的不变量之一，而删除整条会使发言人与时间一并丢失。
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

  /** 轮次级事件挂在 trace 根之下（`docs/10 §1`）。`rootSpanId` 缺失（预览、试跑构造的合成 turn）时不添加。 */
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
      // 活跃期是滑动的空闲间隔，而非从首次唤醒起算的固定截止：每一轮提交都会顺延一次，
      // 因此只要对话在继续就不会裁剪。固定截止会在长对话中途作废热缓存，恰是最不应裁剪
      // 的时刻（docs/02 §5.1.1）。空上下文视同活跃期 —— 本就没有可裁剪的内容。
      const active = request.config.context.active;
      const idleMs = head ? Date.now() - head.createdAt : 0;
      const inActivePeriod =
        active.windowMs > 0 && (head === null || idleMs <= active.windowMs);
      if (active.windowMs > 0 && !inActivePeriod && head) {
        // 空闲超期后补充裁剪。长时间未对话后的第一轮，上下文可能已达常规上限的数倍，若等到
        // commitTurn 再裁剪，本轮需按全价发送一次超大请求；在开轮前裁剪回去时缓存早已过期，
        // 裁剪不损失任何命中。
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
        // 认领已写入库；此处不放行等于永久丢弃这批背景消息（水位尚未推进，但 claimed_at 已非空）。
        if (claim.rows.length) scopedArchive.releaseClaims(turnId);
        throw error;
      }
    });
  }

  /**
   * 被回复的消息是否已在模型可见范围内。三种可见情形：窗口中已有它、本轮刚认领了它、
   * 或它是 bot 某一轮的产出而该轮消息仍在窗口中（bot 消息不带 sourceMessageId，
   * 只能通过 turn_id 反查）。判定错误的代价是每次回复 bot 都会重复贴出它的上一句。
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

  /** trace 的根节点：`turn.start` 的 spanId，同时是本轮其余事件的 `parentSpanId`（`docs/10 §1`）。 */
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
      // `includeNonText=false`：纯图片 / 文件 / 贴纸的背景消息不进入上下文。触发消息与被回复的
      // 消息不受其约束 —— 那两条是用户当前所说的内容及其所指对象，不属于背景噪音。
      // 被过滤的条数并入 omitted 提示：认领水位已经推进，不说明的话它们等于凭空消失。
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
      // 被回复的消息排在背景消息之后、触发消息之前：它是当前这句话的直接语境。
      // 判据使用 `claimed` 而非 `claim.rows`：被 includeNonText 过滤掉的那条并未进入 delta，
      // 将其视为已可见会使被回复的那张图片完全消失。
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
      // traceId 与 parentSpanId：`ctx.open` 此前两者都缺失，因此它完全不出现在
      // `GET /api/logs/trace/:id` 的结果中 —— `docs/10 §1` 图中的第一个节点在实现中是游离的。
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
        // 表示上一次发生的操作是清空上下文：HEAD 即那条 reset 且窗口仍为空。提交一轮之后
        // HEAD 变为 turn commit，该标志自动消失 —— 它表达的是本轮之前刚清空过，而非曾经清空过。
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
    // 校准系数必须对整个窗口一致应用：只缩放 buildTurn 的那几条而不缩放工具调用与回复，
    // 窗口中就会同时存在两种量纲的 tokens，裁剪判定按其求和结果自然是错误的。
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
    // 写入侧同样断言一次：非法形状在产生它的那一轮即报错，而不是等到下一轮物化时才暴露。
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
   * `cancel.commitPartial`：取消时将已生成的部分一并提交进历史（默认 false —— 取消通常意味着
   * 本轮不计入，docs/14 A24）。开启时只对 `cancelled` 生效：`failed` 提交部分产出会把模型尚未
   * 说完的内容变成历史事实，下一轮还需在其基础上继续生成。
   *
   * 提交走正常的 `commitTurn` 路径，因此 rebase、裁剪、形状断言一项不少；提交失败时
   * 退回原有的释放认领逻辑，避免一次取消同时阻塞整轮的背景消息。
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
   *   （排查读出的窗口与库中不一致时会用到）。此前该上界写死为 64，配置项从未接线。
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
   * `/new` 与 WebUI 的清空上下文窗口操作：插入一条 reset commit 将窗口起点推进到最新 ordinal 之后。
   * 不删除任何消息 —— 这是刻意的（`docs/09 §3.10` 规定两者都不删消息），因此清空只限制窗口而不
   * 限制归档工具：实测清空后模型第一步即执行 `read_messages({direction:'before',limit:20})` 将 20 条
   * 历史整段取回，该工具结果又进入新窗口（logs/2026-08-19 · `01M0CKK6W018B5KS9613SNEX5J`）。
   *
   * 因此此处一并记录清空时刻的归档水位（`meta.archiveFloor`），由 `context.recallBarrier`
   * 决定是否真正拦截。水位无条件记录：开关是运行时的，而 commit 是不可变的历史 ——
   * 事后开启开关时，未记录过水位的旧 reset 无法补录。
   *
   * @param advanceClaims 隔断开启时为真：将背景认领水位也推进到同一位置。否则清空后第一轮会把
   *   清空之前尚未认领的群消息重新带入新窗口（`claimBackground` 处理的是 `claim_watermark`
   *   到触发消息之间的区间，与窗口无关），形成一扇门关闭而另一扇门仍开的状态。
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
    // 没有 contexts 行表示该 key 尚未开启过任何一轮（`/new` 执行于从未被唤醒的会话）。
    // 此时既没有窗口也没有已认领的内容，水位记 0 即表示不设限。
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
   * 归档检索的下限（`context.recallBarrier`）。开关不在此处判定 —— 由调用方（`builtins.ts` 的三个
   * 归档工具）按本轮配置决定是否使用，从而使同一份水位在开关关闭时不影响任何查询。
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
   * @param options.timeline 是否附带该会话全部历史上下文消息及其 parts，加最近 100 个 commit。
   *   默认不附带 —— `context_stats` 工具此前获取的正是完整数据：随后 `#normalizeOutput` 按
   *   `tools.exec.maxOutputBytes`（64 KiB）从中间截断，模型看到的是被截断的 JSON，前 32 KiB
   *   是最早的历史、后 32 KiB 是 commit 列表，既消耗 token 又没有信息量（docs/27 · R-03）。
   *   WebUI 的 `GET /api/chats/:key/commits` 需要该时间线，因此显式传入 true。
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

  /** 配额预留应按本轮预计发送量估算，而不是按上限的固定比例（docs/17 · N-QUOTA-01）。 */
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
   * 反方向同样需要拦截：没有配对 tool-result 的 tool-call。
   *
   * `assertValidShape` 只检查孤儿 tool-result 这一个方向。反方向同样致命，只是晚一轮才暴露：
   * 畸形请求体使 provider 返回 0 步，AI SDK 于是用 `NoOutputGeneratedError` reject 结果 promise，
   * 而 parts 是持久化的 —— 该会话在 `/new` 之前每轮都会重现。实测
   * logs/2026-08-18 22:17 / 23:19 两次进程崩溃，根因是 `tool-error` 部件未被追加进 delta
   * （被 `step.toolResults` 过滤，见 `runtime.ts` 的 `stepToolResults`）。
   *
   * 只检查 `delta`，不检查 snapshot。已写入库的历史中可能本就带有这类孤儿（本次事故的那条仍在
   * 库中），用它拦截提交等于彻底锁死整个会话，后果更严重。读出侧的自愈在 `runtime.ts` 的
   * `contextMessages` 中 —— 写入侧只负责不再产生新的，与 `hydrateAttachment` 分工一致。
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
   * `deferrable`：本轮是否处于活跃期（由 `openTurn` 按距上一轮提交的间隔计算后快照进
   * `turn.deferPrune`）。活跃期内将触发阈值提升至 `context.active.*`，但裁剪目标恒为
   * `context.limit.*` —— 裁剪到上限意味着此后每一轮都需在上限上再裁一次，每次都作废整段前缀缓存，
   * 正是该特性要消除的问题（docs/02 §5.1.1 与红线 19）。推迟的方向始终是多保留，因此 turn 边界、
   * tool 配对、`minKeepTurns` 等形状不变式不会因它被破坏。
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
      // 提前返回置于 `repo.messages()` 之前：活跃期内绝大多数轮次走这条路径，无需为一个不会使用的
      // 判定物化整个窗口。上限取 max(active, limit)：将 active 配置得比 limit 更小属于无意义配置，
      // 但不应因此导致裁剪比不启用活跃期时更激进。
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
