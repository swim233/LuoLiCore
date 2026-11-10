import { ApiError } from './api';
import type { Api } from './api';
import { bus } from './bus';
import { db, defaultTitle } from './db';
import type { MsgInfo } from './db';
import type { Conversation, MessageEvent, MsgRow, Segment, TaskRow, TodaySummary } from './types';
import type { ConversationRow } from '../../server/types';

/* 服务给的数据怎么放进 db、再变成总线事件：正式构建（live-source.ts）和开发模式（dev/mock-source.ts）共用这一份。
   - apply*：服务推来的、或接口返回的数据放进 db，发部件在听的事件；
   - openConversation、loadOlder、markRead：按需取数据，用 bindApi 绑定的那个接口。 */

let api: Api | null = null;
/** 数据源启动时绑定它的接口 */
export function bindApi(a: Api) {
  api = a;
}
/** 每次整批重置加一：之前发出的请求回来时发现换了批次就丢掉 */
let epoch = 0;
let tokenSeq = 0;
/** 一次最多取多少条消息（和服务的上限一致） */
const maxPage = 1000;

const toConv = (row: ConversationRow): Conversation => ({
  ...row,
  title: row.title || defaultTitle(row.kind),
});

/** 会话列表与今日概况整批换掉（第一次连上、开发模式切换数据；任务清空，取到了另外放，见 applyTasks）。preloaded：同时放进去的会话消息 */
export function applyReset(
  rows: ConversationRow[],
  today: TodaySummary,
  preloaded: { id: string; rows: MsgRow[]; segs: Segment[] }[] = [],
) {
  epoch++;
  db.reset();
  db.setConversations(rows.map(toConv));
  db.today = today;
  for (const p of preloaded) preload(p.id, p.rows, p.segs);
  const bulk = new Set(rows.map((r) => r.id));
  db.bulk = bulk;
  setTimeout(() => bulk.clear(), 800);
  bus.emit('data:reset', {});
  bus.emit('today:update');
  bus.emit('tasks:update');
}

/** 这一行比 db 里已有的旧：最后一条消息更靠前，或者最后一条一样但已读位置、消息数、段数更小 */
function isStale(prev: Conversation, row: ConversationRow): boolean {
  const a = prev.last?.seq ?? 0;
  const b = row.last?.seq ?? 0;
  if (a !== b) return b < a;
  return row.readSeq < prev.readSeq || row.messages < prev.messages || row.segments < prev.segments;
}

/**
 * 会话列表里的一行变了（新建、改名、切段、新消息、已读……）：整行替换。
 * 接口返回的行（标已读的响应、打开会话时的详情）可能比之后经 SSE 推来的行更晚到，所以比已有的旧的不收；
 * force：就是要换成这一行（标已读失败，还原）
 */
export function applyRow(row: ConversationRow, force = false) {
  const prev = db.conv(row.id);
  if (prev && !force && isStale(prev, row)) return;
  const conv = toConv(row);
  db.upsert(conv);
  if (!prev) {
    bus.emit('conv:add', { conv });
    return;
  }
  bus.emit('conv:update', { id: conv.id });
  if (prev.unread !== conv.unread) bus.emit('unread', { convId: conv.id });
  // 切了新段：段不单独推，打开着的会话重新取一次
  if (prev.segments !== conv.segments && db.msgInfo.has(conv.id)) void refreshSegments(conv.id);
}

/**
 * 服务刚建好的网页会话（对话的响应里先告诉了），列表还没有这一行（SSE 还没推来，不通、被缓冲时更不会来）：
 * 先放一行占位，对话好立刻切过去。消息、段、完整的这一行由 openConversation 取；SSE 推来的行、取到的行都整行换掉它
 */
export function ensureConversation(id: string, title?: string) {
  if (db.conv(id)) return;
  const now = new Date().toISOString();
  applyRow({
    id,
    platform: 'web',
    kind: 'web',
    title,
    createdAt: now,
    lastAt: now,
    messages: 0,
    segments: 0,
    unread: 0,
    readSeq: 0,
  });
}

const sameRow = (a: Conversation, b: ConversationRow) =>
  a.title === (b.title || defaultTitle(b.kind)) &&
  a.kind === b.kind &&
  a.lastAt === b.lastAt &&
  a.messages === b.messages &&
  a.segments === b.segments &&
  a.unread === b.unread &&
  a.readSeq === b.readSeq &&
  a.last?.seq === b.last?.seq;

