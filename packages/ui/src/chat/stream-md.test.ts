import type { Token } from 'marked';
import { describe, expect, it } from 'vitest';
import { IncrementalLexer, lexMarkdown } from './markdown';
import { fixInline, hiddenTail, linkTailSpans, PENDING_HREF, settleMarkdown } from './stream-md';

/* 逐字输出时的排版（stream-md.ts）：对一个回复，每个前缀都按「放出来的文字改一遍再分析」排版，
   排版只能往前走：块的类型序列只往后追加，已经显示出来的块不变成别的样子（diag-bubble.md 第 2 节那张表里的来回变都不能有） */

type Tk = Token & {
  tokens?: Tk[];
  items?: { tokens: Tk[] }[];
  header?: { tokens: Tk[] }[];
  rows?: { tokens: Tk[] }[][];
  depth?: number;
  ordered?: boolean;
  href?: string;
  text?: string;
};

/** 逐字时每个前缀显示的词元 */
const view = (prefix: string) => lexMarkdown(settleMarkdown(prefix)) as Tk[];
/** 顶层块的类型序列：标题带深度，列表带有序无序 */
const blocks = (tokens: Tk[]): string[] =>
  tokens
    .filter((t) => t.type !== 'space')
    .map((t) =>
      t.type === 'heading' ? `h${t.depth}` : t.type === 'list' ? (t.ordered ? 'ol' : 'ul') : t.type,
    );
/** 一个段落里行内词元的类型（不含文字和换行） */
const kinds = (t: Tk) =>
  (t.tokens ?? []).map((x) => x.type).filter((x) => x !== 'text' && x !== 'br');
const para = (text: string) => {
  const t = view(text).find((x) => x.type === 'paragraph');
  if (!t) throw new Error(`没有段落：${JSON.stringify(text)}`);
  return t;
};
/* 各种写法的回复，中英文都有。每个前缀：块的类型序列只往后追加（前面的块一个不变，最后一块的类型不变） */
const DOCS: Record<string, string> = {
  段落后紧跟列表:
    '先说结论，这一段比较长一点，写到这里就该换行了。\n- 第一点：苹果\n- 第二点：香蕉\n\n收尾的话。',
  段落后紧跟列表英文:
    'Summary of the plan:\n- first item\n- second item\n* star item\n+ plus item\nDone.',
  有序列表: '步骤如下：\n1. 甲\n2. 乙\n3. 丙\n\n完成了。',
  有序列表右括号: 'Steps:\n1) one\n2) two\n10. ten',
  空行后的列表: '正文\n\n- 一\n- 二\n\n1. 先\n2. 后\n\n* 星一\n* 星二',
  分隔线: '前文\n\n---\n\n后文\n\n***\n\n再后文\n\n___\n\n末',
  紧跟在文字后的分隔线: '正文一行\n---\n后面\n再一行\n===\n结束',
  多行段落后的分隔线: '第一行\n第二行\n---\n后面',
  缩进的无序嵌套列表:
    '好的，分几点说：\n- 第一点：先装依赖\n  - 子项甲\n  - 子项乙\n- 第二点：再配置\n    - 更深一层\n      - 再深一层\n- 第三点',
  缩进的有序嵌套列表:
    '步骤：\n1. 准备\n   1. 子步骤一\n   2. 子步骤二\n2. 执行\n   - 无序子项\n3. 收尾',
  引用里的列表: '前文\n> - 一\n> - 二\n>   - 嵌套\n> 1. 有序\n> 后文',
  列表项里的代码块:
    '- 项一\n  ```js\n  let a = 1;\n\n  foo();\n  ```\n- 项二\n\n1. 步骤\n   ```\n   ls\n   ```\n2. 下一步',
  带格式表头的表格:
    '| **名称** | **说明** |\n|---|---|\n| a | b |\n\n| 命令 | `rm` | [链接](https://a.com) | ~~旧~~ |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |',
  加粗斜体: '前文\n\n***重要***，后面\n\n***\n\n___\n\n结束',
  标题: '# 标题一\n\n正文\n\n## 标题二\n正文二\n### 三\n#### 四\n##### 五\n###### 六',
  引用: '前一段\n> 引用的话\n> 第二行\n\n> 又一段引用\n\n正文',
  代码块含收尾:
    '看代码：\n```python\ndef f():\n    return 1\n\nprint(f())\n```\n然后：\n~~~\nx\n~~~\n结束',
  较长的围栏: '````md\n```js\nlet a = 1\n```\n````\n后面',
  表格: '| 名字 | 数量 | 单价 |\n|:---|---:|:---:|\n| 苹果 | 3 | 1.5 |\n| 香蕉 | 5 | 2 |\n\n以上。',
  表格前有文字: '数据如下\n\n| name | n |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nOK.',
  行内的写法: '这是**加粗**和`代码`以及~~删除~~，还有*斜体*。English **bold** and `code`.',
  行内写法在列表里:
    '- **粗体开头** 然后\n- `代码开头` 然后\n- [链接开头](https://a.com) 然后\n  - 嵌套项\n    - 再嵌套',
  链接和图片:
    '看 [官方文档](https://example.com/a/very/long/url?x=1&y=2) 和 ![图](https://e.com/a.png) 吧',
  不是链接的方括号: '数组 [1] 和 [x] 还有 [笑] 再 [a b] (c)',
  混合: '## 小结\n\n- **名字：**小明，`id` 是 [3](https://a.com/3)\n1. 有序 **粗体：**中文\n\n| a | b |\n|---|---|\n| **x** | `y` |\n\n```\ncode\n```\n> 引用 ~~删~~',
  符号开头的普通文字: '价格：\n- 5 元\n-5 度\n*号开头\n+1\n#标签\n1.5 倍\n2024 年\n~约\n`行内`',
  中文标点: '**注意：**请先备份，好的~ 到点啦~ 再见~~',
};

