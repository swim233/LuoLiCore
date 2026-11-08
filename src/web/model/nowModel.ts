import { uid } from '../lib/util';
import { bus } from './bus';
import { db } from './db';
import { argsLine, authorOf, isFile, isReasoning, isTool, textOf, toolName } from './parts';
import { recentMessages } from './sync';
import { status } from './status';
import type { ImageInfo, MsgRow } from './types';

/* 「此刻」的数据：每个进行中的回复一份终端日志。只列正在回复的会话加上最近结束的一个。
   行由总线事件拼出来：服务推来的实时事件经 live-feed.ts 变成 reply:*、tool:* 事件（开发模式的模拟服务也一样），
   所以这里只认一种事件，时间（思考了几秒、工具用了多久）都来自事件的时间，没有兜底值。
   一个会话开头的几行是它最近的几条消息，向服务取（sync.ts 的 recentMessages），取到了排在最前面 */
export type LineKind = 'user' | 'luoli' | 'tool' | 'status' | 'think' | 'stats';
export interface Line {
  id: string;
  kind: LineKind;
  at: number;
  name?: string;
  uid?: string | null;
  text?: string;
  /** user：消息里的图；tool：工具结果里的图（服务给的地址与宽高） */
  images?: ImageInfo[];
  streaming?: boolean;
  lingerUntil?: number;
  replyId?: string;
  /** luoli、think、tool：这一行是回复里的第几段（服务事件里的 part）。重新生成时按它去掉作废的行 */
  part?: number;
  /** tool：工具名，和参数的前一截 */
  toolName?: string;
  label?: string;
  done?: boolean;
  ok?: boolean;
  /** tool：耗时；think 的秒数在 sec */
  ms?: number;
  /** tool 出错时：错误的一句话 */
  error?: string;
  sec?: number;
  aborted?: boolean;
  err?: boolean;
  retry?: boolean;
  open?: boolean;
  /** user：这一行对应哪条消息（防止同一条显示两次） */
  rowId?: string;
}
export interface Session {
  convId: string;
  /** 会话的标题：读列表里的，改名后跟着变 */
  readonly title: string;
  web: boolean;
  lines: Line[];
  started: number;
  active: boolean;
  endedAt?: number;
  replyId?: string;
  cur: Line | null;
  think: Line | null;
  tools: Map<string, Line>;
  /** 已经显示成行的消息 id */
  rows: Set<string>;
}
type Sub = (type: string, convId?: string, line?: Line, extra?: string) => void;

const sessions = new Map<string, Session>();
const subs = new Set<Sub>();
let last: Session | null = null;
/** 正在按现场重建（页面刚连上、重连）：文字行不放光标停留的动画 */
let replaying = false;
const emit: Sub = (type, convId, line, extra) =>
  subs.forEach((fn) => {
    try {
      fn(type, convId, line, extra);
    } catch (e) {
      console.error(e);
    }
  });