/**
 * 断线后重新连上：会话列表与今日概况换成服务现在的，但已经取到的消息、段和打开着的时间线都留着（阅读位置不丢）：
 * - 会话行逐行比，变了的才发事件；服务里没有了的会话拿掉；
 * - 取过消息的会话补取：断线期间新来的消息按序号并进去，最近一页里被编辑过的消息就地更新；
 *   缺的消息太多（超过 1000 条）接不上时，丢掉重新取
 */
export function applyResync(rows: ConversationRow[], today: TodaySummary) {
  const ids = new Set(rows.map((r) => r.id));
  for (const c of [...db.conversations]) if (!ids.has(c.id)) applyRemoved(c.id);
  // 列表在连不上时是收起的，连上后各行一起回来，不放进场动画
  const bulk = new Set(ids);
  db.bulk = bulk;
  setTimeout(() => bulk.clear(), 800);
  for (const row of rows) {
    const prev = db.conv(row.id);
    if (!prev || !sameRow(prev, row)) applyRow(row);
  }
  applyToday(today);
  for (const id of [...db.msgInfo.keys()]) void catchUp(id);
}

/** 重新连上之后，补取一个会话断线期间的变化（见 applyResync） */
async function catchUp(convId: string) {
  const info = db.msgInfo.get(convId);
  const conv = db.conv(convId);
  if (!api || !info || !conv) return;
  if (info.state === 'error') {
    // 断线时取失败的：丢掉，时间线重新取
    db.msgInfo.delete(convId);
    db.messages.delete(convId);
    bus.emit('conv:messages', { convId });
    return;
  }
  if (info.state !== 'ready') return;
  const lastKnown = db.msgs(convId).at(-1)?.seq ?? 0;
  const need = (conv.last?.seq ?? 0) - lastKnown;
  if (need > maxPage) {
    db.msgInfo.delete(convId);
    db.messages.delete(convId);
    bus.emit('conv:messages', { convId });
    return;
  }
  const myEpoch = epoch;
  try {
    const page = await api.messages(convId, { limit: Math.max(200, need) });
    if (myEpoch !== epoch || db.msgInfo.get(convId) !== info) return;
    for (const m of page.messages) upsertRow(convId, m);
    bus.emit('conv:messages', { convId });
  } catch {
    /* 下次重连再补；已取到的照常显示 */
  }
}

/** 一条消息写入（按序号插入）或被编辑（就地更新） */
export function applyMessage({ conversationId: id, message, edited }: MessageEvent) {
  const info = db.msgInfo.get(id);
  let changed = false;
  if (info?.state === 'loading') info.pending.push(message);
  else if (info?.state === 'ready') {
    upsertRow(id, message);
    changed = true;
  }
  if (!edited) bus.emit('message', { convId: id, row: message, trigger: message.role === 'user' });
  else if (changed) bus.emit('conv:messages', { convId: id });
}

export function applyToday(t: TodaySummary) {
  db.today = t;
  bus.emit('today:update');
}

/** 这一行比 db 里已有的旧：接口返回的和 SSE 推来的先后不一定。结束了的不会回到进行中，到点次数只增不减 */
function isStaleTask(prev: TaskRow, row: TaskRow): boolean {
  if (prev.status !== 'active') return row.status === 'active';
  return row.status === 'active' && row.dueCount < prev.dueCount;
}
/** 整批换成这些任务：每行比已有的旧就不收；取任务的期间刚建好的（事件先到了）、还没在这批里的进行中的任务留着 */
function putTasks(rows: TaskRow[]) {
  const next = new Map<number, TaskRow>();
  for (const row of rows) {
    const prev = db.tasks.get(row.id);
    next.set(row.id, prev && isStaleTask(prev, row) ? prev : row);
  }
  for (const [id, t] of db.tasks) if (!next.has(id) && t.status === 'active') next.set(id, t);
  db.tasks = next;
}
/** 任务整批换了（连上、重连后重新取到的）：取任务的状态也成了「取到了」 */
export function applyTasks(rows: TaskRow[]) {
  putTasks(rows);
  // 整批到的（第一次连上、重连后重新取的）直接出现，不放进场动画；之后新来的任务才放
  const bulk = new Set<number | string>(rows.flatMap((r) => [r.id, r.conversation.id]));
  db.taskBulk = bulk;
  setTimeout(() => db.taskBulk === bulk && bulk.clear(), 800);
  db.taskLoad = { state: 'ready' };
  bus.emit('tasks:update');
}
/** 取任务失败：只有任务部件和全屏会话头部的任务数受影响（见 Db.taskLoad）。已经取到的任务留在 db 里，但界面不再显示它们 */
export function applyTasksError(e: unknown) {
  db.taskLoad = {
    state: 'error',
    status: e instanceof ApiError ? e.status : 0,
    message: e instanceof Error ? e.message : String(e),
  };
  bus.emit('tasks:update');
}
/** 一个任务新建了或变了（到点、完成、取消）：整行替换；接口返回的行可能比 SSE 推来的晚到，旧的不收。
    上次取任务失败了（版本旧、没取到），来了任务事件说明服务能给了：再取一次 */
