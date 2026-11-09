/**
 * 提示类输出（重试提示、「（已中止）」、退出提示、用量行）：写 stderr。
 * stderr 是终端且没有设置 NO_COLOR 时用暗色，与回复正文区分；管道输出原样。
 */
export function notice(text: string): void {
  const dim = process.stderr.isTTY && !process.env.NO_COLOR;
  process.stderr.write(dim ? `\x1b[2m${text}\x1b[22m\n` : `${text}\n`);
}

/** 错误行（连不上服务、回复出错、发送失败）：写 stderr，不用暗色 */
export function errorLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * 等 stream 把交给它的都写出去。写到管道是异步的：下游读得慢时，没读走的留在缓冲里，这时直接
 * process.exit 会把它们丢掉。不设上限，管道的节奏由下游决定。写不出去了（下游关掉了，EPIPE）也算写完
 */
export function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    // 回调在它前面写的都写出去之后才调（出错时带着错误，同样算结束）
    stream.write('', () => resolve());
  });
}
