import { describe, expect, it } from 'vitest';
import { safeRender, safeRenderHtml, splitTelegramText } from '@luoli/telegram';

/**
 * `safeRender` 的构造级断言（docs/08 §5.3）。
 *
 * 这份文件的存在理由是一类缺陷而不是一个 bug：旧实现「全量转义 + 反解白名单」，于是**每个不在
 * 白名单里的 Markdown 构造都静静降级成字面转义符** —— 行内代码从来没被反解过，`heading` 生成的
 * `*粗体*` 又因为在转义之前生成而被自己的转义吃掉。两条同源缺陷都不报错、都只是「看起来朴素」，
 * 所以下面按构造逐条断言「该有的实体标记在、被转义的那份不在」，而不是逐 bug 加回归用例。
 */

/** 每条：构造名、输入、渲染后必须**含**的片段、必须**不含**的片段。 */
const CONSTRUCTS: Array<[name: string, input: string, want: string[], reject: string[]]> = [
  ['行内代码', '还能用 `agent-browser mcp` 当 MCP 服务器', ['`agent-browser mcp`'], ['\\`']],
  ['行内代码含反引号', '`a``b`', ['`a\\`\\`b`'], []],
  ['粗体', '这是 **加粗** 文本', ['*加粗*'], ['\\*']],
  ['斜体', '这是 _斜体_ 文本', ['_斜体_'], ['\\_']],
  ['删除线', '这是 ~~删除~~ 文本', ['~删除~'], ['\\~']],
  ['链接', '见 [文档](https://a.com/b_c)', ['[文档](https://a.com/b_c)'], ['\\[文档\\]']],
  ['图片降级成链接', '![截图](https://a.com/x.png)', ['[截图](https://a.com/x.png)'], []],
  ['无序列表', '- 第一项\n- 第二项', ['• 第一项', '• 第二项'], ['\\-']],
  ['嵌套列表', '- a\n  - b\n- c', ['• a\n  • b\n• c'], []],
  ['有序列表', '3. 三\n4. 四', ['3\\. 三', '4\\. 四'], []],
  ['待办列表', '- [ ] 待办\n- [x] 完成', ['• ☐ 待办', '• ☑ 完成'], []],
  ['引用', '> 引用\n> 第二行', ['>引用\n>第二行'], ['\\>']],
  ['标题降级成粗体', '## 标题\n正文', ['*标题*\n正文'], ['\\*标题\\*']],
  ['分隔线降级', '上\n\n---\n\n下', ['——————'], []],
  ['表格降级成等宽块', '| a | b |\n| --- | --- |\n| 1 | 2 |', ['```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```'], []],
  ['围栏内不转义正文', '```ts\nconst a = 1; // a-b.c\n```', ['```ts\nconst a = 1; // a-b.c\n```'], ['a\\-b']],
];

describe('safeRender 按构造渲染成 MarkdownV2 实体', () => {
  for (const [name, input, want, reject] of CONSTRUCTS) {
    it(name, () => {
      const rendered = safeRender(input);
      for (const fragment of want) expect(rendered, `${name}：缺 ${JSON.stringify(fragment)}\n实际：${JSON.stringify(rendered)}`).toContain(fragment);
      for (const fragment of reject) expect(rendered, `${name}：不该出现字面转义符 ${JSON.stringify(fragment)}\n实际：${JSON.stringify(rendered)}`).not.toContain(fragment);
    });
  }
});

