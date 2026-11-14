import { lex } from '@luoli/markdown';
import type { Token } from 'marked';

/* Markdown 的词法分析和一行预览。分析的规则（GFM、一个回车就换行、中日韩文字旁的加粗和斜体、HTML 实体、
   不认 setext 标题等）在 @luoli/markdown 里，和 Telegram 前端共用；面板不认公式。这里只有面板自己的：
   缓存、逐字输出时的增量分析、一行预览。纯函数，不碰 DOM，也不输出 HTML：面板自己把词元画成 React 元素
   （components/Markdown.tsx），原始 HTML 当普通文字显示。
   没闭合的写法（半个 **、没写完的代码块）照原样；逐字输出时提前把它们排成最终的样子，在 stream-md.ts 里，
   先把文字改一遍再交给这里。 */

/* 同一段文字常常要重复分析（虚拟列表把行重新挂上、会话列表每次重画）：最近的若干段缓存起来。词元只读，不要改 */
const LEX_CACHE = 300;
const lexed = new Map<string, Token[]>();
export function lexMarkdown(text: string): Token[] {
  const hit = lexed.get(text);
  if (hit) {
    lexed.delete(text);
    lexed.set(text, hit);
    return hit;
  }
  const tokens = lex(text);
  lexed.set(text, tokens);
  if (lexed.size > LEX_CACHE) lexed.delete(lexed.keys().next().value!);
  return tokens;
}

/* 逐字输出时每一帧多几个字，就要重新分析一次。长回复（几千字）不每帧把全文重来：前面写完的块沿用上一次的词元，
   只从倒数第二块起重新分析（最后一块还在长；倒数第二块也可能变：后面接上缩进的行，空行前后的列表并成一个；块之间的空行不算一块）。
   结果和整段重新分析完全一样（markdown.test.ts 里逐字比对），区别只是前面的块是同一批词元对象，界面上的块按原文比较就不会重画。
   交给它的文字不一定是上一次的延长（逐字时 stream-md.ts 把最后一行改过：补上结尾的符号、去掉还看不出是什么的符号，
   每一帧改的地方不一样）：只要前面的块在两次里一字不差就沿用，改动都在最后一两块里，所以通常还是只重新分析最后两块。
   前提：顶层词元的原文拼起来正好是原文；不是的话（对不上就不增量了）每次整段重来。
   不走 lexMarkdown 的缓存：逐字时每个前缀只用一次，塞进去会把别的消息的缓存挤掉 */
export class IncrementalLexer {
  private text = '';
  private tokens: Token[] = [];
  private whole = true; // 词元的原文拼得回原文，才能增量
  private defs = false; // 有链接定义（[名字]: 网址）：前后的块里的引用互相要用，不增量
  /* 最多沿用到倒数第二块「有内容的」之前。块之间的空行也是词元（space），不算一块：
     「1. 一\n\n2. 二」整段分析是一个松散列表，要是把 space 算成倒数第二块，前面的列表就不重排，会一直拆成两个列表 */
  private keepBlocks(): number {
    let keep = this.tokens.length;
    let blocks = 0;
    while (keep > 0 && blocks < 2) {
      keep--;
      if (this.tokens[keep].type !== 'space') blocks++;
    }
    return blocks < 2 ? 0 : keep;
  }
  lex(text: string): Token[] {
    if (text === this.text && this.tokens.length) return this.tokens;
    if (this.whole && !this.defs) {
      // 沿用的词元：不超过倒数第二块，原文也必须和新的文字开头一字不差
      const common = commonPrefix(this.text, text);
      const max = this.keepBlocks();
      let keep = 0;
      let at = 0;
      while (keep < max && at + this.tokens[keep].raw.length <= common)
        at += this.tokens[keep++].raw.length;
      if (keep > 0) {
        const rest = text.slice(at);
        const tail = lex(rest);
        if (rawOf(tail) === rest && !tail.some((t) => t.type === 'def')) {
          this.text = text;
          this.tokens = [...this.tokens.slice(0, keep), ...tail];
          return this.tokens;
        }
      }
    }
    const tokens = lex(text);
    this.whole = rawOf(tokens) === text.replace(/\r\n?/g, '\n');
    this.defs = tokens.some((t) => t.type === 'def');
    this.text = text;
    this.tokens = tokens;
    return tokens;
  }
}
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
const rawOf = (tokens: Token[]) => tokens.map((t) => t.raw).join('');

type Tk = Token & {
  tokens?: Token[];
  items?: Tk[];
  header?: { tokens: Token[] }[];
  rows?: { tokens: Token[] }[][];
  text?: string;
};

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t: Tk) => {
      switch (t.type) {
        case 'br':
          return ' ';
        case 'checkbox':
          return '';
        case 'image':
          return t.text ?? '';
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inlineText(t.tokens);
        default:
          // 文字、转义、行内代码、原始 HTML：就是它的文字
          return t.tokens ? inlineText(t.tokens) : (t.text ?? t.raw);
      }
    })
    .join('');
}

function blockText(tokens: Token[]): string {
  return tokens
    .map((t: Tk) => {
      switch (t.type) {
        case 'space':
        case 'hr':
        case 'def':
        case 'checkbox':
          return '';
        case 'list':
          return (t.items ?? []).map((it) => blockText(it.tokens ?? [])).join(' ');
        case 'blockquote':
          return blockText(t.tokens ?? []);
        case 'table':
          return [
            (t.header ?? []).map((c) => inlineText(c.tokens)),
            ...(t.rows ?? []).map((r) => r.map((c) => inlineText(c.tokens))),
          ]
            .flat()
            .join(' ');
        case 'code':
          return t.text ?? '';
        case 'html':
          return t.text ?? t.raw;
        default:
          return t.tokens ? inlineText(t.tokens) : (t.text ?? t.raw);
      }
    })
    .join(' ');
}

const PREVIEW_CACHE = 300;
const previews = new Map<string, string>();
const FENCE_MARKS = /`{3,}|~{3,}/g;
/**
 * 只显示一行的地方（会话列表的预览……）：去掉 Markdown 的符号，只留文字，换行和多余的空白压成一个空格。
 * 去完什么都不剩时（预览是被截断的，如只剩 ```python 这一行围栏）退回原文，只去掉围栏符号，不显示成「没有文字」
 */
export function plainPreview(text: string): string {
  const hit = previews.get(text);
  if (hit !== undefined) return hit;
  let out = blockText(lexMarkdown(text)).replace(/\s+/g, ' ').trim();
  if (out === '') out = text.replace(FENCE_MARKS, ' ').replace(/\s+/g, ' ').trim();
  previews.set(text, out);
  if (previews.size > PREVIEW_CACHE) previews.delete(previews.keys().next().value!);
  return out;
}
