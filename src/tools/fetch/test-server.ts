import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

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
