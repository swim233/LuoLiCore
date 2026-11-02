import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createModel,
  createPromptFiles,
  openFileStore,
  openSqliteStorage,
  type Storage,
} from '../core/index.js';
import { createLogger, jsonEscapedForms } from '../shared/logger.js';
import { setupTools } from '../shared/tools.js';
import { tools as toolList } from '../tools/index.js';
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

// 人设与内置提示文件：启动时读一遍并检查，有错就退出；之后每次回复、每次摘要开始时重读。
// 所有群共用这一个来源
const prompts = createPromptFiles({ personaPath: config.promptPath, logger });
try {
  await prompts.load();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// 工具清单：有误时退出；缺环境变量的不装，各提示一行。所有群共用装上的这一份
const installed = setupTools(toolList, process.env, {
  logger,
  report: (line) => console.error(line),
});
if (!installed.ok) {
  console.error(installed.error);
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
    prompts,
    tools: installed.tools,
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
