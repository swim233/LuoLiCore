import { DefaultChatTransport } from 'ai';
import { clearUnread } from '../model/source';
import type { DataSource } from '../model/source';
import { status } from '../model/status';
import type { ChatMsg } from '../model/types';
import { bot, initLastReply } from './bot';
import { loadData } from './seed';

/* 模拟数据源：开发模式用。种子数据加 bot.ts 的定时脚本，网页对话接 Vite 中间件模拟的 /api/chat（chat-mock.ts） */
export const mockSource: DataSource = {
  kind: 'mock',
  start() {
    loadData('normal');
    status.lastReplyAt = initLastReply();
    return () => {};
  },
  chatBlocked: () => (bot.online ? null : '洛璃离线了，上线后再发'),
  chatTransport: () => new DefaultChatTransport<ChatMsg>({ api: '/api/chat' }),
  markRead: clearUnread,
};
