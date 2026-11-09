import type { ChatTransport, UIMessageChunk } from 'ai';
import { chars, randi, uid } from '../lib/util';
import { ApiError } from '../model/api';
import { chatRequestBody, ObservedTransport } from '../model/chat-api';
import type { ChatApi } from '../model/chat-api';
import { textOf } from '../model/parts';
import type { ImageInfo, ImagePart, Part, ToolResultInfo } from '../model/types';
import type {
  AbortResponse,
  ChatMessage,
  ChatRequest,
  LiveTask,
  UploadResponse,
} from '../../server/types';
import { WEB_AUTHOR } from './demo-state';
import { mockLive } from './mock-live';
import { mockServer as server, svgImage, toolBody } from './mock-server';
import { imgPart, toolSummary } from './seed';

/* 模拟的对话接口（开发模式用）：在浏览器里照洛璃服务的 POST /api/chat、POST /api/chat/:id/abort、POST /api/files 做一遍，
   所以开发模式里网页对话走的是和正式构建同一份代码（chatCore.ts、useChat），只是 transport 换成这里。
   - 发消息：新会话（标题取前 16 个字）、消息马上写进模拟服务（它像真实的服务那样推 message、conversation 事件）、
     流里先有 data-conversation，生成中再发的排队（data-queued）、当前回复结束后补一次回复、补回复的流交给最后一个排队的请求；
   - 回复的流和「此刻」的实时事件（mockLive）一起发，序号、思考秒数、工具摘要与耗时都照服务的做法；
   - 中止：断开请求就是中止；POST abort 同时取消排队的补回复；重试只在最后一条是出错的回复时可以；
   - 不调用任何模型。回复的内容按消息里的字眼挑：网址、「图」、「查/搜/星座/天气」调一次 fetch；「出错」「报错」输出到第 14 个字时出错；
     「重试」先失败一次再成功；「慢」说很久（试排队、中止用）；带图就说收到几张图。 */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 出错时抛的东西：和 ai 的 APICallError 一样带 statusCode、responseBody，chatErrorText 能认出来 */
const httpError = (statusCode: number, error: string) =>
  Object.assign(new Error(JSON.stringify({ error })), {
    statusCode,
    responseBody: JSON.stringify({ error }),
  });

/* ---------- 回复的剧本 ---------- */
const REPLIES = [
  '好呀～ 我想想……如果只能选一个，我会选第一个！听起来就很有意思！',
  '嘿嘿，这个问题我知道！不过先说好，答错了不许笑我～',
  '收到！我把它记在小本本上了，下次你问我就能想起来～',
  '唔，让我数数星星再回答你……一、二、三……好啦，答案是：先去喝杯水，休息一下眼睛！',
  '这个可以有！要不要我帮你列个清单？一步一步来，一点都不难～',
];
let chatN = 0;
interface Script {
  think: { ms: number; text: string };
  tool?: {
    url: string;
    ms: number;
    title: string;
    chars: number;
    image?: ImagePart;
    fail?: string;
  };
  text: string;
  failAt?: number;
  retry?: boolean;
}
/** 任务到点触发的回复：没有人说话，照任务说的做 */
function taskScript(tasks: LiveTask[]): Script {
  return {
    think: { ms: randi(900, 1500), text: '任务到点了，按任务里写的做。' },
    text: tasks.map((t) => `到点啦～ ${t.action}`).join('\n'),
  };
}
function scriptOf(text: string, nImg: number): Script {
  const think = { ms: randi(1100, 2000), text: '想一想怎么回答比较好。' };
  const url = (text.match(/https?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|dev)\S*/i) ||
    [])[0];
  chatN++;
  const base: Script = { think, text: REPLIES[chatN % REPLIES.length] };
  if (/重试/.test(text)) base.retry = true;
  if (/出错|报错/.test(text)) base.failAt = 14;
  if (/慢/.test(text)) base.text = REPLIES.join('').repeat(2);
  if (url) {
    const bad = /gone|404/.test(url);
    return {
      ...base,
      tool: {
        url: url.replace(/^https?:\/\//, ''),
        ms: 760,
        title: '一个示例页面，正文只有几段说明文字',
        chars: 1460,
        image: /图|封面/.test(text) ? imgPart(205, 45, '封面.jpg', 600, 400) : undefined,
        fail: bad ? '抓取失败：HTTP 404' : undefined,
      },
      text: bad
        ? '这个链接打不开呢，网站返回了 404，可能页面已经被删掉了～'
        : '读完啦！这个页面主要是在说明它自己是一个示例页面，没有别的内容～ 要我帮你找找相关的资料吗？',
    };
  }
  if (nImg && !/慢/.test(text))
    return {
      ...base,
      text: `收到 ${nImg} 张图片啦～ 颜色好温柔，像傍晚的天空。要我帮你描述一下里面的细节吗？`,
    };
  if (/查|搜|星座|天气/.test(text) || chatN % 4 === 0)
    return {
      ...base,
      tool: {
        url: 'zh.wikipedia.org/wiki/星座',
        ms: 910,
        title: '维基百科「星座」条目：全天共 88 个星座',
        chars: 5230,
      },
      text: '我查了一下：全天一共有 88 个星座，其中 12 个在黄道上。冬天最好认的是猎户座，腰带上 3 颗星排成一排～',
    };
  return base;
}