describe('逐字时排版只往前走', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(`${name}：每个前缀的块序列只往后追加`, () => {
      let prev: string[] | null = null;
      for (let i = 1; i <= doc.length; i++) {
        const now = blocks(view(doc.slice(0, i)));
        if (prev) {
          const ok = now.length >= prev.length && prev.every((b, k) => b === now[k]);
          if (!ok)
            throw new Error(
              `前 ${i} 个字 ${JSON.stringify(doc.slice(Math.max(0, i - 12), i))}：${prev.join(' ')} → ${now.join(' ')}`,
            );
        }
        prev = now;
      }
    });
  }

  it('每个前缀分析的结果，增量分析和整段重新分析完全一样（改过的文字不是上一次的延长也一样）', () => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const [name, doc] of Object.entries(DOCS)) {
      for (const step of [1, 3]) {
        const inc = new IncrementalLexer();
        for (let n = step; n <= doc.length + step; n += step) {
          const text = settleMarkdown(doc.slice(0, Math.min(n, doc.length)));
          if (!same(inc.lex(text), lexMarkdown(text)))
            throw new Error(
              `${name}，步长 ${step}，前 ${n} 个字不一样：${JSON.stringify(text.slice(-30))}`,
            );
        }
      }
    }
  });

  it('写完的回复：每个写法都闭合时，放完以后和原文分析的块序列一样', () => {
    for (const doc of [DOCS.有序列表, DOCS.引用, DOCS.表格, DOCS.行内的写法, DOCS.链接和图片]) {
      expect(blocks(view(doc))).toEqual(blocks(lexMarkdown(doc) as Tk[]));
    }
  });
});

