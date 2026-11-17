// 插件的入口文件（ADR-0014）：plugins/ 下的插件要用的东西只从这里引，不引 src/ 下别的文件，
// 也不引别的插件（lint 规则保证）。以后插件要单独打包时，把这个文件换成一个包就行。
// 这里只转出核心、安全请求（src/net/）里插件用得到的东西，用到新的再加；这个文件只引这两处，
// 不引前端、服务的代码。插件的测试另有 src/plugin-test-api.ts
import type { ToolDefinition } from './core/index.js';

export {
  defineTool,
  describeImage,
  imageSize,
  isSupportedImage,
  TextAndImages,
  ToolError,
  type Logger,
  type NewFile,
  type ToolDefinition,
} from './core/index.js';
export {
  createRequester,
  decodeText,
  defaultUserAgents,
  FetchError,
  type FetchErrorKind,
  type FetchResponse,
  type Requester,
} from './net/index.js';

/** definePlugin 的结果，插件清单（plugins/index.ts）里列的就是它 */
export type Plugin = {
  /** 插件名：小写字母、数字、下划线，以字母开头，清单里不能重复 */
  readonly name: string;
  /** 插件里的工具，按这个顺序发给模型；没有时是空的 */
  readonly tools: readonly ToolDefinition[];
  /** 插件声明的服务（defineService 的结果）；没有时是空的 */
  readonly services: readonly ServiceDefinition[];
};

/**
 * 定义一个插件：一个插件一个目录（plugins/<名字>/），入口 index.ts 用它导出插件，
 * 再列进 plugins/index.ts 的清单。名字与重名由洛璃服务启动时装配插件清单时检查
 */
export function definePlugin({
  name,
  tools = [],
  services = [],
}: {
  /** 插件名：小写字母、数字、下划线，以字母开头，清单里不能重复 */
  name: string;
  /** 插件里的工具（defineTool 的结果），按这个顺序发给模型 */
  tools?: readonly ToolDefinition[];
  /** 插件声明的服务（defineService 的结果） */
  services?: readonly ServiceDefinition[];
}): Plugin {
  return { name, tools: [...tools], services: [...services] };
}

/** 服务的环境变量：只含声明里 env 列出的那几个，值都不为空 */
export type ServiceEnv = Readonly<Record<string, string>>;

/** 写在声明里的认证：把环境变量 env 的值（前面加上 prefix，如 `Bearer `）放进请求头 header */
export type HeaderAuth = {
  readonly type: 'header';
  /** 请求头的名字，如 `Authorization`、`X-Api-Key` */
  readonly header: string;
  /** 放进请求头的环境变量，须列在服务的 env 里 */
  readonly env: string;
  readonly prefix?: string;
};

/**
 * 插件自己写的认证（如要签名的）。服务启动时调用一次 setup：拿到这个服务的环境变量，可以检查配置、
 * 读文件，配置有误时抛 ServiceConfigError（服务据此报错退出）。setup 返回的函数在每次请求前由服务层调用，
 * 拿到当前时间（由服务层给，测试里能换），返回要贴的请求头
 */
export type CustomAuth = {
  readonly type: 'custom';
  readonly setup: (env: ServiceEnv) => (request: { now: Date }) => Readonly<Record<string, string>>;
};

/** 服务放行的一个接口：只有 GET */
export type ServiceEndpoint = {
  /** 接口 id：小写字母、数字、下划线，以字母开头，服务内不重复；文档里这一节是 <id>.md */
  readonly id: string;
  /** 给人看的名称，如「实时天气」 */
  readonly title: string;
  /**
   * 路径，以 / 开头，接在服务的地址后面。路径参数单独占一段，写成 {名字}，
   * 如 `/weather/v1/current/{latitude}/{longitude}`
   */
  readonly path: string;
  /** 允许的查询参数的名字；不在这里、也不是路径参数的参数一律拒绝 */
  readonly query: readonly string[];
};

/**
 * defineService 的结果，列进插件的 services。服务是洛璃能调用的一个外部接口提供方（ADR-0014）：
 * 洛璃先读文档，再经服务层调放行的接口；凭据贴在请求上，她看不到
 */
export type ServiceDefinition = {
  /** 服务名：小写字母、数字、下划线，以字母开头，全部插件里不能重复 */
  readonly name: string;
  /** 给人看的名称，如「和风天气」 */
  readonly title: string;
  /** 一句话的简介，写进工具说明，告诉洛璃有这个服务、能做什么 */
  readonly summary: string;
  /** 必需的环境变量。缺任何一个（空字符串算缺），这个服务不装，启动时提示一行 */
  readonly env: readonly string[];
  /**
   * 地址（http、https，可以带路径，不带查询串），接口的路径接在后面。可以由环境变量算出来；
   * 算不出来时抛 ServiceConfigError
   */
  readonly baseUrl: string | ((env: ServiceEnv) => string);
  /** 认证；不写时请求不带凭据 */
  readonly auth?: HeaderAuth | CustomAuth;
  readonly endpoints: readonly ServiceEndpoint[];
  /** 护栏：两个都是正整数 */
  readonly limits: {
    /** 最短多久查一次（秒）。给监听的引擎用 */
    readonly minIntervalSeconds: number;
    /** 每天最多发多少次请求（按服务器的时区算一天），到了当天不再发 */
    readonly maxRequestsPerDay: number;
    /** 可以改每天上限的环境变量（可选）：不设时用上面的值，设了但不是正整数时启动报错退出 */
    readonly maxRequestsPerDayEnv?: string;
  };
  /**
   * 文档目录（写给洛璃看的），如 `new URL('./docs/', import.meta.url)`：
   * `overview.md` 是总说明，每个接口一个 `<接口 id>.md`
   */
  readonly docs: URL;
};

/**
 * 服务的配置有误（环境变量的值不对、私钥文件读不了……）。说明里写清是哪一项，
 * 不带任何环境变量的值、密钥的内容
 */
export class ServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceConfigError';
  }
}

/** 定义一个服务，列进插件的 services。声明有误由洛璃服务启动时检查，一次把问题列全 */
export function defineService(definition: ServiceDefinition): ServiceDefinition {
  return {
    ...definition,
    env: [...definition.env],
    endpoints: definition.endpoints.map((endpoint) => ({
      ...endpoint,
      query: [...endpoint.query],
    })),
    limits: { ...definition.limits },
  };
}
