import { cssVar } from './css-read';
import { tokenNames } from './tokens-src';

/* 刻度的档位：「现在的数字并到哪一档」按「最近的一档，一样近时取小的」算，只是提案。
   档位本身从页面上读（tokens.css 里的 --ll-text-*、--ll-space-* 这些），所以改了 tokens.css，对照表跟着变 */
export interface Tier {
  /** 变量名，如 --ll-text-md */
  name: string;
  px: number;
}

/** '11px' → 11；'999px' → 999；别的写法（em、var……）返回 null */
export function parsePx(v: string): number | null {
  const m = /^(-?\d*\.?\d+)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

/** 最近的一档；一样近时取小的。tiers 不能为空 */
export function nearestTier(value: number, tiers: readonly Tier[]): Tier {
  let best = tiers[0];
  for (const t of tiers) {
    const d = Math.abs(t.px - value);
    const bd = Math.abs(best.px - value);
    if (d < bd || (d === bd && t.px < best.px)) best = t;
  }
  return best;
}

/** 差多少，带正负号：'+0.5'、'−0.5'、'0' */
export function diffText(from: number, to: number): string {
  const d = Math.round((to - from) * 100) / 100;
  if (d === 0) return '0';
  return (d > 0 ? '+' : '−') + String(Math.abs(d));
}

/** 读一组档位：从 tokens.css（页面的样式表）里按名字挑出这一组变量，值取页面上的计算值；不是 px 的丢掉 */
export function readTiers(match: (name: string) => boolean): Tier[] {
  const out: Tier[] = [];
  for (const name of (tokenNames() ?? []).filter(match)) {
    const px = parsePx(cssVar(name));
    if (px != null) out.push({ name, px });
  }
  return out.sort((a, b) => a.px - b.px);
}

/** 专用值（不并到档位上，也不算档位）：窗口的圆角、气泡的各个值、统计数字的两个大字号 */
export const isDedicated = (name: string) => /^--ll-(radius-window|bubble-|text-figure)/.test(name);

export const textTiers = () => readTiers((n) => n.startsWith('--ll-text-') && !isDedicated(n));
export const spaceTiers = () => readTiers((n) => n.startsWith('--ll-space-'));
/** 圆角的档位；窗口的 22（--ll-radius-window）是专用值，不在里面 */
export const radiusTiers = () => readTiers((n) => n.startsWith('--ll-radius-') && !isDedicated(n));

/** 字号的专用值：名字 → 页面上读到的 px（统计数字的 28 和 42），对照表里等于这个 px 的行写「专用，不并」 */
export function dedicatedText(): Tier[] {
  return readTiers((n) => n.startsWith('--ll-text-') && isDedicated(n));
}
