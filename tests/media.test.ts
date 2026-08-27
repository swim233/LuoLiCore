import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Api } from 'grammy';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { TelegramMedia } from '@luoli/telegram';
import { configSchema, contextMessages } from '@luoli/core';

/**
 * 跨边界契约：**造一张真 JPEG 走完整条链路**。此前 43 个测试文件没有一个 import 过 TelegramMedia，
 * 于是「sharp 的输入输出是同一个文件」这种一行的路径拼接错误，能让多模态输入 100% 不可用
 * 而无人发现——日志里只有一句「[photo 处理失败]」（docs/20 · W-MEDIA-01）。
 */
const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, media: { dir: './data/media-test' } }).media;

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync('./data/media-test', { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, archive: new ArchiveRepository(db) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Telegram media processing', () => {
  it('normalizes a real photo into an image part', async () => {
    const { db, archive } = harness('media-photo');
    const jpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 12, g: 200, b: 90 } } }).jpeg().toBuffer();
    vi.stubGlobal('fetch', async () => new Response(jpeg, { status: 200 }));
    const api = { getFile: async () => ({ file_path: 'photos/file_4.jpg' }) } as unknown as Api;
    const media = new TelegramMedia(api, 'token', db, config);
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    const parts = await media.process({ photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 2400, height: 1200, file_size: jpeg.length }] }, archived);
    expect(parts).toHaveLength(1);
    // `image` part 在 AI SDK v7 已废弃（每张图一条 DeprecationWarning），写入侧直接产出 file。
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/jpeg', ref: expect.stringMatching(/^attachment:\/\//) });
    expect(parts[0]).not.toHaveProperty('data');
    const row = db.prepare('SELECT id,download_state AS state,local_path AS path,download_error AS error FROM attachments').get() as { id: string; state: string; path: string; error: string | null };
    expect(row).toMatchObject({ state: 'done', error: null });
    const turn = { snapshot: { messages: [{ role: 'user', parts }], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 1 }, delta: [] } as never;
    expect(contextMessages(turn, db)[0]).toMatchObject({ content: [expect.objectContaining({ type: 'file', data: expect.any(String), mediaType: 'image/jpeg' })] });
    expect(JSON.stringify(parts)).not.toContain(jpeg.toString('base64').slice(0, 32));
    // 归一化真的跑了：最长边被压到 maxImageEdge 以内。
    const meta = await sharp(row.path).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(config.maxImageEdge);
    // 附件没了就整体换占位文本。抛出去的话，parts 是持久化的 —— 这个会话在 /new 之前每一轮
    // 都会在物化时炸掉，而 docs/02 的不变量要的正是「整体换成占位文本」（docs/24 · R-MEDIA-01）。
    rmSync(row.path, { force: true });
    expect(() => contextMessages(turn, db)).not.toThrow();
    expect(contextMessages(turn, db)[0]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('图片已不可用') }] });
    db.prepare('DELETE FROM attachments').run();
    expect(contextMessages(turn, db)[0]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('图片已不可用') }] });
    closeDatabase(db);
  });

  it('records a failure instead of an image part when the download fails', async () => {
    const { db, archive } = harness('media-fail');
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
    const api = { getFile: async () => ({ file_path: 'photos/file_5.jpg' }) } as unknown as Api;
    // `media.download` / `media.extract` 是 `docs/10 §2` 写了而实现里一直没有的两条：一张超限的图、
    // 一个解析失败的 PDF，此前只落在 `attachments` 那两列错误里（docs/28 · L-LOG-01）。
    const events: Array<{ level: string; kind: string; data?: unknown }> = [];
    const log = { event: (event: { level: string; kind: string; data?: unknown }) => { events.push(event); return 1; } } as never;
    const media = new TelegramMedia(api, 'token', db, config, log);
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 2, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    const parts = await media.process({ photo: [{ file_id: 'f2', file_unique_id: 'u2', width: 10, height: 10, file_size: 10 }] }, archived);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((db.prepare('SELECT download_state AS state FROM attachments').get() as { state: string }).state).toBe('failed');
    const download = events.filter((event) => event.kind === 'media.download');
    expect(download).toHaveLength(1);
    expect(download[0]!.level).toBe('warn');
    expect(download[0]!.data).toMatchObject({ kind: 'photo', state: 'failed' });
    // 下载都没成，提取那一条不该出现。
    expect(events.filter((event) => event.kind === 'media.extract')).toEqual([]);
    closeDatabase(db);
  });

  it('超出 maxImageBytes 时记一条 skipped，而且一次网络都不发', async () => {
    const { db, archive } = harness('media-oversize');
    const events: Array<{ level: string; kind: string; data?: unknown }> = [];
    const log = { event: (event: { level: string; kind: string; data?: unknown }) => { events.push(event); return 1; } } as never;
    vi.stubGlobal('fetch', async () => { throw new Error('不该走到网络'); });
    const media = new TelegramMedia({ getFile: async () => { throw new Error('不该走到 getFile'); } } as unknown as Api, 'token', db, config, log);
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 3, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    await media.process({ photo: [{ file_id: 'f3', file_unique_id: 'u3', width: 10, height: 10, file_size: config.maxImageBytes + 1 }] }, archived);
    expect(events.filter((event) => event.kind === 'media.download').map((event) => event.data)).toMatchObject([{ state: 'skipped', reason: 'size_limit' }]);
    closeDatabase(db);
  });

  // 占位符是模型唯一看得见的东西。`file.kind` 直接拼出去是英文的 `voice`，而语音的 file_name 恒为空
  // ——`[voice  9s]`，两个空格来自那个空槽（docs/29 · M-TG-06）。同一个文件里 PDF 走的是「文档」。
  it('语音的占位符是中文的 [语音 12s]，下不下载都一样', async () => {
    const { db, archive } = harness('media-voice');
    const ogg = Buffer.from('OggS-not-really');
    vi.stubGlobal('fetch', async () => new Response(ogg, { status: 200 }));
    const api = { getFile: async () => ({ file_path: 'voice/file_9.oga' }) } as unknown as Api;
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 9, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'voice', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    const voice = { voice: { file_id: 'f9', file_unique_id: 'u9', duration: 12, mime_type: 'audio/ogg', file_size: ogg.length } };
    expect(await new TelegramMedia(api, 'token', db, config).process(voice, archived))
      .toEqual([{ type: 'text', text: '[语音 12s]' }]);
    // downloadVoice=false 那条早就是中文的，两条路必须给出同一句话，否则改配置会换掉模型看到的东西。
    expect(await new TelegramMedia(api, 'token', db, { ...config, downloadVoice: false }).process(voice, archived))
      .toEqual([{ type: 'text', text: '[语音 12s]' }]);
    closeDatabase(db);
  });

  it('文档提取成功时 download 与 extract 各落一条', async () => {
    const { db, archive } = harness('media-extract');
    const events: Array<{ level: string; kind: string; data?: unknown }> = [];
    const log = { event: (event: { level: string; kind: string; data?: unknown }) => { events.push(event); return 1; } } as never;
    vi.stubGlobal('fetch', async () => new Response('第一行\n第二行', { status: 200 }));
    const media = new TelegramMedia({ getFile: async () => ({ file_path: 'documents/notes.md' }) } as unknown as Api, 'token', db, config, log);
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 4, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'document', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    await media.process({ document: { file_id: 'f4', file_unique_id: 'u4', file_name: 'notes.md', mime_type: 'text/markdown', file_size: 20 } }, archived);
    expect(events.filter((event) => event.kind === 'media.download').map((event) => event.data)).toMatchObject([{ state: 'done' }]);
    const extract = events.filter((event) => event.kind === 'media.extract');
    expect(extract).toHaveLength(1);
    expect(extract[0]!.level).toBe('info');
    expect(extract[0]!.data).toMatchObject({ state: 'done' });
    expect((extract[0]!.data as { chars: number }).chars).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
