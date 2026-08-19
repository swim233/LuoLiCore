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
 * `tg.api` 那条在 grammY 的 transformer 里，**拿不到 turn/chat 上下文**：生产库 9745 条里
 * `trace_id IS NULL` 的是 9745 条，`data` 只有 `{method, ok}` —— 没有 chars、没有 messageId
 * （docs/28 · L-LOG-02）。`tg.edit` / `tg.action` 一轮各只落**一条**：一次流式回复能编辑几十次。
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
    // 首帧一条 send；其余全是编辑，聚合成**一条**带 count。
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ ok: true, messageId: 101, path: 'stream' });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.count).toBe(calls.filter((call) => call.kind === 'edit').length);
    expect(edits[0]!.count!).toBeGreaterThan(1);
    // 开轮那一发 typing 是无条件的，所以 action 至少一次，同样聚合成一条。
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
   * 这一档发不出去时是**抛出去**的（由上层记成整轮失败），而投递侧那一行不能跟着消失：
   * `tg.api` 没有 traceId，「这一轮发了什么、哪一段没发出去」只有 `tg.send` 回答得了
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

  /**
   * 回归：typing 曾是 4 秒一发的 fire-and-forget，谁都不管上一次落地没有。而群聊的 API 预算是
   * `telegram.throttle.perChatPerMinute`（默认 20/分钟），4 秒一次已经是 15/分钟 —— 同一个群里两轮
   * 并行就超了预算，多出来的每一条都排在队里，**并且排在真正的消息前面**。实测 logs/2026-08-18：
   * 19:13:03 起每分钟准点吐 20 条 sendChatAction，而这一轮的收尾编辑压在队尾，轮次早在 19:13:03
   * 就被 `turnTimeoutMs` 掐了，用户又等了 3 分钟才看到最后一次编辑。
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
        // 第一次是 `consume` 自己 await 的那一发（进循环之前），让它当场落地；后面每一发都挂住，
        // 模拟被 apiThrottler 压在队列里。
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
   * 上面那条只让 typing **少**了，而它是 per `TelegramOutput` 实例（= per 轮次）的，20/分钟 那个桶
   * 却是 per chat 的 —— 「队列不再增长」只在单轮成立。第十轮实测：群内 6 轮并发 17 秒吃光储备，
   * 随后**整整 14 秒零投递**，排在队首的 `sendChatAction` 排了 14455ms，占的正是后面那条
   * `editMessageText`（14028ms）要用的槽位（docs/28 · L-TG-04）。
   *
   * 判据：**typing 可丢、正文不可丢，所以本轮有正文在途时整拍跳过 typing。**
   */
  it('正文在途时整拍不发 typing：可丢的不许占住不可丢的槽位', async () => {
    vi.useFakeTimers();
    try {
      let typings = 0;
      let releaseSend!: (message: { message_id: number; date: number }) => void;
      const api = {
        // 压在 apiThrottler 队列里的一条正文：整段时间里它都「在途」。
        sendMessage: () => new Promise<{ message_id: number; date: number }>((resolve) => { releaseSend = resolve; }),
        editMessageText: () => Promise.resolve(true),
        sendChatAction: () => { typings += 1; return Promise.resolve(true); },
      };
      const bot = { api } as unknown as Bot;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const stream = (async function* () { yield '在查'; await gate; })();
      const consuming = new TelegramOutput(bot, 'chat', { ...options, replyDelayMs: 0, bufferMs: 0 }, undefined, Date.now()).consume(stream);
      await vi.advanceTimersByTimeAsync(21_000); // 5 拍，一拍都不该发
      // 只有进循环之前那一发（那时屏幕上一个字都没有，typing 是唯一的「在干活」信号）。
      expect(typings).toBe(1);
      releaseSend({ message_id: 1, date: 0 });
      open();
      await consuming;
    } finally { vi.useRealTimers(); }
  });

  /**
   * 另一半判据：**首条消息发出之后节拍放宽**（`docs/08 §5.2` 的伪码本来就写着「每 4s 续期，直到
   * 首次消息发出」）。旧行为在这 60 秒里要发 15 条 sendChatAction，占掉 20/分钟 预算的四分之三。
   * 同时**不许退化成「typing 完全不发」** —— 一次三十秒的工具调用在用户那边不能和「bot 死了」一样。
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
      // 开轮那一发 + 首条之后每 15 秒一发（4 秒一拍，所以落在 16 / 32 / 48 秒）= 60 秒里 4 条，
      // 旧行为是 15 条。这两个数字（TYPING_TICK_MS / TYPING_QUIET_MS）改动时这条会红。
      expect(at).toEqual([0, 16_000, 32_000, 48_000]);
      open();
      await consuming;
    } finally { vi.useRealTimers(); }
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

  /**
   * 回归：`beforeSend` 与 `capMentions` 此前合在一个 async 闭包里、只被 `send()` 调用，而流式
   * 编辑路径直接调 `splitTelegramText` —— 于是 `output.maxMentions` 在**每个流式轮次**都没生效，
   * 尽管 `bot.ts` 的注释写着它「在投递侧收口」。现在拆成两个回调：sanitize 每帧跑、beforeSend 定稿跑。
   */
  it('applies the sync guard on every flush and the plugin hook only once', async () => {
    const calls: Call[] = [];
    const { bot } = fakeBot(calls);
    let hookCalls = 0;
    const fast = { ...options, replyDelayMs: 0, bufferMs: 0, intervalMs: 1, minDeltaChars: 1 };
    const result = await new TelegramOutput(bot, 'chat', fast, undefined, Date.now(),
      async (text) => { hookCalls += 1; return `${text}已过钩子`; },
      (text) => text.replaceAll('@everyone', '各位')).consume(ticker(['@everyone 甲', '。@everyone 乙', '。丙'], 30));
    // 每一次投递出去的文本都过了同步那道，中途的编辑也不例外。
    for (const call of calls) expect(call.text).not.toContain('@everyone');
    expect(calls.some((call) => call.text.includes('各位'))).toBe(true);
    expect(hookCalls).toBe(1);
    expect(calls.at(-1)!.text).toContain('已过钩子');
    // 中途的编辑不该带上钩子的产物：钩子只在定稿那一次跑。
    expect(calls.slice(0, -1).every((call) => !call.text.includes('已过钩子'))).toBe(true);
    // 归档与上下文存的是模型原话，不是改写后的文本。
    expect(result.text).toBe('@everyone 甲。@everyone 乙。丙');
  });
});
