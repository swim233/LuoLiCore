import { readdirSync, rmSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { code, source } from './support/source.js';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, decodeLogPayload, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

const wipe = (database: string): void => {
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
};

describe('structured log pipeline', () => {
  it('低于 level 的不落库，其余整条进 log_events', () => {
    const database = './data/log-pipeline.test.db';
    wipe(database);
    const db = openDatabase(database); migrateDatabase(db); const operations = new OperationsRepository(db);
    const log = new LogSink(operations, [], { level: 'info', console: 'off' });
    expect(log.event({ level: 'debug', kind: 'debug.hidden', summary: 'hidden' })).toBe(0);
    log.event({ level: 'info', kind: 'system.test', summary: 'kept', data: { value: 'x'.repeat(100) } });
    log.close();
    const listed = operations.logs(10) as Array<{ level: string; data_bytes: number }>;
    expect(listed.every((entry) => entry.level !== 'debug')).toBe(true);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.data_bytes).toBeGreaterThan(100);
    closeDatabase(db);
  });

  /**
   * `AC-LOG-011`。载荷整块留在这一行上，**没有第二个落点**（docs/10 §3）—— 上一版把超过
   * `bodyMaxBytes` 的那份挪进 `logs/<day>/blobs/*.json`、行里只留 `{fileRef,bytes}`，于是读出侧
   * 必须解引用，而「行还在、文件已被保留策略删了」是一种要专门处理的半截状态。
   *
   * 两个半边都要成立：写入侧压得动（`data` 远小于 `data_bytes`），读出侧**一字不差**地还得回来
   * —— 只验前者的话，一个把载荷截断之后再压的实现同样能过，而排障要看的那份就永远拿不回来了。
   */
  it('大 payload 压着存在行上，解码后与原文一字不差，日志页两条路都取得到', async () => {
    const database = './data/log-blobref.test.db';
    wipe(database);
    const db = openDatabase(database); migrateDatabase(db); const operations = new OperationsRepository(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' } });
    const log = new LogSink(operations, [], { console: 'off' });
    const payload = { request: { body: { model: 'gpt', input: 'x'.repeat(4000) } } };
    const small = log.event({ level: 'info', kind: 'model.call', summary: '小载荷', data: { request: { body: { input: 'hi' } } } });
    const big = log.event({ level: 'info', kind: 'model.call', summary: '大载荷', data: payload });
    log.close();
    const row = (id: number): { data: Buffer | null; codec: string; bytes: number } =>
      db.prepare('SELECT data,data_codec AS codec,data_bytes AS bytes FROM log_events WHERE id=?').get(id) as { data: Buffer | null; codec: string; bytes: number };
    const stored = row(big);
    expect(stored.codec).toBe('zstd');
    // `data_bytes` 记的是**解压后**的长度：列表要显示载荷多大，不该为此逐行解压。
    expect(stored.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(stored.data!.byteLength).toBeLessThan(stored.bytes / 4);
    expect(JSON.parse(decodeLogPayload(stored.data, stored.codec)!)).toEqual(payload);
    // 阈值以下的不压：几百字节的 JSON 压完通常更大，而 66 个 kind 里有 64 个都在这一档。
    expect(row(small).codec).toBe('raw');
    expect(JSON.parse(decodeLogPayload(row(small).data, 'raw')!)).toEqual({ request: { body: { input: 'hi' } } });
    // 界面上唯一能看到载荷的两条路：日志页点开一行（`GET /api/logs/:id`）与「下载完整 JSON」（`…/data`）。
    // 列表刻意不带载荷，所以这两条都必须自己解码。
    const events = new EventBus(); const archive = new ArchiveRepository(db);
    const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
      providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
      maintenance: new MaintenanceService(db, database, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
    const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}` };
    const detail = (await (await app.request(`/api/logs/${big}`, { headers })).json() as { data: { text: string; bytes: number } }).data;
    expect(JSON.parse(detail.text)).toEqual(payload);
    expect(await (await app.request(`/api/logs/${big}/data`, { headers })).json()).toEqual(payload);
    closeDatabase(db);
  });

  /**
   * `log_events.agent_run_id` 曾经是一条**真死列**：列在、读出侧在读、`LOG_COLUMNS` 里也有它，
   * 而写入方一个都没有（实测生产库 60428 行 / 0 行有值）—— 与 `parent_span_id` 那次
   * （docs/28 · L-LOG-04）是同一种形态：一个永远为 NULL 的列被正确地读着。
   *
   * 接它的前置条件是 `docs/10 §1` 那张载体表里先有一行说清这个值由谁带下来
   * （`ToolExecutionContext.agentRunId` → `LogSink` 入参 → `insertLog`），现在有了。
   * 判据取「写进去的那一行读得出来」而不是「有调用点传了它」：后者随重构改名就会静默失效，
   * 而这一列的失败模式恰恰是**没有任何断言会因此变红**。
   */
  it('agent_run_id 真的写进 log_events —— 给了就写，没给是 NULL', () => {
    const database = './data/log-agentrun.test.db';
    wipe(database);
    const db = openDatabase(database); migrateDatabase(db); const operations = new OperationsRepository(db);
    const log = new LogSink(operations, [], { console: 'off' });
    const withRun = log.event({ level: 'info', kind: 'tool.call', summary: 'worker 里的一次工具调用', agentRunId: 'run-01J8', traceId: 'turn-1' });
    // span 那条路同样要带上：`agent.run` / `model.call` 都是 span，只走 `event()` 等于只接了一半。
    const span = log.span({ level: 'info', kind: 'agent.run', summary: 'worker', agentRunId: 'run-01J8', traceId: 'turn-1' });
    span.end({ ok: true });
    // 主 agent 自己的事件不带 —— 与 `agent_runs.worker_kind` 上主 run 为 NULL 同一个口径。
    const mainSide = log.event({ level: 'info', kind: 'turn.start', summary: '主 agent 这一侧', traceId: 'turn-1' });
    log.close();
    const runOf = (id: number): string | null =>
      db.prepare('SELECT agent_run_id FROM log_events WHERE id=?').pluck().get(id) as string | null;
    expect(runOf(withRun), 'agent_run_id 仍然没有写入方').toBe('run-01J8');
    expect(runOf(mainSide)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='agent.run' AND agent_run_id='run-01J8'").pluck().get(),
      'span() 那条路把 agent_run_id 丢了').toBe(1);
    // 列表也带着它：worker 运行页按这一列过滤，`LOG_COLUMNS` 少了它等于页面上永远是空的。
    const listed = operations.logs(10) as Array<{ kind: string; agent_run_id: string | null }>;
    expect(listed.find((row) => row.kind === 'tool.call')?.agent_run_id).toBe('run-01J8');
    expect(listed.find((row) => row.kind === 'turn.start')?.agent_run_id).toBeNull();
    closeDatabase(db);
  });

  /**
   * 日志落在 `logs.dbPath` 那**一个**文件里，不在主库（docs/10 §3）。判据有两条，缺一不可：
   * 主库那张同名表必须已经不存在 —— 它只要还在就会按 temp → main → attached 的解析顺序一直
   * 遮住附加库那张，所有查询读到的都是一张永远不再增长的旧表，而**没有任何别的断言会因此变红**。
   */
  it('log_events 在附加上来的日志库里，主库那张同名表已删', () => {
    const database = './data/log-attach.test.db';
    wipe(database);
    const db = openDatabase(database); migrateDatabase(db);
    expect(db.prepare("SELECT COUNT(*) FROM main.sqlite_master WHERE name='log_events'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM logs.sqlite_master WHERE name='log_events'").pluck().get()).toBe(1);
    expect((db.pragma('database_list') as Array<{ name: string; file: string }>).find((row) => row.name === 'logs')?.file)
      .toContain('log-attach.test.db-logs');
    const log = new LogSink(new OperationsRepository(db), [], { console: 'off' });
    log.event({ level: 'info', kind: 'system.test', summary: '落在独立文件里' });
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(db.prepare('SELECT COUNT(*) FROM logs.log_events').pluck().get()).toBe(1);
    expect(statSync(`${database}-logs`).size).toBeGreaterThan(0);
    closeDatabase(db);
  });

  /**
   * 入库失败**不许往外抛**。`log.event` 的调用点全在 catch 块、`.catch()` 回调和 `main.ts` 的
   * crash handler 里，让它抛等于把「日志写不进去」升级成「轮次失败」，再升级成
   * 「crash handler 自己抛、`process.exit(1)` 走不到」。用关库来造这个条件 —— 这正是关停竞态里
   * 会真的发生的那一幕：`poller.drain()` 宽限期用完就返回，在途 handler 之后才 settle，
   * 那时 `closeDatabase` 已经跑过（docs/10 §6）。
   *
   * 「库坏了至少内容还在」此前由 JSONL 兜着。删掉文件落点之后接替它的是 **stderr 上的整行**
   * （docs/10 §3.2）—— 只写一句错误消息的话，那条事件的载荷就真的没有了。
   */
  it('入库失败时返回 0 而不抛，整行进 stderr，且告警回调只被叫一次（不打转）', () => {
    const database = './data/log-dbfail.test.db';
    wipe(database);
    const db = openDatabase(database); migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db), [], { level: 'info', console: 'off' });
    const failures: unknown[] = [];
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    // 真实装配里这个回调是 `alerts.fire('db_write_failed')`，而 `AlertDispatcher.raise()` 第一件事
    // 就是再记一行 `alert.raised` —— 库坏了这一路会绕回 LogSink。照那个形状复现一次。
    log.onWriteFailure = (error) => { failures.push(error); log.event({ level: 'error', kind: 'alert.raised', summary: 're-entry' }); };
    try {
      expect(log.event({ level: 'info', kind: 'system.test', summary: 'before close' })).toBeGreaterThan(0);
      closeDatabase(db);
      expect(() => log.event({ level: 'error', kind: 'turn.end', summary: 'after close', data: { detail: '排障要看的那份' } })).not.toThrow();
      expect(log.event({ level: 'error', kind: 'turn.end', summary: 'again' })).toBe(0);
    } finally {
      process.stderr.write = write;
    }
    // 两次 event 各报一次；重入的那一次被闸住，否则这里会是 4 条甚至无限。
    expect(failures).toHaveLength(2);
    // 内容真的还在：摘要与载荷都出现在 stderr 上，而不只是一句「写入失败」。
    const dump = written.join('');
    expect(dump).toContain('after close');
    expect(dump).toContain('排障要看的那份');
    expect(dump).toContain('写入失败');
    log.close();
  });

  /**
   * `migrateDatabase` 的第三个参数是日志库的位置，可选 —— 省掉它拿到的默认值是从主库路径派生的
   * `<db.path>-logs`，而那**恰好**就是本文件与其余 73 个用例的清库约定，所以漏传在测试里全绿。
   * 生产读的是 `logs.dbPath`（默认 `./data/logs.db`），两者对不上的后果不是「日志写别处」这么轻：
   * 这条路上会把主库里的存量 `log_events` 搬进日志库、**再删掉源表**，于是一次 `pnpm db:migrate`
   * 就把历史日志搬进一个没人读的 `luoli.db-logs`，不可逆。`scripts/migrate.ts` 与
   * `scripts/acceptance/seed.ts` 都这么漏过。
   *
   * 行为化装不起来（要先造一个上一版的库、再跑一次真迁移，且只在升级那一次成立），判据本身
   * 也长在源码结构上，所以照 `tests/support/source.ts` 那条口子读源码断。
   */
  it('apps/ 与 scripts/ 里的每个 migrateDatabase 调用都显式给了日志库路径', () => {
    const callers: string[] = [];
    for (const root of ['apps', 'scripts']) {
      for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        const file = `${root}/${entry}`;
        // `node_modules` 里有 workspace 包的软链，`dist` 里是它们的构建产物 —— 两者都会把
        // `@luoli/db` 自己的声明文件扫进来，而那份文件里的 `migrateDatabase(` 是声明不是调用。
        if (/(^|\/)(node_modules|dist)\//.test(file)) continue;
        if (!file.endsWith('.ts') || file.endsWith('.d.ts') || !statSync(file).isFile()) continue;
        const text = source(file);
        // import 那行不含左括号，不会误判。
        if (!text.includes(code('migrateDatabase('))) continue;
        callers.push(file);
        expect(text, `${file} 调 migrateDatabase 时没给日志库路径，会落到 <db.path>-logs 上`)
          .toContain(code('migrateDatabase(db, undefined, { path:'));
      }
    }
    // 反方向：一个都没扫到说明这条断言在空转（目录布局变了、或者调用点改用了别的变量名）。
    expect(callers.length, '没扫到任何 migrateDatabase 调用点').toBeGreaterThanOrEqual(4);
  });
});
