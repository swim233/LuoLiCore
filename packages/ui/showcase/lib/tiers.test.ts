import { describe, expect, it } from 'vitest';
import { diffText, nearestTier, parsePx } from './tiers';
import type { Tier } from './tiers';

const tier = (px: number): Tier => ({ name: `--t-${px}`, px });
const text = [11, 12, 13, 15, 17].map(tier);
const space = [2, 4, 6, 8, 12, 16, 24].map(tier);
const radius = [6, 10, 14, 999].map(tier);
const px = (v: number, tiers: Tier[]) => nearestTier(v, tiers).px;

describe('nearestTier：最近的一档，一样近时取小的', () => {
  it('字号：半号并到小的那档', () => {
    expect(px(10.5, text)).toBe(11);
    expect(px(11.5, text)).toBe(11);
    expect(px(12.5, text)).toBe(12);
    expect(px(13.5, text)).toBe(13);
  });
  it('字号：夹在两档正中间的取小的，比最大档还大的并到最大档', () => {
    expect(px(14, text)).toBe(13);
    expect(px(16, text)).toBe(15);
    expect(px(28, text)).toBe(17);
    expect(px(42, text)).toBe(17);
    expect(px(10, text)).toBe(11);
  });
  it('已经在档上的不动', () => {
    for (const t of text) expect(px(t.px, text)).toBe(t.px);
    for (const t of space) expect(px(t.px, space)).toBe(t.px);
  });
  it('间距：奇数并到小的，大数并到最近的', () => {
    expect(px(3, space)).toBe(2);
    expect(px(5, space)).toBe(4);
    expect(px(7, space)).toBe(6);
    expect(px(9, space)).toBe(8);
    expect(px(10, space)).toBe(8);
    expect(px(11, space)).toBe(12);
    expect(px(14, space)).toBe(12);
    expect(px(18, space)).toBe(16);
    expect(px(20, space)).toBe(16);
    expect(px(22, space)).toBe(24);
    expect(px(112, space)).toBe(24);
    expect(px(1.5, space)).toBe(2);
  });
  it('圆角：药丸的 999 留在 full', () => {
    expect(px(3, radius)).toBe(6);
    expect(px(8, radius)).toBe(6);
    expect(px(9, radius)).toBe(10);
    expect(px(12, radius)).toBe(10);
    expect(px(16, radius)).toBe(14);
    expect(px(18, radius)).toBe(14);
    expect(px(999, radius)).toBe(999);
  });
  it('档位没排好序也一样', () => {
    expect(px(11.5, [...text].reverse())).toBe(11);
  });
});

describe('parsePx', () => {
  it('只认 px', () => {
    expect(parsePx('11px')).toBe(11);
    expect(parsePx(' 13.5px ')).toBe(13.5);
    expect(parsePx('999px')).toBe(999);
    expect(parsePx('1.6')).toBeNull();
    expect(parsePx('2em')).toBeNull();
    expect(parsePx('')).toBeNull();
  });
});

describe('diffText', () => {
  it('带正负号，去掉浮点误差', () => {
    expect(diffText(10.5, 11)).toBe('+0.5');
    expect(diffText(11.5, 11)).toBe('−0.5');
    expect(diffText(12, 12)).toBe('0');
    expect(diffText(42, 17)).toBe('−25');
    expect(diffText(0.1, 0.3)).toBe('+0.2');
  });
});
