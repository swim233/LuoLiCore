import { Tokenizer } from 'marked';

/* 我们对 marked 词法分析的几处改动（Tokenizer 的子类，加上改过的两条规则）：
   - 不认 setext 标题（一行文字下面跟 --- 或 ===）：`---` 是分隔线，`===` 是普通文字（见 MarkdownTokenizer）；
   - 中文里的加粗、斜体，HTML 实体的解法见下面两节（marked 的 Tokenizer 上各改一处）；
   - 段落后面直接跟 `---` 是段落加分隔线（见最后一节）。 */

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
   名字写法的（&amp; &lt;）不解。词元的文字片段要是人看到的样子（用的地方不再输出 HTML、不二次转义），所以文字片段自己解：
   数字写法和最常见的六个名字；别的名字（&copy; 等）没有现成的表，原样留着。代码里的不解（CommonMark 也是）。 */
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

export class MarkdownTokenizer extends Tokenizer {
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

/**
 * Lexer 的构造里才把词法规则交给 tokenizer，规则表是 marked 共用的：构造之后换一份自己的再改
 * （段落规则、结尾 * 的规则），不动共用的那份
 */
export function useOwnRules(tokenizer: Tokenizer): void {
  const { block, inline } = tokenizer.rules;
  tokenizer.rules = {
    ...tokenizer.rules,
    block: { ...block, paragraph: paragraphRule(block.paragraph) },
    inline: { ...inline, emStrongRDelimAst: relaxClosers(inline.emStrongRDelimAst) },
  };
}
