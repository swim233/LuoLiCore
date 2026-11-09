import { httpApi } from './api';
import { httpChatApi } from './chat-api';
import { db } from './db';
import { applyHello, applyLive, applyStatus, setGapHandler } from './live-feed';
import { setLink } from './link';
import type { DataSource } from './source';
import {
  applyMessage,
  applyReset,
  applyResync,
  applyRow,
  applyTask,
  applyTasks,
  applyTasksError,
  applyToday,
  bindApi,
  cancelTask,
  loadOlder,
  markRead,
  openConversation,
  refreshToday,
} from './sync';
import type {
  ConversationRow,
  Hello,
  LiveEvent,
  MessageEvent,
  ServerEvents,
  ServiceStatus,
  TaskRow,
  TodaySummary,
} from '../../server/types';

/* 真实的数据源：连洛璃服务。
   - 连上 SSE（GET /api/events）；每次收到 hello（第一次连上、断线重连）就重新取会话列表、今日概况和任务（hello 里没有它们）：第一次整批放进去并发 data:reset，
     断线重连后合并（已经取到的消息和阅读位置留着，补取断线期间的新消息，见 sync.ts 的 applyResync）；
   - 之后的 conversation、message、today、task 事件增量放进 db，发部件在听的总线事件；
   - hello 里的现场、status 与 live 事件交给 live-feed.ts：「此刻」、徽记、顶栏、助手的名字都从那里来；
   - 连不上时（SSE 断了，或取数据失败）连接状态是 down，部件显示「连不上洛璃服务」；EventSource 自己会重连，连上后自动恢复；
   - 今天的日期（服务器时区）变了就重新取今日概况。 */
const RETRY_MS = 3000;
const DAY_CHECK_MS = 30_000;

/** 现在在这个时区是哪一天，YYYY-MM-DD */
function dateIn(timeZone: string, now = new Date()): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return null;
  }
}

export const liveSource: DataSource = {
  kind: 'live',
  start() {
    bindApi(httpApi);
    setLink('loading');
    let es: EventSource | null = null;
    let stopped = false;
    let syncGen = 0;
    // 第一次取到数据以后，再连上（断线重连）就合并：已经取到的消息和阅读位置留着
    let synced = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    async function resync() {
      const gen = ++syncGen;
      clearTimeout(retry);
      try {
        // 任务单独取、单独算成败：取任务失败（如服务版本旧、没有这个接口）不能让整个面板变成「连不上」
        const [list, today, tasks] = await Promise.all([
          httpApi.conversations(),
          httpApi.today(),
          httpApi.tasks().then(
            (r) => ({ tasks: r.tasks }),
            (e: unknown) => ({ error: e }),
          ),
        ]);
        if (stopped || gen !== syncGen) return;
        if (synced) applyResync(list.conversations, today);
        else applyReset(list.conversations, today);
        if ('tasks' in tasks) applyTasks(tasks.tasks);
        else applyTasksError(tasks.error);
        synced = true;
        setLink('ready');
      } catch {
        if (stopped || gen !== syncGen) return;
        setLink('down');
        retry = setTimeout(resync, RETRY_MS);
      }
    }

    function on<K extends keyof ServerEvents>(
      source: EventSource,
      name: K,
      handler: (data: ServerEvents[K]) => void,
    ) {
      source.addEventListener(name, (e) => {
        let data: ServerEvents[K];
        try {
          data = JSON.parse((e as globalThis.MessageEvent<string>).data) as ServerEvents[K];
        } catch {
          return;
        }
        handler(data);
      });
    }

    function connect() {
      if (stopped) return;
      const source = new EventSource('/api/events');
      es = source;
      // hello：服务的状态加现场。「此刻」和状态按现场重建，之后的 live 事件接着它的序号；会话列表、今日概况另外取
      on(source, 'hello', (h: Hello) => {
        applyHello(h);
        void resync();
      });
      on(source, 'status', (st: ServiceStatus) => applyStatus(st));
      on(source, 'live', (ev: LiveEvent) => applyLive(ev));
      on(source, 'conversation', (row: ConversationRow) => applyRow(row));
      on(source, 'message', (ev: MessageEvent) => applyMessage(ev));
      on(source, 'today', (t: TodaySummary) => applyToday(t));
      on(source, 'task', (row: TaskRow) => applyTask(row));
      source.addEventListener('error', () => {
        if (stopped || es !== source) return;
        // 断了：显示连不上。EventSource 会自己重连；被服务拒绝（状态码不对）时它不再重连，这里补一次
        syncGen++;
        clearTimeout(retry);
        setLink('down');
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          reconnect = setTimeout(connect, RETRY_MS);
        }
      });
    }
    connect();
    // live 事件的序号接不上（理论上不会，服务积压太多会先断开）：重连，从新的现场重来
    setGapHandler(() => {
      es?.close();
      clearTimeout(reconnect);
      connect();
    });

    // 过了 0 点（服务器时区）今日概况换成新的一天：定时看一眼，页面回到前台时也看一眼
    const checkDay = () => {
      const t = db.today;
      if (stopped || !t || document.visibilityState !== 'visible') return;
      const now = dateIn(t.timeZone);
      if (now && now !== t.date) void refreshToday();
    };
    const dayTimer = setInterval(checkDay, DAY_CHECK_MS);
    document.addEventListener('visibilitychange', checkDay);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearInterval(dayTimer);
      setGapHandler(null);
      document.removeEventListener('visibilitychange', checkDay);
      es?.close();
    };
  },
  openConversation: (id) => void openConversation(id),
  loadOlder: (id, manual) => void loadOlder(id, manual),
  markRead,
  cancelTask,
  chat: httpChatApi,
};
