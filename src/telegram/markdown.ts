import { lex, type BlockMathToken, type InlineMathToken, type Token } from '@luoli/markdown';
import { linkHref } from './link.js';
import type {
  InputRichBlock,
  InputRichBlockListItem,
  RichBlockTableCell,
  RichText,
} from './rich.js';

/* 洛璃的回复（Markdown 原文）转成富文本消息的块。分析用 @luoli/markdown（和面板同一套规则，另外认公式），
   转法参考面板怎么画词元（src/web/components/Markdown.tsx）：
   - 块：段落、标题（1 到 6 级）、代码块（pre，写了语言时带语言的第一个词）、块公式、分隔线、引用、列表（有序的
     带编号，任务列表带勾选框）、表格（第一行是表头；超过 20 列的改成代码块，显示原文）；原始 HTML 的块、不认识的
     当段落，文字是原文；一个字都没有的标题、里面什么都没有的代码块 Telegram 不收，也当段落，文字是原文；
     块之间的空行、链接定义不出块。
   - 行内：加粗、斜体、删除线、行内代码、行内公式、链接（[文字](网址) 和图片 ![说明](网址) 都成链接，网址照
     link.ts 的规则，不认的显示原文）；一个回车是 \n；正文里直接写的网址原样（Telegram 自己会认）；
     原始 HTML、不认识的当原文的字。 */

/** 顶层的一个块，连同它对应的原文（这个块的 raw，后面跟着的空行、链接定义也算它的）：退路发原文用 */
export type RichPart = { block: InputRichBlock; raw: string };

/** Telegram 的表格最多 20 列（2026-11-14 在真的接口上试过：20 列收，21 列不收） */
const TABLE_MAX_COLUMNS = 20;

// marked 的词元，按用到的字段放宽成一个类型
type Tk = Token & {
  text?: string;
  tokens?: Tk[];
  depth?: number;
  lang?: string;
  ordered?: boolean;
  start?: number | '';
  items?: Item[];
  header?: Cell[];
  rows?: Cell[][];
  align?: Array<'left' | 'center' | 'right' | null>;
  href?: string;
  autolink?: boolean;
};
type Item = { task: boolean; checked?: boolean; tokens: Tk[] };
type Cell = { tokens: Tk[] };

/** 一段原文转成顶层的块；全是空白、只有链接定义时没有块 */
export function markdownBlocks(text: string): RichPart[] {
  const parts: RichPart[] = [];
  // 不出块的词元（空行、链接定义）的原文：接在前一个块后面；还没有块时留给第一个块
  let leading = '';
  for (const token of lex(text, { math: true }) as Tk[]) {
    const block = toBlock(token);
    if (!block) {
      if (parts.length) parts.at(-1)!.raw += token.raw;
      else leading += token.raw;
      continue;
    }
    parts.push({ block, raw: leading + token.raw });
    leading = '';
  }
  return parts;
}

/** 块（含列表项、引用里面的）；不出块的为 undefined */
function toBlock(t: Tk): InputRichBlock | undefined {
  switch (t.type) {
    case 'space':
    case 'def':
    case 'checkbox':
      return undefined;
    case 'paragraph':
      return { type: 'paragraph', text: inline(t.tokens) };
    case 'text':
      // 紧凑列表里一项的那行字
      return {
        type: 'paragraph',
        text: inline(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text }]),
      };
    case 'heading': {
      const text = inline(t.tokens);
      // Telegram 不收一个字都没有的标题（RICH_MESSAGE_CONTENT_REQUIRED）：原文当段落
      if (!hasContent(text)) return { type: 'paragraph', text: trimEnd(t.raw) };
      return { type: 'heading', text, size: Math.min(Math.max(t.depth ?? 1, 1), 6) };
    }
    case 'code': {
      // 里面什么都没有的代码块 Telegram 也不收：原文当段落。只有空格、换行的照常
      if (!t.text) return { type: 'paragraph', text: trimEnd(t.raw) };
      const language = (t.lang ?? '').trim().split(/\s+/)[0];
      return { type: 'pre', text: t.text, ...(language ? { language } : {}) };
    }
    case 'blockMath':
      return { type: 'mathematical_expression', expression: (t as unknown as BlockMathToken).text };
    case 'hr':
      return { type: 'divider' };
    case 'blockquote':
      return { type: 'blockquote', blocks: blocksOrEmpty(t.tokens) };
    case 'list':
      return { type: 'list', items: (t.items ?? []).map((item, i) => listItem(t, item, i)) };
    case 'table':
      return table(t);
    default:
      // 原始 HTML 的块和不认识的：原文当字
      return { type: 'paragraph', text: trimEnd(t.raw) };
  }
}

