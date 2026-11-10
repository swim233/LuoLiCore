import { uid } from '../lib/util';
import { bus } from './bus';
import { db } from './db';
import { eventOf } from './events';
import { argsLine, authorOf, isFile, isReasoning, isTool, textOf, toolName } from './parts';
import { cachedRecentMessages, recentMessages } from './sync';
import { status } from './status';
import type { ImageInfo, MsgRow } from './types';

/* 「此刻」的数据：每个进行中的回复一份终端日志。只列正在回复的会话加上最近结束的一个。
   行由总线事件拼出来：服务推来的实时事件经 live-feed.ts 变成 reply:*、tool:* 事件（开发模式的模拟服务也一样），
   所以这里只认一种事件，时间（思考了几秒、工具用了多久）都来自事件的时间，没有兜底值。
   一个会话开头的几行是它最近的几条消息，向服务取（sync.ts 的 recentMessages），取到了排在最前面。
   「此刻」只列进行中的会话加最近结束的一个，别的被拿掉的会话（finish、clearEnded）的行不丢，收进 retained：同一个会话再回复时接着原来的行往下写 */
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
  /** luoli：回复正常完成时这是它的最后一行（reply:end）。中止、出错没有。逐字放完最后一个字时据此放星尘 */
  completed?: boolean;
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
  /** status：任务到点触发了这次回复（「任务到点 · 做什么」） */
  task?: boolean;
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
/* 被拿掉（不在「此刻」里列了）的会话，它已有的行留在这里，最近回复过的 RETAIN_SESSIONS 个；刷新页面后没有，只剩从服务取的那些 */
const RETAIN_SESSIONS = 20;
const retained = new Map<string, Session>();
/* 每个会话最多留多少行（超出的从最前面丢） */
const MAX_LINES = 140;
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

/** 一条消息变成终端里的几行。时间、秒数、耗时历史消息里都没有，不显示。
    事件（任务到点）不是人说的话，不显示成一行用户消息：任务到点触发的回复开始时，「此刻」按服务给的任务标出（reply:start 的 tasks） */
