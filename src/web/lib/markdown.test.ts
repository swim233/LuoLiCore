import { Lexer } from 'marked';
import type { Token } from 'marked';
import { describe, expect, it } from 'vitest';
import { IncrementalLexer, lexMarkdown, plainPreview } from './markdown';

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
});

describe('lexMarkdown', () => {
  it('一个回车就换行（不把相邻的两行并成一段）', () => {
    const [p] = lexMarkdown('第一行\n第二行');
    expect(p.type).toBe('paragraph');
    const kinds = (p as { tokens: { type: string }[] }).tokens.map((t) => t.type);
    expect(kinds).toEqual(['text', 'br', 'text']);
  });

  it('网址自动成链接，没写协议的域名不是（那个由 Hl 认）', () => {
    const [p] = lexMarkdown('https://example.com/a 和 example.com');
    const kinds = (p as { tokens: { type: string }[] }).tokens.map((t) => t.type);
    expect(kinds).toEqual(['link', 'text']);
  });

  it('同一段文字重复分析得到同一份结果（缓存）', () => {
    expect(lexMarkdown('**x**')).toBe(lexMarkdown('**x**'));
  });
});

/* 把行内词元写成 <b>粗</b> <i>斜</i> <s>删</s> 的样子，其余原样（raw），方便比对 */
function shape(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const inner = (t as { tokens?: Token[] }).tokens ?? [];
      if (t.type === 'strong') return `<b>${shape(inner)}</b>`;
      if (t.type === 'em') return `<i>${shape(inner)}</i>`;
      if (t.type === 'del') return `<s>${shape(inner)}</s>`;
      return t.raw;
    })
    .join('');
}
const inline = (src: string) => shape((lexMarkdown(src)[0] as { tokens: Token[] }).tokens);

/* 中文里的加粗、斜体：CommonMark 的左右侧规则在标点和中日韩文字相邻时不认（**注意：**请…），这里放宽 */
describe('中日韩文字旁的加粗、斜体', () => {
  it('加粗最后是标点、后面紧贴文字', () => {
    expect(inline('**注意：**请先备份')).toBe('<b>注意：</b>请先备份');
    expect(inline('**「引号」**内容')).toBe('<b>「引号」</b>内容');
    expect(inline('**完成了（真的）**然后')).toBe('<b>完成了（真的）</b>然后');
    expect(inline('**好了！**下一步')).toBe('<b>好了！</b>下一步');
  });

  it('斜体最后是标点、后面紧贴文字', () => {
    expect(inline('*斜体：*文字')).toBe('<i>斜体：</i>文字');
    expect(inline('*「斜体」*文字')).toBe('<i>「斜体」</i>文字');
  });

  it('前文紧贴开头、开头是标点', () => {
    expect(inline('前文**加粗**后文')).toBe('前文<b>加粗</b>后文');
    expect(inline('说**「引号」**内容')).toBe('说<b>「引号」</b>内容');
    expect(inline('这是*「斜体」*文字')).toBe('这是<i>「斜体」</i>文字');
    expect(inline('前文*斜体*后文')).toBe('前文<i>斜体</i>后文');
  });

  it('全角标点后面不论接什么都认（数字、英文）', () => {
    expect(inline('**年龄：**12岁')).toBe('<b>年龄：</b>12岁');
    expect(inline('**Note：**text')).toBe('<b>Note：</b>text');
    expect(inline('使用 Docker**（推荐）**默认')).toBe('使用 Docker<b>（推荐）</b>默认');
    expect(inline('**注意：**ABC')).toBe('<b>注意：</b>ABC');
  });

  it('结尾是表情符号（也算符号）', () => {
    expect(inline('**完成了😀**然后')).toBe('<b>完成了😀</b>然后');
  });

  it('日文、韩文也一样', () => {
    expect(inline('**注意：**これは重要です')).toBe('<b>注意：</b>これは重要です');
    expect(inline('**참고：**내용')).toBe('<b>참고：</b>내용');
  });

  it('一句里有几处、粗斜体叠在一起', () => {
    expect(inline('**注意：**请先**备份：**数据')).toBe('<b>注意：</b>请先<b>备份：</b>数据');
    expect(inline('***注意：***请先备份')).toBe('<i><b>注意：</b></i>请先备份');
    expect(inline('**外层*内层：*文字**后面')).toBe('<b>外层<i>内层：</i>文字</b>后面');
  });

  it('列表、表格、引用里也认', () => {
    const [list] = lexMarkdown('- **名字：**小明\n- **年龄：**12') as unknown as {
      items: { tokens: { tokens: Token[] }[] }[];
    }[];
    expect(list.items.map((it) => shape(it.tokens[0].tokens))).toEqual([
      '<b>名字：</b>小明',
      '<b>年龄：</b>12',
    ]);
  });

  it('本来就对的写法不受影响', () => {
    expect(inline('**加粗**：后文')).toBe('<b>加粗</b>：后文');
    expect(inline('（**加粗**）')).toBe('（<b>加粗</b>）');
    expect(inline('**标题：** 内容')).toBe('<b>标题：</b> 内容');
    expect(inline('**加粗**，**再来**。')).toBe('<b>加粗</b>，<b>再来</b>。');
    expect(inline('「**强调**」')).toBe('「<b>强调</b>」');
  });

  it('没配对的照原样', () => {
    expect(inline('这是**没写完的加粗')).toBe('这是**没写完的加粗');
    expect(inline('**注意：请先备份')).toBe('**注意：请先备份');
    expect(inline('说**「引号」没有闭合')).toBe('说**「引号」没有闭合');
  });

  it('下划线不放宽：中文里的 _ 照旧不当格式（词中的下划线）', () => {
    expect(inline('变量_名字：_后面')).toBe('变量_名字：_后面');
    expect(inline('中文_斜体_中文')).toBe('中文_斜体_中文');
  });

  it('英文：只有紧贴中日韩文字时才放宽', () => {
    expect(inline('**Note:**text')).toBe('**Note:**text');
    expect(inline('2*3*4')).toBe('2<i>3</i>4');
    expect(inline('snake_case_name')).toBe('snake_case_name');
    expect(inline('a ** b ** c')).toBe('a ** b ** c');
    expect(inline('**unclosed bold')).toBe('**unclosed bold');
    expect(inline('**bold** and *em* and ~~del~~')).toBe(
      '<b>bold</b> and <i>em</i> and <s>del</s>',
    );
  });

  it('没有中日韩文字的文字，结果和 marked 自己的完全一样', () => {
    const samples = [
      '2*3*4',
      'a*b*c',
      'snake_case_name and __init__ and _em_',
      '**Note:**text and **Note:** text',
      '**bold**, *em*, ***both***, ****x****',
      '*a **b** c* and **a *b* c**',
      '5 * 3 = 15, 2 ** 3',
      '"**quoted**" and (**paren**) and **(paren)**',
      '**`code`** and *[link](https://example.com)* and **~~del~~**',
      '- **item:**value\n- *x*y',
      '| **a** | *b:*c |\n|---|---|\n| 1 | 2 |',
      '**a** *b* **c',
      'emoji **fine😀**text',
      'a**b**c and a_b_c',
    ];
    for (const s of samples) {
      const stock = new Lexer({ gfm: true, breaks: true }).lex(s);
      expect(JSON.stringify(lexMarkdown(s)), s).toBe(JSON.stringify(stock));
    }
  });
});

