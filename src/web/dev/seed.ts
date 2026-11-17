import { hashStr, pick, rand, randi, startOfDay, uid } from '@luoli/ui/util';
import type { NewMessage } from '../model/source';
import type {
  ImageInfo,
  ImagePart,
  Part,
  TaskMonitor,
  TaskRow,
  ToolResultInfo,
} from '../model/types';
import { devUi, WEB_AUTHOR } from './demo-state';
import type { Dataset } from './demo-state';
import { FAIL_REASON, WATCHES, watchEventText, watchFailedText, watchView } from './mock-monitor';
import { mockServer as server, svgImage, toolBody } from './mock-server';

export const PEOPLE: Record<string, string> = {
  1001: '小明',
  1002: '小雨',
  1003: '阿澈',
  1004: '书虫',
  2001: '观星人老周',
  2002: '月亮不睡',
  3001: '大刘',
  3002: '胖虎',
};
/* 演示里的人用短编号；实际的 Telegram 用户 id 在这里（颜色按它算，这些 id 是挑过的，同一个群的成员颜色不撞，别随手改） */
export const UIDS: Record<string, string> = {
  1001: '5210819003',
  1002: '5210910003',
  1003: '5210119005',
  1004: '5210745000',
  2001: '5210646001',
  2002: '5210583004',
  3001: '5210375017',
  3002: '5210046009',
};

export function imgPart(h1: number, h2: number, label: string, w = 1280, ht = 960): ImagePart {
  const hash = (hashStr(label + h1 + h2) >>> 0).toString(16).padStart(8, '0');
  return {
    type: 'file',
    mediaType: 'image/jpeg',
    url: 'luoli-file:' + hash + '.jpg',
    demo: { h1, h2, label, w, h: ht },
  };
}

/* --- 编数据用的小工具 --- */
const filePart = (img: ImagePart): Part => ({
  type: 'file',
  mediaType: img.mediaType,
  url: img.url,
});
export function U(
  convId: string,
  uidv: number | string,
  text: string,
  at: number,
  extra?: { image?: ImagePart },
) {
  const name = PEOPLE[uidv] || String(uidv);
  const parts: Part[] = [];
  const images: Record<string, ImageInfo | null> = {};
  if (extra?.image) {
    parts.push(filePart(extra.image));
    images[extra.image.url] = svgImage(extra.image);
  }
  if (text) parts.push({ type: 'text', text });
  return server.addMsg(convId, {
    role: 'user',
    author: { id: UIDS[uidv] || (PEOPLE[uidv] ? String(uidv) : undefined), name },
    parts,
    images,
    at,
  })!;
}
export interface ToolSpec {
  url: string;
  summary: string;
  ms?: number;
  chars?: number;
  ok?: boolean;
  image?: ImagePart | null;
}
/** 一次 fetch 工具调用：真实的 part（结果文字最多 2000 个字符，带图片的是 luoli-content），加图片与结果长度的信息；
    summary、ms、image 是「此刻」「对话」还在读的演示字段 */
export function toolPart(callId: string, t: ToolSpec) {
  const images: Record<string, ImageInfo | null> = {};
  const tools: Record<string, ToolResultInfo> = {};
  const full = t.chars || 1830;
  const durationMs = t.ms || 800;
  if (t.ok === false) {
    const errorText = '抓取失败：HTTP 404';
    tools[callId] = { chars: errorText.length, truncated: false, durationMs };
    return {
      part: {
        type: 'tool-fetch',
        toolCallId: callId,
        state: 'output-error',
        input: { url: t.url },
        errorText,
      } as Part,
      images,
      tools,
    };
  }
  const text = toolBody(t.summary, Math.min(full, 2000));
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
  tools[callId] = { chars: full, truncated: full > 2000, summary: toolSummary(t), durationMs };
  return {
    part: {
      type: 'tool-fetch',
      toolCallId: callId,
      state: 'output-available',
      input: { url: t.url },
      output,
    } as Part,
    images,
    tools,
  };
}
/** fetch 给界面看的一句话：网址加页面标题（演示数据里标题就是 summary 的开头一段） */
export const toolSummary = (t: { url: string; summary: string }) =>
  t.summary ? `${t.url} · ${t.summary}` : t.url;
