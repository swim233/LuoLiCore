import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { trackAttempts } from './attempts.js';
import { errorKind, summarizeError } from './errors.js';
import { createMemoryFileStore, inlineFiles, type FileStore, type NewFile } from './files.js';
import {
  isRejectedRequest,
  suspectImages,
  toolImageFallback,
  withFallback,
  withUnreadable,
} from './image-fallback.js';
import { silentLogger, type Logger } from './logger.js';
import { combineSteps, toCallTokens, toUsage } from './model.js';
import type { Author, Message, MessageChunk, MessageMetadata } from './message.js';
import { formatForModel, summaryInstruction, systemPrompt } from './prompt.js';
import { PromptFileError, type PromptSource } from './prompt-files.js';
import { createSegmenter, type SegmentOptions, type Summarize } from './segments.js';
import { createMemoryStore } from './storage/memory.js';
import type { ConversationStore, ModelCall, Segment, ToolCall } from './storage/types.js';
import { isStoredToolContent, toolContentOutput } from './tool-content.js';
import { hasToolCalls, settleToolParts, toolHistory } from './tool-history.js';
import { runTool, toToolSet, ToolError, watchToolCalls, type InstalledTool } from './tools.js';

export type Conversation = {
  /**
   * 记录一条用户消息，不产生回复。可以附带图片（先存进文件存储，消息里只存地址），
   * 有图片时可以没有文字。写入前发现会话已空闲太久时，在后台切段，这条消息归入新段
   */
  append(input: AppendInput): Promise<Message>;
  /**
   * 根据当前历史生成回复。错误以 error chunk 出现在流中，不会抛出；
   * 每次重试前流中出现一个 transient 的 `data-retry` 段；流中途重新生成时随后还有
   * 一个 `reset-step`，失败那次已输出的内容不会写入历史。
   * 流读完时回复已写入历史；被取消、一步都没完成就出错、没有任何文字也没有执行过工具时不写入。
   * 后台正在空闲切段时，等它结束再读当前段；压缩进行中不等，照常用当前段。
   * 开始时读一次提示词，这次的重试与拒收图片后的恢复都用这一份；提示词文件有误时按失败处理
   * （流里一个 error 段，不发请求，不记模型调用）。
   * 请求还没有输出就被拒收（400、413、422），且上一条助手消息之后有新图片时，把这些图片换成
   * 「[图片无法读取]」重试一次，流里只出现重试的输出；重试没有失败时把标记写进那些消息。
   * 工具结果可以带图片（TextAndImages）：图片存进文件存储，当次回复里交给模型看，以后的回复里
   * 照样发。某一步的请求因为这次回复工具结果里的图片被拒收时，换成占位重试这一步，余下的步也用
   * 占位，回复写入历史时把这些图片记进 metadata 的 unreadableFiles，以后的请求都用占位。
   * 正常完成且输入超过压缩阈值时，在后台压缩。
   * 装了工具时一次回复可以有多步：模型调了工具，执行完把结果交回模型再请求一次，直到不再调工具
   * 或碰到上限（步数、总时长）。工具出错、超时、参数不对都以错误结果交给模型，循环照常继续，
   * 不算回复失败。重试与首段、段间超时按每一步的请求计。
   * 中途出错时，已完成的步（流里收到 finish-step 的步）写入历史并标记 failed，失败那一步自己的
   * 输出不写；没有完成的步时不写入。写入前没有结果的工具调用都以「工具调用未完成」结束。
   * 上一个回复的流还没结束时调用会立即抛错。
   */
  reply(options?: ReplyOptions): ReadableStream<MessageChunk>;
  messages(): Promise<Message[]>;
  /** 停止后台的空闲检查，中止进行中的摘要并等它结束。之后不再使用这个会话 */
  close(): Promise<void>;
};

export type AppendInput = {
  author: Author;
  text?: string;
  files?: NewFile[];
  /** 消息发出的时间（ISO），平台给出时用它；默认为写入时间 */
  createdAt?: string;
  /** 平台里的消息 id，存进 metadata 与 platform_message_id 列 */
  platformMessageId?: string;
};

