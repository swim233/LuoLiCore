import { describe, expect, it } from 'vitest';
import { depthProbes } from './fake-rich.js';
import { markdownBlocks, type RichPart } from './markdown.js';
import { footerBlocks, type InputRichBlock, type RichText } from './rich.js';
import { footerReserve, measureBlock, richLimits, splitMessage, splitRich } from './split.js';

const paragraph = (text: string): InputRichBlock => ({ type: 'paragraph', text });
const part = (block: InputRichBlock, raw: string): RichPart => ({ block, raw });

describe('数一个块', () => {
  it('字数：块里所有字符串的长度之和，按 UTF-16 码元（汉字 1 个，emoji 2 个）', () => {
    expect(measureBlock(paragraph('abc')).chars).toBe(3);
    expect(measureBlock(paragraph('你好👍')).chars).toBe(4);
    expect(
      measureBlock({
        type: 'paragraph',
        text: [
          '看 ',
          { type: 'bold', text: '粗' },
          { type: 'url', text: '这', url: 'https://a.com/' },
          { type: 'mathematical_expression', expression: 'x^2' },
        ],
      }).chars,
    ).toBe(2 + 1 + 1 + 'https://a.com/'.length + 3);
    expect(measureBlock({ type: 'pre', text: 'x = 1', language: 'py' }).chars).toBe(5 + 2);
    expect(measureBlock({ type: 'mathematical_expression', expression: 'E=mc^2' }).chars).toBe(6);
    expect(measureBlock({ type: 'heading', text: '标题', size: 2 }).chars).toBe(2);
    expect(measureBlock({ type: 'divider' })).toEqual({ chars: 0, blocks: 1, depth: 0 });
  });

  it('块数、层数：引用里的块；列表、列表项、项里的块；表格的每一行', () => {
    // 引用一层 + 段落一层
    expect(measureBlock({ type: 'blockquote', blocks: [paragraph('a'), paragraph('b')] })).toEqual({
      chars: 2,
      blocks: 3,
      depth: 2,
    });
    // 块数：列表 1 + 两项 2 + 项里的段落 2；层数：列表连同列表项一层 + 段落一层
    expect(
      measureBlock({
        type: 'list',
        items: [{ blocks: [paragraph('一')] }, { blocks: [paragraph('二')] }],
      }),
    ).toEqual({ chars: 2, blocks: 5, depth: 2 });
    // 嵌套：引用 > 列表 > 项 > 引用 > 段落
    expect(
      measureBlock({
        type: 'blockquote',
        blocks: [
          {
            type: 'list',
            items: [{ blocks: [{ type: 'blockquote', blocks: [paragraph('深')] }] }],
          },
        ],
      }),
    ).toEqual({ chars: 1, blocks: 5, depth: 4 });
    // 表格：自己 1 + 每一行 1；格子不算块，格子的字算；表格一层，行和格子不算
    const cell = (text: string) => ({ text, align: 'left' as const, valign: 'top' as const });
    expect(
      measureBlock({
        type: 'table',
        cells: [
          [cell('名字'), cell('年龄')],
          [cell('小明'), cell('12')],
          [cell('小红'), cell('13')],
        ],
        is_bordered: true,
      }),
    ).toEqual({ chars: 12, blocks: 4, depth: 1 });
  });

  it('上限是真接口试出来的数，每条留尾部的余量', () => {
    expect(richLimits).toEqual({ chars: 32768, blocks: 500, depth: 16 });
    expect(footerReserve.blocks).toBe(2);
    expect(footerReserve.chars).toBeGreaterThanOrEqual(
      '输入 999.9k · 缓存 999.9k · 输出 999.9k · 推理 999.9k · 59m59s'.length,
    );
  });
});