export interface AOpts {
  think?: [string, number];
  tool?: ToolSpec;
  usage?: [number, number, number];
  failed?: boolean;
  aborted?: boolean;
}
export function A(convId: string, text: string, at: number, o: AOpts = {}) {
  const parts: Part[] = [];
  let images: Record<string, ImageInfo | null> = {};
  let tools: Record<string, ToolResultInfo> = {};
  if (o.think) parts.push({ type: 'reasoning', text: o.think[0] });
  if (o.tool) {
    const t = toolPart(uid('call'), o.tool);
    parts.push(t.part);
    images = t.images;
    tools = t.tools;
  }
  if (text) parts.push({ type: 'text', text });
  const meta: NewMessage['meta'] = {};
  if (o.usage) meta.usage = { input: o.usage[0], cacheRead: o.usage[1], output: o.usage[2] };
  if (o.think) meta.reasoningMs = [o.think[1] * 1000];
  if (o.failed) meta.failed = true;
  if (o.aborted) meta.aborted = true;
  const row = server.addMsg(convId, { role: 'assistant', parts, images, tools, at, meta })!;
  server.addCall({
    conversation_id: convId,
    reply_id: row.id,
    started_at: new Date(at - 3000).toISOString(),
    duration_ms: randi(1400, 4200),
    outcome: o.failed ? 'failed' : o.aborted ? 'aborted' : 'completed',
    input_tokens: o.usage ? o.usage[0] : 1500,
    cache_read_tokens: o.usage ? o.usage[1] : 0,
    output_tokens: o.usage ? o.usage[2] : 30,
    steps: o.tool ? 2 : 1,
    tool_calls: o.tool ? 1 : 0,
    error: o.failed ? 'APICallError 429' : null,
  });
  return row;
}
const MIN = 60e3,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, '0');

/* --- 任务：今天往后第几天的几点几分 --- */
const clock = (dayOffset: number, hh: number, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
};
const isoOf = (ms: number) => new Date(ms).toISOString();
type Sched = TaskRow['schedule'];
const once = (ms: number): Sched => ({ kind: 'once', at: isoOf(ms) });
/** 谁让建的：演示里的人（带 uid），或网页发言人 */
const byPerson = (uidv: number | string) => ({
  id: UIDS[uidv] || String(uidv),
  name: PEOPLE[uidv] || String(uidv),
});
/** 已经结束的任务的状态：正常到点完成、超时完成（到点次数 0）、取消 */
const doneAt = (ms: number) => ({
  status: 'done' as const,
  dueCount: 1,
  lastDueAt: isoOf(ms),
  endedAt: isoOf(ms),
});
const missedAt = (ms: number) => ({ status: 'done' as const, dueCount: 0, endedAt: isoOf(ms) });
const cancelledAt = (ms: number) => ({
  status: 'cancelled' as const,
  dueCount: 0,
  endedAt: isoOf(ms),
});

/** 监听任务（ADR-0014）：描述、写成人话的几行来自 mock-monitor.ts；check 是检查的状态（已经取消的没有）；进行中的没有下次到点 */
function addWatch(
  convId: string,
  spec: keyof typeof WATCHES,
  o: {
    by: { id?: string; name: string };
    createdAt: number;
    check?: Pick<TaskMonitor, 'lastCheckedAt' | 'lastSuccessAt' | 'failing'>;
    state?: Parameters<typeof server.addTask>[0]['state'];
  },
) {
  const monitor = { ...watchView(WATCHES[spec]), ...o.check };
  return server.addTask({
    convId,
    action: WATCHES[spec].action,
    schedule: { kind: 'monitor', monitor: monitor.description },
    by: o.by,
    createdAt: o.createdAt,
    monitor,
    state: o.state,
  });
}

/* 各种 Markdown 的写法（洛璃的回复）和带网址的群友消息：看气泡、时间线、「此刻」里怎么画。放在最旧的两个会话里，不挤占列表顶上的位置 */
const MD_RICH = [
  '## 周末聚会安排',
  '',
  '**时间**：周六下午 3 点，*老地方*咖啡馆（~~原定周日~~ 已改）。行内代码 `npm run build` 和 `a < b && c > d`。',
  '一个回车就换行（第二行）',
  '**注意：**请先备份。前文**加粗**后文，说**「引号」**内容，*斜体：*文字，**年龄：**12 岁，使用 Docker**（推荐）**默认。2*3*4 和 snake_case_name 照旧。',
  '符号 a < b && c > d、R&D，实体 &amp; &lt;div&gt; 和 &#38;，代码里的 `&amp;` 不解。',
  '第三行，带一个网址 https://example.com/a?b=1。后面的句号不算网址。',
  '',
  '1. 带书：《献给阿尔吉侬的花束》',
  '2. 带零食',
  '   - 甜的',
  '   - 咸的',
  '3. 看看 [活动页面](https://example.com/events?id=7) 里的说明',
  '',
  '- [x] 订位',
  '- [ ] 买蛋糕',
  '',
  '> 读书是一个人的狂欢，聊书是一群人的。',
  '> 第二行引用',
  '',
  '### 安排表',
  '',
  '| 日期 | 地点 | 备注 |',
  '|:--|:-:|--:|',
  '| 周六 | 老地方咖啡馆，三楼靠窗的位置，记得带伞 | 15:00 |',
  '| 周日 | 线上 | 20:00 |',
  '',
  '| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |',
  '|---|---|---|---|---|---|---|---|',
  '| aaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbb | cccccccccccccccc | dddddddddddddd | eeeeeeeeeeeeee | ffffffffffff | gggggggggg | hhhhhhhhhhhh |',
  '',
  '```ts',
  'const message = `这是一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的字符串 ${a + b}`;',
  'function add(a: number, b: number) {',
  '  return a + b;',
  '}',
  '```',
  '',
  '---',
  '',
  '这句有半个 **加粗没闭合，照原样显示。',
  '',
  '图片 ![封面](https://example.com/cover.png) 不加载，显示成链接；裸网址 example.com/docs 和 www.example.org 也能点；',
  '这个 [坏链接](javascript:alert(1)) 和 javascript:alert(1) 不能点；<b>原始 HTML</b> 当文字。',
].join('\n');
const MD_SHORT = '只有一个网址的回复：https://book.example.com/algernon';

