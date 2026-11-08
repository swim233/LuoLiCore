import { chars, rand, randi, uid } from '../lib/util';
import { bus } from '../model/bus';
import { db } from '../model/db';
import type { ImagePart, MsgRow, Part } from '../model/types';
import { U, imgPart } from './seed';

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
  };
  text: string;
  usage?: [number, number, number];
  errorAt?: number;
  errorStatus?: number;
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
}

/* 模拟 bot：一次回复 = 等待合并 →（重试）→ 思考 →（工具）→ 逐字输出 → 结束。
   回复期间又被触发：照「合并回复」，当前回复发出后再回复一次 */
class Bot {
  online = true;
  runs = new Map<string, RunState>();

  post(
    convId: string,
    uidv: number | string,
    text: string,
    {
      trigger = false,
      image = null,
      at,
    }: { trigger?: boolean; image?: ImagePart | null; at?: number } = {},
  ) {
    if (!db.conv(convId)) return null;
    const row = U(convId, uidv, text, at || Date.now(), image ? { image } : undefined);
    if (row && row.role === 'user' && db.conv(convId)!.platform !== 'web')
      db.unread.set(convId, (db.unread.get(convId) || 0) + 1);
    bus.emit('message', { convId, row, trigger });
    return row;
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
    if (first) bus.emit('reply:queued', { convId, replyId: cur.replyId });
    return true;
  }
  abort(convId: string) {
    const st = this.runs.get(convId);
    if (!st) return;
    st.run.cancel();
    this.runs.delete(convId);
    let row: MsgRow | null = null;
    if (db.conv(convId) && (st.text || st.parts.length)) {
      const parts = st.parts.slice();
      if (st.text) parts.push({ type: 'text', text: st.text });
      row = db.addMsg(convId, { role: 'assistant', parts, meta: { aborted: true } });
      db.addCall({
        conversation_id: convId,
        reply_id: row!.id,
        started_at: new Date(st.started).toISOString(),
        duration_ms: Date.now() - st.started,
        outcome: 'aborted',
        input_tokens: null,
        output_tokens: null,
      });
    }
    bus.emit('reply:abort', { convId, replyId: st.replyId, row });
  }
  abortAll() {
    [...this.runs.keys()].forEach((id) => this.abort(id));
  }
  reset() {
    this.runs.forEach((st) => st.run.cancel());
    this.runs.clear();
  }
  setOnline(on: boolean) {
    if (on === this.online) return;
    this.online = on;
    /* 先发离线事件再中止进行中的回复：「此刻」里「回复被中止：bot 离线」那一行要看 status.online */
    bus.emit(on ? 'bot:online' : 'bot:offline');
    if (!on) this.abortAll();
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
  };
  bot.runs.set(convId, st);
  const noWait = merged || script.wait === 0;
  bus.emit('reply:wait', { convId, replyId: st.replyId, noWait });
  st.waitUntil = Date.now() + (noWait ? 300 : script.wait || 2400);
  if (!noWait && script.during)
    for (const m of script.during) {
      run.sleep(m.at).then(() => bot.post(convId, m.uid, m.text, { trigger: !!m.trigger }));
    }
  while (Date.now() < st.waitUntil)
    await run.sleep(Math.min(200, Math.max(10, st.waitUntil - Date.now())));

