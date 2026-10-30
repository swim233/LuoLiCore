import {
  TelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramUpdate,
} from '@chat-adapter/telegram';
import type { Logger as ChatLogger, WebhookOptions } from 'chat';
import type { Logger } from '../core/index.js';

/**
 * 按我们的需要调整的 Telegram 适配器（依赖 4.43.0 的内部实现，升级 SDK 前要重新核对这五处）：
 * - 不让 Chat SDK 再存一份线程历史：会话正本归核心（ADR-0003）。
 * - 不缓存收发过的消息：适配器默认把每条消息都留在内存里且每次重新排序，常驻进程会越积越多；
 *   我们不用 fetchMessages 等依赖缓存的接口。
 * - 私聊来消息时不自动发「正在输入」：白名单外的人也会看到；输入状态由前端在回复时自己发。
 * - 同一个聊天的更新按到达顺序逐条处理：一批更新默认并行派发，后到的消息可能先记录。
 * - 启动时先立即取回离线积压（不长轮询），积压处理完时兑现 caughtUp。
 */
export class LuoliTelegramAdapter extends TelegramAdapter {
  private readonly chains = new Map<string, Promise<void>>();
  // 离线积压是否已全部取回：一次拉取返回的更新少于 limit 条就说明取完了
  private backlogDrained = false;
  private markCaughtUp!: () => void;
  /** 启动后离线积压的更新都处理完时兑现；没有积压时，第一次拉取返回空之后兑现 */
  readonly caughtUp = new Promise<void>((resolve) => (this.markCaughtUp = resolve));

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
    if (this.backlogDrained) {
      // 轮询要等上一批都处理完才拉下一批：积压的最后一批这时已经处理完
      this.markCaughtUp();
      return super.telegramFetch<TResult>(method, payload, request);
    }
    // 还在取积压：不等新消息，立即返回
    const updates = await super.telegramFetch<unknown[]>(
      method,
      { ...payload, timeout: 0 },
      request,
    );
    if (updates.length < Number(payload?.limit ?? 100)) this.backlogDrained = true;
    return updates as TResult;
  }

  protected override cacheMessage(): void {}

  protected override startTypingForPrivateMessage(): void {}

  protected override processUpdate(
    update: TelegramUpdate,
    options?: WebhookOptions,
  ): Promise<void>[] | void {
    const message = update.message ?? update.edited_message;
    // 相册由适配器自己攒齐再派发，依赖并行处理，不排队（第 7 步处理相册）
    if (!message || message.media_group_id) return super.processUpdate(update, options);
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
