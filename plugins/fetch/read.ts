import { describeImage, imageSize, isSupportedImage, ToolError } from '../../src/plugin-api.js';
import { decodeText } from './body.js';
import { convertHtml, isPoorConversion, type Converted, type FetchMode } from './convert.js';
import { readViaJina, type JinaOptions } from './jina.js';
import { truncatedNote, type Page } from './page.js';
import type { FetchResponse, Requester } from './request.js';

export type ReadOptions = {
  requester: Requester;
  jina: JinaOptions;
  signal: AbortSignal;
  mode: FetchMode;
};

/** 读的结果，连同记日志用的几项（不含 URL 与内容） */
export type ReadResult = {
  page: Page;
  /** 通用流程里网页的 HTTP 状态码；站点处理器的结果没有 */
  status?: number;
  /** 正文超过 5 MB 被截短 */
  truncated: boolean;
  /** 用了 r.jina.ai */
  jina: boolean;
};

// 已知的验证页：2xx，但最终 URL 是这些，说明网站要求验证，内容读不到。以后按实际加
const challengePages: Array<(url: URL) => boolean> = [
  // 微信公众号
  (url) => url.pathname.includes('/mp/wappoc_appmsgcaptcha'),
];

const commentsNote = '页面里有评论区，要看用 mode=page';
const javaScriptNote = '页面可能要 JavaScript 才能显示';

/** 通用流程：请求网页，按内容类型处理；HTML 转不出、或被拒时交给 r.jina.ai */
export async function readGeneric(url: URL, options: ReadOptions): Promise<ReadResult> {
  const response = await options.requester.get(url, { signal: options.signal });
  const { status } = response;
  if (response.rejected) {
    await response.discard();
    // 三个 User-Agent 都被拒：没有本地内容，jina 也失败时报最后一次的状态码
    return viaJina(
      response.url,
      status,
      undefined,
      options,
      `抓取失败：HTTP ${status}（r.jina.ai 也没取到）`,
    );
  }
  if (status < 200 || status > 299) {
    await response.discard();
    throw new ToolError(`抓取失败：HTTP ${status}`);
  }
  if (challengePages.some((matches) => matches(new URL(response.url)))) {
    await response.discard();
    throw new ToolError('网站要求验证，读不到');
  }

  const textual = (
    truncated: boolean,
    page: Pick<Page, 'title' | 'method'> & { content: string },
  ): ReadResult => ({
    page: { url: response.url, notes: truncated ? [truncatedNote] : [], ...page },
    status,
    truncated,
    jina: false,
  });

  switch (contentKind(response.mimeType)) {
    case 'markdown': {
      const { text, truncated } = await response.text();
      return textual(truncated, {
        title: markdownTitle(text),
        method: '服务端提供的 Markdown',
        content: text,
      });
    }
    case 'text': {
      const { text, truncated } = await response.text();
      return textual(truncated, { method: '纯文本', content: text });
    }
    case 'json': {
      const { text, truncated } = await response.text();
      return textual(truncated, { method: 'JSON', content: prettyJson(text) });
    }
    case 'html': {
      const { text, truncated } = await response.text();
      return fromHtml(text, truncated, response.url, status, options);
    }
    case 'unknown': {
      // 没写类型：看开头像不像 HTML；不含 NUL 字节就当纯文本
      const { bytes, truncated } = await response.bytes();
      const { text } = decodeText(bytes, null, truncated);
      if (/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(text)) {
        return fromHtml(text, truncated, response.url, status, options);
      }
      if (!bytes.includes(0)) return textual(truncated, { method: '纯文本', content: text });
      return other(response, status);
    }
    case 'image':
      return readImage(response, status);
    case 'other':
      await response.discard();
      return other(response, status);
  }
}

type ContentKind = 'markdown' | 'text' | 'json' | 'html' | 'image' | 'unknown' | 'other';

// 交给模型看的图片类型；其他图片（SVG、BMP、AVIF……）只给一行说明
const modelImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// 图片最多读这么多，再大的不交给模型
const maxImageBytes = 10 * 1024 * 1024;

// 按纯文本原样给模型的非 text/* 类型（text/* 除 HTML、Markdown 外都是纯文本）
const textTypes = new Set([
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
]);

// 顺序要紧：application/xhtml+xml 是 HTML、image/svg+xml 是图片，不按 *+xml 当纯文本
function contentKind(mimeType: string | undefined): ContentKind {
  if (mimeType === undefined) return 'unknown';
  if (mimeType.startsWith('image/')) return modelImageTypes.has(mimeType) ? 'image' : 'other';
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return 'html';
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'markdown';
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json';
  // CSV、XML（含 RSS、Atom）、脚本等文本
  if (mimeType.startsWith('text/') || mimeType.endsWith('+xml') || textTypes.has(mimeType)) {
    return 'text';
  }
  return 'other';
}

/**
 * 图片：不超过 10 MB 时读出来交给模型看，结果是头部加一行说明（类型、宽高、大小）。
 * 超过 10 MB（声明的或读到的）、或者文件头与类型不符时，只给一行说明
 */
