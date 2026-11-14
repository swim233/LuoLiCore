import type {
  MarkedOptions,
  Tokenizer,
  TokenizerExtensionFunction,
  TokenizerStartFunction,
} from 'marked';
import { MarkdownTokenizer } from './tokenizer.js';

/* ---- 公式（可选，lex 的 math 选项打开时才认） ----
   公式的内容原样留着（LaTeX 的原文，去掉首尾的空白），不解析里面的 * _ \ 等符号。
   单独成块的：
   - 从行首的 $$（前面最多三个空格）起，到后面遇到的第一个 $$ 为止，这个 $$ 后面是行尾（可以有空格）；
     中间可以跨几行、不能有空行，内容可以有单个的 $，写了反斜杠的 \$ 不算分界。$$ 贴着内容的首尾、各占一行、
     只有一头单独占一行都行。遇到的第一个 $$ 后面不是行尾（「$$a$$ 和 $$b$$」）、中间有空行、到文字结束都没有
     结尾：不是块，照原样的字，里面的行内公式照认。\[ … \] 同样（到第一个 \] 为止）；
   - 语言标成 math 的围栏代码块（语言的第一个词不分大小写是 math，闭合了的）；
   - 紧跟在一段文字的下一行时也认（打断段落）；列表项、引用里也认。
   行内的：
   - \( 内容 \)，以及没占整行的 $$ 内容 $$、\[ 内容 \]：中间不换行，内容不空；
   - $内容$：开头的 $ 后面紧跟内容，结尾的 $ 前面紧贴内容、后面不是数字，中间不换行，内容不空。
     「这个 $5，那个 $10」「$HOME 和 $PATH」「价格是$5,另一个是$10」都不算。
   写了反斜杠的 \$ 是字面的 $；行内代码、代码块里的不算；没闭合的照原样（$$ 的块到文字结束都没有结尾时整个不当公式）。

   接法：不用 marked 的全局设置。lex 打开公式时，把下面这些扩展（marked 内部的形状）直接交给这一次新建的 Lexer，
   另外用 MathTokenizer 在找加粗、斜体、删除线的结尾时把公式遮住。关着时什么都不加，和没有这个功能时一样。 */

/** 单独成块的公式：和段落、代码块平级（在列表项、引用里就是它们里面的块）。text 是公式的内容 */
export type BlockMathToken = { type: 'blockMath'; raw: string; text: string };

/** 行内的公式：出现在段落、标题、列表项、表格的格子等行内的地方。text 是公式的内容 */
export type InlineMathToken = { type: 'inlineMath'; raw: string; text: string };

/* 单独成块的：行首的 $$（\[）到遇到的第一个 $$（\]），它后面是行尾。内容里写了反斜杠的两个字符成对跳过
   （\$ 不算分界）；$$ 的内容可以有单个 $，但越不过 $$，所以停在第一个 $$ 上，它后面不是行尾就整个不算 */
