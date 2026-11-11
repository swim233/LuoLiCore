import { Chat } from '@ai-sdk/react';
import type { FileUIPart } from 'ai';
import { uid } from '../../lib/util';
import { bus } from '../../model/bus';
import { chatErrorStatus, chatErrorText } from '../../model/chat-api';
import type { SendMeta } from '../../model/chat-api';
import { db } from '../../model/db';
import { replyInfo } from '../../model/replyInfo';
import { getSource } from '../../model/source';
import { ensureConversation } from '../../model/sync';
import type { ChatChunk, ChatMessage } from '../../../server/types';
import { toast } from '../../state/ui';
import { awaitingOwnReply, busyElsewhere } from './replyWait';
import {
  chatCur,
  chatState,
  draftChanged,
  draftKey,
  draftOf,
  IMAGE_TYPES,
  MAX_BYTES,
  MAX_IMAGES,
  NEW_KEY,
  switchTo,
} from './chatState';
import type { Att } from './chatState';

/* 「对话」的核心：怎么把消息发给洛璃服务、怎么看到回复。
   - 会话的正本在服务里：对话里的历史消息、别的标签页发的消息、写入历史的回复，都和「会话」部件一样从服务取、经 SSE 的 message 事件推来（db）；
   - 这个标签页发的每个请求（一次发消息、一次重试）是一个 Req，各用一个 @ai-sdk/react 的 Chat 接服务的 /api/chat（只发新消息）：
     它的流里是这次回复逐字出的内容，对话里这条回复先画它（FlightBubble），回复写入历史（同一个消息 id）后改画历史里的，气泡不重建。
   - 生成中又发一条：服务把它排队，请求一直开着等补的那次回复。每个请求各有一个 Chat，所以几个请求互不干扰：
     第一个请求断开就是中止当前回复，所以排队的消息不能复用第一个请求的 Chat（见 ai 的 AbstractChat.sendMessage：生成中再调用会换掉 activeResponse）；
     补回复的流由发出最后一条排队消息的那个请求带，它的 Chat 里就是补回复的内容。
   - 新对话发出第一句：服务回的第一段（data-conversation）带着会话 id，收到就切到这个会话，不等 SSE 把新会话推来
     （SSE 不通或被代理缓冲时它不来，但对话的流是通的）；这之前的 Esc 直接断开请求（服务把断开当作中止）。
   - 中止用 POST /api/chat/:id/abort（同时取消排队的补回复），不用 Chat.stop（它只断开这一个请求）。
   - 只用了 Chat 的公开接口（构造参数 id、transport、onError、onFinish，以及 sendMessage、regenerate、useChat）；
     「此刻」「会话」的更新、回复的计时都来自服务的实时事件，不靠 Chat 的内部接口。 */

/** 这个标签页发给服务的一个请求 */
export interface Req {
  id: string;
  kind: 'send' | 'retry';
  chat: Chat<ChatMessage>;
  /** 会话 id：新会话要等服务回 data-conversation 才知道 */
  convId: string | null;
  /** 从新对话（还没建的会话）发出的 */
  fromNew: boolean;
  /** 从哪个草稿发出的 */
  draftKey: string;
  /** 发出的文字与图片的预览（新会话还不在历史里时，对话里先显示它） */
  preview: { text: string; images: string[] };
  /** 发出去的图片（出错时放回输入框） */
  atts: Att[];
  startedAt: number;
  /** 服务收下了（回了 data-conversation）：消息已经写进历史 */
  accepted: boolean;
  /** 发出的这条消息的序号 */
  seq?: number;
  /** 这条消息在排队（data-queued） */
  queued: boolean;
  /** 回复 id（start 段的 messageId）：回复写入历史后就是那条助手消息的 id */
  replyId?: string;
  /** 流里出现了真正的内容（思考、文字、工具、图片） */
  content: boolean;
  /** 对话里要显示这条回复：有内容，或者结束时是出错、中止 */
  shown: boolean;
  sawAbort: boolean;
  finished: boolean;
  how: 'end' | 'abort' | 'error' | null;
  errorText?: string;
  /** 请求没发成时服务回的 HTTP 状态码（网络错误没有） */
  errorStatus?: number;
  /** 结束后光标还停到这个时刻（正常 2 秒，中止、出错 .3 秒） */
  lingerUntil: number;
}
const reqs: Req[] = [];
const flight = () => bus.emit('chat:flight');

