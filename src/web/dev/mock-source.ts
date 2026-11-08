import { DefaultChatTransport } from 'ai';
import type { DataSource } from '../model/source';
import { status } from '../model/status';
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
  preload,
} from '../model/sync';
import type { ChatMsg } from '../model/types';
import { bot, initLastReply } from './bot';
import { mockServer as server } from './mock-server';
import { loadData } from './seed';

/* 模拟数据源：开发模式用。数据在模拟服务里（mock-server.ts，结构和洛璃服务的接口一样），
   模拟 bot（bot.ts）的定时脚本往里写，它像真实的服务那样把变化推给客户端；
   取消息、翻页、标记已读走和正式构建同一份代码（sync.ts），只是接口换成模拟服务。
   网页对话接 Vite 中间件模拟的 /api/chat（chat-mock.ts）。 */
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
    mockSource.resync();
    status.lastReplyAt = initLastReply();
    return () => {
      server.hooks = null;
    };
  },
  /** 模拟服务的数据整批交给客户端（启动、切换数据档位） */
  resync() {
    applyReset(
      server.rows(),
      server.todayNow(),
      // 网页对话的历史：对话部件一创建就要读，直接放进去
      server
        .all()
        .filter((c) => c.kind === 'web')
        .map((c) => ({ id: c.id, rows: c.msgs, segs: c.segs })),
    );
  },
  openConversation: (id) => void openConversation(id),
  loadOlder: (id, manual) => void loadOlder(id, manual),
  markRead,
  chatBlocked: () => (bot.online ? null : '洛璃离线了，上线后再发'),
  chatTransport: () => new DefaultChatTransport<ChatMsg>({ api: '/api/chat' }),
  webChat: {
    newConv() {
      let id = '';
      server.batch(() => {
        id = server.addConv({ platform: 'web', kind: 'web', title: '新对话' }).id;
        server.addSeg(id, 'first', Date.now(), null);
      });
      const c = server.conv(id)!;
      preload(id, c.msgs, c.segs);
      return id;
    },
    setTitle: (id, title) => server.setTitle(id, title),
    addMessage: (id, m) => server.addMsg(id, m),
    addCall: (call) => server.addCall(call),
  },
};
