import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import type { Usage } from './message.js';
import type { ModelCall } from './storage/types.js';

export type ModelOptions = {
  baseURL: string;
  apiKey?: string;
  modelId: string;
};

export function createModel({
  baseURL,
  apiKey,
  modelId,
}: ModelOptions): Exclude<LanguageModel, string> {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL,
    apiKey,
    // 流式响应默认不带用量，要显式请求（stream_options.include_usage）
    includeUsage: true,
  });
  return provider(modelId);
}

/**
 * SDK 的用量换成存进历史的 Usage；服务端没报用量时返回 undefined。
 * openai-compatible 的 provider 在服务端没报缓存数（prompt_tokens_details.cached_tokens）时
 * 也填 0；看原始用量区分「没报」和「报了 0」，没报时 cacheRead 为 undefined
 */
export function toUsage(usage: LanguageModelUsage): Usage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
    cacheRead: reportsCacheRead(usage.raw) ? usage.inputTokenDetails.cacheReadTokens : undefined,
  };
}

/** 模型调用表的 4 个 token 列（ADR-0005） */
export type CallTokens = Pick<
  ModelCall,
  'inputTokens' | 'cacheReadTokens' | 'outputTokens' | 'reasoningTokens'
>;

/**
 * SDK 的用量换成模型调用表的 token 列；服务端没报用量时返回 undefined。
 * 输入、输出、缓存命中与 toUsage 一致；推理 token 同缓存命中：provider 没报时也填 0，看原始用量区分
 */
export function toCallTokens(usage: LanguageModelUsage): CallTokens | undefined {
  const reported = toUsage(usage);
  if (!reported) return undefined;
  return {
    inputTokens: reported.input,
    cacheReadTokens: reported.cacheRead,
    outputTokens: reported.output,
    reasoningTokens: reports(usage.raw, 'completion_tokens_details', 'reasoning_tokens')
      ? usage.outputTokenDetails.reasoningTokens
      : undefined,
  };
}

function reportsCacheRead(raw: LanguageModelUsage['raw']): boolean {
  return reports(raw, 'prompt_tokens_details', 'cached_tokens');
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
