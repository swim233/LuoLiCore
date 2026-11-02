import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { expect } from 'vitest';
import { ToolError, type Logger, type ToolDefinition } from '../../core/index.js';

// fetch 测试用的本地 HTTP 服务（不访问外网）

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export type TestServer = {
  origin: string;
  port: number;
  /** 收到的请求，按顺序 */
  requests: Array<{ path: string; headers: IncomingHttpHeaders }>;
  /** 收到的连接 */
  sockets: Socket[];
};

const closers: Array<() => Promise<void>> = [];

/** 测试结束时要关掉的东西（请求器等）；closeAll 时一并关闭 */
export function onClose(close: () => Promise<void>): void {
  closers.push(close);
}

/** 关掉这个测试里起的服务与登记的东西，在 afterEach 里调用 */
export async function closeAll(): Promise<void> {
  for (const close of closers.splice(0)) await close();
}

/** 起一个服务，记下收到的连接与请求，由 handler 决定怎么回 */
export async function serve(handler: Handler, host = '127.0.0.1'): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const sockets: Socket[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? '', headers: request.headers });
    handler(request, response);
  });
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  onClose(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return { origin, port, requests, sockets };
}

/** 回 200 和正文 */
export const ok =
  (body: string | Buffer, headers: Record<string, string> = {}): Handler =>
  (_request, response) => {
    response.writeHead(200, headers);
    response.end(body);
  };

/** 测试里只放行 127.0.0.1，其余照默认范围拦（127.0.0.2、::1 都拦） */
export const onlyLoopback = (address: string) => address !== '127.0.0.1';

/** 按路径（不含查询串）分派；没有的路径回 404 */
export function router(routes: Record<string, Handler>): Handler {
  return (request, response) => {
    const route = routes[new URL(request.url ?? '/', 'http://localhost').pathname];
    if (route) return route(request, response);
    response.writeHead(404);
    response.end('没有这个页面');
  };
}

/** 只回状态码与响应头 */
export const status =
  (code: number, headers: Record<string, string> = {}): Handler =>
  (_request, response) => {
    response.writeHead(code, headers);
    response.end();
  };

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
