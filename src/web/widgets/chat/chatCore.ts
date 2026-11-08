import { Chat } from '@ai-sdk/react';
import { chars, uid } from '../../lib/util';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { getSource } from '../../model/source';
import {
  demoOf,
  isFile,
  isReasoning,
  isText,
  isTool,
  toolOutput,
  withDemo,
} from '../../model/parts';
import type { NewMessage } from '../../model/source';
import type { ChatMsg, ChatPart, ImageInfo, MsgRow, Part, ToolResultInfo } from '../../model/types';
import { toast } from '../../state/ui';
import { chatState, draftOf, newWebConv } from './chatState';

/* 「对话」的核心：每个网页对话一个 Chat（@ai-sdk/react 的 useChat 用的同一个类），接本地模拟的 /api/chat。
   普通大小和全屏里的两个视图共用同一个 Chat，所以生成到一半放大、缩小，对话不会断。
   这里把 Chat 的消息流翻译成总线事件（状态徽记、「此刻」、会话列表都订阅它们），结束时写进模拟数据库（今日概况、会话时间线用）。 */
export type { ChatMsg };
/* 消息里的 part 按网页对话用到的形状读（demo 时期的字段也在里面） */
export const partsOf = (m: ChatMsg) => m.parts as unknown as ChatPart[];
interface Rec {
  chat: Chat<ChatMsg>;
  convId: string;
  replyId: string;
  t0: number;
  state: {
    think?: number;
    tools: Set<string>;
    textLen: number;
    thinkSeen: boolean;
    thinkDone: boolean;
    toolDone: Set<string>;
    started: boolean;
  };
  finished: boolean;
  /** 最后一条助手消息的 id，正在逐字出、或者结束后光标还没淡掉的那条 */
  liveMsg: string | null;
  lingerUntil: number;
  unreg: (() => void)[];
}
const recs = new Map<string, Rec>();

/* 服务里的一条消息 → useChat 的消息。图片用服务给的地址（开发模式是色块的数据地址）；
   思考秒数、工具耗时与摘要读模拟数据里的演示字段（第 6 步换成真实来源） */
function rowToMsg(row: MsgRow): ChatMsg {
  const m = row.message;
  const parts: ChatPart[] = [];
  for (const p of m.parts) {
    if (isText(p)) parts.push({ type: 'text', text: p.text, state: 'done' });
    else if (isFile(p))
      parts.push({
        type: 'file',
        mediaType: p.mediaType,
        url: row.images[p.url]?.src ?? p.url,
        filename: p.filename,
      });
    else if (isReasoning(p)) {
      const sec = demoOf(p)?.sec;
      parts.push({
        type: 'reasoning',
        text: p.text,
        state: 'done',
        demo: sec ? { sec } : undefined,
      });
    } else if (isTool(p)) {
      const d = demoOf(p);
      const out =
        p.state === 'output-available' ? toolOutput((p as { output?: unknown }).output) : null;
      parts.push({
        type: 'tool-fetch',
        toolCallId: p.toolCallId,
        state:
          p.state === 'output-error'
            ? 'output-error'
            : p.state === 'output-available'
              ? 'output-available'
              : 'input-available',
        input: { url: (p as { input?: { url?: string } }).input?.url },
        output: out
          ? {
              summary: d?.summary ?? out.text.slice(0, 120),
              chars: row.tools[p.toolCallId]?.chars ?? out.text.length,
              ms: d?.ms,
            }
          : undefined,
        demo: d ? { ms: d.ms, summary: d.summary, image: d.image } : undefined,
      });
    }
  }
  const usage = m.metadata?.usage;
  return {
    id: row.id,
    role: row.role,
    parts: parts as unknown as ChatMsg['parts'],
    metadata: {
      at: Date.parse(row.createdAt),
      name: m.metadata?.author?.name,
      aborted: m.metadata?.aborted,
      failed: m.metadata?.failed,
      usage: usage
        ? { input: usage.input ?? 0, cache: usage.cacheRead ?? 0, output: usage.output ?? 0 }
        : undefined,
    },
  } as ChatMsg;
}
/* useChat 的消息 → 服务里的消息。图片：浏览器里的 blob 地址就是它的显示地址（第 6 步改成上传进文件存储） */
function msgToParts(m: ChatMsg): Pick<NewMessage, 'parts' | 'images' | 'tools'> {
  const parts: Part[] = [];
  const images: Record<string, ImageInfo | null> = {};
  const tools: Record<string, ToolResultInfo> = {};
  for (const p of partsOf(m)) {
    if (p.type === 'file') {
      const url = 'luoli-file:' + uid('web') + '.png';
      parts.push({ type: 'file', mediaType: p.mediaType, url, filename: p.filename });
      images[url] = { src: p.url };
    } else if (p.type === 'reasoning')
      parts.push(withDemo({ type: 'reasoning', text: p.text }, { sec: p.sec || 2 }));
    else if (p.type === 'tool-fetch' && p.state === 'output-available') {
      const text = p.output?.summary ?? '';
      tools[p.toolCallId] = { chars: p.output?.chars ?? text.length, truncated: false };
      parts.push(
        withDemo(
          {
            type: 'tool-fetch',
            toolCallId: p.toolCallId,
            state: 'output-available',
            input: { url: p.input?.url ?? '' },
            output: text,
          } as Part,
          { ms: p.output?.ms || 800, summary: text, image: null },
        ),
      );
    } else if (p.type === 'text' && p.text) parts.push({ type: 'text', text: p.text });
  }
  return { parts, images, tools };
}

