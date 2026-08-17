import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, ContextRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, configSchema } from '@luoli/core';

/**
 * 活跃期（`context.active.*`，docs/02 §5.1.1 与红线 19）。
 *
 * 这里断言的是「什么时候裁」，不是「怎么裁」—— 后者归 `context.prune.test.ts` 与
 * `context.invariants.test.ts`。活跃期只推迟裁剪、方向永远是多留，所以形状不变式由那两个文件继续保底。
 *
 * 时间用改库里的 `context_commits.created_at` 来造，不注入时钟：判据本来就是「距 HEAD 提交多久」，
 * 改那一列造出来的空闲间隔和真实经过五分钟是同一回事，而假时钟只能证明假时钟能用。
 */
function harness(name: string, active: { windowMs: number; tokens?: number; maxMessages?: number }) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const engine = new ContextEngine(db, archive);
  const config = configSchema.parse({ general: { timezone: 'UTC' },
    context: { limit: { tokens: 4000, maxMessages: 6, minKeepTurns: 1 }, active: { tokens: 40_000, maxMessages: 100, ...active } } });
  return { db, archive, engine, config };
}

async function turn(h: ReturnType<typeof harness>, id: number) {
  const trigger = h.archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in', fromKind: 'user',
    fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: `turn ${id}`, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
  return h.engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted',
    isPrivate: false, trigger, abortSignal: new AbortController().signal, config: h.config });
}

/** 一轮 = 触发消息 + 一句回答，answer 的 token 数可调，用来控制水位。 */
async function exchange(h: ReturnType<typeof harness>, id: number, tokens = 100): Promise<void> {
  const current = await turn(h, id);
  h.engine.appendDelta(current, { id: `a${id}`, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: `answer ${id}` }], tokens, pruneLevel: 0 });
  await h.engine.commitTurn(current);
}

/** 把 HEAD 的提交时刻往回拨，制造「安静了这么久」。 */
function backdateHead(db: ReturnType<typeof openDatabase>, ms: number): void {
  db.prepare(`UPDATE context_commits SET created_at=created_at-? WHERE id=(SELECT commit_id FROM refs WHERE key='chat:chat' AND name='done')`).run(ms);
}

describe('context active period', () => {
  it('lets the window grow past the limit while the conversation is still going', async () => {
    const h = harness('context-active-grow', { windowMs: 600_000 });
    // limit.maxMessages=6，即 3 轮就该撞上；活跃期内一轮接一轮地提交，窗口起点一动不动。
    for (let id = 1; id <= 6; id += 1) await exchange(h, id);
    const repo = new ContextRepository(h.db, 'chat:chat');
    const head = repo.head()!;
    expect(head.windowStart).toBe(1);
    expect(repo.messages(head)).toHaveLength(12);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM context_commits WHERE kind='prune'").get()).toMatchObject({ count: 0 });
    closeDatabase(h.db);
  });

  it('still prunes once the active ceiling is breached, and prunes back to context.limit', async () => {
    const h = harness('context-active-ceiling', { windowMs: 600_000, maxMessages: 8 });
    for (let id = 1; id <= 6; id += 1) await exchange(h, id);
    const repo = new ContextRepository(h.db, 'chat:chat');
    const head = repo.head()!;
    // 6 轮 × 2 条 = 12 条，天花板 8 条：撞顶时裁过，之后又允许长回天花板以内。
    const prunes = h.db.prepare("SELECT msg_count AS msgCount FROM context_commits WHERE kind='prune' ORDER BY seq").all() as Array<{ msgCount: number }>;
    expect(prunes.length).toBeGreaterThan(0);
    // 关键断言：每一次裁剪的落点都是 limit.maxMessages=6，不是天花板 8 ——
    // 裁到天花板等于此后每一轮都要再裁一次，每次都作废整段前缀缓存（红线 19）。
    for (const prune of prunes) expect(prune.msgCount).toBeLessThanOrEqual(6);
    expect(repo.messages(head).length).toBeLessThanOrEqual(8);
    expect(repo.turnStartOrdinals(1, head.headOrdinal)).toContain(head.windowStart);
    expect((h.db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(12);
    closeDatabase(h.db);
  });

  it('prunes in openTurn when the active period has expired, before the request goes out', async () => {
    const h = harness('context-active-idle', { windowMs: 300_000 });
    for (let id = 1; id <= 6; id += 1) await exchange(h, id);
    const repo = new ContextRepository(h.db, 'chat:chat');
    expect(repo.head()!.windowStart).toBe(1);
    backdateHead(h.db, 400_000);
    // 久别重逢的这一轮：开轮时就已经裁完了，所以这一轮发出去的就是小请求，
    // 而不是「按全价发一次超大请求、下一轮才恢复」。
    const current = await turn(h, 7);
    expect(current.snapshot.messages.length).toBeLessThanOrEqual(6);
    expect(current.snapshot.windowStart).toBeGreaterThan(1);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM context_commits WHERE kind='prune'").get()).toMatchObject({ count: 1 });
    h.engine.appendDelta(current, { id: 'a7', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'answer 7' }], tokens: 100, pruneLevel: 0 });
    await h.engine.commitTurn(current);
    expect(repo.messages(repo.head()!).length).toBeLessThanOrEqual(6);
    closeDatabase(h.db);
  });

  it('keeps pruning every turn when the feature is off', async () => {
    const h = harness('context-active-off', { windowMs: 0 });
    for (let id = 1; id <= 6; id += 1) await exchange(h, id);
    const repo = new ContextRepository(h.db, 'chat:chat');
    const head = repo.head()!;
    expect(head.windowStart).toBeGreaterThan(1);
    expect(repo.messages(head).length).toBeLessThanOrEqual(6);
    closeDatabase(h.db);
  });

  it('does not defer a single oversized turn past the ceiling', async () => {
    const h = harness('context-active-oversized', { windowMs: 600_000 });
    const current = await turn(h, 1);
    h.engine.appendDelta(current, { id: 'huge', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: '巨'.repeat(80_000) }], tokens: 48_004, pruneLevel: 0 });
    const result = await h.engine.commitTurn(current);
    // 单轮就顶穿 active.tokens=40000：活跃期推迟不了它，硬截断照跑，目标仍是 limit.tokens=4000。
    expect(h.engine.materialize('chat:chat', result.commit.id).tokens).toBeLessThanOrEqual(4000);
    closeDatabase(h.db);
  });
});
