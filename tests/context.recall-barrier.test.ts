import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, ScheduleRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, FileTools, LogSink, PathJail, ToolRegistry, configSchema, registerBuiltins } from '@luoli/core';
import type { Config } from '@luoli/core';
import type { ArchivedMessage } from '@luoli/db';

/**
 * `context.recallBarrier` —— 「清空上下文」到底清掉了什么。
 *
 * 实测的形态（logs/2026-08-19 · turn `01M0CKK6W018B5KS9613SNEX5J`）：WebUI 点了「清空上下文窗口」，
 * reset commit 确实落库（`window_start=575 > head_ordinal=574`，窗口为空），紧接着那一轮发给模型的
 * 请求也确实只有 2 条消息 —— 然后模型第一步就 `read_messages({direction:'before',limit:20})`
 * 把 20 条历史整段捞了回来，那份工具结果又作为 ordinal 577 落进新窗口，此后每一轮都带着它。
 * 归档表不受窗口约束，这是设计（`/new` 一条消息都不删），所以「清空是不是真的清了」是一个**开关**
 * 该回答的问题，而不是一个 bug。下面两组用例把开关的两档各钉一次。
 */

function harness(name: string, patch: Partial<Config> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const log = new LogSink(new OperationsRepository(db));
  const engine = new ContextEngine(db, archive, log);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' },
    context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20 } }, ...patch });
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  registerBuiltins(registry, { db, archive, context: engine, log, sandbox: { plan: () => ({ allowed: true }) },
    filesFor: (root: string) => new FileTools(new PathJail(root, []), 1000, 1000), maxWebBytes: 1000,
    schedule: { jobs: new ScheduleRepository(db), deliverable: () => false, runner: { register: () => true, unregister: () => true, nextRun: () => null } } } as never);
  const turn = { turnId: 'probe', key: 'chat:chat', chatId: 'chat', threadId: null, initiatorUserId: 'user', effectiveRole: 'owner',
    isPrivate: true, baseCommitId: null, config, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal };
  return { db, archive, engine, config, registry, context: { turn, workspace: './data', agentKind: 'main' } as never };
}

let nextTgId = 100;
function append(archive: ArchiveRepository, text: string, triggered: boolean): ArchivedMessage {
  nextTgId += 1;
  return archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: nextTgId, direction: 'in',
    fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text, tgDate: Date.now(),
    raw: {}, triggered, triggerReason: triggered ? 'private' : null });
}

async function runTurn(engine: ContextEngine, archive: ArchiveRepository, config: Readonly<Config>, text: string) {
  const trigger = append(archive, text, true);
  const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user',
    effectiveRole: 'owner', isPrivate: true, trigger, abortSignal: new AbortController().signal, config });
  engine.appendDelta(turn, { id: `answer-${trigger.id}`, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'ok' }] });
  await engine.commitTurn(turn);
  return turn;
}

/** 归档三工具都是 `untrustedOutput`，返回的是 `{ok, content}`，content 里是包了信封的那份 JSON。 */
const said = (result: object): string => JSON.stringify(result);