/** 一条消息变成终端里的几行。时间、秒数、耗时历史消息里都没有，不显示 */
function linesFromRow(row: MsgRow): Line[] {
  const at = Date.parse(row.createdAt);
  const m = row.message;
  if (row.role === 'user') {
    const author = authorOf(row);
    const images = m.parts
      .filter(isFile)
      .map((f) => row.images[f.url])
      .filter((x): x is ImageInfo => !!x);
    return [
      {
        id: uid('l'),
        kind: 'user',
        at,
        name: author?.name,
        uid: author?.id ?? null,
        text: textOf(row),
        images,
        rowId: row.id,
      },
    ];
  }
  const out: Line[] = [];
  for (const p of m.parts) {
    if (isReasoning(p))
      out.push({ id: uid('l'), kind: 'think', at, done: true, text: p.text, rowId: row.id });
    else if (isTool(p)) {
      const out_ = (p as { output?: unknown }).output;
      const images: ImageInfo[] = [];
      if (out_ && typeof out_ === 'object' && (out_ as { type?: unknown }).type === 'luoli-content')
        for (const part of ((out_ as { parts?: unknown[] }).parts ?? []) as {
          type?: string;
          url?: string;
        }[])
          if (part.type === 'image' && part.url && row.images[part.url])
            images.push(row.images[part.url]!);
      out.push({
        id: uid('l'),
        kind: 'tool',
        at,
        toolName: toolName(p),
        label: argsLine((p as { input?: unknown }).input),
        done: true,
        ok: p.state !== 'output-error',
        error:
          p.state === 'output-error'
            ? firstLine((p as { errorText?: string }).errorText)
            : undefined,
        images,
        rowId: row.id,
      });
    }
  }
  const t = textOf(row);
  if (t) out.push({ id: uid('l'), kind: 'luoli', at, text: t, rowId: row.id });
  if (m.metadata?.aborted) out.push({ id: uid('l'), kind: 'status', at, text: '回复被中止' });
  if (m.metadata?.failed)
    out.push({ id: uid('l'), kind: 'status', at, err: true, text: '出错：回复中断' });
  return out;
}
const firstLine = (s?: string) => (s ?? '').split('\n')[0].slice(0, 200) || undefined;

function newSession(convId: string, active: boolean): Session {
  return {
    convId,
    get title() {
      return db.conv(convId)?.title ?? '会话';
    },
    web: db.conv(convId)?.platform === 'web',
    lines: [],
    started: Date.now(),
    active,
    cur: null,
    think: null,
    tools: new Map(),
    rows: new Set(),
  };
}
/** 取这个会话最近的几条消息，排在已有的行前面（开头的几行用户消息，至多 8 行） */
async function seed(s: Session, fresh = false) {
  const rows = await recentMessages(s.convId, 5, fresh);
  if (sessions.get(s.convId) !== s && last !== s) return;
  const lines: Line[] = [];
  for (const r of rows) if (!s.rows.has(r.id)) lines.push(...linesFromRow(r));
  if (!lines.length) return;
  for (const r of rows) s.rows.add(r.id);
  s.lines.unshift(...lines.slice(-8));
  if (s.lines.length > 140) s.lines.splice(0, s.lines.length - 140);
  emit('seed', s.convId);
}
function ensure(convId: string) {
  let s = sessions.get(convId);
  if (!s) {
    s = newSession(convId, true);
    sessions.set(convId, s);
    emit('sessions');
    void seed(s);
  } else if (!s.active) {
    s.active = true;
    emit('sessions');
  }
  return s;
}
function push(s: Session, line: Partial<Line> & { kind: LineKind }) {
  const l = line as Line;
  l.id = l.id || uid('l');
  l.at = l.at || Date.now();
  s.lines.push(l);
  if (s.lines.length > 140) s.lines.splice(0, s.lines.length - 140);
  emit('add', s.convId, l);
  return l;
}
function endCur(s: Session) {
  if (s.cur && s.cur.streaming) {
    s.cur.streaming = false;
    if (!replaying) s.cur.lingerUntil = Date.now() + 2000;
    emit('update', s.convId, s.cur);
  }
  s.cur = null;
}
/** 没有结束的思考、工具调用：补成结束（服务会先推结束事件再推回复的结束；对话部件在开发模式里自己发的事件靠这里收尾） */
function settleOpen(s: Session) {
  if (s.think) {
    Object.assign(s.think, {
      done: true,
      aborted: true,
      sec: Math.max(1, Math.round((Date.now() - s.think.at) / 1000)),
      text: '',
    });
    emit('update', s.convId, s.think);
    s.think = null;
  }
  s.tools.forEach((l) => {
    if (!l.done) {
      Object.assign(l, { done: true, ok: false, ms: Date.now() - l.at, error: '工具调用未完成' });
      emit('update', s.convId, l);
    }
  });
}
function finish(s: Session) {
  if (replying.has(s.convId)) return;
  s.active = false;
  s.endedAt = Date.now();
  last = s;
  sessions.forEach((x, k) => {
    if (x !== s && !x.active) sessions.delete(k);
  });
  emit('sessions');
}
/* 页面开着还没有任何回复时手动展开「此刻」：显示服务说的上次回复所在的会话。开头的几行向服务取 */
function lastFromServer(): Session | null {
  const id = status.lastReplyConv;
  if (!id || !db.conv(id)) return null;
  const s = newSession(id, false);
  s.endedAt = status.lastReplyAt || undefined;
  void seed(s);
  return s;
}
/* 正在回复的会话：reply:wait、reply:start 加进来，reply:end / abort / error / cancel 先拿掉再收尾。
   回复结束后合并的下一次回复晚几百毫秒才开始，所以结束的那一刻这里没有它 */