/** 这个会话里这个标签页发出的、对话里要显示的回复 */
export const flightsOf = (convId: string | null) =>
  reqs.filter((r) => r.convId === convId && r.shown);
/** 回复的键：回复 id（写入历史后就是那条助手消息的 id）；一开始就失败、没有 start 段的回复没有，用请求 id */
export const flightKey = (r: Req) => r.replyId ?? r.id;
/** 从新对话发出、服务还没回应（还不知道会话 id）的请求 */
export const creatingReq = () => {
  const id = chatState.get().creating;
  return id ? reqs.find((r) => r.id === id) : undefined;
};
/** 对话刚从新对话切到这个会话、它的消息还没取到时，先显示的那条请求（发出的那句和它的回复） */
export const startedFrom = (convId: string) => reqs.find((r) => r.fromNew && r.convId === convId);

/** 这个会话在生成：这个标签页发的请求还开着（含排队等着补回复的），或者服务说有进行中的回复（别的标签页发的） */
export function isBusy(convId: string | null): boolean {
  if (reqs.some((r) => r.convId === convId && !r.finished)) return true;
  return convId !== null && replyInfo.active(convId);
}
/** 这个会话在生成，但不是这个标签页发出的请求：别的标签页发的，或者任务到点触发的（没有哪个页面的请求接着它的流）。
    这个标签页看不到逐字的过程（那在「此刻」里），对话里在输入框上方写一行「正在回复」，带「中止」。
    这个标签页自己的请求刚收尾、服务的「回复结束」还没到时不算（回复 id 一样，见 replyWait.ts） */
export function isBusyElsewhere(convId: string | null): boolean {
  return busyElsewhere(reqs, convId, replyInfo.active(convId), replyInfo.details(convId)?.replyId);
}
/** 这个标签页发的请求在等回复（对话里要不要先画「正在回复」的气泡）：written 是历史里已有的消息 id。回复已经写进历史的不算（见 replyWait.ts） */
export const awaitingReply = (convId: string | null, written: ReadonlySet<string>) =>
  awaitingOwnReply(reqs, convId, written);
/** 有没有任何网页对话在生成（缩略文字用） */
export const anyBusy = () =>
  reqs.some((r) => !r.finished) ||
  db.conversations.some((c) => c.platform === 'web' && replyInfo.active(c.id));

/** 重试被服务拒绝的（最后一条不是出错的回复）：这个会话、这条最后的消息上不再给「重试」 */
const retryDenied = new Set<string>();
export const retryKey = (convId: string, lastSeq: number) => convId + ':' + lastSeq;
export const retryIsDenied = (convId: string, lastSeq: number) =>
  retryDenied.has(retryKey(convId, lastSeq));

function onChunk(req: Req, c: ChatChunk) {
  switch (c.type) {
    case 'data-conversation':
      req.convId = c.data.conversationId;
      req.seq = c.data.seq;
      req.accepted = true;
      // 服务收下了：这个会话里出了错留着的旧请求（重试、再发一句之前的）不再需要
      forgetFinished(req);
      if (req.fromNew) {
        // 新对话发出的第一句：不等服务的 SSE 把新会话推来（SSE 不通、被代理缓冲时它不来），收到就切到这个会话。
        // 列表里还没有这一行时先放一行占位，消息、段由 openConversation 取；SSE 的行到了照常整行换掉
        if (chatState.get().creating === req.id) chatState.set({ creating: null });
        if (chatCur() === null) {
          ensureConversation(req.convId, c.data.title);
          getSource().openConversation(req.convId);
          carryNewDraft(req.convId);
          switchTo(req.convId);
        }
      }
      flight();
      break;
    case 'data-queued':
      req.queued = true;
      flight();
      break;
    case 'start':
      req.replyId = c.messageId;
      flight();
      break;
    case 'reasoning-start':
    case 'text-start':
    case 'tool-input-start':
    case 'tool-input-available':
    case 'file':
      if (!req.content) {
        req.content = true;
        req.shown = true;
        flight();
      }
      break;
    case 'abort':
      req.sawAbort = true;
      break;
    default:
  }
}

