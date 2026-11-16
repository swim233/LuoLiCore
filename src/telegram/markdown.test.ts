import { describe, expect, it } from 'vitest';
import { markdownBlocks } from './markdown.js';
import type { InputRichBlock } from './rich.js';

/** 一段原文转成的块（不看各块的原文） */
const blocks = (text: string): InputRichBlock[] => markdownBlocks(text).map((part) => part.block);
/** 只有一个段落时它的文字 */
const para = (text: string) => {
  const [only, ...rest] = blocks(text);
  expect(rest).toEqual([]);
  expect(only?.type).toBe('paragraph');
  return (only as { text: unknown }).text;
};

describe('段落与行内的样式', () => {
  it('段落；一个回车是 \\n；挨着中文标点的加粗', () => {
    expect(blocks('第一段\n\n第二段')).toEqual([
      { type: 'paragraph', text: '第一段' },
      { type: 'paragraph', text: '第二段' },
    ]);
    expect(para('第一行\n第二行')).toBe('第一行\n第二行');
    expect(para('**注意：**请先备份')).toEqual([{ type: 'bold', text: '注意：' }, '请先备份']);
  });

  it('加粗、斜体、删除线、行内代码，互相套着的', () => {
    expect(para('**粗** *斜* ~~删~~ `码`')).toEqual([
      { type: 'bold', text: '粗' },
      ' ',
      { type: 'italic', text: '斜' },
      ' ',
      { type: 'strikethrough', text: '删' },
      ' ',
      { type: 'code', text: '码' },
    ]);
    expect(para('**粗*斜*~~删~~**')).toEqual({
      type: 'bold',
      text: ['粗', { type: 'italic', text: '斜' }, { type: 'strikethrough', text: '删' }],
    });
    expect(para('***都有***')).toEqual({ type: 'italic', text: { type: 'bold', text: '都有' } });
    // 行内代码里的符号原样
    expect(para('`**不粗** $x$`')).toEqual({ type: 'code', text: '**不粗** $x$' });
  });
});

