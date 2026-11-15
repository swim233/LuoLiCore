import { describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  conversationTitle,
  displayName,
  isAllowed,
  isAllowedChat,
  type TelegramRaw,
} from './message.js';
import { sdkLogger } from './adapter.js';
import type { ReceivedRichText, RichBlock } from './rich-received.js';
import { splitMessage, telegramMessageLimit } from './split.js';
import { isTriggered } from './trigger.js';

const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice', last_name: 'Liddell' };
const bob: TelegramUser = { id: 22, is_bot: false, first_name: 'Bob' };
const botUser: TelegramUser = { id: 999, is_bot: true, first_name: 'Nori', username: 'nori_bot' };
const bot = { id: '999', username: 'nori_bot' };
const wakeWords = ['nori', '小诺'];

function message(fields: Partial<TelegramRaw>): TelegramRaw {
  return { message_id: 7, date: 1793340120, chat: group, from: alice, ...fields };
}

describe('消息转换', () => {
  it('显示名：名 + 空格 + 姓；没有姓时只有名', () => {
    expect(displayName(alice)).toBe('Alice Liddell');
    expect(displayName(bob)).toBe('Bob');
  });

  it('会话标题：群为群名，私聊为「与 显示名 的私聊」', () => {
    expect(conversationTitle(group)).toBe('读书会');
    expect(
      conversationTitle({ id: 11, type: 'private', first_name: 'Alice', last_name: 'Liddell' }),
    ).toBe('与 Alice Liddell 的私聊');
    expect(conversationTitle({ id: 22, type: 'private', first_name: 'Bob' })).toBe('与 Bob 的私聊');
  });
});

describe('白名单', () => {
  const allow = { chats: new Set(['-1001']), users: new Set(['11']) };

  it('群看 chat id，私聊看发送者 id，频道不工作', () => {
    expect(isAllowed(message({ text: 'x' }), allow)).toBe(true);
    expect(isAllowed(message({ chat: { ...group, id: -1002 } }), allow)).toBe(false);
    const privateChat = (user: TelegramUser): TelegramChat => ({ id: user.id, type: 'private' });
    expect(isAllowed(message({ chat: privateChat(alice) }), allow)).toBe(true);
    expect(isAllowed(message({ chat: privateChat(bob), from: bob }), allow)).toBe(false);
    expect(isAllowed(message({ chat: { id: -1001, type: 'channel' } }), allow)).toBe(false);
  });

  it('只有 chat id 时（任务到点）：负数是群，看群；正数是私聊，就是对方的用户 id，看用户', () => {
    expect(isAllowedChat('-1001', allow)).toBe(true);
    expect(isAllowedChat('-1002', allow)).toBe(false);
    expect(isAllowedChat('11', allow)).toBe(true);
    expect(isAllowedChat('22', allow)).toBe(false);
    // 群 id 不会因为碰巧在用户名单里就算允许，反过来也一样
    expect(isAllowedChat('-1001', { chats: new Set(), users: new Set(['-1001']) })).toBe(false);
    expect(isAllowedChat('11', { chats: new Set(['11']), users: new Set() })).toBe(false);
  });
});

