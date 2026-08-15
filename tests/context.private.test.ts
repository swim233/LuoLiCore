import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine } from '@luoli/core';
import type { Config } from '@luoli/core';

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const config = { general: { timezone: 'UTC' }, context: { scope: 'chat', background: { enabled: true, maxPerTurn: 3 }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 }, cacheCommits: 64, tokenRatioAlpha: 0.2 } } as Config;
  return { db, archive, engine: new ContextEngine(db, archive), config };
}

describe('context private and background semantics', () => {
  it('uses no speaker prefixes anywhere in a private turn', async () => {
    const h = harness('context-private');
    const scoped = h.archive.scope('999');
    scoped.append({ chatId: '999', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: '999', fromName: 'Alice', fromUsername: null, kind: 'text', text: '先问一句', tgDate: Date.now(), raw: {}, triggered: false });
    const trigger = scoped.append({ chatId: '999', messageThreadId: null, tgMessageId: 2, direction: 'in', fromKind: 'user', fromUserId: '999', fromName: 'Alice', fromUsername: null, kind: 'text', text: '再问一句', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    const current = await h.engine.openTurn({ chatId: '999', threadId: null, key: 'chat:999', initiatorUserId: '999', effectiveRole: 'trusted', isPrivate: true, trigger, abortSignal: new AbortController().signal, config: h.config });
    expect(current.delta.map((message) => message.textPreview)).toEqual(['先问一句', '再问一句']);
    expect(current.delta.every((message) => !/^\[.+ \d{2}:\d{2}\]/.test(message.textPreview ?? ''))).toBe(true);
    closeDatabase(h.db);
  });

  it('claims only latest allowed background messages and leaves blocked speakers archived', async () => {
    const h = harness('context-background');
    const principals = new PrincipalRepository(h.db);
    principals.upsertSeen({ id: 'user:blocked', kind: 'user', tgId: 'blocked', role: 'blocked', displayName: null, username: null, chatType: null });
    const scoped = h.archive.scope('chat');
    for (let id = 1; id <= 10; id += 1) scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in', fromKind: 'user', fromUserId: id === 9 ? 'blocked' : `user-${id}`, fromName: `User ${id}`, fromUsername: null, kind: 'text', text: `background ${id}`, tgDate: Date.now(), raw: {}, triggered: false });
    const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: 11, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'trigger', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    const current = await h.engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config: h.config });
    expect(current.delta.filter((message) => message.origin === 'background')).toHaveLength(3);
    expect(JSON.stringify(current.delta)).not.toContain('background 9');
    expect(current.delta[0]?.origin).toBe('note');
    expect(scoped.recent(20).some((message) => message.text === 'background 9')).toBe(true);
    expect((h.engine.stats('chat:chat').claimWatermark as number)).toBe(0);
    await h.engine.commitTurn(current);
    expect((h.engine.stats('chat:chat').claimWatermark as number)).toBe(trigger.id);
    closeDatabase(h.db);
  });

  it('charges image parts in context token estimates', async () => {
    const h = harness('context-image-tokens');
    const trigger = h.archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: 'look', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    Object.assign(trigger, { mediaParts: [{ type: 'image', image: 'x'.repeat(400_000) }] });
    const current = await h.engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config: h.config });
    expect(current.delta.at(-1)?.tokens).toBeGreaterThanOrEqual(1500);
    h.archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 2, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: 'stored', tgDate: Date.now(), raw: {}, triggered: false, triggerReason: null, mediaParts: [{ type: 'image', image: 'base64' }] });
    expect(h.archive.scope('chat').recent(1)[0]?.mediaParts).toEqual([{ type: 'image', image: 'base64' }]);
    closeDatabase(h.db);
  });
});
