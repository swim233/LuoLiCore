import { Lexer, Tokenizer } from 'marked';
import type { Token } from 'marked';

/* Markdown 的词法分析（marked 的 lexer）和一行预览。纯函数，不碰 DOM，也不输出 HTML：
   面板自己把词元画成 React 元素（components/Markdown.tsx），原始 HTML 当普通文字显示。
   - GFM 打开（表格、删除线、任务列表、网址自动成链接）；
   - breaks：一个回车就换行（模型写的样子），不把相邻的两行并成一段；
   - 没闭合的写法（半个 **、没写完的代码块）照原样：marked 本来就不把它们当格式
     （逐字输出时提前把它们排成最终的样子，在 stream-md.ts 里，先把文字改一遍再交给这里）；
   - 不认 setext 标题（一行文字下面跟 --- 或 ===）：`---` 是分隔线，`===` 是普通文字（见 PanelTokenizer）；
   - 中文里的加粗、斜体、HTML 实体的解法见下面两节（marked 的 Tokenizer 上各改一处）。 */
const OPTIONS = { gfm: true, breaks: true } as const;

/* ---- 中日韩文字旁的加粗、斜体 ----
   CommonMark 规定：开头的 ** 后面是标点时，前面必须是空白或标点；结尾的 ** 前面是标点时，后面必须是空白或标点。
   英文里这条很少碰到，中文里却处处是：「**注意：**请先备份」「说**「引号」**内容」。中文没有空格，
   标点和文字总是挨着，于是星号原样露了出来。这里照社区的 CJK 友好方案（markdown-cjk-friendly）放宽，
   看 ** 紧挨着的字符：
   - 开头的 *：前面是中日韩文字，或后面是全角标点，当作前面是空白；
   - 结尾的 *：后面是中日韩文字，或前面是全角标点，不再要求后面是空白或标点。
   只放宽 *（下划线在词中本来就不当格式，中文里同理）；两边都没有中日韩文字、全角标点时，规则和 marked 自己的完全一样。
   已知的取舍：*他说：**重点**，对* 这种斜体里套加粗、加粗又紧跟在全角标点后的写法会错位，中文回复里几乎不用。 */
const CJK_CLASS = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`;
// 全角标点：中日韩符号和标点（、。「」《》【】……）、全角形式（，！？：；（）……）
const FULL_PUNCT_CLASS = String.raw`[\u3000-\u303F\uFF00-\uFFEF]`;
const CJK_ONE = new RegExp(`^${CJK_CLASS}$`, 'u');
const STARS_THEN_FULL_PUNCT = new RegExp(`^\\*+${FULL_PUNCT_CLASS}`, 'u');

/* marked 判断结尾 * 的那条正则里，「前面是标点、后面是空白或行尾」这一支只出现一次，在它的后面加两种情况 */
const CLOSER_TAIL = String.raw`(\*+)(?=[\s]|$)`;
const relaxedClosers = new WeakMap<RegExp, RegExp>(); // marked 的规则表是共用的：每条只改一次
function relaxClosers(rdelim: RegExp): RegExp {
  let out = relaxedClosers.get(rdelim);
  if (!out) {
    // marked 改了写法时找不到这一段：放弃放宽，照原样
    const relaxed = String.raw`(\*+)(?=[\s]|$|${CJK_CLASS}|(?<=${FULL_PUNCT_CLASS}\*+))`;
    out = rdelim.source.includes(CLOSER_TAIL)
      ? new RegExp(rdelim.source.replace(CLOSER_TAIL, relaxed), rdelim.flags)
      : rdelim;
    relaxedClosers.set(rdelim, out);
  }
  return out;
}

/* ---- HTML 实体 ----
   marked 的文字片段是给 HTML 输出准备的：有数字写法的实体（&#38;）时，会把同一段里单独的 & 也改成 &amp;，
   名字写法的（&amp; &lt;）不解。面板画的是 React 文字，不再二次转义，所以文字片段自己解：
   数字写法和最常见的六个名字；别的名字（&copy; 等）没有现成的表，原样显示。代码里的不解（CommonMark 也是）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (_m, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name];
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
      ? '\ufffd'
      : String.fromCodePoint(cp);
  });
}

class PanelTokenizer extends Tokenizer {
  /* 不认 setext 标题：模型几乎不这样写，`文字\n---` 本意是分隔线；而且逐字输出时 `文字\n-` 会先闪成标题、下一个字到了又变回来。
     关掉以后：`---` 照分隔线，`===` 和 `-` 是段落里普通的一行（marked 的段落规则本来就不拿 setext 当打断的条件）。`#` 开头的标题不变 */
  override lheading(): undefined {
    return undefined;
  }

  /* 文字片段：按原文自己解实体（见上）。html 原始块里的文字 marked 本来就不解，照旧 */
  override inlineText(src: string) {
    const token = super.inlineText(src);
    if (token && !token.escaped) token.text = decodeEntities(token.raw);
    return token;
  }

  /* 开头的 *：前面是中日韩文字、后面是标点（如「说**「引号」**」）时，按前面是空白交给 marked */
  override emStrong(src: string, maskedSrc: string, prevChar = '') {
    if (src.startsWith('*') && (CJK_ONE.test(prevChar) || STARS_THEN_FULL_PUNCT.test(src))) {
      prevChar = ' ';
    }
    return super.emStrong(src, maskedSrc, prevChar);
  }
}

/* ---- 段落后面直接跟 --- ----
   marked 的段落规则里有一条「下一行起是表格就打断」，它的分隔行写法不要求有 | 或 :，所以 `a\nb\n---`（多行段落后面直接跟分隔线，没有空行）
   里 `b\n---` 被当成表格的开头，段落在 b 前面断开：b 自成一段。可 marked 真正认表格时（Tokenizer.table）要求分隔行里有 | 或 :，
   `b\n---` 不是表格，于是 b 单独一段、再一条分隔线（段间距比换行大）。这里给段落规则的分隔行加同样的要求，
   `a\nb\n---` 就是一个段落（a、b 两行）加一条分隔线 */
const TABLE_DELIM = String.raw`((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)`;
const paragraphRules = new WeakMap<RegExp, RegExp>();
function paragraphRule(paragraph: RegExp): RegExp {
  let out = paragraphRules.get(paragraph);
  if (!out) {
    // marked 改了写法时找不到这一段：放弃，照原样
    out = paragraph.source.includes(TABLE_DELIM)
      ? new RegExp(
          paragraph.source.replace(TABLE_DELIM, String.raw`(?=[^\n]*[:|])` + TABLE_DELIM),
          paragraph.flags,
        )
      : paragraph;
    paragraphRules.set(paragraph, out);
  }
  return out;
}

function newLexer(): Lexer {
  const tokenizer = new PanelTokenizer();
  const lexer = new Lexer({ ...OPTIONS, tokenizer });
  // Lexer 的构造里才把词法规则交给 tokenizer，规则表是 marked 共用的，换一份自己的再改
  const { block, inline } = tokenizer.rules;
  tokenizer.rules = {
    ...tokenizer.rules,
    block: { ...block, paragraph: paragraphRule(block.paragraph) },
    inline: { ...inline, emStrongRDelimAst: relaxClosers(inline.emStrongRDelimAst) },
  };
  return lexer;
}

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
  const tokens = newLexer().lex(text);
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
        const tail = newLexer().lex(rest);
        if (rawOf(tail) === rest && !tail.some((t) => t.type === 'def')) {
          this.text = text;
          this.tokens = [...this.tokens.slice(0, keep), ...tail];
          return this.tokens;
        }
      }
    }
    const tokens = newLexer().lex(text);
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
