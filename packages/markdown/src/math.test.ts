import { Lexer, marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { lex, type Token } from './index.js';

type Tk = Token & {
  text?: string;
  lang?: string;
  tokens?: Tk[];
  items?: Tk[];
  header?: { tokens: Tk[] }[];
  rows?: { tokens: Tk[] }[][];
};

const math = (src: string) => lex(src, { math: true }) as Tk[];

/** 顶层的块：[类型, 内容]（公式是公式的内容，段落是它的文字，代码块带语言），块之间的空行不算 */
const blocks = (tokens: Tk[]) =>
  tokens
    .filter((t) => t.type !== 'space')
    .map((t) => [t.type === 'code' ? `code:${t.lang ?? ''}` : t.type, t.text ?? t.raw]);

/** 行内词元写成一行：行内公式写成 ⟨内容⟩，加粗、斜体、删除线写成 <b> <i> <s>，行内代码 `…`，链接 [文字](→)，其余原样 */
function inline(tokens: Tk[] = []): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'inlineMath':
          return `⟨${t.text}⟩`;
        case 'strong':
          return `<b>${inline(t.tokens)}</b>`;
        case 'em':
          return `<i>${inline(t.tokens)}</i>`;
        case 'del':
          return `<s>${inline(t.tokens)}</s>`;
        case 'codespan':
          return `\`${t.text}\``;
        case 'link':
          return `[${inline(t.tokens)}](→)`;
        default:
          return t.raw;
      }
    })
    .join('');
}
/** 第一块（段落、标题）的行内词元 */
const line = (src: string) => inline(math(src)[0]!.tokens);
const rawOf = (tokens: Tk[]) => tokens.map((t) => t.raw).join('');

