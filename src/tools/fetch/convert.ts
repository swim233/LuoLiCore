import { gfm } from '@joplin/turndown-plugin-gfm';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

// linkedom 的类型依赖 DOM 库（本项目不引入），这两个实际都是 any
type HtmlDocument = ReturnType<typeof parseHTML>['document'];
type HtmlElement = HtmlDocument['body'];

/** 读网页的方式：正文模式只取文章正文，整页模式去掉脚本、导航等之后整页转换 */
export type FetchMode = 'article' | 'page';

/** HTML 转成 Markdown 的结果 */
export type Converted = {
  markdown: string;
  /** 实际用的方式：正文模式取不出正文时退成整页 */
  mode: FetchMode;
  title?: string;
  author?: string;
  publishedTime?: string;
  /** 用正文模式转换，且原页面里有评论区 */
  hasComments: boolean;
};

// 正文模式取出的文字（去掉空白）少于这么多字符时，退成整页转换
const minArticleChars = 200;
// 整页模式删掉的元素
const removedInPage = 'script, style, noscript, template, svg, nav, form, iframe';
// 评论区：id、class 里有这些词，或者 schema.org 的 Comment；合计文字够这么多才算
const commentWords = /comment|repl(?:y|ies)|discuss/i;
const commentItemType = /schema\.org\/Comment/i;
const minCommentChars = 100;

/** 把 HTML 转成 Markdown。url 是页面的最终 URL，用来补全相对链接 */
export function convertHtml(html: string, url: string, mode: FetchMode): Converted {
  return (mode === 'article' ? readArticle(html, url) : undefined) ?? readPage(html, url);
}

/** 正文模式：readability 取正文。取不出或太短时返回 undefined，由调用方退成整页 */
function readArticle(html: string, url: string): Converted | undefined {
  const document = parse(html, url);
  // readability 会改动 document，评论区要在它之前找
  const hasComments = findComments(document);
  // keepClasses：代码块的语言名在 class 里。charThreshold：第一轮取出的少于它时，readability 会
  // 放宽条件重试，评论区、侧栏就被收进来；改成与退成整页的门槛一致，200–500 字符的短文章不再混进评论
  const article = new Readability(document, {
    keepClasses: true,
    charThreshold: minArticleChars,
  }).parse();
  if (!article?.content || compact(article.textContent).length < minArticleChars) return undefined;
  return {
    markdown: toMarkdown(article.content, document),
    mode: 'article',
    title: article.title ?? undefined,
    // byline 常带着「作者：」「By」之类的前缀
    author: article.byline?.trim().replace(/^(?:作者|by)(?:\s*[:：]\s*|\s+)/i, '') || undefined,
    publishedTime: article.publishedTime ?? undefined,
    hasComments,
  };
}

/** 整页模式：删掉脚本、样式、导航、表单等，整个 body 转换 */
function readPage(html: string, url: string): Converted {
  const document = parse(html, url);
  for (const element of document.querySelectorAll(removedInPage)) element.remove();
  absolutizeLinks(document);
  const meta = (selector: string): string | undefined =>
    document.querySelector(selector)?.getAttribute('content') ?? undefined;
  return {
    markdown: toMarkdown(document.body?.innerHTML ?? '', document),
    mode: 'page',
    title: document.querySelector('title')?.textContent ?? undefined,
    author: meta('meta[name="author"]') ?? meta('meta[property="article:author"]'),
    publishedTime:
      meta('meta[property="article:published_time"]') ??
      meta('meta[name="article:published_time"]') ??
      meta('meta[itemprop="datePublished"]') ??
      meta('meta[name="pubdate"]') ??
      meta('meta[name="date"]'),
    hasComments: false,
  };
}

