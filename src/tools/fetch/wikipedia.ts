import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { bodyToMarkdown, type HtmlDocument } from './convert.js';
import { truncatedNote, type Page } from './page.js';
import { defaultUserAgents } from './request.js';
import type { SiteContext, SiteHandler } from './sites.js';

// 维基百科：REST 接口取摘要（page/summary）与正文（page/mobile-html），正文按节转成 Markdown

// 自报身份的 bot
const userAgent = defaultUserAgents[1]!;

export type WikipediaOptions = {
  /** 某个语言站点的地址，默认 https://{语言}.wikipedia.org。测试里指向本地服务 */
  origin?: (lang: string) => string;
};

// {lang}.wikipedia.org 与手机版 {lang}.m.wikipedia.org
const host = /^([a-z][a-z\d-]*)\.(?:m\.)?wikipedia\.org$/;
// 中文站的变体路径，如 /zh-tw/标题；同时决定简繁（Accept-Language）
const zhVariants = new Set([
  'zh-cn',
  'zh-tw',
  'zh-hk',
  'zh-sg',
  'zh-mo',
  'zh-my',
  'zh-hans',
  'zh-hant',
]);

type Route = { lang: string; title: string; variant?: string };

function route(url: URL): Route | undefined {
  const lang = url.hostname.match(host)?.[1];
  if (!lang || lang === 'www') return undefined;
  const [, prefix = '', ...rest] = url.pathname.split('/');
  const variant = lang === 'zh' && zhVariants.has(prefix) ? prefix : undefined;
  if (prefix !== 'wiki' && variant === undefined) return undefined;
  // 标题里可以有 /（子页面）；#章节 不在 pathname 里，读整篇
  let title: string;
  try {
    title = decodeURIComponent(rest.join('/'));
  } catch {
    return undefined;
  }
  return title === '' ? undefined : { lang, title, variant };
}

/** 造维基百科的处理器。清单里用默认地址造的那一份 */
export function createWikipediaHandler({
  origin = (lang) => `https://${lang}.wikipedia.org`,
}: WikipediaOptions = {}): SiteHandler {
  return {
    name: 'wikipedia',
    matches: (url) => route(url) !== undefined,
    async read(url, ctx) {
      const target = route(url);
      return target && readArticle(url, target, origin(target.lang), ctx);
    },
  };
}

const summarySchema = z.object({
  type: z.string().nullish(),
  title: z.string(),
  displaytitle: z.string().nullish(),
  description: z.string().nullish(),
  extract: z.string().nullish(),
});

async function readArticle(
  url: URL,
  { lang, title, variant }: Route,
  site: string,
  ctx: SiteContext,
): Promise<Page | undefined> {
  const path = encodeURIComponent(title.replaceAll(' ', '_'));
  // 中文站按变体路径决定简繁，没有变体时用简体；其他语言发该站的语言代码，盖掉请求器默认的
  // zh-CN 偏好（有变体的语言，如塞尔维亚语，就用站点的默认写法）
  const language = lang === 'zh' ? (variant ?? 'zh-cn') : lang;
  const get = (endpoint: string, accept: string) =>
    ctx.requester.get(`${site}/api/rest_v1/page/${endpoint}/${path}`, {
      userAgent,
      headers: { accept, 'accept-language': language },
      signal: ctx.signal,
    });
  const [summaryResponse, htmlResponse] = await Promise.all([
    get('summary', 'application/json'),
    get('mobile-html', 'text/html'),
  ]);
  // 非 2xx（含条目不存在的 404）交回通用流程
  if (summaryResponse.status !== 200 || htmlResponse.status !== 200) {
    await Promise.all([summaryResponse.discard(), htmlResponse.discard()]);
    return undefined;
  }
  const [summaryText, html] = await Promise.all([summaryResponse.text(), htmlResponse.text()]);
  let summary: z.infer<typeof summarySchema>;
  try {
    const parsed = summarySchema.safeParse(JSON.parse(summaryText.text));
    if (!parsed.success) return undefined;
    summary = parsed.data;
  } catch {
    return undefined;
  }

  const extract = summary.extract?.trim();
  // 相对链接按条目的网页地址补全
  const page = new URL(`/wiki/${path}`, url).href;
  const body = bodyToMarkdown(html.text, page, (document) => prepare(document, extract));
  return {
    url: url.href,
    title: (summary.displaytitle && textOf(summary.displaytitle)) || summary.title,
    method: '维基百科接口',
    notes: [
      ...(html.truncated ? [truncatedNote] : []),
      ...(summary.type === 'disambiguation' ? ['这是消歧义页'] : []),
    ],
    content: [summary.description && `简介：${summary.description.trim()}`, extract, body]
      .filter(Boolean)
      .join('\n\n'),
  };
}

