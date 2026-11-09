import { applyLive, applyStatus } from '../model/live-feed';
import type { ImageInfo } from '../model/types';
import { WEB_AUTHOR } from './demo-state';
import type {
  Hello,
  LastReply,
  LiveEvent,
  LivePart,
  LiveReply,
  LiveRetry,
  LiveSnapshot,
  LiveState,
  LiveTool,
  ServiceStatus,
} from '../../server/types';

/* 模拟洛璃服务的「此刻」：开发模式里模拟 bot（bot.ts）通过它发回复的进展。
   它像真实的服务（src/server/live.ts）那样维护每个进行中回复的现场，每改一次现场就推一个 live 事件（seq 递增，
   一个不缺），客户端收到的事件和连上时拿到的现场（snapshot）与正式构建里服务推来的一样，走同一份处理（model/live-feed.ts）。
   服务的状态（Telegram 启没启动、连没连上、上次在线、助手的名字、上次回复）也在这里（mockStatus）。 */

type Draft = LiveEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'seq' | 'at'>
    : never
  : never;

const iso = (t = Date.now()) => new Date(t).toISOString();

class MockLive {
  private replies = new Map<string, LiveReply>();
  private steps = new Map<string, number>();
  private seq = 0;
  /** 推给客户端（开发模式里直接交给 live-feed；演示「断线重连」时暂时断开） */
  connected = true;

  private emit(draft: Draft, at = Date.now()) {
    this.seq++;
    const ev = { ...draft, seq: this.seq, at: iso(at) } as LiveEvent;
    if (this.connected) applyLive(ev);
  }
  private progress(r: LiveReply) {
    return {
      conversationId: r.conversationId,
      ...(r.replyId ? { replyId: r.replyId } : {}),
      state: r.state,
      ...(r.state === 'tool' && r.toolName ? { toolName: r.toolName } : {}),
    };
  }
  private setState(r: LiveReply, state: LiveState, toolName?: string) {
    r.state = state;
    if (state === 'tool' && toolName) r.toolName = toolName;
    else delete r.toolName;
  }
  private need(convId: string) {
    return this.replies.get(convId);
  }
  has(convId: string) {
    return this.replies.has(convId);
  }

  /** 等待合并（Telegram 被触发） */
  wait(convId: string) {
    if (this.replies.has(convId)) return;
    const at = Date.now();
    const r: LiveReply = {
      conversationId: convId,
      state: 'waiting',
      waitingSince: iso(at),
      again: false,
      parts: [],
    };
    this.replies.set(convId, r);
    this.emit({ type: 'wait', ...this.progress(r) }, at);
  }
  /** 回复中又被触发 */
  again(convId: string) {
    const r = this.need(convId);
    if (r) {
      if (r.again) return;
      r.again = true;
      this.emit({ type: 'again', ...this.progress(r) });
      return;
    }
    const n: LiveReply = { conversationId: convId, state: 'waiting', again: true, parts: [] };
    this.replies.set(convId, n);
    this.emit({ type: 'again', ...this.progress(n) });
  }
  /** 等待合并被放弃 */
  cancel(convId: string) {
    const r = this.need(convId);
    if (!r || r.startedAt !== undefined) return;
    this.replies.delete(convId);
    this.emit({ type: 'cancel', conversationId: convId });
  }
  start(convId: string, replyId: string) {
    const at = Date.now();
    const old = this.need(convId);
    const waiting = old?.startedAt === undefined ? old?.waitingSince : undefined;
    const r: LiveReply = {
      conversationId: convId,
      replyId,
      state: 'thinking',
      ...(waiting ? { waitingSince: waiting } : {}),
      startedAt: iso(at),
      again: waiting !== undefined && !!old?.again,
      parts: [],
    };
    this.replies.set(convId, r);
    this.steps.set(convId, 1);
    this.emit({ type: 'start', ...this.progress(r) }, at);
  }
  /** 下一步（向模型再发一次请求） */
  nextStep(convId: string) {
    this.steps.set(convId, (this.steps.get(convId) ?? 1) + 1);
  }
  private step(convId: string) {
    return this.steps.get(convId) ?? 1;
  }

