import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { DatabaseApprovalBroker, EventBus, LogSink, PROMPT_CALLBACK_MAX_BYTES, PROMPT_MAX_OPTIONS, PROMPT_TEXT_MAX, PROMPT_TTL_GRACE_MS, PendingPrompts, ToolRegistry, configSchema, parsePromptToken, promptToken, type ApprovalOutcome, type PromptChannel, type PromptPost, type PromptRequest, type PromptTarget } from '@luoli/core';
import { approvalSettledText, promptAckText, staleApprovalOutcome } from '@luoli/telegram';
import type { RuntimeTurnContext } from '@luoli/shared';
import { z } from 'zod';

/**
 * 用例自行实现的 `PromptChannel`。它与既有的 `{ request: async () => true }` 桩、`telegram: null`
 * 属于同一类：接口由 core 定义，实现本就应当可替换（`docs/05 §6.1` 的注入形式），并非引入 mock 层。
 */
class TestChannel implements PromptChannel {
  readonly posts: PromptPost[] = [];
  readonly settled: PromptTarget[] = [];
  /** 每次收尾携带的正文，与 `settled` 一一对应。`undefined` 表示只撤销键盘、未修改正文。 */
  readonly rewrites: (string | undefined)[] = [];
  /** 置为真时 `settle()` 抛错，模拟消息已被用户删除。修改文案失败不应影响审批本身。 */
  settleThrows = false;
  /** 置为真时 `post()` 抛错，模拟 Telegram 拒收那条带按钮的回执（界面上没有任何显示）。 */
  postThrows = false;
  up = true;
  /** 该会话中是否可裁决。默认全部可裁决；置为一个集合即模拟 D9 把某些会话降到 owner 档之下。 */
  decidableChats: Set<string> | null = null;
  /** 投递挂起时使用：模拟消息尚在传输途中即被裁决。 */
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
/** 有效角色按 callback 所在的会话计算，因此点击者需携带 chatId（见 `resolve` 的会话绑定）。 */
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
    // 有意交叉：先点击后发起的那一条。
    expect(prompts.resolve(promptToken(second.promptId, 1), { ...OWNER, chatId: 'b' })).toMatchObject({ status: 'accepted', optionId: 'deny' });
    expect(prompts.resolve(promptToken(first.promptId, 0), { ...OWNER, chatId: 'a' })).toMatchObject({ status: 'accepted', optionId: 'approve' });
    expect(await first.outcome).toMatchObject({ status: 'chosen', optionId: 'approve', actor: 'user:1' });
    expect(await second.outcome).toMatchObject({ status: 'chosen', optionId: 'deny', actor: 'user:1' });
    // 两条键盘各撤销一次，分别作用于各自的消息。
    expect(channel.settled.map((target) => target.chatId).sort()).toEqual(['a', 'b']);
  });

  it('同一条消息点两次：第二次是「已经处理过了」而不是「已过期」', async () => {
    const prompts = new PendingPrompts(new TestChannel());
    const handle = prompts.ask(request());
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    expect(prompts.resolve(token, OWNER)).toMatchObject({ status: 'accepted' });
    // 已处理与已过期（进程曾重启）对点击者是两条不同的信息：前者说明已有人做出
    // 决定，后者说明该请求从未被处理。
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
  });

  it('查不到 promptId（进程重启过）与畸形 token 都回 unknown', () => {
    const prompts = new PendingPrompts(new TestChannel());
    // 注册表不持久化：Promise 无法跨进程，因此重启后的延迟点击必然进入这一分支。
    expect(prompts.resolve(promptToken('01JZZZZZZZZZZZZZZZZZZZZZZZ', 0), OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('c:turn-1', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc:', OWNER)).toEqual({ status: 'unknown' });
    expect(prompts.resolve('a:abc:x', OWNER)).toEqual({ status: 'unknown' });
    // 下标越界（选项被裁剪过，或有人手工构造 callback_data）不得读取到其他选项。
    expect(prompts.resolve(`a:abc:${PROMPT_MAX_OPTIONS}`, OWNER)).toEqual({ status: 'unknown' });
  });

  it('decidableBy=owner 时 trusted 点了不生效，等待者一动不动', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ decidableBy: 'owner', initiatorUserId: TRUSTED.userId }));
    await handle.posted;
    const token = promptToken(handle.promptId, 0);
    // 点击者即发起人，在 decidableBy=owner 之下这仍不足以放行（`approval.allowInitiator` 已永久移除，docs/14 A26）。
    expect(prompts.resolve(token, TRUSTED)).toEqual({ status: 'forbidden', required: 'owner' });
    // 越权的那次点击不消耗该提示：键盘仍然保留，owner 随后点击依然有效。
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
    // 该次点击仍视为已消耗：同一用户点击同一条消息，重复操作的结果不会改变。
    expect(prompts.resolve(token, OWNER)).toEqual({ status: 'settled' });
  });

  it('超时以 expired 收尾，宽限期排在发起方的 TTL 之后', async () => {
    vi.useFakeTimers();
    try {
      const channel = new TestChannel();
      const prompts = new PendingPrompts(channel);
      const handle = prompts.ask(request({ ttlMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1000);
      // TTL 的唯一所有者是发起方；该 timer 只负责撤销键盘，因此到点时它不应触发。
      expect(channel.settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(PROMPT_TTL_GRACE_MS + 1);
      expect(await handle.outcome).toEqual({ status: 'expired' });
      expect(channel.settled).toHaveLength(1);
      // 过期之后的点击不属于已处理：该请求从未被处理。
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
    // 非官方客户端可对任意消息构造 `callback_data`：不绑定会话时，用户在自己为 owner 的群中
    // 即可替另一个会话裁决，而那条 role 是按他所在的群计算的。
    expect(prompts.resolve(token, { ...OWNER, chatId: '-999' })).toEqual({ status: 'unknown' });
    expect(channel.settled).toEqual([]);
    expect(prompts.resolve(token, OWNER)).toMatchObject({ status: 'accepted' });
  });

  it('提示还挂着但下标上没有选项 → invalid，键盘一个字节都不动', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request());
    await handle.posted;
    // 只有伪造的 `callback_data` 才会到达这里。若按 unknown 处理，调用方会顺带撤销键盘，
    // 一次伪造即可让一条有效提示在 Telegram 侧失效。
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
    // `dispose()` 的约定是不撤销（那几次编辑会被随后的 bot.stop() 中断）。若只检查 settled
    // 而不检查 dismiss 意图，投递完成后就会立即撤销，导致约定存在却未被遵守。
    expect(channel.settled).toEqual([]);
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
  });

  it('callback_data 不越过 Bot API 的 64 字节上界', () => {
    const prompts = new PendingPrompts(new TestChannel());
    const handle = prompts.ask(request({ options: Array.from({ length: PROMPT_MAX_OPTIONS }, (_unused, index) => ({ id: `option-${index}`, label: `选项 ${index}` })) }));
    for (let index = 0; index < PROMPT_MAX_OPTIONS; index += 1) {
      const token = promptToken(handle.promptId, index);
      // 超限时 Telegram 直接返回 400，而此时按钮已显示在界面上，因此断言的是字节数而非字符数。
      expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(PROMPT_CALLBACK_MAX_BYTES);
      expect(parsePromptToken(token)).toEqual({ promptId: handle.promptId, index });
    }
  });

  it('正文硬截断，且选项超上限时被砍掉', async () => {
    const channel = new TestChannel();
    const prompts = new PendingPrompts(channel);
    const handle = prompts.ask(request({ text: 'x'.repeat(PROMPT_TEXT_MAX + 400), options: Array.from({ length: PROMPT_MAX_OPTIONS + 3 }, (_unused, index) => ({ id: `o${index}`, label: `l${index}` })) }));
    await handle.posted;
    // 键盘附加在一条消息上：正文过长时应截断，不能交给 `segmentTelegramText` 切成两条，否则其中一条没有按钮。
    expect(channel.posts[0]!.text).toHaveLength(PROMPT_TEXT_MAX);
    expect(channel.posts[0]!.buttons).toHaveLength(PROMPT_MAX_OPTIONS);
  });
});

