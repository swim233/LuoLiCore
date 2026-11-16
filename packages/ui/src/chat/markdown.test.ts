import { describe, expect, it } from 'vitest';
import { IncrementalLexer, lexMarkdown, plainPreview } from './markdown';

/* 面板自己的：一行预览、缓存、逐字输出时的增量分析。分析的规则（一个回车就换行、中日韩文字旁的加粗和斜体、
   HTML 实体等）的测试在 @luoli/markdown 包里（packages/markdown/src/lex.test.ts） */

/* 一行预览：去掉 Markdown 的符号，只留文字 */
describe('plainPreview', () => {
  it('行内的写法只留文字', () => {
    expect(plainPreview('**加粗** 和 *斜体* 和 ~~删除~~ 和 `代码`')).toBe(
      '加粗 和 斜体 和 删除 和 代码',
    );
    expect(plainPreview('看 [这个链接](https://example.com/a) 吧')).toBe('看 这个链接 吧');
    expect(plainPreview('图 ![一张图](https://example.com/a.png) 在这')).toBe('图 一张图 在这');
  });

  it('块的写法只留文字，各块之间用一个空格隔开', () => {
    expect(plainPreview('# 标题\n\n正文第一行\n正文第二行')).toBe('标题 正文第一行 正文第二行');
    expect(plainPreview('- 苹果\n- 香蕉\n  - 小的\n\n1. 一\n2. 二')).toBe('苹果 香蕉 小的 一 二');
    expect(plainPreview('> 引用的话\n\n正文')).toBe('引用的话 正文');
    expect(plainPreview('前面\n\n---\n\n后面')).toBe('前面 后面');
    expect(plainPreview('| 名字 | 年龄 |\n|---|---|\n| 小明 | **12** |')).toBe('名字 年龄 小明 12');
    expect(plainPreview('```js\nconst a = 1;\n```\n说明')).toBe('const a = 1; 说明');
  });

  it('任务列表只留文字', () => {
    expect(plainPreview('- [ ] 买菜\n- [x] 洗衣服')).toBe('买菜 洗衣服');
  });

  it('没闭合的写法照原样（和气泡里显示的一致）', () => {
    expect(plainPreview('这是**没写完的加粗')).toBe('这是**没写完的加粗');
    expect(plainPreview('一个 `没闭合的代码')).toBe('一个 `没闭合的代码');
  });

  it('原始 HTML 当文字，转义的符号还原', () => {
    expect(plainPreview('a <b>粗</b> c')).toBe('a <b>粗</b> c');
    expect(plainPreview('\\*不是斜体\\*')).toBe('*不是斜体*');
  });

  it('结果为空时退回原文，去掉围栏符号（以代码围栏开头又被截断）', () => {
    expect(plainPreview('```python')).toBe('python');
    expect(plainPreview('```python\n')).toBe('python');
    expect(plainPreview('~~~\nxx')).toBe('xx');
    expect(plainPreview('---')).toBe('---');
    expect(plainPreview('[a]: https://example.com')).toBe('[a]: https://example.com');
    // 只有围栏符号：确实没有文字
    expect(plainPreview('```')).toBe('');
    expect(plainPreview('```\n```')).toBe('');
  });

  it('没有格式的文字原样，空白压成一个空格', () => {
    expect(plainPreview('就是普通的一句话，没有符号。')).toBe('就是普通的一句话，没有符号。');
    expect(plainPreview('  多   个\n\n\n空白  ')).toBe('多 个 空白');
    expect(plainPreview('')).toBe('');
  });

  /* 符号和 HTML 实体：预览里显示成人看到的样子（解法在 @luoli/markdown 里，那边有完整的测试） */
  it('常见的实体解成符号；有数字写法的实体时，单独的 & 不被改成 &amp;', () => {
    const text = (src: string) => plainPreview(src);
    expect(text('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
    expect(text('a&nbsp;b')).toBe('a b'); // 不换行空格是空白，预览压成一个空格
    expect(text('R&D &#38; AT&T')).toBe('R&D & AT&T');
  });
});

describe('lexMarkdown', () => {
  it('同一段文字重复分析得到同一份结果（缓存）', () => {
    expect(lexMarkdown('**x**')).toBe(lexMarkdown('**x**'));
  });
});

/* 逐字输出时的增量分析：每个前缀的结果都和整段重新分析的完全一样 */
describe('IncrementalLexer', () => {
  const DOC = [
    '## 标题',
    '',
    '第一段，**加粗：**后面，带网址 https://example.com/a?b=1 。',
    '第二行',
    '',
    '- 苹果',
    '- 香蕉',
    '',
    '  接在列表项后面的一段',
    '- 橙子',
    '',
    '1. 一',
    '2. 二',
    '',
    '> 引用的话',
    '> 第二行引用',
    '',
    '| 名字 | 年龄 |',
    '|---|---|',
    '| 小明 | 12 |',
    '| 小红 | 13 |',
    '',
    '```ts',
    'const a = 1;',
    '',
    'function f() {}',
    '```',
    '',
    '标题行',
    '---',
    '',
    '[链接][ref] 在前面，定义在后面',
    '',
    '[ref]: https://example.com/ref',
    '',
    '- [x] 做了',
    '- [ ] 没做',
    '',
    '收尾的话 *斜体* ~~删除~~ `代码`',
  ].join('\n');
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  it('一个字一个字往后加：每个前缀都和整段分析的结果一样', () => {
    for (const step of [1, 3, 7]) {
      const inc = new IncrementalLexer();
      for (let n = step; n <= DOC.length + step; n += step) {
        const text = DOC.slice(0, Math.min(n, DOC.length));
        if (!same(inc.lex(text), lexMarkdown(text)))
          throw new Error(
            `步长 ${step}，前 ${text.length} 个字不一样：${JSON.stringify(text.slice(-30))}`,
          );
      }
    }
  });

  it('块之间的空行不算一块：项之间空一行的有序列表（模型常这样写），一次放出好几个字也和整段分析一样', () => {
    const docs = [
      '1. 一\n\n2. 二\n\n3. 三',
      '先说结论。\n\n1. 一\n\n2. 二\n\n3. 三\n\n收尾。',
      '- 甲\n\n- 乙\n\n- 丙\n\n结尾',
      '> 引用\n\n> 另一个引用\n\n1. 一\n\n2. 二\n\n3. 三\n\n\n收尾',
    ];
    for (const doc of docs)
      for (const step of [1, 2, 4, 5, 7]) {
        const inc = new IncrementalLexer();
        for (let n = step; n <= doc.length + step; n += step) {
          const text = doc.slice(0, Math.min(n, doc.length));
          if (!same(inc.lex(text), lexMarkdown(text)))
            throw new Error(
              `${JSON.stringify(doc.slice(0, 12))}…，步长 ${step}，前 ${text.length} 个字不一样`,
            );
        }
      }
  });

  /* 固定种子的随机对照：松散列表、紧凑列表、引用、代码块（里面有空行）、表格、标题、分隔线、setext 标题、缩进的代码、任务列表拼成的文档，
     随机的步长往后放，每个前缀都和整段分析一样 */
  it('随机拼出的文档、随机的步长：每个前缀都和整段分析一样', () => {
    const FRAGMENTS = [
      '一段普通的话，带 **加粗** 和 `代码`。',
      '第一行\n第二行',
      '## 标题',
      '1. 一\n2. 二\n3. 三',
      '1. 一\n\n2. 二\n\n3. 三',
      '- 苹果\n- 香蕉\n  - 嵌套',
      '- 甲\n\n- 乙\n\n- 丙',
      '- 甲\n\n  接在项后的一段\n- 乙',
      '> 引用的话\n> 第二行',
      '> 引用\n\n> 另一个引用',
      '```ts\nconst a = 1;\n\nfunction f() {}\n```',
      '```\n没有语言\n```',
      '| 名字 | 年龄 |\n|---|---|\n| 小明 | 12 |\n| 小红 | 13 |',
      '---',
      '标题行\n---',
      '- [x] 做了\n- [ ] 没做',
      '    缩进的代码',
      '1. 一\n   - 嵌套\n2. 二',
      '<div>html 块</div>',
      '结尾的话 *斜体* ~~删除~~ https://example.com/a?b=1',
    ];
    // mulberry32：固定种子的伪随机数
    let seed = 20261111;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let k = 0; k < 150; k++) {
      const parts = Array.from(
        { length: 3 + Math.floor(rand() * 6) },
        () => FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)],
      );
      const doc = parts.join(rand() < 0.5 ? '\n\n' : '\n\n\n');
      const maxStep = [1, 3, 8, 17][k % 4];
      const inc = new IncrementalLexer();
      for (let at = 0; at < doc.length;) {
        at = Math.min(doc.length, at + 1 + Math.floor(rand() * maxStep));
        const text = doc.slice(0, at);
        if (!same(inc.lex(text), lexMarkdown(text)))
          throw new Error(`第 ${k} 篇，前 ${at} 个字不一样：${JSON.stringify(text.slice(-40))}`);
      }
    }
  });

  it('前面写完的块沿用同一批词元对象（界面按原文比较，不重画）', () => {
    const inc = new IncrementalLexer();
    const a = inc.lex(DOC.slice(0, 120));
    const b = inc.lex(DOC.slice(0, 140));
    expect(b[0]).toBe(a[0]);
    expect(b.length).toBeGreaterThanOrEqual(a.length - 1);
  });

  it('不是接着往后写的（换了一段文字、变短）整段重来', () => {
    const inc = new IncrementalLexer();
    inc.lex('第一段\n\n第二段\n\n第三段');
    expect(
      same(inc.lex('完全不同的\n\n文字\n\n三块'), lexMarkdown('完全不同的\n\n文字\n\n三块')),
    ).toBe(true);
    expect(same(inc.lex('完全'), lexMarkdown('完全'))).toBe(true);
  });

  it('含回车的文字也不出错', () => {
    const text = '第一段\r\n\r\n第二段\r\n\r\n第三段\r\n\r\n第四段';
    const inc = new IncrementalLexer();
    for (let n = 1; n <= text.length; n++)
      expect(same(inc.lex(text.slice(0, n)), new IncrementalLexer().lex(text.slice(0, n)))).toBe(
        true,
      );
  });
});
