import { describe, expect, it } from 'vitest';
import {
  advanceCp,
  cpLen,
  cpSpans,
  GAP_MS,
  LAG_MS,
  makeCuts,
  MIN_GAP_MS,
  Pacer,
  Spans,
  trimBatches,
} from './typing';

/* 假的时钟：按 hz 一帧一帧往前走，arrivals 是（到达的时刻，字数）；
   返回每个字的到达时刻、开始落下的时刻（Pacer 给的，每个字各有各的）、每一帧里轮到了几个字 */
function simulate(arrivals: { t: number; n: number }[], hz = 60, tail = 3000) {
  const p = new Pacer(0);
  const frame = 1000 / hz;
  const arrived: number[] = [];
  const starts: number[] = [];
  const perFrame: number[] = [];
  let total = 0;
  let next = 0;
  const lastT = arrivals.at(-1)!.t + tail;
  for (let now = 0; now <= lastT; now += frame) {
    while (next < arrivals.length && arrivals[next].t <= now) {
      const a = arrivals[next++];
      total += a.n;
      for (let i = 0; i < a.n; i++) arrived.push(a.t);
      p.arrive(total, a.t);
    }
    const got = p.advance(now);
    for (const t of got) expect(t).toBeLessThanOrEqual(now);
    starts.push(...got);
    perFrame.push(got.length);
  }
  return {
    arrived,
    starts,
    lags: starts.map((t, i) => t - arrived[i]),
    gaps: starts.slice(1).map((t, i) => t - starts[i]),
    maxPerFrame: Math.max(...perFrame),
    pacer: p,
    total,
  };
}
const steady = (every: number, n: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ t: 100 + i * every, n }));

describe('Pacer 排成一条、一个接一个落', () => {
  it('平时每隔 GAP_MS（28 毫秒）一个，第一个字到了就落', () => {
    const r = simulate([{ t: 100, n: 5 }]);
    expect(GAP_MS).toBe(28);
    expect(r.starts).toEqual([100, 128, 156, 184, 212]);
  });

  it('来得慢（比 28 毫秒一个还慢）：字到了就落', () => {
    const r = simulate(steady(100, 1, 20));
    expect(r.lags.every((l) => l === 0)).toBe(true);
    expect(r.starts).toHaveLength(20);
  });

  it('一批几个字隔着一会儿来：每批各自从到达的时刻起排，不从头数', () => {
    // 两批各 4 个，第二批到的时候第一批早就排完
    const r = simulate([
      { t: 0, n: 4 },
      { t: 500, n: 4 },
    ]);
    expect(r.starts).toEqual([0, 28, 56, 84, 500, 528, 556, 584]);
  });

  it('新到的字接在队尾：开始时刻单调不减，每个字不早于它到达，相邻字至少隔 MIN_GAP_MS', () => {
    const r = simulate([
      { t: 0, n: 10 },
      { t: 50, n: 10 },
      { t: 70, n: 3 },
      { t: 400, n: 5 },
    ]);
    expect(r.starts).toHaveLength(28);
    r.starts.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(r.arrived[i]);
      if (i) expect(t - r.starts[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_MS - 1e-9);
    });
  });

  it('来得快：每 40 毫秒 7 个字，间隔缩短，每个字都在到达后 LAG_MS 内开始落下', () => {
    for (const hz of [60, 144]) {
      const r = simulate(steady(40, 7, 100), hz);
      expect(r.starts).toHaveLength(700);
      expect(Math.max(...r.lags)).toBeLessThanOrEqual(LAG_MS + GAP_MS);
      expect(Math.min(...r.gaps)).toBeLessThan(GAP_MS - 1);
    }
  });

  it('来得再快也不会比 MIN_GAP_MS 更密，来得慢了间隔回到 28 毫秒', () => {
    const r = simulate([...steady(10, 20, 30), { t: 3000, n: 6 }]);
    expect(Math.min(...r.gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS - 1e-9);
    // 最后一批到的时候队列早空了：6 个字照 28 毫秒排
    expect(r.starts.slice(-6)).toEqual([3000, 3028, 3056, 3084, 3112, 3140]);
  });

  it('一次来 100 个字：在 LAG_MS 内排完，每个字有自己的开始时刻，一帧里轮到好几个', () => {
    const r = simulate([{ t: 100, n: 100 }], 144);
    expect(r.starts).toHaveLength(100);
    expect(r.lags[99]).toBeLessThanOrEqual(LAG_MS + 1e-6);
    expect(new Set(r.starts).size).toBe(100);
    expect(r.maxPerFrame).toBeGreaterThan(1);
  });

  it('偶尔来一大批、平时一小批：每个字都没有落后超过 LAG_MS（加一个间隔）', () => {
    const arrivals = steady(35, 7, 60);
    arrivals.splice(20, 0, { t: arrivals[20].t - 1, n: 100 });
    arrivals.splice(45, 0, { t: arrivals[45].t - 1, n: 160 });
    const r = simulate(arrivals);
    expect(Math.max(...r.lags)).toBeLessThanOrEqual(LAG_MS + GAP_MS);
  });

  it('帧隔了很久才来一次（标签页在后台）：这一次把过了点的字都排出来，开始时刻还是各自的', () => {
    const p = new Pacer(0);
    p.arrive(5, 0);
    const got = p.advance(10_000);
    expect(got).toEqual([0, 28, 56, 84, 112]);
    expect(p.pending).toBe(0);
  });

  it('还没轮到的字：advance 只给到 now 为止的', () => {
    const p = new Pacer(0);
    p.arrive(5, 0);
    expect(p.advance(0)).toEqual([0]);
    expect(p.advance(27)).toEqual([]);
    expect(p.advance(60)).toEqual([28, 56]);
    expect(p.shown).toBe(3);
    expect(p.pending).toBe(2);
  });

  it('起点：挂上时已有的字不进队列；snap 直接放到', () => {
    const p = new Pacer(40);
    expect(p.shown).toBe(40);
    expect(p.pending).toBe(0);
    expect(p.advance(16)).toEqual([]);
    p.arrive(60, 100);
    expect(p.pending).toBe(20);
    p.snap(60);
    expect(p.pending).toBe(0);
    expect(p.shown).toBe(60);
    expect(p.advance(500)).toEqual([]);
  });

  it('重复到达同样的字数不记', () => {
    const p = new Pacer(0);
    p.arrive(10, 0);
    p.arrive(10, 5);
    p.arrive(4, 6);
    expect(p.pending).toBe(10);
  });

  it('按字（码点）数：表情、生僻字算一个，一个字一个开始时刻，切开时不拆代理对', () => {
    const text = 'a😀b𠮷c';
    const p = new Pacer(0);
    p.arrive(cpLen(text), 0);
    const starts = p.advance(1000);
    expect(starts).toHaveLength(5);
    let at = 0;
    const pieces: string[] = [];
    for (let i = 0; i < starts.length; i++) {
      const to = advanceCp(text, at, 1);
      pieces.push(text.slice(at, to));
      at = to;
    }
    expect(pieces).toEqual(['a', '😀', 'b', '𠮷', 'c']);
  });
});

