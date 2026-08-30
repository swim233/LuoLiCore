import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, decodeLogPayload, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, MaintenanceService, Sandbox, configSchema } from '@luoli/core';

/**
 * 资源上界（docs/22 §6 建议的那一组）。此前只有 `grep` 的正则回溯有上界断言，而 §2 的两个 P0
 * 都是「单线程进程被一条输入拖垮」这一类：沙箱 stdout、流式渲染、文档提取、日志文件五处都能。
 *
 * 这些用例的形状要求：**语料必须真的能压垮没有上界的实现**。`R-SEC-01` 就是反例 ——
 * 用 4 个 `'a'` 去测 `(a|a)*$` 的回溯，即使退回 `RegExp` 也是秒过，那条断言在验证守卫自己的公理。
 * 所以下面每一条都写明「对着旧实现会怎样」。
 */

describe('沙箱 stdout 上界', () => {
  it('吐 8MB 的进程被边收边截，不整份进内存', async () => {
    const workspace = resolve('./data/bounds-sandbox');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const cap = 64 * 1024;
    // mode=none 是刻意的：这里要测的是**收集侧**的上界，不是隔离。docker 不一定可用。
    const sandbox = new Sandbox({ mode: 'none', bypassRoles: ['owner'], dockerBin: 'docker', image: 'x', network: 'none',
      memoryMb: 512, cpus: 1, pidsLimit: 64, readOnlyRoot: true, tmpfsMb: 64, workspaceDir: workspace, hostWorkspaceDir: '',
      defaultTimeoutMs: 20_000, maxTimeoutMs: 30_000, maxOutputBytes: cap });
    // 8MB：远超 `cap*2` 的收集上界。没有上界的实现会把整 8MB 拼进一个字符串。
    const result = await sandbox.run(`node -e "process.stdout.write('x'.repeat(8*1024*1024))"`, 'owner', workspace, new AbortController().signal, 20_000);
    expect(result.truncated).toBe(true);
    // 收集上界是 `cap*2`（留一倍给「头尾各半」的裁剪），所以断言的是这个量级而不是恰好 cap。
    expect(result.stdout.length).toBeLessThanOrEqual(cap * 2 + 1024);
    rmSync(workspace, { recursive: true, force: true });
  }, 40_000);

  it('多字节字符不会在 chunk 边界上被切坏', async () => {
    const workspace = resolve('./data/bounds-utf8');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const sandbox = new Sandbox({ mode: 'none', bypassRoles: ['owner'], dockerBin: 'docker', image: 'x', network: 'none',
      memoryMb: 512, cpus: 1, pidsLimit: 64, readOnlyRoot: true, tmpfsMb: 64, workspaceDir: workspace, hostWorkspaceDir: '',
      defaultTimeoutMs: 20_000, maxTimeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    // 三字节字符 × 大量：`chunk.toString()` 按 chunk 边界解码时必然在某处切开一个字符
    // （docs/22 · I-11，随 V-DOS-02 用 StringDecoder 修掉）。U+FFFD 是那种切坏的唯一痕迹。
    const result = await sandbox.run(`node -e "process.stdout.write('好'.repeat(200000))"`, 'owner', workspace, new AbortController().signal, 20_000);
    expect(result.stdout).not.toContain('�');
    rmSync(workspace, { recursive: true, force: true });
  }, 40_000);
});

describe('文档提取上界', () => {
  it('20MB 文本文件不整份展开成码点数组', async () => {
    const directory = resolve('./data/bounds-extract');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, 'huge.md');
    // 20MB = `media.maxDocBytes` 的默认上限。旧实现 `[...readFileSync(path,'utf8')]` 会为了取
    // 4 万个码点先造一个两千万元素的数组（docs/22 · I-07）。
    writeFileSync(path, '好'.repeat(7 * 1024 * 1024));
    const { TelegramMedia } = await import('@luoli/telegram');
    const config = configSchema.parse({ media: { extract: { maxChars: 40_000 } } }).media;
    const media = new TelegramMedia(null as never, 'token', null as never, config);
    const extract = (media as unknown as { extract(path: string, file: { mime?: string }): Promise<string | null> }).extract.bind(media);
    const started = Date.now();
    const text = await extract(path, { mime: 'text/markdown' });
    const elapsed = Date.now() - started;
    expect([...(text ?? '')]).toHaveLength(40_000);
    // 字符没被字节边界切坏（`StringDecoder` 的作用）。
    expect(text).not.toContain('�');
    // 只读了 `maxChars*4` 字节，所以这一步应该是毫秒级。旧实现在 20MB 上要花掉数百毫秒到数秒
    // 并瞬时占掉几百 MB —— 给一个宽松但有意义的上界。
    expect(elapsed, `提取用了 ${elapsed}ms，像是把整份文件展开了`).toBeLessThan(2000);
    rmSync(directory, { recursive: true, force: true });
  }, 40_000);
});

/**
 * 日志的上界形态在 2026-08-30 换过一次（docs/10 §3）：落点从「按天按类的 jsonl + 独立 blob 文件
 * + 库里一行」并成 `logs.dbPath` 一个文件，于是文件轮转（`maxFileMb`）与大载荷外溢（`bodyMaxBytes`）
 * 这两条上界都不存在了 —— 它们守的是「别把主库撑爆」和「别让单个文件无限长」。
 *
 * 接替它们的是下面两条。**对着没有这两条守卫的实现会怎样**：
 * ① 列表查询一旦 `SELECT *`，日志页每次刷新都会把一整轮的请求体推给浏览器（实测单条均 29 KB、
 *    最大 5 MB，列表一次上千行）；
 * ② `auto_vacuum` 停在 `NONE` 时，保留期删除只把页标成空闲，文件只涨不落 —— 而这正是
 *    `attachLogDatabase` 里「auto_vacuum 必须排在 journal_mode 之前」那句注释所防的事故，
 *    顺序写反的话它会静静地留在 0，没有任何别的判据会响。
 */
describe('日志库的体积上界', () => {
  it('大载荷不进列表：只回 data_bytes，正文要单独取', () => {
    const path = './data/bounds-blob.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const operations = new OperationsRepository(db);
    const sink = new LogSink(operations, [], { console: 'off' });
    const id = sink.event({ level: 'info', kind: 'model.call', summary: 'big', data: { prompt: 'y'.repeat(200_000) } });
    const listed = operations.logs(10) as Array<{ data_bytes: number }>;
    // 列表整体远小于那一条载荷本身。`SELECT *` 的实现在这里会是 200 KB 起步。
    expect(JSON.stringify(listed).length).toBeLessThan(4_000);
    expect(listed[0]!.data_bytes).toBeGreaterThan(200_000);
    // 而正文取得回来，且一字不差 —— 上界不能是靠丢数据换的。
    const row = db.prepare('SELECT data,data_codec AS codec,data_bytes AS bytes FROM log_events WHERE id=?').get(id) as { data: Buffer; codec: string; bytes: number };
    expect(row.codec).toBe('zstd');
    expect(row.data.byteLength).toBeLessThan(row.bytes / 10);
    expect(JSON.parse(decodeLogPayload(row.data, row.codec)!)).toEqual({ prompt: 'y'.repeat(200_000) });
    closeDatabase(db);
  }, 40_000);

  it('保留期删完之后文件真的缩回去，不是只把页标成空闲', () => {
    const path = './data/bounds-reclaim.test.db';
    const logs = `${path}-logs`;
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const operations = new OperationsRepository(db);
    // 关掉压缩：压缩之后 'x'.repeat(4000) 只剩几十字节，量不出「删完有没有还盘」。
    operations.compressLogPayloads = false;
    const sink = new LogSink(operations, [], { console: 'off' });
    for (let index = 0; index < 2000; index += 1)
      sink.event({ level: 'info', kind: 'system.bounds', summary: 'bulk', data: { blob: 'x'.repeat(4000) } });
    db.pragma('wal_checkpoint(TRUNCATE)');
    const grown = statSync(logs).size;
    expect(grown, '语料没把库撑起来，这条用例量不到东西').toBeGreaterThan(4 * 1024 * 1024);
    // 全部挪到保留期之外，再跑一次维护。
    db.prepare('UPDATE log_events SET ts=?').run(Date.now() - 400 * 86_400_000);
    new MaintenanceService(db, path, 2, 30).cleanup();
    expect(statSync(logs).size).toBeLessThan(grown / 4);
    closeDatabase(db);
  }, 60_000);
});
