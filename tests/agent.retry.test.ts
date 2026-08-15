import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { fallbackLanguageModel } from '@luoli/core';

function model(id: string, run: () => unknown): Exclude<LanguageModel, string> & { specificationVersion: 'v4' } {
  return { specificationVersion: 'v4', provider: 'test', modelId: id, supportedUrls: {}, doGenerate: async () => run() as never, doStream: async () => run() as never };
}

const params = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }], maxOutputTokens: 10, temperature: undefined, stopSequences: undefined, topP: undefined, topK: undefined, presencePenalty: undefined, frequencyPenalty: undefined, seed: undefined, responseFormat: undefined, tools: undefined, toolChoice: undefined, providerOptions: undefined, abortSignal: undefined, headers: undefined, reasoning: undefined, includeRawChunks: false } as never;

describe('model-level provider fallback', () => {
  it('retries and falls back inside one model call', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const success = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    const wrapped = fallbackLanguageModel([
      { id: 'first', model: model('first', () => { firstCalls += 1; throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'second', model: model('second', () => { secondCalls += 1; return success; }) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1 });
    const result = await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(result.content).toEqual(success.content);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  // AI SDK 把步骤级失败吞进内部 onError，让 result.text 安静地解析成空串。不在链耗尽时抓一份，
  // 一次彻底的上游故障和「模型没话说」在调用方眼里就一模一样 —— 用户看到的是 bot 不回复。
  it('reports the last error when the whole chain is exhausted', async () => {
    const seen: unknown[] = [];
    const wrapped = fallbackLanguageModel([
      { id: 'first', model: model('first', () => { throw Object.assign(new Error('bad gateway'), { statusCode: 502 }); }) },
      { id: 'second', model: model('second', () => { throw Object.assign(new Error('still bad'), { statusCode: 502 }); }) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, onExhausted: (error) => seen.push(error) });
    await expect((wrapped as Exclude<LanguageModel, string>).doStream(params)).rejects.toThrow('still bad');
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('still bad');
  });

  it('does not report when a later candidate succeeds', async () => {
    const seen: unknown[] = [];
    const success = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    const wrapped = fallbackLanguageModel([
      { id: 'first', model: model('first', () => { throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'second', model: model('second', () => success) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, onExhausted: (error) => seen.push(error) });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(seen).toHaveLength(0);
  });

  it('degrades invalid credentials without retrying or falling back', async () => {
    let invalidCalls = 0;
    let healthyCalls = 0;
    let unavailable = '';
    const wrapped = fallbackLanguageModel([
      { id: 'invalid', model: model('invalid', () => { invalidCalls += 1; throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); }) },
      { id: 'healthy', model: model('healthy', () => { healthyCalls += 1; return {}; }) },
    ], { maxRetries: 3, retryBaseMs: 1, retryMaxMs: 1, onUnavailable: (candidate) => { unavailable = candidate.id; } });
    await expect((wrapped as Exclude<LanguageModel, string>).doGenerate(params)).rejects.toThrow('unauthorized');
    expect(invalidCalls).toBe(1);
    expect(healthyCalls).toBe(0);
    expect(unavailable).toBe('invalid');
  });
});
