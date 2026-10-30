import { parseCommonConfig, type CommonConfig, type Env } from '../shared/config.js';

export type TelegramConfig = CommonConfig & {
  /** bot token，LUOLI_TELEGRAM_TOKEN。不得出现在任何输出与日志里 */
  token: string;
  /** 允许工作的群 id，LUOLI_TELEGRAM_CHATS */
  chats: ReadonlySet<string>;
  /** 允许私聊的用户 id，LUOLI_TELEGRAM_USERS */
  users: ReadonlySet<string>;
  /** 唤醒词，已转成小写，LUOLI_WAKE_WORDS，默认 nori */
  wakeWords: string[];
  /** 回复失败时发的提示，LUOLI_TELEGRAM_ERROR_TEXT */
  errorText: string;
  /**
   * 触发消息的发送时间早于这么久之前（毫秒）时只记录、不回复，如离线期间积压的消息。
   * LUOLI_TELEGRAM_STALE_MINUTES，单位分钟，默认 60
   */
  staleMs: number;
  /** Bot API 地址，LUOLI_TELEGRAM_API_URL，默认官方地址；测试时指向本地假接口 */
  apiUrl: string;
};

export const defaultErrorText = '（出了点问题，稍后再试）';

/** 解析 Telegram 前端的配置。空字符串按未设置处理；错误信息里不出现 token */
export function parseTelegramConfig(
  env: Env,
): { ok: true; config: TelegramConfig } | { ok: false; error: string } {
  const modelId = env.LUOLI_MODEL;
  if (!modelId) return { ok: false, error: '缺少模型：设置环境变量 LUOLI_MODEL' };
  const common = parseCommonConfig(env, modelId);
  if (!common.ok) return common;

  const token = env.LUOLI_TELEGRAM_TOKEN;
  if (!token) return { ok: false, error: '缺少环境变量 LUOLI_TELEGRAM_TOKEN' };
  // BotFather 给的格式：数字 id、冒号、一串字母数字。不合格式时不回显它
  if (!/^\d+:[\w-]+$/.test(token)) {
    return { ok: false, error: 'LUOLI_TELEGRAM_TOKEN 格式不对，应为「数字:字符串」' };
  }

  const chats = parseIds(env, 'LUOLI_TELEGRAM_CHATS');
  if (!chats.ok) return chats;
  const users = parseIds(env, 'LUOLI_TELEGRAM_USERS');
  if (!users.ok) return users;

  const wakeWords = (env.LUOLI_WAKE_WORDS || 'nori')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (wakeWords.length === 0) return { ok: false, error: 'LUOLI_WAKE_WORDS 里没有唤醒词' };

  const staleMinutes = env.LUOLI_TELEGRAM_STALE_MINUTES || '60';
  const staleMs = Number(staleMinutes) * 60_000;
  if (!(/^\d+$/.test(staleMinutes) && staleMs > 0 && Number.isSafeInteger(staleMs))) {
    // 不回显值：万一填错了位置，也不会把别的秘密打出来
    return { ok: false, error: 'LUOLI_TELEGRAM_STALE_MINUTES 必须是正整数（分钟）' };
  }

  const apiUrl = env.LUOLI_TELEGRAM_API_URL || 'https://api.telegram.org';
  if (!URL.canParse(apiUrl)) {
    return { ok: false, error: 'LUOLI_TELEGRAM_API_URL 不是合法的 URL' };
  }

  return {
    ok: true,
    config: {
      ...common.config,
      token,
      chats: chats.ids,
      users: users.ids,
      wakeWords,
      errorText: env.LUOLI_TELEGRAM_ERROR_TEXT || defaultErrorText,
      staleMs,
      apiUrl,
    },
  };
}

/** 逗号分隔的 Telegram id（群 id 为负数）；可以为空。出错时只说第几项，不回显内容 */
function parseIds(
  env: Env,
  variable: string,
): { ok: true; ids: Set<string> } | { ok: false; error: string } {
  const items = (env[variable] ?? '').split(',').map((item) => item.trim());
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item) continue;
    if (!/^-?\d+$/.test(item)) {
      return { ok: false, error: `${variable} 的第 ${index + 1} 项不是数字 id` };
    }
    // 规范成与 String(chat.id) 相同的写法（去掉前导零、-0）
    ids.add(BigInt(item).toString());
  }
  return { ok: true, ids };
}