describe('不再先变样再变回', () => {
  it('一行文字下面的 -、--、- 、---：任何前缀都不出现标题，---是分隔线', () => {
    for (const doc of [
      '上一行文字\n- 第一点',
      '上一行文字\n---\n后面',
      '上一行文字\n===\n后面',
      'text\n--\nmore',
    ]) {
      for (let i = 1; i <= doc.length; i++)
        expect(blocks(view(doc.slice(0, i)))).not.toContain('h1');
      for (let i = 1; i <= doc.length; i++)
        expect(blocks(view(doc.slice(0, i)))).not.toContain('h2');
    }
    expect(blocks(view('上一行文字\n---'))).toEqual(['paragraph', 'hr']);
    expect(blocks(view('上一行文字\n- 第一点'))).toEqual(['paragraph', 'ul']);
  });

  it('setext 关掉（历史消息也一样）：标题行下面的 --- 是段落加分隔线，=== 是普通文字', () => {
    expect(blocks(lexMarkdown('标题\n---') as Tk[])).toEqual(['paragraph', 'hr']);
    expect(blocks(lexMarkdown('标题\n===') as Tk[])).toEqual(['paragraph']);
    expect(blocks(lexMarkdown('标题\n-') as Tk[])).toEqual(['paragraph']);
    expect(blocks(lexMarkdown('# 标题\n正文') as Tk[])).toEqual(['h1', 'paragraph']);
    // 多行段落后面直接跟 ---：一个段落（两行）加一条分隔线，第二行不自成一段
    for (const t of [lexMarkdown('a\nb\n---') as Tk[], view('a\nb\n---')]) {
      expect(blocks(t)).toEqual(['paragraph', 'hr']);
      expect(t[0].tokens?.map((x) => x.type)).toEqual(['text', 'br', 'text']);
    }
    // 真的表格（分隔行有 | 或 :）照旧打断段落
    expect(blocks(lexMarkdown('a\nb\n| x | y |\n|---|---|\n| 1 | 2 |') as Tk[])).toEqual([
      'paragraph',
      'table',
    ]);
    // 一个回车就换行的段落：=== 是段落里的一行
    const p = lexMarkdown('标题\n===')[0] as Tk;
    expect(p.tokens?.map((x) => x.type)).toEqual(['text', 'br', 'text']);
  });

  it('行首还看不出是什么的符号先不显示：这一行整个去掉，下一个字到了再按最终的样子出现', () => {
    for (const mark of [
      '-',
      '--',
      '- ',
      '*',
      '**',
      '__',
      '_',
      '+',
      '1',
      '12',
      '1.',
      '1)',
      '1. ',
      '>',
      '> ',
      '#',
      '###',
      '## ',
      '`',
      '``',
      '~',
      '~~',
      '|',
    ]) {
      const only = blocks(view(`上一行文字\n${mark}`));
      expect(only, JSON.stringify(mark)).toEqual(['paragraph']);
      expect(para(`上一行文字\n${mark}`).raw.trimEnd(), JSON.stringify(mark)).toBe('上一行文字');
    }
    // 空行后的符号：不出现空圆点的列表、空的标题、空的引用
    for (const mark of ['-', '--', '*', '1.', '>', '#', '|']) {
      expect(blocks(view(`上一段\n\n${mark}`)), JSON.stringify(mark)).toEqual(['paragraph']);
    }
    // 一有结果就是最终的样子
    expect(blocks(view('上一行文字\n- 第'))).toEqual(['paragraph', 'ul']);
    expect(blocks(view('上一行文字\n1. 第'))).toEqual(['paragraph', 'ol']);
    expect(blocks(view('上一行文字\n> 引'))).toEqual(['paragraph', 'blockquote']);
    expect(blocks(view('上一行文字\n# 标'))).toEqual(['paragraph', 'h1']);
    expect(blocks(view('上一行文字\n---'))).toEqual(['paragraph', 'hr']);
    expect(blocks(view('上一行文字\n#标签'))).toEqual(['paragraph']);
    expect(para('上一行文字\n-5 度').raw).toBe('上一行文字\n-5 度');
    expect(para('上一行文字\n2024 年').raw).toBe('上一行文字\n2024 年');
  });

  it('写全了的分隔线不压：--- 和 - - -；*** 和 ___ 可能是加粗斜体的开头，换行以后才是分隔线', () => {
    expect(blocks(view('前文\n\n---'))).toEqual(['paragraph', 'hr']);
    expect(blocks(view('前文\n\n- - -'))).toEqual(['paragraph', 'hr']);
    for (const mark of ['***', '* * *', '___', '****']) {
      expect(blocks(view(`前文\n\n${mark}`)), mark).toEqual(['paragraph']);
      expect(blocks(view(`前文\n\n${mark}\n`)), mark).toEqual(['paragraph', 'hr']);
    }
  });

  it('***加粗斜体***：开头的符号一到、字一到就是加粗斜体，从没有出现过分隔线，也没有露出星号', () => {
    const doc = '前文\n\n***重要***，后面';
    for (let i = 1; i <= doc.length; i++) {
      const tokens = view(doc.slice(0, i));
      expect(blocks(tokens), `${i}`).not.toContain('hr');
      const last = tokens.filter((t) => t.type === 'paragraph').at(-1)!;
      if (doc.slice(0, i).includes('重')) expect(plainOf(last), `${i}`).not.toMatch(/\*/);
    }
    const p = view('前文\n\n***重要')
      .filter((t) => t.type === 'paragraph')
      .at(-1)!;
    expect(kinds(p)).toEqual(['em']);
    expect(plainOf(p)).toBe('重要');
  });

  it('代码块：开头的围栏一写满就是代码块；结尾的一两个反引号先不显示，不多出一行', () => {
    expect(blocks(view('前面\n``'))).toEqual(['paragraph']);
    expect(blocks(view('前面\n```'))).toEqual(['paragraph', 'code']);
    const code = (t: string) => view(t).find((x) => x.type === 'code')!.text;
    expect(code('```js\nfoo\nbar')).toBe('foo\nbar');
    expect(code('```js\nfoo\nbar\n')).toBe('foo\nbar');
    expect(code('```js\nfoo\nbar\n`')).toBe('foo\nbar');
    expect(code('```js\nfoo\nbar\n``')).toBe('foo\nbar');
    expect(code('```js\nfoo\nbar\n```')).toBe('foo\nbar');
    // 代码里本来就有的反引号不动
    expect(code('```js\nfoo\n`x`')).toBe('foo\n`x`');
    expect(code('```js\nfoo\n`x')).toBe('foo\n`x');
    // 围栏是四个：最后一行的三个反引号可能是收尾的前三个，先不显示；写满四个收尾
    expect(code('````md\n```js\nx\n```')).toBe('```js\nx');
    expect(code('````md\n```js\nx\n````')).toBe('```js\nx');
    expect(code('````md\n```js\nx')).toBe('```js\nx');
    // ~~~ 同理，不和反引号混
    expect(code('~~~\nfoo\n~')).toBe('foo');
    expect(code('~~~\nfoo\n`')).toBe('foo\n`');
    // 收尾后面的字是正文
    expect(blocks(view('```js\nfoo\n```\n后'))).toEqual(['code', 'paragraph']);
  });

  it('表格：表头行一出现就是表格，分隔行写到一半不露出来', () => {
    const h = (t: string) => {
      const tab = view(t).find((x) => x.type === 'table');
      return tab ? { cols: tab.header!.length, rows: tab.rows!.length } : null;
    };
    expect(h('| 名'.slice(0, 1))).toBeNull(); // 只有一个竖线：还没有字
    expect(h('| 名')).toEqual({ cols: 1, rows: 0 });
    expect(h('| 名字 | 数')).toEqual({ cols: 2, rows: 0 });
    expect(h('| 名字 | 数量 |')).toEqual({ cols: 2, rows: 0 });
    expect(h('| 名字 | 数量 |\n')).toEqual({ cols: 2, rows: 0 });
    for (const delim of ['|', '|-', '|--', '|---', '|---|', '|---|-', '|---|--', '|---|---|']) {
      expect(h(`| 名字 | 数量 |\n${delim}`), delim).toEqual({ cols: 2, rows: 0 });
      // 整个过程中没有出现两行字面的竖线
      expect(blocks(view(`| 名字 | 数量 |\n${delim}`)), delim).toEqual(['table']);
    }
    expect(h('| 名字 | 数量 |\n|---|---|\n|')).toEqual({ cols: 2, rows: 0 }); // 数据行只有竖线：先不显示
    expect(h('| 名字 | 数量 |\n|---|---|\n| 苹')).toEqual({ cols: 2, rows: 1 });
    expect(h('| 名字 | 数量 |\n|---|---|\n| 苹果 | 3 |\n| 香')).toEqual({ cols: 2, rows: 2 });
    // 表格前面有文字：还是一个段落加一个表格
    expect(blocks(view('说明\n| 名字 | 数量 |'))).toEqual(['paragraph', 'table']);
    // 下一行不是分隔行（很少见）：变回普通文字
    expect(blocks(view('| 名字 | 数量 |\n| 苹果 | 3 |'))).toEqual(['paragraph']);
  });
});

