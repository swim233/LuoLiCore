import { DefaultChatTransport } from 'ai';
import { clearUnread } from './source';
import type { DataSource } from './source';
import type { ChatMsg } from './types';

/* 空数据源：正式构建里用到第 4 步之前。没有会话、没有事件，部件都是空状态 */
export const emptySource: DataSource = {
  kind: 'empty',
  start() {
    return () => {};
  },
  chatBlocked: () => '还没有连上洛璃服务',
  chatTransport: () => new DefaultChatTransport<ChatMsg>({ api: '/api/chat' }),
  markRead: clearUnread,
};
