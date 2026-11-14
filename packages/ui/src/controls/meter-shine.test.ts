import { describe, expect, it } from 'vitest';
import { NO_PREV, shouldShine } from './meter-shine';

describe('shouldShine：能量槽的光什么时候扫', () => {
  it('第一次渲染（还没有上一次的值）不扫，哪怕值很大', () => {
    expect(shouldShine(NO_PREV, 0)).toBe(false);
    expect(shouldShine(NO_PREV, 0.9)).toBe(false);
  });
  it('变大时扫，包括从 0 变大', () => {
    expect(shouldShine(0, 0.01)).toBe(true);
    expect(shouldShine(0.3, 0.8)).toBe(true);
  });
  it('不变、变小都不扫', () => {
    expect(shouldShine(0.5, 0.5)).toBe(false);
    expect(shouldShine(0.8, 0.3)).toBe(false);
    expect(shouldShine(0.01, 0)).toBe(false);
  });
});
