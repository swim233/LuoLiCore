import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, contextKey, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MemoryStore, QuotaGuard, TurnConcurrency, TurnRegistry, configSchema } from '@luoli/core';
import { createTelegramBot } from '@luoli/telegram';

function update(id: number, text: string) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: 'group', title: 'Group' }, from: { id: 200, is_bot: false, first_name: 'Blocked' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] } } as never;
}

function editedUpdate(id: number, messageId: number, text: string) {
  return { update_id: id, edited_message: { message_id: messageId, date: Math.floor(Date.now() / 1000), edit_date: Math.floor(Date.now() / 1000), chat: { id: -100, type: 'group', title: 'Group' }, from: { id: 200, is_bot: false, first_name: 'User' }, text } } as never;
}

describe('Telegram command access gate', () => {
  it('archives according to policy and rejects blocked /new before state mutation', async () => {
    const path = './data/access-commands.test.db';
    const memoryDir = './data/access-commands-memory';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmSync(memoryDir, { recursive: true, force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const config = configSchema.parse({ access: { defaultUserRole: 'blocked', defaultChatRole: 'trusted', archiveBlocked: true, bootstrapOwnerId: '1' }, quota: { enabled: false } });
    const principals = new PrincipalRepository(db);
    principals.upsertSeen({ id: 'user:200', kind: 'user', tgId: '200', role: 'blocked', displayName: null, username: null, chatType: null });
    principals.upsertSeen({ id: 'chat:-100', kind: 'chat', tgId: '-100', role: 'trusted', displayName: null, username: null, chatType: 'group' });
    const archive = new ArchiveRepository(db);
    const engine = new ContextEngine(db, archive);
    const operations = new OperationsRepository(db);
    const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
      config, db, principals, archive, operations, context: engine, turns: new TurnRepository(db), quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, memoryDir, 1500, 3000), registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency), log: new LogSink(operations, './data/access-commands-logs'),
      botInfo: { id: 1, is_bot: true, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
    });
    const key = contextKey({ chatId: '-100', messageThreadId: null }, config.context.scope);
    expect(engine.stats(key).commit).toBeNull();
    await bot.handleUpdate(update(1, '/new'));
    expect(engine.stats(key).commit).toBeNull();
    expect(archive.scope('-100').recent(10)).toHaveLength(1);
    closeDatabase(db);
  });

  it('archives edited messages as a new revision without double-claiming the update', async () => {
    const path = './data/access-edited.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { defaultUserRole: 'trusted', defaultChatRole: 'trusted', bootstrapOwnerId: '1' }, quota: { enabled: false } });
    const principals = new PrincipalRepository(db); const archive = new ArchiveRepository(db); const operations = new OperationsRepository(db);
    const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { config, db, principals, archive, operations, context: new ContextEngine(db, archive), turns: new TurnRepository(db), quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, './data/access-edited-memory', 1500, 3000), registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency), log: new LogSink(operations, './data/access-edited-logs'), botInfo: { id: 1, is_bot: true, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
    await bot.handleUpdate(update(10, 'original'));
    await bot.handleUpdate(editedUpdate(11, 10, 'edited'));
    const rows = db.prepare('SELECT text,revision FROM messages WHERE chat_id=? AND tg_message_id=? ORDER BY revision').all('-100', 10) as Array<{ text: string; revision: number }>;
    expect(rows).toEqual([{ text: 'original', revision: 0 }, { text: 'edited', revision: 1 }]);
    archive.scope('-100').append({ chatId: '-100', messageThreadId: null, tgMessageId: 99, direction: 'in', fromKind: 'user', fromUserId: '200', fromName: 'User', fromUsername: null, kind: 'text', text: 'secret', tgDate: Date.now(), raw: { api_key: 'sk-abcdefghijklmnop', authorization: 'Bearer abc' }, triggered: false, triggerReason: null });
    const raw = db.prepare('SELECT raw_json FROM messages WHERE tg_message_id=99').pluck().get() as string;
    expect(raw).not.toContain('sk-abcdefghijklmnop');
    expect(raw).not.toContain('Bearer abc');
    closeDatabase(db);
  });
});
