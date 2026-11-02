import {
  APICallError,
  RetryError,
  type LanguageModelMiddleware,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import type { Message } from './message.js';
import type { FreshImageTag } from './tool-content.js';

type Part = TextStreamPart<ToolSet>;
type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>;
type CallParams = Parameters<WrapStream>[0]['params'];
type CallModel = Parameters<WrapStream>[0]['model'];

// 模型服务拒收请求的状态码：图片损坏、格式或尺寸不被接受时常见这几种
const rejectedStatus = new Set([400, 413, 422]);

/** 请求被模型服务拒收（400、413、422）；先重试过、最后一次是这种的也算 */
export function isRejectedRequest(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isRejectedRequest(error.lastError);
  return APICallError.isInstance(error) && rejectedStatus.has(error.statusCode ?? 0);
}

/**
 * 可疑图片：最后一条助手消息之后的用户消息里、还没被标记的 `luoli-file:` 图片，按消息 id 分组；
 * 没有助手消息时整段都算。读不到的文件不算（发给模型的是「[图片已丢失]」）
 */
export async function suspectImages(
  history: Message[],
  readable: (url: string) => Promise<boolean>,
): Promise<Map<string, string[]>> {
  const lastReply = history.findLastIndex((message) => message.role === 'assistant');
  const suspects = new Map<string, string[]>();
  for (const message of history.slice(lastReply + 1)) {
    if (message.role !== 'user') continue;
    const urls: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'file' || !part.url.startsWith('luoli-file:')) continue;
      if (message.metadata?.unreadableFiles?.includes(part.url)) continue;
      if (await readable(part.url)) urls.push(part.url);
    }
    if (urls.length > 0) suspects.set(message.id, urls);
  }
  return suspects;
}

/** 给消息的 metadata 加上无法读取的图片标记（与已有的合并），其他字段不变 */
export function withUnreadable(message: Message, urls: string[]): Message {
  const metadata = message.metadata!;
  const unreadableFiles = [...new Set([...(metadata.unreadableFiles ?? []), ...urls])];
  return { ...message, metadata: { ...metadata, unreadableFiles } };
}

/**
 * 包住第一次请求的流：出现任何输出之前先攒着开头的段（start-step 等；整个流的 start 段照常放出）。
 * 还没输出就出错时问 recover：它给出新的流，就丢掉攒着的段和这个错误，改读新的流（跳过它的
 * start 段，已经放出过）；否则照原样放出。最多换一次
 */
export function withFallback(
  first: ReadableStream<Part>,
  recover: (error: unknown) => Promise<ReadableStream<Part> | undefined>,
): ReadableStream<Part> {
  let reader = first.getReader();
  // 还在等第一段输出；一旦有输出、出错或结束就不再攒，也不再换
  let deciding = true;
  let held: Part[] = [];
  // 换成的新流开头的 start 段不再放出
  let skipStart = false;
  return new ReadableStream<Part>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          for (const part of held) controller.enqueue(part);
          held = [];
          controller.close();
          return;
        }
        const part = next.value;
        if (skipStart && part.type === 'start') {
          skipStart = false;
          continue;
        }
        if (!deciding || part.type === 'start') {
          controller.enqueue(part);
          return;
        }
        if (part.type === 'error') {
          deciding = false;
          const replacement = await recover(part.error);
          if (replacement) {
            // 第一次请求出错后流就结束了；读完再换
            while (!(await reader.read()).done);
            held = [];
            reader = replacement.getReader();
            skipStart = true;
            continue;
          }
        }
        if (part.type === 'error' || !isQuiet(part)) {
          deciding = false;
          for (const item of held) controller.enqueue(item);
          held = [];
          controller.enqueue(part);
          return;
        }
        held.push(part);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// 还不算输出的段：流与步骤的开始、内容段的起止、空的增量