export type ReplyOptions = {
  /** 中止当前回复。调用时已中止的信号照常走中止路径 */
  abortSignal?: AbortSignal;
};

/** 装了工具时传给 streamText 的几项：工具集与多步的控制 */
type ToolLoop = Pick<
  Parameters<typeof streamText<ToolSet>>[0],
  'tools' | 'toolChoice' | 'stopWhen' | 'prepareStep'
>;

export function createConversation({
  model,
  prompts,
  store = createMemoryStore(),
  fileStore = createMemoryFileStore(),
  logger = silentLogger,
  maxRetries = 2,
  conversationId,
  timeouts = {},
  tools = [],
  maxSteps = 50,
  toolHistoryChars = 2000,
  segments = {},
  checkIdleOnCreate = true,
}: {
  /** 不接受字符串形式的模型 id：`wrapLanguageModel` 需要模型实例 */
  model: Exclude<LanguageModel, string>;
  /**
   * 提示词来源：人设与内置提示（消息格式说明等），每次回复、每次摘要开始时取一次当前的文字。
   * 几个会话可以共用一个来源
   */
  prompts: PromptSource;
  store?: ConversationStore;
  /** 消息附带的图片、工具结果里的图片存在这里 */
  fileStore?: FileStore;
  logger?: Logger;
  /** 重试次数：请求阶段（maxRetries）与流中错误事件（streamRetries）各自最多这么多次 */
  maxRetries?: number;
  /** 存储里的会话 id，只写进日志，便于多会话排查 */
  conversationId?: string;
  /**
   * 超时（毫秒）。firstChunkMs、chunkMs：等第一段输出、两段输出之间，按每一步的每次请求计，
   * 工具执行期间不计；超时按失败处理。replyMs：一次回复的总时长（默认 10 分钟），每一步开始前
   * 检查，已经超过时这一步就是收尾步。toolMs：一次工具调用的默认时限（默认 60 秒），
   * 工具自己声明了 timeoutMs 时用它的；到时这次调用以错误结束，回复继续
   */
  timeouts?: { firstChunkMs?: number; chunkMs?: number; replyMs?: number; toolMs?: number };
  /**
   * 装好的工具（installTools 的结果），按这个顺序发给模型。没有工具时请求里没有工具定义，
   * 与不传这一项时逐字相同
   */
  tools?: readonly InstalledTool[];
  /**
   * 一次回复最多几步（默认 50，至少为 2：为 1 时第一步就是收尾步；这里不校验，由前端的配置保证），
   * 装了工具时才起作用。第 maxSteps 步（或总时长已超过时的那一步）
   * 是收尾步：工具定义照旧发出，但不许调用，请求末尾加一条收尾提示（prompts/tool-limit.md）
   */
  maxSteps?: number;
  /**
   * 以后的回复（和摘要）里，没有声明 history 的工具结果截短到这么多字符（默认 2000）；
   * 不在这次装上的工具里的、工具出错的说明也按它截短
   */
  toolHistoryChars?: number;
  /** 分段：空闲切段、压缩与摘要（ADR-0004） */
  segments?: SegmentOptions;
  /**
   * 创建时按现在的时间检查一次空闲，补做停机期间漏掉的切段（默认）。
   * 前端还有离线积压要写入时传 false：积压的消息带着平台时间，写入时按消息之间的间隔判断
   */
  checkIdleOnCreate?: boolean;
}): Conversation {
  const { firstChunkMs = 60_000, chunkMs = 30_000, replyMs = 600_000, toolMs = 60_000 } = timeouts;
  let replying = false;

  const presentTools = toolHistory(tools, toolHistoryChars);

  /**
   * 历史消息换成发给模型的消息：工具结果按工具的声明呈现、标签格式、中途结束的标记、
   * 图片换成 data URL，工具结果里的图片与当次回复一样以图片部件交出。读不到的图片换成文字，
   * 记一条 warn（只记地址）；
   * 呈现函数出错时按默认处理，记一条 warn（只记工具名与错误类型；同一个调用在这个会话对象里只记一次）
   */
  async function toModelMessages(history: Message[], logFields: object): Promise<ModelMessage[]> {
    const onMissing = (url: string) => logger.warn({ ...logFields, url }, 'file.missing');
    const onRenderError = (tool: string, error: unknown) =>
      logger.warn({ ...logFields, tool, errorType: errorKind(error) }, 'tool.history_failed');
    const messages = await convertToModelMessages(
      await Promise.all(
        history.map((message) =>
          inlineFiles(formatForModel(presentTools(message, onRenderError)), fileStore, onMissing),
        ),
      ),
    );
    // 带图片的工具结果被 SDK 当成 JSON：换成文字加图片的内容部件
    return Promise.all(
      messages.map(async (message) => {
        if (message.role !== 'tool') return message;
        const content = await Promise.all(
          message.content.map(async (part) =>
            part.type === 'tool-result' &&
            part.output.type === 'json' &&
            isStoredToolContent(part.output.value)
              ? {
                  ...part,
                  output: await toolContentOutput(part.output.value, fileStore, { onMissing }),
                }
              : part,
          ),
        );
        return { ...message, content };
      }),
    );
  }

  /**
   * 一次模型调用（回复或摘要），重试与超时相同。tracker 先建好，调用方随时能读它的统计；
   * stream() 才真正发出请求。调用结束时由调用方 record()，在模型调用表记一行
   */
  function modelCall({
    abortSignal,
    logFields,
    notify,
    kind,
  }: {
    /** 调用方的中止信号；请求被中止而它没有中止时，就是超时 */
    abortSignal?: AbortSignal;
    logFields: object;
    notify: (chunk: MessageChunk) => void;
    /** 模型调用表里区分用途的几列 */
    kind: Pick<ModelCall, 'purpose' | 'summaryReason' | 'replyId'>;
  }) {
    const createdAt = Date.now();
    // 第一次请求发出（第一次 stream()）的时间；拒收图片后的重试不改它。
    // 没来得及发出请求就出错时，按建立这次调用的时间算
    let startedAt: number | undefined;
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
    // 本次回复工具结果里的图片被拒收时换成占位重试；套在 tracker 外层，重试的请求照常计数。
    // 被接住的那次失败 SDK 看不到，tracker 也不算进请求失败，之后的重试序号与 SDK 一致
    const imageFallback = toolImageFallback((urls, error) => {
      tracker.discountFailure();
      logger.warn(
        { ...logFields, replaced: urls.length, urls, error: summarizeError(error) },
        'reply.tool_image_fallback',
      );
    });
    return {
      tracker,
      /** 这次调用里被拒收、换成占位的工具图片的地址；回复写入历史时记进 metadata */
      unreadableToolImages: imageFallback.unreadable,
      /** 发出请求。loop 是装了工具时的工具与多步设置；不给时与没有工具时一样，只有一步 */
      stream: (system: string, messages: ModelMessage[], loop?: ToolLoop) => {
        startedAt ??= Date.now();
        return streamText({
          // SDK 的每次请求（含两类重试、多步的每一步）都重新调用 doStream，中间件能逐次观察。
          // 排在前面的中间件在外层
          model: wrapLanguageModel({
            model,
            middleware: [imageFallback.middleware, tracker.middleware],
          }),
          instructions: system,
          messages,
          maxRetries,
          streamRetries: maxRetries,
          timeout: { firstChunkMs, chunkMs },
          abortSignal: signal,
          // 错误经 stream 交给调用方；不传时 SDK 默认把整个错误对象打到 stderr。
          // 不返回 { retry: true }，不额外请求重试
          onError: () => {},
          ...loop,
        });
      },

      /**
       * 调用结束：在模型调用表记一行。正常结束（completed、empty）才记结束原因与用量（各步之和），
       * 失败才记错误；步数取发出过请求的步数，工具调用次数由调用方给（摘要为 0）。
       * 写入出错（如退出时数据库已关闭）只记日志，从不抛出
       */
      async record({
        outcome,
        finishReason,
        usage,
        error,
        toolCalls = 0,
      }: {
        outcome: ModelCall['outcome'];
        finishReason?: string;
        usage?: LanguageModelUsage;
        error?: unknown;
        toolCalls?: number;
      }): Promise<void> {
        const endedAt = Date.now();
        const start = startedAt ?? createdAt;
        const firstOutputAt = tracker.firstOutputAt();
        const finished = outcome === 'completed' || outcome === 'empty';
        const row: ModelCall = {
          ...kind,
          model: model.modelId,
          startedAt: new Date(start).toISOString(),
          durationMs: endedAt - start,
          firstOutputMs: firstOutputAt === undefined ? undefined : firstOutputAt - start,
          attempts: tracker.stats.attempts,
          outcome,
          ...(finished ? { finishReason, ...(usage && toCallTokens(usage)) } : {}),
          ...(outcome === 'failed' ? { error: errorKind(error) } : {}),
          steps: tracker.steps(),
          toolCalls,
        };
        try {
          await store.recordCall(row);
        } catch (writeError) {
          logger.error(
            { ...logFields, purpose: kind.purpose, error: summarizeError(writeError) },
            'model_call.record_failed',
          );
        }
      },
    };
  }

  // 摘要请求沿用这一段的前缀：与回复相同的 system 与消息，末尾追加一条不包标签的指令
  const summarize: Summarize = async ({
    reason,
    segment,
    history,
    scope,
    maxChars,
    abortSignal,
  }) => {
    // 一次摘要读一次提示词，system 与摘要指令来自同一份。读到有错时直接抛出：
    // 切段那边按摘要失败处理；还没有发出请求，不记模型调用
    const texts = await prompts.load();
    const logFields = { conversationId, modelId: model.modelId, purpose: 'summary', reason };
    const call = modelCall({
      abortSignal,
      logFields,
      notify: () => {},
      kind: { purpose: 'summary', summaryReason: reason },
    });
    let text: string;
    let usage: LanguageModelUsage;
    let finishReason: string;
    try {
      const result = call.stream(
        systemPrompt(texts, segment),
        [
          ...(await toModelMessages(history, logFields)),
          { role: 'user', content: summaryInstruction(texts, scope, maxChars) },
        ],
        // 装了工具时带上同样的工具定义：前缀与回复一致，缓存照常命中；历史里的工具调用也有对应的
        // 定义。toolChoice 为 none，SDK 不执行工具
        tools.length > 0
          ? {
              tools: toToolSet(
                tools,
                () => Promise.reject(new ToolError('摘要请求不执行工具')),
                fileStore,
              ),
              toolChoice: 'none',
            }
          : undefined,
      );
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
      const [total, steps] = await Promise.all([result.totalUsage, result.steps]);
      [text, finishReason] = await Promise.all([result.text, result.finishReason]);
      // 与回复相同：缓存数、推理数按各步判断服务端报没报（摘要只有一步，结果与 total 一致）
      usage = combineSteps(
        total,
        steps.map((step) => step.usage),
      );
    } catch (error) {
      // 关闭会话时的中止不算失败，与 summary.aborted 的判断一致
      await call.record(
        abortSignal.aborted ? { outcome: 'aborted' } : { outcome: 'failed', error },
      );
      throw error;
    }
    // 摘要为空由切段那边按失败处理；这次调用本身正常结束了
    await call.record({ outcome: text.trim() ? 'completed' : 'empty', finishReason, usage });
    return { text, usage: toUsage(usage), stats: call.tracker.stats };
  };

  const segmenter = createSegmenter({
    store,
    logger,
    logFields: { conversationId, modelId: model.modelId },
    options: segments,
    summarize,
    isReplying: () => replying,
    checkOnCreate: checkIdleOnCreate,
  });

  return {
    async append({ author, text, files = [], createdAt, platformMessageId }) {
      // 先存文件，再写消息：消息里的地址总能找到文件
      const urls = await Promise.all(files.map((file) => fileStore.save(file)));
      const message: Message = {
        id: generateId(),
        role: 'user',
        metadata: {
          author,
          createdAt: createdAt ?? new Date().toISOString(),
          ...(platformMessageId === undefined ? {} : { platformMessageId }),
        },
        parts: [
          // 有图片时文字可以省略；只有文字时照旧（空文字也写一个 text part）
          ...(text || files.length === 0 ? [{ type: 'text' as const, text: text ?? '' }] : []),
          ...files.map((file, index) => ({
            type: 'file' as const,
            mediaType: file.mediaType,
            url: urls[index]!,
          })),
        ],
      };
      // 写入前看是否已经空闲太久：定时器没赶上、或上次空闲切段失败时，在这里补做，
      // 这条消息归入新段。消息带着平台的发送时间时，按它与上一条的间隔判断：
      // 离线期间积压的消息彼此只隔几秒，不应因为「距今」很久而切段
      await segmenter.checkIdle(createdAt === undefined ? undefined : Date.parse(createdAt));
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
      const call = modelCall({
        abortSignal,
        logFields,
        notify: (chunk) => writeNotice(chunk),
        kind: { purpose: 'reply', replyId },
      });
      const { tracker } = call;
      // 拒收图片后的重试换掉的图片，按消息 id；没有重试过时为 undefined
      let fallback: Map<string, string[]> | undefined;
      // 这次回复的总用量（各步之和，见 combineSteps），记进模型调用表；metadata 里的 usage 由它换算
      let totalUsage: LanguageModelUsage | undefined;
      // 每一步的用量（finish-step 段带着，含原始用量），合计时据此判断服务端报没报缓存数与推理数
      const stepUsages: LanguageModelUsage[] = [];
      // 最后一步的输入 token（finish-step 段带着这一步的用量）：压缩按它判断，
      // 各步之和会把同一段上下文重复计算（ADR-0004）
      let lastStepInput: number | undefined;

      // onEnd 的 outcome 判断不了是否出错：外层流没声明 outcome 时正常结束也是 unknown，
      // 内层在错误事件之后收到 finish 又会记成 completed。所以自己记下出过的错。
      // 同一个错误会经过这里两次，第二次是 SDK 按 errorText 重建的 Error，只留第一次的。
      // 流式重试成功时 SDK 不向下游发 error 部分，这里不会被误置
      let failure: { error: unknown } | undefined;
      const describeError = (error: unknown) => {
        failure ??= { error };
        return error instanceof Error ? error.message : String(error);
      };
      // 工具的错误（执行出错、超时、参数不合结构、不存在的工具）也经过 UI 流的 onError，
      // 用来生成工具段的 errorText。它们以错误结果交给模型、循环继续，不算回复失败：
      // watchToolCalls 已把它们换成 ToolError，message 就是模型看到的说明
      const describeStreamError = (error: unknown) =>
        error instanceof ToolError ? error.message : describeError(error);
      /** 工具调用表写一行。写入出错只记日志，不影响工具调用与回复 */
      async function recordToolCall(row: Omit<ToolCall, 'replyId'>): Promise<void> {
        try {
          await store.recordToolCall({ replyId, ...row });
        } catch (error) {
          logger.error(
            { ...logFields, tool: row.tool, error: summarizeError(error) },
            'tool_call.record_failed',
          );
        }
      }
      // 工具调用：数次数，不合规的调用记日志与工具调用表，工具的错误换成 ToolError
      const toolCalls = watchToolCalls({ logger, logFields, record: recordToolCall });

      // SDK 超时（以及上面的首段计时）都以 abort 段结束回复流。用户没有中止却收到 abort，
      // 就是超时：换成 error 段，按失败处理（不写入，记 reply.failed）。
      // 是哪种超时看超时那次请求（当前这一步的最近一次请求）有没有输出过内容，
      // 由跟踪每次请求的中间件判断，不解析 SDK 的错误文字
      const timeoutAsFailure = () =>
        new TransformStream<MessageChunk, MessageChunk>({
          transform(chunk, controller) {
            if (chunk.type !== 'abort' || abortSignal?.aborted) {
              controller.enqueue(chunk);
              return;
            }
            const detail = tracker.attemptHasOutput()
              ? `两段输出之间超过 ${chunkMs / 1000} 秒`
              : `${firstChunkMs / 1000} 秒内没有收到第一段输出`;
            const error = new DOMException(`等待模型输出超时：${detail}`, 'TimeoutError');
            controller.enqueue({ type: 'error', errorText: describeError(error) });
          },
        });

      // 完成的步：流里收到了 finish-step（工具已执行完、结果已在段里）、此前没有出错的步。
      // 出错的那一步也可能随后收到 finish-step（如模型违反 toolChoice），不算
      let finishedSteps = 0;
      const countFinishedSteps = () => {
        let errored = false;
        return new TransformStream<MessageChunk, MessageChunk>({
          transform(chunk, controller) {
            if (chunk.type === 'error') errored = true;
            if (chunk.type === 'finish-step' && !errored) finishedSteps++;
            controller.enqueue(chunk);
          },
        });
      };

      /** 写入的回复正常结束后，按最后一步的输入看是否要在后台压缩 */
      function checkCompress() {
        if (segment && seq !== undefined) {
          segmenter.replied({ segment, seq, inputTokens: lastStepInput });
        }
      }

      /**
       * 写入历史：工具段收尾（见 settleToolParts），停在 streaming 状态的文字、推理段改为 done，
       * 空的文字段（一步只调了工具、没说话时会有）与末尾没有内容的 step-start 去掉；
       * metadata 合并 extra。这次回复里被拒收的工具图片记进 unreadableFiles，以后的请求都用占位。
       * 序号用回复开始时预留的
       */
      async function save(message: Message, extra: Partial<MessageMetadata> = {}) {
        const unreadable = call.unreadableToolImages();
        const parts = settleToolParts(message.parts).flatMap((part): Message['parts'] => {
          if (part.type === 'text' && part.text === '') return [];
          return (part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming'
            ? [{ ...part, state: 'done' }]
            : [part];
        });
        while (parts.at(-1)?.type === 'step-start') parts.pop();
        await store.add(
          {
            ...message,
            parts,
            metadata: {
              createdAt: new Date().toISOString(),
              ...message.metadata,
              ...extra,
              ...(unreadable.length > 0 ? { unreadableFiles: unreadable } : {}),
            },
          },
          seq,
        );
      }

      /**
       * 装了工具时一次 streamText 调用的多步循环（没有工具时为 undefined）。每次调用（含拒收图片后的
       * 重试）各用一份，从第 1 步数起。每一步开始前看是否已到上限：这一步是第 maxSteps 步，
       * 或回复开始已超过 replyMs，这一步就是收尾步
       */
      const toolLoop = (toolLimit: string, title: string | undefined): ToolLoop | undefined => {
        if (tools.length === 0) return undefined;
        // 当前是第几步（从 0 数），工具执行时记进日志
        let step = 0;
        let finalStep = false;
        return {
          tools: toToolSet(
            tools,
            (tool, input, { toolCallId, abortSignal }) =>
              runTool(tool, input, {
                toolCallId,
                abortSignal,
                timeoutMs: toolMs,
                step: step + 1,
                conversation: { id: conversationId, title },
                logger,
                logFields,
                record: recordToolCall,
                files: fileStore,
              }),
            fileStore,
          ),
          // 收尾步之后不再有下一步；其余时候模型不再调工具，循环自然结束
          stopWhen: () => finalStep,
          prepareStep: ({ stepNumber, messages }) => {
            step = stepNumber;
            const reason =
              stepNumber + 1 >= maxSteps
                ? 'steps'
                : Date.now() - startedAt >= replyMs
                  ? 'time'
                  : undefined;
            if (!reason) return undefined;
            finalStep = true;
            logger.info({ ...logFields, reason, step: stepNumber + 1 }, 'reply.limit');
            // 工具定义照旧发出（前缀不变，缓存不受影响），只是这一步不许调用。
            // 收尾提示不包标签，只加在这次请求的末尾，不写进历史
            return {
              toolChoice: 'none',
              messages: [...messages, { role: 'user', content: toolLimit }],
            };
          },
        };
      };

      /**
       * 拒收图片后的重试没有失败：把换掉的图片标记写进那些消息，之后的请求都用占位。
       * 以存储里的最新版本为基础（生成期间可能被编辑过），只加标记。出错只记日志
       */
      async function markUnreadable(): Promise<{ markedUnreadable?: number }> {
        if (!fallback) return {};
        try {
          let marked = 0;
          for (const [id, urls] of fallback) {
            const latest = await store.get(id);
            if (!latest) continue;
            await store.update(withUnreadable(latest, urls));
            marked++;
          }
          return { markedUnreadable: marked };
        } catch (error) {
          logger.error({ ...logFields, error: summarizeError(error) }, 'reply.mark_failed');
          return {};
        }
      }

      // 外层 createUIMessageStream 让 reply() 能同步返回流（历史要异步读），
      // 并把任何抛出的错误（读历史失败、连接中途断开）都转成 error chunk
      return createUIMessageStream<Message>({
        generateId: () => replyId,
        execute: async ({ writer }) => {
          writeNotice = (chunk) => writer.write(chunk);
          // 正在空闲切段时先等它结束，读到的才是切段之后的当前段（压缩不等，见 settled）
          await segmenter.settled();
          // 读一次提示词：这次的重试（SDK 内部的两类）与拒收图片后的恢复都用这一份，
          // 期间文件再变也不影响。读到有错时抛出，按失败处理
          const texts = await prompts.load();
          const current = await store.currentSegment();
          segment = current;
          seq = await store.reserve();
          // 只看当前段里预留号之前的消息：模型看到的正是排在回复之前的那些
          const history = await store.list({ from: current.startSeq, before: seq });
          const system = systemPrompt(texts, current);
          const loop = () => toolLoop(texts.toolLimit, current.conversationTitle);
          const first = call.stream(
            system,
            await toModelMessages(history, logFields),
            loop(),
          ).stream;
          // 还没有输出就被拒收：可能是新来的图片模型读不了，换成占位重试一次（同一段、同一个序号）
          const stream = withFallback(first, async (error) => {
            if (!isRejectedRequest(error)) return undefined;
            const suspects = await suspectImages(
              history,
              async (url) => (await fileStore.read(url)) !== undefined,
            );
            if (suspects.size === 0) return undefined;
            const urls = [...suspects.values()].flat();
            logger.warn(
              { ...logFields, replaced: urls.length, urls, error: summarizeError(error) },
              'reply.image_fallback',
            );
            fallback = suspects;
            tracker.restart();
            const marked = history.map((message) => {
              const replaced = suspects.get(message.id);
              return replaced ? withUnreadable(message, replaced) : message;
            });
            return call.stream(system, await toModelMessages(marked, logFields), loop()).stream;
          });
          let createdAt: string | undefined;
          writer.merge(
            toUIMessageStream<ToolSet, Message>({
              stream: stream.pipeThrough(toolCalls.stream),
              // start 段附上时间，finish 段附上用量（合并进回复的 metadata）。
              // 中止没有 finish 段；失败的回复不写入历史。finish 段也要带 createdAt（类型要求），值不变
              messageMetadata: ({ part }) => {
                if (part.type === 'start') {
                  createdAt = new Date().toISOString();
                  return { createdAt };
                }
                if (part.type === 'finish-step') {
                  lastStepInput = part.usage.inputTokens;
                  stepUsages.push(part.usage);
                }
                if (part.type === 'finish') {
                  createdAt ??= new Date().toISOString();
                  totalUsage = combineSteps(part.totalUsage, stepUsages);
                  const usage = toUsage(totalUsage);
                  return usage ? { createdAt, usage } : { createdAt };
                }
                return undefined;
              },
              onError: describeStreamError,
            })
              .pipeThrough(tracker.markStreamRetries())
              .pipeThrough(timeoutAsFailure())
              .pipeThrough(countFinishedSteps()),
          );
        },
        onError: describeError,
        onEnd: async ({ responseMessage, isAborted, isCancelled, finishReason }) => {
          const outcome = replyOutcome({
            failed: failure !== undefined,
            isAborted,
            isCancelled,
            message: responseMessage,
          });
          try {
            const summary = {
              ...logFields,
              durationMs: Date.now() - startedAt,
              ...tracker.stats,
              steps: tracker.steps(),
              toolCalls: toolCalls.count(),
              ...(fallback ? { imageFallback: true } : {}),
              ...(call.unreadableToolImages().length > 0 ? { toolImageFallback: true } : {}),
            };
            // 先记模型调用：之后写历史出错也不影响这一行。提示词文件有误时没有发出请求，不记
            if (!(failure?.error instanceof PromptFileError)) {
              await call.record({
                outcome,
                finishReason,
                usage: totalUsage,
                error: failure?.error,
                toolCalls: toolCalls.count(),
              });
            }
            if (outcome === 'failed') {
              // 已完成的步写入历史并标记 failed：群里已经看到的话、工具已经产生的副作用，
              // 模型以后应该知道。失败那一步自己的输出不写；一步都没完成时不写入，序号空着。
              // 失败没有用量（失败那一步可能也带来了 finish 段的用量）
              const done = {
                ...responseMessage,
                parts: firstSteps(responseMessage.parts, finishedSteps),
              };
              const saved = finishedSteps > 0 && (hasText(done) || hasToolCalls(done));
              if (saved) {
                const metadata: MessageMetadata = {
                  createdAt: new Date().toISOString(),
                  ...done.metadata,
                  failed: true,
                };
                delete metadata.usage;
                await save({ ...done, metadata });
              }
              // 写入的步用的是换成占位后被接受的请求：标记照写，否则这些图片落到这条回复之前，
              // 不再算可疑，之后的请求会一直带着它们被拒
              const marked = saved ? await markUnreadable() : {};
              logger.error(
                { ...summary, saved, ...marked, error: summarizeError(failure?.error) },
                'reply.failed',
              );
            } else if (outcome === 'aborted') {
              // 半截回复写入历史并标记 aborted；一个字都没输出、也没执行过工具时不写入。
              // 执行中的工具可能已经产生副作用，以「工具调用未完成」结束后照样写入
              const saved = hasText(responseMessage) || hasToolCalls(responseMessage);
              if (saved) await save(responseMessage, { aborted: true });
              const marked = saved ? await markUnreadable() : {};
              logger.info({ ...summary, outcome: 'aborted', saved, ...marked }, 'reply.end');
            } else if (outcome === 'cancelled') {
              logger.info({ ...summary, outcome: 'cancelled' }, 'reply.end');
            } else if (outcome === 'empty') {
              // 正常结束却没有任何文字：执行过工具时照样写入（副作用已经发生）；
              // 否则与一字未出就被中止一样不写入，序号空着
              const saved = hasToolCalls(responseMessage);
              if (saved) {
                await save(responseMessage);
                checkCompress();
              }
              logger.warn(
                {
                  ...summary,
                  outcome: 'empty',
                  saved,
                  finishReason,
                  usage: responseMessage.metadata?.usage,
                  ...(await markUnreadable()),
                },
                'reply.end',
              );
            } else {
              await save(responseMessage);
              logger.info(
                {
                  ...summary,
                  outcome: 'completed',
                  finishReason,
                  usage: responseMessage.metadata?.usage,
                  ...(await markUnreadable()),
                },
                'reply.end',
              );
              checkCompress();
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

/** 回复的结果：reply.end（或 reply.failed）与模型调用表都按它 */
function replyOutcome({
  failed,
  isAborted,
  isCancelled,
  message,
}: {
  failed: boolean;
  isAborted: boolean;
  isCancelled?: boolean;
  message: Message;
}): ModelCall['outcome'] {
  if (failed) return 'failed';
  if (isAborted) return 'aborted';
  if (isCancelled) return 'cancelled';
  return hasText(message) ? 'completed' : 'empty';
}

function hasText(message: Message): boolean {
  return message.parts.some((part) => part.type === 'text' && part.text.trim() !== '');
}

/** 前 count 步的段：每一步从一个 step-start 开始，切在第 count + 1 个 step-start 之前 */
function firstSteps(parts: Message['parts'], count: number): Message['parts'] {
  let starts = 0;
  const end = parts.findIndex((part) => part.type === 'step-start' && ++starts > count);
  return end === -1 ? parts : parts.slice(0, end);
}
