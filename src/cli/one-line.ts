/**
 * 截成终端里的一行：换行与连续空白换成一个空格；超过 width 列时截断，末尾加「…」。
 * 按显示宽度算（中日韩文字、全角符号、emoji 占两列），逐个码点截，不切开代理对
 */
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ');
  let used = 0;
  for (const char of flat) used += charWidth(char);
  if (used <= width) return flat;
  // 留一列给「…」
  let kept = '';
  used = 0;
  for (const char of flat) {
    const next = used + charWidth(char);
    if (next > width - 1) break;
    kept += char;
    used = next;
  }
  return `${kept}…`;
}

// 显示时占两列的码点范围（东亚宽字符与全角，以及常见 emoji），其余算一列
const wideRanges: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  return wideRanges.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}