/** 发出第一句以后、服务回应之前，在新对话的输入框里接着打的字（和图片）：切到新会话时带过去，接着打字不丢 */
function carryNewDraft(convId: string) {
  const from = draftOf(NEW_KEY),
    to = draftOf(convId);
  if (from === to) return;
  if (from.text) {
    to.text = to.text ? to.text + from.text : from.text;
    from.text = '';
  }
  to.atts.push(...from.atts.splice(0));
  draftChanged();
}

function finish(req: Req, isError: boolean, isAbort: boolean) {
  if (req.finished) return;
  req.finished = true;
  req.how = req.sawAbort || isAbort ? 'abort' : isError ? 'error' : 'end';
  req.lingerUntil = Date.now() + (req.how === 'end' ? 2000 : 300);
  if (req.how !== 'end' && !req.accepted) {
    // 服务没收下（被拒、连不上、还没回应就中止了）：消息没写进历史。发送时清掉的文字和图片放回输入框，出错的提示原因
    if (req.how === 'error') toast(req.errorText || '请求失败');
    if (req.kind === 'send') restoreDraft(req);
    else if (req.convId && req.how === 'error' && req.errorStatus && req.errorStatus < 500) {
      // 服务不让重试（最后一条不是出错的回复、正在回复……）：出错的气泡留着，不再给「重试」；
      // 网络错误、服务那边的错误不算，还能再点
      const last = db.msgs(req.convId).at(-1);
      if (last) retryDenied.add(retryKey(req.convId, last.seq));
    }
    if (chatState.get().creating === req.id) chatState.set({ creating: null });
    drop(req);
  } else if (req.how !== 'end') {
    // 出错或中止：有内容的留着（标「回复出错中断」「已中止」，出错的下面有「重试」）
    req.shown = req.shown || req.how === 'error' || req.sawAbort;
  }
  flight();
  sweepLater(req.lingerUntil - Date.now() + CURSOR_GRACE_MS);
}

function drop(req: Req) {
  const i = reqs.indexOf(req);
  if (i >= 0) reqs.splice(i, 1);
  if (req.kind === 'send' && !req.accepted) return; // 图片放回输入框了，预览地址还要用
  for (const a of req.atts) URL.revokeObjectURL(a.url);
}

/** 光标停留到 lingerUntil 以后，再留这么久才清：逐字输出放完队列里剩下的字要一会儿（最多约 0.3 秒，lib/typing.ts 的 LAG_MS），
 *  停留是从放完起算的，再加光标淡出的 0.5 秒（Typed.tsx） */
const CURSOR_GRACE_MS = 1000;

/** 结束了、光标停够了的请求，回复已经写进历史（或者本来就没有内容）的，不再需要了。出错的（没写进历史、留着给「重试」用的）留到下一次发送 */
function sweep() {
  const now = Date.now();
  let changed = false;
  for (const r of [...reqs]) {
    if (!r.finished || now < r.lingerUntil + CURSOR_GRACE_MS) continue;
    const written = !!r.convId && !!r.replyId && db.msgs(r.convId).some((m) => m.id === r.replyId);
    const keep = r.how === 'error' && r.accepted && !written;
    if (written || (!r.content && !keep)) {
      drop(r);
      changed = true;
    }
  }
  if (changed) flight();
}
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
function sweepLater(ms: number) {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweep, Math.max(0, ms));
}
bus.on('message', () => sweepLater(300));
// SSE 不通时回复没经 message 事件写进历史：重新连上、补取到历史以后也要清
bus.on('conv:messages', () => sweepLater(300));

