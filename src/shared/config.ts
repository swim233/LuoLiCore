import { dirname, join } from 'node:path';
import type { ModelOptions, SegmentOptions } from '../core/index.js';

/** 各前端共用的配置：模型、重试、超时、分段、数据库、文件目录、人设 */
export type CommonConfig = {
  model: ModelOptions;
  /** 未设置时为 undefined，用核心的默认值 */
  maxRetries?: number;
  /** 首段与段间超时（毫秒），未设置的项用核心的默认值 */
  timeouts: { firstChunkMs?: number; chunkMs?: number };
  /** 分段与摘要，未设置的项用核心的默认值 */
  segments: SegmentOptions;
  /** 数据库文件，LUOLI_DB，默认 data/luoli.db */
  dbPath: string;
  /** 图片等文件的目录，LUOLI_FILES_DIR，默认为数据库所在目录下的 files/ */
  filesDir: string;
  /** 人设文件，LUOLI_PROMPT，默认 prompts/system.md */
  promptPath: string;
};

export type Env = Record<string, string | undefined>;

const maxTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000);

/** 解析共用配置。模型 id 由前端自己决定来源（命令行或环境变量）；空字符串按未设置处理 */
export function parseCommonConfig(
  env: Env,
  modelId: string,
): { ok: true; config: CommonConfig } | { ok: false; error: string } {
  const baseURL = env.LUOLI_BASE_URL;
  if (!baseURL) {
    return { ok: false, error: '缺少环境变量 LUOLI_BASE_URL' };
  }
  if (!URL.canParse(baseURL)) {
    return { ok: false, error: 'LUOLI_BASE_URL 不是合法的 URL' };
  }

  const rawRetries = env.LUOLI_MAX_RETRIES;
  const maxRetries = rawRetries ? Number(rawRetries) : undefined;
  if (rawRetries && !(/^\d+$/.test(rawRetries) && Number.isSafeInteger(maxRetries))) {
    return {
      ok: false,
      error: `LUOLI_MAX_RETRIES 必须是非负整数，当前为 "${rawRetries}"`,
    };
  }

  const timeouts: CommonConfig['timeouts'] = {};
  for (const [key, variable] of [
    ['firstChunkMs', 'LUOLI_FIRST_CHUNK_TIMEOUT'],
    ['chunkMs', 'LUOLI_CHUNK_TIMEOUT'],
  ] as const) {
    const raw = env[variable];
    if (!raw) continue;
    const seconds = Number(raw);
    // 上限来自 setTimeout：超过 2^31-1 毫秒会被当成 1 毫秒，立刻超时
    if (!(/^\d+$/.test(raw) && seconds > 0 && seconds <= maxTimeoutSeconds)) {
      return {
        ok: false,
        error: `${variable} 必须是 1 到 ${maxTimeoutSeconds} 之间的整数（秒），当前为 "${raw}"`,
      };
    }
    timeouts[key] = seconds * 1000;
  }

  const segments: SegmentOptions = {};
  for (const [key, variable, scale] of [
    ['idleMs', 'LUOLI_IDLE_MINUTES', 60_000],
    ['compressTokens', 'LUOLI_COMPRESS_TOKENS', 1],
    ['keepMessages', 'LUOLI_KEEP_MESSAGES', 1],
    ['summaryMaxChars', 'LUOLI_SUMMARY_MAX_CHARS', 1],
  ] as const) {
    const raw = env[variable];
    if (!raw) continue;
    const value = Number(raw) * scale;
    if (!(/^\d+$/.test(raw) && value > 0 && Number.isSafeInteger(value))) {
      return { ok: false, error: `${variable} 必须是正整数，当前为 "${raw}"` };
    }
    segments[key] = value;
  }

  const dbPath = env.LUOLI_DB || 'data/luoli.db';
  return {
    ok: true,
    config: {
      model: { baseURL, apiKey: env.LUOLI_API_KEY || undefined, modelId },
      maxRetries,
      timeouts,
      segments,
      dbPath,
      filesDir: env.LUOLI_FILES_DIR || join(dirname(dbPath), 'files'),
      promptPath: env.LUOLI_PROMPT || 'prompts/system.md',
    },
  };
}
