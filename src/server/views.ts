import {
  imageSize,
  isStoredToolContent,
  mediaTypeOf,
  type ConversationOverview,
  type ConversationStore,
  type FileStore,
  type Message,
  type Storage,
  type StoredMessage,
  type StoredToolContent,
  type ToolCall,
} from '../core/index.js';
import { contentImages, contentText, isRecord, isToolPart, toolNameOf } from './parts.js';
import { serverTimeZone, startOfDay } from './today.js';
import { noSummaries, type Summarize } from './tool-summary.js';
import type {
  ApiMessage,
  ApiSegment,
  ConversationKind,
  ConversationResponse,
  ConversationRow,
  ImageInfo,
  MessagePreview,
  MessagesResponse,
  TodaySummary,
  ToolResultInfo,
} from './types.js';
import type { WebState } from './web-state.js';

/** 一次最多取多少条消息；默认取多少条 */
export const maxMessages = 1000;
export const defaultMessages = 200;
/** 接口里工具结果的文字最多多少个字符 */
export const toolOutputChars = 2000;
/** 预览最多多少个字符 */
const previewChars = 80;

export const fileScheme = 'luoli-file:';

export type Views = ReturnType<typeof createViews>;

/**
 * 把核心的读取结果变成接口的样子（类型见 types.ts）：会话列表的行、消息、今日概况、文件。
 * 接口和 SSE 事件都用它，同一种数据只有一种样子
 */
