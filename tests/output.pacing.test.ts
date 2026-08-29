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

/**
 * 投递层的语义 span（`docs/10 §2` 的 `tg.send` / `tg.edit` / `tg.action`）。
 *
 * `tg.api` 那条位于 grammY 的 transformer 内，取不到 turn/chat 上下文：生产库 9745 条中
 * `trace_id IS NULL` 的是 9745 条，`data` 只有 `{method, ok}`，既无 chars 也无 messageId
 * （docs/28 · L-LOG-02）。`tg.edit` / `tg.action` 每轮各只落一条：一次流式回复可产生数十次编辑。
 */
describe('投递层的 tg.send / tg.edit / tg.action', () => {
  it('send 一条一行，edit 与 action 各聚合成一条带次数', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const events: Array<{ kind: string; count?: number; messageId?: number; chars?: number; ok: boolean }> = [];
    const output = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 1 }, undefined, Date.now() - 5000);
    output.onDelivery = (event) => events.push(event);
    await output.consume(ticker(['一', '二', '三', '四', '五'], 20));
    const sends = events.filter((event) => event.kind === 'send');
    const edits = events.filter((event) => event.kind === 'edit');
    // 首帧一条 send，其余均为编辑，聚合成一条带 count 的记录。
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ ok: true, messageId: 101, path: 'stream' });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.count).toBe(calls.filter((call) => call.kind === 'edit').length);
    expect(edits[0]!.count!).toBeGreaterThan(1);
    // 开轮时的首发 typing 是无条件的，因此 action 至少一次，同样聚合成一条。
    const actions = events.filter((event) => event.kind === 'action');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it('`once` 档也发 tg.send —— 三个 return 点都要经过聚合收口', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const events: Array<{ kind: string; path?: string }> = [];
    const output = new TelegramOutput(bot, 'chat', { ...options, mode: 'once', replyDelayMs: 0 }, undefined, Date.now() - 5000);
    output.onDelivery = (event) => events.push(event);
    await output.consume(ticker(['整', '条'], 1));
    expect(events.filter((event) => event.kind === 'send').map((event) => event.path)).toEqual(['once']);
    expect(events.filter((event) => event.kind === 'edit')).toEqual([]);
  });

  /**
   * 该档位投递失败时向上抛出（由上层记为整轮失败），而投递侧的那一行不能随之消失：
   * `tg.api` 没有 traceId，本轮发出了什么、哪一段未发出，只有 `tg.send` 能回答
   * （docs/28 · L-LOG-02）。此前 `once` 与兜底两条路径都硬写 `ok: true`，失败档不可达。
   */
  it('`once` 档发不出去时也落一条 ok:false 的 tg.send', async () => {
    const bot = { api: { sendMessage: () => Promise.reject(new Error('403: bot was blocked by the user')),
      sendChatAction: () => Promise.resolve(true) } } as unknown as Bot;
    const events: Array<{ kind: string; ok: boolean; path?: string; error?: string }> = [];
    const output = new TelegramOutput(bot, 'chat', { ...options, mode: 'once', replyDelayMs: 0 }, undefined, Date.now() - 5000);
    output.onDelivery = (event) => events.push(event);
    await expect(output.consume(ticker(['整', '条'], 1))).rejects.toThrow('blocked');
    expect(events.filter((event) => event.kind === 'send'))
      .toMatchObject([{ ok: false, path: 'once', error: expect.stringContaining('blocked') }]);
  });

  it('onDelivery 抛出来也不许打断投递', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const output = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 1 }, undefined, Date.now() - 5000);
    output.onDelivery = () => { throw new Error('日志挂了'); };
    const result = await output.consume(ticker(['一', '二'], 5));
    expect(result.text).toBe('一二');
    expect(calls.some((call) => call.kind === 'send')).toBe(true);
  });
});

