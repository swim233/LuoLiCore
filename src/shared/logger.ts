import { pino } from 'pino';

export const logFile = 'logs/luoli.log';

/**
 * 写 `logs/luoli.log` 的 JSON Lines 日志。写盘前抹掉 API key 与 secrets（如 bot token），
 * 每行带上服务的主机名。
 */
export function createLogger(
  { baseURL, apiKey }: { baseURL: string; apiKey?: string },
  secrets: string[] = [],
) {
  const keyForms = [apiKey, ...secrets]
    .filter((secret): secret is string => Boolean(secret))
    .flatMap(jsonEscapedForms)
    // 长的在前：一个秘密是另一个的一部分时，先整段替换
    .sort((a, b) => b.length - a.length);
  const logger = pino(
    {
      // 去掉默认的 hostname（本机名），免得与服务主机名 host 混淆
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        streamWrite: (line) => keyForms.reduce((text, form) => text.replaceAll(form, '***'), line),
      },
    },
    pino.destination({ dest: logFile, sync: true, mkdir: true }),
  );
  return logger.child({ host: new URL(baseURL).hostname });
}

/**
 * key 可能出现的几种形式：原文，以及逐层 JSON 转义后的形式。字段写进日志时转义一层；
 * 服务端在 message 或响应体里嵌 JSON 回显 key 时又多若干层。key 含 `"`、`\` 时
 * 每层都不同，这里取到三层：终端能覆盖嵌套三层，日志（多一层）覆盖嵌套两层。
 * 长的在前，免得短的先替换掉一部分。日志与终端共用。
 */
export function jsonEscapedForms(key: string): string[] {
  const forms = [key];
  for (let depth = 1; depth <= 3; depth++) forms.unshift(JSON.stringify(forms[0]).slice(1, -1));
  return [...new Set(forms)];
}
