import { describe, expect, it } from 'vitest';
import { safeRender, safeRenderHtml, sendWithFallback, splitTelegramText, toPlainText } from '@luoli/telegram';

describe('Telegram rendered splitting', () => {
  it('keeps every MarkdownV2 chunk below the configured rendered limit', () => {
    // 前提是「渲染会让正文变长」：3000 个 `.` 全要转义，渲染后 6000 码点。这条前提单独断言 ——
    // 原来用的 `_`×3000 现在渲染成 `——————`（连成一行的下划线在 Markdown 里就是 hr，
    // docs/08 §5.3 第 3 条），前提一失效，下面那句 `>1` 就悄悄变成了空断言。
    const text = '.'.repeat(3000);
    expect([...safeRender(text)].length).toBeGreaterThan(3900);
    const parts = splitTelegramText(text, 3900);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => [...part].length <= 3900)).toBe(true);
    const code = `\`\`\`\n${'x'.repeat(5000)}\n\`\`\``;
    const codeParts = splitTelegramText(code, 1000);
    expect(codeParts.every((part) => ((part.match(/```/g) ?? []).length % 2) === 0)).toBe(true);
  });

  // 断言的是「切完还是那段话」，与断点落在哪、正文里有没有代理对无关。按 UTF-16 下标切码点数组时
  // 这条会红：实测 5001 码点丢 1105 个，而长度上限、分段数、fence 配平全部照常通过（docs/24 · R-TG-01）。
  it('loses nothing when the split boundary sits behind astral characters', () => {
    for (const text of ['😀'.repeat(3000) + '\n' + 'X'.repeat(2000), '🌍🌏'.repeat(2600), `${'字'.repeat(1200)}。${'🙂'.repeat(2800)}`]) {
      const parts = splitTelegramText(text, 3900);
      expect(parts.every((part) => [...part].length <= 3900)).toBe(true);
      const restored = parts.join('').replaceAll('```\n', '').replaceAll('\n```', '');
      // 只允许丢断点处被 trim 掉的空白，正文一个码点都不能少。
      expect([...restored.replaceAll(/\s/gu, '')].join('')).toBe([...text.replaceAll(/\s/gu, '')].join(''));
    }
  });
});

/**
 * `sendWithFallback` 是所有投递路径共用的那一跳（docs/08 §5.2 的第一级兜底）。两条不变量：
 * 纯文本重发**自己也要有兜底**（此前是裸调，第二次失败照样打穿整轮，正是这个函数说要防的事），
 * 以及降级必须留痕 —— 这一跳原先一个字都不落，于是行内代码那个 bug 只能靠翻下一次模型调用的
 * context blob 反推（docs/00 §2.3）。
 */
describe('sendWithFallback 的解析失败降级', () => {
  const parseError = (): Error => new Error("Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12");
  /** grammY 的 Api 在这条路上只被用到 `sendMessage`，按最小面搭。 */
  const fakeApi = (impl: (extra: Record<string, unknown>) => unknown) =>
    ({ sendMessage: (_chatId: string, _text: string, extra: Record<string, unknown> = {}) => Promise.resolve(impl(extra)) }) as unknown as Parameters<typeof sendWithFallback>[0];

  it('MarkdownV2 被拒时降级成纯文本，并回调一次 onFallback', async () => {
    const attempts: Array<string | undefined> = [];
    const api = fakeApi((extra) => {
      attempts.push(extra.parse_mode as string | undefined);
      if (extra.parse_mode) throw parseError();
      return { message_id: 7 };
    });
    const seen: Array<{ chars: number; phase: string }> = [];
    const sent = await sendWithFallback(api, 'chat', 'a*b', {}, 'MarkdownV2', (info) => seen.push(info));
    expect(sent.message_id).toBe(7);
    expect(attempts).toEqual(['MarkdownV2', undefined]);
    expect(seen).toEqual([{ chars: 3, error: expect.stringContaining('parse entities') as unknown as string, phase: 'send' }]);
  });

  it('纯文本重发也失败时抛回**第一个**错误，而不是派生的那个', async () => {
    // 排障要看的是「为什么 MarkdownV2 崩了」；第二次失败（超长、429、chat migrated）通常只是结果。
    const api = fakeApi((extra) => { throw extra.parse_mode ? parseError() : new Error('429: Too Many Requests: retry after 30'); });
    const seen: unknown[] = [];
    await expect(sendWithFallback(api, 'chat', 'a*b', {}, 'MarkdownV2', (info) => seen.push(info)))
      .rejects.toThrow(/parse entities/);
    // 没有真的降级成功，就不该记那条 warn。
    expect(seen).toEqual([]);
  });

  it('不是解析错误的一律原样抛出，不白发第二遍', async () => {
    let calls = 0;
    const api = fakeApi(() => { calls += 1; throw new Error('403: Forbidden: bot was blocked by the user'); });
    await expect(sendWithFallback(api, 'chat', 'hi', {}, 'MarkdownV2')).rejects.toThrow(/blocked by the user/);
    expect(calls).toBe(1);
  });

  it('parseMode=none 时压根不试 Markdown，也就没有回退那一跳', async () => {
    const attempts: Array<string | undefined> = [];
    const api = fakeApi((extra) => { attempts.push(extra.parse_mode as string | undefined); return { message_id: 1 }; });
    await sendWithFallback(api, 'chat', 'a*b', {}, 'none', () => { throw new Error('不该回调'); });
    expect(attempts).toEqual([undefined]);
  });
});

/**
 * 三档分片（docs/08 §5.3.4）。渲染在分片之前，所以每一档都得认自己那套不可切开的构造 ——
 * 这一节焊的就是「渲染出的文本与投递时挂的 parse_mode 是同一种语言」。
 */
describe('splitTelegramText 按 parseMode 分档', () => {
  const source = 'C:\\temp - 见 **issue #3** (1.5x) 与 a<b & c';

  it('none 原样交出去：不渲染、不转义', () => {
    // 这一档此前拿到的是 MarkdownV2 转义结果，用户看到的是 `C:\\temp \- 见 …` 满屏反斜杠。
    expect(splitTelegramText(source, 3900, 'none')).toEqual([source]);
  });

  it('none 仍然摘掉 NUL —— 正文里的 NUL 没有任何显示意义', () => {
    expect(splitTelegramText('a\u0000b', 3900, 'none')).toEqual(['ab']);
  });

  it('MarkdownV2 与 HTML 各自出自己那套标记，互不串味', () => {
    const [markdown] = splitTelegramText(source, 3900, 'MarkdownV2');
    const [html] = splitTelegramText(source, 3900, 'HTML');
    expect(markdown).toContain('*issue \\#3*');
    expect(markdown).not.toContain('<b>');
    expect(html).toContain('<b>issue #3</b>');
    // HTML 那一档最要紧的两条：危险字符成实体、没有 MarkdownV2 的反斜杠。
    expect(html).toContain('a&lt;b &amp; c');
    expect(html).not.toContain('\\-');
  });

  it('默认档没变，仍是 MarkdownV2', () => {
    expect(splitTelegramText(source, 3900)).toEqual(splitTelegramText(source, 3900, 'MarkdownV2'));
  });

  it('HTML 跨片时闭合并重开标签栈，且每片标签成对', () => {
    // 一个长到必须切开的粗体段：切口落在 `<b>` 里面，本片要补 `</b>`、下一片要重开 `<b>`。
    // 闭合的 `**` 前面不能有空格 —— CommonMark 的 right-flanking 判据，带空格时整段只是字面文本，
    // 那样这条用例就一个标签都断言不到了。
    const parts = splitTelegramText(`**${'词 '.repeat(400).trim()}**`, 300, 'HTML');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect([...part].length).toBeLessThanOrEqual(300);
      const opened: string[] = [];
      for (const match of part.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/g)) {
        // 闭合必须匹配栈顶：只数「开了几个闭了几个」的话，一个野闭合标签会把栈弹成空而蒙混过关。
        if (!match[1]) opened.push(match[2]!);
        else { expect(opened.at(-1), `野闭合标签 </${match[2]}>：${part.slice(0, 60)}`).toBe(match[2]); opened.pop(); }
      }
      expect(opened, `这一片有没闭合的标签：${part.slice(-40)}`).toEqual([]);
    }
    expect(parts.slice(1).every((part) => part.startsWith('<b>'))).toBe(true);
  });

  it('HTML 的切口绝不落在标签或实体中间', () => {
    // `<a href="…">` 与 `<pre><code class="…">` 里都有空格，而断点候选里就有 `' '` ——
    // 不挡的话会切出一个 `<a` 加一个 `href="…">`。实体同理（`&amp;` 里没有空格但有换行邻居）。
    const link = '[看这个链接](https://example.com/very/long/path?query=1&other=2) 还有 a<b & c ';
    const parts = splitTelegramText(link.repeat(30), 200, 'HTML');
    for (const part of parts) {
      // 每个 `<` 都必须在同一片里等到自己的 `>`；每个 `&` 都必须等到自己的 `;`。
      expect(part.split('<').length, `切开了标签：${part}`).toBe(part.split('>').length);
      for (const fragment of part.split('&').slice(1)) expect(fragment, `切开了实体：${part}`).toMatch(/^(amp|lt|gt|quot);/);
    }
    // 正文一个字都不能少。
    expect(parts.join('')).toContain('example.com/very/long/path?query=1&amp;other=2');
  });

  // 下面三条都是 8000 轮随机用例逼出来的，逐个都改过实现。
  it('小 maxMessageChars 下不许把标签切成两半（预留量曾经把窗口压得放不下一个 <a>）', () => {
    // 曾按最坏情况给收尾预留 59 字符，于是 max=100 时窗口只剩 41，一个 `<a href="…">` 都放不下，
    // `retreat` 退到 0 之后硬切 —— 预留量本身成了「把标签切开」的原因。
    for (const max of [100, 110, 120, 150]) {
      const parts = splitTelegramText(`见 [标签](https://example.com/p?a=1&b=2) 与 ${'词 '.repeat(60)}末尾`, max, 'HTML');
      for (const part of parts) {
        expect([...part].length, `max=${max}`).toBeLessThanOrEqual(max);
        expect((part.match(/</g) ?? []).length, `标签被切开 max=${max}: ${part}`).toBe((part.match(/>/g) ?? []).length);
      }
    }
  });

  it('不许出现没有配对的闭合标签', () => {
    // 曾经在「前缀装不下」时放弃重开 `<b>`，那一片是纯文本没错，但流里后面**仍然会来那个 `</b>`**
    // —— 它于是变成下一片开头一个野闭合标签。只数「开了几个闭了几个」的弱判据看不见这个。
    for (const max of [100, 101, 110, 150, 300]) {
      for (const part of splitTelegramText(`**${'词 '.repeat(300).trim()}** 与 > 引用\n`, max, 'HTML')) {
        const stack: string[] = [];
        for (const match of part.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/g)) {
          if (!match[1]) { stack.push(match[2]!); continue; }
          expect(stack.at(-1), `野闭合 </${match[2]}> max=${max}: ${part.slice(0, 60)}`).toBe(match[2]);
          stack.pop();
        }
        expect(stack, `未闭合 max=${max}`).toEqual([]);
      }
    }
  });

  it('前缀几乎占满一整片时宁可丢格式也不超上限', () => {
    // 96 字符的 `<a href="…">` 配 max=100 曾让每片都是「前缀 + 1 个字 + 闭合」= 101 字符。
    // 超上限会被 Telegram 以 message is too long 硬拒，而 `sendWithFallback` 只兜得住解析失败。
    const parts = splitTelegramText(`[${'标'.repeat(80)}](https://example.com/${'q'.repeat(64)})`, 100, 'HTML');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => [...part].length <= 100)).toBe(true);
  });

  it('单个标签就长过一整片时硬切而不是死循环', () => {
    // 病态输入：URL 有几千字符，整个 `<a href="…">` 退无可退。切坏的标签会让 Telegram 报解析
    // 失败、`sendWithFallback` 降级成纯文本 —— 消息还在。挂住才是真的不可接受。
    const parts = splitTelegramText(`[x](https://a.com/${'q'.repeat(3000)})`, 300, 'HTML');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => [...part].length <= 300)).toBe(true);
  });

  it('MarkdownV2 的围栏跨片行为一字未改', () => {
    const parts = splitTelegramText(`\`\`\`\n${'x'.repeat(2000)}\n\`\`\``, 500, 'MarkdownV2');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => (part.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
    expect(parts.slice(1).every((part) => part.startsWith('```\n'))).toBe(true);
  });
});