describe('块', () => {
  it('标题 1 到 6 级', () => {
    expect(blocks('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六 **粗**')).toEqual([
      { type: 'heading', text: '一', size: 1 },
      { type: 'heading', text: '二', size: 2 },
      { type: 'heading', text: '三', size: 3 },
      { type: 'heading', text: '四', size: 4 },
      { type: 'heading', text: '五', size: 5 },
      { type: 'heading', text: ['六 ', { type: 'bold', text: '粗' }], size: 6 },
    ]);
  });

  it('代码块：有语言、没语言、语言后面还有别的词；里面的 Markdown 符号原样', () => {
    expect(blocks('```ts\nconst a = **1**;\n# 不是标题\n```')).toEqual([
      { type: 'pre', text: 'const a = **1**;\n# 不是标题', language: 'ts' },
    ]);
    expect(blocks('```\n$x$ 和 [链接](https://a.com)\n```')).toEqual([
      { type: 'pre', text: '$x$ 和 [链接](https://a.com)' },
    ]);
    expect(blocks('```python title="a.py"\nprint(1)\n```')).toEqual([
      { type: 'pre', text: 'print(1)', language: 'python' },
    ]);
    expect(blocks('    缩进的代码 *x*')).toEqual([{ type: 'pre', text: '缩进的代码 *x*' }]);
  });

  it('一个字都没有的标题（Telegram 不收）：改成段落，文字是原文；只有空格、只有一个行内公式的照常是标题', () => {
    expect(blocks('#')).toEqual([{ type: 'paragraph', text: '#' }]);
    // 后面紧跟着下一个块时原文带着换行：段落里去掉
    expect(blocks('#\n# 标题')).toEqual([
      { type: 'paragraph', text: '#' },
      { type: 'heading', text: '标题', size: 1 },
    ]);
    expect(blocks('##   \n\n正文')).toEqual([
      { type: 'paragraph', text: '##   ' },
      { type: 'paragraph', text: '正文' },
    ]);
    // 链接的字是空的：标题里还是一个字都没有
    expect(blocks('# [](https://a.com)\n')).toEqual([
      { type: 'paragraph', text: '# [](https://a.com)' },
    ]);
    // 引用、列表里的也一样
    expect(blocks('> #')).toEqual([
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: '#' }] },
    ]);
    // 原文照旧，退路发的还是它
    expect(markdownBlocks('#\n\n正文').map((part) => part.raw)).toEqual(['#\n\n', '正文']);
    const nbsp = String.fromCharCode(0xa0);
    expect(blocks('# &nbsp;')).toEqual([{ type: 'heading', text: nbsp, size: 1 }]);
    // 有字，另外夹着一个字是空的链接：照常是标题
    expect(blocks('# 标题 [](https://a.com)')).toEqual([
      {
        type: 'heading',
        text: ['标题 ', { type: 'url', text: '', url: 'https://a.com/' }],
        size: 1,
      },
    ]);
    expect(blocks('## $x$')).toEqual([
      { type: 'heading', text: { type: 'mathematical_expression', expression: 'x' }, size: 2 },
    ]);
  });

  it('里面什么都没有的代码块（Telegram 不收）：改成段落，文字是原文；只有空格、只有换行的照常是代码块', () => {
    expect(blocks('```\n```')).toEqual([{ type: 'paragraph', text: '```\n```' }]);
    expect(blocks('```py\n```\n\n后面')).toEqual([
      { type: 'paragraph', text: '```py\n```' },
      { type: 'paragraph', text: '后面' },
    ]);
    // 后面紧跟着下一个块时原文带着换行：段落里去掉
    expect(blocks('```\n```\n# 标题')).toEqual([
      { type: 'paragraph', text: '```\n```' },
      { type: 'heading', text: '标题', size: 1 },
    ]);
    expect(blocks('```math\n```')).toEqual([{ type: 'paragraph', text: '```math\n```' }]);
    // 没写完的；后面跟着空行时原文末尾有两个换行，段落里都去掉
    expect(blocks('```')).toEqual([{ type: 'paragraph', text: '```' }]);
    expect(blocks('```\n\n')).toEqual([{ type: 'paragraph', text: '```' }]);
    expect(blocks('```\n  \n```')).toEqual([{ type: 'pre', text: '  ' }]);
    expect(blocks('```\n\n\n```')).toEqual([{ type: 'pre', text: '\n' }]);
  });

  it('列表：无序、有序（含不从 1 开始的）、嵌套', () => {
    expect(blocks('- 苹果\n- **香蕉**')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: '苹果' }] },
          { blocks: [{ type: 'paragraph', text: { type: 'bold', text: '香蕉' } }] },
        ],
      },
    ]);
    expect(blocks('1. 一\n2. 二')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: '一' }], value: 1, type: '1' },
          { blocks: [{ type: 'paragraph', text: '二' }], value: 2, type: '1' },
        ],
      },
    ]);
    expect(blocks('3. 三\n4. 四')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: '三' }], value: 3, type: '1' },
          { blocks: [{ type: 'paragraph', text: '四' }], value: 4, type: '1' },
        ],
      },
    ]);
    expect(blocks('- 外\n  1. 里\n- 二')).toEqual([
      {
        type: 'list',
        items: [
          {
            blocks: [
              { type: 'paragraph', text: '外' },
              {
                type: 'list',
                items: [{ blocks: [{ type: 'paragraph', text: '里' }], value: 1, type: '1' }],
              },
            ],
          },
          { blocks: [{ type: 'paragraph', text: '二' }] },
        ],
      },
    ]);
  });

  it('列表：任务（勾了的、没勾的），勾选框不再出字；项里有几段的；空的项', () => {
    expect(blocks('- [x] 做了\n- [ ] 没做')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: '做了' }], has_checkbox: true, is_checked: true },
          { blocks: [{ type: 'paragraph', text: '没做' }], has_checkbox: true },
        ],
      },
    ]);
    expect(blocks('- 第一段\n\n  第二段\n- 二')).toEqual([
      {
        type: 'list',
        items: [
          {
            blocks: [
              { type: 'paragraph', text: '第一段' },
              { type: 'paragraph', text: '第二段' },
            ],
          },
          { blocks: [{ type: 'paragraph', text: '二' }] },
        ],
      },
    ]);
    expect(blocks('-\n- b')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: '' }] },
          { blocks: [{ type: 'paragraph', text: 'b' }] },
        ],
      },
    ]);
  });

  it('引用，引用里套列表和代码块', () => {
    expect(blocks('> 引用的话\n> - 项\n>\n> ```js\n> x()\n> ```')).toEqual([
      {
        type: 'blockquote',
        blocks: [
          { type: 'paragraph', text: '引用的话' },
          { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: '项' }] }] },
          { type: 'pre', text: 'x()', language: 'js' },
        ],
      },
    ]);
    expect(blocks('>')).toEqual([
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: '' }] },
    ]);
  });

  it('表格：第一行是表头，三种对齐（没写是 left），格子里有样式', () => {
    const cell = (text: unknown, align: string, header = false) => ({
      text,
      ...(header ? { is_header: true } : {}),
      align,
      valign: 'top',
    });
    expect(blocks('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | **2** | `3` | 4 |')).toEqual([
      {
        type: 'table',
        cells: [
          [
            cell('a', 'left', true),
            cell('b', 'center', true),
            cell('c', 'right', true),
            cell('d', 'left', true),
          ],
          [
            cell('1', 'left'),
            cell({ type: 'bold', text: '2' }, 'center'),
            cell({ type: 'code', text: '3' }, 'right'),
            cell('4', 'left'),
          ],
        ],
        is_bordered: true,
      },
    ]);
  });

  it('超过 20 列的表格改成代码块，文字是这张表的原文；20 列的照常是表格', () => {
    const table = (columns: number) =>
      [
        `| ${Array.from({ length: columns }, (_, i) => `h${i}`).join(' | ')} |`,
        `|${'---|'.repeat(columns)}`,
        `| ${Array.from({ length: columns }, (_, i) => `${i}`).join(' | ')} |`,
      ].join('\n');
    expect(blocks(`${table(21)}\n\n后面`)).toEqual([
      { type: 'pre', text: table(21) },
      { type: 'paragraph', text: '后面' },
    ]);
    // 后面紧跟着别的块（不空行）时，表格的原文带着末尾的换行：代码块里去掉
    expect(blocks(`${table(21)}\n# 标题`)).toEqual([
      { type: 'pre', text: table(21) },
      { type: 'heading', text: '标题', size: 1 },
    ]);
    expect(blocks(table(20))[0]?.type).toBe('table');
  });

  it('分隔线；链接定义不出块；全是空白的文字没有块', () => {
    expect(blocks('上面\n\n---\n\n下面')).toEqual([
      { type: 'paragraph', text: '上面' },
      { type: 'divider' },
      { type: 'paragraph', text: '下面' },
    ]);
    expect(blocks('[ref]: https://example.com')).toEqual([]);
    expect(blocks('前面\n\n[ref]: https://example.com\n\n后面')).toEqual([
      { type: 'paragraph', text: '前面' },
      { type: 'paragraph', text: '后面' },
    ]);
    expect(blocks('')).toEqual([]);
    expect(blocks('  \n\n \t \n')).toEqual([]);
  });

  it('原始 HTML 的块是段落，文字是原文（去掉末尾的换行）', () => {
    expect(blocks('<div>\n<b>粗</b>\n</div>\n\n后面')).toEqual([
      { type: 'paragraph', text: '<div>\n<b>粗</b>\n</div>' },
      { type: 'paragraph', text: '后面' },
    ]);
    expect(blocks('<div>x</div>\n')).toEqual([{ type: 'paragraph', text: '<div>x</div>' }]);
  });

  it('原始 HTML 的块里夹着十万个换行：文字是原文，只去掉末尾的换行', () => {
    const html = `<!--${'\n'.repeat(100_000)}x -->`;
    expect(blocks(`${html}\n`)).toEqual([{ type: 'paragraph', text: html }]);
  });
});