const BLOCK_RULES = [
  /^ {0,3}\$\$((?:\\[\s\S]|[^\\$]|\$(?!\$))*?)\$\$[ \t]*(?:\n|$)/,
  /^ {0,3}\\\[((?:\\(?!\])[\s\S]|[^\\])*?)\\\][ \t]*(?:\n|$)/,
];
// 中间有空行（只有空白的一行）就不算块公式
const BLANK_LINE = /\n[ \t]*\n/;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;
// 下一行起可能是单独成块的公式（$$、\[ 开头）：段落到这一行之前为止，先试公式
const BLOCK_START = /\n {0,3}(?:\$\$|\\\[)/;

/* 行内的：从某个位置开始试（sticky）。内容里写了反斜杠的两个字符成对跳过（\$ 不是结尾）；
   $…$、$$…$$ 的内容里不能有 $（「$$x$ 和 a$$」不是一个公式） */
const INLINE_DOUBLE = /\$\$((?:\\[^\n]|[^\\\n$])+?)\$\$/y;
const INLINE_DOLLAR = /\$(?![\s$])((?:\\[^\n]|[^\\\n$])*?(?:\\[^\n]|[^\\\s$]))\$(?!\d)/y;
const INLINE_BRACKET = /\\\[((?:\\[^\]\n]|[^\\\n])+?)\\\]/y;
const INLINE_PAREN = /\\\(((?:\\[^)\n]|[^\\\n])+?)\\\)/y;
// 行内的公式可能从这里开始：$、\(、\[
const INLINE_START = /\$|\\[([]/;

/**
 * src 里从 at 开始的行内公式：[原文的长度, 内容]，不是时 undefined。
 * afterDollar：前面紧挨着一个没成公式的 $（如 $$x$ 里第二个 $），这时不从这里开始，免得半个 $$ 变成 $…$
 */
function inlineMathAt(
  src: string,
  at: number,
  afterDollar: boolean,
): [length: number, text: string] | undefined {
  const c = src[at];
  const rules =
    c === '$'
      ? afterDollar
        ? []
        : [INLINE_DOUBLE, INLINE_DOLLAR]
      : c === '\\'
        ? [INLINE_BRACKET, INLINE_PAREN]
        : [];
  for (const rule of rules) {
    rule.lastIndex = at;
    const match = rule.exec(src);
    const text = match?.[1]!.trim();
    if (match && text) return [match[0].length, text];
  }
  return undefined;
}

/** 围栏代码块闭合了：最后一行是同样的符号、不比开头的短 */
function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\n$/, '').split('\n');
  const open = FENCE_START.exec(lines[0]!)?.[1];
  const close = lines.length > 1 ? /^ {0,3}(`{3,}|~{3,}) *$/.exec(lines.at(-1)!)?.[1] : undefined;
  return !!open && !!close && close[0] === open[0] && close.length >= open.length;
}

/** 单独成块的公式；围栏代码块交给这次分析用的 tokenizer 认（和代码块的认法一样），再看语言 */
const blockMath =
  (tokenizer: Tokenizer): TokenizerExtensionFunction =>
  (src) => {
    for (const rule of BLOCK_RULES) {
      const match = rule.exec(src);
      const text = match?.[1]!.trim();
      if (match && text && !BLANK_LINE.test(match[1]!)) {
        return { type: 'blockMath', raw: match[0], text } satisfies BlockMathToken;
      }
    }
    if (!FENCE_START.test(src)) return undefined;
    const fence = tokenizer.fences(src);
    const text = fence?.text.trim();
    if (
      !fence ||
      !text ||
      fence.lang?.split(/\s/)[0]?.toLowerCase() !== 'math' ||
      !fenceClosed(fence.raw)
    ) {
      return undefined;
    }
    return { type: 'blockMath', raw: fence.raw, text } satisfies BlockMathToken;
  };

const inlineMath: TokenizerExtensionFunction = function (src, tokens) {
  const prev = tokens.at(-1);
  const found = inlineMathAt(src, 0, prev?.type === 'text' && prev.raw.endsWith('$'));
  if (!found) return undefined;
  return {
    type: 'inlineMath',
    raw: src.slice(0, found[0]),
    text: found[1],
  } satisfies InlineMathToken;
};

/* marked 把段落、文字截到返回的位置之前（下标从 src 的第二个字算起），好让扩展先试 */
const startBlock: TokenizerStartFunction = (src) => {
  const match = BLOCK_START.exec(src);
  return match ? match.index + 1 : undefined;
};
const startInline: TokenizerStartFunction = (src) => {
  const at = src.search(INLINE_START);
  return at < 0 ? undefined : at;
};

/** 交给 Lexer 的公式扩展（marked 内部的形状，不经过 marked.use()）；每次分析新建，tokenizer 是这次用的 */
export function mathExtensions(tokenizer: Tokenizer): NonNullable<MarkedOptions['extensions']> {
  return {
    renderers: {},
    childTokens: {},
    block: [blockMath(tokenizer)],
    inline: [inlineMath],
    startBlock: [startBlock],
    startInline: [startInline],
  };
}

/**
 * 找加粗、斜体、删除线的结尾时看的「遮过的原文」（marked 已经遮住了代码、链接、转义）里，再把公式遮住：
 * 公式里的 * _ ~ 不能当成结尾。src 是还没分析的原文，和 maskedSrc 的末尾对齐；
 * 从 src 开头往后找公式，找法和行内的扩展一样（$ 没被遮住、\( \[ 是 marked 遮成的 ++ 才算开头）
 */
function maskMath(src: string, maskedSrc: string): string {
  if (!src.includes('$') && !src.includes('\\')) return maskedSrc;
  const offset = maskedSrc.length - src.length;
  let out = '';
  let copied = 0;
  let afterDollar = false;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const opener =
      c === '$'
        ? maskedSrc[offset + i] === '$'
        : c === '\\' &&
          (src[i + 1] === '(' || src[i + 1] === '[') &&
          maskedSrc.startsWith('++', offset + i);
    const found = opener ? inlineMathAt(src, i, afterDollar) : undefined;
    if (found) {
      out += maskedSrc.slice(offset + copied, offset + i) + 'a'.repeat(found[0]);
      i += found[0];
      copied = i;
      afterDollar = false;
      continue;
    }
    afterDollar = c === '$';
    i += c === '\\' ? 2 : 1;
  }
  if (copied === 0) return maskedSrc;
  return maskedSrc.slice(0, offset) + out + maskedSrc.slice(offset + copied);
}

/** 打开公式时用的 tokenizer：找加粗、斜体、删除线的结尾时把公式遮住 */
export class MathTokenizer extends MarkdownTokenizer {
  override emStrong(src: string, maskedSrc: string, prevChar = '') {
    const masked = src[0] === '*' || src[0] === '_' ? maskMath(src, maskedSrc) : maskedSrc;
    return super.emStrong(src, masked, prevChar);
  }

  override del(src: string, maskedSrc: string, prevChar = '') {
    return super.del(src, src[0] === '~' ? maskMath(src, maskedSrc) : maskedSrc, prevChar);
  }
}
