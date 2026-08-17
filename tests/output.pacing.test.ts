import type { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramOutput, pickPlaceholder } from '@luoli/telegram';

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

const options = { mode: 'stream' as const, replyDelayMs: 150, bufferMs: 150, intervalMs: 40, minDeltaChars: 1, maxChars: 3900 };

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

  // 这条是「第一条消息只有一个字，剩下的靠编辑补出来」的回归：replyDelayMs 锚在用户消息上，
  // 模型想久一点它就形同虚设，首个 chunk 会被原样发出去。bufferMs 锚在上游第一个 chunk 上。
  it('buffers for bufferMs after the first chunk instead of shipping that chunk alone', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const since = Date.now() - 5000;
    const start = Date.now();
    await new TelegramOutput(bot, 'chat', options, undefined, since).consume(ticker(['一', '二', '三', '四', '五', '六', '七', '八'], 40));
    const first = calls.find((call) => call.kind === 'send')!;
    expect(first.at - start).toBeGreaterThanOrEqual(options.bufferMs);
    expect([...first.text].length).toBeGreaterThan(1);
  });

  it('counts the first send as a refresh so the next edit still waits a full interval', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    // 首条发出后紧跟着的那次编辑只是抖动：消息里已经是同一段文本，多出来的两个字不值一次编辑。
    const slowEdits = { ...options, replyDelayMs: 0, bufferMs: 60, intervalMs: 10_000 };
    await new TelegramOutput(bot, 'chat', slowEdits, undefined, Date.now() - 5000).consume(ticker(['一', '二', '三', '四', '五', '六'], 30));
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'edit')).toHaveLength(1); // 只有收尾那一次
    expect(calls.at(-1)!.text).toBe('一二三四五六');
  });
});

// `output.placeholderTexts` / `placeholderPick` / `placeholderIndex`：等待文案此前是写死的 `…`，
// WebUI 上一个字都改不了。这一组盯住三件事：挑对了哪条、清空列表真的把占位消息关掉、
// 以及占位消息发出后不会因为文案变长而拖慢第一次真编辑。
describe('waiting placeholder text', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('covers the whole candidate list in random mode', () => {
    const seen = new Set<string>();
    // 直接钉住 Math.random：跑几十遍看有没有覆盖全是概率断言，偶尔红一次比没有断言更糟。
    for (const value of [0, 0.34, 0.67, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(value);
      seen.add(pickPlaceholder(['一', '二', '三'], 'random', 0)!);
    }
    expect([...seen].sort()).toEqual(['一', '三', '二']);
  });

  it('honours the index in fixed mode and falls back to the first entry when it is out of range', () => {
    const texts = ['一', '二', '三'];
    expect(pickPlaceholder(texts, 'fixed', 1)).toBe('二');
    // 越界回落到第一条而不是末条：把列表改短的人想要的是「还有得发」，不是悄悄换成另一条。
    expect(pickPlaceholder(texts, 'fixed', 9)).toBe('一');
  });

  it('drops blank entries and reads an all-blank list as "no placeholder at all"', () => {
    expect(pickPlaceholder([' ', '二', ''], 'fixed', 0)).toBe('二');
    expect(pickPlaceholder([], 'random', 0)).toBeNull();
    expect(pickPlaceholder(['', '   '], 'random', 0)).toBeNull();
    expect(pickPlaceholder(undefined, 'random', 0)).toBeNull();
  });

  it('sends the configured text and then edits that same message into the answer', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const slow = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, placeholderAfterMs: 20, placeholderTexts: ['让我想想…'], placeholderPick: 'fixed' as const, placeholderIndex: 0 };
    await new TelegramOutput(bot, 'chat', slow, undefined, Date.now()).consume(ticker(['甲', '乙', '丙'], 60));
    expect(calls[0]).toMatchObject({ kind: 'send', text: '让我想想…' });
    // 占位消息**就是**后面被编辑的那条：另发一条会让「让我想想…」和答复分两条并排躺着。
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ kind: 'edit', text: '甲乙丙' });
  });

  it('sends nothing early when the text list is empty', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    // 清空列表是关掉占位消息的唯一途径：placeholderAfterMs 的 schema 是 positive，填不了 0。
    const off = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, placeholderAfterMs: 20, placeholderTexts: [] };
    await new TelegramOutput(bot, 'chat', off, undefined, Date.now()).consume(ticker(['甲', '乙', '丙'], 60));
    expect(calls[0]!.kind).toBe('send');
    expect(calls[0]!.text.startsWith('甲')).toBe(true); // 第一条就是答复本身，不是占位
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
  });

  it('does not let a long placeholder push back the first real edit', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    // 渲染基线记成文案长度（10）的话，minDeltaChars=5 要等答复满 15 字才肯编辑 —— 六个 chunk 到
    // 不了，占位消息会一直挂到收尾。基线归 0 时第 5 个字就该换掉它。
    const wordy = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, minDeltaChars: 5, placeholderAfterMs: 20, placeholderTexts: ['一二三四五六七八九十'] };
    await new TelegramOutput(bot, 'chat', wordy, undefined, Date.now()).consume(ticker(['A', 'B', 'C', 'D', 'E', 'F'], 30));
    expect(calls.filter((call) => call.kind === 'edit').map((call) => call.text)).toContain('ABCDE');
  });
});