describe('触发', () => {
  const triggered = (fields: Partial<TelegramRaw>) =>
    isTriggered(message(fields), { bot, wakeWords });

  it('私聊总是触发', () => {
    expect(triggered({ chat: { id: 11, type: 'private' }, text: '随便说说' })).toBe(true);
  });

  it('@bot：不分大小写；后面紧跟用户名字符时不算', () => {
    expect(triggered({ text: '@nori_bot 你好' })).toBe(true);
    expect(isTriggered(message({ text: '问一下 @NORI_BOT。' }), { bot, wakeWords: ['小诺'] })).toBe(
      true,
    );
    // 这里不用含 nori 的唤醒词，只看提及
    expect(isTriggered(message({ text: '@nori_bot2 你好' }), { bot, wakeWords: ['小诺'] })).toBe(
      false,
    );
  });

  it('没有用户名的提及（text_mention）按 id 判断', () => {
    expect(
      triggered({
        text: 'Nori 看这里',
        entities: [{ type: 'text_mention', offset: 0, length: 4, user: botUser }],
      }),
    ).toBe(true);
    expect(
      triggered({
        text: 'Bob 看这里',
        entities: [{ type: 'text_mention', offset: 0, length: 3, user: bob }],
      }),
    ).toBe(false);
  });

  it('回复 bot 的消息触发；回复别人不触发；论坛话题里隐含的「回复」不算', () => {
    const botMessage = { message_id: 3, date: 0, chat: group, from: botUser, text: '我是 bot' };
    expect(triggered({ text: '为什么', reply_to_message: botMessage })).toBe(true);
    expect(triggered({ text: '为什么', reply_to_message: { ...botMessage, from: bob } })).toBe(
      false,
    );
    expect(
      triggered({
        text: '话题里说话',
        is_topic_message: true,
        message_thread_id: 3,
        reply_to_message: botMessage,
      }),
    ).toBe(false);
  });

  it('唤醒词不分大小写，出现在文字任何位置都算', () => {
    expect(triggered({ text: 'NORI 在吗' })).toBe(true);
    expect(triggered({ text: '找小诺聊天' })).toBe(true);
    expect(triggered({ text: '今天天气不错' })).toBe(false);
  });

  it('图片等的说明文字与文字一样：唤醒词、@bot、text_mention 都触发；私聊与回复 bot 的非文字消息也触发', () => {
    const image = { photo: [{ file_id: 'p', width: 1, height: 1 }] };
    expect(triggered({ ...image, caption: 'nori 看图' })).toBe(true);
    expect(triggered({ ...image, caption: '看图 @nori_bot' })).toBe(true);
    expect(
      triggered({
        ...image,
        caption: '机器人看图',
        caption_entities: [{ type: 'text_mention', offset: 0, length: 3, user: botUser }],
      }),
    ).toBe(true);
    expect(triggered({ ...image, caption: '看图' })).toBe(false);
    expect(triggered({ ...image })).toBe(false);
    expect(triggered({ ...image, chat: { id: 11, type: 'private' } })).toBe(true);
    const botMessage = { message_id: 3, date: 0, chat: group, from: botUser, text: '我是 bot' };
    expect(triggered({ voice: { file_id: 'v', duration: 1 }, reply_to_message: botMessage })).toBe(
      true,
    );
  });

  describe('富文本消息：看转出来的文字和里面的 text_mention', () => {
    /** 一条富文本消息（适配器的类型比文档旧，这里照文档写） */
    const rich = (...blocks: RichBlock[]): Partial<TelegramRaw> => ({
      rich_message: { blocks } as unknown as TelegramRaw['rich_message'],
    });
    const para = (text: ReceivedRichText): RichBlock => ({ type: 'paragraph', text });
    const mentionOf = (user: TelegramUser): ReceivedRichText => ({
      type: 'text_mention',
      text: user.first_name,
      user,
    });
    // 唤醒词不用含 nori 的，免得 @nori_bot 被当成唤醒词
    const triggeredBy = (fields: Partial<TelegramRaw>) =>
      isTriggered(message(fields), { bot, wakeWords: ['小诺'] });

    it('群里：有唤醒词（不分大小写）、有 @用户名、text_mention 提到 bot，各自触发', () => {
      expect(triggeredBy(rich(para('今天找小诺聊天')))).toBe(true);
      expect(isTriggered(message(rich(para('NORI 在吗'))), { bot, wakeWords })).toBe(true);
      expect(triggeredBy(rich({ type: 'heading', text: '问小诺', size: 2 }))).toBe(true);
      expect(
        triggeredBy(
          rich(
            para(['问一下 ', { type: 'mention', text: '@NORI_BOT', username: 'nori_bot' }, '。']),
          ),
        ),
      ).toBe(true);
      expect(triggeredBy(rich(para('看这里 @nori_bot')))).toBe(true);
      expect(triggeredBy(rich(para([mentionOf(botUser), ' 看看'])))).toBe(true);
    });

    it('都没有不触发；@用户名后面紧跟字母数字下划线的不算；text_mention 提到别人不算', () => {
      expect(triggeredBy(rich(para('今天天气不错')))).toBe(false);
      expect(triggeredBy(rich(para('@nori_bot2 你好')))).toBe(false);
      expect(triggeredBy(rich(para('@nori_bot_x 你好')))).toBe(false);
      expect(triggeredBy(rich(para([mentionOf(bob), ' 看看'])))).toBe(false);
      expect(triggeredBy(rich({ type: 'anchor', name: 'a' }))).toBe(false);
    });

    it('私聊照常触发；回复 bot 的富文本消息照常触发', () => {
      expect(triggeredBy({ ...rich(para('随便说说')), chat: { id: 11, type: 'private' } })).toBe(
        true,
      );
      const botMessage = { message_id: 3, date: 0, chat: group, from: botUser, text: '我是 bot' };
      expect(triggeredBy({ ...rich(para('为什么')), reply_to_message: botMessage })).toBe(true);
    });
  });

  it('bot 身份还没拿到时，只有私聊与唤醒词能触发', () => {
    const raw = message({ text: '@nori_bot 你好' });
    expect(isTriggered(raw, { bot: {}, wakeWords: ['小诺'] })).toBe(false);
    expect(isTriggered(message({ text: '小诺' }), { bot: {}, wakeWords: ['小诺'] })).toBe(true);
  });
});