describe('Telegram reply pacing', () => {
  it('holds the first message until replyDelayMs has passed since the user message', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    const since = Date.now();
    const result = await new TelegramOutput(bot, 'chat', options, undefined, since).consume(ticker(['一', '二', '三', '四', '五', '六'], 40));
    const first = calls.find((call) => call.kind === 'send')!;
    expect(first.at - since).toBeGreaterThanOrEqual(options.replyDelayMs);
    // 窗口内的 chunk 只是尚未发出，并非被丢弃。
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

  // 回归：首条消息只有一个字、其余靠编辑补齐。replyDelayMs 锚定在用户消息上，模型思考时间稍长
  // 即形同虚设，首个 chunk 会被原样发出；bufferMs 锚定在上游第一个 chunk 上。
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
    // 首条发出后紧随的那次编辑属于抖动：消息里已是同一段文本，新增两个字不足以触发一次编辑。
    const slowEdits = { ...options, replyDelayMs: 0, bufferMs: 60, intervalMs: 10_000 };
    await new TelegramOutput(bot, 'chat', slowEdits, undefined, Date.now() - 5000).consume(ticker(['一', '二', '三', '四', '五', '六'], 30));
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'edit')).toHaveLength(1); // 仅收尾那一次
    expect(calls.at(-1)!.text).toBe('一二三四五六');
  });

  /**
   * 回归：typing 曾是 4 秒一次的 fire-and-forget，不检查上一次是否已落地。群聊的 API 预算为
   * `telegram.throttle.perChatPerMinute`（默认 20/分钟），4 秒一次即 15/分钟，同一群内两轮并发
   * 即超出预算，超出部分全部进入队列且排在正文消息之前。实测 logs/2026-08-18：19:13:03 起每分钟
   * 稳定发出 20 条 sendChatAction，本轮收尾编辑压在队尾，轮次在 19:13:03 已被 `turnTimeoutMs`
   * 中断，用户又等待 3 分钟才看到最后一次编辑。
   */
  it('typing 排不起队：上一拍还没落地就跳过这一拍', async () => {
    vi.useFakeTimers();
    try {
      const releases: Array<() => void> = [];
      let ticks = 0;
      let inFlight = 0;
      let peak = 0;
      let first = true;
      const api = {
        sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }),
        editMessageText: () => Promise.resolve(true),
        // 第一次是 `consume` 自身 await 的那一发（进入循环之前），令其立即落地；其后每一发都挂起，
        // 模拟被 apiThrottler 压在队列中。
        sendChatAction: () => {
          if (first) { first = false; return Promise.resolve(true); }
          ticks += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          return new Promise<boolean>((resolve) => releases.push(() => { inFlight -= 1; resolve(true); }));
        },
      };
      const bot = { api } as unknown as Bot;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const stream = (async function* () { yield '在查'; await gate; })();
      const consuming = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0 }, undefined, Date.now()).consume(stream);
      await vi.advanceTimersByTimeAsync(21_000); // 5 拍
      expect(ticks).toBe(1);
      expect(peak).toBe(1);
      for (const release of releases) release();
      open();
      await consuming;
    } finally { vi.useRealTimers(); }
  });

  /**
   * 上一条只减少了 typing 的发送量，且作用域是 per `TelegramOutput` 实例（即 per 轮次），而 20/分钟
   * 那个桶是 per chat 的，队列不再增长只在单轮成立。第十轮实测：群内 6 轮并发 17 秒耗尽储备，
   * 随后 14 秒零投递，队首的 `sendChatAction` 排队 14455ms，占用的正是其后 `editMessageText`
   * （14028ms）所需的槽位（docs/28 · L-TG-04）。
   *
   * 判据：typing 可丢弃、正文不可丢弃，因此本轮有正文在途时整拍跳过 typing。
   */
  it('正文在途时整拍不发 typing：可丢的不许占住不可丢的槽位', async () => {
    vi.useFakeTimers();
    try {
      let typings = 0;
      let releaseSend!: (message: { message_id: number; date: number }) => void;
      const api = {
        // 压在 apiThrottler 队列里的一条正文：整个时段内它都处于在途状态。
        sendMessage: () => new Promise<{ message_id: number; date: number }>((resolve) => { releaseSend = resolve; }),
        editMessageText: () => Promise.resolve(true),
        sendChatAction: () => { typings += 1; return Promise.resolve(true); },
      };
      const bot = { api } as unknown as Bot;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const stream = (async function* () { yield '在查'; await gate; })();
      const consuming = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0 }, undefined, Date.now()).consume(stream);
      await vi.advanceTimersByTimeAsync(21_000); // 5 拍，全部不应发出
      // 仅保留进入循环之前那一发：此时界面上尚无任何文本，typing 是唯一的处理中信号。
      expect(typings).toBe(1);
      releaseSend({ message_id: 1, date: 0 });
      open();
      await consuming;
    } finally { vi.useRealTimers(); }
  });

  /**
   * 另一半判据：首条消息发出后节拍放宽（`docs/08 §5.2` 的伪码即写明每 4s 续期，直到首条消息发出）。
   * 旧行为在这 60 秒内要发 15 条 sendChatAction，占用 20/分钟 预算的四分之三。同时不得退化为完全
   * 不发 typing：一次三十秒的工具调用在用户侧不能与进程无响应表现一致。
   */
  it('首条消息发出之后 typing 的节拍放宽，但绝不整轮不发', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const at: number[] = [];
      const api = {
        sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }),
        editMessageText: () => Promise.resolve(true),
        sendChatAction: () => { at.push(Date.now() - start); return Promise.resolve(true); },
      };
      const bot = { api } as unknown as Bot;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const stream = (async function* () { yield '在查'; await gate; })();
      const consuming = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0 }, undefined, start).consume(stream);
      await vi.advanceTimersByTimeAsync(60_000);
      // 开轮一发 + 首条之后每 15 秒一发（4 秒一拍，落在 16 / 32 / 48 秒）= 60 秒内 4 条，
      // 旧行为为 15 条。TYPING_TICK_MS / TYPING_QUIET_MS 变更时该断言会失败。
      expect(at).toEqual([0, 16_000, 32_000, 48_000]);
      open();
      await consuming;
    } finally { vi.useRealTimers(); }
  });
});

