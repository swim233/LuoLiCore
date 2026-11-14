import {
  TelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramUpdate,
} from '@chat-adapter/telegram';
import type { Logger as ChatLogger, WebhookOptions } from 'chat';
import type { Logger } from '../core/index.js';
import type { TelegramRaw } from './message.js';
import { RichMessageError, type InputRichMessage } from './rich.js';

/**
 * 按我们的需要调整的 Telegram 适配器（依赖 4.43.0 的内部实现，升级 SDK 前要重新核对这几处）：
 * - 不让 Chat SDK 再存一份线程历史：会话正本归核心（ADR-0003）。
 * - 不缓存收发过的消息：适配器默认把每条消息都留在内存里且每次重新排序，常驻进程会越积越多；
 *   我们不用 fetchMessages 等依赖缓存的接口。
 * - 私聊来消息时不自动发「正在输入」：白名单外的人也会看到；输入状态由前端在回复时自己发。
 * - 同一个聊天的更新按到达顺序逐条处理：一批更新默认并行派发，后到的消息可能先记录。
 * - 启动时先立即取回离线积压（不长轮询），积压处理完时兑现 caughtUp。积压里的相册要等
 *   适配器攒齐、派发完才算处理完。
 * - 相册：适配器攒齐后只派发一条（原始数据只有最后一条），各条原始消息另记一份，由 takeAlbum 取回。
 *   相册某一条的编辑不再攒，立即按单条派发。
 * - 下载文件：公开基类的 downloadFile。
 * - 登记指令菜单：setCommands（setMyCommands）。
 * - 发富文本消息（postRichMessage）：直接用 telegramFetch 调 sendRichMessage，不经过 postMessage
 *   （它只在消息是 Markdown 时自己试富文本，传字符串时发普通消息）；聊天、话题、引用的参数用基类的
 *   resolveThreadId、buildChatTargetParams、buildReplyParameters 拼。失败按基类换成的错误类的名字
 *   （ResourceNotFoundError、ValidationError、PermissionError）分出不认识接口、拒收两种，
 *   依赖 4.43.0 的 telegramFetch、这几个方法和这些名字，升级前要核对。
 * - 连接状态：记下最近一次拉取更新是否成功（connected）与成功的时间，变了时调 onConnectionChange，
 *   洛璃服务据此报告「离线」。断开期间的拉取不长轮询（timeout 0），恢复后第一次拉取就立即返回、
 *   变回连上；之后照旧长轮询。否则恢复后要等一次长轮询返回（默认 30 秒）才知道连上了。
 */
export class LuoliTelegramAdapter extends TelegramAdapter {
  private readonly chains = new Map<string, Promise<void>>();
  // 相册的各条原始消息，按「chat id:media_group_id」
  private readonly albums = new Map<string, { raws: TelegramRaw[]; at: number }>();
  // 离线积压是否已全部取回：一次拉取返回的更新少于 limit 条就说明取完了
  private backlogDrained = false;
  // 积压里还没处理完的相册消息（update_id）：轮询要攒够一会儿才处理它们，晚于积压取完
  private readonly backlogAlbums = new Set<number>();
  private markCaughtUp!: () => void;
  /** 启动后离线积压的更新都处理完时兑现；没有积压时，第一次拉取返回空之后兑现 */
  readonly caughtUp = new Promise<void>((resolve) => (this.markCaughtUp = resolve));
  // 最近一次拉取更新是否成功，以及最近一次成功的时间
  private polled = false;
  private polledAt?: Date;

  /** connected 变了（连上、断开）时调用；抛错不影响轮询 */
  onConnectionChange?: (connected: boolean) => void;

  /**
   * 连得上 Telegram：最近一次拉取更新（getUpdates）成功。拉取失败（网络不通、token 失效等）时为 false，
   * 下一次成功时恢复；被中止的拉取（等相册攒齐、退出）不算。还没拉取过时为 false
   */
  get connected(): boolean {
    return this.polled;
  }

  /** 最近一次拉取更新成功的时间；还没成功过时没有 */
  get lastPolledAt(): Date | undefined {
    return this.polledAt;
  }

  private setPolled(polled: boolean): void {
    if (polled) this.polledAt = new Date();
    if (polled === this.polled) return;
    this.polled = polled;
    try {
      this.onConnectionChange?.(polled);
    } catch {
      // 通知出错不影响轮询
    }
  }

