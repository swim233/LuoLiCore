import { describe, expect, it } from 'vitest';
import { splitTelegramText } from '@luoli/telegram';

describe('Telegram rendered splitting', () => {
  it('keeps every MarkdownV2 chunk below the configured rendered limit', () => {
    const text = '_'.repeat(3000);
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
