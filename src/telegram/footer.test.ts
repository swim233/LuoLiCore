import { describe, expect, it } from 'vitest';
import { plainWithFooter, usageFooter } from './footer.js';

describe('尾部的文字', () => {
  it('五项都有：输入、缓存、输出、推理、用时，顺序固定，用「 · 」隔开', () => {
    expect(
      usageFooter({ input: 4976, cacheRead: 4096, output: 135, total: 5111, reasoning: 102 }, 3200),
    ).toBe('输入 5k · 缓存 4.1k · 输出 135 · 推理 102 · 3.2s');
  });

  it('缓存、推理是 0 或没报时不写；输入、输出是 0 时照写，没报时不写', () => {
    expect(usageFooter({ input: 0, cacheRead: 0, output: 0, reasoning: 0 }, 1000)).toBe(
      '输入 0 · 输出 0 · 1.0s',
    );
    expect(usageFooter({ input: 12, output: 3 }, 1000)).toBe('输入 12 · 输出 3 · 1.0s');
    expect(usageFooter({ output: 3, reasoning: 2 }, 1000)).toBe('输出 3 · 推理 2 · 1.0s');
    expect(usageFooter({ input: 12, cacheRead: 8 }, 1000)).toBe('输入 12 · 缓存 8 · 1.0s');
  });

  it('用量整个没有（服务端一项都没报）：只有用时', () => {
    expect(usageFooter(undefined, 3200)).toBe('3.2s');
    expect(usageFooter({}, 3200)).toBe('3.2s');
  });

  it('数字：不到 1000 原样；1000 以上写成 k，一位小数（是 0 不写）；到了 1000k 改写成 M', () => {
    const count = (n: number) => usageFooter({ input: n }, 0).split(' · ')[0];

    expect([999, 1000, 4096, 4976, 128400, 999949, 999950, 1250000].map((n) => count(n))).toEqual([
      '输入 999',
      '输入 1k',
      '输入 4.1k',
      '输入 5k',
      '输入 128.4k',
      '输入 999.9k',
      '输入 1M',
      '输入 1.3M',
    ]);
    // 恰好在一半上的进位
    expect([1050, 1150, 2350, 1049].map((n) => count(n))).toEqual([
      '输入 1.1k',
      '输入 1.2k',
      '输入 2.4k',
      '输入 1k',
    ]);
  });

  it('用时：四舍五入到 0.1 秒；不到 60 秒写一位小数加 s，60 秒以上写成分和两位的秒', () => {
    const duration = (ms: number) => usageFooter(undefined, ms);

    expect([40, 400, 3040, 59_940, 59_960, 65_000, 600_000].map(duration)).toEqual([
      '0.0s',
      '0.4s',
      '3.0s',
      '59.9s',
      '1m00s',
      '1m05s',
      '10m00s',
    ]);
    // 恰好在一半上的进位；不经过两次四舍五入（3049.5 毫秒不是 3.1s）
    expect([3050, 3049.5, 59_950, 89_500, 0].map(duration)).toEqual([
      '3.1s',
      '3.0s',
      '1m00s',
      '1m30s',
      '0.0s',
    ]);
  });
});

describe('普通消息带上尾部', () => {
  it('正文、一个空行、尾部；尾部标成斜体，offset、length 按 UTF-16 码元算（含中文、emoji）', () => {
    const text = '好的 👍🏽 **不解析** <b>\n第二行 𝒳';
    const footer = '输入 5k · 输出 135 · 3.2s';

    const plain = plainWithFooter(text, footer);

    expect(plain.text).toBe(`${text}\n\n${footer}`);
    const [entity] = plain.entities;
    expect(plain.entities).toHaveLength(1);
    expect(entity?.type).toBe('italic');
    // 正文 26 个码元（👍、🏽、𝒳 各 2 个）加空行的 2 个；按码点数会是 25
    expect(entity?.offset).toBe(28);
    expect(entity?.length).toBe(footer.length);
    expect(plain.text.slice(entity!.offset, entity!.offset + entity!.length)).toBe(footer);
    expect(entity!.offset + entity!.length).toBe(plain.text.length);
  });

  it('没有正文时只有尾部那一行，整行斜体', () => {
    expect(plainWithFooter('', '3.2s')).toEqual({
      text: '3.2s',
      entities: [{ type: 'italic', offset: 0, length: 4 }],
    });
  });
});