/* 列表里每个项：有字的项数、没有字的项数（空圆点） */
function listStats(tokens: Tk[]): { items: number; empty: number } {
  let items = 0;
  let empty = 0;
  for (const t of tokens) {
    if (t.type === 'list')
      for (const it of t.items ?? []) {
        items++;
        const own = it.tokens.filter((x) => x.type !== 'list' && x.type !== 'space');
        if (!own.length || own.every((x) => plainOf(x).trim() === '')) empty++;
        const sub = listStats(it.tokens);
        items += sub.items;
        empty += sub.empty;
      }
    else if (t.type === 'blockquote') {
      const sub = listStats(t.tokens ?? []);
      items += sub.items;
      empty += sub.empty;
    }
  }
  return { items, empty };
}
function codeTexts(tokens: Tk[]): string[] {
  return tokens.flatMap((t) => [
    ...(t.type === 'code' ? [t.text ?? ''] : []),
    ...codeTexts(t.tokens ?? []),
    ...codeTexts((t.items ?? []).flatMap((it) => it.tokens)),
  ]);
}

describe('缩进的列表标记也先不显示', () => {
  const NESTED = [
    DOCS.缩进的无序嵌套列表,
    DOCS.缩进的有序嵌套列表,
    DOCS.引用里的列表,
    DOCS.列表项里的代码块,
    '- a\n\t- tab 缩进\n\t\t- 再缩进',
    'Plan:\n1. one\n   - sub a\n     1. deep\n   - sub b\n2. two',
  ];
  it('每个前缀：没有空圆点（没有字的列表项），列表项只增不减', () => {
    for (const doc of NESTED) {
      let prev = 0;
      for (let i = 1; i <= doc.length; i++) {
        const st = listStats(view(doc.slice(0, i)));
        const where = `${JSON.stringify(doc.slice(0, 10))}… 前 ${i} 个字 ${JSON.stringify(doc.slice(Math.max(0, i - 8), i))}`;
        expect(st.empty, where).toBe(0);
        expect(st.items, where).toBeGreaterThanOrEqual(prev);
        prev = st.items;
      }
    }
  });
  it('缩进的 -、1、1.、1. 压住，下一个字到了才出现；列表项里的代码块收尾的反引号不显示', () => {
    for (const mark of [
      '  -',
      '  - ',
      '   1',
      '   1.',
      '   1. ',
      '    -',
      '\t-',
      '  *',
      '  >',
      '  #',
    ]) {
      const t = view(`- 一\n${mark}`);
      expect(listStats(t).items, JSON.stringify(mark)).toBe(1);
    }
    expect(listStats(view('- 一\n  - 二')).items).toBe(2);
    expect(listStats(view('1. 一\n   1. 二')).items).toBe(2);
    // 列表项里的代码块：收尾前的一两个反引号不进代码
    for (const tail of ['', '  `', '  ``', '  ```']) {
      expect(
        codeTexts(view(`- 项\n  \`\`\`js\n  let a;\n${tail}`)).join('|'),
        JSON.stringify(tail),
      ).toBe('let a;');
    }
    for (let i = 1; i <= DOCS.列表项里的代码块.length; i++)
      for (const c of codeTexts(view(DOCS.列表项里的代码块.slice(0, i))))
        expect(c).not.toContain('`');
  });
});