describe('公式', () => {
  it('块公式三种写法：$$…$$、\\[…\\]、math 围栏', () => {
    expect(blocks('$$\nE = mc^2\n$$\n\n\\[ \\frac{a}{b} \\]\n\n```math\nx_1 * y\n```')).toEqual([
      { type: 'mathematical_expression', expression: 'E = mc^2' },
      { type: 'mathematical_expression', expression: '\\frac{a}{b}' },
      { type: 'mathematical_expression', expression: 'x_1 * y' },
    ]);
  });

  it('行内公式两种写法：$…$、\\(…\\)；也在标题、加粗、表格的格子里', () => {
    expect(para('面积 $\\pi r^2$ 和 \\(a_1\\)')).toEqual([
      '面积 ',
      { type: 'mathematical_expression', expression: '\\pi r^2' },
      ' 和 ',
      { type: 'mathematical_expression', expression: 'a_1' },
    ]);
    expect(blocks('## 标题 $x$')).toEqual([
      {
        type: 'heading',
        text: ['标题 ', { type: 'mathematical_expression', expression: 'x' }],
        size: 2,
      },
    ]);
    expect(para('**粗 $a*b$**')).toEqual({
      type: 'bold',
      text: ['粗 ', { type: 'mathematical_expression', expression: 'a*b' }],
    });
  });

  it('「这个 $5，那个 $10」不是公式', () => {
    expect(para('这个 $5，那个 $10')).toBe('这个 $5，那个 $10');
    expect(para('$HOME 和 $PATH')).toBe('$HOME 和 $PATH');
  });
});