describe('context.recallBarrier', () => {
  it('清空时把归档水位记进 reset commit，而 /undo 撤回那次清空会一并解除隔断', async () => {
    const { db, archive, engine, config } = harness('recall-floor');
    await runTurn(engine, archive, config, 'alpha before');
    const last = await runTurn(engine, archive, config, 'alpha still before');
    expect(engine.recallFloor('chat:chat')).toBe(0);
    engine.reset('chat:chat', 'test');
    // 水位 = 清空那一刻归档里最大的 messages.id，也就是最后那条触发消息。
    expect(engine.recallFloor('chat:chat')).toBe(last.claimThroughMessageId);
    // 撤回那次清空 = HEAD 退到它之前，隔断随之解除（判据按 seq，见 `ContextRepository.recallFloor`）。
    expect(engine.undo('chat:chat')).not.toBeNull();
    expect(engine.recallFloor('chat:chat')).toBe(0);
    closeDatabase(db);
  });

  // 水位无条件记：开关是运行时的，而 commit 是不可变历史 —— 事后打开开关时补不回来。
  it('开关关着也照样记水位，只是没人用它', async () => {
    const { db, archive, engine, config, registry, context } = harness('recall-off');
    await runTurn(engine, archive, config, 'alpha before');
    engine.reset('chat:chat', 'test');
    expect(engine.recallFloor('chat:chat')).toBeGreaterThan(0);
    await runTurn(engine, archive, config, 'alpha after');
    // 这就是实测里那一幕：窗口空了，而 read_messages 把清空之前的话整段交回来。
    const read = said(await registry.execute('read_messages', { direction: 'before', limit: 20 }, context));
    expect(read).toContain('alpha before');
    expect(read).not.toContain('recallBarrier');
    closeDatabase(db);
  });

  it('开关开着时三个归档工具都只看得到清空之后的消息，并且说出自己被挡了', async () => {
    const { db, archive, engine, config, registry, context } = harness('recall-on', { context: { recallBarrier: true } } as Partial<Config>);
    const before = await runTurn(engine, archive, config, 'alpha before');
    engine.reset('chat:chat', 'test', { advanceClaims: true });
    const after = await runTurn(engine, archive, config, 'alpha after');
    const read = said(await registry.execute('read_messages', { direction: 'before', limit: 20 }, context));
    expect(read).toContain('alpha after');
    expect(read).not.toContain('alpha before');
    // 削短了就必须说出来，否则模型会把这段当成「本来就没有更早的了」（照 droppedTokenNote 的先例）。
    expect(read).toContain('recallBarrier');
    const searched = said(await registry.execute('search_messages', { query: 'alpha', limit: 20 }, context));
    expect(searched).toContain('alpha after');
    expect(searched).not.toContain('alpha before');
    // 被挡住的单条**不能**回 `message: null`：那和「这条不存在」长得一样，模型会换个 id 再试。
    // 三个工具都是 `untrustedOutput`，所以 `ok:false` 在信封上、`error` 在 `content` 里那份 JSON 上。
    const blocked = await registry.execute('get_message', { messageId: before.claimThroughMessageId }, context);
    expect(blocked).toMatchObject({ ok: false });
    expect(said(blocked)).toContain('recall_barrier');
    expect(said(await registry.execute('get_message', { messageId: after.claimThroughMessageId }, context))).toContain('alpha after');
    closeDatabase(db);
  });

  /**
   * 另一扇门：`claimBackground` 认的是 `contexts.claim_watermark` 到触发消息之间那一段，与窗口无关。
   * 不推水位的话，清空之前那些没人认领的群发言会在清空之后的第一轮进到新窗口里 —— 归档查不到、
   * 上下文里却读得到，自相矛盾。
   */
  it('开关开着时清空还把背景认领水位推到当下，关着时保持原样', async () => {
    const on = harness('recall-claims-on', { context: { recallBarrier: true } } as Partial<Config>);
    append(on.archive, 'background before', false);
    on.engine.reset('chat:chat', 'test', { advanceClaims: false });   // 先证明水位没被推时它会进来
    const leaked = await runTurn(on.engine, on.archive, on.config, 'trigger one');
    expect(leaked.delta.filter((message) => message.origin === 'background')).toHaveLength(1);
    closeDatabase(on.db);

    const barred = harness('recall-claims-barred', { context: { recallBarrier: true } } as Partial<Config>);
    append(barred.archive, 'background before', false);
    // contexts 行由第一轮的 `ensure()` 建出来，所以先跑一轮再清 —— 也正是真实时序。
    await runTurn(barred.engine, barred.archive, barred.config, 'trigger zero');
    append(barred.archive, 'background still before', false);
    barred.engine.reset('chat:chat', 'test', { advanceClaims: true });
    const clean = await runTurn(barred.engine, barred.archive, barred.config, 'trigger one');
    expect(clean.delta.filter((message) => message.origin === 'background')).toHaveLength(0);
    closeDatabase(barred.db);
  });

  /** RUNTIME 块那一行的判据（措辞在 `assembleMainPrompt`，渲染在 `runtimeBlock`）。 */
  it('清空之后的第一轮带 contextCleared，提交过一轮之后就没了', async () => {
    const { db, archive, engine, config } = harness('recall-cleared-flag');
    const first = await runTurn(engine, archive, config, 'alpha before');
    expect(first.contextCleared).toBeUndefined();
    engine.reset('chat:chat', 'test');
    const fresh = await runTurn(engine, archive, config, 'alpha after');
    expect(fresh.contextCleared).toBe(true);
    const later = await runTurn(engine, archive, config, 'alpha later');
    expect(later.contextCleared).toBeUndefined();
    closeDatabase(db);
  });
});
