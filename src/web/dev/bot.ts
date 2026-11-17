import { chars, rand, randi, uid } from '@luoli/ui/util';
import type { ImageInfo, ImagePart, MsgRow, Part, ToolResultInfo } from '../model/types';
import type { LiveTask } from '../../server/types';
import { mockLive, mockStatus } from './mock-live';
import { DECIDE_MARKER, watchEventText, watchFailedText } from './mock-monitor';
import { mockServer as server, svgImage } from './mock-server';
import { U, imgPart, toolPart, toolSummary } from './seed';

/* 模拟 bot 的剧本 */
export interface Script {
  convId?: string;
  msgs?: [number | string, string][];
  during?: { at: number; uid: number | string; text: string; trigger?: boolean }[];
  wait?: number;
  retry?: number;
  think?: { ms: number; text: string };
  tool?: {
    url: string;
    ms: number;
    summary: string;
    image?: ImagePart;
    chars?: number;
    wait?: number;
    /** 工具出错：错误说明（模型看到的第一行） */
    fail?: string;
  };
  text: string;
  usage?: [number, number, number];
  errorAt?: number;
  errorStatus?: number;
  /** 输出到第几个字时流中断，重新生成一次（流中途重试） */
  restreamAt?: number;
  /** 任务到点触发的回复：是哪几个任务（开始时带给「此刻」） */
  tasks?: LiveTask[];
  /** 「自行决定」的监听回复里洛璃回了标记：说完以后什么都没发出，不写进历史（结束事件带 discarded） */
  discard?: boolean;
}

