import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

const broker: ApprovalBroker = { request: async () => true };
const events: Array<{ kind: string; summary: string }> = [];
const log = { span: () => ({ id: 'span', end: () => undefined }), event: (event: { kind: string; summary: string }) => events.push(event) } as unknown as LogSink;
const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner', isPrivate: true, baseCommitId: null,
  snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} } satisfies RuntimeTurnContext;
const context = { turn, workspace: '.', agentKind: 'main' as const };
const policy = { minRole: 'limited' as const, approval: 'never' as const, scope: 'global' as const, source: 'builtin' as const };
const limits = { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 2, defaultTimeoutMs: 80 };

// 一个不返回的工具会挂住整轮：AI SDK 的 toolMs 只是把一个 AbortSignal 递给 execute()，工具不认它
// 就等于没有超时。日志里那些「只有 turn.start 没有 turn.end」的轮次就是这么来的 —— 用户对着沉默
// 等到 concurrency.turnTimeoutMs（10 分钟）为止，而模型连一次失败结果都没收到。
describe('tool call timeout', () => {
  it('hands the model a failure instead of waiting forever, and survives the abandoned call rejecting later', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    let settle: ((value: object) => void) | null = null;
    let fail: ((error: Error) => void) | null = null;
    registry.register({ name: 'hangs', description: '', inputSchema: z.object({}), policy, sourcePriority: 1,
      execute: () => new Promise<object>((resolve, reject) => { settle = resolve; fail = reject; }) });
    const started = Date.now();
    const output = await registry.execute('hangs', {}, context) as { ok: boolean; error: string; hint?: string };
    expect(output.ok).toBe(false);
    expect(output.error).toBe('tool_timeout');
    expect(output.hint).toContain('80ms');
    expect(Date.now() - started).toBeLessThan(3000);
    // 放弃等待不等于取消执行（任意工具都取消不了）。晚到的拒绝必须已经被接住，
    // 否则一次工具超时就是一个 unhandledRejection —— 那会直接打崩进程。
    fail!(new Error('late'));
    settle!({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('leaves tools that own their deadline alone', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'slow', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: null,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, done: true }; } });
    expect(await registry.execute('slow', {}, context)).toEqual({ ok: true, done: true });
  });

  it('honours a per-tool budget that is longer than the default', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'upload', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 400,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, sent: 1 }; } });
    expect(await registry.execute('upload', {}, context)).toEqual({ ok: true, sent: 1 });
  });

  // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：混成一句 tool_unavailable
  // 时模型通常继续原地重试到步数耗尽，也没法如实告诉用户为什么做不到。
  it('tells the model why a tool went away after repeated failures', async () => {
    events.length = 0;
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'flaky', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 50,
      execute: () => ({ ok: false, error: 'upstream_down' }) });
    expect(await registry.execute('flaky', {}, context)).toEqual({ ok: false, error: 'upstream_down' });
    expect(await registry.execute('flaky', {}, context)).toEqual({ ok: false, error: 'upstream_down' });
    const blocked = await registry.execute('flaky', {}, context) as { error: string; hint: string };
    expect(blocked.error).toBe('tool_disabled_after_errors');
    expect(blocked.hint).toContain('2');
    expect(events.filter((event) => event.kind === 'tool.disabled_after_errors')).toHaveLength(1);
    expect(registry.activeNames('owner', context)).not.toContain('flaky');
  });

  it('resets the failure streak after a success', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    let calls = 0;
    registry.register({ name: 'mixed', description: '', inputSchema: z.object({}), policy, sourcePriority: 1,
      execute: () => { calls += 1; return calls === 2 ? { ok: true } : { ok: false, error: 'blip' }; } });
    await registry.execute('mixed', {}, context);
    await registry.execute('mixed', {}, context);
    expect(await registry.execute('mixed', {}, context)).toEqual({ ok: false, error: 'blip' });
    // 失败-成功-失败 只是 1 连败：停用的门槛是**连续**失败，不是一轮里失败的总次数。
    expect(registry.activeNames('owner', context)).toContain('mixed');
    await registry.execute('mixed', {}, context);
    expect(registry.activeNames('owner', context)).not.toContain('mixed');
  });
});