  st.phase = 'request';
  const tReq = Date.now();
  let attempts = 1;
  if (script.retry) {
    await run.sleep(900);
    bus.emit('reply:retry', {
      convId,
      replyId: st.replyId,
      attempt: 1,
      max: 2,
      status: script.retry,
    });
    await run.sleep(1800);
    attempts++;
  }
  if (script.think) {
    st.phase = 'thinking';
    bus.emit('reply:think', { convId, replyId: st.replyId });
    await run.sleep(script.think.ms);
    const sec = Math.max(1, Math.round(script.think.ms / 1000));
    st.parts.push({ type: 'reasoning', text: script.think.text, demo: { sec } });
    bus.emit('reply:thinkEnd', { convId, replyId: st.replyId, sec, text: script.think.text });
  }
  if (script.tool) {
    st.phase = 'tool';
    const callId = uid('call');
    const t = script.tool;
    bus.emit('tool:start', { convId, replyId: st.replyId, callId, name: 'fetch', label: t.url });
    await run.sleep(t.wait || 1500);
    st.parts.push({
      type: 'tool-fetch',
      toolCallId: callId,
      state: 'output-available',
      input: { url: t.url },
      output: { summary: t.summary, chars: t.chars || 2400 },
      demo: { ms: t.ms, image: t.image || null },
    });
    bus.emit('tool:end', {
      convId,
      replyId: st.replyId,
      callId,
      ok: true,
      ms: t.ms,
      summary: t.summary,
      image: t.image || null,
    });
    attempts++;
    await run.sleep(700);
  }
  st.phase = 'replying';
  const cs = chars(script.text);
  let i = 0;
  while (i < cs.length) {
    if (script.errorAt != null && i >= script.errorAt)
      return failFlow(convId, st, script, attempts);
    const n = randi(1, 3);
    const chunk = cs.slice(i, i + n).join('');
    i += n;
    st.text += chunk;
    bus.emit('reply:delta', { convId, replyId: st.replyId, text: chunk });
    await run.sleep(randi(45, 90));
  }
  const ms = Date.now() - tReq;
  const inp = script.usage ? script.usage[0] : randi(1600, 4200);
  const usage = script.usage
    ? { input: script.usage[0], cache: script.usage[1], output: script.usage[2] }
    : {
        input: inp,
        cache: Math.floor((inp * rand(0.3, 0.8)) / 128) * 128,
        output: Math.round(cs.length * 1.3) + randi(4, 20),
      };
  bot.runs.delete(convId);
  const row = db.conv(convId)
    ? db.addMsg(convId, {
        role: 'assistant',
        parts: [...st.parts, { type: 'text', text: st.text }],
        meta: {
          usage: {
            inputTokens: usage.input,
            cachedInputTokens: usage.cache,
            outputTokens: usage.output,
          },
        },
      })
    : null;
  if (row)
    db.addCall({
      conversation_id: convId,
      reply_id: row.id,
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
  bus.emit('reply:end', { convId, replyId: st.replyId, ms, usage, row });
  if (st.pending) {
    const next = st.pending;
    setTimeout(() => {
      if (bot.online && db.conv(convId) && !bot.runs.has(convId)) replyFlow(convId, next, true);
    }, 500);
  }
}

function failFlow(convId: string, st: RunState, script: Script, attempts: number) {
  bot.runs.delete(convId);
  let row: MsgRow | null = null;
  if (db.conv(convId)) {
    const parts = st.parts.slice();
    if (st.text) parts.push({ type: 'text', text: st.text });
    if (parts.length) row = db.addMsg(convId, { role: 'assistant', parts, meta: { failed: true } });
    db.addCall({
      conversation_id: convId,
      reply_id: row ? row.id : null,
      started_at: new Date(st.started).toISOString(),
      duration_ms: Date.now() - st.started,
      attempts: attempts + 2,
      outcome: 'failed',
      error: 'APICallError ' + (script.errorStatus || 429),
    });
  }
  bus.emit('reply:error', { convId, replyId: st.replyId, status: script.errorStatus || 429, row });
  if (st.pending) {
    const next = st.pending;
    setTimeout(() => {
      if (bot.online && db.conv(convId) && !bot.runs.has(convId)) replyFlow(convId, next, true);
    }, 900);
  }
}

/* --- 演示用的剧本 --- */
export const SCRIPTS: Record<'trigger' | 'tool' | 'error' | 'retry', Script[]> = {
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
const scriptIdx = { trigger: 0, tool: 0, error: 0, retry: 0 };
export const nextScript = (kind: keyof typeof scriptIdx) => {
  const list = SCRIPTS[kind];
  return list[scriptIdx[kind]++ % list.length];
};
export function initLastReply() {
  let t = 0;
  for (const c of db.conversations)
    for (const m of db.msgs(c.id))
      if (m.role === 'assistant') t = Math.max(t, Date.parse(m.created_at));
  return t;
}