/* ---------- 流的写入端 ---------- */
interface Sink {
  write(chunk: UIMessageChunk): void;
  close(): void;
  closed: boolean;
}
function makeStream(onCancel: () => void) {
  let ctl!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      ctl = c;
    },
    cancel() {
      sink.closed = true;
      onCancel();
    },
  });
  const sink: Sink = {
    closed: false,
    write(chunk) {
      if (!sink.closed) ctl.enqueue(chunk);
    },
    close() {
      if (sink.closed) return;
      sink.closed = true;
      try {
        ctl.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
  return { stream, sink };
}

/* ---------- 每个会话的状态 ---------- */
interface Run {
  replyId: string;
  sink: Sink;
  aborted: boolean;
  wake: Set<() => void>;
}
interface Queue {
  fromSeq: number;
  /** 最后一个排队的请求：补回复的流交给它。任务到点排的补回复没有请求接，是个丢弃的出口（服务自己把流读完） */
  sink: Sink;
  /** 补的这次回复里有任务到点：是哪几个任务 */
  tasks?: LiveTask[];
}
/** 没有请求接着的流：写进去的都丢掉（回复由服务读完，照常写进历史） */
const discardSink = (): Sink => ({ closed: false, write() {}, close() {} });
interface CState {
  run: Run | null;
  queue: Queue | null;
  /** 上一次回复出错、一步都没写进历史时，当时最后一条消息的序号（只有它还是最后一条才能重试） */
  retryAfter: number | null;
}
const states = new Map<string, CState>();
const stateOf = (id: string): CState => {
  let s = states.get(id);
  if (!s) states.set(id, (s = { run: null, queue: null, retryAfter: null }));
  return s;
};
const sleepIn = (run: Run, ms: number) =>
  new Promise<void>((res) => {
    if (run.aborted) return res();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      run.wake.delete(done);
      res();
    }
    run.wake.add(done);
  });
const abortRun = (run: Run) => {
  run.aborted = true;
  for (const w of [...run.wake]) w();
};

/** 一次回复：流里写思考、工具、文字，「此刻」的实时事件同时推；结束时写进历史，再看有没有排队的补回复 */
async function runReply(convId: string, sink: Sink, again = false, tasks?: LiveTask[]) {
  const st = stateOf(convId);
  const run: Run = { replyId: uid('reply'), sink, aborted: false, wake: new Set() };
  st.run = run;
  const conv = server.conv(convId)!;
  const lastUser = [...conv.msgs]
    .reverse()
    .find((m) => m.role === 'user' && !m.message.metadata?.event);
  const sc = tasks?.length
    ? taskScript(tasks)
    : scriptOf(
        lastUser ? textOf(lastUser) : '',
        lastUser ? lastUser.message.parts.filter((p) => p.type === 'file').length : 0,
      );
  // 重试：这次不再出错
  if (again) delete sc.failAt;
  const seq = server.reserve(convId);
  const started = Date.now();
  const parts: Part[] = [];
  const reasoningMs: number[] = [];
  const tools: Record<string, ToolResultInfo> = {};
  const images: Record<string, ImageInfo | null> = {};
  let out = '';
  let attempts = 1;
  let steps = 1;
  let toolCalls = 0;
  const w = (c: UIMessageChunk) => sink.write(c);
  mockLive.start(convId, run.replyId, tasks);
  w({ type: 'start', messageId: run.replyId });

  /** 结束：写进历史、推结束事件、关流，再看补回复。aborted 时没有任何内容就不写 */
  const end = (how: 'completed' | 'aborted' | 'failed', error?: string) => {
    st.run = null;
    const all: Part[] = [...parts];
    if (out) all.push({ type: 'text', text: out });
    const usage = {
      input: randi(1600, 4200),
      cacheRead: 0,
      output: Math.round(chars(out).length * 1.3) + randi(4, 20),
    };
    usage.cacheRead = Math.floor((usage.input * 0.5) / 128) * 128;
    const row = all.length
      ? server.addMsg(
          convId,
          {
            id: run.replyId,
            role: 'assistant',
            parts: all,
            images,
            tools,
            meta: {
              ...(how === 'aborted' ? { aborted: true as const } : {}),
              ...(how === 'failed' ? { failed: true } : {}),
              ...(how === 'completed' ? { usage } : {}),
              ...(reasoningMs.length ? { reasoningMs } : {}),
            },
          },
          seq,
        )
      : null;
    server.addCall({
      conversation_id: convId,
      reply_id: row?.id ?? null,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      first_output_ms: 900,
      attempts,
      outcome: how === 'completed' ? 'completed' : how === 'aborted' ? 'aborted' : 'failed',
      finish_reason: how === 'completed' ? 'stop' : undefined,
      input_tokens: how === 'completed' ? usage.input : null,
      cache_read_tokens: how === 'completed' ? usage.cacheRead : null,
      output_tokens: how === 'completed' ? usage.output : null,
      steps,
      tool_calls: toolCalls,
      error: how === 'failed' ? 'APICallError 429' : null,
    });
    if (how === 'completed') {
      w({ type: 'finish', messageMetadata: { usage } as never });
      if (row) mockLive.lastReply = { conversationId: convId, at: row.createdAt };
    } else if (how === 'aborted') w({ type: 'abort' });
    mockLive.end(
      convId,
      how,
      how === 'completed'
        ? { usage }
        : how === 'failed'
          ? { error: error ?? '请求失败（429）', statusCode: 429 }
          : {},
    );
    sink.close();
    // 出错、一步都没写进历史：记下最后一条消息，之后只有它还是最后一条才能重试
    st.retryAfter = how === 'failed' && !row ? (conv.msgs.at(-1)?.seq ?? 0) : null;
    // 补回复：排队的请求还在，就让它的流带上补的这次回复（看一眼历史，最后一条已经是助手的就不补）
    const q = st.queue;
    if (!q) return;
    st.queue = null;
    if (conv.msgs.at(-1)?.role === 'assistant' || !server.has(convId)) q.sink.close();
    else void runReply(convId, q.sink, false, q.tasks);
  };

  // 请求失败，自动重试
  if (sc.retry) {
    await sleepIn(run, 900);
    if (run.aborted) return end('aborted');
    w({
      type: 'data-retry',
      data: { phase: 'request', attempt: 1, maxRetries: 2, statusCode: 429 },
      transient: true,
    } as UIMessageChunk);
    mockLive.retry(convId, { phase: 'request', attempt: 1, maxRetries: 2, statusCode: 429 });
    attempts++;
    await sleepIn(run, 1800);
    if (run.aborted) return end('aborted');
  }

  // 思考
  const thinkId = uid('r');
  w({ type: 'start-step' });
  w({ type: 'reasoning-start', id: thinkId });
  const livePart = mockLive.reasoningStart(convId);
  const cs = chars(sc.think.text);
  const pieces = 3;
  const size = Math.ceil(cs.length / pieces);
  for (let k = 0; k < pieces; k++) {
    await sleepIn(run, sc.think.ms / pieces);
    if (run.aborted) return abortInThought();
    const piece = cs.slice(k * size, (k + 1) * size).join('');
    w({ type: 'reasoning-delta', id: thinkId, delta: piece });
    mockLive.reasoningDelta(convId, livePart, piece);
  }
  w({ type: 'reasoning-end', id: thinkId });
  reasoningMs.push(mockLive.reasoningEnd(convId, livePart));
  parts.push({ type: 'reasoning', text: sc.think.text } as Part);

  function abortInThought() {
    // 还在想时被中止：这段思考不写进历史（没有结束）
    w({ type: 'reasoning-end', id: thinkId });
    return end('aborted');
  }

  // 工具
  if (sc.tool) {
    const t = sc.tool;
    const callId = uid('call');
    toolCalls++;
    w({
      type: 'tool-input-available',
      toolCallId: callId,
      toolName: 'fetch',
      input: { url: t.url },
    });
    mockLive.toolStart(convId, callId, 'fetch', { url: t.url }, t.url);
    await sleepIn(run, 1500);
    if (run.aborted) {
      parts.push({
        type: 'tool-fetch',
        toolCallId: callId,
        state: 'output-error',
        input: { url: t.url },
        errorText: '工具调用未完成',
      } as Part);
      return end('aborted');
    }
    if (t.fail) {
      w({ type: 'tool-output-error', toolCallId: callId, errorText: t.fail });
      const ms = mockLive.toolEnd(convId, callId, { ok: false, error: t.fail, summary: t.url });
      tools[callId] = { chars: t.fail.length, truncated: false, durationMs: ms };
      parts.push({
        type: 'tool-fetch',
        toolCallId: callId,
        state: 'output-error',
        input: { url: t.url },
        errorText: t.fail,
      } as Part);
    } else {
      const text = toolBody(t.title, Math.min(t.chars, 2000));
      let output: unknown = text;
      if (t.image) {
        output = {
          type: 'luoli-content',
          parts: [
            { type: 'text', text },
            {
              type: 'image',
              url: t.image.url,
              mediaType: t.image.mediaType,
              width: t.image.demo?.w,
              height: t.image.demo?.h,
              bytes: 52_000,
            },
          ],
        };
        images[t.image.url] = svgImage(t.image);
      }
      w({ type: 'tool-output-available', toolCallId: callId, output });
      const summary = toolSummary({ url: t.url, summary: t.title });
      const ms = mockLive.toolEnd(convId, callId, {
        ok: true,
        images: t.image ? [svgImage(t.image)] : undefined,
        summary,
      });
      tools[callId] = { chars: t.chars, truncated: t.chars > 2000, summary, durationMs: ms };
      parts.push({
        type: 'tool-fetch',
        toolCallId: callId,
        state: 'output-available',
        input: { url: t.url },
        output,
      } as Part);
    }
    w({ type: 'finish-step' });
    w({ type: 'start-step' });
    mockLive.nextStep(convId);
    steps++;
    await sleepIn(run, 600);
    if (run.aborted) return end('aborted');
  }

  // 正文，逐字
  const textId = uid('t');
  w({ type: 'text-start', id: textId });
  const tcs = chars(sc.text);
  let i = 0;
  while (i < tcs.length) {
    if (sc.failAt !== undefined && i >= sc.failAt) {
      w({ type: 'error', errorText: '请求失败（429）' });
      return end('failed');
    }
    const n = randi(1, 3);
    const chunk = tcs.slice(i, i + n).join('');
    i += n;
    out += chunk;
    w({ type: 'text-delta', id: textId, delta: chunk });
    mockLive.text(convId, chunk);
    await sleepIn(run, randi(45, 90));
    if (run.aborted) return end('aborted');
  }
  w({ type: 'text-end', id: textId });
  w({ type: 'finish-step' });
  end('completed');
}

/* ---------- 接口 ---------- */
function handle(body: ChatRequest): ReadableStream<UIMessageChunk> {
  const retry = 'retry' in body && body.retry === true;
  let convId = body.conversationId;
  if (!retry && !body.text?.trim() && !body.files?.length) throw httpError(400, '消息不能是空的');
  if (convId && !server.has(convId)) throw httpError(404, '没有这个会话');
  if (convId && server.conv(convId)!.platform !== 'web') throw httpError(400, '只能在网页会话里发');
  let seq: number | undefined;
  let title: string | undefined;
  if (retry) {
    const st = stateOf(convId!);
    if (st.run || st.queue) throw httpError(409, '正在回复，等她说完再重试');
    const last = server.conv(convId!)!.msgs.at(-1);
    const failed = last?.role === 'assistant' && !!last.message.metadata?.failed;
    if (!failed && !(last && st.retryAfter === last.seq))
      throw httpError(409, '最后一条不是出错的回复，不用重试');
  } else {
    // 消息先写进历史（服务把它推给面板）；新会话同时建，标题取第一句的前 16 个字（只有图片叫「图片」）
    const text = body.text?.trim() ?? '';
    if (!convId) {
      const cs = chars(text);
      title = text ? (cs.length > 16 ? cs.slice(0, 16).join('') + '…' : text) : '图片';
      server.batch(() => {
        convId = server.addConv({ platform: 'web', kind: 'web', title }).id;
        server.addSeg(convId, 'first', Date.now(), null);
      });
    }
    const fileParts: Part[] = [];
    const imgs: Record<string, ImageInfo | null> = {};
    for (const url of body.files ?? []) {
      const info = uploaded.get(url);
      if (!info) throw httpError(400, '图片不在文件存储里');
      fileParts.push({ type: 'file', mediaType: info.mediaType, url } as Part);
      imgs[url] = info.info;
    }
    const row = server.addMsg(convId!, {
      role: 'user',
      author: { name: WEB_AUTHOR },
      parts: text ? [...fileParts, { type: 'text', text }] : fileParts,
      images: imgs,
    })!;
    seq = row.seq;
  }
  const id = convId!;
  const st = stateOf(id);
  const { stream, sink } = makeStream(() => {
    // 请求断开：它在回复就中止这次回复；它是排队的最后一个就取消补回复（补的那次里有任务到点时不取消，没有请求接流，由服务读完）
    if (st.run?.sink === sink) abortRun(st.run);
    else if (st.queue?.sink === sink) {
      if (st.queue.tasks?.length) st.queue.sink = discardSink();
      else {
        st.queue = null;
        mockLive.unqueue(id);
      }
    }
  });
  sink.write({
    type: 'data-conversation',
    data: {
      conversationId: id,
      ...(seq !== undefined ? { seq } : {}),
      ...(title ? { title } : {}),
    },
    transient: true,
  } as UIMessageChunk);
  if (st.run && seq !== undefined) {
    // 生成中又发：排队。前一个排队的请求正常结束，补回复的流交给这一个
    const first = st.queue === null;
    const prev = st.queue?.sink;
    st.queue = {
      fromSeq: first ? seq : st.queue!.fromSeq,
      sink,
      ...(st.queue?.tasks ? { tasks: st.queue.tasks } : {}),
    };
    prev?.close();
    sink.write({
      type: 'data-queued',
      data: { fromSeq: st.queue.fromSeq },
      transient: true,
    } as UIMessageChunk);
    if (first) mockLive.queue(id, seq);
  } else void runReply(id, sink, retry);
  return stream;
}

/**
 * 网页会话里任务到点：服务写事件消息、改任务，再回复一次，回复由服务读完（没有请求接这个流，对话部件看不到逐字的过程，
 * 「此刻」里看）。空闲时直接开始；正在回复就排一次补回复（又被触发，queuedFrom 是事件消息的序号），补的那次带任务
 */
export function webTasksDue(convId: string, ids: number[]) {
  const live: LiveTask[] = [];
  let seq: number | undefined;
  for (const id of ids) {
    const t = server.task(id);
    const ev = t && server.fireTask(id, 'task');
    if (!t || !ev) continue;
    live.push({ id: t.id, ref: t.ref, action: t.action });
    seq ??= ev.seq;
  }
  if (!live.length || seq === undefined) return;
  const st = stateOf(convId);
  if (!st.run) {
    void runReply(convId, discardSink(), false, live);
    return;
  }
  if (st.queue) {
    st.queue.tasks = [...(st.queue.tasks ?? []), ...live];
    return;
  }
  st.queue = { fromSeq: seq, sink: discardSink(), tasks: live };
  mockLive.queue(convId, seq);
}

/** 中止这个会话进行中的回复，同时取消排队的补回复（排队的消息留在历史里） */
function abort(convId: string): boolean {
  const st = states.get(convId);
  if (!st) return false;
  let did = false;
  if (st.queue) {
    const q = st.queue;
    st.queue = null;
    q.sink.close();
    mockLive.unqueue(convId);
    did = true;
  }
  if (st.run) {
    abortRun(st.run);
    did = true;
  }
  return did;
}

/* ---------- 上传 ---------- */
const uploaded = new Map<string, { mediaType: string; info: ImageInfo }>();
async function upload(file: File): Promise<UploadResponse> {
  await delay(250 + Math.min(800, file.size / 4000));
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
    throw new ApiError('只收 PNG、JPEG、WebP 和静态的 GIF 图片', 415);
  if (file.size > 20 * 1024 * 1024) throw new ApiError('图片太大：每张不超过 20 MB', 413);
  if (!file.size) throw new ApiError('图片是空的', 400);
  // 演示：文件名里有 fail 的上传失败
  if (/fail/i.test(file.name)) throw new ApiError('服务出错了（演示的上传失败）', 500);
  let width: number | undefined;
  let height: number | undefined;
  try {
    const bmp = await createImageBitmap(file);
    width = bmp.width;
    height = bmp.height;
    bmp.close();
  } catch {
    throw new ApiError('图片的内容与声明的类型不符', 400);
  }
  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const url = `luoli-file:${uid('up')}.${ext}`;
  const src = URL.createObjectURL(file);
  uploaded.set(url, { mediaType: file.type, info: { src, width, height } });
  return { url, mediaType: file.type, src, bytes: file.size, width, height };
}

class MockTransport implements ChatTransport<ChatMessage> {
  async sendMessages(options: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0]) {
    await delay(60);
    const body = chatRequestBody({
      trigger: options.trigger,
      messages: options.messages,
      metadata: options.metadata,
    });
    return handle(body) as never;
  }
  reconnectToStream() {
    return Promise.resolve(null);
  }
}

export const mockChatApi: ChatApi = {
  transport: (onChunk) => new ObservedTransport(new MockTransport(), onChunk),
  async abort(convId): Promise<AbortResponse> {
    await delay(40);
    return { aborted: abort(convId) };
  },
  upload: (file) => upload(file),
};

/** 切换模拟数据：每个会话的排队、进行中的回复都不要了 */
export function resetMockChat() {
  for (const st of states.values()) {
    if (st.run) abortRun(st.run);
    st.queue = null;
  }
  states.clear();
  uploaded.clear();
}
