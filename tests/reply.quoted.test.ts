import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message } from 'grammy/types';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import type { ArchivedMessage } from '@luoli/db';
import { resolveQuotedMessage, type MediaProcessor } from '@luoli/telegram';

/**
 * 适配层这一半：被回复的消息在库里没有时，必须从 update 自带的副本现场归档并下载它的媒体。
 * 这正是实测场景 —— `access.defaultUserRole=blocked` 的群里，别人发的图从来不进归档
 * （logs/2026-08-16：183757 / 183862 / 183865 三条被回复的图，messages 表里一条都没有）。
 */
function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, archive: new ArchiveRepository(db) };
}

const imagePart = { type: 'image', image: 'ZmFrZQ==', mediaType: 'image/jpeg' };
function processor(): MediaProcessor & { calls: number } {
  return { calls: 0, async process(payload) { this.calls += 1; return 'photo' in payload ? [imagePart] : []; } };
}

const chat = { id: -100, type: 'supergroup' as const, title: 'g' };
function reply(overrides: Partial<Message> = {}): Message {
  return { message_id: 2, date: 1_700_000_000, chat, from: { id: 7, is_bot: false, first_name: '我' },
    text: '这张图描述了什么', reply_to_message: { message_id: 1, date: 1_699_999_000, chat,
      from: { id: 9, is_bot: false, first_name: '别人' }, caption: '猎奇警告',
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 100, height: 100 }] } as Message, ...overrides } as Message;
}

function trigger(archive: ArchiveRepository): ArchivedMessage {
  return archive.scope('-100', null).append({ chatId: '-100', messageThreadId: null, tgMessageId: 2, direction: 'in', fromKind: 'user',
    fromUserId: '7', fromName: '我', fromUsername: null, kind: 'text', text: '这张图描述了什么', tgDate: Date.now(), raw: {},
    triggered: true, triggerReason: 'wakeword', replyToTgMessageId: 1 });
}

describe('被回复消息的取回', () => {
  it('库里没有时现场归档并下载媒体，且标成已消费', async () => {
    const { db, archive } = harness('reply-fetch');
    const scoped = archive.scope('-100', null);
    const media = processor();
    const row = await resolveQuotedMessage({ media, botId: 1 }, scoped, reply(), trigger(archive));
    expect(row).not.toBeNull();
    expect(row!.mediaParts).toEqual([imagePart]);
    expect(row!.text).toBe('猎奇警告');
    // claimed：下一轮 claimBackground 不能再把它当成新的背景发言认领一次。
    expect(db.prepare('SELECT claimed_at FROM messages WHERE tg_message_id=1').pluck().get()).not.toBeNull();
    // media part 要落库，不能只活在内存里 —— 否则这一轮之后就再也取不回来。
    expect(JSON.parse(db.prepare('SELECT media_parts_json FROM messages WHERE tg_message_id=1').pluck().get() as string)).toEqual([imagePart]);
    closeDatabase(db);
  });

  it('已归档且已有 media part 时不重复下载', async () => {
    const { db, archive } = harness('reply-reuse');
    const scoped = archive.scope('-100', null);
    const existing = scoped.append({ chatId: '-100', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user',
      fromUserId: '9', fromName: '别人', fromUsername: null, kind: 'photo', text: '猎奇警告', tgDate: Date.now(), raw: {},
      triggered: false, triggerReason: null, mediaParts: [imagePart] });
    const media = processor();
    const row = await resolveQuotedMessage({ media, botId: 1 }, scoped, reply(), trigger(archive));
    expect(row!.id).toBe(existing.id);
    expect(media.calls).toBe(0);
    closeDatabase(db);
  });

  it('把被回复者的显示名挂到触发消息上', async () => {
    const { db, archive } = harness('reply-name');
    const row = trigger(archive);
    await resolveQuotedMessage({ media: processor(), botId: 1 }, archive.scope('-100', null), reply(), row);
    expect(row.replyToName).toBe('别人');
    closeDatabase(db);
  });

  it('跨会话引用与非回复消息一律不取', async () => {
    const { db, archive } = harness('reply-foreign');
    const scoped = archive.scope('-100', null);
    const plain = reply();
    delete (plain as { reply_to_message?: unknown }).reply_to_message;
    expect(await resolveQuotedMessage({ media: processor(), botId: 1 }, scoped, plain, trigger(archive))).toBeNull();
    // 关联频道的引用带着另一个 chat.id：拉进来等于把别的会话的内容混进这个 context key。
    const foreign = reply();
    (foreign.reply_to_message as { chat: { id: number } }).chat = { id: -200 };
    expect(await resolveQuotedMessage({ media: processor(), botId: 1 }, scoped, foreign, trigger(archive))).toBeNull();
    closeDatabase(db);
  });
});
