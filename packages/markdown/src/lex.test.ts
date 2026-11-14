import { Lexer } from 'marked';
import type { Token } from 'marked';
import { describe, expect, it } from 'vitest';
import { lex as lexWith } from './index.js';

/* 分析的规则（从面板的 src/web/lib/markdown.test.ts 搬来，断言原样）。不认公式、认公式各跑一遍：
   这些例子里没有公式，认公式时这些规则也得照样起作用（Telegram 前端是认公式用的） */
describe.each([
  { math: false, title: '不认公式（默认）' },
  { math: true, title: '认公式' },
])('$title', ({ math }) => {
  const lex = (src: string) => lexWith(src, { math });

  describe('lex', () => {
    it('一个回车就换行（不把相邻的两行并成一段）', () => {
      const [p] = lex('第一行\n第二行');
      expect(p.type).toBe('paragraph');
      const kinds = (p as { tokens: { type: string }[] }).tokens.map((t) => t.type);
      expect(kinds).toEqual(['text', 'br', 'text']);
    });

    it('网址自动成链接，没写协议的域名不是（那个由用的地方自己认）', () => {
      const [p] = lex('https://example.com/a 和 example.com');
      const kinds = (p as { tokens: { type: string }[] }).tokens.map((t) => t.type);
      expect(kinds).toEqual(['link', 'text']);
    });

    it('每次新建分析器：同一段文字两次分析是两份结果，内容一样', () => {
      const a = lex('**x**');
      const b = lex('**x**');
      expect(a).not.toBe(b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  /* 不认 setext 标题、段落后面直接跟 ---（和面板的 stream-md.test.ts 里那条一样，那边照旧留着） */
  describe('setext 标题与分隔线', () => {
    type Tk = Token & { tokens?: Tk[]; depth?: number; ordered?: boolean };
    const blocks = (tokens: Tk[]): string[] =>
      tokens
        .filter((t) => t.type !== 'space')
        .map((t) =>
          t.type === 'heading'
            ? `h${t.depth}`
            : t.type === 'list'
              ? t.ordered
                ? 'ol'
                : 'ul'
              : t.type,
        );

    it('setext 关掉：标题行下面的 --- 是段落加分隔线，=== 是普通文字', () => {
      expect(blocks(lex('标题\n---') as Tk[])).toEqual(['paragraph', 'hr']);
      expect(blocks(lex('标题\n===') as Tk[])).toEqual(['paragraph']);
      expect(blocks(lex('标题\n-') as Tk[])).toEqual(['paragraph']);
      expect(blocks(lex('# 标题\n正文') as Tk[])).toEqual(['h1', 'paragraph']);
      // 多行段落后面直接跟 ---：一个段落（两行）加一条分隔线，第二行不自成一段
      const t = lex('a\nb\n---') as Tk[];
      expect(blocks(t)).toEqual(['paragraph', 'hr']);
      expect(t[0].tokens?.map((x) => x.type)).toEqual(['text', 'br', 'text']);
      // 真的表格（分隔行有 | 或 :）照旧打断段落
      expect(blocks(lex('a\nb\n| x | y |\n|---|---|\n| 1 | 2 |') as Tk[])).toEqual([
        'paragraph',
        'table',
      ]);
      // 一个回车就换行的段落：=== 是段落里的一行
      const p = lex('标题\n===')[0] as Tk;
      expect(p.tokens?.map((x) => x.type)).toEqual(['text', 'br', 'text']);
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
  const inline = (src: string) => shape((lex(src)[0] as { tokens: Token[] }).tokens);

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
      const [list] = lex('- **名字：**小明\n- **年龄：**12') as unknown as {
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
        expect(JSON.stringify(lex(s)), s).toBe(JSON.stringify(stock));
      }
    });
  });

  /* 符号和 HTML 实体：文字片段里是人看到的样子（用的地方不输出 HTML，不会二次转义） */
  describe('符号与 HTML 实体', () => {
    const lines = (src: string) => {
      const [first] = lex(src) as unknown as { text: string; tokens?: { text: string }[] }[];
      return first.tokens ? first.tokens.map((t) => t.text).join('') : first.text;
    };

    it('普通的 & < > 在正文、行内代码、代码块里都和输入一样', () => {
      expect(lines('a < b && c > d, R&D, AT&T')).toBe('a < b && c > d, R&D, AT&T');
      expect(lines('`x < y && z > w`')).toBe('x < y && z > w');
      expect(lines('```\nif (a < b && c > d) {}\n```')).toBe('if (a < b && c > d) {}');
    });

    it('常见的实体解成符号：&amp; &lt; &gt; &quot; &apos; &nbsp; 和数字写法', () => {
      // 面板那边用一行预览检验同样的两句（预览把不换行空格压成普通空格）
      expect(lines('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
      expect(lines('a&nbsp;b')).toBe('a\u00a0b');
      expect(lines('&#38; &#x26; &#60; &#x4F60;')).toBe('& & < 你');
    });

    it('同一段文字里有数字写法的实体时，单独的 & 不被改成 &amp;', () => {
      expect(lines('a && b &#38; c &#60; d')).toBe('a && b & c < d');
      expect(lines('R&D &#38; AT&T')).toBe('R&D & AT&T');
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
});