describe('safeRender 的转义边界', () => {
  it('转义只发生在文本节点上：正文里的特殊字符照转、构造标记不动', () => {
    // 同一行里既有要转义的正文（`.` `-` `!`）又有要保留的实体标记，两件事不能互相污染。
    // 全角 `！` 不在转义集里（Telegram 只要求 ASCII 那一批），一并钉住免得下次「顺手补全」。
    expect(safeRender('注意! 版本 1.2-beta 用 `pnpm i` 装')).toBe('注意\\! 版本 1\\.2\\-beta 用 `pnpm i` 装');
    expect(safeRender('注意！全角')).toBe('注意！全角');
  });

  it('反斜杠本身会被转义 —— 否则 Telegram 把它当转义符，路径里的反斜杠静静消失', () => {
    expect(safeRender('C:\\Users\\x')).toBe('C:\\\\Users\\\\x');
  });

  it('作者手写的 \\* 无损转回去，不会变成粗体', () => {
    expect(safeRender('\\*not bold\\*')).toBe('\\*not bold\\*');
  });

  it('同种强调实体不自嵌套 —— `*a *b* c*` 在 Telegram 那边直接解析失败', () => {
    // `### **x**` 是最容易撞上的一例：整段已经因为标题降级成粗体了。
    expect(safeRender('### **小标题**')).toBe('*小标题*');
    expect(safeRender('### a **b** c')).toBe('*a b c*');
    expect(safeRender('**a **b** c**')).toBe('*a b c*');
  });

  it('可点链接按 scheme 白名单，其余退回字面 raw', () => {
    // 回复正文里可能带被注入的内容（工具输出、网页），可点链接必须是白名单而不是黑名单。
    expect(safeRender('见 [点我](javascript:alert(1))')).toBe('见 \\[点我\\]\\(javascript:alert\\(1\\)\\)');
    expect(safeRender('见 [邮件](mailto:a@b.com)')).toContain('[邮件](mailto:a@b.com)');
  });

  it('URL 里的 `)` 被转义，不会提前收掉链接', () => {
    // `(` 不转义是照 Telegram 的规矩：`(…)` 内部只有 `)` 和 `\` 需要转义。
    expect(safeRender('[wiki](https://a.com/x_(y))')).toBe('[wiki](https://a.com/x_(y\\))');
  });

  it('段落之间的空行数量与模型写的一致', () => {
    for (const text of ['段一\n\n段二', '段一\n\n\n段二', '段一\n段二']) expect(safeRender(text)).toBe(text);
  });

  it('正文里的 NUL 进门就摘掉（docs/27 · C-07）', () => {
    const rendered = safeRender('前\u00000\u0000后\n```\ncode\n```');
    expect(rendered).not.toContain('\u0000');
    expect(rendered).toBe('前0后\n```\ncode\n```');
  });
});