describe('层数：最深的字（或公式）外面一共套了几层', () => {
  const depth = (block: InputRichBlock) => measureBlock(block).depth;
  const cell = (text: RichText) => ({ text, align: 'left' as const, valign: 'top' as const });

  it('带字的块自己算一层（段落、标题、代码块、表格；表格的行和格子不算）；分隔线、块公式不算', () => {
    expect(depth(paragraph('x'))).toBe(1);
    expect(depth({ type: 'heading', text: 'x', size: 1 })).toBe(1);
    expect(depth({ type: 'pre', text: 'x', language: 'ts' })).toBe(1);
    expect(
      depth({
        type: 'table',
        cells: [
          [cell('a'), cell('b')],
          [cell('c'), cell('d')],
        ],
      }),
    ).toBe(1);
    expect(depth({ type: 'divider' })).toBe(0);
    expect(depth({ type: 'mathematical_expression', expression: 'x^2' })).toBe(0);
  });

  it('行内每一个带 type 的对象、每一层数组各算一层；行内公式不算', () => {
    for (const type of ['bold', 'italic', 'strikethrough', 'code', 'subscript'] as const) {
      expect(depth({ type: 'paragraph', text: { type, text: 'x' } })).toBe(2);
    }
    expect(
      depth({ type: 'paragraph', text: { type: 'url', text: 'x', url: 'https://a.com/' } }),
    ).toBe(2);
    expect(depth({ type: 'paragraph', text: ['a', 'b'] })).toBe(2);
    expect(
      depth({ type: 'paragraph', text: { type: 'mathematical_expression', expression: 'x' } }),
    ).toBe(1);
    expect(
      depth({
        type: 'paragraph',
        text: ['a', { type: 'mathematical_expression', expression: 'x' }],
      }),
    ).toBe(2);
    // 段落 > 数组 > 加粗 > 数组 > 斜体 > 字：最深的那个字算
    expect(
      depth({
        type: 'paragraph',
        text: ['a ', { type: 'bold', text: ['b ', { type: 'italic', text: 'c' }] }, ' d'],
      }),
    ).toBe(5);
    // 链接的文字里带样式
    expect(
      depth({
        type: 'heading',
        size: 2,
        text: { type: 'url', text: { type: 'bold', text: 'x' }, url: 'https://a.com/' },
      }),
    ).toBe(3);
    // 表格看最深的那一格
    expect(
      depth({
        type: 'table',
        cells: [[cell('a'), cell({ type: 'bold', text: 'b' })], [cell('c')]],
      }),
    ).toBe(2);
  });

  it('引用一层；列表连同列表项只算一层', () => {
    expect(depth({ type: 'blockquote', blocks: [paragraph('x')] })).toBe(2);
    expect(
      depth({ type: 'blockquote', blocks: [{ type: 'mathematical_expression', expression: 'x' }] }),
    ).toBe(1);
    expect(depth({ type: 'list', items: [{ blocks: [paragraph('x')] }] })).toBe(2);
    // 列表 > 项 > 列表 > 项 > 段落 > 加粗
    expect(
      depth({
        type: 'list',
        items: [
          {
            blocks: [
              paragraph('一'),
              {
                type: 'list',
                items: [{ blocks: [{ type: 'paragraph', text: { type: 'bold', text: '二' } }] }],
              },
            ],
          },
        ],
      }),
    ).toBe(4);
  });

  it('尾部的两个块最深 2 层：不用给层数留余量', () => {
    expect(footerBlocks('输入 1 · 输出 1 · 0.0s').map(depth)).toEqual([0, 2]);
  });

  it.each(depthProbes)(
    '真接口试过的边界（$name）：收的不超过上限，不收的超过上限',
    ({ block, accepted, rejected }) => {
      expect(depth(block(accepted))).toBeLessThanOrEqual(richLimits.depth);
      expect(depth(block(rejected))).toBeGreaterThan(richLimits.depth);
    },
  );
});