  /** 开始一段思考，返回它在 parts 里的下标 */
  reasoningStart(convId: string): number {
    const r = this.need(convId)!;
    const at = Date.now();
    const index =
      r.parts.push({
        type: 'reasoning',
        step: this.step(convId),
        text: '',
        startedAt: iso(at),
      }) - 1;
    this.setState(r, 'thinking');
    this.emit(
      { type: 'reasoning-start', ...this.progress(r), part: index, step: this.step(convId) },
      at,
    );
    return index;
  }
  reasoningDelta(convId: string, part: number, text: string) {
    const r = this.need(convId)!;
    const p = r.parts[part];
    if (p?.type !== 'reasoning') return;
    p.text += text;
    this.setState(r, 'thinking');
    this.emit({ type: 'reasoning-delta', ...this.progress(r), part, text });
  }
  /** 返回这段思考用了多少毫秒（取自推出去的开始、结束时间） */
  reasoningEnd(convId: string, part: number): number {
    const r = this.need(convId)!;
    const p = r.parts[part];
    if (p?.type !== 'reasoning' || p.endedAt) return 0;
    const at = Date.now();
    p.endedAt = iso(at);
    this.emit({ type: 'reasoning-end', ...this.progress(r), part, startedAt: p.startedAt }, at);
    return at - Date.parse(p.startedAt);
  }
  /** 文字接在这一步最后一段文字后面；没有就新建一段 */
  text(convId: string, text: string) {
    const r = this.need(convId)!;
    const step = this.step(convId);
    let index = r.parts.length - 1;
    let p = r.parts[index] as LivePart | undefined;
    if (p?.type !== 'text' || p.step !== step) {
      p = { type: 'text', step, text: '' };
      index = r.parts.push(p) - 1;
    }
    p.text += text;
    this.setState(r, 'replying');
    this.emit({ type: 'text-delta', ...this.progress(r), part: index, step, text });
  }
  toolStart(
    convId: string,
    callId: string,
    name: string,
    input: unknown,
    summary?: string,
  ): number {
    const r = this.need(convId)!;
    const at = Date.now();
    const json = JSON.stringify(input);
    const part: LiveTool = {
      type: 'tool',
      step: this.step(convId),
      callId,
      name,
      input: json.length > 200 ? json.slice(0, 199) + '…' : json,
      ...(summary ? { summary } : {}),
      startedAt: iso(at),
    };
    const index = r.parts.push(part) - 1;
    this.setState(r, 'tool', name);
    this.emit(
      {
        type: 'tool-start',
        ...this.progress(r),
        part: index,
        step: part.step,
        callId,
        name,
        input: part.input,
        ...(part.summary ? { summary: part.summary } : {}),
      },
      at,
    );
    return index;
  }
  toolEnd(
    convId: string,
    callId: string,
    result:
      | { ok: true; images?: ImageInfo[]; summary?: string }
      | { ok: false; error: string; summary?: string },
  ): number {
    const r = this.need(convId)!;
    const index = r.parts.findIndex((p) => p.type === 'tool' && p.callId === callId);
    const part = r.parts[index];
    if (part?.type !== 'tool' || part.endedAt) return 0;
    const at = Date.now();
    part.endedAt = iso(at);
    part.ok = result.ok;
    if (result.summary) part.summary = result.summary;
    if (result.ok) {
      if (result.images?.length) part.images = result.images;
    } else part.error = result.error;
    const running = r.parts.filter(
      (p): p is LiveTool => p.type === 'tool' && p.endedAt === undefined,
    );
    const latest = running.at(-1);
    if (latest) this.setState(r, 'tool', latest.name);
    else this.setState(r, 'thinking');
    this.emit(
      {
        type: 'tool-end',
        ...this.progress(r),
        part: index,
        callId,
        startedAt: part.startedAt,
        ok: part.ok,
        ...(part.error !== undefined ? { error: part.error } : {}),
        ...(part.images ? { images: part.images } : {}),
        ...(part.summary ? { summary: part.summary } : {}),
      },
      at,
    );
    return at - Date.parse(part.startedAt);
  }
  /** 网页会话生成中又发了消息（排队）：现场里那条记上「又被触发」与排队的起点；没有现场（回复刚结束）时新建一条等着补回复的 */
  queue(convId: string, fromSeq: number) {
    const r = this.replies.get(convId);
    if (r) {
      if (r.again && r.queuedFrom !== undefined) return;
      r.again = true;
      r.queuedFrom = fromSeq;
      this.emit({ type: 'again', ...this.progress(r), queuedFrom: fromSeq });
      return;
    }
    const n: LiveReply = {
      conversationId: convId,
      state: 'waiting',
      again: true,
      queuedFrom: fromSeq,
      parts: [],
    };
    this.replies.set(convId, n);
    this.emit({ type: 'again', ...this.progress(n), queuedFrom: fromSeq });
  }
  /** 排队的补回复取消了（发那条消息的请求断开、中止）：进行中的那条去掉排队；只是在等补回复的整条去掉 */
  unqueue(convId: string) {
    const r = this.replies.get(convId);
    if (!r || r.queuedFrom === undefined) return;
    if (r.startedAt === undefined) {
      this.replies.delete(convId);
      this.emit({ type: 'cancel', conversationId: convId });
      return;
    }
    r.again = false;
    delete r.queuedFrom;
    this.emit({ type: 'dequeue', ...this.progress(r) });
  }
  retry(convId: string, retry: Omit<LiveRetry, 'at'>) {
    const r = this.need(convId)!;
    const at = Date.now();
    r.retry = { ...retry, at: iso(at) };
    this.setState(r, 'retry');
    this.emit({ type: 'retry', ...this.progress(r), retry: r.retry }, at);
  }
  /** 流中途出错重新生成：这一步已有的内容作废，parts 只留前 keep 段 */
  resetStep(convId: string, keep: number) {
    const r = this.need(convId)!;
    r.parts.splice(keep);
    this.setState(r, 'thinking');
    this.emit({ type: 'reset', ...this.progress(r), step: this.step(convId), keep });
  }
  /** 回复结束：先收尾还开着的思考与工具调用，再推 end，从现场里去掉 */
  end(
    convId: string,
    outcome: 'completed' | 'failed' | 'aborted',
    extra: {
      usage?: { input?: number; cacheRead?: number; output?: number };
      error?: string;
      statusCode?: number;
    } = {},
  ) {
    const r = this.need(convId);
    if (!r) return;
    if (r.startedAt === undefined) {
      this.cancel(convId);
      return;
    }
    r.parts.forEach((p, i) => {
      if (p.type === 'reasoning' && !p.endedAt) this.reasoningEnd(convId, i);
      if (p.type === 'tool' && !p.endedAt)
        this.toolEnd(convId, p.callId, { ok: false, error: '工具调用未完成' });
    });
    const at = Date.now();
    this.replies.delete(convId);
    this.steps.delete(convId);
    if (outcome === 'completed') this.lastReply = { conversationId: convId, at: iso(at) };
    this.emit(
      {
        type: 'end',
        conversationId: convId,
        ...(r.replyId ? { replyId: r.replyId } : {}),
        outcome,
        startedAt: r.startedAt,
        ...(outcome === 'completed' && extra.usage ? { usage: extra.usage } : {}),
        ...(outcome === 'failed' && extra.error !== undefined
          ? {
              error: extra.error,
              ...(extra.statusCode ? { statusCode: extra.statusCode } : {}),
            }
          : {}),
        ...(this.lastReply ? { lastReply: this.lastReply } : {}),
      },
      at,
    );
  }

