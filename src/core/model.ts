import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import type { Usage } from './message.js';
import type { ModelCall } from './storage/types.js';

export type ModelOptions = {
  baseURL: string;
  apiKey?: string;
  modelId: string;
  /** 发请求用的 fetch，默认全局的；测试里换成假的服务端 */
  fetch?: typeof globalThis.fetch;
};

export function createModel({
  baseURL,
  apiKey,
  modelId,
  fetch,
}: ModelOptions): Exclude<LanguageModel, string> {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL,
    apiKey,
    fetch,
    // 流式响应默认不带用量，要显式请求（stream_options.include_usage）
    includeUsage: true,
    // 工具结果带图片时，tool 消息的内容是文字加 image_url 部件（ADR-0006）。不是 Chat Completions
    // 的标准，用户的服务端实测可用。只影响以内容部件交出的结果，普通结果照旧是字符串
    supportsMultiPartToolContent: true,
  });
  return provider(modelId);
}

/**
 * SDK 的用量换成存进历史的 Usage；服务端没报用量时返回 undefined。
 * openai-compatible 的 provider 在服务端没报缓存数（prompt_tokens_details.cached_tokens）、
 * 推理数（completion_tokens_details.reasoning_tokens）时也填 0；看原始用量区分「没报」和
 * 「报了 0」，没报时 cacheRead、reasoning 为 undefined
 */
export function toUsage(usage: LanguageModelUsage): Usage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
    cacheRead: reportsCacheRead(usage.raw) ? usage.inputTokenDetails.cacheReadTokens : undefined,
    reasoning: reportsReasoning(usage.raw) ? usage.outputTokenDetails.reasoningTokens : undefined,
  };
}

/**
 * 一次调用各步的用量合成一份：输入、输出、总数等取 SDK 的合计（total）；缓存命中与推理 token
 * 按每一步的原始用量判断服务端报没报。SDK 合计多步时不保留原始用量，而 openai-compatible 在
 * 服务端没报时也填 0，只看合计会把「没报」记成 0。任何一步报了就是报了的各步之和，
 * 没有一步报为 undefined。结果不带原始用量：toUsage、toCallTokens 直接用这两个数
 */
export function combineSteps(
  total: LanguageModelUsage,
  steps: readonly LanguageModelUsage[],
): LanguageModelUsage {
  if (steps.length === 0) return total;
  const sumReported = (values: Array<number | undefined>) => {
    const reported = values.filter((value): value is number => value !== undefined);
    return reported.length === 0 ? undefined : reported.reduce((sum, value) => sum + value, 0);
  };
  return {
    ...total,
    inputTokenDetails: {
      ...total.inputTokenDetails,
      cacheReadTokens: sumReported(
        steps.map((step) =>
          reportsCacheRead(step.raw) ? step.inputTokenDetails.cacheReadTokens : undefined,
        ),
      ),
    },
    outputTokenDetails: {
      ...total.outputTokenDetails,
      reasoningTokens: sumReported(
        steps.map((step) =>
          reportsReasoning(step.raw) ? step.outputTokenDetails.reasoningTokens : undefined,
        ),
      ),
    },
    raw: undefined,
  };
}

/** 模型调用表的 4 个 token 列（ADR-0005） */
export type CallTokens = Pick<
  ModelCall,
  'inputTokens' | 'cacheReadTokens' | 'outputTokens' | 'reasoningTokens'
>;

/**
 * SDK 的用量换成模型调用表的 token 列；服务端没报用量时返回 undefined。
 * 4 列都取 toUsage 的结果，「没报」和「报了 0」的区分与它一致
 */
export function toCallTokens(usage: LanguageModelUsage): CallTokens | undefined {
  const reported = toUsage(usage);
  if (!reported) return undefined;
  return {
    inputTokens: reported.input,
    cacheReadTokens: reported.cacheRead,
    outputTokens: reported.output,
    reasoningTokens: reported.reasoning,
  };
}

function reportsCacheRead(raw: LanguageModelUsage['raw']): boolean {
  return reports(raw, 'prompt_tokens_details', 'cached_tokens');
}

function reportsReasoning(raw: LanguageModelUsage['raw']): boolean {
  return reports(raw, 'completion_tokens_details', 'reasoning_tokens');
}

/** 原始用量里报了 raw[details][field] 这个数 */
function reports(raw: LanguageModelUsage['raw'], details: string, field: string): boolean {
  // 没有原始用量（如测试用的 mock）时信任 SDK 给的值；有 openai 格式的原始用量时看它报没报
  if (raw === undefined || !('prompt_tokens' in raw)) return true;
  const value = raw[details];
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[field] === 'number'
  );
}
