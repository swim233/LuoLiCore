import { userInfo } from 'node:os';
import { createConversation, createModel, readInstructions } from '../core/index.js';
import { parseConfig, usage } from './config.js';
import { createLogger, jsonEscapedForms, logFile } from './logger.js';

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { model, prompt, maxRetries } = parsed.config;

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
const { username } = userInfo();
await conversation.append({ author: { id: username, name: username }, text: prompt });

let failure: string | undefined;
let atLineStart = true;
for await (const chunk of conversation.reply()) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta);
    if (chunk.delta) atLineStart = chunk.delta.endsWith('\n');
  } else if (chunk.type === 'data-retry') {
    const { phase, attempt, maxRetries, statusCode } = chunk.data;
    if (phase === 'stream') {
      // 已输出的半截保留，另起一行再提示
      if (!atLineStart) process.stdout.write('\n');
      atLineStart = true;
      console.error(`输出中断，重新生成（${attempt}/${maxRetries}）`);
    } else {
      console.error(`请求失败（${statusCode ?? '网络错误'}），重试中（${attempt}/${maxRetries}）`);
    }
  } else if (chunk.type === 'error') {
    failure ??= chunk.errorText;
  }
}
if (!atLineStart) process.stdout.write('\n');

if (failure !== undefined) {
  console.error(
    `模型调用失败（${model.modelId}）：${redactKey(failure, model.apiKey)}（详见 ${logFile}）`,
  );
  process.exitCode = 1;
}

// 服务端报错可能回显请求里的 key（也可能嵌在 JSON 文本里），打印前抹掉
function redactKey(message: string, apiKey: string | undefined): string {
  if (!apiKey) return message;
  return jsonEscapedForms(apiKey).reduce((text, form) => text.replaceAll(form, '***'), message);
}
