import type { FetchMode } from './convert.js';
import type { Page } from './page.js';
import type { Requester } from './request.js';

// 站点处理器：按网址认出网站，改走它的公开接口（ADR-0007「站点处理器」）。
// 先于通用流程：按清单顺序问，第一个认得这个网址的处理器来处理

/** 处理器拿到的东西 */
export type SiteContext = {
  /** 与通用流程共用的请求器：同样检查内网地址 */
  requester: Requester;
  /** 工具的中止信号（核心的中止或工具超时），发请求时带上 */
  signal: AbortSignal;
  mode: FetchMode;
};

export type SiteHandler = {
  /** 日志里用的名字 */
  name: string;
  /** 认不认这个网址 */
  matches(url: URL): boolean;
  /**
   * 处理：返回结果就用它；返回 undefined（不处理）或抛错（接口失败、额度用完……）时走通用流程。
   * 中止信号触发后抛的错照原样往上传
   */
  read(url: URL, ctx: SiteContext): Promise<Page | undefined>;
};

/** 处理器清单 */
export const siteHandlers: readonly SiteHandler[] = [];