export function createViews({
  storage,
  fileStore,
  webState,
  timeZone = serverTimeZone(),
  now = () => new Date(),
  summarize = noSummaries,
}: {
  storage: Storage;
  fileStore: FileStore;
  webState: WebState;
  /** 工具调用给界面看的一句话（见 tool-summary.ts）；不给时都没有 */
  summarize?: Summarize;
  /** 「今天」按这个时区算，默认服务器的时区 */
  timeZone?: string;
  /** 测试里换掉 */
  now?: () => Date;
}) {
  // 图片按内容存，同一个地址的内容不会变：宽高读过一次就记下
  const imageInfos = new Map<string, ImageInfo>();

  /** 打开会话；不存在时为 undefined（核心只在会话不存在时抛错） */
  async function open(conversationId: string): Promise<ConversationStore | undefined> {
    try {
      return await storage.openConversation(conversationId);
    } catch {
      return undefined;
    }
  }

  async function row(overview: ConversationOverview): Promise<ConversationRow> {
    const kind = kindOf(overview.platform, overview.platformConversationId);
    const readSeq = webState.readSeq(overview.id);
    const last = overview.last;
    // 未读只算 Telegram 里别人（用户）发的；最后一条都没超过已读位置时不用数
    const unread =
      (kind === 'group' || kind === 'private') && last !== undefined && last.seq > readSeq
        ? await (
            await storage.openConversation(overview.id)
          ).count({ after: readSeq, role: 'user' })
        : 0;
    return {
      id: overview.id,
      platform: overview.platform,
      kind,
      // 网页会话的标题只在 web.db 里（只给面板显示，不进 prompt）
      title:
        (overview.platform === 'web' ? webState.title(overview.id) : undefined) ?? overview.title,
      platformConversationId: overview.platformConversationId,
      createdAt: overview.createdAt,
      lastAt: last?.createdAt ?? overview.createdAt,
      ...(last === undefined ? {} : { last: preview(last) }),
      messages: overview.messages,
      segments: overview.segments,
      unread,
      readSeq,
    };
  }

  /** 消息里的图片：地址 → 信息；文件不在了为 null */
  async function images(parts: readonly unknown[]): Promise<ApiMessage['images']> {
    const known = new Map<string, { width?: unknown; height?: unknown } | undefined>();
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (part.type === 'file' && typeof part.url === 'string' && part.url.startsWith(fileScheme)) {
        known.set(part.url, undefined);
      }
      if (isToolPart(part) && part.state === 'output-available') {
        for (const image of contentImages(part.output)) {
          known.set(image.url, { width: image.width, height: image.height });
        }
      }
    }
    const entries = await Promise.all(
      [...known].map(async ([url, size]) => [url, await imageInfo(url, size)] as const),
    );
    return Object.fromEntries(entries);
  }

  async function imageInfo(
    url: string,
    size: { width?: unknown; height?: unknown } | undefined,
  ): Promise<ImageInfo | null> {
    const cached = imageInfos.get(url);
    if (cached) return cached;
    let info: ImageInfo;
    if (size) {
      // 工具结果里的图片：宽高存在消息里，只看文件还在不在
      if (!(await fileStore.has(url))) return null;
      info = { src: fileSrc(url), ...definedSize(size) };
    } else {
      const data = await fileStore.read(url);
      if (!data) return null;
      info = { src: fileSrc(url), ...definedSize(imageSize(data) ?? {}) };
    }
    imageInfos.set(url, info);
    return info;
  }

  async function apiMessage(entry: StoredMessage, calls: readonly ToolCall[]): Promise<ApiMessage> {
    // 消息是核心写的，形状本来就对；这里仍不完全信它，一条坏消息不拖垮整批
    const stored: Record<string, unknown> = isRecord(entry.message) ? entry.message : {};
    const parts: unknown[] = Array.isArray(stored.parts) ? stored.parts : [];
    const durations =
      stored.role === 'assistant' && typeof stored.id === 'string'
        ? toolDurations(
            parts,
            calls.filter((call) => call.replyId === stored.id),
          )
        : new Map<string, number>();
    const { parts: trimmed, tools } = trimTools(parts, { summarize, durations });
    return {
      seq: entry.seq,
      id: typeof stored.id === 'string' ? stored.id : '',
      role: stored.role === 'assistant' ? 'assistant' : 'user',
      createdAt: entry.createdAt,
      message: { ...stored, parts: trimmed } as Message,
      tools,
      images: await images(parts),
    };
  }

  return {
    /** 全部会话，按最后一条消息的时间倒序（没有消息的按建立时间） */
    async conversations(): Promise<ConversationRow[]> {
      const rows = await Promise.all((await storage.overviews()).map(row));
      return rows.sort((a, b) => (a.lastAt === b.lastAt ? 0 : a.lastAt < b.lastAt ? 1 : -1));
    },

    /** 列表里的一行；会话不存在时为 undefined */
    async row(conversationId: string): Promise<ConversationRow | undefined> {
      const overview = await storage.overview(conversationId);
      return overview && row(overview);
    },

    /** 一行加全部段；会话不存在时为 undefined */
    async conversation(conversationId: string): Promise<ConversationResponse | undefined> {
      const overview = await storage.overview(conversationId);
      if (!overview) return undefined;
      const store = await storage.openConversation(conversationId);
      return {
        conversation: await row(overview),
        segments: (await store.segments()).map((segment): ApiSegment => ({
          startSeq: segment.startSeq,
          startReason: segment.startReason,
          conversationTitle: segment.conversationTitle,
          priorSummary: segment.priorSummary,
          createdAt: segment.createdAt,
        })),
      };
    },

    /** 序号在 before 之前的最后 limit 条；会话不存在时为 undefined */
    async messages(
      conversationId: string,
      { before, limit = defaultMessages }: { before?: number; limit?: number } = {},
    ): Promise<MessagesResponse | undefined> {
      const store = await open(conversationId);
      if (!store) return undefined;
      const page = await store.page({ before, limit });
      const calls = await toolCallsFor(store, page.entries);
      return {
        messages: await Promise.all(page.entries.map((entry) => apiMessage(entry, calls))),
        hasMore: page.hasMore,
      };
    },

    /** 一条消息；会话或消息不存在时为 undefined */
    async message(conversationId: string, messageId: string): Promise<ApiMessage | undefined> {
      const store = await open(conversationId);
      const entry = await store?.entry(messageId);
      return entry && apiMessage(entry, await toolCallsFor(store!, [entry]));
    },

    /**
     * 已读位置往前推到 seq（比最后一条大时按最后一条算），返回更新后的那一行；
     * 会话不存在时为 undefined
     */
    async markRead(conversationId: string, seq: number): Promise<ConversationRow | undefined> {
      const overview = await storage.overview(conversationId);
      if (!overview) return undefined;
      webState.advanceRead(conversationId, Math.min(seq, overview.last?.seq ?? 0));
      return row(overview);
    },

    /** 今天（服务器时区）0 点以来的模型调用汇总 */
    async today(): Promise<TodaySummary> {
      const { date, since } = startOfDay(now(), timeZone);
      const summary = await storage.callSummary(since.toISOString());
      return {
        date,
        timeZone,
        since: since.toISOString(),
        replies: summary.replies,
        failedReplies: summary.failedReplies,
        inputTokens: summary.inputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        outputTokens: summary.outputTokens,
        conversations: summary.repliesByConversation.map(({ conversationId, title, replies }) => ({
          id: conversationId,
          // 网页会话没有核心的标题，用 web.db 里的
          title: title ?? webState.title(conversationId),
          replies,
        })),
      };
    },

    /** 文件存储里的图片；名字不对、文件不在时为 undefined */
    async file(name: string): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
      const url = fileScheme + name;
      const mediaType = mediaTypeOf(url);
      if (!mediaType) return undefined;
      const data = await fileStore.read(url);
      return data && { data, mediaType };
    },
  };
}

/** 种类：Telegram 的群的 chat id 是负数，私聊的是对方的用户 id（正数） */
export function kindOf(
  platform: string,
  platformConversationId: string | undefined,
): ConversationKind {
  if (platform === 'telegram') return platformConversationId?.startsWith('-') ? 'group' : 'private';
  if (platform === 'cli') return 'cli';
  if (platform === 'web') return 'web';
  return 'other';
}

function preview(last: NonNullable<ConversationOverview['last']>): MessagePreview {
  const text = cut(last.text.replace(/\s+/g, ' ').trim(), previewChars);
  return {
    seq: last.seq,
    createdAt: last.createdAt,
    role: last.role === 'assistant' ? 'assistant' : 'user',
    ...(last.role === 'user' && last.author ? { author: last.author.name } : {}),
    text: text === '' && last.files > 0 ? '[图片]' : text,
  };
}

