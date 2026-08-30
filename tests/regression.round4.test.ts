import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, MemoryStore, ProviderStore, Secrets, ToolRegistry, configSchema } from '@luoli/core';
import type { Config, LogSink as LogSinkType } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { createServer } from '@luoli/server';

/**
 * 先 parse 一份合法配置再按需覆盖那一个字段：这两条用例**故意**用 schema 不接受的值
 * （`tokens: 1` 压硬截断、拼错的时区压渲染回退），问的正是「这种值真的漏到运行时会怎样」。
 * 直接手搓整份 config 会让后来新增的配置读取路径在这里炸成 undefined，与用例本身无关。
 */
function contextConfig(tokens: number): Config {
  const base = configSchema.parse({ general: { timezone: 'UTC' }, context: { scope: 'chat', background: { enabled: true, maxPerTurn: 4 }, rebase: { injectNotice: false }, limit: { tokens: 4000, maxMessages: 80, minKeepTurns: 1 }, cacheCommits: 64, tokenRatioAlpha: 0.2 } });
  return { ...base, context: { ...base.context, limit: { ...base.context.limit, tokens } } };
}

function harness(name: string) {
  const path = `./data/${name}.test.db`; for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

describe('R-CTX-01 硬截断保持 part 形状', () => {
  it('预算压到 1 也不破坏 type，且带附件的消息整体降级而非半截', async () => {
    const path = './data/round4-truncate.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db); const log = new LogSink(new OperationsRepository(db));
    const engine = new ContextEngine(db, archive, log); const config = contextConfig(100); const scoped = archive.scope('chat');
    const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null,
      kind: 'photo', text: 'z'.repeat(4000), tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention',
      // 两种形态都要挡：`file` 是现在写入的形状，`image` 是库里那些历史 part（AI SDK v7 已废弃它）。
      mediaParts: [{ type: 'file', data: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 640, height: 480 },
        { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 640, height: 480 }] });
    const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: true, trigger, abortSignal: new AbortController().signal, config });
    engine.appendDelta(turn, { id: 'a1', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'y'.repeat(4000) }], tokens: 2404, pruneLevel: 0 });
    await engine.commitTurn(turn);

    // 先确认硬截断这条路径真的走到了——否则下面的断言全是空的（这正是前几轮踩过的坑）。
    const truncated = db.prepare("SELECT COUNT(*) FROM context_messages WHERE json_extract(meta_json,'$.truncated.chars') IS NOT NULL").pluck().get() as number;
    expect(truncated).toBeGreaterThan(0);
    expect(db.prepare("SELECT MIN(json_extract(meta_json,'$.truncated.chars')) FROM context_messages WHERE meta_json IS NOT NULL").pluck().get()).toBe(1);

    const known = new Set(['text', 'image', 'image_url', 'file', 'reasoning', 'tool-call', 'tool-result']);
    const parts = engine.materialize('chat:chat', null).messages.flatMap((message) => message.parts as Array<{ type?: string; image?: string; data?: string }>);
    expect(parts.map((part) => part.type).filter((type) => type !== undefined && !known.has(type))).toEqual([]);
    // 图片要么完整保留，要么整体换成占位文本；绝不能留下截半的 data URI。
    for (const part of parts) if (part.type === 'image') expect(part.image).toBe('data:image/png;base64,AAAA');
    for (const part of parts) if (part.type === 'file') expect(part.data).toBe('data:image/png;base64,AAAA');
    // 物化本身会跑形状断言，这里再确认它不会因为截断而抛。
    expect(() => engine.materialize('chat:chat', null)).not.toThrow();
    closeDatabase(db);
  });

  it('形状断言会拒收未知的 part type', async () => {
    const path = './data/round4-shape.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db); const engine = new ContextEngine(db, archive); const config = contextConfig(32_000);
    const trigger = archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text: 'hi', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: true, trigger, abortSignal: new AbortController().signal, config });
    engine.appendDelta(turn, { id: 'bad', role: 'assistant', origin: 'assistant', parts: [{ type: 'mystery-part', text: 'x' }], tokens: 4, pruneLevel: 0 });
    await expect(engine.commitTurn(turn)).rejects.toThrow(/unknown part type/);
    closeDatabase(db);
  });
});

