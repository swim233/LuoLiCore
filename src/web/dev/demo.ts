import { pick, randi } from '../lib/util';
import { bot, nextScript, PLAIN, SCRIPTS } from './bot';
import type { Script } from './bot';
import { db } from '../model/db';
import { resetLive } from '../model/live-feed';
import { refreshTasks } from '../model/sync';
import { resetMockChat, webTasksDue } from './mock-chat';
import { mockLive, mockStatus } from './mock-live';
import { mockServer as server } from './mock-server';
import { mockSource } from './mock-source';
import { PEOPLE, UIDS, imgPart, loadData } from './seed';
import { addWidget, nowCtl, relayout, removeWidget } from '../state/actions';
import { resetLayoutToDefault } from '../state/appearance';
import { desk, hasDef } from '../state/desk';
import { toast } from '../state/ui';
import { WEB_AUTHOR, toggleDemo } from './demo-state';
import type { Dataset } from './demo-state';
import { TODAY_DEF } from '../widgets/today/Today';
import { chatCur, resetChatState } from '../widgets/chat/chatState';
import { resetSessState } from '../widgets/sessions/sessionsState';

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
/* ---------- 任务（演示） ---------- */
/** 网页会话：对话部件里正开着的那个（在那里看得到变化），没有就用数据里第一个，再没有就建一个 */
function webConv() {
  const cur = chatCur();
  if (cur && server.has(cur)) return cur;
  const found = server.all().find((c) => c.platform === 'web');
  if (found) return found.id;
  let id = '';
  server.batch(() => {
    id = server.addConv({ platform: 'web', kind: 'web', title: '任务演示' }).id;
    server.addSeg(id, 'first', Date.now(), null);
  });
  return id;
}
/** 这个会话里 n 个进行中的任务；不够的现建一分钟后到点的一次性任务（演示按钮总能用） */
function tasksFor(convId: string, n: number): number[] {
  const ids = server.activeTasks(convId).map((t) => t.id);
  const c = server.conv(convId)!;
  const by = c.platform === 'web' ? { name: WEB_AUTHOR } : { id: UIDS[1001], name: PEOPLE[1001] };
  while (ids.length < n)
    ids.push(
      server.addTask({
        convId,
        action: ['提醒大家喝水', '提醒大家站起来活动一下', '说说今天的天气'][ids.length % 3],
        schedule: { kind: 'once', at: new Date(Date.now() + 60e3).toISOString() },
        by,
      }).id,
    );
  return ids.slice(0, n);
}
const NEW_TASKS: {
  key: string;
  action: string;
  schedule: () => Parameters<typeof server.addTask>[0]['schedule'];
}[] = [
  {
    key: 'c-book',
    action: '提醒大家周五交读书笔记',
    schedule: () => ({ kind: 'weekly', weekday: 5, time: '18:00' }),
  },
  {
    key: 'web',
    action: '提醒我下午站起来活动一下',
    schedule: () => ({ kind: 'once', at: new Date(Date.now() + 3 * 3600e3).toISOString() }),
  },
  { key: 'c-star', action: '说说明早的云量', schedule: () => ({ kind: 'daily', time: '07:45' }) },
  {
    key: 'c-dm',
    action: '提醒小雨周日晚上整理房间',
    schedule: () => ({ kind: 'weekly', weekday: 7, time: '20:30' }),
  },
];
let newTaskN = 0;
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
  /* 新建任务：模拟洛璃用 create_task 建了一个，服务推 task 事件，任务部件里立刻出现 */
  'task-new'() {
    const t = NEW_TASKS[newTaskN++ % NEW_TASKS.length];
    const id = t.key === 'web' ? webConv() : convFor(t.key);
    const c = server.conv(id)!;
    server.addTask({
      convId: id,
      action: t.action,
      schedule: t.schedule(),
      by: c.platform === 'web' ? { name: WEB_AUTHOR } : { id: UIDS[1001], name: PEOPLE[1001] },
    });
    toast(`新建任务：${t.action}`);
  },
  /* 群里任务到点：先写事件消息，再像有人触发那样等待合并，开始时带着任务 */
  'task-due'() {
    const id = convFor('c-book');
    if (!bot.dueTasks(id, tasksFor(id, 1), nextScript('due')))
      toast(
        mockStatus.enabled
          ? '连不上 Telegram：只写了事件，没有回复'
          : 'Telegram 服务未启动：只写了事件，没有回复',
      );
  },
  /* 网页会话里任务到点：没有请求接这个流，对话部件看不到逐字的过程（「此刻」里看），输入框上方写「正在回复」 */
  'task-due-web'() {
    const id = webConv();
    webTasksDue(id, tasksFor(id, 1));
  },
  /* 回复中任务到点：当前回复发完后再回复一次，补的那次带任务 */
  'task-due-busy'() {
    if (!needOnline()) return;
    const id = convFor('c-book');
    runScript(nextScript('trigger'), 'c-book');
    setTimeout(() => {
      if (bot.online) bot.dueTasks(id, tasksFor(id, 1), nextScript('due'));
    }, 3600);
  },
  /* 同时到点两个：一次回复，「此刻」里两个任务都列出来 */
  'task-due-two'() {
    const id = convFor('c-star');
    if (!bot.dueTasks(id, tasksFor(id, 2), nextScript('due')))
      toast('连不上 Telegram：只写了事件，没有回复');
  },
  /* 取任务失败：404（服务版本旧，没有这个接口）→ 500 → 恢复。只有任务部件、全屏会话头部的任务数、胶囊受影响，其余照常 */
  'task-fail'() {
    const f = server.tasksFail;
    server.tasksFail = f === null ? 404 : f === 404 ? 500 : null;
    toast(server.tasksFail ? `取任务失败：${server.tasksFail}` : '取任务恢复正常');
    void refreshTasks();
  },
  /* 任务超时：服务停着时错过的，只有事件消息和 task 事件，不回复 */
  'task-missed'() {
    const id = convFor('c-star');
    const [tid] = tasksFor(id, 1);
    server.fireTask(tid, 'task-missed');
    toast('任务超时：写了事件，没有回复');
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
  resetMockChat();
  mockLive.clear();
  mockLive.connected = true;
  mockStatus.reset();
  resetLive();
  loadData(kind);
  mockLive.lastReply = server.lastAssistant();
  resetChatState();
  resetSessState();
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
