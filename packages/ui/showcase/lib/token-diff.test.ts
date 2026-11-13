import { describe, expect, it } from 'vitest';
import { describeDiff, diffTokens } from './token-diff';

describe('diffTokens：分组数据和 tokens.css 对一遍', () => {
  const sheet = ['--ll-a', '--ll-b', '--ll-c'];

  it('都对得上：什么都不报', () => {
    const d = diffTokens(sheet, ['--ll-c', '--ll-a', '--ll-b']);
    expect(d).toEqual({ ungrouped: [], absent: [], duplicated: [] });
    expect(describeDiff(d)).toBe('');
  });

  it('tokens.css 里有、分组里没有：列在 ungrouped，保持 tokens.css 里的顺序', () => {
    const d = diffTokens(['--ll-a', '--ll-new1', '--ll-b', '--ll-new2'], ['--ll-a', '--ll-b']);
    expect(d.ungrouped).toEqual(['--ll-new1', '--ll-new2']);
    expect(d.absent).toEqual([]);
    expect(describeDiff(d)).toContain('--ll-new1、--ll-new2');
  });

  it('分组里有、tokens.css 里没有（名字写错）：列在 absent', () => {
    const d = diffTokens(sheet, ['--ll-a', '--ll-b', '--ll-c', '--ll-typo']);
    expect(d.absent).toEqual(['--ll-typo']);
    expect(d.ungrouped).toEqual([]);
    expect(describeDiff(d)).toContain('--ll-typo');
  });

  it('写错名字等于「少登记一个、多登记一个」，两头都报', () => {
    const d = diffTokens(sheet, ['--ll-a', '--ll-b', '--ll-cc']);
    expect(d.ungrouped).toEqual(['--ll-c']);
    expect(d.absent).toEqual(['--ll-cc']);
  });

  it('登记了两次：列在 duplicated', () => {
    const d = diffTokens(sheet, ['--ll-a', '--ll-b', '--ll-c', '--ll-a', '--ll-a']);
    expect(d.duplicated).toEqual(['--ll-a']);
    expect(d.ungrouped).toEqual([]);
  });
});
