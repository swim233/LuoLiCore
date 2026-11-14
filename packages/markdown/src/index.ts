import { Lexer, type Token } from 'marked';
import { MathTokenizer, mathExtensions } from './math.js';
import { MarkdownTokenizer, useOwnRules } from './tokenizer.js';

/* Markdown 的词法分析（marked 的 lexer 加我们的几处改动），面板和 Telegram 前端共用。纯函数，不碰 DOM、不用 Node 的模块，
   也不输出 HTML：用的地方自己把词元画出来，原始 HTML 当普通文字。
   - GFM 打开（表格、删除线、任务列表、网址自动成链接）；
   - breaks：一个回车就换行（模型写的样子），不把相邻的两行并成一段；
   - 没闭合的写法（半个 **、没写完的代码块）照原样：marked 本来就不把它们当格式；
   - 不认 setext 标题、中日韩文字旁的加粗和斜体、HTML 实体、段落后面直接跟 --- ：见 tokenizer.ts；
   - 公式是可选的（math 选项，默认不认）：见 math.ts。
   不用 marked 的全局设置（marked.use()、setOptions()）：每次分析新建分析器，各次的选项互不影响。 */

export type { Token } from 'marked';
export type { BlockMathToken, InlineMathToken } from './math.js';

export type LexOptions = {
  /** 认公式（$…$、$$…$$、\(…\)、\[…\]、math 围栏），见 math.ts；默认不认 */
  math?: boolean;
};

const OPTIONS = { gfm: true, breaks: true } as const;

/**
 * 把一段文字分析成词元。每次新建分析器，不缓存（要缓存的地方自己缓存）；词元只读，不要改。
 * 认不认公式只管这一次，不影响别的分析
 */
export function lex(text: string, { math = false }: LexOptions = {}): Token[] {
  const tokenizer = math ? new MathTokenizer() : new MarkdownTokenizer();
  const lexer = new Lexer(
    math
      ? { ...OPTIONS, tokenizer, extensions: mathExtensions(tokenizer) }
      : { ...OPTIONS, tokenizer },
  );
  useOwnRules(tokenizer);
  return lexer.lex(text);
}