const replying = new Set<string>();
const get = (id: string) => sessions.get(id);

bus.on('message', ({ convId, row }) => {
  const s = get(convId);
  // 助手的消息写入时回复已经在这里逐行显示过了（reply:* 事件），只加别人发的
  if (s && row && row.role === 'user' && !s.rows.has(row.id)) {
    s.rows.add(row.id);
    linesFromRow(row).forEach((l) => push(s, l));
  }
});
bus.on('reply:wait', ({ convId, replyId, noWait, at }) => {
  replying.add(convId);
  const s = ensure(convId);
  s.replyId = replyId;
  s.cur = null;
  if (!noWait) push(s, { kind: 'status', text: '等待合并', at });
  emit('sessions');
});
bus.on('reply:start', ({ convId, replyId }) => {
  replying.add(convId);
  const s = ensure(convId);
  s.replyId = replyId;
  s.cur = null;
  emit('sessions');
});
bus.on('reply:queued', ({ convId }) => {
  const s = get(convId);
  if (s) push(s, { kind: 'status', text: '回复中又被触发，这条发出后再回复一次' });
});
bus.on('reply:cancel', ({ convId }) => {
  replying.delete(convId);
  const s = get(convId);
  if (!s) return;
  endCur(s);
  settleOpen(s);
  push(s, { kind: 'status', text: '等待结束，没有回复' });
  finish(s);
});
bus.on('reply:think', ({ convId, part, at }) => {
  const s = get(convId) || ensure(convId);
  endCur(s);
  s.think = push(s, { kind: 'think', done: false, part, at });
});
bus.on('reply:thinkEnd', ({ convId, sec, text }) => {
  const s = get(convId);
  if (!s || !s.think) return;
  Object.assign(s.think, { done: true, sec, text });
  emit('update', convId, s.think);
  s.think = null;
});
bus.on('tool:start', ({ convId, name, label, part, at, callId }) => {
  const s = get(convId) || ensure(convId);
  endCur(s);
  s.tools.set(callId, push(s, { kind: 'tool', toolName: name, label, part, done: false, at }));
});
bus.on('tool:end', ({ convId, callId, ok, ms, error, images }) => {
  const s = get(convId),
    l = s && s.tools.get(callId);
  if (!l) return;
  Object.assign(l, { done: true, ok, ms, error, images });
  emit('update', convId, l);
});
bus.on('reply:delta', ({ convId, replyId, text, part, at }) => {
  const s = get(convId) || ensure(convId);
  if (!s.cur || s.cur.replyId !== replyId || s.cur.part !== part) {
    endCur(s);
    s.cur = push(s, { kind: 'luoli', text: '', streaming: true, replyId, part, at });
  }
  s.cur.text += text;
  emit('delta', convId, s.cur, text);
});
bus.on('reply:retry', ({ convId, attempt, max, status: code, phase, at }) => {
  const s = get(convId);
  if (!s) return;
  const text =
    phase === 'stream'
      ? `输出中断，重新生成（${attempt}/${max}）`
      : `${code ? `请求失败（${code}）` : '请求失败'}，重试中（${attempt}/${max}）`;
  push(s, { kind: 'status', retry: true, text, at });
});
/* 流中途出错、重新生成：这一步已经显示的内容作废，只留前 keep 段（part 比 keep 小的）。没有 part 的行（用户消息、状态行）不动 */
bus.on('reply:reset', ({ convId, keep }) => {
  const s = get(convId);
  if (!s) return;
  const dead = (l: Line) => l.part !== undefined && l.part >= keep;
  if (s.cur && dead(s.cur)) s.cur = null;
  if (s.think && dead(s.think)) s.think = null;
  s.tools.forEach((l, k) => dead(l) && s.tools.delete(k));
  s.lines = s.lines.filter((l) => !dead(l));
  emit('reset', convId);
});
bus.on('reply:error', ({ convId, status: code, message }) => {
  replying.delete(convId);
  const s = get(convId);
  if (!s) return;
  endCur(s);
  settleOpen(s);
  push(s, {
    kind: 'status',
    err: true,
    text: `出错：${message ?? (code ? `请求失败（${code}）` : '回复失败')}`,
  });
  finish(s);
});
bus.on('reply:abort', ({ convId }) => {
  replying.delete(convId);
  const s = get(convId);
  if (!s) return;
  endCur(s);
  settleOpen(s);
  push(s, { kind: 'status', text: status.online ? '回复被中止' : '回复被中止：bot 离线' });
  finish(s);
});
bus.on('reply:end', ({ convId, ms, usage }) => {
  replying.delete(convId);
  const s = get(convId);
  if (!s) return;
  endCur(s);
  const tokens: string[] = [];
  if (usage.input !== undefined)
    tokens.push(`输入 ${usage.input}${usage.cache !== undefined ? `（缓存 ${usage.cache}）` : ''}`);
  if (usage.output !== undefined) tokens.push(`输出 ${usage.output}`);
  push(s, { kind: 'stats', text: [`${(ms / 1000).toFixed(1)}s`, ...tokens].join(' · ') });
  finish(s);
});
bus.on('conv:remove', ({ id }) => {
  replying.delete(id);
  sessions.delete(id);
  if (last && last.convId === id) last = null;
  emit('sessions');
});
/* 会话列表整批换了：会话的标题、种类可能变了，要重新画；回复的进度不动（它和会话列表是两路数据） */
bus.on('data:reset', () => emit('sessions'));

