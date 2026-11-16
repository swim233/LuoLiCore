import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCommonConfig, type CommonConfig, type Env } from '../shared/config.js';
import { parseTelegramConfig, type TelegramConfig } from '../telegram/config.js';

/** 网页服务的默认端口 */
export const defaultWebPort = 7310;

/** 助手的显示名默认值 */
export const defaultName = '洛璃';

/** 洛璃服务的配置：共用配置，加上两个前端各自开不开 */
export type ServerConfig = CommonConfig & {
  /**
   * 助手在网页面板上显示的名字：LUOLI_NAME，默认「洛璃」。只影响面板的显示（名字、消息里提到她时的高亮），
   * 不改人设，也不改发给模型的内容
   */
  name: string;
  /** Telegram 前端；没设 LUOLI_TELEGRAM_TOKEN 时为 undefined，不启动 Telegram */
  telegram?: TelegramConfig;
  /**
   * 网页服务；LUOLI_WEB=off 时为 undefined。
   * port：LUOLI_WEB_PORT，默认 7310。只监听 127.0.0.1。
   * dbPath：网页面板自己的状态（已读位置、网页会话的标题）存在这个 SQLite 文件里，LUOLI_WEB_DB，
   * 默认为数据库所在目录下的 web.db。
   * author：网页会话里发言人的名字，LUOLI_WEB_NAME（去掉首尾空白，空的按没设），默认系统用户名
   */
  web?: { port: number; dbPath: string; author: string };
  /**
   * 洛璃服务自己的 SQLite 文件（ADR-0014）：服务每天发了多少次请求，以后还有监视查到的动态。
   * LUOLI_FEEDS_DB，默认为数据库所在目录下的 feeds.db。一个服务都没装上时不打开
   */
  feedsDbPath: string;
};

/**
 * 解析洛璃服务的配置。模型取 LUOLI_MODEL；助手的显示名取 LUOLI_NAME（去掉首尾空白，空的按没设）；Telegram 的其余配置（白名单、唤醒词……）只在设了 token 时
 * 才检查，端口只在网页服务打开时才检查。两个前端都没开时报错。空字符串按未设置处理
 */
export function parseServerConfig(
  env: Env,
  { systemUser = systemUserName }: { systemUser?: () => string } = {},
): { ok: true; config: ServerConfig } | { ok: false; error: string } {
  const modelId = env.LUOLI_MODEL;
  if (!modelId) return { ok: false, error: '缺少模型：设置环境变量 LUOLI_MODEL' };
  const common = parseCommonConfig(env, modelId);
  if (!common.ok) return common;

  const web = parseWeb(env, common.config.dbPath, systemUser);
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
  const name = env.LUOLI_NAME?.trim() || defaultName;
  const feedsDbPath = env.LUOLI_FEEDS_DB || join(dirname(common.config.dbPath), 'feeds.db');
  return {
    ok: true,
    config: { ...common.config, name, telegram, web: web.config, feedsDbPath },
  };
}

function parseWeb(
  env: Env,
  dbPath: string,
  systemUser: () => string,
):
  | { ok: true; config?: { port: number; dbPath: string; author: string } }
  | { ok: false; error: string } {
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
  return {
    ok: true,
    config: {
      port,
      dbPath: env.LUOLI_WEB_DB || join(dirname(dbPath), 'web.db'),
      author: env.LUOLI_WEB_NAME?.trim() || systemUser(),
    },
  };
}

/** 系统用户名；取不到时（极少见）叫「网页」 */
function systemUserName(): string {
  try {
    return userInfo().username || '网页';
  } catch {
    return '网页';
  }
}
