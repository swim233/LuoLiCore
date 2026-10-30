import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { trackAttempts } from './attempts.js';
import { summarizeError } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import { toUsage } from './model.js';
import type { Author, Message, MessageChunk } from './message.js';
import { formatForModel, systemPrompt } from './prompt.js';
import { createSegmenter, type SegmentOptions, type Summarize } from './segments.js';
import { createMemoryStore } from './storage/memory.js';
import type { ConversationStore, Segment } from './storage/types.js';

export type Conversation = {
  /** 记录一条用户消息，不产生回复。写入前发现会话已空闲太久时，在后台切段，这条消息归入新段 */
  append(input: { author: Author; text: string }): Promise<Message>;
  /**
   * 根据当前历史生成回复。错误以 error chunk 出现在流中，不会抛出；
   * 每次重试前流中出现一个 transient 的 `data-retry` 段；流中途重新生成时随后还有
   * 一个 `reset-step`，失败那次已输出的内容不会写入历史。
   * 流读完时回复已写入历史；出错或被取消则不写入。
   * 后台正在空闲切段时，等它结束再读当前段；压缩进行中不等，照常用当前段。
   * 正常完成且输入超过压缩阈值时，在后台压缩。
   * 上一个回复的流还没结束时调用会立即抛错。
   */
  reply(options?: ReplyOptions): ReadableStream<MessageChunk>;
  messages(): Promise<Message[]>;
  /** 停止后台的空闲检查，中止进行中的摘要并等它结束。之后不再使用这个会话 */
  close(): Promise<void>;
};

export type ReplyOptions = {
  /** 中止当前回复。调用时已中止的信号照常走中止路径 */
  abortSignal?: AbortSignal;
};

