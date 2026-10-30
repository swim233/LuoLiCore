import { parseArgs } from 'node:util';
import { parseCommonConfig, type CommonConfig, type Env } from '../shared/config.js';

export type CliConfig = CommonConfig & {
  /** 发言人名字；未指定时为 undefined，由调用方取系统用户名 */
  name?: string;
  /** 接着上次的 CLI 会话，而不是新开一个 */
  resume: boolean;
};

export type ConfigResult =
  { ok: true; config: CliConfig } | { ok: false; error: string; showUsage: boolean };

export const usage = '用法：pnpm dev [--model <模型 id>] [--name <名字>] [--resume]';

// 空字符串按未设置处理；名字去掉首尾空白
export function parseConfig(argv: string[], env: Env): ConfigResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        model: { type: 'string' },
        name: { type: 'string' },
        resume: { type: 'boolean', default: false },
      },
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

  const common = parseCommonConfig(env, modelId);
  if (!common.ok) return { ok: false, error: common.error, showUsage: false };
  return {
    ok: true,
    config: {
      ...common.config,
      name: values.name?.trim() || undefined,
      resume: values.resume,
    },
  };
}
