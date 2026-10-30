import { parseArgs } from 'node:util';
import type { ModelOptions } from '../core/index.js';

export type CliConfig = {
  model: ModelOptions;
  /** 发言人名字；未指定时为 undefined，由调用方取系统用户名 */
  name?: string;
  /** 未设置时为 undefined，用核心的默认值 */
  maxRetries?: number;
};

export type ConfigResult =
  { ok: true; config: CliConfig } | { ok: false; error: string; showUsage: boolean };

export const usage = '用法：pnpm dev [--model <模型 id>] [--name <名字>]';

// 空字符串按未设置处理；名字去掉首尾空白
export function parseConfig(argv: string[], env: Record<string, string | undefined>): ConfigResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { model: { type: 'string' }, name: { type: 'string' } },
      allowPositionals: false,
    });
  } catch (error) {
    return { ok: false, error: `参数错误：${(error as Error).message}`, showUsage: true };
  }

  const { values } = parsed;
  const modelId = values.model || env.LUOLI_MODEL;
  if (!modelId) {
    return {
      ok: false,
      error: '缺少模型：用 --model 指定，或设置环境变量 LUOLI_MODEL',
      showUsage: false,
    };
  }

  const baseURL = env.LUOLI_BASE_URL;
  if (!baseURL) {
    return { ok: false, error: '缺少环境变量 LUOLI_BASE_URL', showUsage: false };
  }
  if (!URL.canParse(baseURL)) {
    return { ok: false, error: 'LUOLI_BASE_URL 不是合法的 URL', showUsage: false };
  }

  const rawRetries = env.LUOLI_MAX_RETRIES;
  const maxRetries = rawRetries ? Number(rawRetries) : undefined;
  if (rawRetries && !(/^\d+$/.test(rawRetries) && Number.isSafeInteger(maxRetries))) {
    return {
      ok: false,
      error: `LUOLI_MAX_RETRIES 必须是非负整数，当前为 "${rawRetries}"`,
      showUsage: false,
    };
  }

  return {
    ok: true,
    config: {
      model: { baseURL, apiKey: env.LUOLI_API_KEY || undefined, modelId },
      name: values.name?.trim() || undefined,
      maxRetries,
    },
  };
}
