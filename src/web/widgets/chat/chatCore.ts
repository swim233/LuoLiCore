import { Chat } from '@ai-sdk/react';
import { chars, uid } from '../../lib/util';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { getSource } from '../../model/source';
import type { ChatMsg, ChatPart, Metadata, MsgRow, Part } from '../../model/types';
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

function rowToMsg(row: MsgRow): ChatMsg {
  const m = row.ui_message;
  const parts: ChatPart[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') parts.push({ type: 'text', text: p.text, state: 'done' });
    else if (p.type === 'file')
      parts.push({
        type: 'file',
        mediaType: p.mediaType,
        url: p.url,
        filename: p.name,
        demo: p.demo,
        blob: p.blob,
      });
    else if (p.type === 'reasoning')
      parts.push({ type: 'reasoning', text: p.text, state: 'done', demo: p.demo });
    else if (p.type === 'tool-fetch')
      parts.push({
        type: 'tool-fetch',
        toolCallId: p.toolCallId,
        state: p.state,
        input: p.input,
        output: p.output ? { ...p.output, ms: p.demo?.ms } : undefined,
        demo: p.demo,
      });
  }
  return {
    id: row.id,
    role: row.role,
    parts: parts as unknown as ChatMsg['parts'],
    metadata: {
      at: Date.parse(row.created_at),
      name: m.metadata.author?.name,
      aborted: m.metadata.aborted,
      failed: m.metadata.failed,
      usage: m.metadata.usage
        ? {
            input: m.metadata.usage.inputTokens,
            cache: m.metadata.usage.cachedInputTokens,
            output: m.metadata.usage.outputTokens,
          }
        : undefined,
    },
  } as ChatMsg;
}
function msgToParts(m: ChatMsg): Part[] {
  const out: Part[] = [];
  for (const p of partsOf(m)) {
    if (p.type === 'file')
      out.push({
        type: 'file',
        mediaType: p.mediaType,
        url: 'luoli-file:（上传后由服务端存）',
        blob: p.url,
        name: p.filename,
      });
    else if (p.type === 'reasoning')
      out.push({ type: 'reasoning', text: p.text, demo: { sec: p.sec || 2 } });
    else if (p.type === 'tool-fetch' && p.state === 'output-available')
      out.push({
        type: 'tool-fetch',
        toolCallId: p.toolCallId,
        state: 'output-available',
        input: { url: p.input?.url ?? '' },
        output: { summary: p.output?.summary ?? '', chars: p.output?.chars ?? 0 },
        demo: { ms: p.output?.ms || 800, image: null },
      });
    else if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
  }
  return out;
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
  const meta: Metadata = {};
  if (how === 'abort') meta.aborted = true;
  if (how === 'error') meta.failed = true;
  const usage = msg?.metadata?.usage || { input: 1500, cache: 0, output: 30 };
  if (how === 'end')
    meta.usage = {
      inputTokens: usage.input,
      cachedInputTokens: usage.cache,
      outputTokens: usage.output,
    };
  let row: MsgRow | null = null;
  const parts = msg ? msgToParts(msg) : [];
  if (db.conv(convId) && parts.length) row = db.addMsg(convId, { role: 'assistant', parts, meta });
  if (db.conv(convId)) {
    db.addCall({
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
      m.id === msg.id ? ({ ...m, metadata: { ...m.metadata, ...meta } } as ChatMsg) : m,
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
  const files = draftOf(id).atts.splice(0);
  const parts: Part[] = files.map((a) => ({
    type: 'file',
    mediaType: a.type,
    url: 'luoli-file:（上传后由服务端存）',
    blob: a.url,
    name: a.name,
  }));
  if (text) parts.push({ type: 'text', text });
  const row = db.addMsg(id, { role: 'user', author: { name: '你', uid: null }, parts })!;
  const c = db.conv(id)!;
  if (c.title === '新对话') {
    c.title = text
      ? chars(text).length > 16
        ? chars(text).slice(0, 16).join('') + '…'
        : text
      : '图片';
    bus.emit('conv:update', { id });
  }
  draftOf(id).text = '';
  bus.emit('message', { convId: id, row, trigger: true });
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