// 去掉的元素：参考文献角标、编辑链接、导航框、隐藏的元素、样式与脚本，以及页首的标题区
const removed = [
  'script',
  'style',
  'link',
  'meta',
  'noscript',
  'header',
  'footer',
  'sup.mw-ref',
  'sup.reference',
  '.mw-editsection',
  '.pcs-edit-section-link-container',
  '.pcs-edit-section-link',
  '.navbox',
  '.vertical-navbox',
  '.navbox-styles',
  '[role="navigation"]',
  '[hidden]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '.mw-empty-elt',
].join(', ');

// App 的界面元素：折叠表格的标题与按钮、展开节的按钮、折叠线
const appChrome = [
  '.pcs-collapse-table-collapsed-container',
  '.pcs-collapse-table-collapsed-bottom',
  '.pcs-section-control',
  'hr.pcs-fold-hr',
].join(', ');

// 跳过的节（按标题，不分大小写）；繁体是 /zh-tw/ 等变体下的写法（各变体用字不一，如注釋、註釋）
const skippedSections = new Set(
  [
    '参考文献',
    '参考资料',
    '注释',
    '注解',
    '外部链接',
    '参见',
    '延伸阅读',
    '相关条目',
    '參考文獻',
    '參考資料',
    '注釋',
    '註釋',
    '註解',
    '外部連結',
    '外部鏈接',
    '參見',
    '延伸閱讀',
    '相關條目',
    'references',
    'notes',
    'external links',
    'see also',
    'further reading',
  ].map((name) => name.toLowerCase()),
);

function prepare(document: HtmlDocument, extract: string | undefined): void {
  // mobile-html 是给 App 用的：导语以外的节、折叠起来的表格（含信息框）都先用 display: none
  // 藏着，等脚本展开。先展开它们，去掉折叠的按钮与说明，再删真正隐藏的元素
  for (const element of document.querySelectorAll('section[style], .pcs-collapse-table-content')) {
    element.removeAttribute('style');
  }
  for (const element of document.querySelectorAll(appChrome)) element.remove();
  for (const element of document.querySelectorAll(removed)) element.remove();
  const sections = [...document.querySelectorAll('section')];
  for (const section of sections) {
    // 第 0 节是导语，没有标题；其余节的第一个标题就是它自己的
    if (section.getAttribute('data-mw-section-id') === '0') continue;
    const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
    const name = (heading?.textContent ?? '').trim().toLowerCase();
    if (skippedSections.has(name)) section.remove();
  }
  // 摘要已放在正文开头：导语里与摘要重复的段落去掉，其余（信息框等）保留
  const lead = document.querySelector('section[data-mw-section-id="0"]') ?? sections[0];
  if (!lead || !extract) return;
  const summary = compact(extract);
  for (const paragraph of lead.querySelectorAll('p')) {
    const text = compact(paragraph.textContent);
    if (text !== '' && summary.includes(text)) paragraph.remove();
  }
}

function compact(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** displaytitle 是 HTML（可能带 <span>、<i>），取文字 */
function textOf(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return (document.body?.textContent ?? '').trim();
}
