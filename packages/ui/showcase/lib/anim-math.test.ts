import { describe, expect, it } from 'vitest';
import { compareAnim, parseBezier, parseTimeMs } from './anim-math';
import type { Expected } from './anim-math';

describe('parseTimeMs：换算成毫秒', () => {
  it('ms 和 s 写法等价', () => {
    expect(parseTimeMs('200ms')).toBe(200);
    expect(parseTimeMs('.2s')).toBe(200);
    expect(parseTimeMs('0.2s')).toBe(200);
    expect(parseTimeMs('0.14s')).toBe(140);
    expect(parseTimeMs(' 250ms ')).toBe(250);
    expect(parseTimeMs('1s')).toBe(1000);
  });
  it('认不出的返回 null', () => {
    expect(parseTimeMs('200')).toBeNull();
    expect(parseTimeMs('var(--x)')).toBeNull();
    expect(parseTimeMs('')).toBeNull();
  });
});

describe('parseBezier：取四个数', () => {
  it('空格、前导 0 都不影响', () => {
    expect(parseBezier('cubic-bezier(0.2, 0.8, 0.2, 1)')).toEqual([0.2, 0.8, 0.2, 1]);
    expect(parseBezier('cubic-bezier(.2,.8,.2,1)')).toEqual([0.2, 0.8, 0.2, 1]);
    expect(parseBezier('cubic-bezier(0.25, 0.8, 0.35, 1)')).toEqual([0.25, 0.8, 0.35, 1]);
  });
  it('认不出的返回 null', () => {
    expect(parseBezier('ease')).toBeNull();
    expect(parseBezier('cubic-bezier(0.2, 0.8, 0.2)')).toBeNull();
    expect(parseBezier('cubic-bezier(a, b, c, d)')).toBeNull();
  });
});

describe('compareAnim', () => {
  const expected: Record<string, Expected> = {
    '--ll-ease-out': [0.2, 0.8, 0.2, 1],
    '--ll-dur-hover': 200,
    '--ll-dur-glide-in': 140,
  };
  const names = Object.keys(expected);
  const same = {
    '--ll-ease-out': 'cubic-bezier(.2,.8,.2,1)',
    '--ll-dur-hover': '.2s',
    '--ll-dur-glide-in': '140ms',
  };
  it('写法不同但数值一样：对得上', () => {
    expect(compareAnim(same, expected, names)).toEqual([]);
  });
  it('时长差一点：报出是哪一个', () => {
    const p = compareAnim({ ...same, '--ll-dur-hover': '210ms' }, expected, names);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('--ll-dur-hover');
    expect(p[0]).toContain('210ms');
  });
  it('曲线差一个数：报出来', () => {
    const p = compareAnim(
      { ...same, '--ll-ease-out': 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
      expected,
      names,
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('--ll-ease-out');
  });
  it('tokens.css 里缺了一个：报出来', () => {
    const { '--ll-dur-hover': _drop, ...rest } = same;
    void _drop;
    const p = compareAnim(rest, expected, names);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('--ll-dur-hover');
  });
  it('tokens.css 里多了一个动画变量、easing.ts 没登记：报出来', () => {
    const p = compareAnim(same, expected, [...names, '--ll-dur-new', '--ll-bg']);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('--ll-dur-new');
  });
  it('只在 tokens.css 里定义的动画变量（cssOnly）：不要求 easing.ts 登记', () => {
    const all = [...names, '--ll-dur-new', '--ll-bg'];
    expect(compareAnim(same, expected, all, ['--ll-dur-new'])).toEqual([]);
    // 没列进 cssOnly 的照样报
    expect(compareAnim(same, expected, [...all, '--ll-dur-other'], ['--ll-dur-new'])).toHaveLength(
      1,
    );
  });
});