describe('safeRender 在流式中途的半截输入上不产生解析错误', () => {
  it('未闭合围栏渲染时补上闭合（AC-OUT-003）', () => {
    const rendered = safeRender('前面\n```ts\nconst a = 1;');
    expect(rendered).toBe('前面\n```ts\nconst a = 1;\n```');
    expect((rendered.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('未闭合的行内标记按字面显示，不猜配对', () => {
    // 每个编辑帧都是「累积到此刻的全文」，切在标记中间是常态而不是异常。
    for (const text of ['用 `agent-brow', '这是 **加粗', '见 [文档](https://a.co', '~~删除', '> 引用还没写完']) {
      const rendered = safeRender(text);
      expect(() => rendered).not.toThrow();
      expect((rendered.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it('逐字符累积地渲染一整段富文本，每一帧的围栏都是配平的', () => {
    const full = '## 标题\n\n用 `x` 启动，见 [文档](https://a.com/b_c)。\n\n- 一\n- 二\n\n```ts\nconst a = 1;\n```\n\n> 收尾';
    for (let length = 1; length <= full.length; length += 1) {
      const rendered = safeRender(full.slice(0, length));
      expect((rendered.match(/```/g) ?? []).length % 2, `切到第 ${length} 个字符时围栏不配平：${JSON.stringify(rendered)}`).toBe(0);
    }
  });

  it('lexer 抛了也要给出可发的正文（退回全文字面转义）', () => {
    // 病态输入不该变成投递失败：格式可以丢，消息不能丢。
    for (const text of ['*'.repeat(400), '['.repeat(400), '`'.repeat(400), '>'.repeat(400), '|'.repeat(400), '- '.repeat(400)]) {
      expect(() => safeRender(text)).not.toThrow();
      expect(typeof safeRender(text)).toBe('string');
    }
  });
});

describe('渲染与分片的接缝', () => {
  it('中英混排 + 嵌套列表 + 长代码块切分后正文不丢', () => {
    const text = `## 报告 Report\n\n- 第一项 with English\n  - 嵌套 nested\n\n\`\`\`\n${'x'.repeat(4000)}\n\`\`\`\n`;
    const parts = splitTelegramText(text, 1000);
    expect(parts.every((part) => [...part].length <= 1000)).toBe(true);
    expect(parts.every((part) => ((part.match(/```/g) ?? []).length % 2) === 0)).toBe(true);
    expect(parts.join('')).toContain('*报告 Report*');
    expect(parts.join('')).toContain('• 第一项 with English');
  });
});

/**
 * `safeRenderHtml` 的构造级断言（docs/08 §5.3.2）。
 *
 * 存在理由与上面那份 MarkdownV2 的一样，但成因不同：HTML 这一档**压根没有实现过** ——
 * `splitTelegramText` 无条件跑 MarkdownV2 渲染器，于是 `parseMode: HTML` 发出去的是
 * MarkdownV2 文本挂 `parse_mode=HTML`：`\>` 之类原样显示，而 `<` 与 `&` 一个都没转成实体，
 * Telegram 直接 `can't parse entities`。逐构造断言「该有的标签在、危险字符已成实体」。
 */
const HTML_CONSTRUCTS: Array<[name: string, input: string, want: string[], reject: string[]]> = [
  ['行内代码', '用 `a<b` 比较', ['<code>a&lt;b</code>'], ['`']],
  ['粗体', '这是 **加粗** 文本', ['<b>加粗</b>'], ['*']],
  ['斜体', '这是 _斜体_ 文本', ['<i>斜体</i>'], ['_斜体_']],
  ['删除线', '这是 ~~删除~~ 文本', ['<s>删除</s>'], ['~']],
  ['链接', '见 [文档](https://a.com/b?x=1&y=2)', ['<a href="https://a.com/b?x=1&amp;y=2">文档</a>'], ['&y=2"']],
  ['图片降级成链接', '![截图](https://a.com/x.png)', ['<a href="https://a.com/x.png">截图</a>'], []],
  ['无序列表', '- 第一项\n- 第二项', ['• 第一项', '• 第二项'], []],
  ['嵌套列表', '- a\n  - b\n- c', ['• a\n  • b\n• c'], []],
  // 有序项的 `.` 在 HTML 里不用转义 —— MarkdownV2 那边是 `3\.`。
  ['有序列表', '3. 三\n4. 四', ['3. 三', '4. 四'], ['3\\. 三']],
  ['待办列表', '- [ ] 待办\n- [x] 完成', ['• ☐ 待办', '• ☑ 完成'], []],
  // MarkdownV2 用逐行 `>` 前缀，HTML 有真的 blockquote 标签，所以不需要那条「内含围栏就退前缀」的妥协。
  ['引用用真标签', '> 引用\n> 第二行', ['<blockquote>引用\n第二行</blockquote>'], ['\n>第二行']],
  ['引用里可以有围栏', '> 看这个\n>\n> ```\n> a<b\n> ```', ['<blockquote>', '<pre>', 'a&lt;b'], []],
  ['标题降级成粗体', '## 标题\n正文', ['<b>标题</b>'], ['<b><b>']],
  ['标题里的粗体不重复嵌套', '### **小标题**', ['<b>小标题</b>'], ['<b><b>']],
  ['分隔线降级', '上\n\n---\n\n下', ['——————'], []],
  ['带语言的围栏', '```ts\nconst a = 1 < 2;\n```', ['<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>'], []],
  ['不带语言的围栏', '```\nplain & text\n```', ['<pre>plain &amp; text</pre>'], ['<code']],
  ['围栏语言名过滤非法字符', '```js"><script>\nx\n```', ['class="language-js"'], ['<script>']],
  // 语言名过长时当没写语言。这不只是整洁：`<pre><code class="language-…">` 是一个不可切开的构造，
  // 它加上自己的 `</code>` 一旦长过 maxMessageChars，这个元素就没有任何切法能既装进一片又保持
  // 成对（6000 轮随机用例里实测：120 个字符的「语言名」配 max=150，标签被切成两半）。
  ['语言名过长当没写', `\`\`\`${'x'.repeat(120)}\ncode\n\`\`\``, ['<pre>code</pre>'], ['class=']],
  ['语言名不长就照写', '```objective-c\nx\n```', ['class="language-objective-c"'], []],
  ['表格降级成等宽块', '| a | b |\n| --- | --- |\n| 1 | 2 |', ['<pre>', '| a | b |'], []],
  ['文本里的三个危险字符', 'a < b & c > d', ['a &lt; b &amp; c &gt; d'], []],
  // `&` 必须第一个替换，否则 `<` 产出的 `&lt;` 会被再转一遍成 `&amp;lt;`（用户看到字面的 &lt;）。
  ['转义顺序不能把实体自己再转一遍', '<b>不是标签</b>', ['&lt;b&gt;'], ['&amp;lt;']],
  ['非白名单 scheme 退回字面', '点 [这里](javascript:alert(1))', ['[这里](javascript:alert(1))'], ['<a href']],
  ['裸 HTML 按字面显示', '<script>alert(1)</script>', ['&lt;script&gt;'], ['<script>']],
];

describe('safeRenderHtml 逐构造', () => {
  for (const [name, input, want, reject] of HTML_CONSTRUCTS) {
    it(name, () => {
      const rendered = safeRenderHtml(input);
      for (const fragment of want) expect(rendered, `应含 ${fragment}`).toContain(fragment);
      for (const fragment of reject) expect(rendered, `不应含 ${fragment}`).not.toContain(fragment);
    });
  }

  it('标签一律成对，且只用白名单里那几个', () => {
    const rendered = safeRenderHtml('# 标\n\n**粗** _斜_ ~~删~~ `码`\n\n> 引 [链](https://a.com)\n\n```py\nx<y\n```\n\n- 项');
    const opened: string[] = [];
    for (const match of rendered.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/g)) {
      const name = match[2]!;
      expect(['b', 'i', 'u', 's', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote'], `白名单外的标签 ${name}`).toContain(name);
      if (match[1]) expect(opened.pop()).toBe(name); else opened.push(name);
    }
    expect(opened).toEqual([]);
  });
});
