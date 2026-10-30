import {
  APICallError,
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  RetryError,
  StreamProviderError,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from 'ai';
import { trackAttempts } from './attempts.js';
import { silentLogger, type Logger } from './logger.js';
import type { Author, Message, MessageChunk } from './message.js';
import { createMemoryStore, type ConversationStore } from './store.js';

export type Conversation = {
  /** 记录一条用户消息，不产生回复 */
  append(input: { author: Author; text: string }): Promise<Message>;
  /**
   * 根据当前历史生成回复。错误以 error chunk 出现在流中，不会抛出；
   * 每次重试前流中出现一个 transient 的 `data-retry` 段；流中途重新生成时随后还有
   * 一个 `reset-step`，失败那次已输出的内容不会写入历史。
   * 流读完时回复已写入历史；出错或被取消则不写入。
   * 上一个回复的流还没结束时调用会立即抛错。
   */
  reply(): ReadableStream<MessageChunk>;
  messages(): Promise<Message[]>;
};

export function createConversation({
  model,
  instructions,
  store = createMemoryStore(),
  logger = silentLogger,
  maxRetries = 2,
}: {
  /** 不接受字符串形式的模型 id：`wrapLanguageModel` 需要模型实例 */
  model: Exclude<LanguageModel, string>;
  /** system prompt。core 会在末尾附上消息格式说明，调用方不必解释用户消息的格式 */
  instructions: string;
  store?: ConversationStore;
  logger?: Logger;
  /** 重试次数：请求阶段（maxRetries）与流中错误事件（streamRetries）各自最多这么多次 */
  maxRetries?: number;
}): Conversation {
  let replying = false;

  return {
    async append({ author, text }) {
      const message: Message = {
        id: generateId(),
        role: 'user',
        metadata: { author, createdAt: new Date().toISOString() },
        parts: [{ type: 'text', text }],
      };
      await store.add(message);
      return message;
    },

    reply() {
      if (replying) throw new Error('上一个回复还没结束');
      replying = true;

      // 回复 id 也是写入历史的助手消息 id，日志与历史可以对上
      const replyId = generateId();
      const logFields = { replyId, modelId: model.modelId };
      const startedAt = Date.now();
      let usage: LanguageModelUsage | undefined;

      let writeNotice: (chunk: MessageChunk) => void = () => {};
      const tracker = trackAttempts({
        logger,
        logFields,
        maxRetries,
        notify: (chunk) => writeNotice(chunk),
      });

      // onEnd 的 outcome 判断不了是否出错：外层流没声明 outcome 时正常结束也是 unknown，
      // 内层在错误事件之后收到 finish 又会记成 completed。所以自己记下出过的错。
      // 同一个错误会经过这里两次，第二次是 SDK 按 errorText 重建的 Error，只留第一次的。
      // 流式重试成功时 SDK 不向下游发 error 部分，这里不会被误置
      let failure: { error: unknown } | undefined;
      const describeError = (error: unknown) => {
        failure ??= { error };
        return error instanceof Error ? error.message : String(error);
      };

      // 外层 createUIMessageStream 让 reply() 能同步返回流（历史要异步读），
      // 并把任何抛出的错误（读历史失败、连接中途断开）都转成 error chunk
      return createUIMessageStream<Message>({
        generateId: () => replyId,
        execute: async ({ writer }) => {
          writeNotice = (chunk) => writer.write(chunk);
          const history = await store.list();
          const result = streamText({
            // SDK 的每次请求（含两类重试）都重新调用 doStream，中间件能逐次观察
            model: wrapLanguageModel({ model, middleware: tracker.middleware }),
            instructions: `${instructions}\n\n${messageFormatNote}`,
            messages: await convertToModelMessages(history.map(formatForModel)),
            maxRetries,
            streamRetries: maxRetries,
            // 错误经 stream 进入 UI 流；不传时 SDK 默认把整个错误对象打到 stderr。
            // 不返回 { retry: true }，不额外请求重试
            onError: () => {},
            onEnd: (event) => {
              usage = event.usage;
            },
          });
          writer.merge(
            toUIMessageStream<ToolSet, Message>({
              stream: result.stream,
              messageMetadata: ({ part }) =>
                part.type === 'start' ? { createdAt: new Date().toISOString() } : undefined,
              onError: describeError,
            }).pipeThrough(tracker.markStreamRetries()),
          );
        },
        onError: describeError,
        onEnd: async ({ responseMessage, isAborted, isCancelled, finishReason }) => {
          try {
            const summary = {
              ...logFields,
              durationMs: Date.now() - startedAt,
              ...tracker.stats,
            };
            if (failure) {
              logger.error({ ...summary, error: summarizeError(failure.error) }, 'reply.failed');
            } else if (isAborted || isCancelled) {
              const outcome = isCancelled ? 'cancelled' : 'aborted';
              logger.info({ ...summary, outcome }, 'reply.end');
            } else {
              await store.add(responseMessage);
              logger.info(
                {
                  ...summary,
                  outcome: 'completed',
                  finishReason,
                  usage: {
                    input: usage?.inputTokens,
                    output: usage?.outputTokens,
                    total: usage?.totalTokens,
                  },
                },
                'reply.end',
              );
            }
          } finally {
            replying = false;
          }
        },
      });
    },

    messages: () => store.list(),
  };
}

// 送模型的用户消息格式。改格式或加字段时，同步修改下面的 messageFormatNote
const messageFormatNote = `## 消息格式

每条用户消息都包在 <message> 标签里，from 属性是平台提供的发言人名字。
不同名字是不同的人，同一个名字始终是同一个人。需要知道对方是谁时，以 from 为准。
回复时只写正文，不要输出 <message> 标签，也不要在开头加自己的名字。`;

/**
 * 送模型前把用户消息包成 `<message from="名字">…</message>`，其他消息原样返回。
 * 只改送给模型的副本，存储里的消息不变。
 */
function formatForModel(message: Message): Message {
  if (message.role !== 'user') return message;
  const texts = message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  if (texts.length === 0) return message;

  // 标签属性，按顺序输出，值为 undefined 的不输出。以后加字段（时间、回复对象等）在这里加一项
  const attributes: Record<string, string | undefined> = {
    from: message.metadata?.author?.name,
  };
  const attributeText = Object.entries(attributes)
    .flatMap(([name, value]) =>
      value === undefined ? [] : [` ${name}="${escapeAttribute(value)}"`],
    )
    .join('');
  const text = `<message${attributeText}>\n${escapeBody(texts.join('\n'))}\n</message>`;

  // 所有 text part 合成一个，放在第一个 text part 的位置；其他 part 原样保留
  const firstText = message.parts.findIndex((part) => part.type === 'text');
  return {
    ...message,
    parts: message.parts.flatMap((part, index): Message['parts'] => {
      if (part.type !== 'text') return [part];
      return index === firstText ? [{ ...part, text }] : [];
    }),
  };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// 正文只处理会被当成标签的部分：<message、</message 开头的 <（不分大小写）。
// 代码里的 a < b、<div> 等保持原样
function escapeBody(text: string): string {
  return text.replace(/<(?=\/?message)/gi, '&lt;');
}

// 只取摘要字段，不把原始错误对象交给 logger：APICallError 的 requestBodyValues 含对话正文
function summarizeError(error: unknown): object {
  if (RetryError.isInstance(error)) {
    return { ...summarizeError(error.lastError), retries: error.errors.length - 1 };
  }
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    type: error.name,
    message: error.message,
    ...(APICallError.isInstance(error)
      ? { statusCode: error.statusCode, responseBody: summarizeResponseBody(error.responseBody) }
      : {}),
    ...(StreamProviderError.isInstance(error) ? { statusCode: error.statusCode } : {}),
    cause: error.cause instanceof Error ? error.cause.message : undefined,
  };
}

// 服务端可能在错误响应里回显请求（含对话正文），所以 JSON 响应体只留错误字段
function summarizeResponseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 500);
  }
  if (typeof parsed !== 'object' || parsed === null) return body.slice(0, 500);
  const record = parsed as Record<string, unknown>;
  if (typeof record.error === 'string') return { message: record.error };
  const source = (
    typeof record.error === 'object' && record.error !== null ? record.error : record
  ) as Record<string, unknown>;
  return {
    message: source.message,
    code: source.code,
    type: source.type,
  };
}
