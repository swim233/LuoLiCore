import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { DatabaseApprovalBroker, EventBus, LogSink, ToolRegistry, configSchema } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { z } from 'zod';

function harness(enabled = true, rules: unknown[] = [{ tool: 'bash', pattern: '(?i)\\brm\\s+-rf\\b', risk: 'high' }, { tool: 'mcp__*', risk: 'medium' }], ttlMs = 10_000) {
  const path = `./data/approval-${enabled}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled, ttlMs, skipForOwner: true, rules } });
  const log = new LogSink(new OperationsRepository(db), './data/approval-logs');
  const events = new EventBus();
  const broker = new DatabaseApprovalBroker(db, config, events, log);
  const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
  const abort = new AbortController();
  const turn = { turnId: 'turn-1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
  return { db, broker, events, registry, abort, context: { turn, workspace: './data', agentKind: 'main' as const } };
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
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db), './data/approval-logs');
    let config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, skipForOwner: true, rules: [{ tool: 'bash', risk: 'high' }] } });
    const broker = new DatabaseApprovalBroker(db, () => config, new EventBus(), log);
    const registry = new ToolRegistry(log, broker, () => ({ maxRegistered: 10, maxCallsPerTurn: 50, maxConsecutiveErrors: 3 }), () => config.approval.rules);
    const turn = { turnId: 'turn-hot', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
    const context = { turn, workspace: './data', agentKind: 'main' as const };
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
});
