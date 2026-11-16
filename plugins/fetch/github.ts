import { z } from 'zod';
import { decodeText, defaultUserAgents, type FetchResponse } from '../../src/plugin-api.js';
import { truncatedNote, type Page } from './page.js';
import type { SiteContext, SiteHandler } from './sites.js';

// GitHub：文件取原文；仓库首页、issue、PR 走公开接口（不带 token，每 IP 每小时 60 次）

// 自报身份的 bot（GitHub 要求必须有 User-Agent）
const userAgent = defaultUserAgents[1]!;

export type GitHubOptions = {
  /** 接口地址，默认 https://api.github.com */
  api?: string;
  /** 网页地址，文件的原文从这里的 /raw/ 取，默认 https://github.com */
  web?: string;
};

type Route =
  | { type: 'repo'; owner: string; repo: string }
  | { type: 'file'; owner: string; repo: string; refAndPath: string[] }
  | { type: 'issue' | 'pull'; owner: string; repo: string; number: string };

// 两段路径的保留页面（github.com/topics/ai 之类），不是仓库，免得白白用掉接口额度
const reservedOwners = new Set([
  'about',
  'apps',
  'collections',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'sponsors',
  'topics',
  'trending',
  'users',
]);

function route(url: URL): Route | undefined {
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  const parts = url.pathname.split('/').filter((part) => part !== '');
  const [owner, repo, kind, ...rest] = parts;
  if (!owner || !repo || reservedOwners.has(owner.toLowerCase())) return undefined;
  if (kind === undefined) return { type: 'repo', owner, repo };
  // blob 之后是分支名与文件路径；分支名可能带 /，分不开，原样交给 /raw/
  if (kind === 'blob' && rest.length >= 2) {
    return { type: 'file', owner, repo, refAndPath: rest };
  }
  // 后面还有 /files、/commits 等的，一律按这个 issue 或 PR 处理
  const number = rest[0];
  if ((kind === 'issues' || kind === 'pull') && number && /^\d+$/.test(number)) {
    return { type: kind === 'pull' ? 'pull' : 'issue', owner, repo, number };
  }
  return undefined;
}

/** 造 GitHub 的处理器。清单里用默认地址造的那一份 */
export function createGitHubHandler({
  api = 'https://api.github.com',
  web = 'https://github.com',
}: GitHubOptions = {}): SiteHandler {
  return {
    name: 'github',
    matches: (url) => route(url) !== undefined,
    async read(url, ctx) {
      const target = route(url);
      switch (target?.type) {
        case 'file':
          return readFile(url, target, web, ctx);
        case 'repo':
          return readRepo(url, target, api, ctx);
        case 'issue':
        case 'pull':
          return readIssue(url, target, api, ctx);
        default:
          return undefined;
      }
    },
  };
}

/** 文件：/{owner}/{repo}/blob/{ref}/{path} 换成 /raw/，GitHub 会跳到 raw.githubusercontent.com */
async function readFile(
  url: URL,
  { owner, repo, refAndPath }: Extract<Route, { type: 'file' }>,
  web: string,
  ctx: SiteContext,
): Promise<Page | undefined> {
  const response = await ctx.requester.get(`${web}/${owner}/${repo}/raw/${refAndPath.join('/')}`, {
    userAgent,
    signal: ctx.signal,
  });
  const text = await readText(response);
  if (text === undefined) return undefined;
  // 分支名带 / 时，路径里会多出分支名的后半段
  const path = refAndPath.slice(1).map(decode).join('/');
  return {
    url: url.href,
    title: `${owner}/${repo}: ${path}`,
    method: 'GitHub 原文',
    notes: text.truncated ? [truncatedNote] : [],
    content: text.text,
  };
}

/** 文本（text/*，或没写类型但不含 NUL 字节）读成文字；非 2xx 或不是文本时丢弃，返回 undefined */
async function readText(
  response: FetchResponse,
): Promise<{ text: string; truncated: boolean } | undefined> {
  const { status, mimeType } = response;
  if (status >= 200 && status <= 299) {
    if (mimeType?.startsWith('text/')) return response.text();
    if (mimeType === undefined) {
      const { bytes, truncated } = await response.bytes();
      if (bytes.includes(0)) return undefined;
      return { text: decodeText(bytes, null, truncated).text, truncated };
    }
  }
  await response.discard();
  return undefined;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const repoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullish(),
  stargazers_count: z.number().nullish(),
  language: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  license: z.object({ name: z.string().nullish(), spdx_id: z.string().nullish() }).nullish(),
  default_branch: z.string().nullish(),
  pushed_at: z.string().nullish(),
});

/** 仓库首页：仓库信息几行，加 README 原文 */
async function readRepo(
  url: URL,
  { owner, repo }: Extract<Route, { type: 'repo' }>,
  api: string,
  ctx: SiteContext,
): Promise<Page | undefined> {
  const base = `${api}/repos/${owner}/${repo}`;
  const [info, readme] = await Promise.all([
    getJson(ctx, base, repoSchema),
    // raw 的 Accept 直接拿到 README 原文。不用 raw 地址取根目录的 README：它可能是符号链接
    get(ctx, `${base}/readme`, 'application/vnd.github.raw+json'),
  ]);
  if (info === undefined) return undefined;
  // 没有 README（404）时只给仓库信息；其他失败交回通用流程
  if (readme.text === undefined && readme.status !== 404) return undefined;
  const license = info.license?.name ?? info.license?.spdx_id;
  const lines = [
    info.description && `描述：${info.description}`,
    info.stargazers_count != null && `Star：${info.stargazers_count}`,
    info.language && `主要语言：${info.language}`,
    info.topics?.length && `话题：${info.topics.join('、')}`,
    license && `许可证：${license}`,
    info.default_branch && `默认分支：${info.default_branch}`,
    info.pushed_at && `最近更新：${info.pushed_at}`,
  ].filter((line): line is string => typeof line === 'string');
  return {
    url: url.href,
    title: info.full_name,
    method: 'GitHub 接口',
    notes: readme.truncated ? [truncatedNote] : [],
    content: [lines.join('\n'), readme.text?.trim()].filter(Boolean).join('\n\n'),
  };
}

