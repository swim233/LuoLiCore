import type { DataSource } from '../model/source';
import { applyHello } from '../model/live-feed';
import {
  applyMessage,
  applyRemoved,
  applyReset,
  applyRow,
  applyToday,
  bindApi,
  loadOlder,
  markRead,
  openConversation,
} from '../model/sync';
import { mockChatApi } from './mock-chat';
import { mockLive, mockStatus } from './mock-live';
import { mockServer as server } from './mock-server';
import { loadData } from './seed';

/* 模拟数据源：开发模式用。数据在模拟服务里（mock-server.ts，结构和洛璃服务的接口一样），
   模拟 bot（bot.ts）的定时脚本往里写，它像真实的服务那样把变化推给客户端；
   取消息、翻页、标记已读走和正式构建同一份代码（sync.ts），只是接口换成模拟服务。
   网页对话的接口也在浏览器里模拟（mock-chat.ts）。 */
export const mockSource: DataSource & { resync(): void } = {
  kind: 'mock',
  start() {
    bindApi(server);
    server.hooks = {
      conversation: applyRow,
      message: applyMessage,
      today: applyToday,
      removed: applyRemoved,
    };
    loadData('normal');
    mockLive.lastReply = server.lastAssistant();
    mockSource.resync();
    return () => {
      server.hooks = null;
    };
  },
  /** 模拟服务的数据整批交给客户端（启动、切换数据档位）；「此刻」按现场重建，和真实的服务连上时一样 */
  resync() {
    applyHello(mockStatus.hello());
    applyReset(server.rows(), server.todayNow());
  },
  openConversation: (id) => void openConversation(id),
  loadOlder: (id, manual) => void loadOlder(id, manual),
  markRead,
  // 网页对话：在浏览器里模拟洛璃服务的对话接口（mock-chat.ts），和正式构建走同一份界面代码
  chat: mockChatApi,
};
