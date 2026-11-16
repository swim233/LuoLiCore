import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { Agent, buildConnector, type Dispatcher } from 'undici';
import { isBlockedAddress } from './address.js';
import { decodeText, decompressed, mimeTypeOf, readCapped } from './body.js';

// 安全请求：fetch 的所有请求（网页、站点接口、r.jina.ai）都经过这一层（ADR-0007「安全」）。
// 不写日志，出错信息里不带 URL

/** 默认依次用的 User-Agent：先用 curl 与自报身份的 bot，被拒再换成桌面 Chrome */
export const defaultUserAgents = [
  'curl/8.0',
  'Mozilla/5.0 (compatible; LuoLiBot/1.0)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
];

// 调用方可以覆盖或追加。User-Agent 不在这里：由轮换或调用方的 userAgent 决定
const defaultHeaders = {
  accept: 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
};

const maxRedirects = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
// 多半是冲着 User-Agent 来的拒绝，换一个再试
const rejectedStatuses = new Set([403, 429, 503]);
const defaultMaxBytes = 5 * 1024 * 1024;
// 429 没给 Retry-After（或看不懂）时等多久
const defaultRetryWaitMs = 1000;

export type FetchErrorKind =
  | 'invalid-url' // 网址（或跳转地址）解析不了
  | 'protocol' // 不是 http、https
  | 'blocked' // 要连的是内网地址
  | 'redirects' // 跳转超过 5 次
  | 'network' // 连接、TLS、解压等出错；默认 User-Agent 都试过之后才抛
  | 'timeout' // 调用方给的时限到了
  | 'aborted'; // 调用方的中止信号

/** 这一层抛出的错误都是它。HTTP 非 2xx 不算错误，作为结果返回 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  constructor(kind: FetchErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FetchError';
    this.kind = kind;
  }
}

export type RequesterOptions = {
  /** 地址是否拦截；默认 isBlockedAddress。测试里换成放行本机地址的 */
  isBlocked?: (address: string) => boolean;
  /** 429 时按 Retry-After 最多等多久（毫秒），默认 10 秒 */
  maxRetryWaitMs?: number;
};

export type GetOptions = {
  /** 指定 User-Agent（站点接口、r.jina.ai）：只发一次，不轮换，429 也不等待重发 */
  userAgent?: string;
  /** 追加或覆盖默认请求头，不分大小写 */
  headers?: Record<string, string>;
  /** 外部的中止信号，如工具的 ctx.abortSignal */
  signal?: AbortSignal;
  /** 这次请求的时限（毫秒），到读完正文为止，含轮换与等待；与 signal 任一触发都中止 */
  timeoutMs?: number;
};

export type ReadOptions = {
  /** 最多读多少字节，默认 5 MB；读到上限就停，truncated 为真 */
  maxBytes?: number;
};

/** 一次请求的结果。拿到时只收到了响应头；正文由调用方选一种方式处理，只能处理一次 */
export type FetchResponse = {
  status: number;
  /** 跳转后的最终 URL */
  url: string;
  /** 跳转了几次 */
  redirects: number;
  headers: Headers;
  /** Content-Type 的类型部分，小写，如 `text/html`；没写时为 undefined */
  mimeType: string | undefined;
  /** 拿到这个结果用的 User-Agent */
  userAgent: string;
  /** 默认的 User-Agent 都试过，仍被拒（403、429、503）。调用方指定 User-Agent 时总为 false */
  rejected: boolean;
  /** 读成文字，字符集见 decodeText；charset 是实际用的编码 */
  text(options?: ReadOptions): Promise<{ text: string; truncated: boolean; charset: string }>;
  bytes(options?: ReadOptions): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  /** 不读正文，释放连接 */
  discard(): Promise<void>;
};

export type Requester = {
  /** GET 一个 http、https 网址。HTTP 非 2xx 不抛错；其余失败抛 FetchError */
  get(url: string | URL, options?: GetOptions): Promise<FetchResponse>;
  /** 关闭连接池，进行中的请求一并中止；之后不能再用 */
  close(): Promise<void>;
};

type Hop = { url: URL; redirects: number; response: Dispatcher.ResponseData };

/** 创建一个请求器。连接池属于这个请求器，互不影响 */
export function createRequester({
  isBlocked = isBlockedAddress,
  maxRetryWaitMs = 10_000,
}: RequesterOptions = {}): Requester {
  const agent = new Agent({ connect: safeConnector(isBlocked) });

  // 用一个 User-Agent 发请求并跟随跳转；每次跳转的连接同样经过 safeConnector
  async function follow(url: URL, headers: Record<string, string>, signal?: AbortSignal) {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const response = await agent.request({
        origin: current.origin,
        path: current.pathname + current.search,
        method: 'GET',
        headers,
        signal,
      });
      const location = redirectStatuses.has(response.statusCode)
        ? first(response.headers.location)
        : undefined;
      if (location === undefined) return { url: current, redirects, response };
      await response.body.dump();
      if (redirects === maxRedirects) throw new FetchError('redirects', '跳转次数过多');
      current = parseUrl(location, current);
    }
  }

  return {
    async get(input, options = {}) {
      const url = parseUrl(input);
      const { signal, fail } = abortControl(options);
      const send = (userAgent: string) =>
        follow(url, requestHeaders(options.headers, userAgent), signal);
      const respond = (hop: Hop, userAgent: string, rejected: boolean) =>
        toFetchResponse(hop, userAgent, rejected, fail);
      try {
        if (options.userAgent !== undefined) {
          return respond(await send(options.userAgent), options.userAgent, false);
        }
        // 前几个：被拒或网络错误就换下一个
        for (const userAgent of defaultUserAgents.slice(0, -1)) {
          try {
            const hop = await send(userAgent);
            if (!rejectedStatuses.has(hop.response.statusCode)) {
              return respond(hop, userAgent, false);
            }
            await hop.response.body.dump();
          } catch (error) {
            // 内网地址、跳转出错、中止与超时换 User-Agent 也没用，直接结束
            if (error instanceof FetchError || signal?.aborted) throw error;
          }
        }
        // 最后一个：429 时按 Retry-After 等一会儿，用同一个再发一次
        const userAgent = defaultUserAgents.at(-1)!;
        let hop = await send(userAgent);
        if (hop.response.statusCode === 429) {
          const waitMs = retryAfterMs(first(hop.response.headers['retry-after']));
          await hop.response.body.dump();
          await delay(Math.min(waitMs, maxRetryWaitMs), undefined, { signal });
          hop = await send(userAgent);
        }
        return respond(hop, userAgent, rejectedStatuses.has(hop.response.statusCode));
      } catch (error) {
        throw fail(error);
      }
    },
    close: () => agent.destroy(),
  };
}

