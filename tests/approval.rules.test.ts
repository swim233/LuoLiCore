import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { DatabaseApprovalBroker, EventBus, LogSink, ToolRegistry, configSchema } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { z } from 'zod';

function harness(enabled = true, rules: unknown[] = [{ tool: 'bash', pattern: '(?i)\\brm\\s+-rf\\b', risk: 'high' }, { tool: 'mcp__*', risk: 'medium' }]) {
  const path = `./data/approval-${enabled}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled, ttlMs: 10_000, skipForOwner: true, rules } });
  const log = new LogSink(new OperationsRepository(db), './data/approval-logs');
  const broker = new DatabaseApprovalBroker(db, config, new EventBus(), log);
  const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 }, config.approval.rules);
  const turn = { turnId: 'turn-1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
  return { db, registry, context: { turn, workspace: './data', agentKind: 'main' as const } };
}

describe('approval rules', () => {
  it('executes always-approval tools directly when approval is disabled', async () => {
    const { db, registry, context } = harness(false);
    let executed = 0;
    registry.register({ name: 'delete_file', description: '', inputSchema: z.object({ path: z.string() }), policy: { minRole: 'trusted', approval: 'always', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('delete_file', { path: 'x' }, context)).toEqual({ ok: true });
    expect(executed).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM approvals').get() as { count: number }).count).toBe(0);
    closeDatabase(db);
  });

  // 审批交互没有可用通道（Telegram 那半从未实现，docs/20 · W-APPR-01）：命中规则的调用当场被拒，
  // 不再挂满 ttlMs 之后才拒。返回里必须带 hint，模型要靠它用自己的话解释这一步为什么没做。
  it('denies matching conditional rules immediately instead of hanging until the TTL', async () => {
    const { db, registry, context } = harness(true);
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    expect(await registry.execute('bash', { command: 'ls' }, context)).toEqual({ ok: true });
    const started = Date.now();
    const result = await registry.execute('bash', { command: 'rm -rf tmp' }, context) as { ok: boolean; error: string; hint?: string };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('未获批准');
    expect(result.hint).toContain('审批');
    const row = db.prepare("SELECT risk,state,decided_by AS decidedBy,decision_channel AS channel FROM approvals").get() as { risk: string; state: string; decidedBy: string; channel: string };
    expect(row).toMatchObject({ risk: 'high', state: 'denied', decidedBy: 'system', channel: 'none' });
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

  it('requires approval for unconditional wildcard rules', async () => {
    const { db, registry, context } = harness(true);
    let executed = 0;
    registry.register({ name: 'mcp__x__write', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'mcp' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('mcp__x__write', {}, context)).toMatchObject({ ok: false, error: '未获批准' });
    expect(executed).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='denied'").get() as { count: number }).count).toBe(1);
    closeDatabase(db);
  });

  it('requires approval for unconditional exact-name rules', async () => {
    const { db, registry, context } = harness(true, [{ tool: 'bash', risk: 'medium' }]);
    let executed = 0;
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => { executed += 1; return { ok: true }; } });
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false, error: '未获批准' });
    expect(executed).toBe(0);
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
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: false });
    config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: false, rules: [{ tool: 'bash', risk: 'high' }] } });
    registry.releaseTurn(turn.turnId);
    expect(await registry.execute('bash', {}, context)).toEqual({ ok: true });
    config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: true, rules: [] } });
    registry.releaseTurn(turn.turnId);
    expect(await registry.execute('bash', {}, context)).toEqual({ ok: true });
    closeDatabase(db);
  });
});
