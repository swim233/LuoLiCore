import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { DatabaseApprovalBroker, EventBus, LogSink, ToolRegistry, configSchema, newToolScope } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { z } from 'zod';

// 审批这一族的视角一律取 `lw`：`bash` / `delete_file` / `write_file` / MCP 那批工具全部下沉给
// worker 了，主 agent 视角下它们先撞 `tool_requires_worker`，根本走不到审批段。
function harness(enabled = true, rules: unknown[] = [{ tool: 'bash', pattern: '(?i)\\brm\\s+-rf\\b', risk: 'high' }, { tool: 'mcp__*', risk: 'medium' }], ttlMs = 10_000,
  receipts: Array<{ chatId: string; tool: string; risk: string; ttlMs: number }> = []) {
  const path = `./data/approval-${enabled}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled, ttlMs, skipForOwner: true, rules } });
  const log = new LogSink(new OperationsRepository(db));
  const events = new EventBus();
  // 这些用例都在问「有人能裁决时怎么走」，所以 harness 必须真的挂一条裁决通道（WebUI 的 SSE）。
  // 挂成普通订阅者的话，走的是「没有通道 → 当场拒绝」那条分支，测的就不是这些用例想测的东西了。
  events.subscribe(() => undefined, { channel: true });
  const broker = new DatabaseApprovalBroker(db, config, events, log, (pending) => { receipts.push({ chatId: pending.chatId, tool: pending.tool, risk: pending.risk, ttlMs: pending.ttlMs }); });
  const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
  const abort = new AbortController();
  const turn = { turnId: 'turn-1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
  return { db, broker, events, registry, abort, receipts, context: { turn, workspace: './data', agentKind: 'lw' as const, ...newToolScope() } };
}
function pendingApprovalId(db: ReturnType<typeof openDatabase>): string {
  const row: unknown = db.prepare("SELECT id FROM approvals WHERE state='pending'").get();
  if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') throw new Error('pending approval not found');
  return row.id;
}

describe('approval rules', () => {
  it('executes always-approval tools directly when approval is disabled', async () => {
    const { db, registry, context } = harness(false);
    let executed = 0;
    registry.register({ name: 'delete_file', description: '', inputSchema: z.object({ path: z.string() }), policy: { minRole: 'trusted', approval: 'always', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('delete_file', { path: 'x' }, context)).toEqual({ ok: true });
    expect(executed).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS count FROM approvals').get() as { count: number };
    expect(count.count).toBe(0);
    closeDatabase(db);
  });

  it('rejects immediately when no approval channel is connected', async () => {
    const path = './data/approval-unavailable.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, skipForOwner: true } });
    const events = new EventBus(); const log = new LogSink(new OperationsRepository(db));
    const sent: string[] = [];
    const broker = new DatabaseApprovalBroker(db, config, events, log, (pending) => { sent.push(pending.tool); });
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    const abort = new AbortController(); const turn = { turnId: 'turn-no-channel', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
    registry.register({ name: 'delete_file', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'always', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    // main.ts 里那个常驻的 config.changed 订阅者：它在，但它不会替谁点「批准」。判据数错对象
    // （subscriberCount 而不是 channelCount）的话，这一行就让当场拒绝变成死代码（docs/24 · R-APPR-01）。
    events.subscribe(() => undefined);
    const started = performance.now();
    expect(await registry.execute('delete_file', {}, { turn, workspace: '.', agentKind: 'lw', ...newToolScope() })).toMatchObject({ ok: false, hint: expect.stringContaining('没有可用的审批通道') });
    expect(performance.now() - started).toBeLessThan(100);
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toMatchObject({ count: 0 });
    // 没有裁决通道时也**不该发回执**：那一条本来就当场拒绝，再发一句「等 owner 批」是骗人。
    expect(sent).toEqual([]);
    closeDatabase(db);
  });

  it('waits for a decision once a real channel is connected', async () => {
    const path = './data/approval-channel.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, skipForOwner: true } });
    const events = new EventBus(); const log = new LogSink(new OperationsRepository(db));
    const sent: string[] = [];
    const broker = new DatabaseApprovalBroker(db, config, events, log, (pending) => { sent.push(pending.tool); });
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    const abort = new AbortController(); const turn = { turnId: 'turn-with-channel', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
    registry.register({ name: 'delete_file', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'always', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    events.subscribe(() => undefined, { channel: true });
    const pending = registry.execute('delete_file', {}, { turn, workspace: '.', agentKind: 'lw', ...newToolScope() });
    const row = db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string };
    expect(row).toBeTruthy();
    expect(broker.decide(row.id, true, 'owner', 'webui')).toBe(true);
    expect(await pending).toEqual({ ok: true });
    closeDatabase(db);
  });

  it('keeps a matching tool pending and resumes it only after approval', async () => {
    const { db, broker, events, registry, context } = harness(true);
    const emitted: string[] = [];
    events.subscribe((event) => emitted.push(event.type));
    let executed = 0;
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('bash', { command: 'ls' }, context)).toEqual({ ok: true });
    const result = registry.execute('bash', { command: 'rm -rf tmp' }, context);
    const row = db.prepare("SELECT id,risk,state FROM approvals WHERE state='pending'").get() as { id: string; risk: string; state: string };
    expect(row).toMatchObject({ risk: 'high', state: 'pending' });
    expect(emitted).toContain('approval.pending');
    expect(executed).toBe(1);
    expect(broker.decide(row.id, true, 'owner', 'webui')).toBe(true);
    expect(await result).toEqual({ ok: true });
    expect(executed).toBe(2);
    expect(db.prepare('SELECT state,decided_by AS decidedBy,decision_channel AS channel FROM approvals WHERE id=?').get(row.id)).toMatchObject({ state: 'approved', decidedBy: 'owner', channel: 'webui' });
    closeDatabase(db);
  });

  it('expires a pending request without executing its tool', async () => {
    const { db, registry, context } = harness(true, [{ tool: 'bash', risk: 'medium' }], 5);
    let executed = 0;
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, error: '未获批准', hint: expect.stringContaining('过期') });
    expect(executed).toBe(0);
    expect(db.prepare('SELECT state,decided_by AS decidedBy FROM approvals').get()).toMatchObject({ state: 'expired', decidedBy: 'system' });
    // rememberWithinTurn 只记布尔的话，同轮重试拿到的是「管理员已拒绝」——模型会把「没人来得及看」
    // 说成「被人拒了」。复用结论可以，复用错的理由不行。
    expect(await registry.execute('bash', {}, context)).toMatchObject({ hint: expect.stringContaining('过期') });
    expect(db.prepare("SELECT COUNT(*) AS count FROM approvals").get()).toMatchObject({ count: 1 });
    closeDatabase(db);
  });
  it('denies a pending request when its turn is cancelled', async () => {
    const { db, abort, registry, context } = harness(true, [{ tool: 'bash', risk: 'high' }]);
    let executed = 0;
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    const result = registry.execute('bash', {}, context);
    expect(pendingApprovalId(db)).toBeTruthy();
    abort.abort();
    expect(await result).toMatchObject({ ok: false, error: '未获批准', hint: expect.stringContaining('取消') });
    expect(executed).toBe(0);
    expect(db.prepare('SELECT state,decided_by AS decidedBy FROM approvals').get()).toMatchObject({ state: 'denied', decidedBy: 'system' });
    closeDatabase(db);
  });


  it('resets call budgets when a turn is released', async () => {
    const { db, registry, context } = harness(false);
    registry.register({ name: 'once', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'never', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    for (let index = 0; index < 10; index += 1) expect(await registry.execute('once', {}, context)).toEqual({ ok: true });
    expect(await registry.execute('once', {}, context)).toMatchObject({ ok: false, error: 'tool_call_limit_exceeded' });
    registry.releaseTurn(context.turn.turnId);
    expect(await registry.execute('once', {}, context)).toEqual({ ok: true });
    closeDatabase(db);
  });

  // 两条收窄都长在 `ToolExecutionContext` 上（per-run），而不是 turn 上：worker 与主轮共享同一个
  // turn 对象，写在 turn 上时一个 worker 载入带 `allowed-tools` 的 skill 会去收窄主轮。
  it('rechecks worker and skill allowlists during execution', async () => {
    const { db, registry, context } = harness(false);
    registry.register({ name: 'write_file', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'never', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    expect(await registry.execute('write_file', {}, { ...context, agentKind: 'lw', allow: new Set(['read_file']) })).toMatchObject({ ok: false, error: 'tool_not_in_allowlist' });
    context.skillAllowedTools.add('read_file');
    expect(await registry.execute('write_file', {}, context)).toMatchObject({ ok: false, error: 'tool_not_in_allowlist' });
    closeDatabase(db);
  });

  it('denies unconditional wildcard approvals through the decision channel', async () => {
    const { db, broker, registry, context } = harness(true);
    let executed = 0;
    registry.register({ name: 'mcp__x__write', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'mcp' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    const result = registry.execute('mcp__x__write', {}, context);
    const id = pendingApprovalId(db);
    expect(broker.decide(id, false, 'owner', 'webui')).toBe(true);
    expect(await result).toMatchObject({ ok: false, error: '未获批准' });
    expect(executed).toBe(0);
    const denied = db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='denied'").get() as { count: number };
    expect(denied.count).toBe(1);
    closeDatabase(db);
  });

  it('allows unconditional exact-name approvals after an explicit decision', async () => {
    const { db, broker, registry, context } = harness(true, [{ tool: 'bash', risk: 'medium' }]);
    let executed = 0;
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    const result = registry.execute('bash', {}, context);
    const id = pendingApprovalId(db);
    expect(broker.decide(id, true, 'owner', 'webui')).toBe(true);
    expect(await result).toEqual({ ok: true });
    expect(executed).toBe(1);
    closeDatabase(db);
  });

  // 审批策略里的开关必须跟着热重载走：出事时运维去 WebUI 关掉审批（或加一条规则），
  // 点了没用而界面说成功，是 docs/20 · W-CFG-02 里最要命的那一类。
  it('follows approval config and rules through a hot reload', async () => {
    const path = './data/approval-hot.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db));
    let config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, skipForOwner: true, rules: [{ tool: 'bash', risk: 'high' }] } });
    const events = new EventBus(); events.subscribe(() => undefined, { channel: true });
    const broker = new DatabaseApprovalBroker(db, () => config, events, log);
    const registry = new ToolRegistry(log, broker, () => ({ maxRegistered: 10, maxCallsPerTurn: 50, maxConsecutiveErrors: 3 }), () => config.approval.rules);
    const turn = { turnId: 'turn-hot', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
    const context = { turn, workspace: './data', agentKind: 'lw' as const, ...newToolScope() };
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const first = registry.execute('bash', {}, context);
    const firstId = pendingApprovalId(db);
    expect(broker.decide(firstId, false, 'owner', 'webui')).toBe(true);
    expect(await first).toMatchObject({ ok: false });
    config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: false, rules: [{ tool: 'bash', risk: 'high' }] } });
    registry.releaseTurn(turn.turnId);
    expect(await registry.execute('bash', {}, context)).toEqual({ ok: true });
    config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, rules: [] } });
    registry.releaseTurn(turn.turnId);
    expect(await registry.execute('bash', {}, context)).toEqual({ ok: true });
    closeDatabase(db);
  });

  /**
   * `docs/22 · D-APPR-01` 的最后一半：有裁决通道时这一轮会**静静挂满 `ttlMs`**（默认 180 秒），
   * 而 Telegram 那边一个字都没有 —— 用户看到的是 bot 收了消息然后沉默三分钟。
   * 回执必须在**插入 pending 行之后**发（先落库再通知，通知失败也不会留下一个没人知道的等待）。
   */
  it('挂起时给发起人发一条回执，且回执失败不影响审批本身', async () => {
    const { db, broker, registry, receipts, context } = harness();
    registry.register({ name: 'bash', description: 'x', inputSchema: z.object({ command: z.string() }),
      policy: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const running = registry.execute('bash', { command: 'rm -rf /tmp/x' }, context);
    // 等 pending 行落库 —— 回执是紧跟着它发的。
    for (let round = 0; round < 20 && !receipts.length; round += 1) await new Promise((settle) => setTimeout(settle, 5));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ chatId: '1', tool: 'bash', risk: 'high' });
    expect(receipts[0]!.ttlMs).toBeGreaterThan(0);
    // 回执发出去的时候 pending 行已经在库里了。
    expect(db.prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'").pluck().get()).toBe(1);
    broker.decide(pendingApprovalId(db), false, 'owner', 'webui');
    await running;
    closeDatabase(db);
  });

  it('回执回调抛异常时审批照常走完', async () => {
    const path = './data/approval-receipt-throws.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, ttlMs: 10_000, skipForOwner: true, rules: [{ tool: 'bash', always: true, risk: 'high' }] } });
    const log = new LogSink(new OperationsRepository(db));
    const events = new EventBus();
    events.subscribe(() => undefined, { channel: true });
    // 回执通道坏了（Telegram 拒发、bot 还没建起来）不该把审批带崩 —— 那会让一次高危调用
    // 从「等人批」变成「整轮失败」。
    const broker = new DatabaseApprovalBroker(db, config, events, log, () => { throw new Error('telegram 拒发'); });
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
    registry.register({ name: 'bash', description: 'x', inputSchema: z.object({ command: z.string() }),
      policy: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const abort = new AbortController();
    const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false,
      baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
    const running = registry.execute('bash', { command: 'anything' }, { turn, workspace: './data', agentKind: 'lw', ...newToolScope() });
    for (let round = 0; round < 40 && !db.prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'").pluck().get(); round += 1) await new Promise((settle) => setTimeout(settle, 5));
    broker.decide(pendingApprovalId(db), true, 'owner', 'webui');
    expect(await running).toMatchObject({ ok: true });
    closeDatabase(db);
  });
});