export function applyTask(row: TaskRow) {
  if (db.taskLoad.state === 'error') {
    void refreshTasks();
    return;
  }
  const prev = db.tasks.get(row.id);
  if (prev && isStaleTask(prev, row)) return;
  db.tasks.set(row.id, row);
  bus.emit('tasks:update');
}

/** 重新取任务。失败时：silent 就留着已经取到的，不改状态（取消碰上 409 时顺带刷新）；否则标成取任务失败 */
export async function refreshTasks(silent = false) {
  if (!api) return;
  const myEpoch = epoch;
  try {
    const { tasks } = await api.tasks();
    if (myEpoch === epoch) applyTasks(tasks);
  } catch (e) {
    if (myEpoch === epoch && !silent) applyTasksError(e);
  }
}

/** 取消一个任务：成功了这一行换成取消后的样子（SSE 的 task 事件也会推一次，同样的行不要紧）；失败时抛错，说明原因。
    已经结束了（409）、没有这个任务（404）说明这边的数据旧了，重新取一次 */
export async function cancelTask(id: number) {
  if (!api) throw new Error('数据源还没有设置');
  try {
    applyTask(await api.cancelTask(id));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 404)) void refreshTasks(true);
    throw e;
  }
}

/** 会话没了（只有开发模式的演示用，真实的服务没有删除会话） */
export function applyRemoved(id: string) {
  db.remove(id);
  bus.emit('conv:remove', { id });
}

/** 直接放进一个会话的全部消息（开发模式里网页对话的历史，对话部件一创建就要读） */
export function preload(convId: string, rows: MsgRow[], segs: Segment[]) {
  db.messages.set(convId, [...rows]);
  db.segments.set(convId, segs);
  db.msgInfo.set(convId, {
    state: 'ready',
    hasMore: false,
    older: 'idle',
    pending: [],
    token: ++tokenSeq,
  });
}