function seedMarkdown(now: number) {
  const md = server.addConv({
    platform: 'telegram',
    kind: 'group',
    title: '写法测试',
    chatId: '-1001288369999',
    at: now - 15 * DAY,
    id: 'c-md',
  }).id;
  server.addSeg(md, 'first', now - 15 * DAY, null);
  U(
    md,
    1001,
    '看这个 https://example.com/a?b=1。还有 example.com/docs 和 www.example.org',
    now - 15 * DAY,
  );
  U(
    md,
    1002,
    '这些不是 Markdown：**不是加粗** `不是代码` [不是链接](https://example.com)',
    now - 15 * DAY + MIN,
  );
  U(
    md,
    1003,
    'javascript:alert(1) 和 https://example.com@evil.com/ 都不能点',
    now - 15 * DAY + 2 * MIN,
  );
  U(md, 1001, '@洛璃 把周末聚会的安排整理一下', now - 15 * DAY + 3 * MIN);
  A(md, MD_RICH, now - 15 * DAY + 4 * MIN, { usage: [2400, 1536, 380] });
  U(md, 1004, '谢谢～ 再给个网址', now - 15 * DAY + 5 * MIN);
  A(md, MD_SHORT, now - 15 * DAY + 6 * MIN, { usage: [2600, 2304, 30] });

  const web = server.addConv({
    platform: 'web',
    kind: 'web',
    title: '写法测试（对话）',
    at: now - 16 * DAY,
    id: 'c-md-web',
  }).id;
  server.addSeg(web, 'first', now - 16 * DAY, null);
  U(
    web,
    WEB_AUTHOR,
    '把周末聚会的安排整理一下，看这个 https://example.com/a?b=1。**不是加粗**',
    now - 16 * DAY,
  );
  A(web, MD_SHORT, now - 16 * DAY + MIN, { usage: [2600, 2304, 30] });
  A(web, MD_RICH, now - 16 * DAY + 2 * MIN, { usage: [2400, 1536, 380] });

  // 预览：只剩代码围栏的一行（被截断的回复），退回原文显示，不是「没有文字」
  const fence = server.addConv({
    platform: 'web',
    kind: 'web',
    title: '预览测试',
    at: now - 17 * DAY,
    id: 'c-md-fence',
  }).id;
  server.addSeg(fence, 'first', now - 17 * DAY, null);
  U(fence, WEB_AUTHOR, '写个脚本', now - 17 * DAY);
  A(fence, '```python', now - 17 * DAY + MIN, { usage: [2600, 2304, 30] });
}