/* 符号和 HTML 实体：Markdown 的文字片段里显示成人看到的样子（面板不输出 HTML，不会二次转义） */
describe('符号与 HTML 实体', () => {
  const text = (src: string) => plainPreview(src);
  const lines = (src: string) => {
    const [first] = lexMarkdown(src) as unknown as { text: string; tokens?: { text: string }[] }[];
    return first.tokens ? first.tokens.map((t) => t.text).join('') : first.text;
  };

  it('普通的 & < > 在正文、行内代码、代码块里都和输入一样', () => {
    expect(lines('a < b && c > d, R&D, AT&T')).toBe('a < b && c > d, R&D, AT&T');
    expect(lines('`x < y && z > w`')).toBe('x < y && z > w');
    expect(lines('```\nif (a < b && c > d) {}\n```')).toBe('if (a < b && c > d) {}');
  });

  it('常见的实体解成符号：&amp; &lt; &gt; &quot; &apos; &nbsp; 和数字写法', () => {
    expect(text('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
    expect(text('a&nbsp;b')).toBe('a b'); // 不换行空格是空白，预览压成一个空格
    expect(lines('&#38; &#x26; &#60; &#x4F60;')).toBe('& & < 你');
  });

  it('同一段文字里有数字写法的实体时，单独的 & 不被改成 &amp;', () => {
    expect(lines('a && b &#38; c &#60; d')).toBe('a && b & c < d');
    expect(text('R&D &#38; AT&T')).toBe('R&D & AT&T');
  });

  it('不认识的实体、不完整的写法原样；代码里的实体不解', () => {
    expect(lines('&copy; &unknown; &amp &#; &#x;')).toBe('&copy; &unknown; &amp &#; &#x;');
    expect(lines('`&amp;`')).toBe('&amp;');
    expect(lines('```\n&lt;div&gt;\n```')).toBe('&lt;div&gt;');
  });

  it('不合法的数字（0、超范围、半个代理对）换成 U+FFFD', () => {
    expect(lines('&#0; &#1114112; &#xD800;')).toBe('\ufffd \ufffd \ufffd');
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