describe('toPlainText：降级要真的只丢格式', () => {
  it('MarkdownV2 的转义反斜杠去掉', () => {
    // 此前降级是把渲染结果原样按纯文本发出去，用户看到的是 `C:\\temp \- …`。
    expect(toPlainText('C:\\\\temp \\- 见 \\#3', 'MarkdownV2')).toBe('C:\\temp - 见 #3');
  });

  it('HTML 的标签剥掉、实体解码，链接的 URL 留着', () => {
    const rendered = safeRenderHtml('见 **粗** 与 [文档](https://a.com/x?y=1&z=2)，还有 a<b');
    const plain = toPlainText(rendered, 'HTML');
    expect(plain).toBe('见 粗 与 文档 (https://a.com/x?y=1&z=2)，还有 a<b');
    expect(plain).not.toContain('<b>');
    expect(plain).not.toContain('&amp;');
  });

  it('解码顺序不能把 &amp;lt; 解成 <', () => {
    // 用户原文里就写着 `&lt;`：转义成 `&amp;lt;`，解回来必须还是 `&lt;`。
    expect(toPlainText(safeRenderHtml('字面的 &lt; 符号'), 'HTML')).toContain('&lt;');
  });

  it('none 档原样返回', () => {
    expect(toPlainText('a\\-b <c>', 'none')).toBe('a\\-b <c>');
  });
});
