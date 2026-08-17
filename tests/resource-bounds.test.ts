import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, Sandbox, configSchema } from '@luoli/core';

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

describe('日志文件上界', () => {
  it('单文件超过 maxFileMb 时轮转，不无限增长', () => {
    const path = './data/bounds-logs.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const directory = resolve('./data/bounds-logs');
    rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(path); migrateDatabase(db);
    // maxFileMb 压到 1：默认 128MB 的话这条用例要写掉一百多兆才看得出轮转。
    const sink = new LogSink(new OperationsRepository(db), directory, [], { maxFileMb: 1, bodyMaxBytes: 512 });
    for (let index = 0; index < 4000; index += 1) sink.event({ level: 'info', kind: 'system.bounds', summary: 'x'.repeat(400) });
    sink.close();
    const day = new Date().toISOString().slice(0, 10);
    const files = readdirSync(resolve(directory, day));
    // 轮转发生过：除了 `system.jsonl` 还该有 `.1`（甚至 `.2`）。
    expect(files.some((name) => /\.jsonl\.\d+$/.test(name)), `没有发生轮转：${files.join(', ')}`).toBe(true);
    for (const name of files) expect(statSync(resolve(directory, day, name)).size).toBeLessThan(2 * 1024 * 1024);
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }, 40_000);

  it('超过 bodyMaxBytes 的 payload 落独立文件，不塞进 log_events', () => {
    const path = './data/bounds-blob.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const directory = resolve('./data/bounds-blob');
    rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const sink = new LogSink(new OperationsRepository(db), directory, [], { bodyMaxBytes: 1024 });
    sink.event({ level: 'info', kind: 'model.call', summary: 'big', data: { prompt: 'y'.repeat(200_000) } });
    sink.close();
    // DB 行里只留引用：不这么做的话一条带请求体的 `model.call` 就能把 log_events 撑爆（docs/10 §4）。
    const row = db.prepare("SELECT data_json AS data,file_ref AS ref FROM log_events WHERE kind='model.call'").get() as { data: string | null; ref: string | null };
    expect(row.ref).toBeTruthy();
    expect((row.data ?? '').length).toBeLessThan(512);
    expect(row.data ?? '').not.toContain('yyyy');
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }, 40_000);
});