  /** 上次回复：初始取自模拟数据里最近一条助手消息 */
  lastReply: LastReply | undefined;

  snapshot(): LiveSnapshot {
    return { seq: this.seq, replies: structuredClone([...this.replies.values()]) };
  }
  /** 切换数据：现场清空（序号接着走，客户端那边也重置） */
  clear() {
    this.replies.clear();
    this.steps.clear();
    this.seq = 0;
  }
}
export const mockLive = new MockLive();

/* 服务的状态 */
class MockStatus {
  enabled = true;
  connected = true;
  lastOnlineAt: number | undefined = Date.now();
  name = '洛璃';
  wakeWords = ['nori'];
  username = 'luoli_bot';
  private startedAt = Date.now();

  get(): ServiceStatus {
    const enabled = this.enabled;
    return {
      startedAt: iso(this.startedAt),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      telegram: {
        enabled,
        connected: enabled && this.connected,
        ...(enabled && this.lastOnlineAt ? { lastOnlineAt: iso(this.lastOnlineAt) } : {}),
      },
      assistant: {
        name: this.name,
        wakeWords: enabled ? this.wakeWords : [],
        ...(enabled ? { username: this.username } : {}),
      },
      web: { author: WEB_AUTHOR },
      ...(mockLive.lastReply ? { lastReply: mockLive.lastReply } : {}),
    };
  }
  hello(): Hello {
    return { ...this.get(), live: mockLive.snapshot() };
  }
  /** Telegram 连上、断开：像服务那样推 status 事件 */
  setConnected(on: boolean) {
    if (on === this.connected) return;
    // 离线时显示「上次在线」：断开的那一刻
    if (!on) this.lastOnlineAt = Date.now();
    this.connected = on;
    this.push();
  }
  /** 启动、不启动 Telegram 前端（服务重启才能改，这里只是演示） */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.connected = true;
    this.push();
  }
  push() {
    applyStatus(this.get());
  }
  reset() {
    this.enabled = true;
    this.connected = true;
    this.lastOnlineAt = Date.now();
  }
}
export const mockStatus = new MockStatus();