describe('带格式的表头：列数照显示出来的算', () => {
  const HEADERS = [
    '| **名称** | **说明** |',
    '| 命令 | `rm` |',
    '| 名称 | [链接](https://a.com) |',
    '| ~~旧~~ | ~~新~~ |',
    '| *斜* | _下_ |',
    '| **粗体 | 没闭合 |',
    '| `代码` | **粗** | [链](https://a.com) |',
  ];
  it('表头、分隔行、数据行写的每个前缀：不是表格就是什么都没有，从来不出现字面的竖线', () => {
    for (const hdr of HEADERS) {
      const n = hdr.split('|').length - 2; // 列数（竖线数 - 1）
      const cell = ['a', '**b**', '`c`', '[d](https://a.com)'];
      const row =
        '| ' + Array.from({ length: n }, (_, k) => cell[k % cell.length]).join(' | ') + ' |';
      const doc = `${hdr}\n|${'---|'.repeat(n)}\n${row}\n${row}`;
      for (let i = 1; i <= doc.length; i++) {
        const b = blocks(view(doc.slice(0, i)));
        expect(
          b.every((x) => x === 'table'),
          `${JSON.stringify(hdr)} 前 ${i} 个字 ${JSON.stringify(doc.slice(Math.max(0, i - 6), i))}：${b.join(' ')}`,
        ).toBe(true);
      }
    }
  });
  it('一格都剩不下时整行先不显示；剩下的格数是分隔行的列数', () => {
    for (const mark of ['| *', '| **', '| `', '| ~~', '| [', '| !['])
      expect(blocks(view(mark)), mark).toEqual([]);
    expect(blocks(view('| 名称 | **'))).toEqual(['table']);
    const tab = (t: string) => view(t).find((x) => x.type === 'table')!;
    expect(tab('| **名称** | **').header).toHaveLength(1);
    expect(tab('| **名称** | **说').header).toHaveLength(2);
    expect(tab('| 命令 | `').header).toHaveLength(1);
    expect(tab('| 命令 | `r').header).toHaveLength(2);
  });
});

