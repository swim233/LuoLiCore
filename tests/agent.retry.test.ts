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

  // 上游不设超时时这一步可以永远不返回，而 AI SDK 不管、fetch 默认也不管：唯一兜底是 10 分钟的
  // turnTimeoutMs。日志里那 7 轮「只有 turn.start 没有 turn.end」的最后一条都停在这里
  // （fallback → model.error 的 62 秒节拍走完两遍，第三遍再没回来）。
  it('bounds a single attempt and keeps retrying the rest of the chain', async () => {
    let stalledCalls = 0;
    const wrapped = fallbackLanguageModel([
      { id: 'stalled', model: model('stalled', () => new Promise(() => undefined)) },
      { id: 'healthy', model: model('healthy', () => { stalledCalls += 1; return {}; }) },
    ], { maxRetries: 1, retryBaseMs: 1, retryMaxMs: 1, requestTimeoutMs: 60 });
    const started = Date.now();
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    // 两次尝试 × 60ms 之后换第二个候选，而不是挂在第一个上面等到轮次超时。
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stalledCalls).toBe(1);
  });

  it('reports a stream that connects and then never speaks, instead of hanging', async () => {
    const seen: unknown[] = [];
    const wrapped = fallbackLanguageModel([
      { id: 'silent', model: model('silent', () => ({ stream: new ReadableStream({ start: () => undefined }) })) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, streamIdleTimeoutMs: 60, onExhausted: (error) => seen.push(error) });
    const result = await (wrapped as Exclude<LanguageModel, string>).doStream(params);
    await expect(result.stream.getReader().read()).rejects.toThrow('stream_idle_timeout_60ms');
    expect((seen[0] as Error).message).toBe('stream_idle_timeout_60ms');
  });

  it('passes chunks through untouched while the provider keeps talking', async () => {
    const parts = [{ type: 'text-delta', id: '1', delta: 'a' }, { type: 'text-delta', id: '1', delta: 'b' }];
    const wrapped = fallbackLanguageModel([
      { id: 'chatty', model: model('chatty', () => ({ stream: new ReadableStream({ start: (controller) => { for (const part of parts) controller.enqueue(part); controller.close(); } }) })) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, streamIdleTimeoutMs: 60 });
    const result = await (wrapped as Exclude<LanguageModel, string>).doStream(params);
    const seen: unknown[] = [];
    for await (const part of result.stream as unknown as AsyncIterable<unknown>) seen.push(part);
    expect(seen).toEqual(parts);
  });

  // 轮次被取消（/cancel、turnTimeoutMs）之后重试就是替一个没人等的轮次占着并发槽与配额。
  it('does not retry or fall back once the caller aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    const wrapped = fallbackLanguageModel([
      { id: 'first', model: model('first', () => { calls += 1; controller.abort(new Error('cancelled')); throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'second', model: model('second', () => { calls += 1; return {}; }) },
    ], { maxRetries: 3, retryBaseMs: 1, retryMaxMs: 1 });
    await expect((wrapped as Exclude<LanguageModel, string>).doGenerate({ ...params as object, abortSignal: controller.signal } as never)).rejects.toThrow('busy');
    expect(calls).toBe(1);
  });

  // 那 363 秒里日志一行都没有：只有开头的 turn.start 与结尾的 provider.fallback，中间要靠
  // `3 × requestTimeoutMs + 退避` 的算术反推（docs/10 早就给 model.error 定了 retryAttempt /
  // willFallback 两个字段）。也是「只有超时计入连续失败」那条判据的输入。
  it('reports every failed attempt with the retry/fallback decision attached', async () => {
    const seen: Array<{ id: string; kind: string; attempt: number; willRetry: boolean; willFallback: boolean }> = [];
    const wrapped = fallbackLanguageModel([
      { id: 'stalled', model: model('stalled', () => new Promise(() => undefined)) },
      { id: 'healthy', model: model('healthy', () => ({})) },
    ], { maxRetries: 1, retryBaseMs: 1, retryMaxMs: 1, requestTimeoutMs: 40,
      onCandidateFailed: (candidate, failure) => seen.push({ id: candidate.id, kind: failure.kind, attempt: failure.attempt, willRetry: failure.willRetry, willFallback: failure.willFallback }) });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(seen).toEqual([
      { id: 'stalled', kind: 'timeout', attempt: 0, willRetry: true, willFallback: false },
      { id: 'stalled', kind: 'timeout', attempt: 1, willRetry: false, willFallback: true },
    ]);
  });

  it('separates a talking-but-broken upstream from a black hole', async () => {
    const kinds: string[] = [];
    const wrapped = fallbackLanguageModel([
      { id: 'busy', model: model('busy', () => { throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'healthy', model: model('healthy', () => ({})) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, onCandidateFailed: (_candidate, failure) => kinds.push(failure.kind) });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(kinds).toEqual(['status']);
  });

  // 判成 down 的候选要在**这一次调用**就被跳过，不能等下一次 rebuild：一轮 12 步，每步重新熬满
  // 一遍超时预算就是本次事故里那个「每轮只走得完一步」。
  it('skips a candidate already marked down without spending an attempt on it', async () => {
    let deadCalls = 0;
    let healthyCalls = 0;
    const wrapped = fallbackLanguageModel([
      { id: 'dead', rowId: 'r-dead', model: model('dead', () => { deadCalls += 1; return {}; }) },
      { id: 'healthy', rowId: 'r-healthy', model: model('healthy', () => { healthyCalls += 1; return {}; }) },
    ], { maxRetries: 2, retryBaseMs: 1, retryMaxMs: 1, isDown: (candidate) => candidate.rowId === 'r-dead' });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(deadCalls).toBe(0);
    expect(healthyCalls).toBe(1);
  });

  /**
   * 跳过要留痕，而且 `provider.fallback` 的 `to` 必须是**真正会被试的**那个：报数组里的下一个时
   * 日志写着「A → B」而实际服务的是 C，比不报更误导人（docs/10 · provider.fallback）。
   * 两个中间件分支的这段代码是同构的，测 `doGenerate` 这一路。
   */
  it('names the candidate that will actually be tried and reports the skipped one', async () => {
    const skipped: Array<[string, string | undefined]> = [];
    const fell: Array<[string, string]> = [];
    let served = '';
    const wrapped = fallbackLanguageModel([
      { id: 'busy', rowId: 'r-busy', model: model('busy', () => { throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'dead', rowId: 'r-dead', model: model('dead', () => { throw new Error('never reached'); }) },
      { id: 'healthy', rowId: 'r-healthy', model: model('healthy', () => ({})) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, isDown: (candidate) => candidate.rowId === 'r-dead',
      onSkipped: (candidate, next) => skipped.push([candidate.id, next?.id]),
      onFallback: (from, to) => fell.push([from.id, to.id]),
      onServed: (candidate) => { served = candidate.id; } });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(fell).toEqual([['busy', 'healthy']]);
    expect(skipped).toEqual([['dead', 'healthy']]);
    expect(served).toBe('healthy');
  });

  // 全链都 down 时宁可发一次注定失败的请求：一个都不发，调用方拿到的是「模型没话说」而不是故障。
  it('still calls the last candidate when the whole chain is marked down', async () => {
    let lastCalls = 0;
    const wrapped = fallbackLanguageModel([
      { id: 'dead', model: model('dead', () => { throw new Error('never reached'); }) },
      { id: 'also-dead', model: model('also-dead', () => { lastCalls += 1; return {}; }) },
    ], { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, isDown: () => true });
    await (wrapped as Exclude<LanguageModel, string>).doGenerate(params);
    expect(lastCalls).toBe(1);
  });

  // 轮次超时（`TurnRegistry` 的 `controller.abort('timeout')`）在日志里也是一条 timeout，但那不是
  // provider 的故障 —— 报上去会把健康的 provider 一路推到 down。
  it('does not blame the provider for the caller aborting', async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    const wrapped = fallbackLanguageModel([
      { id: 'first', model: model('first', () => { controller.abort('timeout'); throw Object.assign(new Error('busy'), { statusCode: 503 }); }) },
      { id: 'second', model: model('second', () => ({})) },
    ], { maxRetries: 3, retryBaseMs: 1, retryMaxMs: 1, onCandidateFailed: (candidate) => seen.push(candidate.id) });
    await expect((wrapped as Exclude<LanguageModel, string>).doGenerate({ ...params as object, abortSignal: controller.signal } as never)).rejects.toThrow('busy');
    expect(seen).toEqual([]);
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
