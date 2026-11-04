import { dirname, join } from 'node:path';
import type { ModelOptions, SegmentOptions } from '../core/index.js';

/** 各前端共用的配置：模型、重试、超时、步数上限、分段、数据库、文件目录、人设、请求记录 */
export type CommonConfig = {
  model: ModelOptions;
  /** 未设置时为 undefined，用核心的默认值 */
  maxRetries?: number;
  /**
   * 超时（毫秒）：首段、段间、一次回复的总时长、一次工具调用的默认时限。
   * 环境变量的单位是秒，未设置的项用核心的默认值
   */
  timeouts: { firstChunkMs?: number; chunkMs?: number; replyMs?: number; toolMs?: number };
  /** 一次回复最多几步（不小于 2），LUOLI_MAX_STEPS；未设置时为 undefined，用核心的默认值 */
  maxSteps?: number;
  /**
   * 以后的回复里，没有声明呈现方式的工具结果截短到这么多字符，LUOLI_TOOL_HISTORY_CHARS；
   * 未设置时为 undefined，用核心的默认值
   */
  toolHistoryChars?: number;
  /** 分段与摘要，未设置的项用核心的默认值 */
  segments: SegmentOptions;
  /** 数据库文件，LUOLI_DB，默认 data/luoli.db */
  dbPath: string;
  /** 图片等文件的目录，LUOLI_FILES_DIR，默认为数据库所在目录下的 files/ */
  filesDir: string;
  /** 人设文件，LUOLI_PROMPT；未设置时为 undefined，用仓库里的 prompts/system.md */
  promptPath?: string;
  /**
   * 请求记录（ADR-0008），默认打开；LUOLI_REQUEST_LOG=off 时为 undefined。
   * path：LUOLI_REQUESTS_DB，默认为数据库所在目录下的 requests.db；
   * retentionDays：LUOLI_REQUEST_LOG_DAYS，默认 30，0 为永久保留，最多 36500（约 100 年）
   */
  requestLog?: { path: string; retentionDays: number };
};

export type Env = Record<string, string | undefined>;

const maxTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000);
const maxRetentionDays = 36_500;

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
    ['replyMs', 'LUOLI_REPLY_TIMEOUT'],
    ['toolMs', 'LUOLI_TOOL_TIMEOUT'],
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

  let maxSteps: number | undefined;
  const rawSteps = env.LUOLI_MAX_STEPS;
  if (rawSteps) {
    maxSteps = Number(rawSteps);
    // 为 1 时第一步就是收尾步：模型一次工具都没调过，却被告知已到上限
    if (!(/^\d+$/.test(rawSteps) && maxSteps >= 2 && Number.isSafeInteger(maxSteps))) {
      return { ok: false, error: `LUOLI_MAX_STEPS 必须是不小于 2 的整数，当前为 "${rawSteps}"` };
    }
  }

  let toolHistoryChars: number | undefined;
  const rawChars = env.LUOLI_TOOL_HISTORY_CHARS;
  if (rawChars) {
    toolHistoryChars = Number(rawChars);
    if (!(
      /^\d+$/.test(rawChars) &&
      toolHistoryChars > 0 &&
      Number.isSafeInteger(toolHistoryChars)
    )) {
      return {
        ok: false,
        error: `LUOLI_TOOL_HISTORY_CHARS 必须是正整数，当前为 "${rawChars}"`,
      };
    }
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

  const switchValue = env.LUOLI_REQUEST_LOG;
  if (switchValue && switchValue !== 'off') {
    return {
      ok: false,
      error: `LUOLI_REQUEST_LOG 只能是 off（关闭请求记录；不设时打开），当前为 "${switchValue}"`,
    };
  }
  const rawDays = env.LUOLI_REQUEST_LOG_DAYS;
  const retentionDays = rawDays ? Number(rawDays) : 30;
  // 上限：清理时的截止时间要在 Date 的范围内，天数太大时算不出来
  if (rawDays && !(/^\d+$/.test(rawDays) && retentionDays <= maxRetentionDays)) {
    return {
      ok: false,
      error: `LUOLI_REQUEST_LOG_DAYS 必须是 0 到 ${maxRetentionDays} 之间的整数（0 为永久保留），当前为 "${rawDays}"`,
    };
  }

  const dbPath = env.LUOLI_DB || 'data/luoli.db';
  return {
    ok: true,
    config: {
      model: { baseURL, apiKey: env.LUOLI_API_KEY || undefined, modelId },
      maxRetries,
      timeouts,
      maxSteps,
      toolHistoryChars,
      segments,
      dbPath,
      filesDir: env.LUOLI_FILES_DIR || join(dirname(dbPath), 'files'),
      promptPath: env.LUOLI_PROMPT || undefined,
      requestLog:
        switchValue === 'off'
          ? undefined
          : {
              path: env.LUOLI_REQUESTS_DB || join(dirname(dbPath), 'requests.db'),
              retentionDays,
            },
    },
  };
}