const login = z.object({ login: z.string() }).nullish();

const issueSchema = z.object({
  title: z.string(),
  user: login,
  state: z.string(),
  state_reason: z.string().nullish(),
  created_at: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).nullish(),
  body: z.string().nullish(),
  comments: z.number().nullish(),
  // 有这个字段的是 PR
  pull_request: z.object({}).passthrough().nullish(),
});

const commentsSchema = z.array(
  z.object({ user: login, created_at: z.string(), body: z.string().nullish() }),
);

const pullSchema = z.object({
  state: z.string(),
  merged: z.boolean().nullish(),
  draft: z.boolean().nullish(),
  head: z.object({ label: z.string().nullish(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changed_files: z.number().nullish(),
});

// 评论只取第一页
const commentsPerPage = 100;

/** issue 与 PR：元信息几行、正文、评论 */
async function readIssue(
  url: URL,
  { type, owner, repo, number }: Extract<Route, { type: 'issue' | 'pull' }>,
  api: string,
  ctx: SiteContext,
): Promise<Page | undefined> {
  const base = `${api}/repos/${owner}/${repo}`;
  const pullUrl = `${base}/pulls/${number}`;
  // issues 接口对 PR 也有效
  const [issue, comments, pullFromUrl] = await Promise.all([
    getJson(ctx, `${base}/issues/${number}`, issueSchema),
    getJson(ctx, `${base}/issues/${number}/comments?per_page=${commentsPerPage}`, commentsSchema),
    type === 'pull' ? getJson(ctx, pullUrl, pullSchema) : undefined,
  ]);
  if (issue === undefined || comments === undefined) return undefined;
  // /issues/N 其实是 PR 时，再取 PR 的信息
  const isPull = type === 'pull' || issue.pull_request != null;
  const pull = pullFromUrl ?? (isPull ? await getJson(ctx, pullUrl, pullSchema) : undefined);
  if (isPull && pull === undefined) return undefined;

  const author = issue.user?.login ?? 'ghost';
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const meta = [
    `类型：${isPull ? 'PR' : 'issue'}`,
    `状态：${pull ? pullState(pull) : issueState(issue)}`,
    `作者：${author}`,
    `创建时间：${issue.created_at}`,
    ...(labels.length > 0 ? [`标签：${labels.join('、')}`] : []),
    ...(pull
      ? [
          `来源分支：${pull.head.label ?? pull.head.ref}`,
          `目标分支：${pull.base.ref}`,
          `增删：+${pull.additions ?? 0} -${pull.deletions ?? 0}`,
          `改动文件：${pull.changed_files ?? 0} 个`,
        ]
      : []),
  ];
  const discussion =
    comments.length === 0
      ? ['（没有评论）']
      : comments.map(
          (comment) =>
            `### ${comment.user?.login ?? 'ghost'} · ${comment.created_at}\n\n${comment.body?.trim() || '（空）'}`,
        );
  const total = issue.comments ?? comments.length;
  return {
    url: url.href,
    title: issue.title,
    author,
    publishedTime: issue.created_at,
    method: 'GitHub 接口',
    notes: total > comments.length ? [`评论共 ${total} 条，只取了前 ${comments.length} 条`] : [],
    content: [meta.join('\n'), issue.body?.trim() || '（没有正文）', '## 评论', ...discussion].join(
      '\n\n',
    ),
  };
}

function issueState({ state, state_reason }: z.infer<typeof issueSchema>): string {
  return state === 'closed' && state_reason ? `closed（${state_reason}）` : state;
}

function pullState({ state, merged, draft }: z.infer<typeof pullSchema>): string {
  if (merged) return 'merged';
  return state === 'open' && draft ? 'open（draft）' : state;
}

/** 请求接口：2xx 时读出文字；否则丢弃正文，只给状态码。额度用完时记一条日志 */
async function get(
  ctx: SiteContext,
  url: string,
  accept = 'application/vnd.github+json',
): Promise<{ status: number; text?: string; truncated?: boolean }> {
  const response = await ctx.requester.get(url, {
    userAgent,
    headers: { accept, 'x-github-api-version': '2022-11-28' },
    signal: ctx.signal,
  });
  const { status } = response;
  if (status >= 200 && status <= 299) return { status, ...(await response.text()) };
  if ((status === 403 || status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    ctx.logger.warn({ site: 'github', status }, 'fetch.rate_limited');
  }
  await response.discard();
  return { status };
}

/** 请求 JSON 接口并按结构解析；非 2xx、解析不了时返回 undefined */
async function getJson<T>(
  ctx: SiteContext,
  url: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const { text } = await get(ctx, url);
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