  constructor(config: TelegramAdapterConfig) {
    super(config);
    // 基类把它声明成字面量 true，只能在构造后改写
    (this as { persistThreadHistory: boolean }).persistThreadHistory = false;
  }

  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
    request?: { signal?: AbortSignal },
  ): Promise<TResult> {
    if (method !== 'getUpdates' || payload instanceof FormData) {
      return super.telegramFetch<TResult>(method, payload, request);
    }
    try {
      const updates = await this.fetchUpdates<TResult>(payload, request);
      this.setPolled(true);
      return updates;
    } catch (error) {
      if (!request?.signal?.aborted) this.setPolled(false);
      throw error;
    }
  }

  /** getUpdates：积压取完之前、断开期间都不长轮询 */
  private async fetchUpdates<TResult>(
    payload: Record<string, unknown> | undefined,
    request?: { signal?: AbortSignal },
  ): Promise<TResult> {
    if (this.backlogDrained) {
      // 轮询要等上一批都处理完才拉下一批：积压的最后一批这时已经处理完；相册要等它也派发完
      if (this.backlogAlbums.size === 0) this.markCaughtUp();
      // 断开期间（上一次拉取失败）：立即返回，成功了就算连上，下一次再长轮询
      const quick = !this.polled;
      return super.telegramFetch<TResult>(
        'getUpdates',
        quick ? { ...payload, timeout: 0 } : payload,
        request,
      );
    }
    // 还在取积压：不等新消息，立即返回
    const updates = await super.telegramFetch<TelegramUpdate[]>(
      'getUpdates',
      { ...payload, timeout: 0 },
      request,
    );
    for (const update of updates) {
      // 相册里某一条的编辑不打开会话，不用等
      if (update.message?.media_group_id) this.backlogAlbums.add(update.update_id);
    }
    if (updates.length < Number(payload?.limit ?? 100)) this.backlogDrained = true;
    return updates as TResult;
  }

  /**
   * 登记 bot 的指令菜单（Bot API 的 setMyCommands），不带范围和语言：默认范围，所有人看到同一份。
   * 会覆盖之前登记的（含在 BotFather 里设的）。出错时抛出（错误信息里没有 token）
   */
  async setCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
  ): Promise<void> {
    await this.telegramFetch<boolean>('setMyCommands', { commands });
  }

  /**
   * 发一条富文本消息（sendRichMessage）到 threadId 那个聊天（论坛群里连同话题）。replyTo 为被引用
   * 消息的 id，和 postMessage 一样带 allow_sending_without_reply：被引用的消息不在了照样发出，
   * 只是不带引用。服务端不认识这个接口、Telegram 拒收这一条时抛 RichMessageError，别的失败原样抛出
   */
  async postRichMessage(
    threadId: string,
    message: InputRichMessage,
    replyTo?: string,
  ): Promise<void> {
    // 拼参数时出的错（thread id 不对等）不是发送的失败，不归类
    const thread = this.resolveThreadId(threadId);
    const payload = {
      ...this.buildChatTargetParams(thread),
      rich_message: message,
      reply_parameters: this.buildReplyParameters(replyTo, thread.chatId),
    };
    try {
      await this.telegramFetch('sendRichMessage', payload);
    } catch (error) {
      const kind = richFailure(error);
      throw kind ? new RichMessageError(kind, error) : error;
    }
  }

  /** 按 file_id 下载文件（getFile 再取文件；地址含 token，出错时的消息里只有 file_id） */
  async download(fileId: string): Promise<Uint8Array> {
    return new Uint8Array(await this.downloadFile(fileId));
  }

  /**
   * 取走相册里已派发的各条原始消息，按消息 id 排序。raw 是适配器派发的那一条（攒齐的最后一条）；
   * id 比它大的是下一批，留着。没记过时只返回 raw
   */
  takeAlbum(raw: TelegramRaw): TelegramRaw[] {
    const key = albumKey(raw);
    const album = this.albums.get(key);
    const taken = album?.raws.filter((item) => item.message_id <= raw.message_id) ?? [];
    const rest = album?.raws.filter((item) => item.message_id > raw.message_id) ?? [];
    if (rest.length > 0) album!.raws = rest;
    else this.albums.delete(key);
    return taken.length > 0 ? taken.sort((a, b) => a.message_id - b.message_id) : [raw];
  }

  protected override cacheMessage(): void {}

  protected override startTypingForPrivateMessage(): void {}

  protected override processUpdate(
    update: TelegramUpdate,
    options?: WebhookOptions,
  ): Promise<void>[] | void {
    if (update.message?.media_group_id) {
      return this.processAlbumUpdate(update, update.message, options);
    }
    if (update.edited_message?.media_group_id) {
      // 编辑只改那一条，不用攒：去掉 media_group_id，按单条处理
      update = {
        ...update,
        edited_message: { ...update.edited_message, media_group_id: undefined },
      };
    }
    const message = update.message ?? update.edited_message;
    if (!message) return super.processUpdate(update, options);
    const chatId = String(message.chat.id);
    const run = (this.chains.get(chatId) ?? Promise.resolve()).then(async () => {
      await Promise.all(super.processUpdate(update, options) ?? []);
    });
    const tail = run.catch(() => {});
    this.chains.set(chatId, tail);
    void tail.then(() => {
      if (this.chains.get(chatId) === tail) this.chains.delete(chatId);
    });
    return [run];
  }

  /** 相册的一条：记下原始消息，交给适配器攒齐（依赖并行处理，不排队） */
  private processAlbumUpdate(
    update: TelegramUpdate,
    message: TelegramRaw,
    options?: WebhookOptions,
  ): Promise<void>[] | void {
    const now = Date.now();
    // 没派发出去的（如处理失败）不一直留着
    for (const [key, album] of this.albums) {
      if (now - album.at > albumTtlMs) this.albums.delete(key);
    }
    const key = albumKey(message);
    const album = this.albums.get(key) ?? { raws: [], at: now };
    album.raws = [...album.raws.filter((raw) => raw.message_id !== message.message_id), message];
    album.at = now;
    this.albums.set(key, album);

    const tasks = super.processUpdate(update, options) ?? [];
    if (this.backlogAlbums.has(update.update_id)) {
      void Promise.allSettled(tasks).then(() => this.backlogAlbums.delete(update.update_id));
    }
    return tasks;
  }
}

