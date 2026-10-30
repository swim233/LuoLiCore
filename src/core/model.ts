import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ModelOptions = {
  baseURL: string;
  apiKey?: string;
  modelId: string;
};

export function createModel({ baseURL, apiKey, modelId }: ModelOptions): LanguageModel {
  const provider = createOpenAICompatible({ name: 'openai-compatible', baseURL, apiKey });
  return provider(modelId);
}
