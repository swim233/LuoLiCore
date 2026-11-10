import { describe, expect, it } from 'vitest';
import { advanceCp, cpLen, GAP_MS, LAG_MS, makeCuts, MIN_GAP_MS, Pacer } from './typing';

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
