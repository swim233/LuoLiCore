import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MemoryStore, QuotaGuard, TurnConcurrency, TurnRegistry, configSchema } from '@luoli/core';
import { createTelegramBot } from '@luoli/telegram';

const botInfo = { id: 1, is_bot: true as const, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };

function textUpdate(id: number, text: string) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: 'group', title: 'Group' }, from: { id: 200, is_bot: false, first_name: 'User' }, text } } as never;
}

describe('per-chat trigger overrides', () => {
  it('matches the chat-level wakeword list instead of the global one', async () => {
    const path = './data/trigger-perchat.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmSync('./data/trigger-perchat-memory', { recursive: true, force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { defaultUserRole: 'trusted', defaultChatRole: 'trusted', bootstrapOwnerId: '1' }, quota: { enabled: false },
      trigger: { wakewords: ['洛璃'] }, perChat: { 'chat:-100': { trigger: { wakewords: ['璃酱'] } } } });
    const principals = new PrincipalRepository(db); const archive = new ArchiveRepository(db); const operations = new OperationsRepository(db);
    const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { config, db, principals, archive, operations, context: new ContextEngine(db, archive),
      turns: new TurnRepository(db), quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, './data/trigger-perchat-memory', 1500, 3000), registry: new TurnRegistry(),
      concurrency: new TurnConcurrency(config.concurrency), log: new LogSink(operations, './data/trigger-perchat-logs'), botInfo });
    // 触发之后整轮会跑到发消息，这里把 Bot API 整个短路掉，测试不打网络。
    bot.api.config.use((async (_prev: unknown, method: string) => ({ ok: true, result: method === 'sendMessage' || method === 'editMessageText'
      ? { message_id: 900, date: 0, chat: { id: -100, type: 'group' }, text: 'ok' } : true })) as never);
    await bot.handleUpdate(textUpdate(1, '璃酱在吗'));
    await bot.handleUpdate(textUpdate(2, '洛璃在吗'));
    const rows = db.prepare('SELECT text,triggered,trigger_reason AS reason FROM messages WHERE direction=? ORDER BY id').all('in');
    expect(rows).toEqual([{ text: '璃酱在吗', triggered: 1, reason: 'wakeword' }, { text: '洛璃在吗', triggered: 0, reason: null }]);
    closeDatabase(db);
  });
});
