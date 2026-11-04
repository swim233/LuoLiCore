import { pino } from 'pino';
import { createRedactor } from '../core/index.js';

export { jsonEscapedForms } from '../core/index.js';

export const logFile = 'logs/luoli.log';

/**
 * 写 `logs/luoli.log` 的 JSON Lines 日志。写盘前抹掉 API key 与 secrets（如 bot token），
 * 每行带上服务的主机名。
 */
export function createLogger(
  { baseURL, apiKey }: { baseURL: string; apiKey?: string },
  secrets: string[] = [],
) {
  const redact = createRedactor([apiKey, ...secrets]);
  const logger = pino(
    {
      // 去掉默认的 hostname（本机名），免得与服务主机名 host 混淆
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        streamWrite: redact,
      },
    },
    pino.destination({ dest: logFile, sync: true, mkdir: true }),
  );
  return logger.child({ host: new URL(baseURL).hostname });
}
