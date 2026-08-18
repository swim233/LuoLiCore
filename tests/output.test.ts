import { describe, expect, it } from 'vitest';
import { safeRender, splitTelegramText } from '@luoli/telegram';

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
