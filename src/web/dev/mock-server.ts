import { pad2, startOfDay, uid } from '@luoli/ui/util';
import { ApiError } from '../model/api';
import type { Api } from '../model/api';
import { defaultTitle } from '../model/db';
import { textOf } from '../model/parts';
import type { NewCall, NewMessage } from '../model/source';
import type {
  ApiSegment,
  ConvKind,
  ImagePart,
  ImageInfo,
  MessageEvent,
  ModelCall,
  MsgRow,
  TaskBrief,
  TaskRow,
  TodaySummary,
} from '../model/types';
import type { ConversationRow } from '../../server/types';

/* 模拟的洛璃服务：开发模式里「服务端」的数据都在这里，结构和接口返回的一样（ConversationRow、ApiMessage、ApiSegment、TodaySummary）。
   实现和真实的服务同一个 Api 接口，所以客户端取数据、翻页、标记已读走的是和正式构建同一份代码；
   写入（演示的模拟 bot、种子数据、网页对话）之后，像真实的服务那样把变化推给客户端（hooks）。
   消息分批取、未读按已读位置算（只算 Telegram 里别人发的）、今日概况按本机今天算，都和服务一致。 */

interface MockConv {
  id: string;
  platform: string;
  kind: ConvKind;
  title?: string;
  platformConversationId?: string;
  createdAt: string;
  msgs: MsgRow[];
  segs: ApiSegment[];
  nextSeq: number;
  readSeq: number;
}
export interface MockHooks {
  conversation(row: ConversationRow): void;
  message(ev: MessageEvent): void;
  today(t: TodaySummary): void;
  task(row: TaskRow): void;
  removed(id: string): void;
}

/** 模拟的网络延迟：能看到「加载中」 */
const LATENCY = 160;
const delay = (ms = LATENCY) => new Promise<void>((res) => setTimeout(res, ms));
const PREVIEW_CHARS = 80;

/** 开发模式里图片用色块：画成 SVG 的数据地址，页面里就是一张普通的图 */
export function svgImage(img: ImagePart): ImageInfo {
  const d = img.demo ?? { h1: 230, h2: 40, label: '图片', w: 1280, h: 960 };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${d.h1},45%,22%)"/><stop offset="1" stop-color="hsl(${d.h2},50%,35%)"/></linearGradient>` +
    `<radialGradient id="a" cx=".7" cy=".3" r=".6"><stop offset="0" stop-color="hsl(${d.h2},80%,75%)" stop-opacity=".9"/><stop offset="1" stop-color="hsl(${d.h2},80%,75%)" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="b" cx=".2" cy=".8" r=".7"><stop offset="0" stop-color="hsl(${d.h1},60%,45%)" stop-opacity=".95"/><stop offset="1" stop-color="hsl(${d.h1},60%,45%)" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#b)"/><rect width="100%" height="100%" fill="url(#a)"/>` +
    `<text x="${d.w * 0.03}" y="${d.h * 0.96}" font-family="sans-serif" font-size="${Math.round(d.h / 14)}" fill="rgba(255,255,255,.8)">${d.label.replace(/[<&>]/g, '')}</text></svg>`;
  return { src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), width: d.w, height: d.h };
}

/** 工具结果的文字：开头是摘要，补到大约 chars 个字符 */
export function toolBody(summary: string, chars: number): string {
  const filler =
    '页面正文的一段内容，这里是模拟的工具结果，用来看长结果在时间线里怎么折叠、怎么截短。';
  let s = summary + '\n\n';
  while (s.length < chars) s += filler;
  return s.slice(0, Math.max(chars, summary.length));
}

