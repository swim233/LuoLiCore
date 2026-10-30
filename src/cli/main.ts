import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { createConversation, createModel, readInstructions } from '../core/index.js';
import { parseConfig, usage } from './config.js';
import { createLogger, jsonEscapedForms, logFile } from './logger.js';
import { printReply } from './print-reply.js';

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { model, maxRetries } = parsed.config;
const name = parsed.config.name ?? userInfo().username;

let instructions: string;
try {
  instructions = await readInstructions();
} catch (error) {
  console.error(`读取 system prompt 失败：${(error as Error).message}`);
  process.exit(1);
}

const conversation = createConversation({
  model: createModel(model),
  instructions,
  logger: createLogger(model),
  maxRetries,
});
const author = { id: name, name };

// stdin 是管道时不按终端处理：没有行编辑、回显与提示符，读到 EOF 结束
const interactive = Boolean(process.stdin.isTTY);
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
  terminal: interactive,
});

// 读到 EOF 时 rl 立即 close，此时可能还有已读入、未处理的行（管道一次送来多行），
// 之后不能再调用 prompt()
let inputClosed = false;
rl.on('close', () => {
  inputClosed = true;
});

// 光标是否停在提示符后，决定退出时要不要补一个换行
let atPrompt = false;
function prompt(): void {
  if (!interactive || inputClosed) return;
  rl.prompt();
  atPrompt = true;
}

// 终端下 readline 开着 raw 模式，Ctrl+C 不产生 SIGINT 信号，而是由 readline 发出这个事件
let replying = false;
rl.on('SIGINT', () => {
  // 生成中：本步直接退出（第 6 步改为中止当前生成）。日志是同步写入的，退出不丢行
  if (replying) process.exit(130);
  rl.close();
});

// 迭代 rl 会缓存读到的行：回复期间到达的行不会丢
prompt();
for await (const line of rl) {
  atPrompt = false;
  const text = line.trim();
  if (text === '/exit') break;
  if (text) await converse(text);
  prompt();
}
rl.close();
// 空闲时按 Ctrl+C 或 Ctrl+D 退出，光标还停在提示符后
if (atPrompt) process.stdout.write('\n');

async function converse(text: string): Promise<void> {
  await conversation.append({ author, text });
  replying = true;
  const result = await printReply(conversation.reply());
  replying = false;
  if (!result.ok) {
    // 出错不退出：用户消息已留在历史里，继续下一轮
    console.error(
      `模型调用失败（${model.modelId}）：${redactKey(result.errorText, model.apiKey)}（详见 ${logFile}）`,
    );
  }
}

// 服务端报错可能回显请求里的 key（也可能嵌在 JSON 文本里），打印前抹掉
function redactKey(message: string, apiKey: string | undefined): string {
  if (!apiKey) return message;
  return jsonEscapedForms(apiKey).reduce((text, form) => text.replaceAll(form, '***'), message);
}
