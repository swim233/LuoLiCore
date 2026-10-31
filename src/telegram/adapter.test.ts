import { describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUpdate, TelegramUser } from '@chat-adapter/telegram';
import { silentLogger } from '../core/index.js';
import { LuoliTelegramAdapter, sdkLogger } from './adapter.js';
import type { TelegramRaw } from './message.js';

const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice' };

function adapter() {
  const instance = new LuoliTelegramAdapter({
    botToken: '424242:FAKE-token_for_tests',
    apiUrl: 'http://127.0.0.1:9',
    mode: 'polling',
    allowedUserIds: [],
    logger: sdkLogger(silentLogger),
  });
  // 没有接上 Chat 时，基类处理更新什么也不派发，只剩我们的记录
  const process = (update: TelegramUpdate) =>
    (instance as unknown as { processUpdate(update: TelegramUpdate): unknown }).processUpdate(
      update,
    );
  return { instance, process };
}

let nextUpdateId = 1;
function albumItem(message_id: number, media_group_id = 'g', chat = group): TelegramRaw {
  return { message_id, date: 0, chat, from: alice, media_group_id, photo: [] };
}

describe('适配器记下相册的各条', () => {
  it('取回已派发的那一批（id 不大于派发的那条），按消息 id 排序；之后到的留给下一批', () => {
    const { instance, process } = adapter();
    for (const id of [11, 10, 12]) {
      process({ update_id: nextUpdateId++, message: albumItem(id) });
    }

    expect(instance.takeAlbum(albumItem(11)).map((raw) => raw.message_id)).toEqual([10, 11]);
    expect(instance.takeAlbum(albumItem(12)).map((raw) => raw.message_id)).toEqual([12]);
    // 已经取走：只返回派发的那一条
    expect(instance.takeAlbum(albumItem(12)).map((raw) => raw.message_id)).toEqual([12]);
  });

  it('不同聊天、不同相册分开记；相册里某一条的编辑不记', () => {
    const { instance, process } = adapter();
    const otherGroup = { ...group, id: -1002 };
    process({ update_id: nextUpdateId++, message: albumItem(1, 'a') });
    process({ update_id: nextUpdateId++, message: albumItem(2, 'b') });
    process({ update_id: nextUpdateId++, message: albumItem(3, 'a', otherGroup) });
    process({ update_id: nextUpdateId++, edited_message: { ...albumItem(4, 'a'), edit_date: 1 } });

    expect(instance.takeAlbum(albumItem(9, 'a')).map((raw) => raw.message_id)).toEqual([1]);
    expect(instance.takeAlbum(albumItem(9, 'b')).map((raw) => raw.message_id)).toEqual([2]);
    expect(instance.takeAlbum(albumItem(9, 'a', otherGroup)).map((raw) => raw.message_id)).toEqual([
      3,
    ]);
  });
});