describe('没写完的写法提前变样', () => {
  it('**、行内代码的反引号、~~：开头的符号一出现就不显示，后面的字直接按格式显示', () => {
    expect(kinds(para('这是**加粗'))).toEqual(['strong']);
    expect(kinds(para('这是`代码'))).toEqual(['codespan']);
    expect(kinds(para('这是~~删除'))).toEqual(['del']);
    expect(para('这是**加粗').raw).toBe('这是**加粗**'); // 补上结尾的符号
    // 符号后面还没有字：不显示
    expect(para('这是**').raw).toBe('这是');
    expect(para('这是`').raw).toBe('这是');
    expect(para('这是~~').raw).toBe('这是');
    expect(kinds(para('这是**'))).toEqual([]);
    // 中文标点结尾也认
    expect(kinds(para('**注意：'))).toEqual(['strong']);
  });

  it('结尾的符号逐个到达：不能先露出来再消失', () => {
    for (const [doc, kind] of [
      ['**加粗**', 'strong'],
      ['~~删除~~', 'del'],
    ] as const) {
      const closing = doc.slice(0, -1); // 结尾的符号刚到第一个
      const p = para(`这是${closing}`);
      expect(kinds(p)).toEqual([kind]);
      expect(p.raw).toBe(`这是${doc}`);
      // 前后每个前缀的显示文字：单调不减，没有多出来的 * 或 ~
      for (let i = 1; i <= doc.length; i++) {
        const text = plainOf(para(`这是${doc.slice(0, i)}`));
        expect(text, `${i}`).not.toMatch(/[*~]/);
      }
    }
    // 行尾孤零零的一个 * 或 ~ 先不显示，下一个字定
    expect(para('这是*').raw).toBe('这是');
    expect(para('这是*号').raw).toBe('这是*号');
    expect(para('好的~').raw).toBe('好的');
    expect(para('好的~ 到点啦').raw).toBe('好的~ 到点啦');
  });

  it('单个 * 和 _ 的斜体仍然等闭合；2*3 不是斜体', () => {
    expect(kinds(para('这是*斜体'))).toEqual([]);
    expect(para('这是*斜体').raw).toBe('这是*斜体');
    expect(kinds(para('这是*斜体*好'))).toEqual(['em']);
    expect(kinds(para('这是_斜体'))).toEqual([]);
    expect(kinds(para('2*3'))).toEqual([]);
    expect(para('2*3').raw).toBe('2*3');
    expect(kinds(para('a * b * c'))).toEqual([]);
  });

  it('链接：从 [ 起只显示方括号里的字，网址不显示；写完就是真的链接', () => {
    const link = (t: string) => (para(t).tokens ?? []).find((x) => x.type === 'link');
    const pending = (t: string) => {
      const l = link(t);
      return l ? { href: l.href, text: plainOf(l) } : null;
    };
    expect(pending('看 [')).toBeNull(); // 方括号里还没有字
    expect(pending('看 [官')).toEqual({ href: PENDING_HREF, text: '官' });
    expect(pending('看 [官方文档')).toEqual({ href: PENDING_HREF, text: '官方文档' });
    expect(pending('看 [官方文档]')).toEqual({ href: PENDING_HREF, text: '官方文档' });
    expect(pending('看 [官方文档](')).toEqual({ href: PENDING_HREF, text: '官方文档' });
    expect(pending('看 [官方文档](https://exa')).toEqual({ href: PENDING_HREF, text: '官方文档' });
    expect(pending('看 [官方文档](https://example.com/a?b=1')).toEqual({
      href: PENDING_HREF,
      text: '官方文档',
    });
    expect(pending('看 [官方文档](https://example.com/a)')).toEqual({
      href: 'https://example.com/a',
      text: '官方文档',
    });
    // 整个过程里没有网址的字露出来
    const doc = '看 [官方文档](https://example.com/a?b=1) 吧';
    for (let i = 1; i <= doc.length; i++) {
      const p = para(doc.slice(0, i));
      if (i < doc.indexOf(')') + 1) expect(plainOf(p), `${i}`).not.toMatch(/https?:|\(|\]/);
    }
    // 括号里带括号的网址
    expect(pending('看 [维基](https://en.wikipedia.org/wiki/Foo_(bar')).toEqual({
      href: PENDING_HREF,
      text: '维基',
    });
    expect(pending('看 [维基](https://en.wikipedia.org/wiki/Foo_(bar))')?.text).toBe('维基');
    // 链接文字里有加粗
    expect(
      kinds((link('看 [**粗')?.tokens as unknown as Tk[]).length ? para('看 [**粗') : para('x')),
    ).toEqual(['link']);
  });

  it('图片 ![说明](地址) 同理', () => {
    const img = (t: string) => (para(t).tokens ?? []).find((x) => x.type === 'image');
    expect(img('看 ![图')?.href).toBe(PENDING_HREF);
    expect(img('看 ![图](https://e.com/a')?.text).toBe('图');
    expect(img('看 ![图](https://e.com/a.png)')?.href).toBe('https://e.com/a.png');
    expect(img('看 ![')).toBeUndefined();
    expect(para('看!').raw).toBe('看'); // 行尾的 ! 先不显示（可能是 ![ 的前一半）
    expect(para('看! 好').raw).toBe('看! 好');
  });

  it('[文字] 后面跟的不是 (：变回字面的 [文字]', () => {
    expect(para('数组 [1').raw).toBe('数组 [1](' + PENDING_HREF + ')');
    expect(para('数组 [1] 和').raw).toBe('数组 [1] 和');
    expect(kinds(para('数组 [1] 和'))).toEqual([]);
    expect(kinds(para('任务 [ ] 和 [x] 好'))).toEqual([]);
  });

  it('到这一段结束都没闭合的：变回原样的文字，和历史消息里一致', () => {
    for (const doc of [
      '这是**没闭合\n\n下一段',
      '这是`没闭合\n\n下一段',
      '这是~~没闭合\n\n下一段',
      '看 [没闭合\n\n下一段',
    ]) {
      const settled = lexMarkdown(settleMarkdown(doc)) as Tk[];
      expect(settled.filter((t) => t.type === 'paragraph').map(kinds)).toEqual([[], []]);
      expect(blocks(settled)).toEqual(blocks(lexMarkdown(doc) as Tk[]));
    }
    // 同一段里换行也一样（只补当前这一行）
    expect(kinds(para('这是**没闭合\n后面'))).toEqual([]);
  });

  it('不改围栏代码块里面的字', () => {
    expect(settleMarkdown('```\n**x\n[y](z\n- 1')).toBe('```\n**x\n[y](z\n- 1');
    expect(settleMarkdown('```\n**x\n```\n**y')).toBe('```\n**x\n```\n**y**');
  });

  it('只改最后一行：前面的文字一个字不动', () => {
    const doc = '第一段 **粗** 完。\n\n- 项一\n- 项二 **未完';
    const out = settleMarkdown(doc);
    expect(out.startsWith('第一段 **粗** 完。\n\n- 项一\n- 项二 ')).toBe(true);
    expect(settleMarkdown('第一行\n第二行')).toBe('第一行\n第二行');
    expect(settleMarkdown('')).toBe('');
  });
});

