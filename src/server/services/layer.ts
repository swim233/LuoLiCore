import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../core/index.js';
import { defaultUserAgents, FetchError, type Requester } from '../../net/index.js';
import type { FeedsDb } from '../feeds-db.js';
import { pathParams, type InstalledService } from './install.js';
import { createServiceRedactor, normalizeJson } from './redact.js';

// 服务层（ADR-0014）：洛璃的工具和监听的引擎都经过它调外部服务、读服务的文档。
// 只调装上的服务、声明了的接口，只发 GET，不跟随跳转；凭据只在这里贴上；每天的请求数有上限，
// 计数存在 feeds.db 里；交给调用方的文字和日志里抹掉凭据

/**
 * 出错的类别，调用方（引擎）据此决定多久以后再试：
 * unknown 没有这个服务、接口或文档的节；params 参数不对；quota 今天的额度用完了；
 * status 服务回了 2xx 以外的状态（含 3xx：不跟随跳转）；network 网络错误；timeout 超时；
 * aborted 被调用方中止；auth 认证的请求头算不出来；docs 文档读不了
 */
export type ServiceErrorKind =
  'unknown' | 'params' | 'quota' | 'status' | 'network' | 'timeout' | 'aborted' | 'auth' | 'docs';

/** 服务层的错误。说明是给模型看的话，不带凭据和请求的地址 */
export class ServiceError extends Error {
  constructor(
    readonly kind: ServiceErrorKind,
    message: string,
    /** kind 为 status 时：服务回的状态码 */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * 调用一个接口的结果（2xx）：状态码与正文（解压、解码过，最多 1 MB）。正文是 JSON 时已经规整、
 * 用 2 个空格排版；凭据（含 JSON 转义的写法）都抹成了 `***`，可以直接交出去
 */
export type ServiceResponse = {
  status: number;
  body: string;
  /** Content-Type 的类型部分，如 `application/json`；没写时为 undefined */
  mimeType: string | undefined;
  /** 正文超过上限，只读了前面一段 */
  truncated: boolean;
};

/** 装上的服务里给工具、监听看的部分 */
export type ServiceInfo = {
  name: string;
  title: string;
  summary: string;
  endpoints: Array<{ id: string; title: string; pathParams: string[]; query: string[] }>;
  /** 最短多久查一次（秒），监听的间隔不能比它短 */
  minIntervalSeconds: number;
  /** 每天最多发多少次请求（一次性的查询和监听合在一起算） */
  maxRequestsPerDay: number;
};

export type ServiceLayer = {
  /** 装上的服务，按插件清单的先后 */
  readonly services: readonly ServiceInfo[];
  /**
   * 调一个接口：params 里路径参数、查询参数都写在一起，值只收字符串、有限的数字、布尔值。
   * 2xx 时返回结果，其余都抛 ServiceError
   */
  call(
    service: string,
    endpoint: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ServiceResponse>;
  /**
   * 只检查、不发请求（也不算次数）：服务装没装、有没有这个接口、参数过不过得了 call 的检查。
   * 不过时抛 ServiceError（unknown、params），说明和 call 的相同
   */
  check(service: string, endpoint: string, params?: unknown): void;
  /**
   * 读文档：不给 section 时是总说明（overview.md），给了是那个接口的一节（<接口 id>.md）。
   * 每次都重新读文件；读不到时抛 ServiceError
   */
  readDoc(service: string, section?: string): Promise<string>;
};

/** 一次调用最长多久（毫秒），到读完正文为止 */
export const serviceTimeoutMs = 20_000;
/** 正文最多读多少字节 */
export const serviceMaxBytes = 1024 * 1024;
/** 出错时带上正文的前多少个字符（服务说的原因） */
const reasonChars = 500;
/** 一个参数的值最多多少个字符 */
export const maxParamChars = 2000;

export function createServiceLayer({
  services,
  feeds,
  requester,
  logger,
  now = () => new Date(),
  timeoutMs = serviceTimeoutMs,
  maxBytes = serviceMaxBytes,
}: {
  services: readonly InstalledService[];
  /** 记每天的请求数 */
  feeds: FeedsDb;
  /** 防内网的安全请求（src/net/）。由调用方建、调用方关 */
  requester: Requester;
  logger: Logger;
  /** 当前时间：算「今天」、交给认证；测试里换成假的 */
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
}): ServiceLayer {
  const byName = new Map(services.map((service) => [service.definition.name, service]));
  const names = () => list([...byName.keys()]);

  function find(name: string): InstalledService {
    const service = byName.get(name);
    if (!service)
      throw new ServiceError('unknown', `服务不存在：${name}（可用的服务：${names()}）`);
    return service;
  }

  function endpointOf(service: InstalledService, id: string) {
    const endpoint = service.definition.endpoints.find((candidate) => candidate.id === id);
    if (!endpoint) {
      const ids = list(service.definition.endpoints.map((candidate) => candidate.id));
      throw new ServiceError(
        'unknown',
        `服务 ${service.definition.name} 没有接口 ${id}（可用的接口：${ids}）`,
      );
    }
    return endpoint;
  }

  return {
    services: services.map(({ definition, maxRequestsPerDay }) => ({
      name: definition.name,
      title: definition.title,
      summary: definition.summary,
      endpoints: definition.endpoints.map(({ id, title, path, query }) => ({
        id,
        title,
        pathParams: pathParams(path) ?? [],
        query: [...query],
      })),
      minIntervalSeconds: definition.limits.minIntervalSeconds,
      maxRequestsPerDay,
    })),

    check(name, endpointId, params = {}) {
      buildPath(endpointOf(find(name), endpointId), params);
    },

    async call(name, endpointId, params = {}, { signal } = {}) {
      const started = performance.now();
      const at = now();
      const day = localDay(at);
      let known = false;
      let knownEndpoint = false;
      let requests: number | undefined;
      // 日志：状态码或错误的类别、正文长度；不记参数、地址、正文。服务名、接口是模型给的字，
      // 认得出时才记
      let outcome: Record<string, unknown> = {};
      let redact = (text: string) => text;
      try {
        const service = find(name);
        known = true;
        const endpoint = endpointOf(service, endpointId);
        knownEndpoint = true;
        const path = buildPath(endpoint, params);

        // 认证的请求头只在这里算、只贴在发往这个服务的请求上
        let authHeaders: Readonly<Record<string, string>>;
        try {
          authHeaders = service.sign?.({ now: at }) ?? {};
        } catch {
          throw new ServiceError('auth', `服务 ${name} 认证出错，请求未发出`);
        }
        // 要抹的：环境变量的值、算出来的主机名、贴上去的请求头的值，以及值里按空格切开的各段
        // （第一段是 Bearer 这样的认证方式，不算）。短的由抹的那一步去掉
        redact = createServiceRedactor([
          ...service.secrets,
          ...Object.values(authHeaders).flatMap((value) => [
            value,
            ...value.trim().split(/\s+/).slice(1),
          ]),
        ]);

        requests = feeds.reserveRequest(name, day, service.maxRequestsPerDay);
        if (requests === undefined) {
          throw new ServiceError(
            'quota',
            `今日额度已用完（服务 ${name} 每天最多 ${service.maxRequestsPerDay} 次请求），请明天再试`,
          );
        }

        const response = await requester.get(`${service.baseUrl}${path}`, {
          userAgent: defaultUserAgents[1],
          headers: { accept: 'application/json, */*;q=0.8', ...authHeaders },
          signal,
          timeoutMs,
          followRedirects: false,
        });
        const { text, truncated } = await response.text({ maxBytes });
        outcome = { status: response.status, bodyLength: text.length };
        // 先规整 JSON（凭据的转义写法都还原成原文）、再抹凭据、最后截短，顺序不能反
        if (response.status < 200 || response.status > 299) {
          const reason = redact(normalizeJson(text.trim()).text).slice(0, reasonChars);
          const redirect =
            response.status >= 300 && response.status < 400 ? '（要求跳转，未跟随）' : '';
          throw new ServiceError(
            'status',
            `服务 ${name} 返回 HTTP ${response.status}${redirect}${reason ? `：${reason}` : ''}`,
            response.status,
          );
        }
        const body = redact(normalizeJson(text, 2).text);
        return { status: response.status, body, mimeType: response.mimeType, truncated };
      } catch (error) {
        const failure =
          error instanceof ServiceError ? error : fromFetchError(error, name, timeoutMs, redact);
        if (failure.kind !== 'status') outcome = { error: failure.kind };
        throw failure;
      } finally {
        logger.info(
          {
            ...(known ? { service: name } : {}),
            ...(knownEndpoint ? { endpoint: endpointId } : {}),
            ...outcome,
            durationMs: Math.round(performance.now() - started),
            requestsToday: known ? (requests ?? feeds.requestsOn(name, day)) : undefined,
          },
          'service.call',
        );
      }
    },

    async readDoc(name, section) {
      const service = find(name);
      if (section !== undefined && !service.definition.endpoints.some(({ id }) => id === section)) {
        const ids = list(service.definition.endpoints.map(({ id }) => id));
        throw new ServiceError(
          'unknown',
          `服务 ${name} 的文档没有此章节：${section}（可用的章节：${ids}）`,
        );
      }
      const file = section === undefined ? 'overview.md' : `${section}.md`;
      try {
        return await readFile(join(service.docsDir, file), 'utf8');
      } catch (error) {
        logger.error(
          { service: name, file, code: (error as NodeJS.ErrnoException).code },
          'service.docs_failed',
        );
        throw new ServiceError('docs', `服务 ${name} 的文档读取失败：${file}`);
      }
    },
  };
}

/**
 * 检查参数、拼出路径和查询串。参数的名字只能是这个接口的路径参数、查询参数；值只收字符串、有限的数字、
 * 布尔值；路径参数要给全。路径参数的值做 URL 编码，单独占一段，不能改变路径的层次（不能是空的、. 或 ..）。
 * 检查不过抛 ServiceError（params），这时不发请求
 */
function buildPath(endpoint: InstalledService['definition']['endpoints'][number], params: unknown) {
  const pathNames = pathParams(endpoint.path) ?? [];
  const allowed = [...pathNames.map((name) => `${name}（路径参数，必填）`), ...endpoint.query];
  const hint = `接口 ${endpoint.id} 可用的参数：${allowed.length > 0 ? allowed.join('、') : '没有'}`;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ServiceError('params', `参数须为对象。${hint}`);
  }
  const entries = Object.entries(params as Record<string, unknown>);
  const values = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!pathNames.includes(name) && !endpoint.query.includes(name)) {
      throw new ServiceError('params', `不支持参数 ${name}。${hint}`);
    }
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new ServiceError('params', `参数 ${name} 的值只能是字符串、数字或布尔值`);
    }
    const text = String(value);
    if ([...text].length > maxParamChars) {
      throw new ServiceError('params', `参数 ${name} 过长（最多 ${maxParamChars} 个字符）`);
    }
    values.set(name, text);
  }
  const missing = pathNames.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new ServiceError('params', `缺少路径参数 ${missing.join('、')}。${hint}`);
  }
  const path = endpoint.path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = values.get(name)!;
    if (value === '' || value === '.' || value === '..') {
      throw new ServiceError('params', `路径参数 ${name} 不能为空，也不能是 . 或 ..`);
    }
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(
    entries
      .filter(([name]) => endpoint.query.includes(name))
      .map(([name]): [string, string] => [name, values.get(name)!]),
  ).toString();
  return query ? `${path}?${query}` : path;
}

/** 安全请求的错误换成服务层的类别；说明抹掉凭据（网络错误的原文里可能有主机名） */
function fromFetchError(
  error: unknown,
  name: string,
  timeoutMs: number,
  redact: (text: string) => string,
): ServiceError {
  if (!(error instanceof FetchError)) {
    return new ServiceError('network', `服务 ${name} 请求出错：${redact(String(error))}`);
  }
  switch (error.kind) {
    case 'timeout':
      return new ServiceError('timeout', `服务 ${name} 超过 ${timeoutMs / 1000} 秒未响应`);
    case 'aborted':
      return new ServiceError('aborted', `对服务 ${name} 的调用已中止`);
    default:
      return new ServiceError('network', `服务 ${name} 请求出错：${redact(error.message)}`);
  }
}

/** 服务器时区的日期，YYYY-MM-DD */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const list = (items: readonly string[]) => (items.length > 0 ? items.join('、') : '没有');
