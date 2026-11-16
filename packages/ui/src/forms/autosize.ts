/* 多行输入随内容长高的计算（纯函数，不碰 DOM；Textarea 在量到内容高度以后调它）。
   做法：把 textarea 的高度先设成 auto、行数设成 1，读 scrollHeight（内容加上下内边距）；这里再按「至少几行、最多几行」夹一下：
   - 高度 = 内容高度夹在 [最少行数、最多行数] 对应的高度之间；
   - 内容超过上限时 overflow 为 true：这时才出滚动条，里面滚（没超出时不出，免得内容刚好贴着上限时闪出滚动条）。 */
export interface AutosizeInput {
  /** textarea 的 scrollHeight（高度设成 auto 时量的，含上下内边距） */
  scrollHeight: number;
  /** 一行的高度（行高，px） */
  lineHeight: number;
  /** 上下内边距加起来（px） */
  padding: number;
  /** 最少几行 */
  minRows: number;
  /** 最多几行；不给就不封顶 */
  maxRows?: number;
}
export interface AutosizeResult {
  /** 该设的高度（px） */
  height: number;
  /** 内容是不是超出了上限（要不要出滚动条） */
  overflow: boolean;
}

/** 几行对应的高度（px） */
export function rowsToHeight(rows: number, lineHeight: number, padding: number): number {
  return Math.max(0, rows) * lineHeight + padding;
}

export function autosize({
  scrollHeight,
  lineHeight,
  padding,
  minRows,
  maxRows,
}: AutosizeInput): AutosizeResult {
  const min = rowsToHeight(minRows, lineHeight, padding);
  const max =
    maxRows === undefined ? Infinity : Math.max(min, rowsToHeight(maxRows, lineHeight, padding));
  return {
    height: Math.min(Math.max(scrollHeight, min), max),
    overflow: scrollHeight > max + 0.5,
  };
}

/** 右下角的字数：给了上限写「12 / 200」，没给只写数字 */
export function countLabel(length: number, max?: number): string {
  return max === undefined ? String(length) : `${length} / ${max}`;
}

/** 按「字」数（不是 UTF-16 码元数）算长度：一个表情、一个生僻字算一个，和用户看到的一致 */
export function charCount(text: string): number {
  return Array.from(text).length;
}
