import type { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { TelegramOutput } from '@luoli/telegram';

interface Call { kind: 'send' | 'edit'; at: number; text: string }

function fakeBot(calls: Call[]): { bot: Bot } {
  let nextId = 100;
  const api = {
    sendMessage: (_chat: string, text: string) => { calls.push({ kind: 'send', at: Date.now(), text }); nextId += 1; return Promise.resolve({ message_id: nextId, date: 0 }); },
    editMessageText: (_chat: string, _id: number, text: string) => { calls.push({ kind: 'edit', at: Date.now(), text }); return Promise.resolve(true); },
    sendChatAction: () => Promise.resolve(true),
  };
  return { bot: { api } as unknown as Bot };
}

async function* ticker(chunks: string[], everyMs: number): AsyncGenerator<string> {
  for (const chunk of chunks) { await new Promise((resolve) => setTimeout(resolve, everyMs)); yield chunk; }
}

const options = { mode: 'stream' as const, replyDelayMs: 150, intervalMs: 40, minDeltaChars: 1, maxChars: 3900 };

describe('Telegram reply pacing', () => {
  it('holds the first message until replyDelayMs has passed since the user message', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const since = Date.now();
    const result = await new TelegramOutput(bot, 'chat', options, undefined, since).consume(ticker(['一', '二', '三', '四', '五', '六'], 40));
    const first = calls.find((call) => call.kind === 'send')!;
    expect(first.at - since).toBeGreaterThanOrEqual(options.replyDelayMs);
    // 窗口内的 chunk 只是没发出去，不是被丢掉了。
    expect(result.text).toBe('一二三四五六');
    expect(calls.at(-1)!.text).toBe('一二三四五六');
  });

  it('still sends exactly once when the whole stream finishes inside the delay window', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const since = Date.now();
    const result = await new TelegramOutput(bot, 'chat', options, undefined, since).consume(ticker(['短', '答'], 1));
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    expect(calls[0]!.at - since).toBeGreaterThanOrEqual(options.replyDelayMs);
    expect(result.text).toBe('短答');
  });

  it('does not add the delay again when the model already took longer than it', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const since = Date.now() - 5000;
    await new TelegramOutput(bot, 'chat', options, undefined, since).consume(ticker(['立', '刻'], 1));
    expect(calls[0]!.at - Date.now()).toBeLessThan(options.replyDelayMs);
  });
});