/** 解析成 document，设上 baseURI 与 documentURI：有 <base href> 时以它为准，相对于最终 URL 解析 */
function parse(html: string, url: string): HtmlDocument {
  // linkedom 不补省略的 <html>、<head>、<body>：没写 <body> 时自己包一层，否则内容不在 body 里
  const source = /<body[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html.replace(/<\/?(?:html|head)(?:\s[^>]*)?>/gi, '')}</body></html>`;
  const { document } = parseHTML(source);
  const base = document.querySelector('base[href]')?.getAttribute('href');
  Object.defineProperty(document, 'baseURI', { value: resolve(base, url) ?? url });
  Object.defineProperty(document, 'documentURI', { value: url });
  return document;
}

function resolve(uri: string | null | undefined, base: string): string | undefined {
  if (uri == null) return undefined;
  try {
    return new URL(uri, base).href;
  } catch {
    return undefined;
  }
}

// 整页模式自己补全相对链接（正文模式由 readability 补）：页内锚点在没有 <base> 时保持原样，
// javascript: 链接只留文字
function absolutizeLinks(document: HtmlDocument): void {
  const { baseURI, documentURI } = document as { baseURI: string; documentURI: string };
  for (const link of document.querySelectorAll('a[href]')) {
    const href: string = link.getAttribute('href');
    if (/^\s*javascript:/i.test(href)) link.removeAttribute('href');
    else if (!(href.startsWith('#') && baseURI === documentURI)) {
      link.setAttribute('href', resolve(href, baseURI) ?? href);
    }
  }
  for (const image of document.querySelectorAll('img[src]')) {
    const src: string = image.getAttribute('src');
    image.setAttribute('src', resolve(src, baseURI) ?? src);
  }
}

function findComments(document: HtmlDocument): boolean {
  const isCommentArea = (element: HtmlElement): boolean =>
    !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName) &&
    (commentWords.test(element.getAttribute('id') ?? '') ||
      commentWords.test(element.getAttribute('class') ?? '') ||
      commentItemType.test(element.getAttribute('itemtype') ?? ''));
  let chars = 0;
  for (const element of document.querySelectorAll('[id], [class], [itemtype]')) {
    if (!isCommentArea(element)) continue;
    // 嵌套的（评论区里的每条评论）只算最外层那个
    let parent = element.parentElement;
    while (parent && !isCommentArea(parent)) parent = parent.parentElement;
    if (!parent) chars += compact(element.textContent).length;
  }
  return chars >= minCommentChars;
}

let turndown: TurndownService | undefined;

/**
 * 交给 turndown 的是 HTML 字符串，由它自带的 domino 解析：linkedom 没有 HTMLTableElement.rows，
 * 直接交 linkedom 的节点，gfm 插件会跳过所有表格
 */
function toMarkdown(html: string, document: HtmlDocument): string {
  turndown ??= new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  }).use(gfm);
  const pages = [document.documentURI, document.baseURI].map(withoutHash);
  return (
    turndown
      .turndown(html)
      // data: 内联图片换成 alt 文字，没有 alt 就去掉
      .replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, '$1')
      // 文字为空、只指向页内锚点的链接
      .replace(/\[\s*\]\(([^)\s]*)\)/g, (link, target: string) =>
        isPageAnchor(target, pages) ? '' : link,
      )
      // 连续的空行压成一个
      .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
      .trim()
  );
}

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

function isPageAnchor(target: string, pages: string[]): boolean {
  const hash = target.indexOf('#');
  if (hash === -1) return false;
  const page = target.slice(0, hash);
  return page === '' || pages.includes(page);
}

function compact(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

// 页面要 JavaScript 才能显示时常见的提示
const javaScriptNotices = [
  /enable\s+javascript/i,
  /javascript\s+is\s+(?:required|disabled|not\s+(?:enabled|available))/i,
  /requires?\s+javascript/i,
  /(?:开启|启用|打开|允许)\s*javascript/i,
  /需要\s*javascript/i,
  /javascript\s*(?:被禁用|未启用|未开启)/i,
];
// 转出的正文（去掉图片）少于这么多字符，算没取到
const minContentChars = 200;
// 只在正文不长时看上面的提示：长文章里提到「开启 JavaScript」多半是正文的一部分
const maxNoticeChars = 1000;

/** 本地转换的结果是否太差，要交给 r.jina.ai：太短，或者像「请开启 JavaScript」的提示页 */
export function isPoorConversion(markdown: string): boolean {
  const text = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  if (text.length < minContentChars) return true;
  return text.length < maxNoticeChars && javaScriptNotices.some((notice) => notice.test(text));
}
