import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import type { Usage } from './message.js';

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

function reportsCacheRead(raw: LanguageModelUsage['raw']): boolean {
  // 没有原始用量（如测试用的 mock）时信任 SDK 给的值；有 openai 格式的原始用量时看它报没报
  if (raw === undefined || !('prompt_tokens' in raw)) return true;
  const details = raw.prompt_tokens_details;
  return (
    typeof details === 'object' &&
    details !== null &&
    'cached_tokens' in details &&
    typeof details.cached_tokens === 'number'
  );
}
