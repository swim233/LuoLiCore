import { pick, randi } from '../lib/util';
import { bot, nextScript, PLAIN, SCRIPTS } from './bot';
import type { Script } from './bot';
import { db } from '../model/db';
import { resetLive } from '../model/live-feed';
import { mockLive, mockStatus } from './mock-live';
import { mockServer as server } from './mock-server';
import { mockSource } from './mock-source';
import { imgPart, loadData } from './seed';
import { addWidget, nowCtl, relayout, removeWidget } from '../state/actions';
import { resetLayoutToDefault } from '../state/appearance';
import { desk, hasDef } from '../state/desk';
import { toast } from '../state/ui';
import { toggleDemo } from './demo-state';
import type { Dataset } from './demo-state';
import { TODAY_DEF } from '../widgets/today/Today';
import { resetChatState } from '../widgets/chat/chatState';

/* 演示控制的动作：用模拟事件检验自适应和动画 */
const CONV_KEYS: Record<string, { title: string; kind: 'group' | 'private'; chat: string }> = {
  'c-book': { title: '读书会', kind: 'group', chat: '-1001288361001' },
  'c-star': { title: '星空观测站', kind: 'group', chat: '-1001288362002' },
  'c-ball': { title: '周末打球', kind: 'group', chat: '-1001288363003' },
  'c-dm': { title: '与 小雨 的私聊', kind: 'private', chat: '50001002' },
};
/* 找到剧本要用的会话；数据里没有时（空数据、被删掉了），群里第一条消息到来，会话随之出现 */
function convFor(key: string) {
  if (server.has(key)) return key;
  const k = CONV_KEYS[key];
  const found = server.all().find((c) => c.title === k.title && c.kind === k.kind);
  if (found) return found.id;
  server.batch(() => {
    server.addConv({
      platform: 'telegram',
      kind: k.kind,
      title: k.title,
      chatId: k.chat,
      id: key,
    });
    server.addSeg(key, 'first', Date.now(), null);
  });
  return key;
}
function needOnline() {
  if (bot.online) return true;
  toast(
    mockStatus.enabled
      ? '连不上 Telegram：先点「bot 上线」'
      : 'Telegram 服务未启动：先点「启动 Telegram」',
  );
  return false;
}
function runScript(sc: Script, key?: string) {
  const id = convFor(sc.convId || key!);
  sc.msgs!.forEach(([u, t]) => bot.post(id, u, t, { trigger: true }));
  bot.trigger(id, sc);
  return id;
}
const NEW_GROUPS: [string, number, string][] = [
  ['摄影小组', 1001, '周末去植物园扫街，有人一起吗'],
  ['猫咪互助会', 1002, '我家猫今天学会开柜门了😂'],
  ['考研加油站', 1004, '今天背了 200 个单词，打卡'],
  ['吉他练习群', 1003, '终于把 F 和弦按响了！'],
  ['深夜食堂', 3001, '凌晨一点，谁还在煮面'],
];
let addN = 0;
/* 演示面板「新增会话」加出来的会话（「删掉会话」优先删它们） */
const demoAdded = new Set<string>();
export const ACTIONS: Record<string, () => void> = {
  plain() {
    if (!needOnline()) return;
    const key = pick(['c-book', 'c-star', 'c-ball']);
    const id = convFor(key);
    const [u, t, img] = pick(PLAIN[key]);
    bot.post(id, u, t, { image: img ? imgPart(randi(0, 360), randi(0, 360), '照片.jpg') : null });
  },
  trigger() {
    if (needOnline()) runScript(nextScript('trigger'), 'c-book');
  },
  tool() {
    if (needOnline()) runScript(nextScript('tool'));
  },
  error() {
    if (needOnline()) runScript(nextScript('error'));
  },
  retry() {
    if (needOnline()) runScript(nextScript('retry'));
  },
  two() {
    if (!needOnline()) return;
    runScript(nextScript('trigger'), 'c-book');
    setTimeout(() => {
      if (bot.online) runScript(SCRIPTS.tool[0]);
    }, 450);
  },
  online() {
    if (!mockStatus.enabled) {
      toast('Telegram 服务未启动：先点「启动 Telegram」');
      return;
    }
    bot.setOnline(!mockStatus.connected);
    toast(mockStatus.connected ? '连上 Telegram 了' : '连不上 Telegram 了：进行中的回复不受影响');
  },
  /* 没启动 Telegram 前端（没设 token）：徽记显示「空闲」，弹出框写「Telegram 服务未启动」；进行中的 Telegram 回复中止 */
  tg() {
    const on = !mockStatus.enabled;
    if (!on) bot.abortAll();
    mockStatus.setEnabled(on);
    toast(on ? '启动了 Telegram' : 'Telegram 服务未启动');
  },
  /* 断线重连：断开几秒，期间服务照常推进，重连后按现场重建「此刻」（不丢不重） */
  reconnect() {
    mockLive.connected = false;
    toast('断开了 SSE，3 秒后重连');
    setTimeout(() => {
      mockLive.connected = true;
      mockSource.resync();
    }, 3000);
  },
  widget() {
    if (hasDef('today')) removeWidget('today');
    else {
      toggleDemo(false);
      addWidget(TODAY_DEF);
    } /* 先收起面板，免得挡住新部件 */
  },
  'conv-add'() {
    if (!needOnline()) return;
    const n = randi(1, 2);
    for (let i = 0; i < n; i++) {
      const [base, u, t] = NEW_GROUPS[addN % NEW_GROUPS.length];
      const round = Math.floor(addN / NEW_GROUPS.length);
      addN++;
      let id = '';
      server.batch(() => {
        id = server.addConv({
          platform: 'telegram',
          kind: 'group',
          title: round ? `${base} ${round + 1}` : base,
          chatId: String(-1001288390000 - addN),
        }).id;
        server.addSeg(id, 'first', Date.now(), null);
      });
      demoAdded.add(id);
      setTimeout(
        () => {
          if (server.has(id)) bot.post(id, u, t);
        },
        260 + i * 320,
      );
    }
  },
  'conv-del'() {
    let victims = db.conversations.filter((c) => demoAdded.has(c.id)).slice(-2);
    if (!victims.length)
      victims = db
        .sorted()
        .filter((c) => c.platform !== 'web')
        .slice(-2);
    if (!victims.length) {
      toast('没有可以删的会话了');
      return;
    }
    for (const c of victims) {
      if (bot.runs.has(c.id)) bot.abort(c.id);
      server.removeConv(c.id); // 模拟服务通知客户端：会话没了
    }
    toast('删掉了' + victims.map((c) => '「' + c.title + '」').join(''));
  },
  'reset-layout'() {
    resetLayoutToDefault();
  },
};
export function setData(kind: Dataset) {
  bot.reset();
  mockLive.clear();
  mockLive.connected = true;
  mockStatus.reset();
  resetLive();
  loadData(kind);
  mockLive.lastReply = server.lastAssistant();
  resetChatState();
  nowCtl.cancel();
  desk.set({ nowFloat: false, floatTop: null });
  mockSource.resync();
  relayout(null, { instant: true });
  toast(
    { empty: '切换成空数据', normal: '切换成正常的数据', big: '切换成大量数据：30 个会话、长消息' }[
      kind
    ],
  );
}
