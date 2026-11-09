import { startOfDay, uid } from '../lib/util';
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

export class MockServer implements Api {
  private convs = new Map<string, MockConv>();
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
      const users = c.msgs.filter((m) => m.role === 'user');
      const firstUnread = users[users.length - n];
      if (firstUnread) c.readSeq = firstUnread.seq - 1;
    }
    this.unreadPlan.clear();
  }
  reset() {
    this.convs.clear();
    this.calls = [];
    this.unreadPlan.clear();
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
    return {
      seq: m.seq,
      createdAt: m.createdAt,
      role: m.role,
      ...(m.role === 'user' && m.message.metadata?.author
        ? { author: m.message.metadata.author.name }
        : {}),
      text,
    };
  }
  rowOf(id: string): ConversationRow {
    const c = this.convs.get(id)!;
    const last = c.msgs.at(-1);
    const unread =
      c.kind === 'group' || c.kind === 'private'
        ? c.msgs.filter((m) => m.seq > c.readSeq && m.role === 'user').length
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
}

export const mockServer = new MockServer();
