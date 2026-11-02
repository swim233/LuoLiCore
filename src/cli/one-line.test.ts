import { describe, expect, it } from 'vitest';
import { oneLine } from './one-line.js';

describe('截成一行', () => {
  it('换行与连续空白换成一个空格；没超过宽度时不截', () => {
    expect(oneLine('第一行\n  第二行\t\t末尾', 80)).toBe('第一行 第二行 末尾');
    expect(oneLine('abcde', 5)).toBe('abcde');
  });

  it('超过宽度时截断，末尾加「…」，连同它不超过宽度', () => {
    expect(oneLine('abcdefgh', 5)).toBe('abcd…');
  });

  it('中文、全角符号与 emoji 占两列', () => {
    // 「工具结果」八列，再加「…」超过 8 列：留下三个字
    expect(oneLine('工具结果ab', 8)).toBe('工具结…');
    expect(oneLine('好，😀', 6)).toBe('好，😀');
    expect(oneLine('好，😀a', 6)).toBe('好，…');
  });

  it('不切开代理对：放不下整个 emoji 时整个去掉', () => {
    // 宽 4：留一列给「…」，剩 3 列放不下 a、b 之后的 😀
    const line = oneLine('ab😀😀', 4);
    expect(line).toBe('ab…');
    expect(oneLine('ab😀😀', 5)).toBe('ab😀…');
    expect(line.isWellFormed()).toBe(true);
  });
});
