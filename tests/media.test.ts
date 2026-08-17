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
    const media = new TelegramMedia(api, 'token', db, config);
    const archived = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 2, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: null, tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'private' });
    const parts = await media.process({ photo: [{ file_id: 'f2', file_unique_id: 'u2', width: 10, height: 10, file_size: 10 }] }, archived);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((db.prepare('SELECT download_state AS state FROM attachments').get() as { state: string }).state).toBe('failed');
    closeDatabase(db);
  });
});
