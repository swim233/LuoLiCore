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
});
