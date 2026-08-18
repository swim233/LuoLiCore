import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, ContextRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, configSchema } from '@luoli/core';
import type { Config } from '@luoli/core';

const seeds = [11, 29, 47, 83, 131, 197];

function config(tokens: number): Config {
  return configSchema.parse({ general: { timezone: 'UTC' }, context: { scope: 'chat', background: { enabled: true, maxPerTurn: 4 }, rebase: { injectNotice: false }, limit: { tokens, maxMessages: 80, minKeepTurns: 1 }, cacheCommits: 64, tokenRatioAlpha: 0.2 } });
}

describe('context output invariants', () => {
  for (const seed of seeds) it(`preserves materialized shape for deterministic sequence ${seed}`, async () => {
    const path = `./data/context-invariants-${seed}.test.db`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db); const log = new LogSink(new OperationsRepository(db), `./data/context-invariants-${seed}-logs`);
    const engine = new ContextEngine(db, archive, log); const limit = 4000 + seed * 7; const cfg = config(limit); const scoped = archive.scope('chat');
    for (let turnNumber = 1; turnNumber <= 8; turnNumber += 1) {
      scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: turnNumber * 10, direction: 'in', fromKind: 'user', fromUserId: `bg-${turnNumber}`, fromName: 'Background', fromUsername: null, kind: 'text', text: `background ${seed}-${turnNumber}`, tgDate: Date.now(), raw: {}, triggered: false });
      const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: turnNumber * 10 + 1, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: `trigger ${turnNumber}`, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
      const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config: cfg });
      const toolCallId = `call-${seed}-${turnNumber}`; const payload = 'x'.repeat(800 + (seed * turnNumber) % 1200);
      engine.appendDelta(turn, { id: `${toolCallId}:call`, role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId, toolName: 'read', input: { payload } }], tokens: 700, pruneLevel: 2 });
      engine.appendDelta(turn, { id: `${toolCallId}:result`, role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId, toolName: 'read', output: { payload } }], tokens: 700, pruneLevel: 1 });
      engine.appendDelta(turn, { id: `${toolCallId}:answer`, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: `answer ${turnNumber}` }], tokens: 20, pruneLevel: 0 });
      await expect(Promise.race([engine.commitTurn(turn), new Promise((_, reject) => setTimeout(() => reject(new Error('commit timeout')), 1000))])).resolves.toBeDefined();
    }
    const repo = new ContextRepository(db, 'chat:chat'); const head = repo.head()!; const materialized = engine.materialize('chat:chat', null);
    const starts = repo.turnStartOrdinals(1, head.headOrdinal); expect(starts).toContain(head.windowStart);
    const calls = new Set<string>(); const answered = new Set<string>(); const backgroundIds: number[] = [];
    for (const message of materialized.messages) {
      if (message.origin === 'background' && message.sourceMessageId !== undefined) backgroundIds.push(message.sourceMessageId);
      const parts = message.parts as Array<{ type?: string; toolCallId?: string }>;
      if (message.role === 'tool') expect(parts.some((part) => part.type === 'tool-result')).toBe(true);
      for (const part of parts) {
        if (part.type === 'tool-call' && part.toolCallId) calls.add(part.toolCallId);
        if (part.type === 'tool-result') { expect(calls.has(part.toolCallId!)).toBe(true); answered.add(part.toolCallId!); }
      }
    }
    // **反方向同样是不变量**：tool-call 没有配对结果时 provider 拒收整个请求（中转站的表现是
    // 200 + 0 步 → `NoOutputGeneratedError`），而 parts 是持久化的 —— 该会话此后每轮都失败。
    // 裁剪只降级 output、不删整条 tool 消息，所以窗口里两边必须一直是成对的。
    expect([...calls].filter((id) => !answered.has(id))).toEqual([]);
    expect(new Set(backgroundIds).size).toBe(backgroundIds.length);
    expect(head.tokensTotal <= limit || Number(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='ctx.hardcap'").pluck().get()) > 0).toBe(true);
    closeDatabase(db);
  });
});