describe('R-TG-01 时区', () => {
  it('群聊渲染在时区非法时回退而不是抛错', async () => {
    const path = './data/round4-timezone.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db); const engine = new ContextEngine(db, archive);
    const valid = contextConfig(32_000);
    const config: Config = { ...valid, general: { ...valid.general, timezone: 'Asia/Shangahi' } };
    const trigger = archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text: '你好', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    await expect(engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config })).resolves.toBeDefined();
    closeDatabase(db);
  });
});

describe('R-API-01 / R-CFG-02 WebUI 写端点', () => {
  it('perChat 覆盖必须通过白名单校验', async () => {
    const { app, db, headers } = harness('round4-perchat');
    const forbidden = await app.request('/api/chats/chat%3Aabc', { method: 'PATCH', headers, body: JSON.stringify({ access: { defaultUserRole: 'owner' } }) });
    expect(forbidden.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) FROM config_kv').pluck().get()).toBe(0);
    const allowed = await app.request('/api/chats/chat%3Aabc', { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' } }) });
    expect(allowed.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:abc'").pluck().get()).toBe(JSON.stringify({ output: { mode: 'once' } }));
    closeDatabase(db);
  });

  it('工具启停写入的是 schema 内的合法路径并广播变更', async () => {
    const { app, db, headers } = harness('round4-tooltoggle');
    expect((await app.request('/api/tools/not_a_tool', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(404);
    expect((await app.request('/api/tools/bash', { method: 'PATCH', headers, body: JSON.stringify({ enabled: 'no' }) })).status).toBe(400);
    expect((await app.request('/api/tools/bash', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    const stored = db.prepare("SELECT value_json FROM config_kv WHERE key='tools.overrides.bash'").pluck().get() as string;
    expect(configSchema.parse({ tools: { overrides: { bash: JSON.parse(stored) as { enabled: boolean } } } }).tools.overrides.bash).toEqual({ enabled: false });
    closeDatabase(db);
  });

  it('被运维禁用的工具既不出现在目录里，也无法被调用', async () => {
    const log = { event: () => 1, span: () => ({ id: 's', end: () => undefined }) } as unknown as LogSinkType;
    const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    let disabled = false;
    registry.bindOverrides(() => (disabled ? { bash: { enabled: false } } : {}));
    registry.register({ name: 'bash', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'never', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const turn = { turnId: 't', key: 'k', chatId: 'c', threadId: null, initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} } as unknown as RuntimeTurnContext;
    const context = { turn, workspace: '.', agentKind: 'main' as const };
    expect(registry.activeNames('trusted', context)).toContain('bash');
    disabled = true;
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(await registry.execute('bash', {}, context)).toEqual({ ok: false, error: 'tool_disabled_by_operator' });
  });
});

describe('R-MEM-01 记忆段合并', () => {
  it('段数超限时不会复制「其他」段的条目', () => {
    const path = './data/round4-memory.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const directory = './data/round4-memory-docs';
    rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
    const db = openDatabase(path); migrateDatabase(db);
    writeFileSync(`${directory}/PUBMEMORY.md`, ['# 公开记忆', '', '- 开头的裸条目', ...Array.from({ length: 13 }, (_, index) => `## 段${index}\n- 条目${index}`)].join('\n'));
    const store = new MemoryStore(db, directory, 100_000, 200_000, 12);
    store.queueWrite({ scope: 'pubmemory', subject: null, section: '新增', lines: ['一条新记忆'], actor: 'test', turnId: 't1', chatId: 'c', userId: 'u' }, 'owner', false, 'trusted');
    store.flush('t1');
    const content = store.read('pubmemory', null, 'owner').content;
    // 合并循环必须真的跑过（14 段 + 新增段 > 12），否则这个用例什么都没验证。
    expect((content.match(/^## /gm) ?? []).length).toBeLessThanOrEqual(12);
    expect(content).toContain('## 其他');
    expect(content.split('\n').filter((line) => line.includes('开头的裸条目'))).toHaveLength(1);
    closeDatabase(db);
  });
});
