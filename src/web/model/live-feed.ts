import { bus } from './bus';
import { nowModel } from './nowModel';
import { argsLine } from './parts';
import { replyInfo } from './replyInfo';
import { status } from './status';
import { setAssistant, setWebAuthor } from './who';
import type { Hello, LiveEvent, LiveReply, LivePart, ServiceStatus } from '../../server/types';

/* 服务推来的「此刻」数据（hello 里的现场、status 事件、live 事件）变成总线事件：nowModel、status 只认总线事件，
   开发模式的模拟服务（dev/mock-live.ts）发的是同样的 live 事件和现场，所以它们只认一种。

   不丢不重：现场里的 seq 是它包含的最后一个 live 事件的序号，之后收到的 live 事件序号一个接一个。
   序号小于等于已经收到的丢掉；中间缺了（理论上不会，服务积压太多会先断开连接）就让数据源重连，从现场重来。 */

let lastSeq = 0;
/** 缺了事件，等下一个 hello 再恢复；这期间的 live 事件都不收 */
let broken = false;
let onGap: (() => void) | null = null;
/** 数据源注册：缺了事件时调它（重新连接，拿新的现场） */
export function setGapHandler(fn: (() => void) | null) {
  onGap = fn;
}

const ms = (iso: string) => Date.parse(iso);

/** 各会话的思考内容攒着，思考结束时一起给「此刻」（思考中显示「思考中…」，不逐字显示） */
const thoughts = new Map<string, Map<number, string>>();
const thoughtOf = (convId: string) => {
  let m = thoughts.get(convId);
  if (!m) thoughts.set(convId, (m = new Map()));
  return m;
};

function handle(ev: LiveEvent) {
  const convId = ev.conversationId;
  const replyId = ev.replyId ?? '';
  const at = ms(ev.at);
  switch (ev.type) {
    case 'wait':
      bus.emit('reply:wait', { convId, at });
      break;
    case 'again':
      bus.emit('reply:queued', { convId, queuedFrom: ev.queuedFrom });
      break;
    case 'dequeue':
      bus.emit('reply:dequeue', { convId });
      break;
    case 'cancel':
      thoughts.delete(convId);
      bus.emit('reply:cancel', { convId });
      return;
    case 'start':
      thoughts.delete(convId);
      bus.emit('reply:start', { convId, replyId, at, again: ev.again, queuedFrom: ev.queuedFrom });
      break;
    case 'reasoning-start':
      thoughtOf(convId).set(ev.part, '');
      bus.emit('reply:think', { convId, replyId, part: ev.part, at });
      break;
    case 'reasoning-delta': {
      const m = thoughtOf(convId);
      m.set(ev.part, (m.get(ev.part) ?? '') + ev.text);
      break;
    }
    case 'reasoning-end': {
      const m = thoughtOf(convId);
      const text = m.get(ev.part) ?? '';
      m.delete(ev.part);
      // 「思考了 N 秒」：服务打的开始、结束时间之差，至少 1 秒
      const sec = Math.max(1, Math.round((at - ms(ev.startedAt)) / 1000));
      bus.emit('reply:thinkEnd', { convId, replyId, sec, text });
      break;
    }
    case 'text-delta':
      bus.emit('reply:delta', { convId, replyId, text: ev.text, part: ev.part, at });
      break;
    case 'tool-start':
      bus.emit('tool:start', {
        convId,
        replyId,
        callId: ev.callId,
        name: ev.name,
        label: ev.summary ?? argsLine(ev.input),
        summary: ev.summary,
        part: ev.part,
        at,
      });
      break;
    case 'tool-end':
      bus.emit('tool:end', {
        convId,
        replyId,
        callId: ev.callId,
        ok: ev.ok,
        ms: Math.max(0, at - ms(ev.startedAt)),
        error: ev.error,
        images: ev.images,
        summary: ev.summary,
      });
      break;
    case 'retry':
      bus.emit('reply:retry', {
        convId,
        replyId,
        attempt: ev.retry.attempt,
        max: ev.retry.maxRetries,
        status: ev.retry.statusCode,
        phase: ev.retry.phase,
        at: ms(ev.retry.at),
      });
      break;
    case 'reset':
      bus.emit('reply:reset', { convId, replyId, keep: ev.keep });
      break;
    case 'end': {
      thoughts.delete(convId);
      const took = Math.max(0, at - ms(ev.startedAt));
      if (ev.outcome === 'completed') {
        bus.emit('reply:end', {
          convId,
          replyId,
          ms: took,
          usage: {
            input: ev.usage?.input,
            cache: ev.usage?.cacheRead,
            output: ev.usage?.output,
          },
        });
      } else if (ev.outcome === 'failed') {
        bus.emit('reply:error', {
          convId,
          replyId,
          status: ev.statusCode,
          message: ev.error,
        });
      } else bus.emit('reply:abort', { convId, replyId });
      // 上次回复：以服务说的为准（回复结束时刻）
      if (ev.lastReply) {
        status.setLastReply(ev.lastReply.conversationId, ms(ev.lastReply.at));
        nowModel.resetLast();
      }
      return;
    }
  }
  // 状态：以服务给的为准（工具结束后还有别的工具在跑时仍是 tool，等等）
  if ('state' in ev)
    bus.emit('reply:state', { convId, replyId: ev.replyId, state: ev.state, tool: ev.toolName });
}