describe('单独成块的公式', () => {
  it('$$ 在同一行、跨几行；\\[…\\]；标成 math 的围栏（不分大小写）：内容原样，去掉首尾空白', () => {
    expect(blocks(math('$$ E = mc^2 $$'))).toEqual([['blockMath', 'E = mc^2']]);
    const body = String.raw`\frac{a}{b} * c_1 & d \\ e_{2}`;
    expect(blocks(math(`$$\n${body}\n$$`))).toEqual([['blockMath', body]]);
    expect(blocks(math(`$$\n  ${body}\n  第二行 *x*\n$$`))).toEqual([
      ['blockMath', `${body}\n  第二行 *x*`],
    ]);
    expect(blocks(math(`\\[ ${body} \\]`))).toEqual([['blockMath', body]]);
    expect(blocks(math(`\\[\n${body}\n\\]`))).toEqual([['blockMath', body]]);
    expect(blocks(math('```math\n' + body + '\n```'))).toEqual([['blockMath', body]]);
    expect(blocks(math('```MATH\nx_1\n```'))).toEqual([['blockMath', 'x_1']]);
    expect(blocks(math('~~~Math\nx_1\n~~~'))).toEqual([['blockMath', 'x_1']]);
  });

  it('别的语言（latex、tex、mathematica）、没写语言的围栏还是代码块', () => {
    expect(blocks(math('```latex\nx_1\n```'))).toEqual([['code:latex', 'x_1']]);
    expect(blocks(math('```tex\nx_1\n```'))).toEqual([['code:tex', 'x_1']]);
    // 看的是语言的第一个词等于 math，不是以 math 开头
    expect(blocks(math('```mathematica\nx_1\n```'))).toEqual([['code:mathematica', 'x_1']]);
    expect(blocks(math('```math extra\nx_1\n```'))).toEqual([['blockMath', 'x_1']]);
    expect(blocks(math('```\n$x$\n```'))).toEqual([['code:', '$x$']]);
  });

  it('$$ 和 \\[ 的四种排法都是块：同一行；各占一行；只有结尾单独一行；贴着内容的首尾（aligned）', () => {
    expect(blocks(math('$$x = 1$$'))).toEqual([['blockMath', 'x = 1']]);
    expect(blocks(math('$$\nx = 1\n$$'))).toEqual([['blockMath', 'x = 1']]);
    expect(blocks(math('$$x = 1\n= 2\n$$'))).toEqual([['blockMath', 'x = 1\n= 2']]);
    expect(blocks(math('$$\nx = 1\n= 2$$'))).toEqual([['blockMath', 'x = 1\n= 2']]);
    const aligned = String.raw`\begin{aligned}
a &= b \\
c &= d
\end{aligned}`;
    expect(blocks(math(`$$${aligned}$$`))).toEqual([['blockMath', aligned]]);
    expect(blocks(math('\\[x = 1\\]'))).toEqual([['blockMath', 'x = 1']]);
    expect(blocks(math('\\[\nx = 1\n\\]'))).toEqual([['blockMath', 'x = 1']]);
    expect(blocks(math('\\[x = 1\n= 2\n\\]'))).toEqual([['blockMath', 'x = 1\n= 2']]);
    expect(blocks(math(`\\[${aligned}\\]`))).toEqual([['blockMath', aligned]]);
    // 结尾后面可以有空格
    expect(blocks(math('$$\nx\n$$   \n后面'))).toEqual([
      ['blockMath', 'x'],
      ['paragraph', '后面'],
    ]);
  });

  it('块的内容里可以有单个的 $；写了反斜杠的 \\$ 不算分界', () => {
    expect(blocks(math('$$\n\\text{if $x > 0$}\n$$'))).toEqual([
      ['blockMath', '\\text{if $x > 0$}'],
    ]);
    expect(blocks(math('$$a$b$$'))).toEqual([['blockMath', 'a$b']]);
    expect(blocks(math('$$ x \\$$ y $$'))).toEqual([['blockMath', 'x \\$$ y']]);
    expect(blocks(math('\\[ a \\\\]\n b \\]'))).toEqual([['blockMath', 'a \\\\]\n b']]);
  });

  it('遇到的第一个 $$、\\] 后面不是行尾：不是块，交给行内去认', () => {
    expect(blocks(math('$$a$$ 和 $$b$$'))).toEqual([['paragraph', '$$a$$ 和 $$b$$']]);
    expect(line('$$a$$ 和 $$b$$')).toBe('⟨a⟩ 和 ⟨b⟩');
    expect(line('\\[a\\] 和 \\[b\\]')).toBe('⟨a⟩ 和 ⟨b⟩');
    expect(blocks(math('$$\na\n$$ 后面跟字'))).toEqual([['paragraph', '$$\na\n$$ 后面跟字']]);
  });

  it('中间有空行：不是块，照原样的字，里面的行内公式照认', () => {
    const tokens = math('$$\nx = 1\n\n说明 $y$\n$$');
    expect(blocks(tokens)).toEqual([
      ['paragraph', '$$\nx = 1'],
      ['paragraph', '说明 $y$\n$$'],
    ]);
    expect(inline(tokens.filter((t) => t.type === 'paragraph')[1]!.tokens)).toBe('说明 ⟨y⟩\n$$');
    expect(blocks(math('\\[\na\n\n\\]'))).toEqual([
      ['paragraph', '\\[\na'],
      ['paragraph', '\\]'],
    ]);
    // 只有空格、制表符的一行也是空行
    const types = (src: string) => math(src).map((t) => t.type);
    expect(types('$$\na\n  \nb\n$$')).not.toContain('blockMath');
    expect(types('\\[\na\n\t \nb\n\\]')).not.toContain('blockMath');
  });

  it('第一个公式的结尾写在内容那一行：它到那里为止，不吞后面的正文和下一个公式', () => {
    expect(
      blocks(math('$$\na = 1 $$\n\n中间有一大段正文。\n\n- 还有列表\n\n$$\nb = 2\n$$')),
    ).toEqual([
      ['blockMath', 'a = 1'],
      ['paragraph', '中间有一大段正文。'],
      ['list', '- 还有列表'],
      ['blockMath', 'b = 2'],
    ]);
  });

  it('开头那一行最多三个空格的缩进；四个空格是缩进的代码', () => {
    expect(blocks(math('   $$x$$'))).toEqual([['blockMath', 'x']]);
    expect(blocks(math('   \\[\n   x\n   \\]'))).toEqual([['blockMath', 'x']]);
    expect(blocks(math('    $$x$$'))).toEqual([['code:', '$$x$$']]);
  });

  it('紧跟在文字的下一行（没有空行）：前面的文字是一段，公式是另一块；公式后面紧跟的文字是下一段', () => {
    expect(blocks(math('文字\n$$x$$\n后面'))).toEqual([
      ['paragraph', '文字'],
      ['blockMath', 'x'],
      ['paragraph', '后面'],
    ]);
    expect(blocks(math('第一行\n第二行\n\\[\nx\n\\]\n后面'))).toEqual([
      ['paragraph', '第一行\n第二行'],
      ['blockMath', 'x'],
      ['paragraph', '后面'],
    ]);
    expect(blocks(math('文字\n```math\nx\n```'))).toEqual([
      ['paragraph', '文字'],
      ['blockMath', 'x'],
    ]);
    expect(blocks(math('文字\n$$x = 1\n= 2$$\n后面'))).toEqual([
      ['paragraph', '文字'],
      ['blockMath', 'x = 1\n= 2'],
      ['paragraph', '后面'],
    ]);
  });

  it('列表项、引用里面也认，是它们里面的块', () => {
    const [list] = math('- 项\n  $$x$$\n- 二\n  \\[y\\]');
    expect(list!.type).toBe('list');
    expect(list!.items!.map((item) => blocks(item.tokens!))).toEqual([
      [
        ['text', '项'],
        ['blockMath', 'x'],
      ],
      [
        ['text', '二'],
        ['blockMath', 'y'],
      ],
    ]);
    // 松散的列表（项里有空行）：项里的文字是段落，公式照样是项里的块
    const [loose] = math('- 项\n\n  $$\n  x\n  $$\n- 二');
    expect(loose!.items!.map((item) => blocks(item.tokens!))).toEqual([
      [
        ['paragraph', '项'],
        ['blockMath', 'x'],
      ],
      [['paragraph', '二']],
    ]);
    const [quote] = math('> 引用\n> $$x$$');
    expect(quote!.type).toBe('blockquote');
    expect(blocks(quote!.tokens!)).toEqual([
      ['paragraph', '引用'],
      ['blockMath', 'x'],
    ]);
    const [multi] = math('- 项\n  $$a\n  = b$$\n- 二');
    expect(blocks(multi!.items![0]!.tokens!)).toEqual([
      ['text', '项'],
      ['blockMath', 'a\n= b'],
    ]);
    const [quoted] = math('> 引用\n> $$a\n> = b$$');
    expect(blocks(quoted!.tokens!)).toEqual([
      ['paragraph', '引用'],
      ['blockMath', 'a\n= b'],
    ]);
  });
});