/* ---------- 任务：和服务的 describeSchedule、nextDue 同一种说法（时间按这台机器的时区，开发模式里它就是「服务器」） ---------- */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const mdOf = (d: Date) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const stampOf = (ms: number) =>
  `${mdOf(new Date(ms))} ${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
export function describeSchedule(s: TaskRow['schedule']): string {
  if (s.kind === 'once') return '一次性';
  const base =
    s.kind === 'daily'
      ? `每天 ${s.time}`
      : s.kind === 'weekdays'
        ? `每个工作日 ${s.time}`
        : s.kind === 'weekly'
          ? `每周${WEEK[s.weekday % 7]} ${s.time}`
          : `每月 ${s.day} 号 ${s.time}`;
  return s.until ? `${base}，到 ${mdOf(new Date(s.until))} 为止` : base;
}
/** 在 after 之后第一次到点；一次性的 at 已经过了、周期的过了截止时没有 */
export function nextDue(s: TaskRow['schedule'], after: number): number | undefined {
  if (s.kind === 'once') return Date.parse(s.at) > after ? Date.parse(s.at) : undefined;
  const [hh, mm] = s.time.split(':').map(Number);
  const until = s.until ? Date.parse(s.until) : Infinity;
  const base = new Date(after);
  for (let i = 0; i <= 400; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const wd = day.getDay() === 0 ? 7 : day.getDay();
    const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    const hit =
      s.kind === 'daily' ||
      (s.kind === 'weekdays' && wd <= 5) ||
      (s.kind === 'weekly' && wd === s.weekday) ||
      (s.kind === 'monthly' && day.getDate() === Math.min(s.day, last));
    if (!hit) continue;
    const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm).getTime();
    if (t <= after) continue;
    return t > until ? undefined : t;
  }
  return undefined;
}
export interface NewMockTask {
  convId: string;
  action: string;
  schedule: TaskRow['schedule'];
  by: { id?: string; name: string };
  createdAt?: number;
  /** 不给时按 schedule 算下次到点；给了就是这个状态（种子数据里已经结束的任务） */
  state?: Partial<Pick<TaskRow, 'status' | 'nextDueAt' | 'lastDueAt' | 'dueCount' | 'endedAt'>>;
}
const THIRTY_DAYS = 30 * 864e5;

export class MockServer implements Api {
  private convs = new Map<string, MockConv>();
  private taskMap = new Map<number, TaskRow>();
  private taskSeq = 0;
  /** 演示：取任务失败时的 HTTP 状态码（演示面板切换），null 为正常 */
  tasksFail: number | null = null;
  private calls: ModelCall[] = [];
  hooks: MockHooks | null = null;
  /** true：写入不推事件（灌种子数据时） */
  silent = false;
  private queue: (() => void)[] | null = null;
  private queuedRows = new Set<string>();
  private unreadPlan = new Map<string, number>();

  /* ---------- 推事件 ---------- */
  private fire(fn: () => void) {
    if (this.silent || !this.hooks) return;
    if (this.queue) this.queue.push(fn);
    else fn();
  }
  /** 里面的写入攒着，结束时一次推出去（同一个会话的行只推最后一次）：一个会话刚建出来时带着段，别推半成品 */
  batch(fn: () => void) {
    if (this.queue) return fn();
    this.queue = [];
    this.queuedRows.clear();
    try {
      fn();
    } finally {
      const q = this.queue;
      this.queue = null;
      this.queuedRows.clear();
      for (const f of q) f();
    }
  }
  private pushRow(id: string) {
    if (this.queue) {
      if (this.queuedRows.has(id)) return;
      this.queuedRows.add(id);
    }
    this.fire(() => {
      if (this.convs.has(id)) this.hooks!.conversation(this.rowOf(id));
    });
  }

  /* ---------- 写入 ---------- */
  has(id: string) {
    return this.convs.has(id);
  }
  conv(id: string) {
    return this.convs.get(id);
  }
  all() {
    return [...this.convs.values()];
  }
  addConv({
    platform,
    kind,
    title,
    chatId,
    at = Date.now(),
    id,
  }: {
    platform: string;
    kind: ConvKind;
    title?: string;
    chatId?: string;
    at?: number;
    id?: string;
  }) {
    const c: MockConv = {
      id: id || uid('conv'),
      platform,
      kind,
      title,
      platformConversationId: chatId,
      createdAt: new Date(at).toISOString(),
      msgs: [],
      segs: [],
      nextSeq: 1,
      readSeq: 0,
    };
    this.convs.set(c.id, c);
    this.pushRow(c.id);
    return c;
  }
  removeConv(id: string) {
    if (!this.convs.delete(id)) return;
    this.fire(() => this.hooks!.removed(id));
  }
  setTitle(id: string, title: string) {
    const c = this.convs.get(id);
    if (!c) return;
    c.title = title;
    this.pushRow(id);
  }
  addSeg(
    convId: string,
    reason: ApiSegment['startReason'],
    at: number,
    summary: string | null,
  ): ApiSegment {
    const c = this.convs.get(convId)!;
    const seg: ApiSegment = {
      startSeq: c.nextSeq,
      startReason: reason,
      conversationTitle: c.title,
      ...(summary ? { priorSummary: summary } : {}),
      createdAt: new Date(at).toISOString(),
    };
    c.segs.push(seg);
    this.pushRow(convId);
    return seg;
  }
  /** 预留一个序号（回复开始时，和 core 一样）：回复写入时用它，生成期间写入的消息排在回复后面 */
  reserve(convId: string): number {
    return this.convs.get(convId)!.nextSeq++;
  }
  addMsg(convId: string, m: NewMessage, seq?: number): MsgRow | null {
    const c = this.convs.get(convId);
    if (!c) return null;
    const id = m.id ?? uid('msg');
    const createdAt = new Date(m.at ?? Date.now()).toISOString();
    const message = {
      id,
      role: m.role,
      parts: m.parts,
      metadata: {
        createdAt,
        ...(m.role === 'user' && m.author ? { author: m.author } : {}),
        ...(m.event ? { event: m.event } : {}),
        ...(m.meta?.aborted ? { aborted: true as const } : {}),
        ...(m.meta?.failed ? { failed: true as const } : {}),
        ...(m.meta?.usage ? { usage: m.meta.usage } : {}),
        ...(m.meta?.reasoningMs ? { reasoningMs: m.meta.reasoningMs } : {}),
      },
    } as MsgRow['message'];
    const row: MsgRow = {
      seq: seq ?? c.nextSeq++,
      id,
      role: m.role,
      createdAt,
      message,
      tools: m.tools ?? {},
      images: m.images ?? {},
      ...(m.event && this.taskMap.has(m.event.taskId)
        ? { task: this.briefOf(this.taskMap.get(m.event.taskId)!) }
        : {}),
    };
    // 按序号插入（预留过序号的回复比后来写入的消息序号小）
    let pos = c.msgs.length;
    while (pos > 0 && c.msgs[pos - 1].seq > row.seq) pos--;
    c.msgs.splice(pos, 0, row);
    this.fire(() => {
      this.hooks!.message({ conversationId: convId, message: row, edited: false });
      this.hooks!.conversation(this.rowOf(convId));
    });
    return row;
  }
  addCall(row: NewCall) {
    this.calls.push(
      Object.assign({ id: this.calls.length + 1, purpose: 'reply', model: '' }, row) as ModelCall,
    );
    this.fire(() => this.hooks!.today(this.todayNow()));
  }
  /** 灌完种子数据后调用 settle 时，让这个会话最后 n 条用户消息是未读 */
  setUnread(convId: string, n: number) {
    this.unreadPlan.set(convId, n);
  }
  /** 种子数据灌完：现有的每个会话都算看完了（和服务第一次打开 web.db 一样），再按 setUnread 留下几个未读 */
  settle() {
    for (const c of this.convs.values()) {
      c.readSeq = c.msgs.at(-1)?.seq ?? 0;
      const n = this.unreadPlan.get(c.id);
      if (n === undefined || n <= 0) continue;
      const users = c.msgs.filter((m) => m.role === 'user' && !m.message.metadata?.event);
      const firstUnread = users[users.length - n];
      if (firstUnread) c.readSeq = firstUnread.seq - 1;
    }
    this.unreadPlan.clear();
  }
  reset() {
    this.convs.clear();
    this.taskMap.clear();
    this.taskSeq = 0;
    this.calls = [];
    this.unreadPlan.clear();
  }

  /* ---------- 任务 ---------- */
  briefOf(t: TaskRow): TaskBrief {
    return { id: t.id, ref: t.ref, action: t.action, scheduleText: t.scheduleText };
  }
  task(id: number) {
    return this.taskMap.get(id);
  }
  /** 这个会话进行中的任务 */
  activeTasks(convId: string) {
    return [...this.taskMap.values()].filter(
      (t) => t.status === 'active' && t.conversation.id === convId,
    );
  }
  /** 接口返回的：进行中的，加上最近 30 天里结束的，按 id 排 */
  taskRows(): TaskRow[] {
    const since = Date.now() - THIRTY_DAYS;
    return [...this.taskMap.values()]
      .filter((t) => t.status === 'active' || Date.parse(t.endedAt ?? '') >= since)
      .sort((a, b) => a.id - b.id);
  }
  private putTask(row: TaskRow) {
    this.taskMap.set(row.id, row);
    this.fire(() => this.hooks!.task(row));
  }
  /** 新建一个任务（工具 create_task 的结果）：进行中，推 task 事件 */
  addTask(n: NewMockTask): TaskRow {
    const c = this.convs.get(n.convId)!;
    const id = ++this.taskSeq;
    const created = n.createdAt ?? Date.now();
    const status = n.state?.status ?? 'active';
    const next =
      status === 'active' ? nextDue(n.schedule, Math.max(created, Date.now())) : undefined;
    const row: TaskRow = {
      id,
      ref: 't' + id,
      action: n.action,
      scheduleText: describeSchedule(n.schedule),
      conversation: {
        id: c.id,
        platform: c.platform,
        kind: c.kind,
        ...(c.title ? { title: c.title } : {}),
      },
      schedule: n.schedule,
      status,
      ...(status === 'active'
        ? { nextDueAt: n.state?.nextDueAt ?? (next ? new Date(next).toISOString() : undefined) }
        : {}),
      ...(n.state?.lastDueAt ? { lastDueAt: n.state.lastDueAt } : {}),
      dueCount: n.state?.dueCount ?? 0,
      requestedBy: n.by,
      createdAt: new Date(created).toISOString(),
      ...(n.state?.endedAt ? { endedAt: n.state.endedAt } : {}),
    };
    this.putTask(row);
    return row;
  }
  /** 事件消息：没有发言人的用户消息，正文是写给模型看的完整句子（只写消息，不改任务） */
  addEvent(convId: string, taskId: number, type: 'task' | 'task-missed', at = Date.now()) {
    const t = this.taskMap.get(taskId);
    if (!t) return null;
    const who = t.requestedBy.id
      ? `${t.requestedBy.name}（uid ${t.requestedBy.id}）`
      : t.requestedBy.name;
    const kind = t.schedule.kind === 'once' ? '一次性任务' : `周期任务（${t.scheduleText}）`;
    const due = t.lastDueAt ? stampOf(Date.parse(t.lastDueAt)) : stampOf(at);
    const text =
      type === 'task'
        ? `任务到点：${t.action}。${who}在 ${stampOf(Date.parse(t.createdAt))} 让你建的，${kind}。`
        : t.schedule.kind === 'once'
          ? `任务超时：${t.action}（本该 ${due} 到点，那时洛璃服务没在运行）。这个一次性任务已经结束。`
          : `任务超时：${t.action}（${t.scheduleText}；本该 ${due} 到点，那时洛璃服务没在运行）。`;
    return this.addMsg(convId, {
      role: 'user',
      parts: [{ type: 'text', text }],
      event: { type, taskId },
      at,
    });
  }
  /**
   * 到点（task）或任务超时（task-missed）：写事件消息，改任务（一次性的完成；周期的下次到点往后挪，到点的次数加一），推 task 事件。
   * 返回事件消息。顺序同真实的服务：事件消息先写，任务的新样子接着推
   */
  fireTask(taskId: number, type: 'task' | 'task-missed'): MsgRow | null {
    const t = this.taskMap.get(taskId);
    if (!t || t.status !== 'active') return null;
    const now = Date.now();
    const due = t.nextDueAt ?? new Date(now).toISOString();
    const row = this.addEvent(t.conversation.id, taskId, type, now);
    const next =
      type === 'task' || t.schedule.kind !== 'once' ? nextDue(t.schedule, now) : undefined;
    const upd: TaskRow = { ...t };
    if (type === 'task') {
      upd.dueCount = t.dueCount + 1;
      upd.lastDueAt = due;
    }
    if (next) upd.nextDueAt = new Date(next).toISOString();
    else {
      upd.status = 'done';
      upd.endedAt = new Date(now).toISOString();
      delete upd.nextDueAt;
    }
    this.putTask(upd);
    return row;
  }
  /** 最近一条助手消息所在的会话与时间（模拟「上次回复」的初始值） */
  lastAssistant(): { conversationId: string; at: string } | undefined {
    let best: { conversationId: string; at: string } | undefined;
    for (const c of this.convs.values())
      for (const m of c.msgs)
        if (
          m.role === 'assistant' &&
          !m.message.metadata?.failed &&
          !m.message.metadata?.aborted &&
          (!best || Date.parse(m.createdAt) > Date.parse(best.at))
        )
          best = { conversationId: c.id, at: m.createdAt };
    return best;
  }

  /* ---------- 读：和服务的接口一样 ---------- */
  private preview(m: MsgRow): ConversationRow['last'] {
    let text = textOf(m).replace(/\s+/g, ' ').trim();
    if (text.length > PREVIEW_CHARS) text = text.slice(0, PREVIEW_CHARS);
    else if (!text && m.message.parts.some((p) => p.type === 'file')) text = '[图片]';
    const event = m.message.metadata?.event?.type;
    return {
      seq: m.seq,
      createdAt: m.createdAt,
      role: m.role,
      ...(m.role === 'user' && m.message.metadata?.author && !event
        ? { author: m.message.metadata.author.name }
        : {}),
      ...(event ? { event } : {}),
      text,
    };
  }
  rowOf(id: string): ConversationRow {
    const c = this.convs.get(id)!;
    const last = c.msgs.at(-1);
    const unread =
      c.kind === 'group' || c.kind === 'private'
        ? c.msgs.filter((m) => m.seq > c.readSeq && m.role === 'user' && !m.message.metadata?.event)
            .length
        : 0;
    return {
      id: c.id,
      platform: c.platform,
      kind: c.kind,
      ...(c.title ? { title: c.title } : {}),
      ...(c.platformConversationId ? { platformConversationId: c.platformConversationId } : {}),
      createdAt: c.createdAt,
      lastAt: last?.createdAt ?? c.createdAt,
      ...(last ? { last: this.preview(last) } : {}),
      messages: c.msgs.length,
      segments: c.segs.length,
      unread,
      readSeq: c.readSeq,
    };
  }
  rows(): ConversationRow[] {
    return [...this.convs.keys()]
      .map((id) => this.rowOf(id))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }
  todayNow(): TodaySummary {
    const t0 = startOfDay(Date.now());
    let replies = 0,
      failed = 0,
      input = 0,
      cache = 0,
      output = 0;
    const per = new Map<string, number>();
    for (const c of this.calls) {
      if (Date.parse(c.started_at) < t0) continue;
      input += c.input_tokens || 0;
      cache += c.cache_read_tokens || 0;
      output += c.output_tokens || 0;
      if (c.purpose !== 'reply') continue;
      if (c.outcome === 'completed') {
        replies++;
        per.set(c.conversation_id, (per.get(c.conversation_id) || 0) + 1);
      }
      if (c.outcome === 'failed') failed++;
    }
    const d = new Date(t0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      since: d.toISOString(),
      replies,
      failedReplies: failed,
      inputTokens: input,
      cacheReadTokens: cache,
      outputTokens: output,
      conversations: [...per]
        .filter(([id]) => this.convs.has(id))
        .map(([id, n]) => {
          const c = this.convs.get(id)!;
          return { id, title: c.title ?? defaultTitle(c.kind), replies: n };
        })
        .sort((a, b) => b.replies - a.replies),
    };
  }

  async conversations() {
    await delay(40);
    return { conversations: this.rows() };
  }
  async conversation(id: string) {
    await delay();
    const c = this.convs.get(id);
    if (!c) throw new Error('没有这个会话');
    return { conversation: this.rowOf(id), segments: [...c.segs] };
  }
  async messages(id: string, { before, limit = 200 }: { before?: number; limit?: number }) {
    await delay();
    const c = this.convs.get(id);
    if (!c) throw new Error('没有这个会话');
    const pool = before === undefined ? c.msgs : c.msgs.filter((m) => m.seq < before);
    const messages = pool.slice(Math.max(0, pool.length - limit));
    return { messages, hasMore: pool.length > limit };
  }
  async markRead(id: string, seq: number) {
    await delay(60);
    const c = this.convs.get(id);
    if (!c) throw new Error('没有这个会话');
    const last = c.msgs.at(-1)?.seq ?? 0;
    c.readSeq = Math.max(c.readSeq, Math.min(seq, last));
    const row = this.rowOf(id);
    this.fire(() => this.hooks!.conversation(row));
    return row;
  }
  async today() {
    await delay(40);
    return this.todayNow();
  }
  /** 演示取任务失败（版本旧的服务没有这个接口：404）时，取任务会碰到的错 */
  tasksError(): ApiError | null {
    if (!this.tasksFail) return null;
    const msg = this.tasksFail === 404 ? '没有这个接口' : `请求失败（HTTP ${this.tasksFail}）`;
    return new ApiError(msg, this.tasksFail);
  }
  async tasks() {
    await delay(60);
    const err = this.tasksError();
    if (err) throw err;
    return { tasks: this.taskRows() };
  }
  async cancelTask(id: number) {
    await delay(300);
    const t = this.taskMap.get(id);
    if (!t) throw new ApiError('没有这个任务', 404);
    if (t.status !== 'active') throw new ApiError('任务已经结束了', 409);
    const row: TaskRow = { ...t, status: 'cancelled', endedAt: new Date().toISOString() };
    delete row.nextDueAt;
    this.putTask(row);
    return row;
  }
}

export const mockServer = new MockServer();