function linesFromRow(row: MsgRow): Line[] {
  if (eventOf(row)) return [];
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
  let thinkIndex = 0;
  for (const p of m.parts) {
    if (isReasoning(p)) {
      // 思考用了几秒：消息里记的毫秒（以前的消息没有，就不显示秒数）
      const ms = m.metadata?.reasoningMs?.[thinkIndex++];
      out.push({
        id: uid('l'),
        kind: 'think',
        at,
        done: true,
        text: p.text,
        sec: typeof ms === 'number' ? Math.max(1, Math.round(ms / 1000)) : undefined,
        rowId: row.id,
      });
    } else if (isTool(p)) {
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
        label: row.tools[p.toolCallId]?.summary ?? argsLine((p as { input?: unknown }).input),
        done: true,
        ok: p.state !== 'output-error',
        ms: row.tools[p.toolCallId]?.durationMs,
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
/* 一个会话开头放几行：向服务取最近 SEED_MESSAGES 条消息，变成的行都放（总数受 MAX_LINES 限制） */
const SEED_MESSAGES = 20;
/** 把取到的消息变成行，排在已有的行前面；放进了几行就返回 true */
function placeSeed(s: Session, rows: MsgRow[]): boolean {
  const lines: Line[] = [];
  for (const r of rows) if (!s.rows.has(r.id)) lines.push(...linesFromRow(r));
  if (!lines.length) return false;
  for (const r of rows) s.rows.add(r.id);
  s.lines.unshift(...lines);
  if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
  return true;
}
/** 取这个会话最近的几条消息，排在已有的行前面。页面里已经取到过这个会话的消息时同步放进来（调用返回时行就在了，
    不发事件：调用的人接着就会让界面重画；「此刻」从胶囊展开、形变拿到的是挂上那一刻的画面，不能等一个微任务）；
    没有就向服务取，取到了发 seed。fresh：一定向服务取 */
function seed(s: Session, fresh = false) {
  const cached = fresh ? null : cachedRecentMessages(s.convId, SEED_MESSAGES);
  if (cached) {
    placeSeed(s, cached);
    return;
  }
  void recentMessages(s.convId, SEED_MESSAGES, fresh).then((rows) => {
    if (sessions.get(s.convId) !== s && last !== s) return;
    if (placeSeed(s, rows)) emit('seed', s.convId);
  });
}
/** 一个会话不再在「此刻」里列了：它已有的行收进 retained，只留最近的 RETAIN_SESSIONS 个 */
function retire(s: Session) {
  if (!s.lines.length) return;
  retained.delete(s.convId);
  retained.set(s.convId, s);
  for (const k of retained.keys()) {
    if (retained.size <= RETAIN_SESSIONS) break;
    retained.delete(k);
  }
}
function ensure(convId: string) {
  let s = sessions.get(convId);
  if (!s) {
    const old = retained.get(convId);
    if (old) {
      /* 这个会话以前回复过、被拿掉了：接着原来的行往下写（上一轮的思考、工具、用量行都在），不重新取开头那几条 */
      retained.delete(convId);
      s = old;
      Object.assign(s, {
        web: db.conv(convId)?.platform === 'web',
        active: true,
        endedAt: undefined,
        replyId: undefined,
        cur: null,
        think: null,
      });
      s.tools.clear();
      sessions.set(convId, s);
    } else {
      s = newSession(convId, true);
      sessions.set(convId, s);
      seed(s);
    }
    emit('sessions');
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
  if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
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
    if (x !== s && !x.active) {
      sessions.delete(k);
      retire(x);
    }
  });
  emit('sessions');
}
/* 页面开着还没有任何回复时手动展开「此刻」：显示服务说的上次回复所在的会话。开头的几行向服务取 */
function lastFromServer(): Session | null {
  const id = status.lastReplyConv;
  if (!id || !db.conv(id)) return null;
  const s = newSession(id, false);
  s.endedAt = status.lastReplyAt || undefined;
  seed(s);
  return s;
}
/* 正在回复的会话：reply:wait、reply:start 加进来，reply:end / abort / error / cancel 先拿掉再收尾。
   回复结束后合并的下一次回复晚几百毫秒才开始，所以结束的那一刻这里没有它 */
const replying = new Set<string>();
const get = (id: string) => sessions.get(id);

bus.on('message', ({ convId, row }) => {
  /* 被拿掉的会话（retained）也要收：空闲期别人说的话、触发下一次回复的那一条，都是在会话回复之前到的，
     那时它不在 sessions 里；下一轮回复接着它的行往下写，不重新取开头，这些消息只能在这里补上 */
  const s = get(convId) ?? retained.get(convId);
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
bus.on('reply:start', ({ convId, replyId, at, tasks }) => {
  replying.add(convId);
  const s = ensure(convId);
  s.replyId = replyId;
  s.cur = null;
  // 任务到点触发的回复：几个任务都列出来
  for (const t of tasks ?? [])
    push(s, { kind: 'status', task: true, text: `任务到点 · ${t.action}`, at });
  emit('sessions');
});
bus.on('reply:queued', ({ convId }) => {
  const s = get(convId);
  if (s) push(s, { kind: 'status', text: '回复中又被触发，这条发出后再回复一次' });
});
bus.on('reply:dequeue', ({ convId }) => {
  const s = get(convId);
  if (s) push(s, { kind: 'status', text: '排队的回复取消了' });
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
bus.on('tool:end', ({ convId, callId, ok, ms, error, images, summary }) => {
  const s = get(convId),
    l = s && s.tools.get(callId);
  if (!l) return;
  // 结束时的摘要比开始时的完整（fetch：开始时只有网址，结束时带页面标题）
  Object.assign(l, { done: true, ok, ms, error, images, ...(summary ? { label: summary } : {}) });
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
  if (s.cur) s.cur.completed = true;
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
  retained.delete(id);
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
        retire(s);
        changed = true;
      }
    });
    if (changed) emit('sessions');
  },
  /** 全部清掉（开发模式切换数据） */
  reset() {
    sessions.clear();
    retained.clear();
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
    /* 重连：断开期间的消息、回复这边没收到，被拿掉的会话留着的行可能缺了一段。和刷新页面一样，都不要了，
       这些会话再回复时按新建的来，开头向服务取最近的消息 */
    retained.clear();
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
        seed(fresh, true);
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