describe('fixInline', () => {
  it('补上结尾的符号；符号后面的空白放在补上的符号后面', () => {
    expect(fixInline('**粗 ')).toBe('**粗** ');
    expect(fixInline('**粗 **')).toBe('**粗** ');
    expect(fixInline('a `b')).toBe('a `b`');
    expect(fixInline('``a b')).toBe('``a b``');
    expect(fixInline('~~删')).toBe('~~删~~');
  });
  it('嵌套的按相反的顺序补', () => {
    expect(fixInline('**[文字')).toBe(`**[文字](${PENDING_HREF})**`);
    expect(fixInline('[**粗')).toBe(`[**粗**](${PENDING_HREF})`);
    expect(fixInline('**粗 ~~删')).toBe('**粗 ~~删~~**');
    expect(fixInline('**a `b')).toBe('**a `b`**');
  });
  it('转义的符号、代码里的符号不算', () => {
    expect(fixInline('\\*\\*不是')).toBe('\\*\\*不是');
    expect(fixInline('`a**b`')).toBe('`a**b`');
    expect(fixInline('`a**b')).toBe('`a**b`');
  });
  it('后面没有字的开头符号连同外面空的一起去掉', () => {
    expect(fixInline('前面**[')).toBe('前面');
    expect(fixInline('前面![')).toBe('前面');
    expect(fixInline('前面`')).toBe('前面');
  });
  it('没有可补的原样', () => {
    expect(fixInline('普通的一句话。')).toBe('普通的一句话。');
    expect(fixInline('**加粗** 和 [链接](https://a.com)')).toBe(
      '**加粗** 和 [链接](https://a.com)',
    );
  });
});

