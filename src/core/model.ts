import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

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