function seedNormal() {
  const now = Date.now();
  const book = server.addConv({
    platform: 'telegram',
    kind: 'group',
    title: '读书会',
    chatId: '-1001288361001',
    at: now - 9 * DAY,
    id: 'c-book',
  }).id;
  server.addSeg(book, 'first', now - 2 * DAY - 3 * HOUR, null);
  server.addTask({
    convId: book,
    action: '提醒大家周六下午 3 点在咖啡馆聚会',
    schedule: once(clock(1, 10)),
    by: byPerson(1004),
    createdAt: now - 3 * HOUR,
  });
  server.addTask({
    convId: book,
    action: '提醒大家周日晚上聊聊这周读到的章节',
    schedule: { kind: 'weekly', weekday: 7, time: '20:00' },
    by: byPerson(1001),
    createdAt: now - 2 * DAY,
  });
  const tBring = server.addTask({
    convId: book,
    action: '提醒小明带书',
    schedule: once(now - 100 * MIN),
    by: byPerson(1002),
    createdAt: now - 2 * DAY,
    state: doneAt(now - 100 * MIN),
  }).id;
  server.addTask({
    convId: book,
    action: '每天早上提醒大家读 10 页',
    schedule: { kind: 'daily', time: '07:30' },
    by: byPerson(1004),
    createdAt: now - 6 * DAY,
    state: cancelledAt(now - 2 * DAY - HOUR),
  });
  U(book, 1001, '这个月读什么？我提名《三体》', now - 2 * DAY - 3 * HOUR);
  U(book, 1004, '三体我读过三遍了😂 换一本吧', now - 2 * DAY - 3 * HOUR + 2 * MIN);
  U(book, 1002, '@洛璃 有没有不太长、又能聊很久的书', now - 2 * DAY - 3 * HOUR + 4 * MIN);
  A(
    book,
    '那试试《献给阿尔吉侬的花束》？不到 300 页，读完后劲很大，聊起来能聊一整晚～',
    now - 2 * DAY - 3 * HOUR + 5 * MIN,
    {
      think: [
        '书虫读过三体想换一本，小雨要篇幅适中、讨论空间大的。阿尔吉侬篇幅短，主题也值得聊。',
        3,
      ],
      usage: [1620, 0, 58],
    },
  );
  server.addSeg(
    book,
    'idle',
    now - DAY - 5 * HOUR,
    '大家在挑这个月要读的书。小明提名《三体》，书虫读过三遍想换一本；小雨想要不太长、能聊很久的书，洛璃推荐了《献给阿尔吉侬的花束》，大家觉得不错。',
  );
  U(book, 1002, '阿尔吉侬那本我借到了！图书馆最后一本', now - DAY - 5 * HOUR);
  U(
    book,
    1003,
    '我在 https://book.example.com/algernon 看到电子版，12 块',
    now - DAY - 4 * HOUR - 50 * MIN,
  );
  U(book, 1001, '洛璃 一周读多少比较合适', now - DAY - 4 * HOUR - 40 * MIN);
  A(
    book,
    '一周读到第 5 章就好，大概 60 页～ 周日晚上大家一起聊，别熬夜哦！',
    now - DAY - 4 * HOUR - 39 * MIN,
    { usage: [2210, 1536, 61] },
  );
  server.addSeg(
    book,
    'compress',
    now - 5 * HOUR,
    '本月共读《献给阿尔吉侬的花束》。小雨在图书馆借到了纸质书，阿澈找到了 12 元的电子版。约定每周读到第 5 章左右，周日晚上讨论；书虫提议下次线下聚会，时间待定。',
  );
  U(book, 1001, '第 5 章看哭了', now - 5 * HOUR);
  U(book, 1002, '“我想变聪明”这句太难受了', now - 4 * HOUR - 40 * MIN);
  U(book, 1004, '下次聚会定在周六下午 3 点？老地方咖啡馆', now - 3 * HOUR);
  U(book, 1004, '@洛璃 帮忙看下咖啡馆周六开到几点', now - 3 * HOUR + MIN);
  A(
    book,
    '咖啡馆周六营业到 22 点，下午 3 点开始时间很宽裕～ 我先帮大家记下啦！',
    now - 3 * HOUR + 2 * MIN,
    {
      tool: {
        url: 'cafe.example.com/hours',
        summary: '咖啡馆营业时间：周六 10:00–22:00',
        ms: 640,
        chars: 920,
      },
      usage: [2810, 2304, 70],
    },
  );
  U(book, 1003, '好，周六见', now - 2 * HOUR);
  server.addEvent(book, tBring, 'task', now - 100 * MIN);
  A(
    book,
    '@小明 到点啦～ 记得把《献给阿尔吉侬的花束》带上，周六聚会要用～',
    now - 100 * MIN + 20e3,
    {
      usage: [1710, 1024, 44],
    },
  );
  server.addSeg(
    book,
    'manual',
    now - 80 * MIN,
    '本月读《献给阿尔吉侬的花束》，每周读到第 5 章左右，周日晚上讨论。下次聚会定在周六下午 3 点，咖啡馆营业到 22 点。小明负责带书，洛璃已提醒。',
    byPerson(1001),
  );
  U(book, 1002, '压缩完了？我接着说，周六我可能晚 10 分钟', now - 75 * MIN);
  server.addSeg(
    book,
    'clear',
    now - 60 * MIN,
    null,
    // 很长的显示名：分隔线上名字截短、悬停看完整的
    { id: '5210999001', name: '夜观天象的小明同学（读书会管理员、咖啡馆常客、周六聚会的召集人）' },
  );
  U(book, 1001, '@洛璃 我们刚才在聊什么来着？', now - 55 * MIN);
  A(book, '我这边看不到之前的内容了，你们可以再说一下～', now - 55 * MIN + 10e3, {
    usage: [880, 0, 30],
  });
  U(book, 1003, '哈哈，被清空了', now - 50 * MIN);
  // 监听任务四种样子（任务部件里点右边的小箭头展开）：查得通的（带「并且」的条件，有人让建过、到点两次）、查不到的、已经取消的；只记录的在「推荐几部科幻小说」里
  const wOk = addWatch(book, 'ok', {
    by: byPerson(1004),
    createdAt: now - 3 * DAY,
    check: { lastCheckedAt: isoOf(now - 4 * MIN), lastSuccessAt: isoOf(now - 4 * MIN) },
    state: { dueCount: 2, lastDueAt: isoOf(now - 45 * MIN) },
  });
  const failSince = now - 6.5 * HOUR;
  const wBad = addWatch(book, 'failing', {
    by: byPerson(1001),
    createdAt: now - 2 * DAY,
    check: {
      lastCheckedAt: isoOf(now - 6 * MIN),
      lastSuccessAt: isoOf(failSince - 4 * MIN),
      failing: { since: isoOf(failSince), reason: FAIL_REASON },
    },
    state: { dueCount: 1, lastDueAt: isoOf(now - 2 * DAY + 3 * HOUR) },
  });
  addWatch(book, 'cancelled', {
    by: byPerson(1002),
    createdAt: now - 5 * DAY,
    state: cancelledAt(now - 2 * DAY - 2 * HOUR),
  });
  // 时间线里：监听触发（后面跟着洛璃的回复）、监听失败（洛璃告诉大家）
  server.addEvent(book, wOk.id, 'monitor', now - 45 * MIN, watchEventText(wOk.action, 2));
  A(
    book,
    '上海中心气象台刚发了两条预警：大风黄色预警，今天傍晚到明天上午沿海阵风 7～8 级；暴雨橙色预警，未来 3 小时有强降水，路上小心积水～',
    now - 45 * MIN + 25e3,
    { usage: [2240, 1536, 96] },
  );
  server.addEvent(
    book,
    wBad.id,
    'monitor-failed',
    now - 20 * MIN,
    watchFailedText(wBad, failSince, FAIL_REASON),
  );
  A(
    book,
    '我盯着北京天气预警的那个任务已经查不到半天了，说是今天的请求次数用完了。可以请人看看服务的配置，或者把这个任务取消（t' +
      wBad.id +
      '）～',
    now - 20 * MIN + 18e3,
    { usage: [2480, 1792, 74] },
  );

  const star = server.addConv({
    platform: 'telegram',
    kind: 'group',
    title: '星空观测站',
    chatId: '-1001288362002',
    at: now - 30 * DAY,
    id: 'c-star',
  }).id;
  server.addTask({
    convId: star,
    action: '提醒大家狮子座流星雨的观测时间',
    schedule: { kind: 'monthly', day: 17, time: '21:00' },
    by: byPerson(2001),
    createdAt: now - 5 * DAY,
  });
  server.addTask({
    convId: star,
    action: '说说今晚的云量和月相',
    schedule: {
      kind: 'weekdays',
      time: '08:30',
      until: isoOf(new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999).getTime()),
    },
    by: byPerson(2002),
    createdAt: now - 4 * DAY,
  });
  const tTripod = server.addTask({
    convId: star,
    action: '提醒老周带三脚架',
    schedule: once(now - 30 * HOUR),
    by: byPerson(1002),
    createdAt: now - 3 * DAY,
    state: missedAt(now - 14 * MIN),
  }).id;
  server.addSeg(
    star,
    'idle',
    now - 7 * HOUR,
    '群友在约这周的观测。老周推荐了城郊的水库，光污染小；月亮不睡在练习拍月亮，问过洛璃对焦和曝光的设置。',
  );
  U(star, 2001, '今晚云量 20%，月亮 22 点才升起，适合拍 M42', now - 6 * HOUR);
  U(star, 2002, '昨晚拍的月亮', now - 5 * HOUR - 50 * MIN, { image: imgPart(225, 48, '月亮.jpg') });
  U(star, 1002, '好清楚！用的什么镜头', now - 5 * HOUR - 40 * MIN);
  U(star, 2002, '@洛璃 帮我看看这张对焦准不准', now - 5 * HOUR - 30 * MIN);
  A(
    star,
    '对焦挺准的！环形山的边缘很锐利，右下角有一点点暗角，后期拉一下就好～',
    now - 5 * HOUR - 29 * MIN,
    {
      think: ['看图里环形山的边缘，明暗交界线附近细节清楚，对焦没问题；四角略暗。', 4],
      usage: [3310, 1024, 66],
    },
  );
  U(star, 2001, '洛璃 英仙座流星雨还有吗', now - 40 * MIN);
  A(star, '英仙座已经过啦，最近的是 11 月中旬的狮子座流星雨，17、18 号前后最多，', now - 39 * MIN, {
    aborted: true,
    usage: [3720, 3072, 31],
  });
  server.addEvent(star, tTripod, 'task-missed', now - 14 * MIN);
  U(star, 2002, '那 17 号一起去水库？', now - 12 * MIN);
  U(star, 1002, '我可以！', now - 8 * MIN);
  server.setUnread(star, 2);

  const ball = server.addConv({
    platform: 'telegram',
    kind: 'group',
    title: '周末打球',
    chatId: '-1001288363003',
    at: now - 60 * DAY,
    id: 'c-ball',
  }).id;
  server.addSeg(ball, 'first', now - 6 * HOUR, null);
  server.addTask({
    convId: ball,
    action: '提醒大家周六带球和打气筒',
    schedule: { kind: 'weekly', weekday: 6, time: '08:30' },
    by: byPerson(3001),
    createdAt: now - 6 * HOUR,
  });
  server.addTask({
    convId: ball,
    action: '提醒大家交场地费',
    schedule: once(clock(2, 12)),
    by: byPerson(3002),
    createdAt: now - 5 * HOUR,
    state: cancelledAt(now - 4 * HOUR),
  });
  U(ball, 3001, '周六上午 9 点，老地方', now - 6 * HOUR);
  U(ball, 3002, '我带球，谁带打气筒', now - 5 * HOUR - 30 * MIN);
  U(ball, 1003, 'nori 周六会下雨吗', now - 5 * HOUR);
  A(ball, '我看看哦，周六上午', now - 5 * HOUR + MIN, { failed: true });
  U(ball, 3001, '洛璃好像卡住了哈哈', now - 4 * HOUR - 50 * MIN);
  U(ball, 3002, '那就先按不下雨准备', now - 50 * MIN);
  server.setUnread(ball, 3);

  const dm = server.addConv({
    platform: 'telegram',
    kind: 'private',
    title: '与 小雨 的私聊',
    chatId: '50001002',
    at: now - 40 * DAY,
    id: 'c-dm',
  }).id;
  server.addSeg(dm, 'first', now - 13 * HOUR, null);
  server.addTask({
    convId: dm,
    action: '提醒小雨早点睡',
    schedule: { kind: 'daily', time: '22:30' },
    by: byPerson(1002),
    createdAt: now - 4 * DAY,
  });
  server.addTask({
    convId: dm,
    action: '提醒小雨去取快递',
    schedule: once(now - 25 * HOUR),
    by: byPerson(1002),
    createdAt: now - 2 * DAY,
    state: doneAt(now - 25 * HOUR),
  });
  U(dm, 1002, '洛璃晚安～', now - 13 * HOUR);
  A(dm, '晚安小雨！明天也要元气满满哦！', now - 13 * HOUR + MIN, { usage: [980, 768, 18] });
  U(dm, 1002, '早！今天降温了', now - 70 * MIN);
  A(dm, '早呀！今天最高只有 9 度，出门记得围巾～', now - 69 * MIN, { usage: [1120, 768, 21] });
  server.setUnread(dm, 1);

  const cli = server.addConv({
    platform: 'cli',
    kind: 'cli',
    at: now - 3 * DAY,
    id: 'c-cli',
  }).id;
  server.addSeg(cli, 'first', now - 26 * HOUR, null);
  U(cli, '小林', '测试一下 fetch 工具 https://example.com', now - 26 * HOUR);
  A(
    cli,
    '读到啦！这是 IANA 的示例页面，只有一句说明：这个域名只用于文档示例～',
    now - 26 * HOUR + MIN,
    {
      tool: {
        url: 'https://example.com',
        summary: 'Example Domain 示例页面，只有一段说明文字',
        ms: 820,
        chars: 167,
      },
      usage: [1408, 0, 44],
    },
  );
  U(cli, '小林', '写一首关于星星的长诗', now - 25 * HOUR);
  A(cli, '星星落进口袋里，\n口袋里装着一整个夏天，', now - 25 * HOUR + MIN, { aborted: true });

  const w1 = server.addConv({
    platform: 'web',
    kind: 'web',
    title: '推荐几部科幻小说',
    at: now - 3 * DAY,
    id: 'c-web1',
  }).id;
  server.addSeg(w1, 'first', now - 3 * DAY, null);
  const tReview = server.addTask({
    convId: w1,
    action: '提醒我看科幻小说的书评',
    schedule: once(now - 2 * DAY - 4 * HOUR),
    by: { name: WEB_AUTHOR },
    createdAt: now - 3 * DAY,
    state: missedAt(now - 2 * DAY),
  }).id;
  U(w1, WEB_AUTHOR, '推荐几部科幻小说', now - 3 * DAY);
  A(
    w1,
    '好呀～ 按口味挑：想烧脑就读《你一生的故事》，想热血就读《火星救援》，想哭一场就读《献给阿尔吉侬的花束》！',
    now - 3 * DAY + MIN,
    { usage: [1210, 0, 52] },
  );
  server.addEvent(w1, tReview, 'task-missed', now - 2 * DAY);
  // 只记录的监听任务：到点只写事件，洛璃不回复（这个会话里没有进行中的定时任务）
  const wRec = addWatch(w1, 'record', {
    by: { name: WEB_AUTHOR },
    createdAt: now - 2 * DAY,
    check: { lastCheckedAt: isoOf(now - 12 * MIN), lastSuccessAt: isoOf(now - 12 * MIN) },
    state: { dueCount: 3, lastDueAt: isoOf(now - 5 * HOUR) },
  });
  server.addEvent(w1, wRec.id, 'monitor', now - 5 * HOUR, watchEventText(wRec.action, 1));
  const w2 = server.addConv({
    platform: 'web',
    kind: 'web',
    title: '帮我起个群名',
    at: now - 20 * HOUR,
    id: 'c-web2',
  }).id;
  server.addSeg(w2, 'first', now - 20 * HOUR, null);
  server.addTask({
    convId: w2,
    action: '提醒我把本周的周报整理好发给团队，别忘了附上上周的遗留问题清单和下周的计划',
    schedule: once(Math.ceil((now + 20 * MIN) / MIN) * MIN),
    by: { name: WEB_AUTHOR },
    createdAt: now - 20 * HOUR + 2 * MIN,
  });
  const tWater = server.addTask({
    convId: w2,
    action: '提醒我喝水',
    schedule: once(now - 19 * HOUR),
    by: { name: WEB_AUTHOR },
    createdAt: now - 20 * HOUR + 2 * MIN,
    state: doneAt(now - 19 * HOUR),
  }).id;
  U(w2, WEB_AUTHOR, '帮我给天文社团起个群名', now - 20 * HOUR);
  A(w2, '“今晚有星星”“拾星社”“仰望小分队”——我最喜欢第一个，像一句约定～', now - 20 * HOUR + MIN, {
    usage: [1180, 768, 40],
  });
  server.addEvent(w2, tWater, 'task', now - 19 * HOUR);
  A(w2, '到点啦～ 该喝水了，顺便站起来活动一下～', now - 19 * HOUR + 20e3, {
    usage: [1230, 768, 28],
  });

  seedMarkdown(now);

  /* 今天的模型调用（模拟）：42 次完成，2 次失败 */
  const t0 = startOfDay(now),
    span = Math.max(now - t0 - 10 * MIN, HOUR);
  const weights: [string, number][] = [
    [book, 14],
    [star, 11],
    [ball, 6],
    [dm, 8],
    [cli, 1],
    [w2, 2],
  ];
  let k = 0;
  for (const [cid, n] of weights)
    for (let i = 0; i < n; i++) {
      const inp = randi(2600, 5600);
      server.addCall({
        conversation_id: cid,
        started_at: new Date(t0 + (((k++ * 7919) % 44) / 44) * span).toISOString(),
        duration_ms: randi(1200, 5200),
        outcome: 'completed',
        input_tokens: inp,
        cache_read_tokens: Math.floor((inp * rand(0.68, 0.9)) / 64) * 64,
        output_tokens: randi(40, 420),
        steps: 1,
        tool_calls: 0,
      });
    }
  // 摘要也是模型调用：今天的 token 把它们算进去，回复数不算
  for (let i = 0; i < 2; i++)
    server.addCall({
      conversation_id: book,
      started_at: new Date(t0 + span * (0.2 + i * 0.3)).toISOString(),
      duration_ms: 4200,
      outcome: 'completed',
      purpose: 'summary',
      input_tokens: 8200,
      cache_read_tokens: 6144,
      output_tokens: 310,
    });
  for (let i = 0; i < 2; i++)
    server.addCall({
      conversation_id: ball,
      started_at: new Date(t0 + span * (0.3 + i * 0.4)).toISOString(),
      duration_ms: 3100,
      outcome: 'failed',
      input_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 0,
      error: 'APICallError 429',
    });
}

