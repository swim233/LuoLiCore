import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { createConversation, createModel, readInstructions } from '../core/index.js';
import { parseConfig, usage } from './config.js';
import { createLogger, jsonEscapedForms, logFile } from './logger.js';
import { printReply } from './print-reply.js';
import { runTerminal } from './terminal.js';

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

async function converse(text: string, abortSignal?: AbortSignal): Promise<void> {
  await conversation.append({ author, text });
  const result = await printReply(conversation.reply({ abortSignal }));
  if (result.status === 'aborted') {
    console.error('（已中止）');
  } else if (result.status === 'failed') {
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
