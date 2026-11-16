import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../core/index.js';
import { ServiceConfigError, type ServiceDefinition, type ServiceEnv } from '../../plugin-api.js';
import type { Env } from '../../shared/config.js';
import { createServiceRedactor } from './redact.js';

// 服务（ADR-0014）：启动时检查插件声明的服务，按环境变量装上。检查声明不看环境变量，有误时把问题列全；
// 缺环境变量的服务不装、提示一行；装上的服务再检查配置（地址、认证、每天的上限），有误时报错退出

/** 装上的一个服务：声明，加上它的环境变量的值、算好的地址、认证、每天的上限、文档目录 */
export type InstalledService = {
  readonly definition: ServiceDefinition;
  /** 声明里 env 列出的环境变量的值 */
  readonly env: ServiceEnv;
  /** 地址，结尾没有 /；接口的路径接在后面 */
  readonly baseUrl: string;
  /** 每次请求前调用，返回要贴的请求头；没有认证时为 undefined */
  readonly sign?: (request: { now: Date }) => Readonly<Record<string, string>>;
  readonly maxRequestsPerDay: number;
  readonly docsDir: string;
  /**
   * 交给调用方之前要抹掉的：环境变量的值、由环境变量算出来的地址的主机名
   * （太短的由抹的那一步去掉，见 createServiceRedactor）
   */
  readonly secrets: readonly string[];
};

/** 声明有误（名字不合规、重名、接口 id 重复、路径写法不对、缺文档……）。信息里列出每个服务与它的问题 */
export class ServiceDefinitionError extends Error {
  constructor(readonly problems: Array<{ service: string; problems: string[] }>) {
    const list = problems.map(
      (entry) => `${entry.service || '（空）'}（${entry.problems.join('，')}）`,
    );
    super(`服务定义有误：${list.join('；')}`);
    this.name = 'ServiceDefinitionError';
  }
}

// 服务名、接口 id：同工具名
const nameRule = /^[a-z][a-z0-9_]*$/;
// 参数名（路径参数、查询参数）：字母开头，字母、数字、下划线
const paramRule = /^[A-Za-z][A-Za-z0-9_]*$/;
// 路径里不是参数的一段：URL 路径里不用转义的字符（不含 %），不能是 . 或 ..
const literalSegment = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
const pathParam = /^\{([^{}]*)\}$/;
// 请求头的名字（HTTP 的 token）
const headerRule = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const envRule = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 路径里的参数名，按出现的先后；路径写法不对时为 undefined */
export function pathParams(path: string): string[] | undefined {
  if (!path.startsWith('/')) return undefined;
  const names: string[] = [];
  for (const segment of path.slice(1).split('/')) {
    const param = pathParam.exec(segment);
    if (param) {
      if (!paramRule.test(param[1]!)) return undefined;
      names.push(param[1]!);
    } else if (!literalSegment.test(segment) || segment === '.' || segment === '..') {
      return undefined;
    }
  }
  return names;
}

const positiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 检查全部服务的声明（不看环境变量），有误时抛 ServiceDefinitionError，一次把问题列全 */
export function checkServices(definitions: readonly ServiceDefinition[]): void {
  // 按名字归并问题，按第一次出现的顺序列出
  const problems = new Map<string, string[]>();
  const report = (name: string, problem: string) => {
    const list = problems.get(name) ?? [];
    if (!list.includes(problem)) list.push(problem);
    problems.set(name, list);
  };
  const counts = new Map<string, number>();
  for (const { name } of definitions) counts.set(name, (counts.get(name) ?? 0) + 1);

  for (const definition of definitions) {
    const { name, title, summary, env, baseUrl, auth, endpoints, limits, docs } = definition;
    const problem = (text: string) => report(name, text);
    if (!nameRule.test(name)) problem('名字只能用小写字母、数字和下划线，以字母开头');
    if (counts.get(name)! > 1) problem('重名');
    if (typeof title !== 'string' || !title.trim()) problem('没有名称');
    if (typeof summary !== 'string' || !summary.trim()) problem('没有简介');

    for (const variable of env) {
      if (!envRule.test(variable)) problem(`环境变量名 ${variable} 不合规`);
    }
    if (new Set(env).size !== env.length) problem('环境变量重复');

    if (typeof baseUrl === 'string') {
      const reason = urlProblem(baseUrl);
      if (reason) problem(`地址${reason}`);
    } else if (typeof baseUrl !== 'function') {
      problem('地址只能是字符串或函数');
    }

    if (auth?.type === 'header') {
      if (!headerRule.test(auth.header)) problem(`认证的请求头名 ${auth.header} 不合规`);
      if (!env.includes(auth.env)) problem(`认证用的环境变量 ${auth.env} 不在 env 里`);
      if (auth.prefix !== undefined && typeof auth.prefix !== 'string') {
        problem('认证的前缀只能是字符串');
      }
    } else if (auth?.type === 'custom') {
      if (typeof auth.setup !== 'function') problem('自己写的认证要给 setup 函数');
    } else if (auth !== undefined) {
      problem('认证只能是 header 或 custom');
    }

    if (endpoints.length === 0) problem('没有接口');
    const ids = new Map<string, number>();
    for (const { id } of endpoints) ids.set(id, (ids.get(id) ?? 0) + 1);
    for (const { id, title: endpointTitle, path, query } of endpoints) {
      if (!nameRule.test(id))
        problem(`接口 id ${id || '（空）'} 只能用小写字母、数字和下划线，以字母开头`);
      if (ids.get(id)! > 1) problem(`接口 id ${id} 重复`);
      if (typeof endpointTitle !== 'string' || !endpointTitle.trim()) {
        problem(`接口 ${id} 没有名称`);
      }
      const params = pathParams(path);
      if (!params) {
        problem(`接口 ${id} 的路径 ${path} 写法不对（以 / 开头，路径参数单独占一段，写成 {名字}）`);
      } else if (new Set(params).size !== params.length) {
        problem(`接口 ${id} 的路径参数重复`);
      }
      for (const name of query) {
        if (!paramRule.test(name)) problem(`接口 ${id} 的查询参数名 ${name} 不合规`);
        if (params?.includes(name)) problem(`接口 ${id} 的查询参数 ${name} 和路径参数重名`);
      }
      if (new Set(query).size !== query.length) problem(`接口 ${id} 的查询参数重复`);
    }

    if (!positiveInteger(limits.minIntervalSeconds)) problem('最短间隔要是正整数（秒）');
    if (!positiveInteger(limits.maxRequestsPerDay)) problem('每天的上限要是正整数');
    if (limits.maxRequestsPerDayEnv !== undefined && !envRule.test(limits.maxRequestsPerDayEnv)) {
      problem(`每天上限的环境变量名 ${limits.maxRequestsPerDayEnv} 不合规`);
    }

    const dir = docsDir(docs);
    if (dir === undefined) {
      problem('文档目录要是 file: 的 URL');
    } else {
      const files = new Set([
        'overview.md',
        ...endpoints.filter(({ id }) => nameRule.test(id)).map(({ id }) => `${id}.md`),
      ]);
      const missing = [...files].filter((file) => !isFile(join(dir, file)));
      if (missing.length > 0) problem(`缺文档 ${missing.join('、')}`);
    }
  }
  if (problems.size > 0) {
    throw new ServiceDefinitionError(
      [...problems].map(([service, list]) => ({ service, problems: list })),
    );
  }
}

/**
 * 装上服务：先检查声明（有误时返回错误信息，服务打到 stderr 后退出）；缺环境变量的不装，各提示一行、
 * 记一条 warn services.skipped（只有服务名与缺的变量名）；装上的再检查配置（地址、认证、每天的上限），
 * 有误时返回错误信息（说清哪个服务的哪一项，不带变量的值）；最后记一条 info services.installed
 */