/** 回执正文中的倒计时提示。任何一种结束方式之后它都不应继续显示（`AC-APV-004`）。 */
const COUNTDOWN = '秒内未处理将自动拒绝';

/** 发起人会话里那条纯文本报信。它没有 `settle` 句柄，因此正文里一个状态字都不能有。 */
const NOTICE_HANDOFF = '已请求 owner 批准，结果随本轮回复给出。';
const NOTICE_WEBUI = '需 owner 在 WebUI 审批页批准。';

/**
 * `options.ownerChat` 为真时那一轮跑在 owner 私聊里（`chatId === bootstrapOwnerId`），
 * 否则跑在群 `-100` 里 —— 后者是默认形态：按钮发往 owner 私聊 `1`，群里只留一条报信。
 */
function brokerHarness(name: string, options: { webuiChannel: boolean; telegramUp: boolean; abortSignal?: AbortSignal; ttlMs?: number; ownerChat?: boolean }) {
  const path = `./data/prompts-${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  // owner 私聊那一档的有效角色就是 owner，`skipForOwner` 开着的话根本走不到审批
  // （生产里的同形路径是 ACP 的 `exemptOwnerSkip`，它反向豁免的正是这个开关）。
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, ttlMs: options.ttlMs ?? 10_000, skipForOwner: !options.ownerChat, rules: [{ tool: 'bash', always: true, risk: 'high' }] } });
  const log = new LogSink(new OperationsRepository(db), './data/prompts-logs');
  const events = new EventBus();
  if (options.webuiChannel) events.subscribe(() => undefined, { channel: true });
  const channel = new TestChannel();
  channel.up = options.telegramUp;
  const prompts = new PendingPrompts(channel, log);
  /** 发往发起人会话的纯文本消息（`main.ts` 里是 `bot.api.sendMessage`，此处没有 bot）。 */
  const notices: { chatId: string; text: string }[] = [];
  const broker: DatabaseApprovalBroker = new DatabaseApprovalBroker(db, config, events, log, async (pending) => {
    // 与 `main.ts` 的接线一致：带按钮的那条发 owner 私聊（群内有效角色封顶 trusted，群里的按钮
    // 谁都点不动），发起人会话只留一条不带倒计时的报信。
    const target = config.access.bootstrapOwnerId || pending.chatId;
    const sameChat = target === pending.chatId;
    if (!prompts.available(target)) {
      notices.push({ chatId: pending.chatId, text: `${pending.tool} ${NOTICE_WEBUI}${Math.round(pending.ttlMs / 1000)} ${COUNTDOWN}` });
      return;
    }
    if (!sameChat) notices.push({ chatId: pending.chatId, text: `${pending.tool} ${NOTICE_HANDOFF}` });
    const handle = prompts.ask({ kind: 'approval', chatId: target, threadId: sameChat ? pending.threadId : null, decidableBy: 'owner', initiatorUserId: pending.requesterUserId,
      text: `${pending.tool} 要批准，${Math.round(pending.ttlMs / 1000)} ${COUNTDOWN}`, options: [{ id: 'approve', label: '批准' }, { id: 'deny', label: '拒绝' }], ttlMs: pending.ttlMs,
      claim: (optionId, actor) => broker.decide(pending.id, optionId === 'approve', actor, 'telegram') });
    const posted = await handle.posted;
    // owner 私聊发不出去（403）时不改往群里贴按钮 —— 那儿点不动 —— 只补一条说清去哪儿。
    if (!posted && !sameChat) notices.push({ chatId: pending.chatId, text: `${pending.tool} ${NOTICE_WEBUI}${Math.round(pending.ttlMs / 1000)} ${COUNTDOWN}` });
    // `settle` 撤销键盘并把正文替换为结果，返回该次编辑是否实际生效；发送失败时报告
    // `delivered: false`，由 broker 两侧共同判断是否还有其他通道。`tgChatId` 与 `tgMessageId` 同写：
    // 回执落在 owner 私聊，而 `approvals.chat_id` 记的是发起人会话。
    return posted
      ? { tgChatId: posted.chatId, tgMessageId: posted.messageId, settle: (outcome) => prompts.dismiss(posted, approvalSettledText(pending.tool, outcome)) }
      : { delivered: false };
  }, prompts);
  const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
  registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
  const chatId = options.ownerChat ? '1' : '-100';
  const turn = { turnId: `turn-${name}`, key: `chat:${chatId}`, chatId, threadId: null, initiatorUserId: options.ownerChat ? '1' : '7', effectiveRole: options.ownerChat ? 'owner' : 'trusted', isPrivate: Boolean(options.ownerChat),
    ...(options.ownerChat ? {} : { chatTitle: '开发群' }),
    baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: options.abortSignal ?? new AbortController().signal, config } satisfies RuntimeTurnContext;
  return { db, broker, prompts, channel, registry, notices, context: { turn, workspace: './data', agentKind: 'main' as const } };
}
async function waitForPost(channel: TestChannel): Promise<PromptPost> {
  for (let round = 0; round < 60 && !channel.posts.length; round += 1) await new Promise((settle) => setTimeout(settle, 5));
  if (!channel.posts.length) throw new Error('prompt was never posted');
  return channel.posts[0]!;
}
/** 回执句柄生效：`tg_message_id` 与 `ApprovalReceipt.settle` 在同一个 `.then` 中设置。 */
async function waitForReceipt(db: ReturnType<typeof openDatabase>): Promise<void> {
  const count = db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL');
  for (let round = 0; round < 60 && !count.pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
}
/** 待办列已清除。清列在收尾生效之后执行，因此判据是延迟检查而非立即检查。 */
async function receiptsPending(db: ReturnType<typeof openDatabase>): Promise<number> {
  const count = db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL');
  for (let round = 0; round < 40 && count.pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
  return Number(count.pluck().get());
}

/** 按钮落在 owner 私聊（chatId 即 owner 的 userId `1`），而 `resolve` 绑定的正是那个会话。 */
const OWNER_IN_TURN = { ...OWNER, chatId: '1' };
/** 同一个会话上的 trusted 点击：`decidableBy:'owner'` 不认角色以外的任何东西。 */
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

  /**
   * 群内的有效角色封顶 `trusted`，`decidableBy:'owner'` 在任何群里都无人可满足 —— 贴在群里的
   * 按钮既点不动，又会被 `resolve()` 的会话绑定判成 unknown。带按钮的那条因此发 owner 私聊，
   * 发起人会话只留一条报信；而那条报信没有 `settle` 句柄，收场时无人回来改它，所以正文里
   * 一个倒计时字都不能有（写了就是 `docs/21 §12` 那类「界面在说谎」）。
   */
  it('按钮贴到 owner 私聊，发起人群里只留一条不带倒计时的报信', async () => {
    const { db, channel, prompts, registry, notices, context } = brokerHarness('to-owner-dm', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(channel.posts.map((entry) => entry.chatId)).toEqual(['1']);
    expect(notices).toEqual([{ chatId: '-100', text: `bash ${NOTICE_HANDOFF}` }]);
    expect(notices[0]!.text).not.toContain(COUNTDOWN);
    // 投递目标即裁决绑定（`waiter.request.chatId === actor.chatId`）：群里拿同一个 token 点不动。
    expect(prompts.resolve(post.buttons[0]!.token, { ...OWNER, chatId: '-100' })).toEqual({ status: 'unknown' });
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted', optionId: 'approve' });
    expect(await running).toEqual({ ok: true });
    closeDatabase(db);
  });

  it('owner 自己私聊里触发时只发一条，不再对着同一个屏幕报一次信', async () => {
    const { db, channel, prompts, registry, notices, context } = brokerHarness('owner-dm-only', { webuiChannel: false, telegramUp: true, ownerChat: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(post.chatId).toBe('1');
    // 投递目标与发起人会话是同一个，报信那条会把同一件事在同一个屏幕上说两遍。
    expect(notices).toEqual([]);
    expect(channel.posts).toHaveLength(1);
    expect(prompts.resolve(post.buttons[1]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted', optionId: 'deny' });
    expect(await running).toMatchObject({ ok: false, error: '未获批准' });
    closeDatabase(db);
  });

  /**
   * owner 从没跟 bot 说过话时 Telegram 拒发私聊（403）。改往群里贴按钮不是退路 —— 那儿谁都
   * 点不动 —— 因此只补一句去哪儿处理，投递侧照旧交回 `delivered: false`，由
   * `#receiptUndeliverable` 在无 WebUI 通道时当场落定（`AC-APV-012` ① 的形状不变，只是投递
   * 目标换成了私聊）。
   */
  it('owner 私聊发不出去：不改往群里贴按钮，当场拒并落 expired', async () => {
    const { db, channel, registry, notices, context } = brokerHarness('dm-undeliverable', { webuiChannel: false, telegramUp: true });
    channel.postThrows = true;
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    // ttlMs 为 10 秒；本条必须在毫秒级返回。
    expect(performance.now() - started).toBeLessThan(500);
    expect(channel.posts.map((entry) => entry.chatId)).toEqual(['1']);
    expect(notices.map((entry) => entry.chatId)).toEqual(['-100', '-100']);
    expect(notices[1]!.text).toContain(NOTICE_WEBUI);
    expect(db.prepare('SELECT state,decided_by AS decidedBy,decision_channel AS channel FROM approvals').get())
      .toMatchObject({ state: 'expired', decidedBy: 'system', channel: 'system' });
    expect(db.prepare("SELECT data_json AS data FROM log_events WHERE kind='approval.unavailable'").pluck().get()).toContain('receipt_undeliverable');
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
   * 一次点击返回给点击者的提示（`AC-APV-002`）。原先此处还有一条「你是 owner 但在这个会话里不是」
   * 的分支（`promptDeniedByChat`），它随审批按钮改发 owner 私聊一并摘除：按钮只落在 owner 私聊，
   * 而私聊的有效角色就是用户自身的角色，那一情形已构造不出来。
   */
  it('越权点击的回话逐档可分辨', () => {
    expect(promptAckText({ status: 'forbidden', required: 'owner' })).toEqual({ text: '仅 owner 可裁决该请求。', show_alert: true });
    // 已处理与已过期（进程曾重启）对点击者是两条不同的信息。
    expect(promptAckText({ status: 'settled' }).text).not.toBe(promptAckText({ status: 'unknown' }).text);
    // 成功时使用轻量提示：弹窗会让每一次正常裁决多出一步点击。
    expect(promptAckText({ status: 'accepted', kind: 'approval', optionId: 'approve', label: '批准' })).toEqual({ text: '已批准' });
    for (const status of ['settled', 'invalid', 'stale', 'unknown'] as const) expect(promptAckText({ status }).show_alert).toBe(true);
  });

  it('WebUI 抢先裁决时 Telegram 那两个按钮当场消失，迟到的点击回 stale', async () => {
    const { db, broker, channel, prompts, registry, context } = brokerHarness('raced', { webuiChannel: true, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    const id = (db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string }).id;
    // `UPDATE … WHERE state='pending' AND expires_at>?` 是两条通道之间唯一的原子竞争点。
    expect(broker.decide(id, false, 'owner', 'webui')).toBe(true);
    expect(await running).toMatchObject({ ok: false, error: '未获批准' });
    // 裁决完成时那两个按钮必须立即消失，保留即会导致后续误触。
    expect(channel.settled).toHaveLength(1);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toEqual({ status: 'stale' });
    expect(db.prepare('SELECT decision_channel AS channel FROM approvals WHERE id=?').get(id)).toMatchObject({ channel: 'webui' });
    closeDatabase(db);
  });

  /**
   * 键盘所在的会话与 `approvals.chat_id` 不再是同一个：按钮发 owner 私聊，而那一列记的是发起人
   * 会话（审计要回答「这次调用发生在哪」）。扫描取 `chat_id` 的话，撤键盘会拿群 id 配私聊的
   * message_id —— 全部 400，上一次进程留下的那排按钮永远点得动。回落 `COALESCE` 守的是迁移
   * `0016` 之前写下的行：它们没有 `tg_chat_id`，当初的投递目标正是 `chat_id`。
   */
  it('staleKeyboards 取的是键盘真正所在的会话，旧行回落到 chat_id', async () => {
    const { db, broker, channel, prompts, registry, context } = brokerHarness('stale-keyboard', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    await waitForReceipt(db);
    const row = db.prepare('SELECT chat_id AS chatId,tg_chat_id AS tgChatId,tg_message_id AS messageId FROM approvals').get() as { chatId: string; tgChatId: string; messageId: number };
    // 前提：这一行两个会话确实不同，否则下面那条断言恒真。
    expect(row).toMatchObject({ chatId: '-100', tgChatId: '1' });
    // 迁移之前留下的一行：`tg_chat_id` 为 NULL，投递目标就是 `chat_id` 本身。
    db.prepare("INSERT INTO approvals(id,turn_id,chat_id,requester_user_id,tool_name,input_json,risk,state,tg_message_id,requested_at,expires_at) VALUES ('legacy','turn-legacy','-200','7','bash','{}','high','expired',77,0,0)").run();
    // 一次进程重启：注册表清空（Promise 无法跨进程），界面上那排按钮由本次扫描处理。
    const restarted = new PendingPrompts(channel);
    const targets = broker.staleKeyboards();
    // 同时读取 state 与 tool：正文要替换为当时的实际结果，而非统一替换为同一句。
    expect([...targets].sort((left, right) => left.messageId - right.messageId)).toEqual([
      { chatId: '-200', messageId: 77, state: 'expired', tool: 'bash' },
      { chatId: '1', messageId: row.messageId, state: 'pending', tool: 'bash' },
    ]);
    for (const target of targets) restarted.dismiss(target, approvalSettledText(target.tool, staleApprovalOutcome(target.state)));
    expect(channel.settled).toContainEqual({ chatId: '1', messageId: row.messageId, state: 'pending', tool: 'bash' });
    // 读取后清列：不清理时每次重启都会重复编辑同一批历史消息。
    expect(broker.staleKeyboards()).toEqual([]);
    prompts.resolve(post.buttons[1]!.token, OWNER_IN_TURN);
    await running;
    closeDatabase(db);
  });

  /**
   * 上一条用例中 `staleKeyboards()` 已清空整列，因此在那里断言裁决后为空是恒真的：
   * 删除 `finish` 中的清列语句后用例仍会通过。本条不调用 `staleKeyboards`，只检查裁决本身。
   */
  it('裁决落定时 tg_message_id 就该清掉，不留到下次启动', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('clear-on-decide', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    for (let round = 0; round < 60 && !db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL').pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE tg_message_id IS NOT NULL').get()).toMatchObject({ count: 1 });
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    expect(await running).toEqual({ ok: true });
    // 该列记录的是仍显示在界面上的键盘：键盘已撤销时该列不应保留。若长时间运行的进程保留每一条审批，
    // 下次启动会逐条重新编辑，与真实投递争抢 `perChatPerMinute` 的槽位。
    expect(await receiptsPending(db)).toBe(0);
    closeDatabase(db);
  });

  /**
   * 清列的前提是收尾确实生效。该列是待办队列而非历史记录（`docs/03` 的 `approvals` 段），
   * 因此那次 `editMessageText` 未返回即表示这一条尚未完成，需留给下次启动的 `staleKeyboards()` 处理。
   * 提前清理的表现是：消息被删除、网络抖动或 429 各发生一次后，那排按钮就永久无人处理；关停竞态
   * （`dispose()` 之后的 `abortAll()`）只是其中一种来源，并非唯一来源。
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
    // 编辑抛错时界面上那排按钮仍然存在，因此该行仍属于待办。
    expect(await receiptsPending(db)).toBe(1);
    // 且下一次启动的扫描确实能取回它，否则留给下次启动只是一句空话。
    expect(broker.staleKeyboards().map((row) => row.messageId)).toEqual([messageId]);
    closeDatabase(db);
  });

  /**
   * `AC-APV-004` 的两个部分。让一句 N 秒内未处理将自动拒绝停留在已不成立的状态上，正属于
   * `docs/21 §12` 界面与实际不符所清理的那一类，因此撤销键盘的同时把正文替换为结果，且在同一次
   * 编辑中完成（拆成两次调用会在 `perChatPerMinute` 的 20 个槽位中排队两轮）。
   */
  it('五种收场的回执文案互不相同，一句都不再写倒计时', () => {
    const outcomes: ApprovalOutcome[] = [{ kind: 'approved', channel: 'telegram' }, { kind: 'approved', channel: 'webui' },
      { kind: 'denied', channel: 'telegram' }, { kind: 'denied', channel: 'webui' }, { kind: 'expired' }, { kind: 'cancelled' }, { kind: 'stale' }];
    const texts = outcomes.map((outcome) => approvalSettledText('bash', outcome));
    // Telegram 点击、WebUI 裁决、超时、轮次取消、进程重启对用户而言是五件不同的事。
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) {
      expect(text).not.toContain(COUNTDOWN);
      expect(text).toContain('bash');
      // `decided_by` 现有两种格式（`user:<tgId>` 与 `owner`）：一串 Telegram id 对群内其他人
      // 没有意义，还会泄漏 owner 的 id。文案一律表述为 channel。
      expect(text).not.toContain('user:');
      expect(text).not.toMatch(/（owner ）/);
    }
    expect(approvalSettledText('bash', { kind: 'approved', channel: 'telegram' })).toContain('Telegram');
    expect(approvalSettledText('bash', { kind: 'approved', channel: 'webui' })).toContain('WebUI');
    // 数据库中没有轮次取消这一档位，启动扫描能观察到的真实状态只有 expired 与未处理两种。
    expect(staleApprovalOutcome('expired')).toEqual({ kind: 'expired' });
    expect(staleApprovalOutcome('pending')).toEqual({ kind: 'stale' });
    expect(staleApprovalOutcome('approved')).toEqual({ kind: 'stale' });
  });

  it('Telegram 点了批准：正文当场换成结局，且只编辑一次', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('rewrite-telegram', { webuiChannel: false, telegramUp: true });
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(post.text).toContain(COUNTDOWN);
    // 等待回执句柄生效（`tg_message_id` 与 `ApprovalReceipt.settle` 在同一个 `.then` 中设置）。
    // 真实点击必然在此之后，因为人工操作至少需要一次网络往返。
    await waitForReceipt(db);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    expect(await running).toEqual({ ok: true });
    // 一次 editMessageText 而非撤销键盘与修改正文两次：带正文的收尾先到达，注册表中不带
    // 正文的那条被 `#dismiss` 的去重拦截。两次调用会在 `perChatPerMinute` 的 20 个槽位中排队两轮。
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
    // TTL 缩短到毫秒级：判据是文案而非时长。broker 读取的是自身的 config，修改 `turn.config` 无效。
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
    // abort 路径会把该行写为 `denied` 且 `decided_by='system'`，但对用户而言这并非被拒绝。
    expect(channel.rewrites).toEqual([approvalSettledText('bash', { kind: 'cancelled' })]);
    expect(channel.rewrites[0]).toContain('本轮被取消');
    closeDatabase(db);
  });

  it('改文案失败不影响审批本身 —— 消息可能早被用户删了', async () => {
    const { db, channel, prompts, registry, context } = brokerHarness('rewrite-throws', { webuiChannel: false, telegramUp: true });
    channel.settleThrows = true;
    const running = registry.execute('bash', {}, context);
    const post = await waitForPost(channel);
    expect(prompts.resolve(post.buttons[0]!.token, OWNER_IN_TURN)).toMatchObject({ status: 'accepted' });
    // 与回执失败不影响审批本身同一约束：一次文案修改不得把等待审批变成整轮失败。
    expect(await running).toEqual({ ok: true });
    expect(db.prepare('SELECT state FROM approvals').pluck().get()).toBe('approved');
    closeDatabase(db);
  });

  /**
   * `request()` 那道闸判定的是放行时刻通道是否存在。若在投递时才失效，此刻在语义上即
   * 不存在裁决通道；仍然等满 `ttlMs` 就是 `docs/reviews/20 §0.0` 要消除的形态的另一种来源：
   * 占用 concurrency 槽、配额预留与 `turnTimeoutMs` 预算空等 180 秒，而界面上没有任何显示。
   */
  it('回执发不出去且没有 WebUI：当场拒，不干等 ttlMs', async () => {
    const { db, channel, registry, context } = brokerHarness('undeliverable', { webuiChannel: false, telegramUp: true });
    channel.postThrows = true;
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    // ttlMs 为 10 秒；本条必须在毫秒级返回。
    expect(performance.now() - started).toBeLessThan(500);
    // 记为 `expired` 而非 `denied`：`denied` 加 `system` 在该表中已表示轮次被取消，
    // 而本条从未送达用户。说明原因的是那条 `approval.unavailable` warn。
    expect(db.prepare('SELECT state,decided_by AS decidedBy,decision_channel AS channel FROM approvals').get())
      .toMatchObject({ state: 'expired', decidedBy: 'system', channel: 'system' });
    expect(db.prepare("SELECT data_json AS data FROM log_events WHERE kind='approval.unavailable'").pluck().get()).toContain('receipt_undeliverable');
    closeDatabase(db);
  });

  it('回执发不出去但 WebUI 还在：审批照旧等着，能被 WebUI 裁决', async () => {
    const { db, broker, channel, registry, context } = brokerHarness('undeliverable-webui', { webuiChannel: true, telegramUp: true });
    channel.postThrows = true;
    const running = registry.execute('bash', {}, context);
    // 回执失败不影响审批本身：Telegram 拒绝发送不应把一次高风险调用从等待审批变成整轮失败，
    // 也不应判定为没有通道，因为真实通道（WebUI 的 SSE）仍然连接着。
    for (let round = 0; round < 60 && !db.prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'").pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    const id = (db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string }).id;
    expect(broker.decide(id, true, 'owner', 'webui')).toBe(true);
    expect(await running).toEqual({ ok: true });
    closeDatabase(db);
  });

  /**
   * 闸探的是**按钮落地的那个会话**（owner 私聊），不是发起人会话 —— 按发起人会话探等于判定一个
   * 不会收到按钮的地方，仍会挂上一条无人可点的 pending 行再空等满 ttlMs。
   */
  it('owner 私聊点不动时不算一条 Telegram 通道：没有 WebUI 就当场拒，不挂 pending 行', async () => {
    const { db, channel, registry, context } = brokerHarness('undecidable', { webuiChannel: false, telegramUp: true });
    // 发起人会话「可裁决」也不作数：这里刻意只放行 -100，而按钮发往 1。
    channel.decidableChats = new Set(['-100']);
    const started = performance.now();
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    expect(performance.now() - started).toBeLessThan(100);
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toMatchObject({ count: 0 });
    expect(channel.posts).toEqual([]);
    closeDatabase(db);
  });
});