export const nowModel = {
  sub(fn: Sub) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  get,
  get last() {
    if (!last) last = lastFromServer();
    return last;
  },
  list() {
    return [...sessions.values()];
  },
  clearEnded() {
    let changed = false;
    sessions.forEach((s, k) => {
      if (!s.active) {
        sessions.delete(k);
        changed = true;
      }
    });
    if (changed) emit('sessions');
  },
  /** 全部清掉（开发模式切换数据） */
  reset() {
    sessions.clear();
    replying.clear();
    last = null;
    emit('sessions');
  },
  /** 上次回复变了：手动展开时要显示的会话重新按服务说的来 */
  resetLast() {
    if (last && !last.active && !sessions.has(last.convId)) last = null;
  },
  /**
   * 按现场重建：这些会话的进度从头来过。replay 里发的事件和平时一样处理，只是文字行不放光标停留的动画。
   * ids 之外、这边还以为在回复的会话，是断开期间结束了的，悄悄收尾
   */
  rebuild(ids: Set<string>, replay: () => void) {
    for (const s of [...sessions.values()]) {
      if (ids.has(s.convId)) {
        sessions.delete(s.convId);
        replying.delete(s.convId);
      } else if (s.active) {
        /* 断开期间结束了的：这边只收到一半（文字停在断开的那一刻，也没有结束的标记）。丢掉，按服务里已经写好的消息重新放 */
        replying.delete(s.convId);
        status.clear(s.convId);
        const fresh = newSession(s.convId, false);
        fresh.endedAt = Date.now();
        sessions.set(s.convId, fresh);
        last = fresh;
        void seed(fresh, true);
      }
    }
    for (const k of [...status.conv.keys()]) if (!ids.has(k)) status.clear(k);
    for (const id of ids) status.conv.delete(id);
    replaying = true;
    try {
      replay();
    } finally {
      replaying = false;
    }
    emit('sessions');
  },
};