describe('行内的公式', () => {
  it('\\(…\\) 和 $…$；一句里有两个', () => {
    expect(line('行内 \\(a_1\\) 和 $b^2$ 两个')).toBe('行内 ⟨a_1⟩ 和 ⟨b^2⟩ 两个');
    expect(line('前文$x$后文')).toBe('前文⟨x⟩后文');
    expect(line('$a$ 和 $b$')).toBe('⟨a⟩ 和 ⟨b⟩');
    expect(line('\\( \\frac{1}{2} \\)')).toBe('⟨\\frac{1}{2}⟩');
  });

  it('和加粗、行内代码、链接混在一起', () => {
    expect(line('**粗 $x$** 和 `$c$` 和 [链接 $d$](https://a.com) 和 *\\(y\\)*')).toBe(
      '<b>粗 ⟨x⟩</b> 和 `$c$` 和 [链接 ⟨d⟩](→) 和 <i>⟨y⟩</i>',
    );
  });

  it('表格的格子里、标题里、列表项里', () => {
    const [table] = math('| a | b |\n|---|---|\n| $x$ | \\(y\\) |');
    expect(table!.rows!.map((row) => row.map((cell) => inline(cell.tokens)))).toEqual([
      ['⟨x⟩', '⟨y⟩'],
    ]);
    expect(line('# 标题 $x^2$')).toBe('标题 ⟨x^2⟩');
    const [list] = math('- 项 $x$');
    expect(inline(list!.items![0]!.tokens![0]!.tokens)).toBe('项 ⟨x⟩');
  });

  it('没占整行的 $$…$$、\\[…\\] 是行内的公式', () => {
    expect(line('一句中间 $$x$$ 和 \\[y\\] 的')).toBe('一句中间 ⟨x⟩ 和 ⟨y⟩ 的');
    expect(line('$$x$$ 后面还有字')).toBe('⟨x⟩ 后面还有字');
    expect(blocks(math('$$x$$ 后面还有字'))).toEqual([['paragraph', '$$x$$ 后面还有字']]);
  });

  it('公式里的 *、_、~ 不当成加粗、斜体、删除线；外面包着的照样认', () => {
    expect(line('$a_1$ 和 $b_2$')).toBe('⟨a_1⟩ 和 ⟨b_2⟩');
    expect(line('$a*b*c$ 和 $x_1 * y_2$')).toBe('⟨a*b*c⟩ 和 ⟨x_1 * y_2⟩');
    expect(line('*斜 $a*b$ 体*')).toBe('<i>斜 ⟨a*b⟩ 体</i>');
    expect(line('**粗 $a*b$ 体**')).toBe('<b>粗 ⟨a*b⟩ 体</b>');
    expect(line('**粗 \\(a**b\\) 体**')).toBe('<b>粗 ⟨a**b⟩ 体</b>');
    expect(line('~~删 $a~b$ 除~~')).toBe('<s>删 ⟨a~b⟩ 除</s>');
    expect(line('~~删 $a~~b$ 除~~')).toBe('<s>删 ⟨a~~b⟩ 除</s>');
    expect(line('_斜 $a_b$ 体_')).toBe('<i>斜 ⟨a_b⟩ 体</i>');
  });
});

