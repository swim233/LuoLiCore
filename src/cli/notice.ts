/**
 * 提示类输出（重试提示、「（已中止）」、退出提示、用量行）：写 stderr。
 * stderr 是终端且没有设置 NO_COLOR 时用暗色，与回复正文区分；管道输出原样。
 */
export function notice(text: string): void {
  const dim = process.stderr.isTTY && !process.env.NO_COLOR;
  process.stderr.write(dim ? `\x1b[2m${text}\x1b[22m\n` : `${text}\n`);
}
