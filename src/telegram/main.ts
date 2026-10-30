import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createModel,
  openFileStore,
  openSqliteStorage,
  readInstructions,
  type Storage,
} from '../core/index.js';
import { createLogger, jsonEscapedForms } from '../shared/logger.js';
import { startTelegram } from './app.js';
import { parseTelegramConfig } from './config.js';

const parsed = parseTelegramConfig(process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { config } = parsed;
// token 与 API key 写进日志前都会被抹掉；打到终端的错误同样先抹一遍
const logger = createLogger(config.model, [config.token]);
const redact = (text: string) =>
  [config.token, config.model.apiKey]
    .filter((secret): secret is string => Boolean(secret))
    .flatMap(jsonEscapedForms)
    .reduce((result, form) => result.replaceAll(form, '***'), text);

let instructions: string;
try {
  instructions = await readInstructions(config.promptPath);
} catch (error) {
  console.error(`读取 system prompt 失败：${(error as Error).message}`);
  process.exit(1);
}

let storage: Storage;
try {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  storage = openSqliteStorage(config.dbPath);
} catch (error) {
  console.error(`打开数据库失败（${config.dbPath}）：${(error as Error).message}`);
  process.exit(1);
}

let app: Awaited<ReturnType<typeof startTelegram>>;
try {
  app = await startTelegram({
    config,
    model: createModel(config.model),
    instructions,
    storage,
    fileStore: openFileStore(config.filesDir),
    logger,
  });
} catch (error) {
  console.error(redact(`启动失败：${(error as Error).message}`));
  storage.close();
  process.exit(1);
}
console.log('Telegram bot 已启动，按 Ctrl+C 退出');

let stopping = false;
const stop = async () => {
  // 第二次按 Ctrl+C 时直接退出
  if (stopping) process.exit(1);
  stopping = true;
  console.log('正在退出……');
  await app.stop();
  storage.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
