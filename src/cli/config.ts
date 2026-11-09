import { parseArgs } from 'node:util';

/** 环境变量（只读 LUOLI_WEB_PORT） */
export type Env = Record<string, string | undefined>;

export type CliConfig = {
  /** 发言人名字；未指定时为 undefined，由调用方取系统用户名 */
  name?: string;
  /** 接着上次的 CLI 会话，而不是新开一个 */
  resume: boolean;
  /** 洛璃服务的端口（LUOLI_WEB_PORT，默认 7310），只连 127.0.0.1 */
  port: number;
};

export type ConfigResult =
  { ok: true; config: CliConfig } | { ok: false; error: string; showUsage: boolean };

export const usage = '用法：pnpm cli [--name <名字>] [--resume]';

/** 洛璃服务的默认端口，与服务的 LUOLI_WEB_PORT 默认值相同 */
export const defaultPort = 7310;

/** 名字最多多少个字符：与服务对话接口里 author 的上限相同（src/server/chat.ts 的 maxAuthorChars） */
export const maxNameChars = 100;

/**
 * CLI 是洛璃服务的客户端，配置只有发言人名字、--resume 与服务的端口。模型、key 等都在服务那边，
 * 这里一概不读。空字符串按未设置处理；名字去掉首尾空白
 */
export function parseConfig(argv: string[], env: Env): ConfigResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        resume: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    return { ok: false, error: `参数错误：${(error as Error).message}`, showUsage: true };
  }

  const rawPort = env.LUOLI_WEB_PORT;
  const port = rawPort ? Number(rawPort) : defaultPort;
  if (rawPort && !(/^\d+$/.test(rawPort) && port >= 1 && port <= 65_535)) {
    return {
      ok: false,
      error: `LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "${rawPort}"`,
      showUsage: false,
    };
  }

  const { values } = parsed;
  const name = values.name?.trim() || undefined;
  // 服务收不下的名字，启动时就报，不等发第一句才「发送失败」
  if (name !== undefined && name.length > maxNameChars) {
    return {
      ok: false,
      error: `参数错误：--name 最多 ${maxNameChars} 个字符，现在是 ${name.length} 个`,
      showUsage: true,
    };
  }
  return { ok: true, config: { name, resume: values.resume, port } };
}
