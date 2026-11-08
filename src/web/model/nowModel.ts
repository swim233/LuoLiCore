import { uid } from '../lib/util';
import { bus } from './bus';
import { db } from './db';
import {
  authorOf,
  demoOf,
  inputLine,
  isFile,
  isReasoning,
  isTool,
  textOf,
  toolName,
} from './parts';
import { status } from './status';
import type { Conversation, ImagePart, MsgRow } from './types';

/* 「此刻」的数据：每个进行中的对话一份终端日志。只列正在回复的会话加上最近结束的一个 */
export type LineKind = 'user' | 'luoli' | 'tool' | 'status' | 'think' | 'stats';
export interface Line {
  id: string;
  kind: LineKind;
  at: number;
  name?: string;
  uid?: string | null;
  text?: string;
  image?: ImagePart | null;
  streaming?: boolean;
  lingerUntil?: number;
  replyId?: string;
  label?: string;
  done?: boolean;
  ok?: boolean;
  ms?: number;
  summary?: string;
  sec?: number;
  aborted?: boolean;
  err?: boolean;
  retry?: boolean;
  open?: boolean;
}
export interface Session {
  convId: string;
  title: string;
  web: boolean;
  lines: Line[];
  started: number;
  active: boolean;
  endedAt?: number;
  replyId?: string;
  cur: Line | null;
  think: Line | null;
  tools: Map<string, Line>;
}
type Sub = (type: string, convId?: string, line?: Line, extra?: string) => void;

const sessions = new Map<string, Session>();
const subs = new Set<Sub>();
let last: Session | null = null;
const emit: Sub = (type, convId, line, extra) =>
  subs.forEach((fn) => {
    try {
      fn(type, convId, line, extra);
    } catch (e) {
      console.error(e);
    }
  });