describe('长消息拆分', () => {
  it('不超过上限时原样一段', () => {
    expect(splitMessage('你好', 10)).toEqual(['你好']);
    expect(splitMessage('1234567890', 10)).toEqual(['1234567890']);
  });

  it('优先在后半段的换行处断开；没有合适的换行时按长度断', () => {
    expect(splitMessage('12345678\n12345', 10)).toEqual(['12345678\n', '12345']);
    expect(splitMessage('12\n345678901234', 10)).toEqual(['12\n3456789', '01234']);
  });

  it('换行恰好在第 limit + 1 个字符处：不把它塞进第一段，每段都不超过上限', () => {
    expect(splitMessage('1234567890\nab', 10)).toEqual(['1234567890', '\nab']);
    expect(splitMessage('123456789\nab', 10)).toEqual(['123456789\n', 'ab']);
  });

  it('真实上限下的长回复（A×4096、换行、B×3000、换行、C×100）：每段不超过 4096，拼回去与原文相同', () => {
    const text = `${'A'.repeat(4096)}\n${'B'.repeat(3000)}\n${'C'.repeat(100)}`;

    const chunks = splitMessage(text);

    expect(chunks.every((chunk) => chunk.length <= telegramMessageLimit)).toBe(true);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('A'.repeat(4096));
  });

  it('不拆开代理对，拼回去与原文相同', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(5)}`;
    const chunks = splitMessage(text, 10);
    expect(chunks).toEqual(['a'.repeat(9), `😀${'b'.repeat(5)}`]);
    expect(chunks.join('')).toBe(text);
  });
});

describe('SDK 日志转写', () => {
  it('debug 丢弃；只留简单字段，去掉可能带正文的字段，错误只留类型与消息', () => {
    const entries: Array<{ level: string; msg: string; fields: object }> = [];
    const record = (level: string) => (fields: object, msg: string) =>
      entries.push({ level, msg, fields });
    const logger = sdkLogger({
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    });

    logger.debug('Bot mentioned', { threadId: 't', text: '正文' });
    logger.child('telegram').warn('Telegram polling update processing failed', {
      error: new TypeError('fetch failed'),
      updateId: 5,
      text: '正文',
      message: '正文',
      nested: { text: '正文' },
    });
    logger.error('Message processing error', new Error('boom'));

    expect(entries).toEqual([
      {
        level: 'warn',
        msg: 'chat.warn',
        fields: {
          sdk: 'chat:telegram',
          detail: 'Telegram polling update processing failed',
          error: 'TypeError: fetch failed',
          updateId: 5,
        },
      },
      {
        level: 'error',
        msg: 'chat.error',
        fields: { sdk: 'chat', detail: 'Message processing error', error: 'Error: boom' },
      },
    ]);
  });
});
