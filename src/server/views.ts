import {
  imageSize,
  isStoredToolContent,
  mediaTypeOf,
  type ConversationOverview,
  type ConversationStore,
  type FileStore,
  type Message,
  type Storage,
  type StoredImage,
  type StoredMessage,
  type StoredToolContent,
} from '../core/index.js';
import { serverTimeZone, startOfDay } from './today.js';
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
}: {
  storage: Storage;
  fileStore: FileStore;
  webState: WebState;
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
      title: overview.title,
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

  async function apiMessage(entry: StoredMessage): Promise<ApiMessage> {
    // 消息是核心写的，形状本来就对；这里仍不完全信它，一条坏消息不拖垮整批
    const stored: Record<string, unknown> = isRecord(entry.message) ? entry.message : {};
    const parts: unknown[] = Array.isArray(stored.parts) ? stored.parts : [];
    const { parts: trimmed, tools } = trimTools(parts);
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
      return { messages: await Promise.all(page.entries.map(apiMessage)), hasMore: page.hasMore };
    },

    /** 一条消息；会话或消息不存在时为 undefined */
    async message(conversationId: string, messageId: string): Promise<ApiMessage | undefined> {
      const entry = await (await open(conversationId))?.entry(messageId);
      return entry && apiMessage(entry);
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
          title,
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

/** 工具结果的文字太长时截短；记下每个结果原来的长度。不是对象的段、形状不对的字段原样放过 */
function trimTools(parts: readonly unknown[]): {
  parts: unknown[];
  tools: Record<string, ToolResultInfo>;
} {
  const tools: Record<string, ToolResultInfo> = {};
  const trimmed = parts.map((part) => {
    if (!isRecord(part) || !isToolPart(part)) return part;
    const id = String(part.toolCallId);
    if (part.state === 'output-error') {
      // 缺错误说明时按空算
      const errorText = typeof part.errorText === 'string' ? part.errorText : '';
      tools[id] = { chars: errorText.length, truncated: errorText.length > toolOutputChars };
      return errorText.length > toolOutputChars
        ? { ...part, errorText: cut(errorText, toolOutputChars) }
        : part;
    }
    if (part.state !== 'output-available') return part;
    const output = part.output;
    if (isStoredToolContent(output)) {
      const text = contentText(output);
      tools[id] = { chars: text.length, truncated: text.length > toolOutputChars };
      if (text.length <= toolOutputChars) return part;
      const shortened: StoredToolContent = {
        type: 'luoli-content',
        parts: [{ type: 'text', text: cut(text, toolOutputChars) }, ...contentImages(output)],
      };
      return { ...part, output: shortened };
    }
    const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null');
    tools[id] = { chars: text.length, truncated: text.length > toolOutputChars };
    return text.length > toolOutputChars ? { ...part, output: cut(text, toolOutputChars) } : part;
  });
  return { parts: trimmed, tools };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 工具调用段：type 为 tool-<工具名>，或 dynamic-tool（与 ai 的 isToolUIPart 相同，但不怕缺字段） */
function isToolPart(part: Record<string, unknown>): boolean {
  return (
    typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
  );
}

/** 带图片的工具结果的文字（同 core 的 toolContentText），不是对象、没有文字的段跳过 */
function contentText(output: unknown): string {
  if (!isStoredToolContent(output)) return '';
  return (output.parts as unknown[])
    .flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

/** 带图片的工具结果里的图片（同 core 的 toolContentImages），没有地址的跳过 */
function contentImages(output: unknown): StoredImage[] {
  if (!isStoredToolContent(output)) return [];
  return (output.parts as unknown[]).filter(
    (part): part is StoredImage =>
      isRecord(part) && part.type === 'image' && typeof part.url === 'string',
  );
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
