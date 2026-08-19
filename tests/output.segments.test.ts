import type { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { TelegramOutput, deliveryOrder, segmentTelegramText } from '@luoli/telegram';

/**
 * 分段投递的两条判据（`docs/reviews/28`）：
 *
 * - **`L-TG-03`**：同一轮的 3 条出站消息在 `messages` 表里是 3 行，**每行 `length(text)` 都是 9469**、
 *   head/tail 完全相同 —— 连带 `messages_fts` 三份，`search_messages` 把同一条回复搜出三次。
 * - **`L-TG-02`**：一条 9469 字的回复切成 3 条，Telegram 给的 id 是 1458 / 1459 / **1467** ——
 *   中间隔着三轮后续对话，真人在屏幕上确认第三段是在后面三条回复之后才冒出来的。
 *
 * 两条都落在「每一半都有测试、没有一条跨过边界」的位置上：分片器有 4000 轮随机用例，归档有自己的
 * 用例，而「分片之后每一段各自归档 / 那一批分段之间不许插队」两处都没有断言。
 */

const options = { mode: 'stream' as const, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, minDeltaChars: 1, maxChars: 200 };

/** 记下每次调用与调用时的段首字符：分段是否交错只看这一串。 */
function fakeBot(calls: Array<{ kind: 'send' | 'edit'; head: string }>, gapMs = 1): Bot {
  let nextId = 100;
  const api = {
    // 真实那一跳是 `apiThrottler` 的 `out: { minTime: 1000 }`：段与段之间必然让出一次事件循环，
    // 别的轮次的 `sendMessage` 就是在这个空档里挤进队列的。
    sendMessage: async (_chat: string, text: string) => {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      calls.push({ kind: 'send', head: [...text][0] ?? '' });
      nextId += 1;
      return { message_id: nextId, date: 0 };
    },
    editMessageText: async (_chat: string, _id: number, text: string) => {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      calls.push({ kind: 'edit', head: [...text][0] ?? '' });
      return true;
    },
    sendChatAction: () => Promise.resolve(true),
  };
  return { api } as unknown as Bot;
}

describe('segmentTelegramText：分片的同时给出逐段的归档文本', () => {
  it('只有一片时 archived 就是渲染前的原文，口径一个字未变', () => {
    const source = '用 `pnpm i` 装 1.2-beta';
    const segmented = segmentTelegramText(source, 3900);
    expect(segmented.rendered).toEqual(['用 `pnpm i` 装 1\\.2\\-beta']);
    // 归档存渲染前的正文：存 rendered 的话 WebUI 会话页和 `read_messages` 里的 bot 发言带一串 `\-` `\.`。
    expect(segmented.archived).toEqual([source]);
  });

  it('真的切开时每一段只存自己那一段，且不带 MarkdownV2 转义符', () => {
    const long = Array.from({ length: 40 }, (_, index) => `第 ${index} 段：见 1.2-beta 的说明。`).join('\n\n');
    const { rendered, archived } = segmentTelegramText(long, 300);
    expect(rendered.length).toBeGreaterThan(2);
    expect(archived).toHaveLength(rendered.length);
    // 此前这里给每一段都存一份**完整全文**（三行 9469 字、head/tail 相同）。
    for (const part of archived) {
      expect(part.length).toBeLessThan(long.length);
      expect(part).not.toContain('\\.');
      expect(part).not.toContain('\\-');
    }
    expect(new Set(archived).size).toBe(archived.length);
    // 拼起来还是那段话：只允许丢断点处被 trim 掉的空白。
    expect(archived.join('').replaceAll(/\s/gu, '')).toBe(long.replaceAll(/\s/gu, ''));
  });

  it('none 与 HTML 两档同样逐段，且各自不带自己那套标记', () => {
    const long = Array.from({ length: 30 }, (_, index) => `第 ${index} 行 a<b & c 与 **粗体**`).join('\n\n');
    for (const parseMode of ['none', 'HTML'] as const) {
      const { rendered, archived } = segmentTelegramText(long, 300, parseMode);
      expect(rendered.length).toBeGreaterThan(1);
      expect(archived).toHaveLength(rendered.length);
      for (const part of archived) {
        expect(part).not.toContain('<b>');
        expect(part).not.toContain('&amp;');
        expect(part.length).toBeLessThan(long.length);
      }
    }
  });

  it('空正文两个数组都是空的：归档跟着 messageIds 走，不许留一行空正文的 out', () => {
    expect(segmentTelegramText('', 3900)).toEqual({ rendered: [], archived: [] });
  });
});

describe('定稿那一批分段按 chat 串行（docs/28 · L-TG-02）', () => {
  it('同一个 chat 的两批分段不交错 —— 两个轮次共用模块级那一把锁', async () => {
    const calls: Array<{ kind: 'send' | 'edit'; head: string }> = [];
    const bot = fakeBot(calls);
    // 每份 600 个同一个字，maxChars=200 → 各切成好几段，段首字符就是它属于哪一轮。
    const count = segmentTelegramText('甲'.repeat(600), options.maxChars).rendered.length;
    expect(count).toBeGreaterThan(2);
    await Promise.all([
      new TelegramOutput(bot, 'chat-serial', options, undefined, Date.now()).send('甲'.repeat(600)),
      new TelegramOutput(bot, 'chat-serial', options, undefined, Date.now()).send('乙'.repeat(600)),
    ]);
    expect(calls).toHaveLength(count * 2);
    // 没有锁时这里是「甲乙甲乙甲乙…」：段与段之间那个空档里排进了另一轮的 sendMessage。
    expect(calls.map((call) => call.head).join('')).toMatch(new RegExp(`^(甲{${count}}乙{${count}}|乙{${count}}甲{${count}})$`, 'u'));
  });

  it('不同 chat 之间不串行：锁按 chatId 分键', async () => {
    const calls: Array<{ kind: 'send' | 'edit'; head: string }> = [];
    const bot = fakeBot(calls, 5);
    const count = segmentTelegramText('甲'.repeat(600), options.maxChars).rendered.length;
    await Promise.all([
      new TelegramOutput(bot, 'chat-a', options, undefined, Date.now()).send('甲'.repeat(600)),
      new TelegramOutput(bot, 'chat-b', options, undefined, Date.now()).send('乙'.repeat(600)),
    ]);
    expect(calls.map((call) => call.head).join('')).not.toMatch(new RegExp(`^(甲{${count}}乙{${count}}|乙{${count}}甲{${count}})$`, 'u'));
  });

  /**
   * **只盖定稿那一批，不盖流中途的增量编辑。** 盖整轮会让同一个群里的并发轮次变成实质串行
   * （前一轮跑完才能看到后一轮的字）—— 那是把一个投递顺序问题换成一个吞吐问题。
   */
  it('别的轮次正压在锁里时，流中途的首条与增量编辑照样发得出去', async () => {
    const calls: Array<{ kind: 'send' | 'edit'; head: string }> = [];
    const bot = fakeBot(calls);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    void deliveryOrder.run('chat-mid', () => held);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const stream = (async function* () { yield '甲'; await gate; yield '甲'; })();
    const consuming = new TelegramOutput(bot, 'chat-mid', options, undefined, Date.now()).consume(stream);
    // 锁还握在别人手里，而首条已经在屏幕上了。
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    open();
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await consuming;
  });
});

describe('consume 交回的 segments 与 messageIds 逐一对应（docs/28 · L-TG-03）', () => {
  it('分段时逐段交回，拼起来是整全文', async () => {
    const calls: Array<{ kind: 'send' | 'edit'; head: string }> = [];
    const answer = '甲'.repeat(300) + '乙'.repeat(300);
    const consumed = await new TelegramOutput(fakeBot(calls), 'chat-segments', { ...options, mode: 'once' }, undefined, Date.now())
      .consume((async function* () { yield '甲'.repeat(300); yield '乙'.repeat(300); })());
    expect(consumed.messageIds.length).toBeGreaterThan(1);
    expect(consumed.segments).toHaveLength(consumed.messageIds.length);
    expect(consumed.segments.join('')).toBe(answer);
    // 上下文侧仍是一条整全文，一个字都不动。
    expect(consumed.text).toBe(answer);
  });

  it('只有一条消息时 segments 是空的 —— 单条那一路仍存模型原话', async () => {
    const calls: Array<{ kind: 'send' | 'edit'; head: string }> = [];
    const consumed = await new TelegramOutput(fakeBot(calls), 'chat-single', { ...options, mode: 'once' }, undefined, Date.now())
      .consume((async function* () { yield '短答'; })());
    expect(consumed.messageIds).toHaveLength(1);
    expect(consumed.segments).toEqual([]);
  });
});
