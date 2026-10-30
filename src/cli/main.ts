import { streamText } from 'ai';
import { createModel } from '../core/index.js';
import { parseConfig, usage } from './config.js';

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { model, prompt } = parsed.config;

let failure: unknown;
const result = streamText({
  model: createModel(model),
  prompt,
  // HTTP 错误、连不上、流中的服务端错误都走这里，textStream 只是安静地结束。
  // 不传 onError 时 SDK 默认把整个错误对象打到 stderr，所以这里只记下，最后统一打印。
  onError: ({ error }) => {
    failure ??= error;
  },
});

let wroteText = false;
try {
  for await (const text of result.textStream) {
    process.stdout.write(text);
    wroteText = true;
  }
} catch (error) {
  // 连接中途断开会直接从流里抛出，不经过 onError
  failure ??= error;
}
if (wroteText) process.stdout.write('\n');

if (failure !== undefined) {
  console.error(`模型调用失败（${model.modelId}）：${describeError(failure, model.apiKey)}`);
  process.exitCode = 1;
}

function describeError(error: unknown, apiKey: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  // 服务端报错可能回显请求里的 key，打印前抹掉
  return apiKey ? message.replaceAll(apiKey, '***') : message;
}
