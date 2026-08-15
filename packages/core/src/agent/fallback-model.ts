import { retryDelay } from '../provider/store.js';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
type V4LanguageModel = Exclude<LanguageModel, string> & { specificationVersion: 'v4' };
import { wrapLanguageModel } from 'ai';

export interface FallbackCandidate {
  model: V4LanguageModel;
  id: string;
}

interface FallbackOptions {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  abortSignal?: AbortSignal;
  onFallback?: (from: FallbackCandidate, to: FallbackCandidate) => void;
  onUnavailable?: (candidate: FallbackCandidate, error: unknown) => void;
}

function statusCode(error: unknown): number | null {
  return error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
}

function retryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  if ('responseHeaders' in error && error.responseHeaders && typeof error.responseHeaders === 'object') {
    const value = (error.responseHeaders as Record<string, unknown>)['retry-after'];
    if (typeof value === 'string') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
  }
  return null;
}

function retriable(error: unknown): boolean {
  const status = statusCode(error);
  return status === null || status === 429 || status >= 500;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

export function fallbackLanguageModel(candidates: FallbackCandidate[], options: FallbackOptions): LanguageModel {
  const [first] = candidates;
  if (!first) throw new Error('fallback chain is empty');
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ params }) => {
      let last: unknown;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const model = candidate.model;
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          try { return await model.doGenerate(params) as Awaited<ReturnType<V4LanguageModel['doGenerate']>>; }
          catch (error) {
            last = error;
            const status = statusCode(error);
            if (status === 401 || status === 403) { options.onUnavailable?.(candidate, error); throw error; }
            if (!retriable(error)) throw error;
            if (attempt < options.maxRetries) await pause(retryDelay(attempt, retryAfter(error), options.retryBaseMs, options.retryMaxMs), options.abortSignal);
          }
        }
        const next = candidates[index + 1];
        if (next) options.onFallback?.(candidate, next);
      }
      throw last ?? new Error('all providers unavailable');
    },
    wrapStream: async ({ params }) => {
      let last: unknown;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const model = candidate.model;
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          try { return await model.doStream(params) as Awaited<ReturnType<V4LanguageModel['doStream']>>; }
          catch (error) {
            last = error;
            const status = statusCode(error);
            if (status === 401 || status === 403) { options.onUnavailable?.(candidate, error); throw error; }
            if (!retriable(error)) throw error;
            if (attempt < options.maxRetries) await pause(retryDelay(attempt, retryAfter(error), options.retryBaseMs, options.retryMaxMs), options.abortSignal);
          }
        }
        const next = candidates[index + 1];
        if (next) options.onFallback?.(candidate, next);
      }
      throw last ?? new Error('all providers unavailable');
    },
  };
  return wrapLanguageModel({ model: first.model, middleware });
}