/** 服务收下了新的一次发送、重试：这个会话里出了错留着的旧请求不再留（没收下之前留着，被拒了气泡还在） */
function forgetFinished(except: Req) {
  for (const r of [...reqs])
    if (r !== except && r.finished && r.convId === except.convId && r.how === 'error') drop(r);
}

function restoreDraft(req: Req) {
  const d = draftOf(req.draftKey);
  if (!d.text) d.text = req.preview.text;
  for (const a of req.atts) if (d.atts.length < MAX_IMAGES) d.atts.push(a);
  draftChanged();
  bus.emit('chat:flight');
}

function newReq(
  kind: Req['kind'],
  convId: string | null,
  key: string,
  preview: Req['preview'],
  atts: Att[],
  messages: ChatMessage[],
): Req {
  const req: Req = {
    id: uid('req'),
    kind,
    chat: undefined as never,
    convId,
    fromNew: convId === null,
    draftKey: key,
    preview,
    atts,
    startedAt: Date.now(),
    accepted: false,
    queued: false,
    content: false,
    shown: false,
    sawAbort: false,
    finished: false,
    how: null,
    lingerUntil: 0,
  };
  req.chat = new Chat<ChatMessage>({
    id: req.id,
    messages,
    transport: getSource().chat.transport((c) => onChunk(req, c)),
    onError: (e) => {
      req.errorText = chatErrorText(e);
      req.errorStatus = chatErrorStatus(e);
    },
    onFinish: ({ isAbort, isError }) => finish(req, isError, isAbort),
  });
  reqs.push(req);
  if (convId === null) chatState.set({ creating: req.id });
  flight();
  return req;
}

/* ---------- 图片 ---------- */