function toFetchResponse(
  { url, redirects, response }: Hop,
  userAgent: string,
  rejected: boolean,
  fail: (error: unknown) => FetchError,
): FetchResponse {
  const headers = toHeaders(response.headers);
  const contentType = headers.get('content-type');
  let handled = false;
  const take = () => {
    if (handled) throw new Error('正文只能处理一次');
    handled = true;
    return response.body;
  };
  const read = async (maxBytes = defaultMaxBytes) => {
    const body = decompressed(take(), headers.get('content-encoding'));
    try {
      return await readCapped(body, maxBytes);
    } catch (error) {
      throw fail(error);
    }
  };
  return {
    status: response.statusCode,
    url: url.href,
    redirects,
    headers,
    mimeType: mimeTypeOf(contentType),
    userAgent,
    rejected,
    async text({ maxBytes } = {}) {
      const { bytes, truncated } = await read(maxBytes);
      return { ...decodeText(bytes, contentType, truncated), truncated };
    },
    bytes: ({ maxBytes } = {}) => read(maxBytes),
    async discard() {
      if (handled) return;
      handled = true;
      // 读掉剩下的一点（不超过 128 KB）让连接回到池里，长的直接断开
      await response.body.dump();
    },
  };
}

/**
 * 合并外部信号与时限，并给出把任意错误换成 FetchError 的函数：中止与超时看信号，
 * 这一层自己的错误原样，其余的算网络错误
 */
function abortControl({ signal: external, timeoutMs }: GetOptions) {
  const limit = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signals = [external, limit].filter((signal) => signal !== undefined);
  const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
  const fail = (error: unknown): FetchError => {
    if (error instanceof FetchError) return error;
    if (signal?.aborted) {
      return limit !== undefined && signal.reason === limit.reason
        ? new FetchError('timeout', `请求超时（${timeoutMs! / 1000} 秒）`, { cause: signal.reason })
        : new FetchError('aborted', '请求已中止', { cause: signal.reason });
    }
    return new FetchError('network', `网络错误：${summarize(error)}`, { cause: error });
  };
  return { signal, fail };
}

function parseUrl(input: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new FetchError('invalid-url', base ? '跳转地址无效' : '网址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('protocol', `只能访问 http 与 https 网址，不支持 ${url.protocol}`);
  }
  return url;
}

function requestHeaders(
  custom: Record<string, string> | undefined,
  userAgent: string,
): Record<string, string> {
  const headers = new Headers(defaultHeaders);
  for (const [name, value] of Object.entries(custom ?? {})) headers.set(name, value);
  headers.set('user-agent', userAgent);
  return Object.fromEntries(headers);
}

// 同名的头出现多次时取第一个
function first(value: string | string[] | undefined): string | undefined {
  return [value].flat()[0];
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const item of value === undefined ? [] : [value].flat()) headers.append(name, item);
  }
  return headers;
}

/** Retry-After：秒数或 HTTP 日期；没给或看不懂时 1 秒 */
function retryAfterMs(value: string | undefined): number {
  const text = value?.trim() ?? '';
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? defaultRetryWaitMs : Math.max(0, date - Date.now());
}

function summarize(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // 同时尝试 IPv4、IPv6 都失败时是 AggregateError，message 为空，原因在 code 里
  return error.message || (error as NodeJS.ErrnoException).code || error.name;
}

const blocked = () => new FetchError('blocked', '不能访问内网地址');

/**
 * 连接时检查实际要连的 IP。域名由 checkedLookup 解析并检查，net 直接用这次解析的结果去连，
 * 不会再解析第二次，DNS 重绑定没有空隙；URL 里直接写的 IP 不经 lookup，在这里先查。
 * 连上之后、发请求之前再核对一次对端地址兜底
 */
function safeConnector(isBlocked: (address: string) => boolean): buildConnector.connector {
  const connect = buildConnector({ lookup: checkedLookup(isBlocked) });
  return (options, callback) => {
    if (isIP(options.hostname) !== 0 && isBlocked(options.hostname)) {
      callback(blocked(), null);
      return;
    }
    connect(options, (error, socket) => {
      if (error !== null || socket === null) {
        callback(error ?? new Error('连接失败'), null);
        return;
      }
      const address = socket.remoteAddress;
      if (address === undefined || isBlocked(address)) {
        socket.destroy();
        callback(address === undefined ? new Error('连接已断开') : blocked(), null);
        return;
      }
      callback(null, socket);
    });
  };
}

/** 解析域名，解析出的地址只要有一个在拦截范围内就拒绝 */
function checkedLookup(isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
      } else if (addresses.some(({ address }) => isBlocked(address))) {
        callback(blocked(), []);
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}