async function readImage(response: FetchResponse, status: number): Promise<ReadResult> {
  const mediaType = response.mimeType!;
  const declared = contentLength(response);
  const line = (summary: string): ReadResult => ({
    page: { url: response.url, method: '图片', notes: [], summary },
    status,
    truncated: false,
    jina: false,
  });
  const size = declaredSize(response);
  const tooLarge = () =>
    line(`[图片超过 10 MB，没有交给模型：${mediaType}${size === undefined ? '' : `，${size}`}]`);
  if (declared !== undefined && declared > maxImageBytes) {
    await response.discard();
    return tooLarge();
  }
  const { bytes, truncated } = await response.bytes({ maxBytes: maxImageBytes });
  if (truncated) return tooLarge();
  if (!isSupportedImage({ data: bytes, mediaType })) {
    return line(`[图片无法识别：${mediaType}，${formatSize(bytes.length)}]`);
  }
  return {
    page: {
      url: response.url,
      method: '图片',
      notes: [],
      summary: describeImage({ mediaType, ...imageSize(bytes), bytes: bytes.length }),
      image: { data: bytes, mediaType },
    },
    status,
    truncated: false,
    jina: false,
  };
}

/** Content-Length；没给或看不懂时为 undefined */
function contentLength(response: FetchResponse): number | undefined {
  const value = response.headers.get('content-length');
  const length = value === null ? NaN : Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/**
 * 按 Content-Length 写的大小，如「1.2 MB」；响应压缩过（Content-Encoding 不是 identity）时它是
 * 压缩后的大小，写成「2 KB（压缩后）」。没有 Content-Length 时为 undefined
 */
function declaredSize(response: FetchResponse): string | undefined {
  const length = contentLength(response);
  if (length === undefined) return undefined;
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const compressed = encoding !== undefined && encoding !== '' && encoding !== 'identity';
  return compressed ? `${formatSize(length)}（压缩后）` : formatSize(length);
}

/** 非文本内容：不读正文，只给一行说明 */
function other(response: FetchResponse, status: number): ReadResult {
  const size = declaredSize(response) ?? '大小未知';
  return {
    page: {
      url: response.url,
      method: '非文本内容',
      notes: [],
      summary: `[非文本内容：${response.mimeType ?? '类型未知'}，${size}]`,
    },
    status,
    truncated: false,
    jina: false,
  };
}

/** HTML 转换；转出的东西太差时交给 r.jina.ai，jina 也失败时用本地的（有的话）并提示 */
async function fromHtml(
  html: string,
  truncated: boolean,
  url: string,
  status: number,
  options: ReadOptions,
): Promise<ReadResult> {
  const converted = convert(html, url, options.mode);
  const local = ({ markdown, mode, hasComments, ...meta }: Converted, notes: string[]) => ({
    page: {
      url,
      ...meta,
      method: mode === 'article' ? '本地转换（正文）' : '本地转换（整页）',
      notes: [
        ...(truncated ? [truncatedNote] : []),
        ...(hasComments ? [commentsNote] : []),
        ...notes,
      ],
      content: markdown,
    },
    status,
    truncated,
    jina: false,
  });
  if (converted && !isPoorConversion(converted.markdown)) return local(converted, []);
  return viaJina(
    url,
    status,
    converted?.markdown ? () => local(converted, [javaScriptNote]) : undefined,
    options,
    '抓取失败：页面内容取不到',
  );
}

function convert(html: string, url: string, mode: FetchMode): Converted | undefined {
  try {
    return convertHtml(html, url, mode);
  } catch {
    // 解析或转换出错：当作本地没有内容
    return undefined;
  }
}

/** 交给 r.jina.ai；失败时用本地的结果，没有就以 failure 报错 */
async function viaJina(
  url: string,
  status: number,
  fallback: (() => ReadResult) | undefined,
  { requester, jina: jinaOptions, signal }: ReadOptions,
  failure: string,
): Promise<ReadResult> {
  const jina = await readViaJina(requester, jinaOptions, url, signal);
  if (jina) {
    return {
      page: {
        url,
        title: jina.title,
        method: '经 r.jina.ai',
        notes: jina.truncated ? [truncatedNote] : [],
        content: jina.content,
      },
      status,
      truncated: jina.truncated,
      jina: true,
    };
  }
  if (fallback) return fallback();
  throw new ToolError(failure);
}

/** Markdown 的标题：开头 front matter 的 title，没有就取第一个 `# ` 标题 */
function markdownTitle(text: string): string | undefined {
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const title = frontMatter
    ?.match(/^title:[ \t]*(.*)$/m)?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  return title || text.match(/^#[ \t]+(.+)$/m)?.[1]?.trim();
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / 1024 / 1024;
  return megabytes < 1024
    ? `${Number(megabytes.toFixed(1))} MB`
    : `${Number((megabytes / 1024).toFixed(1))} GB`;
}