describe('链接的网址不占放字的时间：位置、没显示的字', () => {
  it('linkTailSpans：] 到 ) 的范围（没写完的到行尾），围栏代码块里的不算', () => {
    const t = '看 [a](http://x.y/z) 和 ![b](u)，再 [c](pend';
    const spans = linkTailSpans(t);
    expect(spans.map(([a, b]) => t.slice(a, b))).toEqual(['](http://x.y/z)', '](u)', '](pend']);
    expect(linkTailSpans('没有链接')).toEqual([]);
    expect(linkTailSpans('```\n[a](b)\n```\n[c](d)').map(([a, b]) => [a, b])).toEqual([[17, 21]]);
    // 方括号后面不是 ( 的不算
    expect(linkTailSpans('[1] 和 [2](x')).toEqual([[8, 11]]);
    // 逐行：后面一行的位置也对
    const t2 = '第一行\n[a](b)';
    expect(linkTailSpans(t2).map(([a, b]) => t2.slice(a, b))).toEqual(['](b)']);
  });

  it('hiddenTail：放出来的文字末尾有几个字没显示出来', () => {
    const h = (raw: string) => hiddenTail(raw, view(raw));
    expect(h('这是**加粗')).toBe(0);
    expect(h('这是**加粗*')).toBe(1);
    expect(h('这是**加粗**')).toBe(2);
    expect(h('文字\n-')).toBe(2);
    expect(h('```\nfoo\n`')).toBe(2);
    expect(h('普通的话')).toBe(0);
    expect(h('')).toBe(0);
    // 代码块末尾有空行：空行的换行和去掉的结尾换行是同一个字，不能数少
    expect(h('```\nfoo\n\n')).toBe(1);
    expect(h('```\nfoo\n\n`')).toBe(2);
    expect(h('```\nfoo\n\nbar\n\n')).toBe(1);
    expect(h('```\nfoo\n\nbar\n\n``')).toBe(3);
    expect(h('```\nfoo\n\n\n')).toBe(1);
  });
});

/** 词元里显示出来的文字 */
function plainOf(t: Tk): string {
  if (t.tokens) return t.tokens.map(plainOf).join('');
  return t.type === 'br' ? '\n' : (t.text ?? t.raw);
}