/* 可取消的流程：模拟数据的每一次回复都跑在一个 run 里，切换数据、离线、删会话时整体取消 */
export function createRun() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let dead = false;
  return {
    get dead() {
      return dead;
    },
    sleep(ms: number) {
      return new Promise<void>((res) => {
        if (dead) return;
        const t = setTimeout(() => {
          timers.delete(t);
          if (!dead) res();
        }, ms);
        timers.add(t);
      });
    },
    cancel() {
      dead = true;
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}

interface RunState {
  run: ReturnType<typeof createRun>;
  replyId: string;
  phase: string;
  pending: Script | null;
  started: number;
  waitUntil: number;
  text: string;
  parts: Part[];
  /** 每段思考用了多少毫秒 */
  reasoningMs: number[];
  images: Record<string, ImageInfo | null>;
  tools: Record<string, ToolResultInfo>;
  /** 这次回复是哪几个任务到点触发的（等待合并时到点的并进来） */
  tasks: LiveTask[];
}

/* 模拟 bot：一次回复 = 等待合并 →（重试）→ 思考 →（工具）→ 逐字输出 → 结束。
   回复期间又被触发：照「合并回复」，当前回复发出后再回复一次 */
class Bot {
  /** 能收到 Telegram 的消息：启动了 Telegram 前端，而且连得上 */
  get online() {
    return mockStatus.enabled && mockStatus.connected;
  }
  runs = new Map<string, RunState>();

  post(
    convId: string,
    uidv: number | string,
    text: string,
    { image = null, at }: { trigger?: boolean; image?: ImagePart | null; at?: number } = {},
  ) {
    if (!server.has(convId)) return null;
    // 写进模拟服务：它像真实的服务那样推 message、conversation 事件，客户端的 sync.ts 放进 db、发总线事件
    return U(convId, uidv, text, at || Date.now(), image ? { image } : undefined);
  }
  trigger(convId: string, script: Script) {
    if (!this.online) return false;
    const cur = this.runs.get(convId);
    if (!cur) {
      replyFlow(convId, script);
      return true;
    }
    if (cur.phase === 'waiting') {
      cur.waitUntil = Math.min(cur.started + 8000, Date.now() + 2000);
      return true;
    }
    const first = !cur.pending;
    cur.pending = script;
    if (first) mockLive.again(convId);
    return true;
  }
  /**
   * 任务到点（Telegram 会话）：服务先写事件消息、改任务，再把它当作一次触发：空闲时走等待合并，开始时带着是哪几个任务；
   * 正在等待合并就并进这一轮（到点本身不推事件）；正在回复就等这次发完再回复一次（推「又被触发」，补的那次带任务）。
   * Telegram 连不上时只有事件消息，不回复。返回有没有回复。
   * kind：task 定时任务到点（默认）；monitor 监听查到了新的；monitor-failed 监听满 6 小时还查不到（事件正文由 mock-monitor.ts 写）
   * decide：处理方式是「自行决定」的监听任务这次怎么收场（演示用）：silent 洛璃判断不值得说、只回标记，什么都没发出；
   * reply 值得说，照常回复。事件正文、带给「此刻」的任务都按任务的处理方式写，不看这个参数
   */
  dueTasks(
    convId: string,
    ids: number[],
    script: Script,
    kind: 'task' | 'monitor' | 'monitor-failed' = 'task',
    decide?: 'silent' | 'reply',
  ) {
    const live: LiveTask[] = [];
    let silent = false;
    for (const id of ids) {
      const t = server.task(id);
      if (!t) continue;
      const isDecide = kind === 'monitor' && t.monitor?.description.mode === 'decide';
      if (isDecide && decide === 'silent') silent = true;
      const text =
        kind === 'monitor'
          ? watchEventText(
              t.action,
              1,
              isDecide
                ? // 不值得说的演示挑样本里的高温黄色预警，值得说的挑暴雨橙色
                  { decide: true, first: decide === 'silent' ? 2 : 1 }
                : {},
            )
          : kind === 'monitor-failed' && t.monitor?.failing
            ? watchFailedText(t, Date.parse(t.monitor.failing.since), t.monitor.failing.reason)
            : undefined;
      if (!server.fireTask(id, kind, text)) continue;
      live.push({
        id: t.id,
        ref: t.ref,
        action: t.action,
        ...(kind === 'task' ? {} : { event: kind }),
        ...(isDecide ? { decide: true as const } : {}),
      });
    }
    if (!live.length || !this.online) return false;
    // 洛璃照任务说的做：回复里说一遍任务；自行决定、判断不值得说的，只回标记
    const say = (t: LiveTask) =>
      kind === 'monitor'
        ? t.decide
          ? `${t.action}：上海中心气象台刚发布了暴雨橙色预警，未来 3 小时有强降水，路上注意积水～`
          : `${t.action}：上海中心气象台刚发布了大风黄色预警，傍晚起沿海阵风 7～8 级，出门小心～`
        : kind === 'monitor-failed'
          ? `${t.action}，现在已经查不到半天了，可以请人看看服务的配置，或者取消这个任务（${t.ref}）。`
          : `到点啦～ ${t.action}`;
    script = {
      ...script,
      ...(silent ? { discard: true, text: DECIDE_MARKER } : { text: live.map(say).join('；') }),
    };
    const cur = this.runs.get(convId);
    if (!cur) {
      replyFlow(convId, { ...script, tasks: live });
      return true;
    }
    if (cur.phase === 'waiting') {
      cur.tasks.push(...live);
      return true;
    }
    const first = !cur.pending;
    cur.pending = { ...script, tasks: [...(cur.pending?.tasks ?? []), ...live] };
    if (first) mockLive.again(convId);
    return true;
  }
  abort(convId: string) {
    const st = this.runs.get(convId);
    if (!st) return;
    st.run.cancel();
    this.runs.delete(convId);
    if (server.has(convId) && (st.text || st.parts.length)) {
      const parts = st.parts.slice();
      if (st.text) parts.push({ type: 'text', text: st.text });
      const row = server.addMsg(convId, {
        role: 'assistant',
        parts,
        images: st.images,
        tools: st.tools,
        meta: {
          aborted: true,
          ...(st.reasoningMs.length ? { reasoningMs: st.reasoningMs } : {}),
        },
      });
      server.addCall({
        conversation_id: convId,
        reply_id: row?.id ?? null,
        started_at: new Date(st.started).toISOString(),
        duration_ms: Date.now() - st.started,
        outcome: 'aborted',
        input_tokens: null,
        output_tokens: null,
      });
    }
    mockLive.end(convId, 'aborted');
  }
  abortAll() {
    [...this.runs.keys()].forEach((id) => this.abort(id));
  }
  reset() {
    this.runs.forEach((st) => st.run.cancel());
    this.runs.clear();
  }
  /** 连上、连不上 Telegram。连不上时进行中的回复照样跑完（只是发不到群里），新的触发进不来 */
  setOnline(on: boolean) {
    mockStatus.setConnected(on);
  }
}
export const bot = new Bot();

async function replyFlow(convId: string, script: Script, merged = false) {
  const run = createRun();
  const st: RunState = {
    run,
    replyId: uid('reply'),
    phase: 'waiting',
    pending: null,
    started: Date.now(),
    waitUntil: 0,
    text: '',
    parts: [],
    reasoningMs: [],
    images: {},
    tools: {},
    tasks: [...(script.tasks ?? [])],
  };
  bot.runs.set(convId, st);
  /* 回复中又被触发而再回复一次的（merged），不再等待合并：直接开始 */
  const noWait = merged || script.wait === 0;
  if (!merged) mockLive.wait(convId);
  st.waitUntil = Date.now() + (noWait ? 300 : script.wait || 2400);
  if (!noWait && script.during)
    for (const m of script.during) {
      run.sleep(m.at).then(() => bot.post(convId, m.uid, m.text, { trigger: !!m.trigger }));
    }
  while (Date.now() < st.waitUntil)
    await run.sleep(Math.min(200, Math.max(10, st.waitUntil - Date.now())));

  st.phase = 'request';
  mockLive.start(convId, st.replyId, st.tasks);
  let attempts = 1;
  if (script.retry) {
    await run.sleep(900);
    mockLive.retry(convId, {
      phase: 'request',
      attempt: 1,
      maxRetries: 2,
      statusCode: script.retry,
    });
    await run.sleep(1800);
    attempts++;
  }
  if (script.think) {
    st.phase = 'thinking';
    const part = mockLive.reasoningStart(convId);
    /* 思考的内容分几次到：「此刻」不逐字显示，只显示「思考中…」，结束后才有内容 */
    const cs = chars(script.think.text);
    const pieces = 4;
    const size = Math.ceil(cs.length / pieces);
    for (let k = 0; k < pieces; k++) {
      await run.sleep(script.think.ms / pieces);
      mockLive.reasoningDelta(convId, part, cs.slice(k * size, (k + 1) * size).join(''));
    }
    st.parts.push({ type: 'reasoning', text: script.think.text });
    st.reasoningMs.push(script.think.ms);
    mockLive.reasoningEnd(convId, part);
  }
  if (script.tool) {
    st.phase = 'tool';
    const callId = uid('call');
    const t = script.tool;
    mockLive.toolStart(convId, callId, 'fetch', { url: t.url }, t.url);
    await run.sleep(t.wait || 1500);
    const built = toolPart(callId, {
      url: t.url,
      summary: t.summary,
      ms: t.ms,
      chars: t.chars || 2400,
      image: t.image,
      ok: !t.fail,
    });
    st.parts.push(built.part);
    Object.assign(st.images, built.images);
    Object.assign(st.tools, built.tools);
    mockLive.toolEnd(
      convId,
      callId,
      t.fail
        ? { ok: false, error: t.fail, summary: t.url }
        : {
            ok: true,
            images: t.image ? [svgImage(t.image)] : undefined,
            summary: toolSummary(t),
          },
    );
    attempts++;
    mockLive.nextStep(convId);
    await run.sleep(700);
  }
  st.phase = 'replying';
  const cs = chars(script.text);
  let i = 0;
  let restreamed = script.restreamAt == null;
  while (i < cs.length) {
    if (script.errorAt != null && i >= script.errorAt)
      return failFlow(convId, st, script, attempts);
    if (!restreamed && i >= script.restreamAt!) {
      /* 流中途出错：重试，这一步已输出的内容作废，从头再来 */
      restreamed = true;
      await run.sleep(500);
      mockLive.retry(convId, { phase: 'stream', attempt: 1, maxRetries: 2 });
      mockLive.resetStep(convId, st.parts.length);
      st.text = '';
      i = 0;
      attempts++;
      await run.sleep(1200);
      continue;
    }
    const n = randi(1, 3);
    const chunk = cs.slice(i, i + n).join('');
    i += n;
    st.text += chunk;
    mockLive.text(convId, chunk);
    await run.sleep(randi(45, 90));
  }
  const inp = script.usage ? script.usage[0] : randi(1600, 4200);
  const usage = script.usage
    ? { input: script.usage[0], cache: script.usage[1], output: script.usage[2] }
    : {
        input: inp,
        cache: Math.floor((inp * rand(0.3, 0.8)) / 128) * 128,
        output: Math.round(cs.length * 1.3) + randi(4, 20),
      };
  bot.runs.delete(convId);
  /* 回了标记（自行决定）：什么都没发出，助手消息不写进历史；模型调用表照常记一行，回复算正常完成 */
  const row =
    server.has(convId) && !script.discard
      ? server.addMsg(convId, {
          role: 'assistant',
          parts: [...st.parts, { type: 'text', text: st.text }],
          images: st.images,
          tools: st.tools,
          meta: {
            usage: { input: usage.input, cacheRead: usage.cache, output: usage.output },
            ...(st.reasoningMs.length ? { reasoningMs: st.reasoningMs } : {}),
          },
        })
      : null;
  if (row || (script.discard && server.has(convId)))
    server.addCall({
      conversation_id: convId,
      reply_id: row?.id ?? null,
      started_at: new Date(st.started).toISOString(),
      duration_ms: Date.now() - st.started,
      first_output_ms: 900,
      attempts,
      outcome: 'completed',
      finish_reason: 'stop',
      input_tokens: usage.input,
      cache_read_tokens: usage.cache,
      output_tokens: usage.output,
      steps: script.tool ? 2 : 1,
      tool_calls: script.tool ? 1 : 0,
    });
  mockLive.lastReply = row ? { conversationId: convId, at: row.createdAt } : mockLive.lastReply;
  mockLive.end(convId, 'completed', {
    usage: { input: usage.input, cacheRead: usage.cache, output: usage.output },
    ...(script.discard ? { discarded: true } : {}),
  });
  if (st.pending) {
    const next = st.pending;
    setTimeout(() => {
      if (bot.online && server.has(convId) && !bot.runs.has(convId)) replyFlow(convId, next, true);
    }, 500);
  }
}

function failFlow(convId: string, st: RunState, script: Script, attempts: number) {
  bot.runs.delete(convId);
  let row: MsgRow | null = null;
  const status = script.errorStatus || 429;
  if (server.has(convId)) {
    const parts = st.parts.slice();
    if (st.text) parts.push({ type: 'text', text: st.text });
    if (parts.length)
      row = server.addMsg(convId, {
        role: 'assistant',
        parts,
        images: st.images,
        tools: st.tools,
        meta: {
          failed: true,
          ...(st.reasoningMs.length ? { reasoningMs: st.reasoningMs } : {}),
        },
      });
    server.addCall({
      conversation_id: convId,
      reply_id: row ? row.id : null,
      started_at: new Date(st.started).toISOString(),
      duration_ms: Date.now() - st.started,
      attempts: attempts + 2,
      outcome: 'failed',
      error: 'APICallError ' + status,
    });
  }
  mockLive.end(convId, 'failed', { error: `请求失败（${status}）`, statusCode: status });
  if (st.pending) {
    const next = st.pending;
    setTimeout(() => {
      if (bot.online && server.has(convId) && !bot.runs.has(convId)) replyFlow(convId, next, true);
    }, 900);
  }
}

/* --- 演示用的剧本 --- */
export const SCRIPTS: Record<'trigger' | 'tool' | 'error' | 'retry' | 'due', Script[]> = {
  trigger: [
    {
      msgs: [[1002, '@洛璃 下周读书会读什么好呀？想要轻松一点的']],
      during: [{ at: 1100, uid: 1003, text: '我投“小王子”一票' }],
      think: {
        ms: 2600,
        text: '小雨想要轻松一点的书，阿澈投了《小王子》。《小王子》一百来页，适合一周读完，可以顺着阿澈的提议，再约一下时间。',
      },
      text: '@小雨 我也投《小王子》！一百来页，一个周末就能读完，聊起来话题也多～ 周六下午 3 点见？',
      usage: [1798, 768, 75],
    },
    {
      msgs: [[1001, '洛璃 第 6 章讲了什么？我还没看到，别剧透太多']],
      during: [{ at: 900, uid: 1004, text: '只说开头就好哈哈' }],
      think: { ms: 2000, text: '小明还没读到第 6 章，只要开头、不剧透。书虫也这么说。' },
      text: '只说开头：查理的进步报告越写越长，字也越来越工整了～ 后面的留给你自己读，不剧透！',
      usage: [2104, 1536, 64],
    },
    {
      msgs: [[1004, 'nori 推荐一本适合冬天读的书']],
      think: { ms: 1800, text: '冬天、温暖、篇幅适中。' },
      text: '冬天适合读《雪国》，第一句就是“穿过县界长长的隧道，便是雪国”，读的时候配一杯热可可刚刚好～',
      usage: [1922, 1024, 70],
    },
  ],
  tool: [
    {
      convId: 'c-star',
      msgs: [[2001, '洛璃 看看这个 https://example.com/m42 讲的是哪个星云']],
      think: { ms: 1400, text: '老周发了一个链接，先读一下页面内容。' },
      tool: {
        url: 'example.com/m42',
        ms: 820,
        summary: '猎户座大星云 M42 的介绍页，附一张照片',
        image: imgPart(330, 200, 'm42.jpg'),
        chars: 3120,
      },
      text: '是猎户座大星云 M42！离我们大约 1344 光年，冬天顺着猎户座腰带往下看就能找到～ 照片里粉色的那团就是它',
      usage: [4212, 2304, 88],
    },
    {
      convId: 'c-book',
      msgs: [[1003, '@洛璃 帮我看看 https://book.example.com/fox 这本怎么样']],
      think: { ms: 1200, text: '阿澈发了书的链接，先读一下。' },
      tool: {
        url: 'book.example.com/fox',
        ms: 640,
        summary: '《小王子》新译本的详情页，带一张封面',
        image: imgPart(205, 45, '封面.jpg'),
        chars: 2210,
      },
      text: '是新译本，评分 9.1，封面是星空蓝的，好看！详情在 https://book.example.com/fox ，纸质书 32 块，比图书馆的版本多了 20 幅插图～',
      usage: [3880, 2048, 71],
    },
    {
      convId: 'c-star',
      msgs: [[2002, '洛璃 这个链接帮我看一下 https://example.com/gone']],
      think: { ms: 1100, text: '小星发了一个链接，先读一下。' },
      tool: {
        url: 'example.com/gone',
        ms: 600,
        summary: '',
        wait: 1200,
        fail: '抓取失败：HTTP 404',
      },
      text: '这个链接打不开呢，网站返回了 404，可能页面已经被删掉了～ 换个链接再发给我试试？',
      usage: [2650, 1536, 60],
    },
  ],
  error: [
    {
      convId: 'c-ball',
      msgs: [[3002, 'nori 周六会下雨吗，要不要改到室内']],
      think: { ms: 1500, text: '胖虎问周六的天气。' },
      text: '我看看哦，周六上午有小雨，下午转阴，建议',
      errorAt: 14,
      errorStatus: 429,
    },
  ],
  /* 任务到点触发的回复：没有人说话，洛璃照任务说的做 */
  due: [
    {
      wait: 1500,
      think: { ms: 1400, text: '任务到点了，按任务里写的提醒大家。' },
      text: '到点啦～ 提醒一下：周六下午 3 点在咖啡馆聚会，别迟到哦！',
      usage: [1688, 1024, 52],
    },
    {
      wait: 1500,
      think: { ms: 1200, text: '到了说天气的时间，简单说两句。' },
      text: '早上好！今天多云，最高 9 度，出门记得围巾～ 晚上 9 点的空间站过境也别错过。',
      usage: [1742, 1024, 63],
    },
  ],
  retry: [
    {
      convId: 'c-dm',
      msgs: [[1002, '洛璃 明早 7 点叫我起床可以吗']],
      wait: 1200,
      retry: 429,
      think: { ms: 1300, text: '小雨想让我叫她起床，我做不到主动发消息，要说清楚。' },
      text: '我还不能主动发消息呢……不过可以提醒你：今晚早点睡，定好 7 点的闹钟，明早见～',
      usage: [1320, 768, 52],
    },
    {
      convId: 'c-dm',
      msgs: [[1002, '洛璃 晚上吃什么好呢，纠结']],
      wait: 1200,
      think: { ms: 1200, text: '小雨在纠结晚饭，给一个轻松的建议。' },
      text: '天冷了，来一碗热乎乎的面吧～ 加个蛋，再配点青菜，简单又舒服。',
      restreamAt: 12,
      usage: [1410, 768, 48],
    },
  ],
};
export const PLAIN: Record<string, [number, string, boolean?][]> = {
  'c-book': [
    [1001, '刚看完第 7 章，信息量好大'],
    [1002, '有人要一起去图书馆吗'],
    [1004, '周六我可能晚到半小时'],
    [1003, '哈哈哈哈哈哈'],
  ],
  'c-star': [
    [2001, '晚上 9 点有空间站过境，记得抬头'],
    [2002, '今晚的月亮', true],
    [1002, '降温了，观测记得穿厚点'],
  ],
  'c-ball': [
    [3001, '球馆周六只剩 2 号场了'],
    [3002, '我的护膝丢了，谁有多的'],
    [1003, '收到'],
  ],
};
const scriptIdx = { trigger: 0, tool: 0, error: 0, retry: 0, due: 0 };
export const nextScript = (kind: keyof typeof scriptIdx) => {
  const list = SCRIPTS[kind];
  return list[scriptIdx[kind]++ % list.length];
};
