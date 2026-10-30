import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  createConversation,
  createModel,
  openSqliteStorage,
  readInstructions,
  type Storage,
  type Usage,
} from '../core/index.js';
import { parseConfig, usage } from './config.js';
import { createLogger, jsonEscapedForms, logFile } from './logger.js';
import { notice } from './notice.js';
import { printReply } from './print-reply.js';
import { runTerminal } from './terminal.js';

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { model, maxRetries, resume, dbPath, promptPath } = parsed.config;
const name = parsed.config.name ?? userInfo().username;

let instructions: string;
try {
  instructions = await readInstructions(promptPath);
} catch (error) {
  console.error(`读取 system prompt 失败：${(error as Error).message}`);
  process.exit(1);
}

let storage: Storage;
try {
  mkdirSync(dirname(dbPath), { recursive: true });
  storage = openSqliteStorage(dbPath);
} catch (error) {
  console.error(`打开数据库失败（${dbPath}）：${(error as Error).message}`);
  process.exit(1);
}

const conversationId = await chooseConversation(storage, resume);
const conversation = createConversation({
  model: createModel(model),
  instructions,
  store: await storage.openConversation(conversationId),
  logger: createLogger(model),
  maxRetries,
  conversationId,
});
const author = { id: name, name };

if (process.stdin.isTTY) {
  await runTerminal(converse);
} else {
  // 管道输入：逐行按顺序处理，读到 EOF 结束；不显示提示符，不处理 Ctrl+C（按默认退出）。
  // 迭代 rl 会缓存读到的行：EOF 时 rl 立即关闭，已读入的行照常处理
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text) await converse(text);
  }
  rl.close();
}
storage.close();

// 默认每次新开会话；--resume 接着 CLI 平台里最后一条消息最新的会话
async function chooseConversation(storage: Storage, resume: boolean): Promise<string> {
  if (resume) {
    const latest = await storage.findLatestConversation('cli');
    if (latest) {
      const count = (await (await storage.openConversation(latest)).list()).length;
      notice(`接着上次的会话（${count} 条消息）`);
      return latest;
    }
    notice('没有之前的 CLI 会话，已新开一个');
  }
  return storage.createConversation({ platform: 'cli' });
}

async function converse(text: string, abortSignal?: AbortSignal): Promise<void> {
  await conversation.append({ author, text });
  const result = await printReply(conversation.reply({ abortSignal }));
  if (result.status === 'completed') {
    const line = result.usage && formatUsage(result.usage);
    if (line) notice(line);
  } else if (result.status === 'aborted') {
    notice('（已中止）');
  } else {
    // 出错不退出：用户消息已留在历史里，继续下一轮
    console.error(
      `模型调用失败（${model.modelId}）：${redactKey(result.errorText, model.apiKey)}（详见 ${logFile}）`,
    );
  }
}

// tokens 输入 1234（缓存 1000）· 输出 567。服务端报了缓存数才显示括号；
// 输入、输出都没报时不打印，只缺一个时那个数显示 ?
function formatUsage({ input, output, cacheRead }: Usage): string | undefined {
  if (input === undefined && output === undefined) return undefined;
  const cache = cacheRead === undefined ? ' ' : `（缓存 ${cacheRead}）`;
  return `tokens 输入 ${input ?? '?'}${cache}· 输出 ${output ?? '?'}`;
}

// 服务端报错可能回显请求里的 key（也可能嵌在 JSON 文本里），打印前抹掉
function redactKey(message: string, apiKey: string | undefined): string {
  if (!apiKey) return message;
  return jsonEscapedForms(apiKey).reduce((text, form) => text.replaceAll(form, '***'), message);
}
