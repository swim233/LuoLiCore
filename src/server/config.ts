import { parseCommonConfig, type CommonConfig, type Env } from '../shared/config.js';
import { parseTelegramConfig, type TelegramConfig } from '../telegram/config.js';

/** 网页服务的默认端口 */
export const defaultWebPort = 7310;

/** 洛璃服务的配置：共用配置，加上两个前端各自开不开 */
export type ServerConfig = CommonConfig & {
  /** Telegram 前端；没设 LUOLI_TELEGRAM_TOKEN 时为 undefined，不启动 Telegram */
  telegram?: TelegramConfig;
  /**
   * 网页服务；LUOLI_WEB=off 时为 undefined。
   * port：LUOLI_WEB_PORT，默认 7310。只监听 127.0.0.1
   */
  web?: { port: number };
};

/**
 * 解析洛璃服务的配置。模型取 LUOLI_MODEL；Telegram 的其余配置（白名单、唤醒词……）只在设了 token 时
 * 才检查，端口只在网页服务打开时才检查。两个前端都没开时报错。空字符串按未设置处理
 */
export function parseServerConfig(
  env: Env,
): { ok: true; config: ServerConfig } | { ok: false; error: string } {
  const modelId = env.LUOLI_MODEL;
  if (!modelId) return { ok: false, error: '缺少模型：设置环境变量 LUOLI_MODEL' };
  const common = parseCommonConfig(env, modelId);
  if (!common.ok) return common;

  const web = parseWeb(env);
  if (!web.ok) return web;

  let telegram: TelegramConfig | undefined;
  if (env.LUOLI_TELEGRAM_TOKEN) {
    const parsed = parseTelegramConfig(env);
    if (!parsed.ok) return parsed;
    telegram = parsed.config;
  }

  if (!telegram && !web.config) {
    return { ok: false, error: 'Telegram 和网页都没有开，服务没有事可做' };
  }
  return { ok: true, config: { ...common.config, telegram, web: web.config } };
}

function parseWeb(
  env: Env,
): { ok: true; config?: { port: number } } | { ok: false; error: string } {
  const switchValue = env.LUOLI_WEB;
  if (switchValue === 'off') return { ok: true };
  if (switchValue) {
    return {
      ok: false,
      error: `LUOLI_WEB 只能是 off（关闭网页服务；不设时打开），当前为 "${switchValue}"`,
    };
  }
  const rawPort = env.LUOLI_WEB_PORT;
  const port = rawPort ? Number(rawPort) : defaultWebPort;
  if (rawPort && !(/^\d+$/.test(rawPort) && port >= 1 && port <= 65_535)) {
    return {
      ok: false,
      error: `LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "${rawPort}"`,
    };
  }
  return { ok: true, config: { port } };
}
