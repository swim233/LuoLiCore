import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { DatabaseApprovalBroker, EventBus, LogSink, PROMPT_CALLBACK_MAX_BYTES, PROMPT_MAX_OPTIONS, PROMPT_TEXT_MAX, PROMPT_TTL_GRACE_MS, PendingPrompts, ToolRegistry, configSchema, parsePromptToken, promptToken, type ApprovalOutcome, type PromptChannel, type PromptPost, type PromptRequest, type PromptTarget } from '@luoli/core';
import { approvalSettledText, promptAckText, promptDeniedByChat, staleApprovalOutcome } from '@luoli/telegram';
import type { RuntimeTurnContext } from '@luoli/shared';
import { z } from 'zod';

/**
 * 用例自己实现的 `PromptChannel`。这与既有的 `{ request: async () => true }` 桩、`telegram: null`
 * 同一档：接口是 core 定的，实现本来就该可替换（`docs/05 §6.1` 的注入形状），不是引入 mock 层。
 */
class TestChannel implements PromptChannel {
  readonly posts: PromptPost[] = [];
  readonly settled: PromptTarget[] = [];
  /** 每次收尾带的正文，与 `settled` 一一对应。`undefined` = 只撤键盘、没改正文。 */
  readonly rewrites: (string | undefined)[] = [];
  /** 置真时 `settle()` 抛 —— 模拟消息已被用户删掉。改文案失败不该影响审批本身。 */
  settleThrows = false;
  /** 置真时 `post()` 抛 —— 模拟 Telegram 拒收那条带按钮的回执（屏幕上一个字都没有）。 */
  postThrows = false;
  up = true;
  /** 「那个会话里点得动吗」。默认全都点得动；置成一个集合就模拟 D9 把某些会话压到 owner 档以下。 */
  decidableChats: Set<string> | null = null;
  /** 投递挂起时用：模拟「消息还在途中就被裁决了」。 */
  hold: (() => void) | null = null;
  #nextMessageId = 500;
  available(chatId?: string): boolean {
    if (!this.up) return false;
    return chatId === undefined || this.decidableChats === null || this.decidableChats.has(chatId);
  }
  async post(post: PromptPost): Promise<PromptTarget | null> {
    this.posts.push(post);
    if (this.hold) await new Promise<void>((release) => { this.hold = release; });
    if (this.postThrows) throw new Error('bot was blocked by the user');
    return { chatId: post.chatId, messageId: this.#nextMessageId++ };
  }
  async settle(target: PromptTarget, text?: string): Promise<void> {
    this.settled.push(target);
    this.rewrites.push(text);
    if (this.settleThrows) throw new Error('message to edit not found');
  }
}

function request(overrides: Partial<PromptRequest> = {}): PromptRequest {
  return { kind: 'approval', chatId: '-100', threadId: null, decidableBy: 'owner', initiatorUserId: '7', text: '要批准吗',
    options: [{ id: 'approve', label: '批准' }, { id: 'deny', label: '拒绝' }], ttlMs: 60_000, ...overrides };
}
/** 有效角色是**按 callback 所在的会话**算的，所以点的人身上得带 chatId（见 `resolve` 的会话绑定）。 */
const OWNER = { userId: '1', role: 'owner', chatId: '-100' } as const;
const TRUSTED = { userId: '7', role: 'trusted', chatId: '-100' } as const;

describe('PendingPrompts', () => {
  it('两条同时挂着的提示各自路由到自己的等待者', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const first = prompts.ask(request({ chatId: 'a' }));
    const second = prompts.ask(request({ chatId: 'b' }));
    expect(first.promptId).not.toBe(second.promptId);
    await Promise.all([first.posted, second.posted]);
    // 故意交叉：先点后发起的那一条。
    expect(prompts.resolve(promptToken(second.promptId, 1), { ...OWNER, chatId: 'b' })).toMatchObject({ status: 'accepted', optionId: 'deny' });
    expect(prompts.resolve(promptToken(first.promptId, 0), { ...OWNER, chatId: 'a' })).toMatchObject({ status: 'accepted', optionId: 'approve' });
    expect(await first.outcome).toMatchObject({ status: 'chosen', optionId: 'approve', actor: 'user:1' });
    expect(await second.outcome).toMatchObject({ status: 'chosen', optionId: 'deny', actor: 'user:1' });
    // 两条键盘各撤一次，撤的是各自那条消息。
    expect(channel.settled.map((target) => target.chatId).sort()).toEqual(['a', 'b']);
  });

  it('同一条消息点两次：第二次是「已经处理过了」而不是「已过期」', async () => {
    const prompts = new PendingPrompts(new TestChannel());
    const handle = prompts.ask(request());
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    expect(prompts.resolve(token, OWNER)).toMatchObject({ status: 'accepted' });
    // 「已经处理过了」与「已过期（进程重启过）」对点的人是两条不同的信息：前者说明有人已经做过
    // 决定，后者说明这条请求根本没人接手过。
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
  });

  it('查不到 promptId（进程重启过）与畸形 token 都回 unknown', () => {
    const prompts = new PendingPrompts(new TestChannel());
    // 注册表不持久化 —— Promise 跨不了进程，所以重启后的迟到点击必然落到这一支。
    expect(prompts.resolve(promptToken('01JZZZZZZZZZZZZZZZZZZZZZZZ', 0), OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('c:turn-1', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc:', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc:x', OWNER)).toEqual({ status: 'unknown' });
    // 下标越界（选项被砍过、或有人手搓 callback_data）不能翻出别人的选项。
    expect(prompts.resolve(`a:abc:${PROMPT_MAX_OPTIONS}`, OWNER)).toEqual({ status: 'unknown' });
  });

  it('decidableBy=owner 时 trusted 点了不生效，等待者一动不动', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ decidableBy: 'owner', initiatorUserId: TRUSTED.userId }));
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    // 点的人正是发起人 —— decidableBy=owner 之下这仍然不够（`approval.allowInitiator` 已永久摘除，docs/14 A26）。
    expect(prompts.resolve(token, TRUSTED)).toEqual({ status: 'forbidden', required: 'owner' });
    // 越权那一次**不消耗**这条提示：键盘还在，owner 随后点仍然算。
    expect(channel.settled).toEqual([]);
    expect(prompts.resolve(token, OWNER)).toMatchObject({ status: 'accepted' });
    expect(await handle.outcome).toMatchObject({ status: 'chosen' });
  });

  it('decidableBy=initiator 时发起人自己可以点，别人不行', async () => {
    const prompts = new PendingPrompts(new TestChannel());
    const handle = prompts.ask(request({ decidableBy: 'initiator', initiatorUserId: '7' }));
    await handle.posted;
    expect(prompts.resolve(promptToken(handle.promptId, 0), { userId: '9', role: 'trusted', chatId: '-100' })).toEqual({ status: 'forbidden', required: 'initiator' });
    expect(prompts.resolve(promptToken(handle.promptId, 0), TRUSTED)).toMatchObject({ status: 'accepted' });
  });

  it('claim 说底下那条请求已经不是 pending 了 → stale，且键盘要撤掉', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ claim: () => false }));
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'stale' });
    expect(channel.settled).toHaveLength(1);
    // 这一次点击照旧算消耗掉了：同一个人点同一条消息，重来一次的答案不会变。
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
  });

  it('超时以 expired 收尾，宽限期排在发起方的 TTL 之后', async () => {
    vi.useFakeTimers();
    try {
      const channel = new TestChannel();
      const prompts = new PendingPrompts(channel);
      const handle = prompts.ask(request({ ttlMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1000);
      // TTL 的唯一所有者是发起方；这个 timer 只负责撤键盘，所以到点时它还不该响。
      expect(channel.settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(PROMPT_TTL_GRACE_MS + 1);
      expect(await handle.outcome).toEqual({ status: 'expired' });
      expect(channel.settled).toHaveLength(1);
      // 过期之后的点击不是「已经处理过了」—— 没人处理过它。
      expect(prompts.resolve(promptToken(handle.promptId, 0), OWNER)).toEqual({ status: 'unknown' });
    } finally { vi.useRealTimers(); }
  });

  it('轮次 abort 时以 cancelled 收尾；已 abort 的信号不会留下等待者', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const controller = new AbortController();
    const handle = prompts.ask(request({ abortSignal: controller.signal }));
    await handle.posted;
    controller.abort();
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
    expect(channel.settled).toHaveLength(1);
    const dead = new AbortController();
    dead.abort();
    const stillborn = prompts.ask(request({ abortSignal: dead.signal }));
    expect(await stillborn.posted).toBeNull();
    expect(await stillborn.outcome).toEqual({ status: 'cancelled' });
    expect(channel.posts).toHaveLength(1);
  });

  it('投递还在途中就被取消：键盘一落地就撤', async () => {
    const channel = new TestChannel();
    channel.hold = () => undefined;
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    handle.cancel();
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
    channel.hold?.();
    const posted = await handle.posted;
    expect(posted).not.toBeNull();
    expect(channel.settled).toEqual([posted]);
  });

  it('同一条键盘只撤一次 —— 发起方与注册表各有一条撤销路径', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    const posted = (await handle.posted)!;
    prompts.dismiss(posted);
    prompts.dismiss(posted);
    handle.cancel();
    expect(channel.settled).toEqual([posted]);
  });

  it('dispose 收尾所有等待者但不撤键盘（那几次编辑会被 bot.stop() 掐断）', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    await handle.posted;
    prompts.dispose();
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
    expect(channel.settled).toEqual([]);
  });

  it('会话对不上的点击一律当查不到 —— 有效角色是按 callback 所在会话算的', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ chatId: '-100' }));
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    // 非官方客户端能对任意消息构造 `callback_data`：不绑会话的话，一个人在自己是 owner 的群里
    // 就能替另一个会话裁决 —— 而那条 role 是**按他那个群**算出来的。
    expect(prompts.resolve(token, { ...OWNER, chatId: '-999' })).toEqual({ status: 'unknown' });
    expect(channel.settled).toEqual([]);
    expect(prompts.resolve(token, OWNER)).toMatchObject({ status: 'accepted' });
  });

  it('提示还挂着但下标上没有选项 → invalid，键盘一个字节都不动', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    await handle.posted;
    // 只有伪造的 `callback_data` 到得了这里。当成 unknown 处理的话，调用方会顺手撤键盘 ——
    // 一次伪造就能把一条活着的提示的 Telegram 侧弄哑。
    expect(prompts.resolve(promptToken(handle.promptId, 5), OWNER)).toEqual({ status: 'invalid' });
    expect(channel.settled).toEqual([]);
    expect(prompts.resolve(promptToken(handle.promptId, 0), OWNER)).toMatchObject({ status: 'accepted' });
  });

  it('dispose 期间落地的投递也不撤键盘', async () => {
    const channel = new TestChannel();
    channel.hold = () => undefined;
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    prompts.dispose();
    channel.hold?.();
    await handle.posted;
    // `dispose()` 的约定是「不撤」（那几次编辑会被紧随其后的 bot.stop() 掐断）。只看 settled
    // 不看 dismiss 意图的话，投递一落地就把它撤了 —— 约定写着，却没人守。
    expect(channel.settled).toEqual([]);
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
  });

  it('callback_data 不越过 Bot API 的 64 字节上界', () => {
    const prompts = new PendingPrompts(new TestChannel());
    const handle = prompts.ask(request({ options: Array.from({ length: PROMPT_MAX_OPTIONS }, (_unused, index) => ({ id: `option-${index}`, label: `选项 ${index}` })) }));
    for (let index = 0; index < PROMPT_MAX_OPTIONS; index += 1) {
      const token = promptToken(handle.promptId, index);
      // 超了 Telegram 直接 400，而那一刻按钮已经在屏幕上了 —— 所以断言的是字节数而不是字符数。
      expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(PROMPT_CALLBACK_MAX_BYTES);
      expect(parsePromptToken(token)).toEqual({ promptId: handle.promptId, index });
    }
  });

  it('正文硬截断，且选项超上限时被砍掉', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ text: 'x'.repeat(PROMPT_TEXT_MAX + 400), options: Array.from({ length: PROMPT_MAX_OPTIONS + 3 }, (_unused, index) => ({ id: `o${index}`, label: `l${index}` })) }));
    await handle.posted;
    // 键盘挂在一条消息上：正文一长就该截断，不能交给 `segmentTelegramText` 切成两条 —— 那样有一条没按钮。
    expect(channel.posts[0]!.text).toHaveLength(PROMPT_TEXT_MAX);
    expect(channel.posts[0]!.buttons).toHaveLength(PROMPT_MAX_OPTIONS);
  });
});