/** 收到一个 live 事件 */
export function applyLive(ev: LiveEvent) {
  if (broken || ev.seq <= lastSeq) return;
  if (ev.seq !== lastSeq + 1) {
    broken = true;
    onGap?.();
    return;
  }
  lastSeq = ev.seq;
  handle(ev);
}

/** 现场里的一段，按它在回复里的位置变成事件（和实时收到的一样处理） */
function replayPart(r: LiveReply, part: LivePart, index: number) {
  const convId = r.conversationId;
  const replyId = r.replyId ?? '';
  if (part.type === 'reasoning') {
    bus.emit('reply:think', { convId, replyId, part: index, at: ms(part.startedAt) });
    if (part.endedAt)
      bus.emit('reply:thinkEnd', {
        convId,
        replyId,
        sec: Math.max(1, Math.round((ms(part.endedAt) - ms(part.startedAt)) / 1000)),
        text: part.text,
      });
    else thoughtOf(convId).set(index, part.text);
  } else if (part.type === 'text') {
    bus.emit('reply:delta', { convId, replyId, text: part.text, part: index });
  } else {
    bus.emit('tool:start', {
      convId,
      replyId,
      callId: part.callId,
      name: part.name,
      label: part.summary ?? argsLine(part.input),
      summary: part.summary,
      part: index,
      at: ms(part.startedAt),
    });
    if (part.endedAt)
      bus.emit('tool:end', {
        convId,
        replyId,
        callId: part.callId,
        ok: part.ok ?? false,
        ms: Math.max(0, ms(part.endedAt) - ms(part.startedAt)),
        error: part.error,
        images: part.images,
        summary: part.summary,
      });
  }
}

/** 按现场重建「此刻」和状态：进行中的回复已有的文字、思考、工具都放回去，之后接着收增量 */
function applySnapshot(live: Hello['live']) {
  lastSeq = live.seq;
  broken = false;
  thoughts.clear();
  const ids = new Set(live.replies.map((r) => r.conversationId));
  // 断开期间结束了的回复：不再算进行中
  replyInfo.reconcile(ids);
  nowModel.rebuild(ids, () => {
    for (const r of live.replies) {
      const convId = r.conversationId;
      if (r.waitingSince) bus.emit('reply:wait', { convId, at: ms(r.waitingSince) });
      if (r.replyId && r.startedAt)
        bus.emit('reply:start', { convId, replyId: r.replyId, at: ms(r.startedAt) });
      r.parts.forEach((p, i) => replayPart(r, p, i));
      if (r.retry)
        bus.emit('reply:retry', {
          convId,
          replyId: r.replyId ?? '',
          attempt: r.retry.attempt,
          max: r.retry.maxRetries,
          status: r.retry.statusCode,
          phase: r.retry.phase,
          at: ms(r.retry.at),
        });
      if (r.again) bus.emit('reply:queued', { convId, queuedFrom: r.queuedFrom });
      bus.emit('reply:state', { convId, replyId: r.replyId, state: r.state, tool: r.toolName });
    }
  });
}

/** 服务的状态变了（hello 里、status 事件）：助手的名字、网页会话发言人的名字、Telegram 的连接、上次回复 */
export function applyStatus(s: ServiceStatus) {
  setAssistant({
    name: s.assistant.name,
    wakeWords: s.assistant.wakeWords,
    username: s.assistant.username,
  });
  setWebAuthor(s.web.author);
  if (status.tgEnabled !== s.telegram.enabled) {
    status.tgEnabled = s.telegram.enabled;
    status.emit();
  }
  // 没启动 Telegram 不算离线：显示「空闲」
  const connected = !s.telegram.enabled || s.telegram.connected;
  const lastOnlineAt = s.telegram.lastOnlineAt ? ms(s.telegram.lastOnlineAt) : null;
  if (connected !== status.online)
    bus.emit(connected ? 'bot:online' : 'bot:offline', { lastOnlineAt });
  else if (!connected && status.lastOnlineAt !== lastOnlineAt) {
    status.lastOnlineAt = lastOnlineAt;
    status.emit();
  }
  if (s.lastReply) {
    const at = ms(s.lastReply.at);
    if (status.lastReplyConv !== s.lastReply.conversationId || status.lastReplyAt !== at) {
      status.setLastReply(s.lastReply.conversationId, at);
      nowModel.resetLast();
      status.emit();
    }
  }
}

/** 连上（每次 hello，含重连）：状态，加上现场 */
export function applyHello(h: Hello) {
  applyStatus(h);
  applySnapshot(h.live);
}

/** 全部清掉（开发模式切换数据） */
export function resetLive() {
  lastSeq = 0;
  broken = false;
  thoughts.clear();
  replyInfo.reset();
  nowModel.reset();
  status.reset();
}
