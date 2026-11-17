import { z } from 'zod';
import {
  createRequester,
  definePlugin,
  defineTool,
  FetchError,
  ToolError,
  type FetchErrorKind,
  type Logger,
  type Requester,
  type ToolDefinition,
} from '../../src/plugin-api.js';
import { defaultJina } from './jina.js';
import { fetchSummary, renderPage, truncatedNote } from './page.js';
import { readGeneric, type ReadOptions, type ReadResult } from './read.js';
import { siteHandlers, type SiteHandler } from './sites.js';

// fetch：读一个网址，转成 Markdown 交给模型（ADR-0007）

const description = [
  '此工具用于访问网址（http、https），工具会把网页转成 Markdown 返回给你。会话中有人发了链接、问到网页上的内容，或者需要某个网页上的信息时可以使用此工具。此工具不能搜索，只能读给定的网址；此工具无法访问内网地址。',
  '结果开头几行为元数据（URL、标题、长度等），`---` 之后是正文。正文太长时一次只给一段，头部「长度」一行给出接着读用的 offset；offset 按同一个 mode 计，换 mode 时从 0 读起。',
  '默认只取文章正文；要看评论区等正文以外的内容，用 mode: "page" 再次调用工具。',
].join('\n');

const input = z.object({
  url: z.string().describe('此处填写目标网址；未填写协议时默认为 https'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      '从正文的第几个字符开始读取，默认为 0；接着读时用上次结果头部给的值，切换 mode 时需要重新将此参数设置为 0',
    ),
  mode: z
    .enum(['article', 'page'])
    .default('article')
    .describe('article：只取文章正文（默认）；page：整页，含评论区等正文以外的内容'),
});

// 请求器的错误换成模型看到的说明；aborted（核心的中止或工具超时）不在这里，照原样抛出
const fetchErrorTexts: Record<Exclude<FetchErrorKind, 'aborted'>, string> = {
  'invalid-url': '网址无效',
  protocol: '仅支持 http 和 https',
  blocked: '无法访问内网地址',
  redirects: '抓取失败：跳转次数过多',
  network: '抓取失败：网络错误',
  // 只有 r.jina.ai 的请求带时限，它的超时在 jina.ts 里按失败处理；这里只是兜底
  timeout: '抓取失败：网络错误',
};

export type FetchToolOptions = {
  /** 请求器；不给时在第一次调用时建一个，之后复用。测试里传放行本机地址的 */
  requester?: Requester;
  /** r.jina.ai 的地址，后面直接接完整网址。测试里指向本地服务 */
  jinaReader?: string;
  /** r.jina.ai 的单次时限（毫秒），默认 20 秒 */
  jinaTimeoutMs?: number;
  /** 站点处理器清单，默认 sites.ts 里的 */
  sites?: readonly SiteHandler[];
};

/** 造一个 fetch 工具。fetch 插件里用的是默认参数造的那一份（fetchTool） */
export function createFetchTool({
  requester,
  jinaReader = defaultJina.reader,
  jinaTimeoutMs = defaultJina.timeoutMs,
  sites = siteHandlers,
}: FetchToolOptions = {}): ToolDefinition {
  let shared = requester;
  return defineTool({
    name: 'fetch',
    description,
    input,
    timeoutMs: 30_000,
    // 网址加页面标题；带图片的结果给的是它的文字部分，开头同样是元数据
    summary: ({ input: { url }, output }) =>
      fetchSummary(url, typeof output === 'string' ? output : undefined),
    async execute({ url: raw, offset, mode }, ctx) {
      const options: ReadOptions = {
        requester: (shared ??= createRequester()),
        jina: { reader: jinaReader, timeoutMs: jinaTimeoutMs },
        signal: ctx.abortSignal,
        mode,
      };
      let result: ReadResult;
      let output: Awaited<ReturnType<typeof renderPage>>;
      try {
        const url = normalizeUrl(raw);
        result =
          (await fromSites(url, sites, options, ctx.logger)) ?? (await readGeneric(url, options));
        output = renderPage(result.page, offset);
      } catch (error) {
        const failure =
          error instanceof FetchError && error.kind !== 'aborted'
            ? new ToolError(fetchErrorTexts[error.kind])
            : error;
        // 说明文字里没有 URL 与网页内容
        if (failure instanceof ToolError) {
          ctx.logger.info({ mode, reason: failure.message }, 'fetch.failed');
        }
        throw failure;
      }
      // 不记 URL、标题与内容
      const { page, status, truncated, jina } = result;
      ctx.logger.info(
        {
          method: page.method,
          status,
          mode,
          contentLength: 'content' in page ? page.content.length : undefined,
          truncated,
          jina,
        },
        'fetch.done',
      );
      return output;
    },
  });
}

export const fetchTool = createFetchTool();

/** fetch 插件：只有 fetch 这一个工具。列进插件清单 plugins/index.ts */
export const fetchPlugin = definePlugin({ name: 'fetch', tools: [fetchTool] });

/** 去掉首尾空白；没写协议的（example.com/a、www.example.com）补成 https */
function normalizeUrl(raw: string): URL {
  const text = raw.trim();
  // 冒号后面是数字的是端口（example.com:8080），不是协议
  const withScheme = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ToolError('网址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('仅支持 http 和 https');
  }
  return url;
}

/**
 * 第一个认得这个网址的站点处理器来处理；它不处理或失败时返回 undefined，走通用流程。
 * 每次记一条 fetch.site：处理器名字与结果（用了、不处理、失败），不记网址与内容
 */
async function fromSites(
  url: URL,
  sites: readonly SiteHandler[],
  { requester, signal, mode }: ReadOptions,
  logger: Logger,
): Promise<ReadResult | undefined> {
  const site = sites.find((handler) => handler.matches(url));
  if (!site) return undefined;
  try {
    const page = await site.read(url, { requester, signal, mode, logger });
    logger.info({ site: site.name, outcome: page ? 'used' : 'declined' }, 'fetch.site');
    return page && { page, truncated: page.notes.includes(truncatedNote), jina: false };
  } catch (error) {
    if (signal.aborted) throw error;
    logger.info({ site: site.name, outcome: 'failed' }, 'fetch.site');
    return undefined;
  }
}
