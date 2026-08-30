import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, ContextRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, configSchema } from '@luoli/core';

const config = configSchema.parse({ general: { timezone: 'UTC' }, context: { scope: 'chat', background: { enabled: false, maxPerTurn: 20 }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 }, cacheCommits: 64, tokenRatioAlpha: 0.2 } });

describe('context reset races and token accounting', () => {
  it('inserts a reset note for a turn whose base was reset while running', async () => {
    const path = './data/context-reset-race.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const archive = new ArchiveRepository(db);
    const engine = new ContextEngine(db, archive);
    const scoped = archive.scope('chat');
    const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'question', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    const current = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config });
    engine.reset('chat:chat', 'test');
    engine.appendDelta(current, { id: 'answer', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'answer' }] });
    const result = await engine.commitTurn(current);
    const messages = new ContextRepository(db, 'chat:chat').messages(result.commit);
    expect(messages[0]?.origin).toBe('note');
    expect(messages[0]?.textPreview).toContain('上下文已被重置');
    const stats = new ContextRepository(db, 'chat:chat').effectiveStats(result.commit.windowStart, result.commit.headOrdinal);
    expect(result.commit.tokensTotal).toBe(stats.tokens);
    expect(result.commit.msgCount).toBe(stats.count);
    closeDatabase(db);
  });
});