export function getRec(convId: string): Rec {
  let r = recs.get(convId);
  if (r) return r;
  const chat = new Chat<ChatMsg>({
    id: convId,
    messages: db.msgs(convId).map(rowToMsg),
    transport: getSource().chatTransport(convId),
    onData: (d) => {
      if (d.type !== 'data-retry') return;
      const x = d.data as { attempt: number; max: number; status: number };
      bus.emit('reply:retry', {
        convId,
        replyId: r!.replyId,
        attempt: x.attempt,
        max: x.max,
        status: x.status,
      });
    },
    onFinish: ({ isAbort, isError, isDisconnect }) =>
      finalize(r!, isAbort ? 'abort' : isError || isDisconnect ? 'error' : 'end'),
    onError: () => {
      if (!r!.finished) finalize(r!, 'error');
    },
  });
  r = {
    chat,
    convId,
    replyId: '',
    t0: 0,
    state: {
      tools: new Set(),
      textLen: 0,
      thinkSeen: false,
      thinkDone: false,
      toolDone: new Set(),
      started: false,
    },
    finished: true,
    liveMsg: null,
    lingerUntil: 0,
    unreg: [],
  };
  r.unreg.push(chat['~registerMessagesCallback'](() => onMessages(r!)));
  r.unreg.push(chat['~registerStatusCallback'](() => onStatus(r!)));
  recs.set(convId, r);
  return r;
}
/* Chat 的状态变了：提交（submitted）时开一次回复 */
function onStatus(r: Rec) {
  const st = r.chat.status;
  if (st === 'submitted' && r.finished) {
    r.finished = false;
    r.replyId = uid('reply');
    r.t0 = Date.now();
    r.state = {
      tools: new Set(),
      textLen: 0,
      thinkSeen: false,
      thinkDone: false,
      toolDone: new Set(),
      started: true,
    };
    chatState.set({ gen: r.convId });
    bus.emit('reply:wait', { convId: r.convId, replyId: r.replyId, noWait: true });
  }
}
/* 消息流更新：对照上一次看到的，发出 reply:think、tool:start、reply:delta 这些事件 */
function onMessages(r: Rec) {
  if (r.finished) return;
  const last = r.chat.messages[r.chat.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  r.liveMsg = last.id;
  const s = r.state;
  for (const p of partsOf(last)) {
    if (p.type === 'reasoning') {
      if (!s.thinkSeen) {
        s.thinkSeen = true;
        s.think = Date.now();
        bus.emit('reply:think', { convId: r.convId, replyId: r.replyId });
      }
      if (p.state === 'done' && !s.thinkDone) {
        s.thinkDone = true;
        const sec = Math.max(1, Math.round((Date.now() - (s.think || Date.now())) / 1000));
        p.sec = sec;
        bus.emit('reply:thinkEnd', { convId: r.convId, replyId: r.replyId, sec, text: p.text });
      }
    } else if (p.type === 'tool-fetch') {
      if (!s.tools.has(p.toolCallId)) {
        s.tools.add(p.toolCallId);
        bus.emit('tool:start', {
          convId: r.convId,
          replyId: r.replyId,
          callId: p.toolCallId,
          name: 'fetch',
          label: p.input?.url,
        });
      }
      if (p.state === 'output-available' && !s.toolDone.has(p.toolCallId)) {
        s.toolDone.add(p.toolCallId);
        bus.emit('tool:end', {
          convId: r.convId,
          replyId: r.replyId,
          callId: p.toolCallId,
          ok: true,
          ms: p.output?.ms || 800,
          summary: p.output?.summary,
          image: null,
        });
      }
    } else if (p.type === 'text') {
      const cs = chars(p.text || '');
      if (cs.length > s.textLen) {
        const chunk = cs.slice(s.textLen).join('');
        s.textLen = cs.length;
        bus.emit('reply:delta', { convId: r.convId, replyId: r.replyId, text: chunk });
      }
    }
  }
}
/* 一次回复结束：写进模拟数据库，发 reply:end / reply:abort / reply:error */
function finalize(r: Rec, how: 'end' | 'abort' | 'error') {
  if (r.finished) return;
  r.finished = true;
  const { convId } = r;
  const last = r.chat.messages[r.chat.messages.length - 1];
  const msg = last && last.role === 'assistant' ? last : null;
  const ms = Date.now() - r.t0;
  const meta: NonNullable<NewMessage['meta']> = {};
  if (how === 'abort') meta.aborted = true;
  if (how === 'error') meta.failed = true;
  const usage = msg?.metadata?.usage || { input: 1500, cache: 0, output: 30 };
  if (how === 'end')
    meta.usage = { input: usage.input, cacheRead: usage.cache, output: usage.output };
  let row: MsgRow | null = null;
  const built = msg ? msgToParts(msg) : null;
  const store = getSource().webChat;
  if (store && db.conv(convId) && built && built.parts.length)
    row = store.addMessage(convId, { role: 'assistant', ...built, meta });
  if (store && db.conv(convId)) {
    store.addCall({
      conversation_id: convId,
      reply_id: row?.id ?? null,
      started_at: new Date(r.t0).toISOString(),
      duration_ms: ms,
      first_output_ms: 900,
      attempts: 1,
      outcome: how === 'end' ? 'completed' : how === 'abort' ? 'aborted' : 'failed',
      finish_reason: how === 'end' ? 'stop' : undefined,
      input_tokens: how === 'end' ? usage.input : null,
      cache_read_tokens: how === 'end' ? usage.cache : null,
      output_tokens: how === 'end' ? usage.output : null,
      steps: r.state.tools.size ? 2 : 1,
      tool_calls: r.state.tools.size,
      error: how === 'error' ? 'APICallError 429' : null,
    });
  }
  /* 界面上这条消息的标记 */
  if (msg && how !== 'end')
    r.chat.messages = r.chat.messages.map((m) =>
      m.id === msg.id
        ? ({
            ...m,
            metadata: { ...m.metadata, aborted: meta.aborted, failed: meta.failed },
          } as ChatMsg)
        : m,
    );
  r.lingerUntil = Date.now() + (how === 'end' ? 2000 : 300);
  if (chatState.get().gen === convId) chatState.set({ gen: null });
  if (how === 'end') bus.emit('reply:end', { convId, replyId: r.replyId, ms, usage, row });
  else if (how === 'abort') bus.emit('reply:abort', { convId, replyId: r.replyId, row });
  else bus.emit('reply:error', { convId, replyId: r.replyId, status: 429, row });
}

export function abortChat(convId: string) {
  recs.get(convId)?.chat.stop();
}
export const isGenerating = (convId: string | null) => !!convId && chatState.get().gen === convId;

/* 发送：用户的消息进数据库和会话列表，再交给 Chat */
export function sendChat(convId: string | null, text: string): boolean {
  const id0 = convId;
  const d = id0 ? draftOf(id0) : { text: '', atts: [] };
  if (!text && !d.atts.length) return false;
  const blocked = getSource().chatBlocked();
  if (blocked) {
    toast(blocked);
    return false;
  }
  if (chatState.get().gen) {
    toast('另一个对话还在生成，先等等或中止它');
    return false;
  }
  const id = id0 || newWebConv();
  const store = getSource().webChat;
  if (!id || !store) return false;
  const files = draftOf(id).atts.splice(0);
  const parts: Part[] = [];
  const images: Record<string, ImageInfo | null> = {};
  for (const a of files) {
    const url = 'luoli-file:' + uid('web') + '.png';
    parts.push({ type: 'file', mediaType: a.type, url, filename: a.name });
    images[url] = { src: a.url };
  }
  if (text) parts.push({ type: 'text', text });
  // 用户的消息记进「服务」：服务把它推回来，会话列表、时间线、「此刻」从事件里看到
  store.addMessage(id, { role: 'user', author: { name: '你' }, parts, images });
  const c = db.conv(id);
  if (c && c.title === '新对话')
    store.setTitle(
      id,
      text ? (chars(text).length > 16 ? chars(text).slice(0, 16).join('') + '…' : text) : '图片',
    );
  draftOf(id).text = '';
  const r = getRec(id);
  r.liveMsg = null;
  const fileParts = files.map((a) => ({
    type: 'file' as const,
    mediaType: a.type,
    url: a.url,
    filename: a.name,
  }));
  r.chat.sendMessage(text ? { text, files: fileParts } : { files: fileParts }).catch(() => {});
  return true;
}
/* 数据重置、会话被删：丢掉 Chat */
export function disposeChat(convId: string) {
  const r = recs.get(convId);
  if (!r) return;
  r.unreg.forEach((f) => f());
  r.chat.stop().catch(() => {});
  recs.delete(convId);
}
bus.on('data:reset', () => {
  [...recs.keys()].forEach(disposeChat);
});
bus.on('conv:remove', ({ id }) => disposeChat(id));
bus.on('bot:offline', () => {
  for (const r of recs.values()) if (!r.finished) r.chat.stop();
});
