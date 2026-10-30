/** Telegram 一条文字消息的上限（UTF-16 码元，与 JS 字符串长度一致） */
export const telegramMessageLimit = 4096;

/**
 * 把长回复拆成不超过 limit 的几段。尽量在换行处断开（断点在后半段时），
 * 否则按长度硬断，不拆开代理对。适配器自己只会截断（末尾加 ...），不会拆分
 */
export function splitMessage(text: string, limit = telegramMessageLimit): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 换行连同它自己都要放进这一段，所以只找下标不超过 limit - 1 的换行
    const newline = rest.lastIndexOf('\n', limit - 1);
    let end = newline >= limit / 2 ? newline + 1 : limit;
    // 不在代理对中间断开
    const code = rest.charCodeAt(end - 1);
    if (end === limit && code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