describe('字数（码点）', () => {
  it('表情、生僻字算一个字', () => {
    expect(cpLen('')).toBe(0);
    expect(cpLen('abc你好')).toBe(5);
    expect(cpLen('a😀b𠮷')).toBe(4);
    expect(cpLen('😀')).toBe(1);
  });
  it('advanceCp 不把一个字拆开', () => {
    const s = 'a😀b𠮷c';
    expect(advanceCp(s, 0, 1)).toBe(1);
    expect(advanceCp(s, 1, 1)).toBe(3);
    expect(advanceCp(s, 0, 4)).toBe(s.indexOf('c'));
    expect(advanceCp(s, 0, 99)).toBe(s.length);
    expect(Array.from(s).slice(0, 3).join('')).toBe(s.slice(0, advanceCp(s, 0, 3)));
  });
});

describe('makeCuts 末尾刚放出的字怎么按批切开', () => {
  const b = (id: number, n: number) => ({ id, n, at: id * 10 });
  it('最新的一批在最末尾，往前依次是旧的批', () => {
    expect(makeCuts(10, [b(1, 3), b(2, 2), b(3, 1)])).toEqual([
      { id: 1, at: 10, from: 4, to: 7 },
      { id: 2, at: 20, from: 7, to: 9 },
      { id: 3, at: 30, from: 9, to: 10 },
    ]);
  });
  it('文字比这些批加起来短时，最旧的批被截掉', () => {
    expect(makeCuts(4, [b(1, 3), b(2, 2), b(3, 1)])).toEqual([
      { id: 1, at: 10, from: 0, to: 1 },
      { id: 2, at: 20, from: 1, to: 3 },
      { id: 3, at: 30, from: 3, to: 4 },
    ]);
  });
  it('没有批、空文字：没有切口', () => {
    expect(makeCuts(5, [])).toEqual([]);
    expect(makeCuts(0, [b(1, 3)])).toEqual([]);
  });
});