// `output.placeholderTexts` / `placeholderPick` / `placeholderIndex`：等待文案此前硬编码为 `…`，
// WebUI 无法修改。这一组覆盖三项判据：选中条目正确、清空列表可关闭占位消息，
// 以及占位消息发出后不会因文案变长而推迟第一次真实编辑。
describe('waiting placeholder text', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('covers the whole candidate list in random mode', () => {
    const seen = new Set<string>();
    // 直接固定 Math.random：靠多次运行观察覆盖属于概率断言，偶发失败比没有断言更糟。
    for (const value of [0, 0.34, 0.67, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(value);
      seen.add(pickPlaceholder(['一', '二', '三'], 'random', 0)!);
    }
    expect([...seen].sort()).toEqual(['一', '三', '二']);
  });

  it('honours the index in fixed mode and falls back to the first entry when it is out of range', () => {
    const texts = ['一', '二', '三'];
    expect(pickPlaceholder(texts, 'fixed', 1)).toBe('二');
    // 越界回落到第一条而非末条：缩短列表的意图是继续可用，而不是静默切换到另一条文案。
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
    // 占位消息即后续被编辑的那条：另发一条会使等待文案与答复变成并列的两条消息。
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ kind: 'edit', text: '甲乙丙' });
  });

  it('sends nothing early when the text list is empty', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    // 清空列表是关闭占位消息的唯一途径：placeholderAfterMs 的 schema 为 positive，填不了 0。
    const off = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, placeholderAfterMs: 20, placeholderTexts: [] };
    await new TelegramOutput(bot, 'chat', off, undefined, Date.now()).consume(ticker(['甲', '乙', '丙'], 60));
    expect(calls[0]!.kind).toBe('send');
    expect(calls[0]!.text.startsWith('甲')).toBe(true); // 第一条即答复本身，不是占位
    expect(calls.filter((call) => call.kind === 'send')).toHaveLength(1);
  });

  it('does not let a long placeholder push back the first real edit', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    // 若把渲染基线记为文案长度（10），minDeltaChars=5 要等答复满 15 字才编辑，六个 chunk 达不到，
    // 占位消息会一直保留到收尾。基线归 0 时第 5 个字即应替换它。
    const wordy = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 10, minDeltaChars: 5, placeholderAfterMs: 20, placeholderTexts: ['一二三四五六七八九十'] };
    await new TelegramOutput(bot, 'chat', wordy, undefined, Date.now()).consume(ticker(['A', 'B', 'C', 'D', 'E', 'F'], 30));
    expect(calls.filter((call) => call.kind === 'edit').map((call) => call.text)).toContain('ABCDE');
  });

  /**
   * 回归：`beforeSend` 与 `capMentions` 此前合并在一个 async 闭包里且只被 `send()` 调用，而流式
   * 编辑路径直接调用 `splitTelegramText`，导致 `output.maxMentions` 在每个流式轮次均未生效，
   * 尽管 `bot.ts` 的注释称其在投递侧收口。现拆为两个回调：sanitize 每帧执行、beforeSend 定稿执行。
   */
  it('applies the sync guard on every flush and the plugin hook only once', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    let hookCalls = 0;
    const fast = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 1, minDeltaChars: 1 };
    const result = await new TelegramOutput(bot, 'chat', fast, undefined, Date.now(),
      async (text) => { hookCalls += 1; return `${text}已过钩子`; },
      (text) => text.replaceAll('@everyone', '各位')).consume(ticker(['@everyone 甲', '。@everyone 乙', '。丙'], 30));
    // 每次投递出去的文本都经过同步那一道处理，中途的编辑也不例外。
    for (const call of calls) expect(call.text).not.toContain('@everyone');
    expect(calls.some((call) => call.text.includes('各位'))).toBe(true);
    expect(hookCalls).toBe(1);
    expect(calls.at(-1)!.text).toContain('已过钩子');
    // 中途的编辑不应带上钩子的产物：钩子只在定稿那一次执行。
    expect(calls.slice(0, -1).every((call) => !call.text.includes('已过钩子'))).toBe(true);
    // 归档与上下文保存的是模型原始输出，而非改写后的文本。
    expect(result.text).toBe('@everyone 甲。@everyone 乙。丙');
  });
});