/** 回执正文里那句倒计时话术。任何一种收场之后它都不该还留在屏幕上（`AC-APV-004`）。 */
const COUNTDOWN = '秒内没人处理就会自动拒绝';

function brokerHarness(name: string, options: { webuiChannel: boolean; telegramUp: boolean; abortSignal?: AbortSignal; ttlMs?: number }) {
  const path = `./data/prompts-${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, ttlMs: options.ttlMs ?? 10_000, skipForOwner: true, rules: [{ tool: 'bash', always: true, risk: 'high' }] } });
  const log = new LogSink(new OperationsRepository(db), './data/prompts-logs');
  const events = new EventBus();
  if (options.webuiChannel) events.subscribe(() => undefined, { channel: true });
  const channel = new TestChannel();
  channel.up = options.telegramUp;
  const prompts = new PendingPrompts(channel, log);
  const broker: DatabaseApprovalBroker = new DatabaseApprovalBroker(db, config, events, log, async (pending) => {
    const handle = prompts.ask({ kind: 'approval', chatId: pending.chatId, threadId: pending.threadId, decidableBy: 'owner', initiatorUserId: pending.requesterUserId,
      text: `${pending.tool} 要批准，${Math.round(pending.ttlMs / 1000)} ${COUNTDOWN}`, options: [{ id: 'approve', label: '批准' }, { id: 'deny', label: '拒绝' }], ttlMs: pending.ttlMs,
      claim: (optionId, actor) => broker.decide(pending.id, optionId === 'approve', actor, 'telegram') });
    const posted = await handle.posted;
    // 与 `main.ts` 同一条接线：`settle` 撤键盘**并**把正文换成结局，返回那次编辑是否真落地；
    // 发不出去时报 `delivered: false`，由 broker 两边一起判还有没有别的通道。
    return posted
      ? { tgMessageId: posted.messageId, settle: (outcome) => prompts.dismiss(posted, approvalSettledText(pending.tool, outcome)) }
      : { delivered: false };
  }, prompts);
  const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
  registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
  const turn = { turnId: `turn-${name}`, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '7', effectiveRole: 'trusted', isPrivate: false,
    baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: options.abortSignal ?? new AbortController().signal, config } satisfies RuntimeTurnContext;
  return { db, broker, prompts, channel, registry, context: { turn, workspace: './data', agentKind: 'main' as const } };
}
async function waitForPost(channel: TestChannel): Promise<PromptPost> {
  for (let round = 0; round < 60 && !channel.posts.length; round += 1) await new Promise((settle) => setTimeout(settle, 5));
  if (!channel.posts.length) throw new Error('prompt was never posted');
  return channel.posts[0]!;
}
/** 回执句柄落地：`tg_message_id` 与 `ApprovalReceipt.settle` 是同一个 `.then` 里置上的。 */
async function waitForReceipt(db: ReturnType<typeof openDatabase>): Promise<void> {
  const count = db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL');
  for (let round = 0; round < 60 && !count.pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
}
/** 待办列被销掉。清列排在收尾**落地之后**，所以判据是「等一会儿」而不是「立刻」。 */
async function receiptsPending(db: ReturnType<typeof openDatabase>): Promise<number> {
  const count = db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL');
  for (let round = 0; round < 40 && count.pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
  return Number(count.pluck().get());
}

/** brokerHarness 里那一轮跑在 chat `1`，而 `resolve` 绑会话。 */
const OWNER_IN_TURN = { ...OWNER, chatId: '1' };
const TRUSTED_IN_TURN = { ...TRUSTED, chatId: '1' };

describe('Telegram 审批裁决通道', () => {
  it('没有 WebUI 的 SSE 但 Telegram 通道在时照旧挂 pending 并等人点', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('tg-only', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(post.buttons.map((button) => button.label)).toEqual(['批准', '拒绝']);
    const row = db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string };
    expect(row).toBeTruthy();
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted', optionId: 'approve' });
    expect(await running).toEqual({ ok: true });
    expect(db.prepare('SELECT state,decided_by AS decidedBy,decision_channel AS channel FROM approvals WHERE id=?').get(row.id))
      .toMatchObject({ state: 'approved', decidedBy: 'user:1', channel: 'telegram' });
    closeDatabase(db);
  });

  it('两条通道都没有才当场拒 —— 漏判 Telegram 这一半就等于新通道永远走不到', async () => {
    const { db, registry, context } = brokerHarness('no-channel', { webuiChannel: false, telegramUp: false });
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    expect(performance.now() - started).toBeLessThan(100);
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toMatchObject({ count: 0 });
    closeDatabase(db);
  });

  it('trusted 点按钮不生效，pending 行照旧挂着', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('forbidden', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(prompts.resolve(post.buttons[1]!.token, TRUSTED_IN_TURN)).toEqual({ status: 'forbidden', required: 'owner' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='pending'").get()).toMatchObject({ count: 1 });
    expect(prompts.resolve(post.buttons[1]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted', optionId: 'deny' });
    expect(await running).toMatchObject({ ok: false, error: '未获批准' });
    closeDatabase(db);
  });

  /**
   * 一次点击回给点的人的那句话（`AC-APV-002`）。**「你确实是 owner，但在这个会话里不是」要单独讲**：
   * D9 把 owner 在一个 `trusted` 群里压成 `trusted`，那时 `promptAckText` 的「只有 owner 能裁决这条
   * 请求。」对他是纯粹的谎（`docs/05 §6` 那个警示块）。
   */
  it('越权点击的回话分两种：真的不是 owner，与「在这个会话里不是」', () => {
    const forbidden = { status: 'forbidden', required: 'owner' } as const;
    // 点的人本来就不是 owner —— 这一支不适用，交回通用文案。
    expect(promptDeniedByChat(forbidden, 'trusted', 'trusted')).toBeNull();
    expect(promptAckText(forbidden)).toEqual({ text: '只有 owner 能裁决这条请求。', show_alert: true });
    // 部署方本人在一个 trusted 群里点自己的审批：通用那句话是谎，这一支要接住它。
    const denied = promptDeniedByChat(forbidden, 'owner', 'trusted');
    expect(denied?.text).toContain('trusted');
    expect(denied?.text).toContain('WebUI');
    expect(denied?.show_alert).toBe(true);
    // owner 档会话里的 owner 不该走到 forbidden；真走到了也不该收到那句「会话本身不是 owner 档」。
    expect(promptDeniedByChat(forbidden, 'owner', 'owner')).toBeNull();
    // 「已经处理过了」与「已过期（进程重启过）」对点的人是两条不同的信息。
    expect(promptAckText({ status: 'settled' }).text).not.toBe(promptAckText({ status: 'unknown' }).text);
    // 成功那一次用轻提示 —— 弹窗会让每一次正常裁决都多一步点击。
    expect(promptAckText({ status: 'accepted', kind: 'approval', optionId: 'approve', label: '批准' })).toEqual({ text: '已批准' });
    for (const status of ['settled', 'invalid', 'stale', 'unknown'] as const) expect(promptAckText({ status }).show_alert).toBe(true);
  });

  it('WebUI 抢先裁决时 Telegram 那两个按钮当场消失，迟到的点击回 stale', async () => {
    const { db, broker, channel, prompts, registry, context } = brokerHarness('raced', { webuiChannel: true, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    const id = (db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string }).id;
    // `UPDATE … WHERE state='pending' AND expires_at>?` 是两条通道之间唯一的原子抢夺点。
    expect(broker.decide(id, false, 'owner', 'webui')).toBe(true);
    expect(await running).toMatchObject({ ok: false, error: '未获批准' });
    // 裁决落定时那两个按钮必须当场消失 —— 留着就是下一次误点。
    expect(channel.settled).toHaveLength(1);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toEqual({ status: 'stale' });
    expect(db.prepare('SELECT decision_channel AS channel FROM approvals WHERE id=?').get(id)).toMatchObject({ channel: 'webui' });
    closeDatabase(db);
  });

  it('tg_message_id 落库，且 staleKeyboards 读完就清列（重启后收拾残留键盘的待办队列）', async () => {
    const { db, broker, channel, prompts, registry, context } = brokerHarness('stale-keyboard', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    for (let round = 0; round < 60 && !db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL').pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    const messageId = db.prepare('SELECT tg_message_id FROM approvals').pluck().get() as number;
    expect(typeof messageId).toBe('number');
    // 一次进程重启：注册表清零（Promise 跨不了进程），屏幕上那排按钮由这一趟收拾。
    const restarted = new PendingPrompts(channel);
    const targets = broker.staleKeyboards();
    // 连 state / tool 一起读出来：正文要换成当时真正的结局，不是一律换成同一句。
    expect(targets).toEqual([{ chatId: '1', messageId, state: 'pending', tool: 'bash' }]);
    for (const target of targets) restarted.dismiss(target, approvalSettledText(target.tool, staleApprovalOutcome(target.state)));
    expect(channel.settled).toContainEqual({ chatId: '1', messageId, state: 'pending', tool: 'bash' });
    // 读完清列：不清的话每次重启都去编辑同一批历史消息。
    expect(broker.staleKeyboards()).toEqual([]);
    prompts.resolve(post.buttons[1]!.token, OWNER_IN_TURN);
    await running;
    closeDatabase(db);
  });

  /**
   * 上一条用例里 `staleKeyboards()` 已经把整列清空了，所以那里再断言「裁决后为空」是恒真的 ——
   * 把 `finish` 里那句清列删掉，用例照样绿。这一条不碰 `staleKeyboards`，只看裁决本身。
   */
  it('裁决落定时 tg_message_id 就该清掉，不留到下次启动', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('clear-on-decide', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    for (let round = 0; round < 60 && !db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL').pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL').get()).toMatchObject({ count: 1 });
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    expect(await running).toEqual({ ok: true });
    // 它记的是「还在屏幕上」：键盘已经撤了，那一列不该再留着 —— 一个长跑进程攒下的每条审批都留着
    // 的话，下次启动会挨个去编辑一遍，跟真实投递抢 `perChatPerMinute` 的槽位。
    expect(await receiptsPending(db)).toBe(0);
    closeDatabase(db);
  });

  /**
   * 清列的前提是**收尾真落地**。那一列是待办队列不是历史记录（`docs/03` 的 `approvals` 段），
   * 所以「那次 `editMessageText` 没回来」= 「这条还没办完」，得留给下次启动那趟 `staleKeyboards()`。
   * 抢在前面清的表现是：消息被删 / 网络抖 / 429 各来一次，那排按钮就永久没人收 —— 关停竞态
   * （`dispose()` 之后 `abortAll()` 那一下）只是其中一条来路，不是唯一那条。
   */
  it('收尾没落地就不清待办列 —— 留给下次启动那趟扫描', async () => {
    const { db, broker, channel, prompts, registry, context } = brokerHarness('receipt-not-landed', { webuiChannel: false, telegramUp: true });
    channel.settleThrows = true;
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    await waitForReceipt(db);
    const messageId = db.prepare('SELECT tg_message_id FROM approvals').pluck().get() as number;
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    expect(await running).toEqual({ ok: true });
    // 编辑抛了 → 屏幕上那排按钮还在 → 这一行仍然是待办。
    expect(await receiptsPending(db)).toBe(1);
    // 而下一次启动那趟扫描真的能把它捞回来（否则「留给下次启动」只是一句话）。
    expect(broker.staleKeyboards().map((row) => row.messageId)).toEqual([messageId]);
    closeDatabase(db);
  });

  /**
   * D9 的连带后果（`docs/05 §2.2` 那张表）：owner 在一个 `trusted` 群里的有效角色是 `trusted`，
   * 所以 `decidableBy:'owner'` 在那儿**无人可满足**。可用性判据必须把这一问算进去，否则挂上一条
   * pending 行、贴一排点不动的按钮，然后干等满 ttlMs —— `docs/22 · D-APPR-01` 换了个来路。
   */
  /**
   * `AC-APV-004` 的两半。留一句「N 秒内没人处理就会自动拒绝」停在一个已经不成立的状态上，正是
   * `docs/21 §12`「界面在说谎」清过的那一类 —— 所以撤键盘的同时把正文换成结局，而且是**同一次**
   * 编辑（两次调用要在 `perChatPerMinute` 那 20 个槽位里排两回队）。
   */
  it('五种收场的回执文案互不相同，一句都不再写倒计时', () => {
    const outcomes: ApprovalOutcome[] = [{ kind: 'approved', channel: 'telegram' }, { kind: 'approved', channel: 'webui' },
      { kind: 'denied', channel: 'telegram' }, { kind: 'denied', channel: 'webui' }, { kind: 'expired' }, { kind: 'cancelled' }, { kind: 'stale' }];
    const texts = outcomes.map((outcome) => approvalSettledText('bash', outcome));
    // 「Telegram 点的」「WebUI 裁的」「超时」「轮次取消」「进程重启」对屏幕前的人是五件不同的事。
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) {
      expect(text).not.toContain(COUNTDOWN);
      expect(text).toContain('bash');
      // `decided_by` 现在有两种格式（`user:<tgId>` / `owner`）—— 一串 Telegram id 对群里其他人
      // 什么都不是，还顺手把 owner 的 id 抖了出去。文案说的一律是 channel。
      expect(text).not.toContain('user:');
      expect(text).not.toMatch(/（owner ）/);
    }
    expect(approvalSettledText('bash', { kind: 'approved', channel: 'telegram' })).toContain('Telegram');
    expect(approvalSettledText('bash', { kind: 'approved', channel: 'webui' })).toContain('WebUI');
    // 库里没有「轮次取消」这一档，而启动扫描看得见的真实状态只有 expired 与「没人碰过」两种。
    expect(staleApprovalOutcome('expired')).toEqual({ kind: 'expired' });
    expect(staleApprovalOutcome('pending')).toEqual({ kind: 'stale' });
    expect(staleApprovalOutcome('approved')).toEqual({ kind: 'stale' });
  });

  it('Telegram 点了批准：正文当场换成结局，且只编辑一次', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('rewrite-telegram', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(post.text).toContain(COUNTDOWN);
    // 等回执句柄落地（`tg_message_id` 与 `ApprovalReceipt.settle` 是同一个 `.then` 里置上的）。
    // 真实点击必然在这之后 —— 人手最快也隔着一次网络往返。
    await waitForReceipt(db);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    expect(await running).toEqual({ ok: true });
    // 一次 editMessageText 而不是「撤键盘 + 改正文」两次：带正文的那条收尾先到，注册表那条不带
    // 正文的被 `#dismiss` 的去重挡掉。两次调用要在 `perChatPerMinute` 那 20 个槽位里排两回队。
    expect(channel.settled).toHaveLength(1);
    expect(channel.rewrites[0]).toBe(approvalSettledText('bash', { kind: 'approved', channel: 'telegram' }));
    expect(channel.rewrites[0]).not.toContain(COUNTDOWN);
    closeDatabase(db);
  });

  it('WebUI 抢先裁决：正文说的是「在 WebUI 裁的」，不是超时也不是 Telegram', async () => {
    const { db, broker, channel, registry, context } = brokerHarness('rewrite-webui', { webuiChannel: true, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    await waitForPost(channel);
    const id = (db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string }).id;
    expect(broker.decide(id, false, 'owner', 'webui')).toBe(true);
    expect(await running).toMatchObject({ ok: false });
    expect(channel.rewrites).toEqual([approvalSettledText('bash', { kind: 'denied', channel: 'webui' })]);
    closeDatabase(db);
  });

  it('TTL 到点：正文换成「窗口到点了」，而不是留着倒计时', async () => {
    // TTL 压到毫秒级 —— 判据是文案，不是时长。broker 读的是它自己那份 config，改 `turn.config` 没用。
    const { db, channel, registry, context } = brokerHarness('rewrite-expired', { webuiChannel: false, telegramUp: true, ttlMs: 50 });
    const running = registry.execute('bash', {}, context);
    await waitForPost(channel);
    expect(await running).toMatchObject({ ok: false, hint: expect.stringContaining('超时') });
    expect(channel.rewrites).toEqual([approvalSettledText('bash', { kind: 'expired' })]);
    closeDatabase(db);
  });

  it('轮次 abort：正文换成「这一轮被取消了」', async () => {
    const controller = new AbortController();
    const { db, channel, registry, context } = brokerHarness('rewrite-cancelled', { webuiChannel: false, telegramUp: true, abortSignal: controller.signal });
    const running = registry.execute('bash', {}, context);
    await waitForPost(channel);
    controller.abort();
    expect(await running).toMatchObject({ ok: false });
    // abort 那条路把行写成 `denied` + `decided_by='system'`，但对屏幕前的人这不是「被拒绝」。
    expect(channel.rewrites).toEqual([approvalSettledText('bash', { kind: 'cancelled' })]);
    expect(channel.rewrites[0]).toContain('这一轮被取消');
    closeDatabase(db);
  });

  it('改文案失败不影响审批本身 —— 消息可能早被用户删了', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('rewrite-throws', { webuiChannel: false, telegramUp: true });
    channel.settleThrows = true;
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    // 「回执失败不影响审批本身」同一条纪律：一次改文案绝不能把「等人批」变成「整轮失败」。
    expect(await running).toEqual({ ok: true });
    expect(db.prepare('SELECT state FROM approvals').pluck().get()).toBe('approved');
    closeDatabase(db);
  });

  /**
   * `request()` 那道闸判的是**放行那一刻**通道在不在。投递那一下才死掉时，这一刻语义上就是
   * 「没有裁决通道」—— 照旧等满 `ttlMs` 就是 `docs/reviews/20 §0.0` 裁决要消灭的那个形态换了个
   * 来路：白占 concurrency 槽、配额预留与 `turnTimeoutMs` 预算干等 180 秒，而屏幕上一个字都没有。
   */
  it('回执发不出去且没有 WebUI：当场拒，不干等 ttlMs', async () => {
    const { db, channel, registry, context } = brokerHarness('undeliverable', { webuiChannel: false, telegramUp: true });
    channel.postThrows = true;
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    // ttlMs 是 10 秒；这一条必须在毫秒级回来。
    expect(performance.now() - started).toBeLessThan(500);
    // 落 `expired` 而不是 `denied`：`denied + system` 在这张表里已经是「轮次被取消」的意思，
    // 而这一条压根没送到人眼前。说清缘由的是那条 `approval.unavailable` warn。
    expect(db.prepare('SELECT state,decided_by AS decidedBy,decision_channel AS channel FROM approvals').get())
      .toMatchObject({ state: 'expired', decidedBy: 'system', channel: 'system' });
    expect(db.prepare("SELECT data_json AS data FROM log_events WHERE kind='approval.unavailable'").pluck().get()).toContain('receipt_undeliverable');
    closeDatabase(db);
  });

  it('回执发不出去但 WebUI 还在：审批照旧等着，能被 WebUI 裁决', async () => {
    const { db, broker, channel, registry, context } = brokerHarness('undeliverable-webui', { webuiChannel: true, telegramUp: true });
    channel.postThrows = true;
    const running = registry.execute('bash', {}, context);
    // 「回执失败不影响审批本身」：Telegram 拒发不该把一次高危调用从「等人批」变成「整轮失败」，
    // 也不该把它当成「没有通道」—— 真通道（WebUI 的 SSE）还挂着。
    for (let round = 0; round < 60 && !db.prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'").pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    const id = (db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string }).id;
    expect(broker.decide(id, true, 'owner', 'webui')).toBe(true);
    expect(await running).toEqual({ ok: true });
    closeDatabase(db);
  });

  it('会话里点不动时不算一条 Telegram 通道：没有 WebUI 就当场拒，不挂 pending 行', async () => {
    const { db, channel, registry, context } = brokerHarness('undecidable', { webuiChannel: false, telegramUp: true });
    channel.decidableChats = new Set(['999']);
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    expect(performance.now() - started).toBeLessThan(100);
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toMatchObject({ count: 0 });
    expect(channel.posts).toEqual([]);
    closeDatabase(db);
  });
});
