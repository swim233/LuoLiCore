import { expect } from 'vitest';
import { ToolError, type Logger, type ToolDefinition } from '../../src/plugin-api.js';

// fetch 测试用的东西：本地 HTTP 服务（不访问外网）是通用的那一半，从插件测试的入口文件转出；
// 下面是 fetch 自己的那一半（记日志、像核心那样调用工具、拆开结果）
export {
  closeAll,
  ok,
  onClose,
  onlyLoopback,
  router,
  serve,
  status,
  type Handler,
  type TestServer,
} from '../../src/plugin-test-api.js';

export type Log = { level: string; fields: Record<string, unknown>; msg: string };

/** 把日志记进 logs */
export function recorder(logs: Log[]): Logger {
  const record =
    (level: string) =>
    (fields: object, msg: string): void => {
      logs.push({ level, fields: fields as Record<string, unknown>, msg });
    };
  return { info: record('info'), warn: record('warn'), error: record('error') };
}

/** 像核心那样调用工具：参数按结构解析，ctx 带上中止信号与日志 */
export function caller(tool: ToolDefinition, logs: Log[]) {
  return (input: Record<string, unknown>, signal = new AbortController().signal) =>
    Promise.resolve(
      tool.execute(tool.input.parse(input), {
        conversation: {},
        triggers: [],
        abortSignal: signal,
        logger: recorder(logs),
        env: {},
      }),
    ) as Promise<string>;
}

/** 拆开 fetch 的结果：头部各行、`名称：值` 的表、`---` 之后的正文 */
export function parseOutput(output: string) {
  const at = output.indexOf('\n---\n');
  const header = (at === -1 ? output : output.slice(0, at)).split('\n');
  const fields = Object.fromEntries(
    header.map((line) => [line.slice(0, line.indexOf('：')), line.slice(line.indexOf('：') + 1)]),
  );
  return { header, fields, body: at === -1 ? undefined : output.slice(at + 5) };
}

/** 等这次调用以 ToolError 结束，返回说明文字 */
export async function toolError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ToolError);
  return (error as ToolError).message;
}
