import type { Logger, Requester } from '../../src/plugin-api.js';
import type { FetchMode } from './convert.js';
import { createGitHubHandler } from './github.js';
import type { Page } from './page.js';
import { createWikipediaHandler } from './wikipedia.js';

// 站点处理器：按网址认出网站，改走它的公开接口（ADR-0007「站点处理器」）。
// 先于通用流程：按清单顺序问，第一个认得这个网址的处理器来处理
//
// oh-my-pi 有、我们还没做的处理器，按类别列出（加了处理器就删掉对应的名字）：
// - 代码托管：github-gist、gitlab；github 的目录、提交、issue 列表、Actions
// - 视频与媒体：youtube、vimeo、spotify、discogs、musicbrainz
// - 游戏：rawg
// - 社交与新闻：twitter、bluesky、mastodon、lemmy、hackernews、lobsters、discourse
// - reddit：本机网络下对三种 User-Agent 一律 403
// - 开发内容：stackoverflow、devto、mdn、docs-rs、readthedocs、searchcode、sourcegraph、tldr、cheatsh
// - 软件包仓库：npm、firefox-addons、vscode-marketplace、nuget、chocolatey、clojars、brew、pypi、
//   crates-io、dockerhub、fdroid、flathub、go-pkg、hex、packagist、pub-dev、maven、
//   jetbrains-marketplace、open-vsx、artifacthub、rubygems、terraform、aur、hackage、metacpan、
//   repology、snapcraft
// - ML：huggingface、ollama
// - 学术：arxiv、biorxiv、crossref、iacr、orcid、semantic-scholar、pubmed、rfc
// - 安全：cisa-kev、nvd、osv
// - 加密货币：coingecko
// - 商业：opencorporates、sec-edgar
// - 参考资料：openlibrary、choosealicense、w3c、spdx、wikidata

/** 处理器拿到的东西 */
export type SiteContext = {
  /** 与通用流程共用的请求器：同样检查内网地址 */
  requester: Requester;
  /** 工具的中止信号（核心的中止或工具超时），发请求时带上 */
  signal: AbortSignal;
  mode: FetchMode;
  /** 工具的日志：不记网址与内容 */
  logger: Logger;
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
export const siteHandlers: readonly SiteHandler[] = [
  createGitHubHandler(),
  createWikipediaHandler(),
];
