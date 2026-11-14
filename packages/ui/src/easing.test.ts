import { describe, expect, it } from 'vitest';
import { bezierAt, EASE_MORPH, EASE_OUT } from './easing';
import type { Bezier } from './easing';

/* 没有 document 的环境里能 import easing（上面这行能过就说明加载时不碰 DOM）。
   下面用的数是真的 Chrome 里量的：给一个元素挂上 CSS 的 cubic-bezier 动画，暂停在 t 处，读它走到的比例 */
const CHROME: [string, Bezier, number[]][] = [
  ['EASE_OUT', EASE_OUT, [0.2022, 0.3967, 0.7673, 0.9461, 0.9911, 0.9988]],
  ['ease', [0.25, 0.1, 0.25, 1], [0.033, 0.0948, 0.4085, 0.8024, 0.9605, 0.9943]],
  ['ease-in-out', [0.42, 0, 0.58, 1], [0.0048, 0.0197, 0.1292, 0.5, 0.8708, 0.9803]],
  ['EASE_MORPH', EASE_MORPH, [0.0356, 0.0889, 0.4152, 0.8445, 0.9714, 0.996]],
];
const TS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9];

describe('bezierAt：按 CSS 的 cubic-bezier 求值', () => {
  it('端点：0 处是 0，1 处是 1，超出范围截到端点', () => {
    for (const [, b] of CHROME) {
      expect(bezierAt(b, 0)).toBe(0);
      expect(bezierAt(b, 1)).toBe(1);
      expect(bezierAt(b, -0.5)).toBe(0);
      expect(bezierAt(b, 3)).toBe(1);
    }
  });
  it('对角线 (0,0,1,1) 就是原样（进度等于时间）', () => {
    for (const t of [0.1, 0.33, 0.5, 0.9]) expect(bezierAt([0, 0, 1, 1], t)).toBeCloseTo(t, 6);
  });
  it('EASE_OUT 随时间只增不减（一路单调往上，不回头）', () => {
    let last = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = bezierAt(EASE_OUT, i / 1000);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
  it('EASE_OUT 起步很快：走到 10% 的时间已经过了近 40%，走到一半时间已经过了 94%', () => {
    expect(bezierAt(EASE_OUT, 0.1)).toBeGreaterThan(0.39);
    expect(bezierAt(EASE_OUT, 0.5)).toBeGreaterThan(0.94);
  });
  it('关于中点对称的曲线（ease-in-out）：f(t) + f(1 − t) = 1', () => {
    const b: Bezier = [0.42, 0, 0.58, 1];
    for (const t of [0.1, 0.3, 0.45]) expect(bezierAt(b, t) + bezierAt(b, 1 - t)).toBeCloseTo(1, 5);
  });
  it('和 Chrome 里 CSS 的 cubic-bezier 在几个点上对得上（差不到万分之一）', () => {
    for (const [name, b, want] of CHROME)
      TS.forEach((t, i) => expect(bezierAt(b, t), `${name} @ ${t}`).toBeCloseTo(want[i], 3));
  });
  it('控制点超出 0–1 的曲线（回弹，y 会超过 1）也算得出来', () => {
    const b: Bezier = [0.3, 1.6, 0.5, 1];
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => bezierAt(b, (i + 1) / 100)));
    expect(peak).toBeGreaterThan(1);
    expect(bezierAt(b, 1)).toBe(1);
  });
});