/**
 * 工具结果的文字太长时截短；记下每个结果原来的长度、给界面看的一句话（用截短之前的结果）、
 * 耗时（durations，按调用 id）。不是对象的段、形状不对的字段原样放过
 */
function trimTools(
  parts: readonly unknown[],
  { summarize, durations }: { summarize: Summarize; durations: ReadonlyMap<string, number> },
): {
  parts: unknown[];
  tools: Record<string, ToolResultInfo>;
} {
  const tools: Record<string, ToolResultInfo> = {};
  const trimmed = parts.map((part) => {
    if (!isRecord(part) || !isToolPart(part)) return part;
    const id = String(part.toolCallId);
    const name = toolNameOf(part);
    const extra = (output?: unknown) => {
      const summary = summarize(name, part.input, output);
      const durationMs = durations.get(id);
      return {
        ...(summary !== undefined ? { summary } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    };
    if (part.state === 'output-error') {
      // 缺错误说明时按空算
      const errorText = typeof part.errorText === 'string' ? part.errorText : '';
      tools[id] = {
        chars: errorText.length,
        truncated: errorText.length > toolOutputChars,
        ...extra(),
      };
      return errorText.length > toolOutputChars
        ? { ...part, errorText: cut(errorText, toolOutputChars) }
        : part;
    }
    if (part.state !== 'output-available') return part;
    const output = part.output;
    if (isStoredToolContent(output)) {
      const text = contentText(output);
      tools[id] = {
        chars: text.length,
        truncated: text.length > toolOutputChars,
        ...extra(output),
      };
      if (text.length <= toolOutputChars) return part;
      const shortened: StoredToolContent = {
        type: 'luoli-content',
        parts: [{ type: 'text', text: cut(text, toolOutputChars) }, ...contentImages(output)],
      };
      return { ...part, output: shortened };
    }
    const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null');
    tools[id] = { chars: text.length, truncated: text.length > toolOutputChars, ...extra(output) };
    return text.length > toolOutputChars ? { ...part, output: cut(text, toolOutputChars) } : part;
  });
  return { parts: trimmed, tools };
}

/**
 * 一条助手消息里每个工具调用的耗时（调用 id → 毫秒），从工具调用表对出来。calls 是这条回复的行。
 * - 表里有调用 id 的行（表结构版本 4 起）按 id 对上；
 * - 以前写的行没有调用 id：按「第几步、工具名」分组，组里按开始时间的先后与消息里的先后一一对上，
 *   同一组里结果不同（成功、出错）的先按结果对。同一毫秒开始、结果又相同的同名调用分不开，可能对反。
 * 对不上的（表里没有、行数不够）不给
 */
export function toolDurations(
  parts: readonly unknown[],
  calls: readonly ToolCall[],
): Map<string, number> {
  const durations = new Map<string, number>();
  if (calls.length === 0) return durations;
  const byId = new Map<string, ToolCall>();
  const groups = new Map<string, ToolCall[]>();
  const unnamed = calls
    .filter((call) => {
      if (call.toolCallId === undefined) return true;
      byId.set(call.toolCallId, call);
      return false;
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  for (const call of unnamed) {
    const key = `${call.step}\u0000${call.tool}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  let step = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === 'step-start') {
      step++;
      continue;
    }
    if (!isToolPart(part)) continue;
    const id = String(part.toolCallId);
    const named = byId.get(id);
    if (named) {
      durations.set(id, named.durationMs);
      continue;
    }
    const group = groups.get(`${Math.max(step, 1)}\u0000${toolNameOf(part)}`);
    if (!group || group.length === 0) continue;
    const ok = part.state === 'output-available';
    const index = group.findIndex((call) => (call.outcome === 'completed') === ok);
    const [call] = group.splice(index === -1 ? 0 : index, 1);
    durations.set(id, call!.durationMs);
  }
  return durations;
}

/** 这些消息里助手回复的工具调用表的行；没有工具调用时不读表 */
async function toolCallsFor(
  store: ConversationStore,
  entries: readonly StoredMessage[],
): Promise<ToolCall[]> {
  const hasTools = entries.some(
    ({ message }) =>
      isRecord(message) &&
      message.role === 'assistant' &&
      Array.isArray(message.parts) &&
      (message.parts as unknown[]).some((part) => isRecord(part) && isToolPart(part)),
  );
  return hasTools ? store.toolCalls() : [];
}

/** 开头 max 个字符（UTF-16 单位，与工具结果长度的口径相同）；不在代理对中间切开 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return text.slice(0, end);
}

/** luoli-file: 地址 → 取图片的路径 /api/files/<文件名> */
export function fileSrc(url: string): string {
  return `/api/files/${url.slice(fileScheme.length)}`;
}

function definedSize(size: { width?: unknown; height?: unknown }): {
  width?: number;
  height?: number;
} {
  return typeof size.width === 'number' && typeof size.height === 'number'
    ? { width: size.width, height: size.height }
    : {};
}