function isQuiet(part: Part): boolean {
  switch (part.type) {
    case 'start-step':
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
    case 'raw':
      return true;
    case 'text-delta':
    case 'reasoning-delta':
      return part.text === '';
    default:
      return false;
  }
}

/** 换掉的图片的占位，与用户消息里被拒收的图片相同 */
const unreadableImage = '[图片无法读取]';

/**
 * 本次回复工具结果里的图片被拒收时，换成占位重试这一步（套在模型外层的中间件，一次回复一个）。
 * 只有本次回复新出现、还没被接受过的图片可疑：它们在请求里带着 FreshImageTag（见 toolModelOutput）；
 * 历史里的图片以前已被接受过，不带标记，不算；带标记的图片随某次请求成功发出（doStream 返回）后
 * 记进 accepted，也不再算。某次请求还没有输出就被拒收（400、413、422），且请求里有可疑图片：把它们
 * 记进 unreadable，换成「[图片无法读取]」立即再请求一次，SDK 只看到这次的结果；这次回复余下的请求
 * 里，记下的图片都换成占位。重试的请求经过内层的中间件，照常计入请求次数。没有可疑图片、或重试
 * 仍失败时，错误照原样交给 SDK。
 * unreadable 是换掉的图片的地址，回复写入历史时记进 metadata，以后的请求也用占位
 */
export function toolImageFallback(onFallback: (urls: string[], error: unknown) => void): {
  middleware: LanguageModelMiddleware;
  unreadable: () => string[];
} {
  const unreadable = new Set<string>();
  const accepted = new Set<string>();
  // 请求成功发出：其中没换掉的带标记图片都已被接受
  const request = async (model: CallModel, params: CallParams) => {
    const result = await model.doStream(withoutImages(params, unreadable));
    for (const url of freshImages(params)) if (!unreadable.has(url)) accepted.add(url);
    return result;
  };
  return {
    middleware: {
      wrapStream: async ({ params, model }) => {
        try {
          return await request(model, params);
        } catch (error) {
          const suspect = freshImages(params).filter(
            (url) => !unreadable.has(url) && !accepted.has(url),
          );
          if (suspect.length === 0 || !isRejectedRequest(error)) throw error;
          for (const url of suspect) unreadable.add(url);
          onFallback(suspect, error);
          return request(model, params);
        }
      },
    },
    unreadable: () => [...unreadable],
  };
}

type ToolResultOutput = Extract<
  Extract<CallParams['prompt'][number], { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];
type ContentPart = Extract<ToolResultOutput, { type: 'content' }>['value'][number];

/** 带 FreshImageTag 的文件部件的地址 */
function freshImageOf(part: ContentPart): string | undefined {
  if (part.type !== 'file') return undefined;
  const url = (part.providerOptions as Partial<FreshImageTag> | undefined)?.luoli?.freshToolImage;
  return typeof url === 'string' ? url : undefined;
}

function toolOutputs(params: CallParams): ToolResultOutput[] {
  return params.prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : [],
  );
}

function freshImages(params: CallParams): string[] {
  return toolOutputs(params).flatMap((output) =>
    output.type === 'content' ? output.value.flatMap((part) => freshImageOf(part) ?? []) : [],
  );
}

function withoutImages(params: CallParams, urls: ReadonlySet<string>): CallParams {
  if (urls.size === 0) return params;
  const replace = (output: ToolResultOutput): ToolResultOutput =>
    output.type === 'content'
      ? {
          ...output,
          value: output.value.map((part) => {
            const url = freshImageOf(part);
            return url !== undefined && urls.has(url)
              ? { type: 'text' as const, text: unreadableImage }
              : part;
          }),
        }
      : output;
  return {
    ...params,
    prompt: params.prompt.map((message) =>
      message.role === 'tool'
        ? {
            ...message,
            content: message.content.map((part) =>
              part.type === 'tool-result' ? { ...part, output: replace(part.output) } : part,
            ),
          }
        : message,
    ),
  };
}