export function createConversation({
  model,
  instructions,
  store = createMemoryStore(),
  logger = silentLogger,
  maxRetries = 2,
  conversationId,
  timeouts = {},
  segments = {},
}: {
  /** 不接受字符串形式的模型 id：`wrapLanguageModel` 需要模型实例 */
  model: Exclude<LanguageModel, string>;
  /** system prompt。core 会在末尾附上消息格式说明，调用方不必解释用户消息的格式 */
  instructions: string;
  store?: ConversationStore;
  logger?: Logger;
  /** 重试次数：请求阶段（maxRetries）与流中错误事件（streamRetries）各自最多这么多次 */
  maxRetries?: number;
  /** 存储里的会话 id，只写进日志，便于多会话排查 */
  conversationId?: string;
  /** 超时（毫秒）：等第一段输出、两段输出之间。超时按失败处理 */
  timeouts?: { firstChunkMs?: number; chunkMs?: number };
  /** 分段：空闲切段、压缩与摘要（ADR-0004） */
  segments?: SegmentOptions;
}): Conversation {
  const { firstChunkMs = 60_000, chunkMs = 30_000 } = timeouts;
  let replying = false;

  /**
   * 一次模型调用（回复或摘要），重试与超时相同。tracker 先建好，调用方随时能读它的统计；
   * stream() 才真正发出请求
   */
  function modelCall({
    abortSignal,
    logFields,
    notify,
  }: {
    /** 调用方的中止信号；请求被中止而它没有中止时，就是超时 */
    abortSignal?: AbortSignal;
    logFields: object;
    notify: (chunk: MessageChunk) => void;
  }) {
    // 超时由这个控制器中止 streamText；与调用方的中止分开，结束时据此区分
    const timeoutController = new AbortController();
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutController.signal])
      : timeoutController.signal;
    const tracker = trackAttempts({
      logger,
      logFields,
      maxRetries,
      abortSignal,
      firstChunkMs,
      onFirstChunkTimeout: () => timeoutController.abort(),
      notify,
    });
    return {
      tracker,
      stream: (segment: Segment, messages: ModelMessage[]) =>
        streamText({
          // SDK 的每次请求（含两类重试）都重新调用 doStream，中间件能逐次观察
          model: wrapLanguageModel({ model, middleware: tracker.middleware }),
          instructions: systemPrompt(instructions, segment),
          messages,
          maxRetries,
          streamRetries: maxRetries,
          timeout: { firstChunkMs, chunkMs },
          abortSignal: signal,
          // 错误经 stream 交给调用方；不传时 SDK 默认把整个错误对象打到 stderr。
          // 不返回 { retry: true }，不额外请求重试
          onError: () => {},
        }),
    };
  }

  // 摘要请求沿用这一段的前缀：与回复相同的 system 与消息，末尾追加一条不包标签的指令
  const summarize: Summarize = async ({ reason, segment, history, instruction, abortSignal }) => {
    const call = modelCall({
      abortSignal,
      logFields: { conversationId, modelId: model.modelId, purpose: 'summary', reason },
      notify: () => {},
    });
    const result = call.stream(segment, [
      ...(await convertToModelMessages(history.map(formatForModel))),
      { role: 'user', content: instruction },
    ]);
    // 流式重试时 result.text 只含成功那次的文本；出错、超时、中止都以流中的段告知
    let failure: { error: unknown } | undefined;
    for await (const part of result.stream) {
      if (part.type === 'error') failure ??= { error: part.error };
      if (part.type === 'abort') {
        failure ??= {
          error: abortSignal.aborted
            ? new DOMException('摘要被中止', 'AbortError')
            : new DOMException('等待模型输出超时', 'TimeoutError'),
        };
      }
    }
    if (failure) throw failure.error;
    return {
      text: await result.text,
      usage: toUsage(await result.totalUsage),
      stats: call.tracker.stats,
    };
  };

  const segmenter = createSegmenter({
    store,
    logger,
    logFields: { conversationId, modelId: model.modelId },
    options: segments,
    summarize,
    isReplying: () => replying,
  });

  return {
    async append({ author, text }) {
      const message: Message = {
        id: generateId(),
        role: 'user',
        metadata: { author, createdAt: new Date().toISOString() },
        parts: [{ type: 'text', text }],
      };
      // 写入前看是否已经空闲太久：定时器没赶上、或上次空闲切段失败时，在这里补做，
      // 这条消息归入新段
      await segmenter.checkIdle();
      await store.add(message);
      segmenter.wrote();
      return message;
    },

    reply({ abortSignal }: ReplyOptions = {}) {
      if (replying) throw new Error('上一个回复还没结束');
      replying = true;

      // 回复 id 也是写入历史的助手消息 id，日志与历史可以对上
      const replyId = generateId();
      const logFields = { conversationId, replyId, modelId: model.modelId };
      // 回复在历史里的序号，开始时预留：生成期间记录进来的消息排在回复之后。
      // 回复失败或没有输出时不写入，这个序号空着
      let seq: number | undefined;
      // 这次回复所在的段，回复完成后据此决定是否压缩
      let segment: Segment | undefined;
      const startedAt = Date.now();

      let writeNotice: (chunk: MessageChunk) => void = () => {};
      const call = modelCall({ abortSignal, logFields, notify: (chunk) => writeNotice(chunk) });
      const { tracker } = call;

      // onEnd 的 outcome 判断不了是否出错：外层流没声明 outcome 时正常结束也是 unknown，
      // 内层在错误事件之后收到 finish 又会记成 completed。所以自己记下出过的错。
      // 同一个错误会经过这里两次，第二次是 SDK 按 errorText 重建的 Error，只留第一次的。
      // 流式重试成功时 SDK 不向下游发 error 部分，这里不会被误置
      let failure: { error: unknown } | undefined;
      const describeError = (error: unknown) => {
        failure ??= { error };
        return error instanceof Error ? error.message : String(error);
      };

      // SDK 超时（以及上面的首段计时）都以 abort 段结束回复流。用户没有中止却收到 abort，
      // 就是超时：换成 error 段，按失败处理（不写入，记 reply.failed）。
      // 是哪种超时看这次请求有没有输出过内容，不解析 SDK 的错误文字。
      // 流式重试的 reset-step 之后是新的请求，失败那次的半截不算
      const timeoutAsFailure = () => {
        let sawOutput = false;
        return new TransformStream<MessageChunk, MessageChunk>({
          transform(chunk, controller) {
            if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.delta) {
              sawOutput = true;
            }
            if (chunk.type === 'reset-step') sawOutput = false;
            if (chunk.type !== 'abort' || abortSignal?.aborted) {
              controller.enqueue(chunk);
              return;
            }
            const detail = sawOutput
              ? `两段输出之间超过 ${chunkMs / 1000} 秒`
              : `${firstChunkMs / 1000} 秒内没有收到第一段输出`;
            const error = new DOMException(`等待模型输出超时：${detail}`, 'TimeoutError');
            controller.enqueue({ type: 'error', errorText: describeError(error) });
          },
        });
      };

      // 外层 createUIMessageStream 让 reply() 能同步返回流（历史要异步读），
      // 并把任何抛出的错误（读历史失败、连接中途断开）都转成 error chunk
      return createUIMessageStream<Message>({
        generateId: () => replyId,
        execute: async ({ writer }) => {
          writeNotice = (chunk) => writer.write(chunk);
          // 正在空闲切段时先等它结束，读到的才是切段之后的当前段（压缩不等，见 settled）
          await segmenter.settled();
          segment = await store.currentSegment();
          seq = await store.reserve();
          // 只看当前段里预留号之前的消息：模型看到的正是排在回复之前的那些
          const history = await store.list({ from: segment.startSeq, before: seq });
          const result = call.stream(
            segment,
            await convertToModelMessages(history.map(formatForModel)),
          );
          let createdAt: string | undefined;
          writer.merge(
            toUIMessageStream<ToolSet, Message>({
              stream: result.stream,
              // start 段附上时间，finish 段附上用量（合并进回复的 metadata）。
              // 中止没有 finish 段；失败的回复不写入历史。finish 段也要带 createdAt（类型要求），值不变
              messageMetadata: ({ part }) => {
                if (part.type === 'start') {
                  createdAt = new Date().toISOString();
                  return { createdAt };
                }
                if (part.type === 'finish') {
                  createdAt ??= new Date().toISOString();
                  const usage = toUsage(part.totalUsage);
                  return usage ? { createdAt, usage } : { createdAt };
                }
                return undefined;
              },
              onError: describeError,
            })
              .pipeThrough(tracker.markStreamRetries())
              .pipeThrough(timeoutAsFailure()),
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
            } else if (isAborted) {
              // 半截回复写入历史并标记 aborted；一个字都没输出就被中止时不写入
              const saved = hasText(responseMessage);
              if (saved) {
                await store.add(
                  {
                    ...responseMessage,
                    // 中止时最后一段还停在 streaming 状态；写入历史的是定稿，改为 done
                    parts: responseMessage.parts.map((part) =>
                      (part.type === 'text' || part.type === 'reasoning') &&
                      part.state === 'streaming'
                        ? { ...part, state: 'done' }
                        : part,
                    ),
                    metadata: {
                      createdAt: new Date().toISOString(),
                      ...responseMessage.metadata,
                      aborted: true,
                    },
                  },
                  seq,
                );
              }
              logger.info({ ...summary, outcome: 'aborted', saved }, 'reply.end');
            } else if (isCancelled) {
              logger.info({ ...summary, outcome: 'cancelled' }, 'reply.end');
            } else {
              await store.add(responseMessage, seq);
              logger.info(
                {
                  ...summary,
                  outcome: 'completed',
                  finishReason,
                  usage: responseMessage.metadata?.usage,
                },
                'reply.end',
              );
              if (segment && seq !== undefined) {
                segmenter.replied({ segment, seq, usage: responseMessage.metadata?.usage });
              }
            }
          } finally {
            replying = false;
            // 回复期间跳过了空闲检查，从现在起重新计时
            segmenter.wrote();
          }
        },
      });
    },

    messages: () => store.list(),

    close: () => segmenter.close(),
  };
}

function hasText(message: Message): boolean {
  return message.parts.some((part) => part.type === 'text' && part.text.trim() !== '');
}
