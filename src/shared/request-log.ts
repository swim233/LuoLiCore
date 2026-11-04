import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createRequestRecorder,
  openRequestLog,
  startRequestLogCleanup,
  type FileStore,
  type Logger,
} from '../core/index.js';
import type { CommonConfig } from './config.js';

export type RequestLogging = {
  /** 交给 createModel 的 fetch；关闭请求记录时为 undefined（provider 用全局的 fetch） */
  fetch?: typeof globalThis.fetch;
  /** 退出时调用：等已经开始的写入完成，停止定时清理，关闭数据库 */
  close(): Promise<void>;
};

/**
 * 按配置打开请求记录（ADR-0008）：建目录、打开数据库、包住 provider 的 fetch，保留天数不为 0 时
 * 立即清理一次、之后每天一次。关闭时什么也不打开。日志记一条 requests.open。
 * 打开失败时抛错，消息里带着数据库路径
 */
export function openRequestLogging({
  config,
  fileStore,
  logger,
  secrets,
  fetch,
}: {
  config: CommonConfig['requestLog'];
  /** 会话用的文件存储：请求里的图片对上它的就只存引用 */
  fileStore: FileStore;
  logger: Logger;
  /** 出现在错误内容里时抹掉的秘密（API key 等），与日志相同 */
  secrets: ReadonlyArray<string | undefined>;
  /** 实际发请求的 fetch，默认全局的；测试用 */
  fetch?: typeof globalThis.fetch;
}): RequestLogging {
  if (!config) {
    logger.info({ enabled: false }, 'requests.open');
    return { async close() {} };
  }
  const { path, retentionDays } = config;
  let log;
  try {
    mkdirSync(dirname(path), { recursive: true });
    log = openRequestLog({ path, fileStore, retentionDays });
  } catch (error) {
    throw new Error(`打开请求记录失败（${path}）：${(error as Error).message}`, { cause: error });
  }
  logger.info({ enabled: true, retentionDays, path }, 'requests.open');
  const recorder = createRequestRecorder({ log, logger, secrets, fetch });
  const cleanup = retentionDays > 0 ? startRequestLogCleanup(log, { logger }) : undefined;
  return {
    fetch: recorder.fetch,
    async close() {
      await recorder.flush();
      await cleanup?.stop();
      log.close();
    },
  };
}
