import { describe, expect, it } from 'vitest';
import { FOLLOW, SizeFollower, widthTau } from './follow';

/* 假的时钟：按 hz 一帧一帧往前走，target(t) 给出此刻的目标大小 */
function run(
  target: (t: number) => [number, number],
  from: [number, number],
  ms: number,
  hz = 144,
) {
  const f = new SizeFollower(from[0], from[1]);
  const dt = 1000 / hz;
  const out: { t: number; w: number; h: number; tw: number; th: number }[] = [];
  for (let t = 0; t <= ms; t += dt) {
    const [tw, th] = target(t);
    const [w, h] = f.step(tw, th, dt);
    out.push({ t, w, h, tw, th });
  }
  return out;
}

describe('SizeFollower：宽度', () => {
  /* 逐字：每 28 毫秒出一个字，自然宽度跳 13.5 px（匀速每秒 482 px） */
  const typing = (t: number): [number, number] => [100 + (Math.floor(t / 28) + 1) * 13.5, 40];

  /* 落后量是「台阶刚跳上去那一帧」的值，帧率越高，台阶被摊得越开，峰值越大（60 Hz 1.8、144 Hz 7.3、240 Hz 10.6）；
     平均落后只有 1～4 px。用户的屏是 144 Hz，上限按 8 px 卡 */
  it('匀速增长的输入下，稳态落后不超过 8 px（144 Hz 及以下），永远不超过目标', () => {
    for (const hz of [60, 90, 120, 144]) {
      const rows = run(typing, [100, 40], 2000, hz).filter((r) => r.t > 150);
      const lag = Math.max(...rows.map((r) => r.tw - r.w));
      expect(lag).toBeLessThanOrEqual(8);
      for (const r of rows) expect(r.w).toBeLessThanOrEqual(r.tw + 1e-9);
    }
    for (const hz of [165, 240]) {
      const rows = run(typing, [100, 40], 2000, hz).filter((r) => r.t > 150);
      expect(Math.max(...rows.map((r) => r.tw - r.w))).toBeLessThanOrEqual(11);
    }
  });

  it('13.5 px 的台阶被摊到几帧里：144 Hz 下每帧的变化有上限，没有来回', () => {
    const rows = run(typing, [100, 40], 2000, 144);
    let maxStep = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].w - rows[i - 1].w;
      expect(d).toBeGreaterThanOrEqual(-1e-9);
      maxStep = Math.max(maxStep, d);
    }
    expect(maxStep).toBeLessThanOrEqual(7);
  });

  it('阶跃（+100 px）约 0.15 秒到位，不超调，单调', () => {
    const rows = run(() => [200, 40], [100, 40], 600);
    const at = (ms: number) => rows.find((r) => r.t >= ms)!;
    expect(at(150).w).toBeGreaterThan(100 + 100 * 0.95);
    expect(at(300).w).toBeGreaterThan(200 - 0.5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].w).toBeGreaterThanOrEqual(rows[i - 1].w - 1e-9);
      expect(rows[i].w).toBeLessThanOrEqual(200 + 1e-9);
    }
  });

  it('落后得远时用慢的时间常数，落后得不远时用快的', () => {
    expect(widthTau(0)).toBe(FOLLOW.widthTauFast);
    expect(widthTau(FOLLOW.gapLo)).toBe(FOLLOW.widthTauFast);
    expect(widthTau(500)).toBe(FOLLOW.widthTauSlow);
    expect(widthTau(-500)).toBe(FOLLOW.widthTauSlow);
    const mid = widthTau((FOLLOW.gapLo + FOLLOW.gapHi) / 2);
    expect(mid).toBeGreaterThan(FOLLOW.widthTauFast);
    expect(mid).toBeLessThan(FOLLOW.widthTauSlow);
  });

  it('目标变小时同样收敛，不跑到目标下面', () => {
    const rows = run(() => [120, 40], [300, 40], 800);
    expect(rows.at(-1)!.w).toBeCloseTo(120, 0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].w).toBeLessThanOrEqual(rows[i - 1].w + 1e-9);
      expect(rows[i].w).toBeGreaterThanOrEqual(120 - 1e-9);
    }
  });
});

describe('SizeFollower：高度', () => {
  it('多出一行（+21.6 px）：头一帧只动一点，约 0.15 秒到位，不超调', () => {
    const rows = run(() => [300, 64.8], [300, 43.2], 600);
    expect(rows[0].h - 43.2).toBeLessThanOrEqual(4);
    const at = (ms: number) => rows.find((r) => r.t >= ms)!;
    expect(at(150).h).toBeGreaterThan(43.2 + 21.6 * 0.93);
    expect(at(400).h).toBeGreaterThan(64.8 - 0.5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].h).toBeGreaterThanOrEqual(rows[i - 1].h - 1e-9);
      expect(rows[i].h).toBeLessThanOrEqual(64.8 + 1e-9);
    }
  });

  it('变矮同样收敛', () => {
    const rows = run(() => [300, 43.2], [300, 108], 800);
    expect(rows.at(-1)!.h).toBeCloseTo(43.2, 0);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i].h).toBeLessThanOrEqual(rows[i - 1].h + 1e-9);
  });

  it('宽、高各走各的：一边到位了，另一边不受影响', () => {
    const f = new SizeFollower(100, 40);
    for (let i = 0; i < 200; i++) f.step(100, 80, 7);
    expect(f.width).toBeCloseTo(100, 6);
    expect(f.height).toBeCloseTo(80, 1);
  });
});

describe('SizeFollower：到位与跳变', () => {
  it('settled：差不到 0.5 px 才算到位', () => {
    const f = new SizeFollower(100, 40);
    expect(f.settled(100.4, 39.6)).toBe(true);
    expect(f.settled(101, 40)).toBe(false);
    expect(f.settled(100, 41)).toBe(false);
  });

  it('dt 很大（切回标签页）时不发散，直接到位', () => {
    const f = new SizeFollower(100, 40);
    expect(f.step(500, 300, 5000)).toEqual([500, 300]);
    expect(f.width).toBe(500);
    expect(f.height).toBe(300);
    // 变小也一样
    expect(f.step(50, 20, FOLLOW.snapDt + 1)).toEqual([50, 20]);
  });

  it('dt 为 0 或负数时原地不动', () => {
    const f = new SizeFollower(100, 40);
    expect(f.step(500, 300, 0)).toEqual([100, 40]);
    expect(f.step(500, 300, -3)).toEqual([100, 40]);
    expect(f.step(500, 300, Number.NaN)).toEqual([100, 40]);
  });

  it('不同的帧率走到同一个地方（时间常数按毫秒算）', () => {
    const w = (hz: number) => run(() => [260, 90], [100, 40], 120, hz).at(-1)!;
    const a = w(60);
    const b = w(165);
    expect(Math.abs(a.w - b.w)).toBeLessThan(6);
    expect(Math.abs(a.h - b.h)).toBeLessThan(2);
  });
});