const albumTtlMs = 5 * 60_000;

/**
 * 发富文本消息失败属于哪一种。基类的 telegramFetch 把 Telegram 的错误换成 @chat-adapter/shared 的
 * 错误类（不是我们直接声明的依赖，按 name 认）：
 * - 404（ResourceNotFoundError），或者 400 系列（ValidationError，message 是 Telegram 的说明）的说明
 *   说的是找不到方法（见 methodNotFound）：服务端不认识这个接口，unsupported；
 * - 其余的 400 系列（ValidationError）和 403（PermissionError）：Telegram 拒收这一条，rejected；
 * - 别的（429 的 AdapterRateLimitError、401 的 AuthenticationError、5xx 与网络错误的 NetworkError）：
 *   undefined，由调用方原样抛出
 */
function richFailure(error: unknown): RichMessageError['kind'] | undefined {
  if (!(error instanceof Error)) return undefined;
  switch (error.name) {
    case 'ResourceNotFoundError':
      return 'unsupported';
    case 'ValidationError':
      return methodNotFound.test(error.message) ? 'unsupported' : 'rejected';
    case 'PermissionError':
      return 'rejected';
    default:
      return undefined;
  }
}

// 服务端说不认识这个方法：「method not found」「METHOD_NOT_FOUND」「method sendRichMessage not
// found」「unknown method」之类，只认出现在说明开头、或者紧跟在一个「Bad Request: 」「Not Found: 」
// 这样的前缀之后的；说明中间碰巧有的（如「Bad Request: payment method not found」）不算。
// 认不出只会被当成拒收（多一次请求、多一行日志），认错了这个 bot 以后就不再发富文本，所以宁可认得窄
const methodNotFound =
  /^(?:[\w ]+:\s*)?(?:method(?:\s+\w+)?[\s_]+not[\s_]+found|unknown[\s_]+method)\b/i;

function albumKey(raw: TelegramRaw): string {
  return `${raw.chat.id}:${raw.media_group_id}`;
}

// SDK 的日志里可能带消息正文的字段，转写时去掉
const contentKeys = new Set(['text', 'messageText', 'content', 'body', 'raw', 'message']);

/**
 * 把 Chat SDK 与适配器的日志转进我们的日志（`chat.info` 等）。debug 级别带消息正文，丢弃；
 * 其余只留第一个参数里的简单字段，错误只留类型与消息
 */
export function sdkLogger(logger: Logger, prefix = 'chat'): ChatLogger {
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, ...args: unknown[]) => {
      logger[level]({ sdk: prefix, detail: message, ...fieldsOf(args[0]) }, `chat.${level}`);
    };
  return {
    child: (name) => sdkLogger(logger, `${prefix}:${name}`),
    debug: () => {},
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

function fieldsOf(arg: unknown): Record<string, unknown> {
  if (arg instanceof Error) return { error: `${arg.name}: ${arg.message}` };
  if (typeof arg !== 'object' || arg === null) return arg === undefined ? {} : { arg: String(arg) };
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(arg)) {
    if (contentKeys.has(key)) continue;
    if (value instanceof Error) fields[key] = `${value.name}: ${value.message}`;
    else if (['string', 'number', 'boolean'].includes(typeof value)) fields[key] = value;
  }
  return fields;
}