function linesFromRow(row: MsgRow): Line[] {
  const at = Date.parse(row.createdAt);
  const m = row.message;
  if (row.role === 'user') {
    const file = m.parts.find(isFile);
    const author = authorOf(row);
    return [
      {
        id: uid('l'),
        kind: 'user',
        at,
        name: author?.name,
        uid: author?.id ?? null,
        text: textOf(row),
        // 「此刻」第 5 步才接真图；开发模式的色块图在 demo 里
        image: file
          ? ({ type: 'file', mediaType: file.mediaType, url: file.url } as ImagePart)
          : null,
      },
    ];
  }
  /* 思考秒数、工具耗时、摘要、工具结果里的图是演示字段（parts.ts 的 demoOf），第 5 步换成真实来源 */
  const out: Line[] = [];
  for (const p of m.parts) {
    if (isReasoning(p))
      out.push({
        id: uid('l'),
        kind: 'think',
        at,
        done: true,
        sec: demoOf(p)?.sec || 2,
        text: p.text,
      });
    else if (isTool(p))
      out.push({
        id: uid('l'),
        kind: 'tool',
        at,
        label: inputLine((p as { input?: unknown }).input) || toolName(p),
        done: true,
        ok: p.state !== 'output-error',
        ms: demoOf(p)?.ms || 800,
        summary: demoOf(p)?.summary,
        image: demoOf(p)?.image,
      });
  }
  const t = textOf(row);
  if (t) out.push({ id: uid('l'), kind: 'luoli', at, text: t });
  if (m.metadata?.aborted) out.push({ id: uid('l'), kind: 'status', at, text: '回复被中止' });
  if (m.metadata?.failed)
    out.push({ id: uid('l'), kind: 'status', at, err: true, text: '出错：回复中断' });
  return out;
}
function seed(convId: string) {
  const lines: Line[] = [];
  for (const r of db.msgs(convId).slice(-5)) lines.push(...linesFromRow(r));
  return lines.slice(-8);
}
function ensure(convId: string) {
  let s = sessions.get(convId);
  if (!s) {
    const conv = db.conv(convId);
    s = {
      convId,
      title: conv ? conv.title : '会话',
      web: !!(conv && conv.platform === 'web'),
      lines: seed(convId),
      started: Date.now(),
      active: true,
      cur: null,
      think: null,
      tools: new Map(),
    };
    sessions.set(convId, s);
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
  if (s.lines.length > 140) s.lines.splice(0, s.lines.length - 140);
  emit('add', s.convId, l);
  return l;
}
function endCur(s: Session) {
  if (s.cur && s.cur.streaming) {
    s.cur.streaming = false;
    s.cur.lingerUntil = Date.now() + 2000;
    emit('update', s.convId, s.cur);
  }
  s.cur = null;
}
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
      Object.assign(l, { done: true, ok: false, ms: Date.now() - l.at, summary: '工具调用未完成' });
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
/* 还没有人触发过时：取数据里最近一次回复所在的会话，手动展开时显示它的上下文 */
function recentFromDb(): Session | null {
  let best: Conversation | null = null,
    t = 0;
  for (const c of db.conversations) {
    const m = db.msgs(c.id);
    for (let i = m.length - 1; i >= 0; i--) {
      if (m[i].role !== 'assistant') continue;
      const tt = Date.parse(m[i].createdAt);
      if (tt > t) {
        t = tt;
        best = c;
      }
      break;
    }
  }
  if (!best) return null;
  return {
    convId: best.id,
    title: best.title,
    web: best.platform === 'web',
    lines: seed(best.id),
    started: t,
    active: false,
    endedAt: t,
    cur: null,
    think: null,
    tools: new Map(),
  };
}
/* 正在回复的会话：reply:wait 加进来，reply:end / abort / error 先拿掉再收尾。
   回复结束后合并的下一次回复晚几百毫秒才开始，所以结束的那一刻这里没有它 */
const replying = new Set<string>();
const get = (id: string) => sessions.get(id);

bus.on('message', ({ convId, row }) => {
  const s = get(convId);
  // 助手的消息写入时回复已经在这里逐行显示过了（reply:* 事件），只加别人发的
  if (s && row && row.role === 'user') linesFromRow(row).forEach((l) => push(s, l));
});
bus.on('reply:wait', ({ convId, replyId, noWait }) => {
  replying.add(convId);
  const s = ensure(convId);
  s.replyId = replyId;
  s.cur = null;
  if (!noWait) push(s, { kind: 'status', text: '等待合并' });
  emit('sessions');
});
bus.on('reply:queued', ({ convId }) => {
  const s = get(convId);
  if (s) push(s, { kind: 'status', text: '回复中又被触发，这条发出后再回复一次' });
});
bus.on('reply:think', ({ convId }) => {
  const s = get(convId) || ensure(convId);
  s.think = push(s, { kind: 'think', done: false });
});
bus.on('reply:thinkEnd', ({ convId, sec, text }) => {
  const s = get(convId);
  if (!s || !s.think) return;
  Object.assign(s.think, { done: true, sec, text });
  emit('update', convId, s.think);
  s.think = null;
});
bus.on('tool:start', ({ convId, callId, label }) => {
  const s = get(convId) || ensure(convId);
  s.tools.set(callId, push(s, { kind: 'tool', label, done: false }));
});
bus.on('tool:end', ({ convId, callId, ok, ms, summary, image }) => {
  const s = get(convId),
    l = s && s.tools.get(callId);
  if (!l) return;
  Object.assign(l, { done: true, ok, ms, summary, image });
  emit('update', convId, l);
});
bus.on('reply:delta', ({ convId, replyId, text }) => {
  const s = get(convId) || ensure(convId);
  if (!s.cur || s.cur.replyId !== replyId)
    s.cur = push(s, { kind: 'luoli', text: '', streaming: true, replyId });
  s.cur.text += text;
  emit('delta', convId, s.cur, text);
});
bus.on('reply:retry', ({ convId, attempt, max, status: code }) => {
  const s = get(convId);
  if (s)
    push(s, {
      kind: 'status',
      retry: true,
      text: `请求失败（${code}），重试中（${attempt}/${max}）`,
    });
});
bus.on('reply:error', ({ convId, status: code }) => {
  replying.delete(convId);
  const s = get(convId);
  if (!s) return;
  endCur(s);
  settleOpen(s);
  push(s, { kind: 'status', err: true, text: `出错：请求失败（${code}）` });
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
  push(s, {
    kind: 'stats',
    text: `${(ms / 1000).toFixed(1)}s · 输入 ${usage.input}（缓存 ${usage.cache}）· 输出 ${usage.output}`,
  });
  finish(s);
});
bus.on('conv:remove', ({ id }) => {
  replying.delete(id);
  sessions.delete(id);
  if (last && last.convId === id) last = null;
  emit('sessions');
});
bus.on('data:reset', () => {
  sessions.clear();
  replying.clear();
  last = null;
  emit('sessions');
});

export const nowModel = {
  sub(fn: Sub) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  get,
  get last() {
    if (!last) last = recentFromDb();
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
  /* 取状态里的 status.conv 判断是否仍在回复：供外部调用 finish 后的清理（无） */
};