describe('不算公式的', () => {
  it('钱数、变量名：开头的 $ 后面是空白，或结尾的 $ 前面是空白、后面是数字', () => {
    for (const s of ['这个 $5，那个 $10', '$HOME 和 $PATH', '价格是$5,另一个是$10', '$x$5']) {
      expect(line(s), s).toBe(s);
    }
    expect(line('$ x$ 和 $x $')).toBe('$ x$ 和 $x $');
  });

  it('写了反斜杠的 \\$ 是字面的 $，不是开头也不是结尾', () => {
    expect(line('\\$x\\$ 和 \\$5')).toBe('\\$x\\$ 和 \\$5');
    expect(line('$a\\$b$')).toBe('⟨a\\$b⟩');
  });

  it('行内代码、代码块里的不算', () => {
    expect(line('`$x$` 和 `\\(y\\)`')).toBe('`$x$` 和 `\\(y\\)`');
    expect(blocks(math('```js\nconst a = `$x$`;\n```'))).toEqual([['code:js', 'const a = `$x$`;']]);
    expect(blocks(math('    \\[x\\]'))).toEqual([['code:', '\\[x\\]']]);
  });

  it('中间换行的、内容是空的不算', () => {
    expect(line('$a\nb$')).toBe('$a\nb$');
    expect(line('\\(a\nb\\)')).toBe('\\(a\nb\\)');
    expect(line('$$  $$ 和 \\(  \\) 和 \\[\\]')).toBe('$$  $$ 和 \\(  \\) 和 \\[\\]');
    expect(blocks(math('$$\n\n$$'))).toEqual([
      ['paragraph', '$$'],
      ['paragraph', '$$'],
    ]);
    // 内容全是空白、中间又没有空行的：也不是块
    for (const src of ['$$   $$', '$$ \t $$', '$$\n   $$', '\\[   \\]', '\\[\n \t\\]']) {
      expect(blocks(math(src)), src).toEqual([['paragraph', src]]);
    }
  });
});

describe('没闭合的照原样', () => {
  it('只有开头的 $$、\\[、\\(、$', () => {
    expect(line('$$ 没闭合')).toBe('$$ 没闭合');
    expect(line('\\[ 没闭合')).toBe('\\[ 没闭合');
    expect(line('\\( 没闭合')).toBe('\\( 没闭合');
    expect(line('$ 没闭合')).toBe('$ 没闭合');
    expect(line('$$x$')).toBe('$$x$');
    expect(line('a$$b')).toBe('a$$b');
    expect(line('$$x$ 和 a$$b')).toBe('$$x$ 和 a$$b');
  });

  it('$$ 的块到文字结束都没有结尾：整个不当公式，照普通的段落', () => {
    expect(blocks(math('$$\n没闭合\n的块'))).toEqual([['paragraph', '$$\n没闭合\n的块']]);
    expect(blocks(math('前文\n\\[\nx'))).toEqual([['paragraph', '前文\n\\[\nx']]);
  });

  it('没闭合的 math 围栏还是代码块（和别的围栏一样）', () => {
    expect(blocks(math('```math\nx'))).toEqual([['code:math', 'x']]);
  });
});

describe('原文', () => {
  it('打开公式时，顶层词元的 raw 拼起来仍等于原文', () => {
    const docs = [
      '文字\n$$x$$\n后面',
      '第一行\n第二行\n\\[\nx\n\\]\n\n后面的 $y$ 和 \\(z\\)',
      '# 标题 $x$\n\n- 项\n  $$a$$\n- 二\n\n> 引用\n> \\[b\\]\n\n```math\nc\n```\n\n| $d$ | e |\n|---|---|\n| 1 | 2 |',
      '$$ 没闭合\n文字\n\n$$\n没闭合的块',
      '   $$\n   x\n   $$\n文字 $$y$$ 中间\n\n\n$$z$$',
      '$$\\begin{aligned}\na &= b \\\\\n\\end{aligned}$$\n后面\n$$x\n= 1\n$$  \n\n$$a$$ 和 $$b$$',
      '$$\na = 1 $$\n\n正文\n\n- 列表\n\n$$\nb = 2\n$$\n\n$$\nx\n\n$y$\n$$',
    ];
    for (const doc of docs) expect(rawOf(math(doc)), doc).toBe(doc);
  });
});