/** 往草稿里加图片（粘贴、拖入）：只收几种格式，每张不超过 20 MB，一条消息最多 10 张；不合的不加，在输入框上提示 */
export function addFiles(key: string, files: File[]) {
  const d = draftOf(key);
  const msgs: string[] = [];
  let notImage = false;
  for (const f of files) {
    const name = f.name || '粘贴的图片';
    if (!f.type.startsWith('image/')) {
      notImage = true;
      continue;
    }
    if (!IMAGE_TYPES.includes(f.type)) {
      msgs.push(`「${name}」不是 PNG、JPEG、WebP、GIF，不收`);
      continue;
    }
    if (f.size > MAX_BYTES) {
      msgs.push(`「${name}」超过 20 MB，不收`);
      continue;
    }
    if (d.atts.length >= MAX_IMAGES) {
      msgs.push(`一条消息最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    d.atts.push({
      id: uid('att'),
      file: f,
      url: URL.createObjectURL(f),
      name,
      type: f.type,
      bytes: f.size,
      state: 'ready',
    });
  }
  if (notImage && !msgs.length && files.length) toast('只能放图片');
  setNote(key, msgs.length ? { text: msgs.join('；'), err: true } : undefined);
}
const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();
function setNote(key: string, note: { text: string; err: boolean } | undefined) {
  const d = draftOf(key);
  d.note = note;
  clearTimeout(noteTimers.get(key));
  if (note)
    noteTimers.set(
      key,
      setTimeout(() => setNote(key, undefined), 6000),
    );
  draftChanged();
}
export function removeAtt(key: string, id: string) {
  const d = draftOf(key);
  const i = d.atts.findIndex((a) => a.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(d.atts[i].url);
  d.atts.splice(i, 1);
  if (!d.atts.some((a) => a.state === 'failed') && d.note?.err) setNote(key, undefined);
  draftChanged();
}

async function uploadOne(a: Att) {
  a.state = 'uploading';
  a.error = undefined;
  draftChanged();
  try {
    a.ref = await getSource().chat.upload(a.file);
    a.state = 'done';
  } catch (e) {
    a.state = 'failed';
    a.error = e instanceof Error ? e.message : '上传失败';
  }
  draftChanged();
}

/* ---------- 发送、重试、中止 ---------- */

/**
 * 发送：先把还没传的图片传上去（有一张失败就不发，留着文字和图片，提示哪张怎么了），再发出请求。
 * 生成中也能发：服务把它排队。返回有没有发出去
 */
export async function sendChat(convId: string | null, rawText: string): Promise<boolean> {
  const key = draftKey(convId);
  const d = draftOf(key);
  const text = rawText.trim();
  if ((!text && !d.atts.length) || d.sending) return false;
  d.sending = true;
  setNote(key, undefined);
  try {
    const pending = d.atts.filter((a) => a.state !== 'done');
    await Promise.all(pending.map(uploadOne));
    const failed = d.atts.filter((a) => a.state === 'failed');
    if (failed.length) {
      setNote(key, {
        text: `「${failed[0].name}」没传上去：${failed[0].error ?? '上传失败'}。去掉它，或者再点发送重试`,
        err: true,
      });
      return false;
    }
    // 上传时用户可能又加了图、改了字：以现在草稿里的图片为准
    const atts = d.atts.splice(0);
    if (!atts.length && !text) return false;
    d.text = '';
    const files: FileUIPart[] = atts.map((a) => ({
      type: 'file',
      mediaType: a.ref!.mediaType,
      url: a.ref!.url,
      filename: a.name,
    }));
    const req = newReq('send', convId, key, { text, images: atts.map((a) => a.url) }, atts, []);
    const meta: SendMeta = convId ? { conversationId: convId } : {};
    void req.chat
      .sendMessage({ ...(text ? { text } : {}), files }, { metadata: meta })
      .catch(() => {});
    draftChanged();
    bus.emit('chat:sent', { convId });
    return true;
  } finally {
    d.sending = false;
    draftChanged();
  }
}

/** 重试：让洛璃对着同样的历史再回复一次。只在上一次回复出错、没有在生成时可用，服务端也会检查（不符合回 409） */
export function retryChat(convId: string) {
  if (isBusy(convId)) return;
  // regenerate 需要 Chat 里至少有一条消息；请求体不带消息（见 chatRequestBody），这条只是个占位
  const placeholder: ChatMessage = {
    id: uid('m'),
    role: 'user',
    parts: [{ type: 'text', text: '' }],
  };
  const req = newReq(
    'retry',
    convId,
    draftKey(convId),
    { text: '', images: [] },
    [],
    [placeholder],
  );
  const meta: SendMeta = { conversationId: convId };
  void req.chat.regenerate({ metadata: meta }).catch(() => {});
  bus.emit('chat:sent', { convId });
}

/** 中止这个会话进行中的回复，同时取消排队的补回复（排队的消息留在历史里）。还没建好的新会话，直接断开请求 */
export async function abortChat(convId: string | null) {
  if (convId === null) {
    for (const r of reqs) if (r.convId === null && !r.finished) void r.chat.stop();
    return;
  }
  try {
    await getSource().chat.abort(convId);
  } catch (e) {
    toast(chatErrorText(e));
  }
}

/** 数据整批重置（重新连上服务、切换模拟数据）、会话没了：丢掉这个会话里发出的请求 */
export function disposeChat(convId: string) {
  for (const r of [...reqs]) {
    if (r.convId !== convId) continue;
    void r.chat.stop().catch(() => {});
    drop(r);
  }
  flight();
}
bus.on('conv:remove', ({ id }) => disposeChat(id));
bus.on('data:reset', () => {
  // 正式构建里只有第一次取到数据时会发：它可能比用户发出的第一句晚（SSE 不通、很慢），这时发出的请求不能因此中止；
  // 模拟数据切换时旧数据里的请求都不要了
  const live = getSource().kind === 'live';
  for (const r of [...reqs]) {
    if (live && (r.convId === null || db.conv(r.convId))) continue;
    void r.chat.stop().catch(() => {});
    drop(r);
  }
  flight();
});
