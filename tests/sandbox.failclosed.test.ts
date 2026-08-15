import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Sandbox, ToolRegistry } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

const broker: ApprovalBroker = { request: async () => true };
const log = { span: () => ({ id: 'span', end: () => undefined }) } as unknown as LogSink;
const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} } satisfies RuntimeTurnContext;
const sandboxConfig = { mode: 'none' as const, bypassRoles: ['owner' as const], dockerBin: 'docker', image: 'none', network: 'none' as const, memoryMb: 128, cpus: 1, pidsLimit: 8, readOnlyRoot: true, tmpfsMb: 8, defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024 };

describe('sandbox fail-closed visibility', () => {
  it('hides execution tools from trusted roles while preserving owner bypass', () => {
    const sandbox = new Sandbox(sandboxConfig);
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, available: (role, context) => sandbox.plan(role, context.workspace).allowed, execute: () => ({ ok: true }) });
    const context = { turn, workspace: '.', agentKind: 'main' as const };
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(registry.activeNames('owner', { ...context, turn: { ...turn, effectiveRole: 'owner' } })).toContain('bash');
  });

  it('hides Docker execution tools when Docker is known unavailable', () => {
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker' }, false);
    expect(sandbox.plan('trusted').allowed).toBe(false);
    expect(sandbox.plan('owner').allowed).toBe(true);
  });

  it('records a failed Docker binary probe and remains fail closed', async () => {
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker', dockerBin: 'definitely-missing-docker' });
    const result = await sandbox.probe();
    expect(result.available).toBe(false);
    expect(sandbox.plan('trusted').allowed).toBe(false);
  });
});