const BIG_TITLES = [
  '读书会',
  '星空观测站',
  '周末打球',
  '摄影小组',
  '猫咪互助会',
  '考研加油站',
  '深夜食堂',
  '吉他练习群',
  '徒步旅行',
  '前端交流',
  '桌游局',
  '跑步打卡',
  '日语学习',
  '咖啡爱好者',
  '电影夜',
  '家庭群',
  '宿舍 404',
  '租房互助',
  '二手闲置',
  '露营装备',
  '钓鱼佬聚集地',
  '烘焙小分队',
  '养花日记',
  'Switch 联机',
  '开源周报',
  '健身房',
  '羽毛球',
  '读诗会',
  '城市骑行',
  '天文摄影',
];
const LONG_LINES = [
  '我觉得这件事得从头说起。上周我们本来约好周六一起去，结果临时有人加班，改到周日；周日又下雨，最后只去了三个人。所以这次我建议提前一周定好时间，大家在群里接龙，人数够了再订场地，不够就顺延，别再临时改了，不然每次都有人白跑一趟。',
  '刚看完，信息量太大了。前半段一直在铺垫，我差点以为要弃了，结果最后二十页把前面所有细节都串起来了，那个反转我是真的没想到。强烈建议大家读到最后再讨论，千万别剧透！',
  '分享一下这次的路线：早上 7 点从地铁站集合，坐 40 分钟大巴到山脚，沿东线上山大概 3 小时，山顶有补给点；下山走西线，比较陡，记得带登山杖。全程 14 公里左右，爬升 900 米，新手量力而行。',
  '哈哈哈哈哈哈哈',
  '收到',
  '有人知道附近哪里能修车吗？链条掉了好几次了',
  '今天降温了，大家多穿点',
  '@洛璃 帮我总结一下今天群里聊了什么，我刚下班，翻了半天没翻完，一千多条消息……',
];
const BIG_NAMES = [
  '小明',
  '小雨',
  '阿澈',
  '书虫',
  '大刘',
  '胖虎',
  '一只猫',
  '晴天',
  '阿飞',
  '豆豆',
  '老王',
  '星星眼',
  '橘子汽水',
  '路人甲',
  '慢慢',
  '半夏',
];
function seedBig() {
  const now = Date.now();
  BIG_TITLES.forEach((title, i) => {
    const kind = i === 5 ? 'private' : 'group';
    const c = server.addConv({
      platform: 'telegram',
      kind,
      title: kind === 'private' ? '与 晴天 的私聊' : title,
      chatId: String(-1001288370000 - i),
      at: now - (40 + i) * DAY,
    }).id;
    // 第一个会话有 650 条消息：看分批取（200 条一批）和「一次取到分隔线那条」
    const long = i === 0;
    const n = long ? 650 : randi(14, 34);
    let t = long ? now - 650 * 8 * MIN : now - randi(2, 60 * 30) * MIN - n * 9 * MIN;
    server.addSeg(c, 'first', t, null);
    for (let j = 0; j < n; j++) {
      if (long ? j > 0 && j % 160 === 0 : j === Math.floor(n / 2))
        server.addSeg(
          c,
          j % 2 ? 'compress' : 'idle',
          t,
          '之前大家在聊' + title + '的安排：' + pick(LONG_LINES).slice(0, 60) + '……',
        );
      const nm = pick(BIG_NAMES);
      const uidv = 9000 + BIG_NAMES.indexOf(nm);
      PEOPLE[uidv] = nm;
      if (j % 6 === 5)
        A(
          c,
          pick([
            '好呀～ 我记下啦！',
            '这个我知道！' + pick(LONG_LINES).slice(0, 80) + '～',
            '收到收到！',
            '让我想想……我觉得周六更合适，大家都有空。',
          ]),
          t,
          { usage: [randi(2000, 9000), randi(0, 6000), randi(20, 200)] },
        );
      else
        U(
          c,
          uidv,
          pick(LONG_LINES),
          t,
          j % 11 === 3 ? { image: imgPart(randi(0, 360), randi(0, 360), '照片.jpg') } : undefined,
        );
      t += randi(2, 14) * MIN;
    }
    if (long) server.setUnread(c, 320);
    else if (i % 3 === 0) server.setUnread(c, randi(1, 99));
    // 前十个会话各有几个任务（看分组很多时的样子）
    if (i < 10) {
      const acts = ['提醒大家交周报', '说说今天的天气', '提醒大家晚上 8 点开会', '汇总这周的活动'];
      for (let k = 0; k <= i % 3; k++)
        server.addTask({
          convId: c,
          action: acts[(i + k) % acts.length],
          schedule:
            k % 2
              ? { kind: 'weekdays', time: `${pad(8 + k)}:${pad((i * 7) % 60)}` }
              : once(clock(1 + ((i + k) % 5), 9 + k, (i * 5) % 60)),
          by: byPerson(1001 + ((i + k) % 4)),
          createdAt: now - (i + 1) * HOUR,
        });
    }
  });
  ['帮我写一段很长很长的自我介绍，用在社团招新上', '新对话'].forEach((title, i) => {
    const c = server.addConv({ platform: 'web', kind: 'web', title, at: now - (i + 1) * HOUR }).id;
    server.addSeg(c, 'first', now - (i + 1) * HOUR, null);
    if (i === 0) {
      U(c, WEB_AUTHOR, title, now - HOUR);
      A(c, '好的！' + LONG_LINES[2] + LONG_LINES[1], now - HOUR + MIN, { usage: [1800, 0, 260] });
    }
  });
  // 一个很长的网页对话（520 条）：看对话里往上翻、分批取更早的消息
  const long = server.addConv({
    platform: 'web',
    kind: 'web',
    title: '很长的对话（520 条）',
    at: now - 3 * HOUR,
  }).id;
  let lt = now - 3 * HOUR - 520 * MIN;
  server.addSeg(long, 'first', lt, null);
  for (let j = 0; j < 260; j++) {
    U(long, WEB_AUTHOR, `第 ${j + 1} 个问题：` + pick(LONG_LINES).slice(0, 40), lt);
    lt += MIN;
    A(long, `第 ${j + 1} 个回答：` + pick(LONG_LINES).slice(0, 70), lt, {
      think: j % 7 === 0 ? ['想一想这个问题怎么答。', 2 + (j % 3)] : undefined,
      tool:
        j % 13 === 0
          ? { url: 'example.com/p' + j, summary: '示例页面 ' + j, ms: 600 + j, chars: 1200 }
          : undefined,
      usage: [1800, 0, 60],
    });
    lt += MIN;
  }
  const t0 = startOfDay(now);
  for (let i = 0; i < 380; i++)
    server.addCall({
      conversation_id: server.all()[i % 30].id,
      started_at: new Date(t0 + rand(0, Math.max(now - t0 - MIN, MIN))).toISOString(),
      duration_ms: 2000,
      outcome: i % 37 === 0 ? 'failed' : 'completed',
      input_tokens: randi(3000, 12000),
      cache_read_tokens: randi(1500, 9000),
      output_tokens: randi(40, 600),
    });
}

/** 灌模拟服务的数据（不推事件）。灌完要调用 mockSource 的 resync 把它交给客户端 */
export function loadData(kind: Dataset) {
  server.reset();
  devUi.set({ dataset: kind });
  server.silent = true;
  try {
    if (kind === 'normal') seedNormal();
    else if (kind === 'big') seedBig();
    server.settle();
  } finally {
    server.silent = false;
  }
}