export function installServices(
  definitions: readonly ServiceDefinition[],
  env: Env,
  { logger, report }: { logger: Logger; report: (line: string) => void },
): { ok: true; services: InstalledService[] } | { ok: false; error: string } {
  try {
    checkServices(definitions);
  } catch (error) {
    if (error instanceof ServiceDefinitionError) return { ok: false, error: error.message };
    throw error;
  }

  const services: InstalledService[] = [];
  const problems: string[] = [];
  for (const definition of definitions) {
    const missing = definition.env.filter((name) => !env[name]);
    if (missing.length > 0) {
      report(`服务 ${definition.name} 没有装上：缺少环境变量 ${missing.join('、')}`);
      logger.warn({ service: definition.name, missing }, 'services.skipped');
      continue;
    }
    const values = Object.fromEntries(definition.env.map((name) => [name, env[name]!]));
    const configured = configure(definition, values, env);
    if (configured.ok) {
      services.push(configured.service);
    } else {
      const redact = createServiceRedactor(Object.values(values));
      problems.push(
        ...configured.problems.map((text) => redact(`服务 ${definition.name} 的配置有误：${text}`)),
      );
    }
  }
  if (problems.length > 0) return { ok: false, error: problems.join('\n') };
  logger.info(
    { services: services.map((service) => service.definition.name) },
    'services.installed',
  );
  return { ok: true, services };
}

function configure(
  definition: ServiceDefinition,
  values: ServiceEnv,
  env: Env,
): { ok: true; service: InstalledService } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const failed = (error: unknown, fallback: string) =>
    problems.push(error instanceof ServiceConfigError ? error.message : fallback);

  let baseUrl: string | undefined;
  try {
    const raw =
      typeof definition.baseUrl === 'function' ? definition.baseUrl(values) : definition.baseUrl;
    const reason = urlProblem(raw);
    if (reason) problems.push(`地址${reason}`);
    else baseUrl = raw.replace(/\/+$/, '');
  } catch (error) {
    failed(error, '地址算不出来');
  }

  let sign: InstalledService['sign'];
  const { auth } = definition;
  if (auth?.type === 'header') {
    const value = `${auth.prefix ?? ''}${values[auth.env]!}`;
    sign = () => ({ [auth.header]: value });
  } else if (auth?.type === 'custom') {
    try {
      sign = auth.setup(values);
    } catch (error) {
      failed(error, '认证的配置检查出错');
    }
  }

  const { maxRequestsPerDay: fallback, maxRequestsPerDayEnv: limitEnv } = definition.limits;
  let maxRequestsPerDay = fallback;
  const rawLimit = limitEnv ? env[limitEnv] : undefined;
  if (limitEnv && rawLimit) {
    const limit = Number(rawLimit);
    if (/^\d+$/.test(rawLimit) && Number.isSafeInteger(limit) && limit > 0) {
      maxRequestsPerDay = limit;
    } else {
      problems.push(`${limitEnv} 要是正整数`);
    }
  }

  if (problems.length > 0 || baseUrl === undefined) return { ok: false, problems };
  // 由环境变量算出来的地址（如和风天气每个账号的主机名）也算凭据的一部分
  const { hostname, host } = new URL(baseUrl);
  const hosts = typeof definition.baseUrl === 'function' ? [host, hostname] : [];
  return {
    ok: true,
    service: {
      definition,
      env: values,
      baseUrl,
      sign,
      maxRequestsPerDay,
      docsDir: docsDir(definition.docs)!,
      secrets: [...Object.values(values), ...hosts],
    },
  };
}

/** 地址的毛病（「不是合法的网址」等）；没有毛病时为 undefined。说明里不带地址本身 */
function urlProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return '不是字符串';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '不是合法的网址';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只能是 http 或 https';
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return '不能带查询串或 #';
  }
  if (url.username || url.password) return '不能带用户名和密码';
  return undefined;
}

function docsDir(docs: unknown): string | undefined {
  if (!(docs instanceof URL) || docs.protocol !== 'file:') return undefined;
  return fileURLToPath(docs);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
