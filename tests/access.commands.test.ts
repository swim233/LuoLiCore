import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, contextKey, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MemoryStore, QuotaGuard, TurnConcurrency, TurnRegistry, UsageLedger, configSchema } from '@luoli/core';
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

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } as const;

function privateCommand(id: number, text: string) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 200, type: 'private' }, from: { id: 200, is_bot: false, first_name: 'Owner' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } } as never;
}

/**
 * 三条只读命令的**回执内容**。此前它们一条都没有断言 ——「回了一句话」和「回的是对的那句话」
 * 是两件事，而 `/ping` 少了三样、`/usage` 读错了表都是从这个空档里长出来的。
 *
 * 回执靠一个 API transformer 截下来：短路掉就不会真的打网络，`createTelegramBot` 自己装的
 * throttler / autoRetry / `tg.api` span 仍然在外层照常跑。
 */
async function readOnlyHarness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ general: { timezone: 'UTC' }, access: { defaultUserRole: 'owner', defaultChatRole: 'owner', bootstrapOwnerId: '200' }, quota: { enabled: false } });
  const archive = new ArchiveRepository(db); const operations = new OperationsRepository(db);
  const sent: string[] = [];
  const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
    config, db, principals: new PrincipalRepository(db), archive, operations, context: new ContextEngine(db, archive),
    turns: new TurnRepository(db), quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, `./data/${name}-memory`, 1500, 3000),
    registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency), log: new LogSink(operations, `./data/${name}-logs`),
    ledger: new UsageLedger(db), startedAt: Date.now() - 3_725_000, botInfo: BOT_INFO,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') sent.push(String((payload as { text: string }).text));
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 200, type: 'private' } } } as never;
  });
  return { db, bot, sent };
}

describe('Telegram 只读命令的回执', () => {
  // 条目要「版本、上线时长、模型别名、DB 大小」四样，实际只有版本 —— owner 多出来的那坨是
  // `JSON.stringify(dashboard())`，运维总览，与健康检查要的四样毫无交集（docs/29 · M-TG-03）。
  it('/ping 四样齐全，而且不再原样吐 dashboard() 的 JSON', async () => {
    const { db, bot, sent } = await readOnlyHarness('ping-detail');
    await bot.handleUpdate(privateCommand(1, '/ping'));
    const [text] = sent;
    expect(text).toContain('LuoLiCore');
    expect(text).toContain('上线时长：1小时2分');
    expect(text).toContain('模型别名：main');
    expect(text).toMatch(/DB 大小：\d+\.\d MB（含 -wal \/ -shm）/);
    // W-TG-02 给 /ctx、/tasks 修掉的反模式：一坨 JSON 顶着 4096 字符上限。
    expect(text).not.toContain('"turns"');
    closeDatabase(db);
  });

  // `/tasks` 与 WebUI「任务与审批」页此前各指一样东西：前者列 turns（没有标题也没有进度），
  // 后者列 tasks。两样都列，各自标清楚（docs/29 · M-TG-05）。
  it('/tasks 同时列在途轮次与子 agent 任务，带标题与进度', async () => {
    const { db, bot, sent } = await readOnlyHarness('tasks-detail');
    const now = Date.now();
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,started_at)
      VALUES('01TURNRUNNING','chat:200','200','200','owner','running',?)`).run(now - 12_000);
    db.prepare(`INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,progress_json,created_at,updated_at)
      VALUES('01TASKRUNNING','01TURNRUNNING','200','200','把 docs 扫一遍','running',?,?,?)`)
      .run(JSON.stringify({ status: '读文档', current: 12, total: 20, detail: 'docs/11' }), now - 90_000, now);
    await bot.handleUpdate(privateCommand(1, '/tasks'));
    const [text] = sent;
    expect(text).toContain('在途轮次 1 个');
    expect(text).toContain('01TURNRUNNIN running · 已运行 12s');
    expect(text).toContain('子 agent 任务 1 个');
    expect(text).toContain('「把 docs 扫一遍」');
    expect(text).toContain('读文档 12/20 · docs/11');
    closeDatabase(db);
  });

  /**
   * 靶子就是实测那两行：`agents.createDryRun()` 往 ledger 写行但**不建 turns 行**，于是读 `turns`
   * 的 `/usage` 和读 ledger 的用量页永久差一截（实测 0.0001008 美元，docs/29 · M-QUOTA-01）。
   * 这里让差额大到一眼可见：试跑那一行占总额的一半。
   */
  it('/usage 读 usage_ledger，试跑那种没有 turns 行的花费也算进去', async () => {
    const { db, bot, sent } = await readOnlyHarness('usage-detail');
    const insert = db.prepare(`INSERT INTO usage_ledger(ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,input_tokens,output_tokens,cost_usd)
      VALUES(?,?,?,?,'p','m','main',?,?,?)`);
    insert.run(Date.now(), '01TURNREAL', '200', '200', 1000, 200, 0.25);
    // 这一行在 turns 表里没有对应，正是此前被漏掉的那种。
    insert.run(Date.now(), 'dryrun:01ABC', '200', '200', 500, 100, 0.25);
    await bot.handleUpdate(privateCommand(1, '/usage'));
    const [text] = sent;
    expect(text).toContain('用量 · 今天（UTC）');
    expect(text).toContain('全局 $0.500000 · 2 轮 · 1.5K in / 300 out');
    expect(text).toContain('本会话 $0.500000');
    expect(text).toContain('本人 $0.500000');
    // 与 ledger 的 SUM 逐位一致 —— 这条断言就是 AC-QUOTA-011 要的「三方一致」的机器版。
    const total = db.prepare('SELECT SUM(cost_usd) FROM usage_ledger').pluck().get() as number;
    expect(text).toContain(`$${total.toFixed(6)}`);
    closeDatabase(db);
  });

  it('/usage month 与未知参数各走各的', async () => {
    const { db, bot, sent } = await readOnlyHarness('usage-window');
    db.prepare(`INSERT INTO usage_ledger(ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,cost_usd)
      VALUES(?,'01T','200','200','p','m','main',1.5)`).run(Date.now());
    await bot.handleUpdate(privateCommand(1, '/usage month'));
    expect(sent[0]).toContain('用量 · 本月（UTC）');
    expect(sent[0]).toContain('$1.500000');
    await bot.handleUpdate(privateCommand(2, '/usage 上周'));
    expect(sent[1]).toBe('用法：/usage [today|month]');
    closeDatabase(db);
  });
});
