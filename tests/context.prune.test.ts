import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, ContextRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, configSchema } from '@luoli/core';

function harness(name: string, tokens = 4000) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const engine = new ContextEngine(db, archive);
  const config = configSchema.parse({ general: { timezone: 'UTC' }, context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20 }, rebase: { injectNotice: false }, limit: { tokens, maxMessages: 200, minKeepTurns: 1 }, cacheCommits: 64, tokenRatioAlpha: 0.2 } });
  return { db, archive, engine, config };
}

async function turn(h: ReturnType<typeof harness>, id: number, isPrivate = false) {
  const scoped = h.archive.scope('chat');
  const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: `turn ${id}`, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
  return h.engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate, trigger, abortSignal: new AbortController().signal, config: h.config });
}

describe('context pruning', () => {
  it('keeps window start at turn boundaries and does not delete rows', async () => {
    const h = harness('context-prune', 4000);
    for (let id = 1; id <= 10; id += 1) {
      const current = await turn(h, id);
      h.engine.appendDelta(current, { id: `call-${id}`, role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: `c${id}`, toolName: 'x', input: 'x'.repeat(400) }], tokens: 300, pruneLevel: 2 });
      h.engine.appendDelta(current, { id: `result-${id}`, role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: `c${id}`, toolName: 'x', output: 'x'.repeat(400) }], tokens: 300, pruneLevel: 1 });
      await h.engine.commitTurn(current);
    }
    const repo = new ContextRepository(h.db, 'chat:chat');
    const head = repo.head()!;
    expect(repo.turnStartOrdinals(1, head.headOrdinal)).toContain(head.windowStart);
    expect(repo.messages(head)[0]?.role).not.toBe('tool');
    expect((h.db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(30);
    expect(head.tokensTotal).toBeLessThanOrEqual(4000);
    // `/ctx` 要报「最近一次 prune / rebase」，而两者都只在 commit 行上留痕 —— `head()` 只看得到
    // 当前那一条，摘要里没有的话命令侧就无处可取（AC-CTX-027，docs/29 · M-TG-04）。
    const summary = h.engine.stats('chat:chat') as { lastPrune: { seq: number } | null; lastRebase: unknown };
    expect(summary.lastPrune?.seq).toBe(h.db.prepare("SELECT MAX(seq) FROM context_commits WHERE key='chat:chat' AND kind='prune'").pluck().get());
    // 没有并发轮次就没有 rebase：两个标记各查各的，不能一个有值就都当有。
    expect(summary.lastRebase).toBeNull();
    closeDatabase(h.db);
  });

  it('preserves tool message shape and pairing after tiered pruning', async () => {
    const h = harness('context-prune-shape', 5000);
    for (let id = 1; id <= 4; id += 1) {
      const current = await turn(h, id);
      h.engine.appendDelta(current, { id: `call-${id}`, role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: `c${id}`, toolName: 'read', input: { text: 'x'.repeat(2500) } }], tokens: 1400, pruneLevel: 2 });
      h.engine.appendDelta(current, { id: `result-${id}`, role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: `c${id}`, toolName: 'read', output: { text: 'x'.repeat(2500) } }], tokens: 1400, pruneLevel: 1 });
      h.engine.appendDelta(current, { id: `answer-${id}`, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'done' }], tokens: 10, pruneLevel: 0 });
      await h.engine.commitTurn(current);
    }
    const messages = h.engine.materialize('chat:chat', null).messages;
    const seenCalls = new Set<string>();
    for (const message of messages) for (const part of message.parts as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-call' && part.toolCallId) seenCalls.add(part.toolCallId);
      if (part.type === 'tool-result') expect(seenCalls.has(part.toolCallId!)).toBe(true);
    }
    expect(messages.filter((message) => message.role === 'tool').every((message) => (message.parts as Array<{ type?: string }>).some((part) => part.type === 'tool-result'))).toBe(true);
    closeDatabase(h.db);
  });

  it('hard truncates an oversized single turn without changing original parts_json', async () => {
    const h = harness('context-hardtruncate', 4000);
    const current = await turn(h, 1);
    const original = '巨'.repeat(20_000);
    h.engine.appendDelta(current, { id: 'huge', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: original }], tokens: 12_004, pruneLevel: 0 });
    const beforeCount = (h.db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count;
    const result = await h.engine.commitTurn(current);
    const materialized = h.engine.materialize('chat:chat', result.commit.id);
    expect(materialized.tokens).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(materialized.messages)).not.toContain(original);
    expect((h.db.prepare("SELECT parts_json FROM context_messages WHERE id='huge'").get() as { parts_json: string }).parts_json).toContain(original);
    expect((h.db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(beforeCount + 2);
    closeDatabase(h.db);
  });

  it('strictly converges for equal-sized oversized messages', async () => {
    const h = harness('context-hardtruncate-equal', 4000);
    const current = await turn(h, 1);
    for (const id of ['huge-a', 'huge-b']) h.engine.appendDelta(current, { id, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: '巨'.repeat(20_000) }], tokens: 12_004, pruneLevel: 0 });
    const result = await Promise.race([
      h.engine.commitTurn(current),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hard truncation timed out')), 1000)),
    ]);
    expect(h.engine.materialize('chat:chat', result.commit.id).tokens).toBeLessThanOrEqual(4000);
    closeDatabase(h.db);
  });
});