describe('在顶层的块之间拆成几条', () => {
  it('没超：一条，原文是几个块的原文连起来，去掉首尾的空行', () => {
    const parts = markdownBlocks('\n\n# 标题\n\n正文\n\n- 项\n\n');
    expect(splitRich(parts)).toEqual([
      { rich: parts.map((p) => p.block), raw: '# 标题\n\n正文\n\n- 项' },
    ]);
  });

  it('字数超了：在块之间拆，每条加上余量都不超，顺序不变', () => {
    // 每段 10000 字：三段加余量就超了，一条放两段
    const parts = ['甲', '乙', '丙', '丁', '戊'].map((c) =>
      part(paragraph(c.repeat(10_000)), `${c.repeat(10_000)}\n\n`),
    );
    const pieces = splitRich(parts);
    expect(pieces.map((p) => p.rich?.length)).toEqual([3, 2]);
    expect(pieces.flatMap((p) => p.rich ?? [])).toEqual(parts.map((p) => p.block));
    expect(pieces.map((p) => p.raw)).toEqual([
      `${'甲'.repeat(10_000)}\n\n${'乙'.repeat(10_000)}\n\n${'丙'.repeat(10_000)}`,
      `${'丁'.repeat(10_000)}\n\n${'戊'.repeat(10_000)}`,
    ]);
    for (const piece of pieces) {
      const chars = piece.rich!.reduce((sum, b) => sum + measureBlock(b).chars, 0);
      expect(chars + footerReserve.chars).toBeLessThanOrEqual(richLimits.chars);
    }
  });

  it('字数正好卡在余量上：放得下就放，多一个字就另起一条', () => {
    const room = richLimits.chars - footerReserve.chars;
    const exact = splitRich([
      part(paragraph('a'.repeat(room - 1)), 'x'),
      part(paragraph('b'), 'y'),
    ]);
    expect(exact.map((p) => p.rich?.length)).toEqual([2]);
    const over = splitRich([part(paragraph('a'.repeat(room)), 'x'), part(paragraph('b'), 'y')]);
    expect(over.map((p) => p.rich?.length)).toEqual([1, 1]);
  });

  it('块数超了：在块之间拆，每条加上余量不超过 500 个块', () => {
    // 每个列表 1 + 50 项 × 2 = 101 个块：一条最多放 4 个（404 + 2 ≤ 500，505 + 2 > 500）
    const list: InputRichBlock = {
      type: 'list',
      items: Array.from({ length: 50 }, () => ({ blocks: [paragraph('项')] })),
    };
    const pieces = splitRich(Array.from({ length: 9 }, (_, i) => part(list, `列表${i}\n`)));
    expect(pieces.map((p) => p.rich?.length)).toEqual([4, 4, 1]);
    for (const piece of pieces) {
      const blocks = piece.rich!.reduce((sum, b) => sum + measureBlock(b).blocks, 0);
      expect(blocks + footerReserve.blocks).toBeLessThanOrEqual(richLimits.blocks);
    }
  });

  it('块数正好卡在余量上：498 个块的一条装得下（加上尾部的两块正好 500），499 个另起一条', () => {
    const paras = (n: number) =>
      Array.from({ length: n }, (_, i) => part(paragraph(`${i}`), `${i}\n\n`));
    expect(splitRich(paras(498)).map((p) => p.rich?.length)).toEqual([498]);
    expect(splitRich(paras(499)).map((p) => p.rich?.length)).toEqual([498, 1]);
  });

  it('每条的原文：去掉开头的空行，末尾的换行连同只有空白的行；第一行行首、最后一行行尾的空格留着', () => {
    const ideographicSpace = String.fromCharCode(0x3000);
    const raw = ` \t\n\n    缩进的第一行\n\n中间\n最后一行  \n \t\n${ideographicSpace}\n\n`;
    const trimmed = '    缩进的第一行\n\n中间\n最后一行  ';
    expect(splitRich([part(paragraph('x'), raw)])).toEqual([
      { rich: [paragraph('x')], raw: trimmed },
    ]);
    // 单独超限、发原文的那一条也一样
    expect(splitRich([part(paragraph('长'.repeat(richLimits.chars)), raw)])).toEqual([
      { raw: trimmed },
    ]);
    // 只有一行、没有换行的原样
    expect(splitRich([part(paragraph('x'), '  x  ')])).toEqual([
      { rich: [paragraph('x')], raw: '  x  ' },
    ]);
  });

  it('两段之间夹着十万个换行：一条，原文是两段连着中间的换行', () => {
    const text = `正文\n${'\n'.repeat(100_000)}正文`;
    expect(splitRich(markdownBlocks(text))).toEqual([
      { rich: [paragraph('正文'), paragraph('正文')], raw: text },
    ]);
  });

  it('单独一个块超了字数、块数：它单独成一条原文（没有块），前后的照常是富文本', () => {
    const huge = part(paragraph('长'.repeat(richLimits.chars)), '长长长……\n\n');
    const many: RichPart = part(
      { type: 'list', items: Array.from({ length: 250 }, () => ({ blocks: [paragraph('x')] })) },
      '- x\n- x……\n',
    );
    const before = part(paragraph('前'), '前\n\n');
    const after = part(paragraph('后'), '后');
    expect(splitRich([before, huge, after, many])).toEqual([
      { rich: [before.block], raw: '前' },
      { raw: '长长长……' },
      { rich: [after.block], raw: '后' },
      { raw: '- x\n- x……' },
    ]);
  });

  it('层数超过 16：这个块单独成一条原文；正好 16 层的照常', () => {
    const nested = (quotes: number): InputRichBlock =>
      quotes === 0 ? paragraph('最里面') : { type: 'blockquote', blocks: [nested(quotes - 1)] };
    expect(measureBlock(nested(15)).depth).toBe(16);
    expect(measureBlock(nested(16)).depth).toBe(17);
    const ok = part(nested(15), '> > …ok\n\n');
    const deep = part(nested(16), '> > …deep\n\n');
    expect(splitRich([part(paragraph('前'), '前\n\n'), deep, ok])).toEqual([
      { rich: [paragraph('前')], raw: '前' },
      { raw: '> > …deep' },
      { rich: [ok.block], raw: '> > …ok' },
    ]);
  });

  it('行内样式套得太深的段落（17 层）：单独成一条原文，前后的照常；16 层的照常', () => {
    // 段落一层 + 加粗、斜体交替套 n 层
    const styled = (n: number): RichText =>
      n === 0 ? '深' : { type: n % 2 ? 'bold' : 'italic', text: styled(n - 1) };
    const ok = part({ type: 'paragraph', text: styled(15) }, '***…ok***\n\n');
    const deep = part({ type: 'paragraph', text: styled(16) }, '***…deep***\n\n');
    expect(measureBlock(ok.block).depth).toBe(16);
    expect(measureBlock(deep.block).depth).toBe(17);
    expect(
      splitRich([part(paragraph('前'), '前\n\n'), deep, part(paragraph('后'), '后\n\n'), ok]),
    ).toEqual([
      { rich: [paragraph('前')], raw: '前' },
      { raw: '***…deep***' },
      { rich: [paragraph('后'), ok.block], raw: '后\n\n***…ok***' },
    ]);
  });

  it('8 层的嵌套列表是富文本（列表连同列表项只算一层：9 层）；16 层的超了，单独成一条原文', () => {
    // 每层缩进两格：- 第1层\n  - 第2层\n    - 第3层……
    const nestedList = (levels: number) =>
      Array.from({ length: levels }, (_, i) => `${'  '.repeat(i)}- 第${i + 1}层`).join('\n');
    const eight = markdownBlocks(nestedList(8));
    expect(eight).toHaveLength(1);
    expect(measureBlock(eight[0]!.block).depth).toBe(9);
    expect(splitRich(eight)).toEqual([{ rich: [eight[0]!.block], raw: nestedList(8) }]);
    const fifteen = markdownBlocks(nestedList(15));
    expect(measureBlock(fifteen[0]!.block).depth).toBe(16);
    expect(splitRich(fifteen)[0]?.rich).toEqual([fifteen[0]!.block]);
    const sixteen = markdownBlocks(nestedList(16));
    expect(measureBlock(sixteen[0]!.block).depth).toBe(17);
    expect(splitRich(sixteen)).toEqual([{ raw: nestedList(16) }]);
  });
});

describe('普通消息按 4096 拆', () => {
  it('尽量在换行处断开，不拆开代理对', () => {
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`;
    expect(splitMessage(text)).toEqual([`${'a'.repeat(3000)}\n`, 'b'.repeat(3000)]);
    const emoji = `${'a'.repeat(4095)}👍b`;
    expect(splitMessage(emoji).map((chunk) => chunk.length)).toEqual([4095, 3]);
  });
});
