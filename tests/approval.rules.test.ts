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

  it('creates pending approval only for matching conditional rules', async () => {
    const { db, registry, context } = harness(true);
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    expect(await registry.execute('bash', { command: 'ls' }, context)).toEqual({ ok: true });
    const pending = registry.execute('bash', { command: 'rm -rf tmp' }, context);
    const row = db.prepare("SELECT id,risk,state FROM approvals WHERE state='pending'").get() as { id: string; risk: string; state: string };
    db.prepare("UPDATE approvals SET state='approved' WHERE id=?").run(row.id);
    expect(await pending).toEqual({ ok: true });
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
    registry.register({ name: 'mcp__x__write', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'mcp' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const pending = registry.execute('mcp__x__write', {}, context);
    const row = db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string };
    db.prepare("UPDATE approvals SET state='approved' WHERE id=?").run(row.id);
    expect(await pending).toEqual({ ok: true });
    closeDatabase(db);
  });

  it('requires approval for unconditional exact-name rules', async () => {
    const { db, registry, context } = harness(true, [{ tool: 'bash', risk: 'medium' }]);
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const pending = registry.execute('bash', {}, context);
    const row = db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as { id: string };
    db.prepare("UPDATE approvals SET state='approved' WHERE id=?").run(row.id);
    expect(await pending).toEqual({ ok: true });
    closeDatabase(db);
  });
});
