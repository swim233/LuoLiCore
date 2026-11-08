import type { IncomingMessage, ServerResponse } from 'node:http';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { UIMessage } from 'ai';
import type { Plugin } from 'vite';

/* 本地模拟的 /api/chat（只挂在开发服务器上，正式构建里没有）：用 ai 的 UI message stream 输出模拟的思考、工具调用、正文。不调用任何真实模型，不读 .env，不访问外网。
   回复的内容、节奏照第 4.1 版（chatScript）：先思考 1.1–2 秒，然后：
   - 消息里有网址 → 调一次 fetch → 回复一段「这个页面是示例页面」；
   - 带图片 → 回复「收到 N 张图片啦～ …」；
   - 文字里有「查、搜、星座、天气」，或者每第 4 次发送 → 调 fetch（维基百科「星座」条目）→ 回复「全天一共有 88 个星座……」；
   - 其他 → 从 5 句写好的回复里轮着挑。
   演示用的特殊词：文字里有「出错」或「报错」，输出到第 14 个字时服务端报错；有「重试」，先发一条 data-retry（429，重试 1/2）再继续。 */
const REPLIES = [
  '好呀～ 我想想……如果只能选一个，我会选第一个！听起来就很有意思！',
  '嘿嘿，这个问题我知道！不过先说好，答错了不许笑我～',
  '收到！我把它记在小本本上了，下次你问我就能想起来～',
  '唔，让我数数星星再回答你……一、二、三……好啦，答案是：先去喝杯水，休息一下眼睛！',
  '这个可以有！要不要我帮你列个清单？一步一步来，一点都不难～',
];
let chatN = 0;
const randi = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
interface Script {
  think: { ms: number; text: string };
  tool?: {
    url: string;
    ms: number;
    summary: string;
    chars: number;
    image?: { h1: number; h2: number; label: string };
  };
  text: string;
}
function scriptOf(text: string, nImg: number): Script {
  const think = { ms: randi(1100, 2000), text: '想一想怎么回答比较好。' };
  const url = (text.match(/https?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|dev)\S*/i) ||
    [])[0];
  chatN++;
  if (url)
    return {
      think,
      tool: {
        url: url.replace(/^https?:\/\//, ''),
        ms: 760,
        summary: '一个示例页面，正文只有几段说明文字',
        chars: 1460,
      },
      text: '读完啦！这个页面主要是在说明它自己是一个示例页面，没有别的内容～ 要我帮你找找相关的资料吗？',
    };
  if (nImg)
    return {
      think,
      text: `收到 ${nImg} 张图片啦～ 颜色好温柔，像傍晚的天空。要我帮你描述一下里面的细节吗？`,
    };
  if (/查|搜|星座|天气/.test(text) || chatN % 4 === 0)
    return {
      think,
      tool: {
        url: 'zh.wikipedia.org/wiki/星座',
        ms: 910,
        summary: '维基百科「星座」条目：全天共 88 个星座',
        chars: 5230,
      },
      text: '我查了一下：全天一共有 88 个星座，其中 12 个在黄道上。冬天最好认的是猎户座，腰带上 3 颗星排成一排～',
    };
  return { think, text: REPLIES[chatN % REPLIES.length] };
}

/* 请求体：只读用到的那几个字段 */
interface ChatBody {
  messages?: { role: string; parts?: { type: string; text?: string }[] }[];
}
/* 流里自定义的两样：消息的 metadata（用量、耗时）和瞬时的重试提示 */
type MockMsg = UIMessage<
  { usage: { input: number; cache: number; output: number }; ms: number },
  { retry: { attempt: number; max: number; status: number } }
>;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const body = await new Promise<ChatBody>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
  const msgs = body.messages ?? [];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const text = (last?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
  const nImg = (last?.parts ?? []).filter((p) => p.type === 'file').length;
  const sc = scriptOf(text, nImg);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const stream = createUIMessageStream<MockMsg>({
    execute: async ({ writer }) => {
      /* 演示：重试一次后成功 */
      if (/重试/.test(text)) {
        await sleep(900);
        writer.write({
          type: 'data-retry',
          data: { attempt: 1, max: 2, status: 429 },
          transient: true,
        });
        await sleep(1800);
      }
      if (closed) return;
      writer.write({ type: 'reasoning-start', id: 'r1' });
      await sleep(sc.think.ms);
      if (closed) return;
      writer.write({ type: 'reasoning-delta', id: 'r1', delta: sc.think.text });
      writer.write({ type: 'reasoning-end', id: 'r1' });
      if (sc.tool) {
        const callId = 'call_' + Date.now().toString(36);
        writer.write({
          type: 'tool-input-available',
          toolCallId: callId,
          toolName: 'fetch',
          input: { url: sc.tool.url },
        });
        await sleep(1500);
        if (closed) return;
        writer.write({
          type: 'tool-output-available',
          toolCallId: callId,
          output: { summary: sc.tool.summary, chars: sc.tool.chars, ms: sc.tool.ms },
        });
        await sleep(700);
      }
      if (closed) return;
      writer.write({ type: 'text-start', id: 't1' });
      const cs = Array.from(sc.text);
      const failAt = /出错|报错/.test(text) ? 14 : -1;
      let i = 0;
      while (i < cs.length) {
        if (closed) return;
        if (failAt >= 0 && i >= failAt) {
          writer.write({ type: 'error', errorText: '请求失败（429）' });
          return;
        }
        const n = randi(1, 3);
        writer.write({ type: 'text-delta', id: 't1', delta: cs.slice(i, i + n).join('') });
        i += n;
        await sleep(randi(45, 90));
      }
      writer.write({ type: 'text-end', id: 't1' });
      const input = randi(1600, 4200);
      writer.write({
        type: 'message-metadata',
        messageMetadata: {
          usage: {
            input,
            cache: Math.floor((input * (0.3 + Math.random() * 0.5)) / 128) * 128,
            output: Math.round(cs.length * 1.3) + randi(4, 20),
          },
          ms: Date.now() - t0,
        },
      });
    },
    onError: (e) => (e instanceof Error ? e.message : String(e)),
  });
  const r = createUIMessageStreamResponse({ stream });
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) {
    res.end();
    return;
  }
  const reader = r.body.getReader();
  res.on('close', () => {
    reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* 连接断了 */
  }
  res.end();
}
const mw = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  if (req.method === 'POST' && req.url?.split('?')[0] === '/api/chat')
    handle(req, res).catch(() => res.end());
  else next();
};
export function chatMock(): Plugin {
  return {
    name: 'chat-mock',
    configureServer(server) {
      server.middlewares.use(mw);
    },
  };
}