describe('链接', () => {
  it('正常的链接：文字可以带样式，网址规整过', () => {
    expect(para('看 [这个**页面**](https://example.com/a) 吧')).toEqual([
      '看 ',
      { type: 'url', text: ['这个', { type: 'bold', text: '页面' }], url: 'https://example.com/a' },
      ' 吧',
    ]);
    expect(para('[首页](http://example.com)')).toEqual({
      type: 'url',
      text: '首页',
      url: 'http://example.com/',
    });
  });

  it('没写协议的域名补 https', () => {
    expect(para('[文档](docs.foo.dev/a)')).toEqual({
      type: 'url',
      text: '文档',
      url: 'https://docs.foo.dev/a',
    });
  });

  it('别的协议、带用户名密码的：整个显示原文', () => {
    expect(para('[点我](javascript:alert(1))')).toBe('[点我](javascript:alert(1))');
    expect(para('[文件](ftp://example.com/a)')).toBe('[文件](ftp://example.com/a)');
    expect(para('[登录](https://user:pw@example.com/)')).toBe(
      '[登录](https://user:pw@example.com/)',
    );
  });

  it('链接套链接：里面的只留文字', () => {
    expect(para('[外 [里](https://b.com)](https://a.com)')).toEqual([
      '[外 ',
      { type: 'url', text: '里', url: 'https://b.com/' },
      '](https://a.com)',
    ]);
    expect(para('[看 https://b.com 这里](https://a.com)')).toEqual({
      type: 'url',
      text: '看 https://b.com 这里',
      url: 'https://a.com/',
    });
    // 链接的文字里有尖括号的网址、图片：不再成链接，只留文字（图片显示原文）
    expect(para('[看 <https://b.com> 这](https://a.com)')).toEqual({
      type: 'url',
      text: '看 https://b.com 这',
      url: 'https://a.com/',
    });
    expect(para('[![图](https://a.com/i.png)](https://b.com)')).toEqual({
      type: 'url',
      text: '![图](https://a.com/i.png)',
      url: 'https://b.com/',
    });
  });

  it('正文里直接写的网址是原样的字（Telegram 自己会认）；尖括号包着的是链接', () => {
    expect(para('网址 https://example.com/a?b=1 和 www.example.com')).toBe(
      '网址 https://example.com/a?b=1 和 www.example.com',
    );
    expect(para('<https://example.com/x>')).toEqual({
      type: 'url',
      text: 'https://example.com/x',
      url: 'https://example.com/x',
    });
  });

  it('图片显示成链接：有说明的写说明，没有说明的写网址；网址不认的显示原文', () => {
    expect(para('![一张图](https://example.com/a.png)')).toEqual({
      type: 'url',
      text: '一张图',
      url: 'https://example.com/a.png',
    });
    expect(para('![](https://example.com/a.png)')).toEqual({
      type: 'url',
      text: 'https://example.com/a.png',
      url: 'https://example.com/a.png',
    });
    expect(para('![图](data:image/png;base64,xx)')).toBe('![图](data:image/png;base64,xx)');
  });
});

describe('原样的字', () => {
  it('原始 HTML 当字；HTML 实体解开；没闭合的写法原样', () => {
    expect(para('a <b>粗</b> c')).toBe('a <b>粗</b> c');
    expect(para('&amp; &lt; &#x4F60; R&D')).toBe('& < 你 R&D');
    expect(para('这是**没写完的加粗 和 一个 `没闭合的代码')).toBe(
      '这是**没写完的加粗 和 一个 `没闭合的代码',
    );
    expect(blocks('```python\n没写完的代码块')).toEqual([
      { type: 'pre', text: '没写完的代码块', language: 'python' },
    ]);
    expect(para('\\*转义的星号\\*')).toBe('*转义的星号*');
  });
});

describe('每个块对应的原文', () => {
  it('块的原文连着它后面的空行、链接定义；全部连起来就是原文', () => {
    const text = '# 标题\n\n第一段\n\n[ref]: https://a.com\n\n- 项\n\n$$\nx\n$$\n';
    const parts = markdownBlocks(text);
    expect(parts.map((part) => part.raw)).toEqual([
      '# 标题\n\n',
      '第一段\n\n[ref]: https://a.com\n\n',
      '- 项\n\n',
      '$$\nx\n$$\n',
    ]);
    expect(parts.map((part) => part.raw).join('')).toBe(text);
  });

  it('开头是链接定义、空行：算进第一个块的原文，不丢', () => {
    const text = '[r]: https://r.com\n\n\n正文 [看这](r)\n\n后面';
    expect(markdownBlocks(text).map((part) => part.raw)).toEqual([
      '[r]: https://r.com\n\n\n正文 [看这](r)\n\n',
      '后面',
    ]);
  });
});
