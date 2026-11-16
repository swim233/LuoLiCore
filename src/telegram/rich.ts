/**
 * Telegram 的富文本消息（Bot API 10.1 起的 sendRichMessage）：发送要用到的类型与构造。
 * 只写现在用得到的，字段名照 Bot API 的写法（https://core.telegram.org/bots/api/rich-messages.md），
 * 2026-11-14 在真的接口上试过都收（见 .grill/telegram-usage-footer/final.md「真机上验证过的」）
 */

/**
 * 富文本（RichText）：纯文字是一个字符串；也可以是 RichText 的数组（依次连起来），或带 type 的
 * 对象（样式、链接、公式）
 */
export type RichText =
  string | RichText[] | RichTextStyled | RichTextUrl | RichTextMathematicalExpression;

/**
 * 带样式的字：加粗（RichTextBold）、斜体（RichTextItalic）、删除线（RichTextStrikethrough）、
 * 行内代码（RichTextCode）、下标（RichTextSubscript，尾部用它）
 */
export type RichTextStyled = {
  type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'subscript';
  text: RichText;
};

/** 链接（RichTextUrl）：显示 text，点了打开 url */
export type RichTextUrl = { type: 'url'; text: RichText; url: string };

/** 行内的公式（RichTextMathematicalExpression），LaTeX 原文 */
export type RichTextMathematicalExpression = {
  type: 'mathematical_expression';
  expression: string;
};

/** 段落块（InputRichBlockParagraph），对应 HTML 的 `<p>` */
export type InputRichBlockParagraph = { type: 'paragraph'; text: RichText };

/** 标题（InputRichBlockSectionHeading）：size 1 到 6，1 最大 */
export type InputRichBlockSectionHeading = { type: 'heading'; text: RichText; size: number };

/** 等宽的代码块（InputRichBlockPreformatted）；language 是语言，可以不写 */
export type InputRichBlockPreformatted = { type: 'pre'; text: RichText; language?: string };

/** 分隔线块（InputRichBlockDivider），对应 HTML 的 `<hr/>` */
export type InputRichBlockDivider = { type: 'divider' };

/** 单独成块的公式（InputRichBlockMathematicalExpression），LaTeX 原文 */
export type InputRichBlockMathematicalExpression = {
  type: 'mathematical_expression';
  expression: string;
};

/** 引用（InputRichBlockBlockQuotation）：里面是块 */
export type InputRichBlockBlockQuotation = { type: 'blockquote'; blocks: InputRichBlock[] };

/**
 * 列表的一项（InputRichBlockListItem）：里面是块。有序列表的项带 value（编号）和 type（"1" 是数字）；
 * 任务列表的项带 has_checkbox，勾了的再带 is_checked
 */
export type InputRichBlockListItem = {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: '1';
};

/** 列表（InputRichBlockList）：有序还是无序看项带不带 value、type */
export type InputRichBlockList = { type: 'list'; items: InputRichBlockListItem[] };

/** 表格的一格（RichBlockTableCell）：align、valign 都要写 */
export type RichBlockTableCell = {
  text?: RichText;
  is_header?: true;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
};

/** 表格（InputRichBlockTable）：cells 一行一个数组；最多 20 列 */
export type InputRichBlockTable = {
  type: 'table';
  cells: RichBlockTableCell[][];
  is_bordered?: true;
};

/** 富文本消息里的一个块（InputRichBlock）；只写我们会发的几种 */
export type InputRichBlock =
  | InputRichBlockParagraph
  | InputRichBlockSectionHeading
  | InputRichBlockPreformatted
  | InputRichBlockDivider
  | InputRichBlockMathematicalExpression
  | InputRichBlockBlockQuotation
  | InputRichBlockList
  | InputRichBlockTable;

/**
 * 要发出的富文本消息（InputRichMessage）。Bot API 要求 blocks、html、markdown 三个字段只用一个，
 * 我们只用 blocks
 */
export type InputRichMessage = { blocks: InputRichBlock[] };

/** 尾部（见 footer.ts）在富文本消息里占的块：分隔线，和一个下标包着那一行的段落 */
export function footerBlocks(footer: string): InputRichBlock[] {
  return [{ type: 'divider' }, { type: 'paragraph', text: { type: 'subscript', text: footer } }];
}

/** 一条富文本消息：这些块，带 footer 时后面再加尾部的两块 */
export function richMessage(blocks: InputRichBlock[], footer?: string): InputRichMessage {
  return { blocks: footer === undefined ? blocks : [...blocks, ...footerBlocks(footer)] };
}

/**
 * 发富文本消息失败、这一条可以改发普通消息的两种情况（Sender.sendRich 抛出）：
 * - unsupported：Bot API 服务端不认识 sendRichMessage（如自己搭的旧版服务端），之后也不必再试；
 * - rejected：Telegram 拒收这一条，下一条照常先试富文本。
 * 别的失败（限流、token 失效、5xx、网络错误）不包成它，原样抛出。cause 是原来的错误
 */
export class RichMessageError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'rejected',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RichMessageError';
  }
}