/** 里面的块；一个都没有时放一个空文字的段落（空的列表项、空的引用） */
function blocksOrEmpty(tokens: Tk[] | undefined): InputRichBlock[] {
  const blocks = (tokens ?? []).flatMap((t) => toBlock(t) ?? []);
  return blocks.length ? blocks : [{ type: 'paragraph', text: '' }];
}

function listItem(list: Tk, item: Item, index: number): InputRichBlockListItem {
  const start = typeof list.start === 'number' ? list.start : 1;
  return {
    blocks: blocksOrEmpty(item.tokens),
    ...(item.task ? { has_checkbox: true as const } : {}),
    ...(item.task && item.checked ? { is_checked: true as const } : {}),
    ...(list.ordered ? { value: start + index, type: '1' as const } : {}),
  };
}

function table(t: Tk): InputRichBlock {
  const header = t.header ?? [];
  // 太宽的表 Telegram 不收：改成代码块，显示原文
  if (header.length > TABLE_MAX_COLUMNS) return { type: 'pre', text: trimEnd(t.raw) };
  const cell = (c: Cell, column: number, isHeader: boolean): RichBlockTableCell => ({
    text: inline(c.tokens),
    ...(isHeader ? { is_header: true as const } : {}),
    align: t.align?.[column] ?? 'left',
    valign: 'top',
  });
  return {
    type: 'table',
    cells: [
      header.map((c, k) => cell(c, k, true)),
      ...(t.rows ?? []).map((row) => row.map((c, k) => cell(c, k, false))),
    ],
    is_bordered: true,
  };
}

/** 行内的词元转成富文本。inLink：已经在链接的文字里（链接里不能再套链接，只留文字） */
function inline(tokens: Tk[] | undefined, inLink = false): RichText {
  return joined((tokens ?? []).map((t) => inlineOne(t, inLink)));
}

function inlineOne(t: Tk, inLink: boolean): RichText {
  switch (t.type) {
    case 'text':
      // 列表项、引用里的文字块自己带着行内词元；文字里的 HTML 实体包已经解过了
      return t.tokens ? inline(t.tokens, inLink) : (t.text ?? t.raw);
    case 'escape':
      return t.text ?? t.raw;
    case 'strong':
      return { type: 'bold', text: inline(t.tokens, inLink) };
    case 'em':
      return { type: 'italic', text: inline(t.tokens, inLink) };
    case 'del':
      return { type: 'strikethrough', text: inline(t.tokens, inLink) };
    case 'codespan':
      return { type: 'code', text: t.text ?? '' };
    case 'br':
      return '\n';
    case 'inlineMath':
      return {
        type: 'mathematical_expression',
        expression: (t as unknown as InlineMathToken).text,
      };
    case 'link': {
      // 正文里直接写的网址（没有尖括号）：原样的字，Telegram 自己会认
      if (t.autolink && !t.raw.startsWith('<')) return t.raw;
      const url = inLink ? null : linkHref(t.href ?? '');
      if (!url) return inLink ? inline(t.tokens, true) : t.raw;
      return { type: 'url', text: t.autolink ? (t.text ?? t.raw) : inline(t.tokens, true), url };
    }
    case 'image': {
      // 不嵌图片：显示成链接，文字是说明，没有说明就写网址
      const url = inLink ? null : linkHref(t.href ?? '');
      if (!url) return t.raw;
      return { type: 'url', text: t.text || (t.href ?? ''), url };
    }
    case 'checkbox':
      return '';
    default:
      // 原始 HTML 和不认识的：原文当字
      return t.raw;
  }
}

/** 几段富文本连起来：相邻的字符串并成一个，空字符串去掉；只有一段时不用数组包着，什么都没有时是空字符串 */
function joined(parts: RichText[]): RichText {
  const out: RichText[] = [];
  for (const part of parts.flatMap((p) => (Array.isArray(p) ? p : [p]))) {
    if (part === '') continue;
    const last = out.at(-1);
    if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part;
    else out.push(part);
  }
  if (out.length === 0) return '';
  return out.length === 1 ? out[0]! : out;
}

/**
 * 富文本里有没有字：有一个字符（空格也算）或者一个公式就算有；空的样式、字是空的链接不算（链接的网址不算字）。
 * 2026-11-15 在真的接口上试过，标题、代码块里这些都不收：空字符串、空数组、全是空字符串的数组、只有一个空的加粗、
 * 只有一个空的行内代码、只有一个字是空的链接；只有空格、只有换行的收，标题里只有一个行内公式的收
 */
function hasContent(text: RichText): boolean {
  if (typeof text === 'string') return text !== '';
  if (Array.isArray(text)) return text.some(hasContent);
  if (text.type === 'mathematical_expression') return true;
  return hasContent(text.text);
}

/**
 * 去掉末尾的换行。从后往前数，不用 /\n+$/：那样从每个换行起都往后扫，中间夹着一长串换行时是平方级的
 */
function trimEnd(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '\n') end--;
  return s.slice(0, end);
}
