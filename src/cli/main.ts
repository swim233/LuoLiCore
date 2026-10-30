import { userInfo } from 'node:os';
import { createConversation, createModel, readInstructions } from '../core/index.js';
import { parseConfig, usage } from './config.js';

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { model, prompt } = parsed.config;

let instructions: string;
try {
  instructions = await readInstructions();
} catch (error) {
  console.error(`读取 system prompt 失败：${(error as Error).message}`);
  process.exit(1);
}

const conversation = createConversation({ model: createModel(model), instructions });
const { username } = userInfo();
await conversation.append({ author: { id: username, name: username }, text: prompt });

let failure: string | undefined;
let wroteText = false;
for await (const chunk of conversation.reply()) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta);
    wroteText = true;
  } else if (chunk.type === 'error') {
    failure ??= chunk.errorText;
  }
}
if (wroteText) process.stdout.write('\n');

if (failure !== undefined) {
  console.error(`模型调用失败（${model.modelId}）：${redactKey(failure, model.apiKey)}`);
  process.exitCode = 1;
}

// 服务端报错可能回显请求里的 key，打印前抹掉
function redactKey(message: string, apiKey: string | undefined): string {
  return apiKey ? message.replaceAll(apiKey, '***') : message;
}
