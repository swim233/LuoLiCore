import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, QuotaGuard, Secrets, TurnRegistry, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

/** 这一组守的是 docs/21 · G-SSE-01：接线之前 SSE 那根管子里一个字节都没有，
 *  首屏之后界面看到的永远是打开那一刻的快照。 */
function harness(events = new EventBus()) {
  const path = './data/sse-events.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync('./data/sse-events-logs', { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } });
  const operations = new OperationsRepository(db);
  const log = new LogSink(operations, './data/sse-events-logs', [], { events });
  const archive = new ArchiveRepository(db);
  const turnRegistry = new TurnRegistry();
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, turnRegistry, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, log, events, operations, turnRegistry, headers };
}

const collect = (events: EventBus, type: string): Array<Record<string, unknown>> => {
  const seen: Array<Record<string, unknown>> = [];
  events.subscribe((event) => { if (event.type === type) seen.push(event.data as Record<string, unknown>); });
  return seen;
};

describe('EventBus 隔离', () => {
  it('does not let one subscriber break later subscribers', () => {
    const failures: unknown[] = []; const events = new EventBus((error) => failures.push(error)); const seen: string[] = [];
    events.subscribe(() => { throw new Error('closed stream'); });
    events.subscribe((event) => seen.push(event.type));
    expect(() => events.emit('usage', { value: 1 })).not.toThrow();
    expect(seen).toEqual(['usage']);
    expect(failures).toHaveLength(1);
    expect(events.subscriberCount).toBe(2);
  });
});

describe('SSE 事件接线', () => {
  it('日志广播只发摘要、跳过 debug，并按 kind 合并窗口内的连发', async () => {
    const { db, log, events } = harness();
    const seen = collect(events, 'log');
    // 阈值是广播侧的，不是落库侧的：debug 照旧写库，只是不推给界面。
    log.event({ level: 'debug', kind: 'x.noise', summary: 'debug 不广播' });
    expect(seen).toHaveLength(0);
    log.event({ level: 'info', kind: 'x.first', summary: '第一条', data: { body: 'y'.repeat(400) } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'x.first', summary: '第一条', level: 'info' });
    // 载荷能到几百 KB，全量广播会把每个开着的 WebUI 连接打爆。
    expect(seen[0]).not.toHaveProperty('data');
    expect(typeof seen[0]!.id).toBe('number');
    // 同一 kind 在窗口内只留最后一条；不同 kind 互不阻塞。
    log.event({ level: 'info', kind: 'x.first', summary: '第二条' });
    log.event({ level: 'info', kind: 'x.first', summary: '第三条' });
    log.event({ level: 'warn', kind: 'x.other', summary: '另一类' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'x.other', summary: '另一类' });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ kind: 'x.first', summary: '第三条', merged: 2 });
    log.close();
    closeDatabase(db);
  });

  it('publish 直接广播结构化事件而不落库', () => {
    const { db, log, events, operations } = harness();
    const seen = collect(events, 'turn.started');
    log.publish('turn.started', { turnId: 't1', key: 'chat:c' });
    expect(seen).toEqual([{ turnId: 't1', key: 'chat:c' }]);
    expect(operations.logs(10)).toHaveLength(0);
    log.close();
    closeDatabase(db);
  });

  it('/api/events 真的把日志推到流上（接线之前这根管子里一个字节都没有）', async () => {
    const { app, db, log, headers } = harness();
    const aborter = new AbortController();
    const response = await app.request('/api/events', { headers: { cookie: headers.cookie }, signal: aborter.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain('connected');
    log.event({ level: 'info', kind: 'x.stream', summary: '推到流上', traceId: 'trace-1' });
    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain('event: log');
    expect(frame).toContain('推到流上');
    expect(frame).toContain('trace-1');
    aborter.abort();
    await reader.cancel().catch(() => undefined);
    log.close();
    closeDatabase(db);
  });

  it('配额结算广播已花掉的金额与当时的限额', () => {
    const { db, events } = harness();
    const seen = collect(events, 'quota');
    const quota = new QuotaGuard(db, 'UTC', events);
    const reservation = quota.reserve({ chatId: 'c', userId: 'u', estimateUsd: 0.01,
      limits: { globalDaily: 1, globalMonthly: null, chatDaily: null, chatMonthly: null, userDaily: null, userMonthly: null } });
    expect(reservation).not.toBeNull();
    quota.commit(reservation!, 0.02);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ scope: 'global', subject: 'global', window: 'day', limit: 1 });
    expect(seen[0]!.spent).toBeCloseTo(0.02, 6);
    closeDatabase(db);
  });
});

describe('在途 turn 与取消通道', () => {
  it('GET /api/turns/active 读的是进程内注册表，缺统计行时补零', async () => {
    const { app, db, turnRegistry, headers } = harness();
    expect((await (await app.request('/api/turns/active', { headers: { cookie: headers.cookie } })).json() as { data: unknown[] }).data).toEqual([]);
    turnRegistry.register({ id: 'turn-1', key: 'chat:c', chatId: 'c', userId: 'u', role: 'trusted' }, 60_000);
    const listed = await (await app.request('/api/turns/active', { headers: { cookie: headers.cookie } })).json() as { data: Array<Record<string, unknown>> };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ id: 'turn-1', key: 'chat:c', chatId: 'c', userId: 'u', role: 'trusted', steps: 0, costUsd: 0 });
    // 进程内的 controller / timeout 不该出现在响应里。
    expect(listed.data[0]).not.toHaveProperty('controller');
    turnRegistry.finish('turn-1');
    closeDatabase(db);
  });

  it('POST /api/turns/:id/cancel 触发 abort，对已经结束的轮次回 cancelled:false', async () => {
    const { app, db, turnRegistry, headers } = harness();
    const active = turnRegistry.register({ id: 'turn-2', key: 'chat:c', chatId: 'c', userId: 'u', role: 'limited' }, 60_000);
    const cancelled = await app.request('/api/turns/turn-2/cancel', { method: 'POST', headers, body: '{}' });
    expect((await cancelled.json() as { data: { cancelled: boolean } }).data.cancelled).toBe(true);
    expect(active.controller.signal.aborted).toBe(true);
    turnRegistry.finish('turn-2');
    const missing = await app.request('/api/turns/turn-2/cancel', { method: 'POST', headers, body: '{}' });
    expect((await missing.json() as { data: { cancelled: boolean } }).data.cancelled).toBe(false);
    // 取消是写操作，必须留审计。
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary='POST /api/turns/turn-2/cancel'").pluck().get()).toBe(2);
    closeDatabase(db);
  });
});