describe('不占放字时间的字（链接的网址）', () => {
  it('Spans：位置在不在范围里、一段里有几个', () => {
    const sp = new Spans([
      [3, 6],
      [10, 12],
    ]);
    expect([2, 3, 5, 6, 10, 11, 12].map((i) => sp.has(i))).toEqual([
      false,
      true,
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(sp.count(0, 20)).toBe(5);
    expect(sp.count(4, 11)).toBe(3);
    expect(sp.count(6, 10)).toBe(0);
    expect(new Spans().has(0)).toBe(false);
  });

  it('cpSpans：UTF-16 下标的范围换成字（码点）的范围', () => {
    const text = 'a😀[b](u)';
    const i = text.indexOf('](u)');
    const sp = cpSpans(text, [[i, text.length]]);
    expect(sp.has(cpLen(text.slice(0, i)))).toBe(true);
    expect(sp.count(0, cpLen(text))).toBe(4);
    expect(sp.has(2)).toBe(false); // 表情后面的 [ 是第 3 个字
  });

  it('这些字一到就算放完：不要间隔，不在返回的开始时刻里，后面的字接着照节奏出', () => {
    // 「看[文字](https://e.com)吧」：从 ] 起的 17 个字不占时间
    const text = '看[文字](https://e.com)吧';
    const url = cpSpans(text, [[text.indexOf(']'), text.indexOf('吧')]]);
    const p = new Pacer(0);
    p.arrive(cpLen(text), 0);
    const starts = p.advance(10_000, url);
    // 看 [ 文 字 | 吧：5 个字有时间，其余不占
    expect(starts).toEqual([0, 28, 56, 84, 112]);
    expect(p.shown).toBe(cpLen(text));
    expect(p.pending).toBe(0);
  });

  it('网址在队尾、字没到齐：放到哪算哪，后来的字接着排', () => {
    const p = new Pacer(0);
    const sp = new Spans([[3, 9]]);
    p.arrive(6, 0); // 到了 6 个字：前 3 个有时间，后面 3 个是网址
    expect(p.advance(0, sp)).toEqual([0]);
    expect(p.advance(100, sp)).toEqual([28, 56]);
    expect(p.shown).toBe(6); // 网址的 3 个字紧接着放完
    p.arrive(9, 150); // 网址又到了 3 个字（还是网址）
    expect(p.advance(150, sp)).toEqual([]);
    expect(p.shown).toBe(9);
    p.arrive(11, 160); // 后面 2 个字是正文：接在上一个有时间的字后面
    expect(p.advance(1000, sp)).toEqual([160, 188]);
  });

  it('追赶只看有时间的字：一大批里网址很长，间隔不因为它缩短', () => {
    const p = new Pacer(0);
    const sp = new Spans([[10, 110]]); // 100 个字的网址
    p.arrive(120, 0);
    const starts = p.advance(10_000, sp);
    expect(starts).toHaveLength(20);
    // 只有 20 个字要排：在 LAG_MS 内排完，间隔约 12 毫秒；算上网址的 100 个字会缩到 2 毫秒
    expect(starts[19]).toBeLessThanOrEqual(LAG_MS + 1e-6);
    expect(starts[1] - starts[0]).toBeGreaterThan(10);
  });
});

describe('trimBatches 去掉最新的几个没显示的字', () => {
  const b = (id: number, n: number) => ({ id, n, at: id * 10 });
  it('不去：原样（同一个数组）', () => {
    const list = [b(1, 3), b(2, 1)];
    expect(trimBatches(list, 0)).toBe(list);
  });
  it('从最新的一批往前去，去不完的批减少个数', () => {
    expect(trimBatches([b(1, 3), b(2, 2), b(3, 1)], 1)).toEqual([b(1, 3), b(2, 2)]);
    expect(trimBatches([b(1, 3), b(2, 2), b(3, 1)], 2)).toEqual([b(1, 3), b(2, 1)]);
    expect(trimBatches([b(1, 3), b(2, 2), b(3, 1)], 4)).toEqual([b(1, 2)]);
    expect(trimBatches([b(1, 3)], 9)).toEqual([]);
  });
  it('配合 makeCuts：结尾的符号一到，前面显示出来的最后几个字的批不变（不再落一次）', () => {
    // 「加粗」两个字各一批，接着 ** 到了：* 的批不能算在「加粗」头上
    const before = makeCuts(2, [b(1, 1), b(2, 1)]);
    const after = makeCuts(2, trimBatches([b(1, 1), b(2, 1), b(3, 1), b(4, 1)], 2));
    expect(after).toEqual(before);
  });
});
