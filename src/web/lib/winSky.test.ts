import { describe, expect, it } from 'vitest';
import { saturateMatrix } from './winSky';

const apply = (m: number[], c: [number, number, number]) =>
  [0, 3, 6].map((i) => m[i] * c[0] + m[i + 1] * c[1] + m[i + 2] * c[2]);

describe('saturateMatrix：CSS saturate(s) 的颜色矩阵', () => {
  it('s = 1 不改颜色', () => {
    const out = apply(saturateMatrix(1), [96, 82, 200]);
    expect(out[0]).toBeCloseTo(96, 9);
    expect(out[1]).toBeCloseTo(82, 9);
    expect(out[2]).toBeCloseTo(200, 9);
  });

  it('s = 0 变成灰色：三个通道都是亮度', () => {
    const [r, g, b] = apply(saturateMatrix(0), [96, 82, 200]);
    const lum = 0.213 * 96 + 0.715 * 82 + 0.072 * 200;
    expect(r).toBeCloseTo(lum, 9);
    expect(g).toBeCloseTo(lum, 9);
    expect(b).toBeCloseTo(lum, 9);
  });

  it('灰色和白色不受影响（每行的和是 1）：糊好的星点是白的，饱和度不改它', () => {
    for (const s of [0.5, 1.3, 2]) {
      const out = apply(saturateMatrix(s), [255, 255, 255]);
      for (const v of out) expect(v).toBeCloseTo(255, 9);
      const grey = apply(saturateMatrix(s), [40, 40, 40]);
      for (const v of grey) expect(v).toBeCloseTo(40, 9);
    }
  });

  it('s = 1.3：偏紫的颜色更紫（蓝通道涨、绿通道降），和规范里的系数一致', () => {
    const m = saturateMatrix(1.3);
    expect(m[0]).toBeCloseTo(1.2361, 4);
    expect(m[1]).toBeCloseTo(-0.2145, 4);
    expect(m[2]).toBeCloseTo(-0.0216, 4);
    expect(m[3]).toBeCloseTo(-0.0639, 4);
    expect(m[4]).toBeCloseTo(1.0855, 4);
    expect(m[8]).toBeCloseTo(1.2784, 4);
    const [r, g, b] = apply(m, [96, 82, 200]);
    expect(b).toBeGreaterThan(200);
    expect(g).toBeLessThan(82 + 5);
    expect(r).toBeGreaterThan(0);
  });
});
