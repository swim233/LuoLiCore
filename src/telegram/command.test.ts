import { describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import { parseCommand } from './command.js';
import type { TelegramRaw } from './message.js';

const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice' };
const bot = { id: '999', username: 'nori_bot' };

function message(fields: Partial<TelegramRaw>): TelegramRaw {
  return { message_id: 7, date: 1793340120, chat: group, from: alice, ...fields };
}

describe('认指令（Telegram）', () => {
  it.each([
    ['/compact', 'compact'],
    ['/clear', 'clear'],
    [' /CLEAR ', 'clear'],
    ['\n/compact\t', 'compact'],
    ['/clear@nori_bot', 'clear'],
    ['/Clear@NORI_BOT', 'clear'],
    ['/COMPACT@Nori_Bot', 'compact'],
  ] as const)('%j 是指令 %s', (text, command) => {
    expect(parseCommand(message({ text }), bot)).toBe(command);
  });

  it.each([
    '/clear@other_bot',
    '/clear@nori_bott',
    '/clear@',
    '/clear 现在',
    '/compact 重点记住旅行计划',
    '/clear@nori_bot 现在',
    '/clearx',
    '/clear_all',
    '请 /clear',
    '/ clear',
    '/start',
    '/help@nori_bot',
    'clear',
    '',
  ])('%j 不是指令', (text) => {
    expect(parseCommand(message({ text }), bot)).toBeUndefined();
  });

  it('还不知道自己的用户名（getMe 还没成功过）：带 @ 的不算，不带 @ 的照样算', () => {
    for (const identity of [{}, { id: '999' }]) {
      expect(parseCommand(message({ text: '/clear@nori_bot' }), identity)).toBeUndefined();
      expect(parseCommand(message({ text: '/clear' }), identity)).toBe('clear');
    }
  });

  it('写在图片说明里的、相册、没有发送者的都不是', () => {
    const photo = [{ file_id: 'p', width: 8, height: 8 }];
    expect(parseCommand(message({ photo, caption: '/clear' }), bot)).toBeUndefined();
    expect(
      parseCommand(message({ photo, caption: '/clear', media_group_id: 'g' }), bot),
    ).toBeUndefined();
    expect(parseCommand(message({ text: '/clear', from: undefined }), bot)).toBeUndefined();
  });

  it('私聊、论坛话题里同样认', () => {
    const privateChat: TelegramChat = { id: 11, type: 'private', first_name: 'Alice' };
    expect(parseCommand(message({ chat: privateChat, text: '/compact' }), bot)).toBe('compact');
    expect(
      parseCommand(
        message({ text: '/clear@nori_bot', is_topic_message: true, message_thread_id: 77 }),
        bot,
      ),
    ).toBe('clear');
  });
});