/** 按序号放进已取到的消息：同一条（id 相同）就地替换，新的按序号插进去 */
function upsertRow(convId: string, message: MsgRow) {
  let rows = db.messages.get(convId);
  if (!rows) db.messages.set(convId, (rows = []));
  const i = rows.findIndex((r) => r.id === message.id);
  if (i >= 0) {
    rows[i] = message;
    return;
  }
  let pos = rows.length;
  while (pos > 0 && rows[pos - 1].seq > message.seq) pos--;
  rows.splice(pos, 0, message);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 打开一个会话：取最近一批消息和全部段；有未读时一次取到已读位置之后的第一条消息（最多 1000 条）。已经取到或在取就什么也不做 */
export async function openConversation(convId: string) {
  const conv = db.conv(convId);
  if (!api || !conv) return;
  const cur = db.msgInfo.get(convId);
  if (cur && (cur.state === 'ready' || cur.state === 'loading')) {
    // 取到的最早一条已经在已读位置之后，说明已读位置之后的第一条消息还在更早的地方；
    // 一次能取到它（不超过上限）才重新取，超过上限的重新取也没用
    const first = db.msgs(convId)[0];
    const need = (conv.last?.seq ?? 0) - conv.readSeq + 1;
    const farUnread =
      cur.state === 'ready' &&
      cur.hasMore &&
      conv.unread > 0 &&
      first !== undefined &&
      first.seq > conv.readSeq &&
      need <= maxPage;
    if (!farUnread) return;
    db.messages.delete(convId);
  }
  const info: MsgInfo = {
    state: 'loading',
    hasMore: false,
    older: 'idle',
    pending: [],
    token: ++tokenSeq,
  };
  db.msgInfo.set(convId, info);
  bus.emit('conv:messages', { convId });
  const myEpoch = epoch;
  try {
    const last = conv.last?.seq ?? 0;
    const need = conv.unread > 0 ? last - conv.readSeq + 1 : 0;
    const limit = Math.min(maxPage, Math.max(200, need));
    const [detail, page] = await Promise.all([
      api.conversation(convId),
      api.messages(convId, { limit }),
    ]);
    if (myEpoch !== epoch || db.msgInfo.get(convId) !== info) return;
    const rows = [...page.messages];
    const have = new Set(rows.map((r) => r.id));
    for (const m of info.pending) {
      const i = rows.findIndex((r) => r.id === m.id);
      if (i >= 0) rows[i] = m;
      else if (!have.has(m.id)) rows.push(m);
    }
    rows.sort((a, b) => a.seq - b.seq);
    db.messages.set(convId, rows);
    db.segments.set(convId, detail.segments);
    info.hasMore = page.hasMore;
    info.pending = [];
    info.state = 'ready';
    applyRow(detail.conversation);
  } catch (e) {
    if (myEpoch !== epoch || db.msgInfo.get(convId) !== info) return;
    info.state = 'error';
    info.error = errorText(e);
    info.pending = [];
  }
  bus.emit('conv:messages', { convId });
}

/** 往上翻：取比已经取到的最早一条更早的一批（200 条），插在上面。manual：用户点了重试 */
export async function loadOlder(convId: string, manual = false) {
  const info = db.msgInfo.get(convId);
  const first = db.msgs(convId)[0];
  if (!api || !info || info.state !== 'ready' || !info.hasMore || !first) return;
  if (info.older === 'loading' || (info.older === 'error' && !manual)) return;
  info.older = 'loading';
  bus.emit('conv:messages', { convId });
  const myEpoch = epoch;
  try {
    const page = await api.messages(convId, { before: first.seq, limit: 200 });
    if (myEpoch !== epoch || db.msgInfo.get(convId) !== info) return;
    const rows = db.msgs(convId);
    const have = new Set(rows.map((r) => r.id));
    db.messages.set(convId, [...page.messages.filter((m) => !have.has(m.id)), ...rows]);
    info.hasMore = page.hasMore;
    info.older = 'idle';
  } catch {
    if (myEpoch !== epoch || db.msgInfo.get(convId) !== info) return;
    info.older = 'error';
  }
  bus.emit('conv:messages', { convId });
}

/** 重新取一个会话的全部段（会话行里的段数变了） */
async function refreshSegments(convId: string) {
  if (!api) return;
  const myEpoch = epoch;
  try {
    const detail = await api.conversation(convId);
    if (myEpoch !== epoch || !db.conv(convId)) return;
    db.segments.set(convId, detail.segments);
    bus.emit('conv:messages', { convId });
  } catch {
    /* 下次打开时会重新取 */
  }
}

const marking = new Map<string, number>();
/** 已经看到了这个会话的第 seq 条：先在本地清零，再告诉服务；服务返回的行是准的。失败就还原 */
export function markRead(convId: string, seq: number) {
  const conv = db.conv(convId);
  if (!api || !conv) return;
  if (seq <= conv.readSeq || (marking.get(convId) ?? -1) >= seq) return;
  marking.set(convId, seq);
  if (seq >= (conv.last?.seq ?? 0)) applyRow({ ...conv, readSeq: seq, unread: 0 });
  api
    .markRead(convId, seq)
    .then((row) => applyRow(row))
    .catch(() => {
      const now = db.conv(convId);
      if (now && now.readSeq === seq) applyRow(conv, true);
    })
    .finally(() => {
      if (marking.get(convId) === seq) marking.delete(convId);
    });
}

/** 页面里已经取到的这个会话最近的 n 条消息（同步读，不向服务取）；这个会话的消息还没取到过时返回 null */
export function cachedRecentMessages(convId: string, n: number): MsgRow[] | null {
  return db.msgInfo.get(convId)?.state === 'ready' ? db.msgs(convId).slice(-n) : null;
}

/** 一个会话最近的 n 条消息（「此刻」里一个会话开头的几行）：已经取到的直接用，没有就向服务取；取不到是空的。
    fresh：一定向服务取（断开期间可能有新消息，已经取到的不是最新的）。
    要在页面里已经有缓存时马上拿到（不等一个微任务），先调 cachedRecentMessages */
export async function recentMessages(convId: string, n: number, fresh = false): Promise<MsgRow[]> {
  const cached = cachedRecentMessages(convId, n);
  if (cached && !fresh) return cached;
  if (!api) return cached ?? [];
  try {
    return (await api.messages(convId, { limit: n })).messages;
  } catch {
    return cached ?? [];
  }
}

/** 重新取今日概况 */
export async function refreshToday() {
  if (!api) return;
  const myEpoch = epoch;
  try {
    const t = await api.today();
    if (myEpoch === epoch) applyToday(t);
  } catch {
    /* 连不上时由数据源的连接状态提示 */
  }
}
