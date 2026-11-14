/**
 * Telegram 的富文本消息（Bot API 10.1 起的 sendRichMessage）：发送要用到的类型与构造。
 * 只写现在用得到的，字段名照 Bot API 的写法：https://core.telegram.org/bots/api/rich-messages.md
 */

/**
 * 富文本（RichText）。现在只用纯文字，就是一个字符串；Bot API 还允许 RichText 的数组和带 type 的
 * 对象（加粗、下标等），用到时再加
 */
export type RichText = string;

/** 段落块（InputRichBlockParagraph），对应 HTML 的 `<p>` */
export type InputRichBlockParagraph = { type: 'paragraph'; text: RichText };

/** 富文本消息里的一个块（InputRichBlock）；现在只有段落 */
export type InputRichBlock = InputRichBlockParagraph;

/**
 * 要发出的富文本消息（InputRichMessage）。Bot API 要求 blocks、html、markdown 三个字段只用一个，
 * 我们只用 blocks
 */
export type InputRichMessage = { blocks: InputRichBlock[] };

/**
 * 一段原样文字做成的富文本消息：只有一个段落块，文字原样。不解析任何符号（`**`、`<`、`$` 等都是
 * 字面的字），换行符留在文字里，不按行拆成几个段落
 */
export function plainRichMessage(text: string): InputRichMessage {
  return { blocks: [{ type: 'paragraph', text }] };
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
