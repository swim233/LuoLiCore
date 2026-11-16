/* 逐字输出（光标打字）里不碰 DOM 的部分：放字的节奏、按字（码点）数的换算、刚放出的字怎么按批切开。
   组件在 Typed.tsx。

   一回复的文字是一批一批到达的（对话里约 30 ms、「此刻」里约 50 ms 一批），但不照到达的样子一下子全冒出来：
   到达的字排成一条队，一个接一个轮到，轮到的字才出现、各自落下，光标紧跟在最后出现的字后面。 */

/** 平时相邻两个字开始落下的间隔（毫秒） */
export const GAP_MS = 28;
/** 追赶时间隔最短缩到这么多（毫秒）。屏幕一帧至少 7 ms，比一帧短的间隔看上去就是同一帧里出现：取 1 ms，一次来 100 个字也能在 LAG_MS 内排完 */
export const MIN_GAP_MS = 1;
/** 每个字到达后，最迟到这个时间点开始落下（毫秒）。从界面收到字算起；再加上收到前后的几十毫秒（对话里的合并、一次渲染），
 *  从服务发出算起显示最多落后约 0.3 秒 */
export const LAG_MS = 240;
/** 一个字落下的时长（毫秒），落完就当普通文字 */
export const DROP_MS = 300;

/** 文字有多少个字（码点，一个表情、生僻字算一个，和 Array.from 一致，不用建数组） */
export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 高位代理后面跟着低位代理：一个字
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** 从 UTF-16 下标 at 起再往后数 n 个字，返回新的下标（到头为止） */
export function advanceCp(s: string, at: number, n: number): number {
  let i = at;
  for (let k = 0; k < n && i < s.length; k++) {
    const c = s.charCodeAt(i);
    i++;
    if (c >= 0xd800 && c <= 0xdbff && i < s.length) {
      const d = s.charCodeAt(i);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return i;
}

/** 一组字（码点）的位置范围 [from, to)，按位置排好、互不重叠。放字时这些字不占时间（链接的网址：显示出来的只有方括号里的字） */
export class Spans {
  constructor(private readonly ranges: readonly (readonly [number, number])[] = []) {}
  has(pos: number): boolean {
    for (const [a, b] of this.ranges) {
      if (pos < a) return false;
      if (pos < b) return true;
    }
    return false;
  }
  /** [from, to) 里有几个字在范围里 */
  count(from: number, to: number): number {
    let n = 0;
    for (const [a, b] of this.ranges) {
      if (a >= to) break;
      n += Math.max(0, Math.min(b, to) - Math.max(a, from));
    }
    return n;
  }
}
/** 把文字里 UTF-16 下标的范围（按位置排好）换成字（码点）的范围 */
export function cpSpans(text: string, ranges: readonly (readonly [number, number])[]): Spans {
  const out: [number, number][] = [];
  let at = 0; // 已经数到的 UTF-16 下标
  let cp = 0; // 到 at 为止有几个字
  const upTo = (i: number) => {
    cp += cpLen(text.slice(at, i));
    at = i;
    return cp;
  };
  for (const [a, b] of ranges) out.push([upTo(a), upTo(b)]);
  return new Spans(out);
}

/**
 * 放字的节奏：到达的字排成一条队，每个字各自开始落下。
 * 每个字的开始时刻 = max(它到达的时刻, 上一个字的开始时刻 + 间隔)；新到的字接在队尾，不从头数，所以同一时刻只有一个波前。
 * 间隔平时是 GAP_MS；每个字开始以后看一眼队列里已经到了、还没轮到的字：
 * 照 GAP_MS 排下去有字会晚于它到达后的 LAG_MS（一批里最后一个最晚，逐批算，最紧的那一批说了算），就把间隔缩短到刚好赶上（最短 MIN_GAP_MS）；
 * 来得慢（队列里没有等着的字）时回到 GAP_MS，来得比 GAP_MS 一个还慢时字到了就落。
 * 每一帧问它到现在为止轮到了哪些字，每个字有自己的开始时刻（可以比这一帧早：一帧里轮到好几个字时各有各的），
 * 落下的动画按各自的开始时刻对起点。
 * free：不占时间的字（链接的网址，见 Spans）：到了就算放完，不要间隔，也不在返回的开始时刻里；
 * 放了几个字看 shown 的变化。追赶时队列里这些字也不算。
 */
export class Pacer {
  private pos: number;
  private total: number;
  /** 到达：到 at 这一刻累计到 end 个字（按时间、按字数都递增） */
  private marks: { at: number; end: number }[] = [];
  private lastStart = -Infinity;
  private gap = GAP_MS;
  constructor(initial = 0) {
    this.pos = this.total = initial;
  }
  /** 已经出现（轮到）的字数 */
  get shown(): number {
    return this.pos;
  }
  /** 到达了、还没轮到的字数 */
  get pending(): number {
    return this.total - this.pos;
  }
  /** 文字累计到了 total 个字（now：毫秒） */
  arrive(total: number, now: number): void {
    if (total <= this.total) return;
    this.total = total;
    this.marks.push({ at: now, end: total });
  }
  /** 不播了：直接放到 total（文字不是接着原来的往后写、关了动画的时候） */
  snap(total: number): void {
    this.pos = this.total = total;
    this.marks = [];
    this.gap = GAP_MS;
    this.lastStart = -Infinity;
  }
  /** 到 now 为止轮到的字：每个字一个开始时刻（毫秒，不晚于 now），按顺序；没有就是空的。不占时间的字（free）放了但不在里面 */
  advance(now: number, free?: Spans): number[] {
    const out: number[] = [];
    // marks[mi] 是装着下一个字（第 pos 个）的那一批
    let mi = 0;
    while (mi < this.marks.length && this.marks[mi].end <= this.pos) mi++;
    while (this.pos < this.total) {
      if (free?.has(this.pos)) {
        this.pos++;
        while (mi < this.marks.length && this.marks[mi].end <= this.pos) mi++;
        continue;
      }
      const arrived = this.marks[mi].at;
      const t = Math.max(arrived, this.lastStart + this.gap);
      if (t > now) break;
      out.push(t);
      this.pos++;
      this.lastStart = t;
      while (mi < this.marks.length && this.marks[mi].end <= this.pos) mi++;
      // 到 t 时已经到了、还没轮到的字（队列）：每一批里最后一个字最晚，它前面排着 end - pos 个字，下一个字在 t + gap 开始，
      // 它在 t + (end - pos) * gap 开始，要赶在它到达后的 LAG_MS 内：gap <= (at + LAG_MS - t) / (end - pos)。取所有批里最紧的
      let gap = GAP_MS;
      for (let k = mi; k < this.marks.length && this.marks[k].at <= t; k++) {
        const m = this.marks[k];
        const ahead = m.end - this.pos - (free ? free.count(this.pos, m.end) : 0);
        if (ahead > 0) gap = Math.min(gap, (m.at + LAG_MS - t) / ahead);
      }
      this.gap = Math.max(MIN_GAP_MS, gap);
    }
    if (mi > 0) this.marks.splice(0, mi);
    return out;
  }
}

/** 同一刻开始落下的那几个字（间隔缩到几乎为零时合成一批）：落下的动画从 at（performance.now 的毫秒）开始 */
export interface Batch {
  id: number;
  n: number;
  at: number;
}
/** 某个字的范围 [from, to)，是哪一批 */
export interface Cut {
  id: number;
  at: number;
  from: number;
  to: number;
}
/**
 * 一段文字（共 len 个字）末尾那几批刚出现的字各占哪一段。batches 从旧到新，最新的一批在最末尾；
 * 文字比这些批加起来短（这一段是不久前才开头的）时，最旧的批被截掉。
 * 放出去的字数是按原文数的，渲染出来的文字里没有 Markdown 的符号，对不上的几个字只是落下的时刻差一点，不影响显示
 */
export function makeCuts(len: number, batches: readonly Batch[]): Cut[] {
  const out: Cut[] = [];
  let end = len;
  for (let i = batches.length - 1; i >= 0 && end > 0; i--) {
    const b = batches[i];
    const from = Math.max(0, end - b.n);
    if (from < end) out.push({ id: b.id, at: b.at, from, to: end });
    end = from;
  }
  return out.reverse();
}

/** 去掉最新的 hidden 个字（不在显示里的结尾符号等）以后的各批：落下的动画只对显示出来的字 */
export function trimBatches(batches: readonly Batch[], hidden: number): readonly Batch[] {
  if (hidden <= 0) return batches;
  const out = batches.slice();
  let left = hidden;
  while (left > 0 && out.length) {
    const b = out[out.length - 1];
    if (b.n <= left) {
      left -= b.n;
      out.pop();
    } else {
      out[out.length - 1] = { ...b, n: b.n - left };
      left = 0;
    }
  }
  return out;
}