describe('选项关着', () => {
  const SAMPLES = [
    '$$ E = mc^2 $$',
    '$$\n\\frac{a}{b}\n$$',
    '\\[ x^2 \\]',
    '```math\nx_1\n```',
    'text\n$$x$$\nafter',
    'inline \\(a_1\\) and $b^2$ and $$c$$',
    '*em $a*b$ em*',
    '$a_1$ and $b_2$',
    '- item\n  $$x$$',
    '| $x$ | \\(y\\) |\n|---|---|\n| 1 | 2 |',
  ];

  it('$、\\( 是普通的字（\\( 是转义的括号），math 围栏是代码块：和 marked 自己分析的一样', () => {
    // 这些文字里没有中日韩文字、HTML 的符号，我们的另外几处改动不起作用，结果应该和 marked 自己的完全一样
    for (const s of SAMPLES) {
      const stock = new Lexer({ gfm: true, breaks: true }).lex(s);
      expect(JSON.stringify(lex(s, { math: false })), s).toBe(JSON.stringify(stock));
      expect(JSON.stringify(lex(s)), s).toBe(JSON.stringify(stock));
    }
    expect(blocks(lex('```math\nx\n```') as Tk[])).toEqual([['code:math', 'x']]);
    expect((lex('\\(x\\)')[0] as Tk).tokens!.map((t) => t.type)).toEqual([
      'escape',
      'text',
      'escape',
    ]);
  });

  it('不含公式的文字（各种块，也有不成公式的 $、\\(）：开着公式分析的结果和关着时一样', () => {
    const CORPUS = [
      '一段普通的话，带 **加粗** 和 `代码`。',
      '**注意：**请先备份，说**「引号」**内容，这是*「斜体」*文字',
      '第一行\n第二行',
      '## 标题 *斜*',
      '标题行\n---',
      '标题行\n===',
      'a\nb\n---',
      'a\nb\n| x | y |\n|---|---|\n| 1 | 2 |',
      '1. 一\n2. 二\n3. 三',
      '1. 一\n\n2. 二\n\n3. 三',
      '- 苹果\n- 香蕉\n  - 嵌套',
      '- [x] 做了\n- [ ] 没做',
      '> 引用的话\n> 第二行',
      '```ts\nconst a = 1;\n\nfunction f() {}\n```',
      '```mathematica\nx\n```',
      '    缩进的代码',
      '| 名字 | 年龄 |\n|:---|---:|\n| 小明 | **12** |',
      '<div>html 块</div>',
      'a < b && c > d, R&D, &amp; &lt; &#38; &#x4F60; &copy; &#0;',
      '价格 $5 和 $10，变量 $HOME，价格是$5,另一个是$10',
      '$ 前后有空格 $ 的不是，$x$5 也不是，\\$转义\\$',
      '\\(没闭合 和 \\[没闭合 和 $$没闭合',
      '[链接](https://example.com) 和 https://example.com/a?b=1 和 example.com',
      '[ref] 用了定义\n\n[ref]: https://example.com/ref',
      '~~删除~~ 和 2*3*4 和 snake_case_name 和 ***都有***',
      '**没写完的加粗 和 一个 `没闭合的代码',
      '```python\n没闭合的代码块',
      'emoji 😀 **完成了😀**然后',
      '\\*转义的星号\\* 和 \\_',
      '文字\n$$\n没闭合的块\n\n下一段',
    ];
    const docs = [...CORPUS, CORPUS.join('\n\n'), CORPUS.join('\n')];
    for (const doc of docs) {
      expect(JSON.stringify(math(doc)), doc).toBe(JSON.stringify(lex(doc)));
    }
  });

  it('同一个进程里先开后关：关着的那次不受前一次影响，marked 的全局设置没被改', () => {
    const before = SAMPLES.map((s) => JSON.stringify(lex(s)));
    for (const s of SAMPLES) math(s);
    expect(SAMPLES.map((s) => JSON.stringify(lex(s)))).toEqual(before);
    // 开、关交替
    for (const s of SAMPLES) {
      expect(JSON.stringify(math(s))).not.toBe(JSON.stringify(lex(s)));
      expect(JSON.stringify(lex(s))).toBe(before[SAMPLES.indexOf(s)]);
    }
    expect(marked.defaults.extensions).toBeNull();
    expect(new Lexer().options.extensions).toBeNull();
  });
});
