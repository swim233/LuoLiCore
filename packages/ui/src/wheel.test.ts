import { describe, expect, it } from 'vitest';
import {
  cancelWheel,
  isStep,
  isWheeling,
  takesOver,
  WHEEL_STREAM_GAP,
  WHEEL_TAU,
  WheelMotion,
  wheelDir,
  wheelPixels,
  wheelRegistry,
  WheelStream,
} from './wheel';
import type { WheelHost, WheelLike } from './wheel';

/* 假的滚动区和时钟：一帧一帧往前走。scrollTop 夹在 [0, max]；round 为真时像浏览器一样把写进去的值取整到整数像素 */
function rig(start = 0, max = 100000, round = false) {
  let t = 0;
  let pending: (() => void) | null = null;
  const st = { top: start, max };
  const writes: number[] = [];
  const host: WheelHost = {
    get: () => st.top,
    set: (v) => {
      const w = round ? Math.round(v) : v;
      st.top = Math.min(st.max, Math.max(0, w));
      writes.push(st.top);
    },
    max: () => st.max,
    now: () => t,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    caf: () => {
      pending = null;
    },
  };
  let idle = 0;
  let alive = true;
  const m = new WheelMotion(host, { onIdle: () => idle++, alive: () => alive });
  const run = (ms: number, dt = 1000 / 144) => {
    const end = t + ms;
    while (t < end - 1e-9 && pending) {
      t += dt;
      const cb = pending;
      pending = null;
      cb();
    }
  };
  return {
    m,
    st,
    run,
    writes,
    now: () => t,
    advance: (ms: number) => (t += ms),
    idle: () => idle,
    kill: () => (alive = false),
  };
}

const ev = (o: Partial<WheelLike> = {}): WheelLike => ({
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...o,
});

describe('WheelMotion：一格', () => {
  it('走的总量恰好等于 deltaY（含小数），0.3 秒走掉 96%，剩下不到 0.5 px 时一步走完，不超过', () => {
    for (const dy of [120, 100, 119.9999974, 53.37, -120, -87.21]) {
      const r = rig(5000);
      r.m.add(dy);
      r.run(300);
      expect(Math.abs(r.st.top - 5000) / Math.abs(dy)).toBeGreaterThan(0.96);
      r.run(400);
      expect(r.st.top).toBeCloseTo(5000 + dy, 9);
      expect(r.m.active).toBe(false);
      for (const w of r.writes) {
        const lo = Math.min(5000, 5000 + dy) - 1e-9;
        const hi = Math.max(5000, 5000 + dy) + 1e-9;
        expect(w).toBeGreaterThanOrEqual(lo);
        expect(w).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('90 毫秒时走了约 63%，曲线是指数趋近：逐帧只往一个方向走，越走越慢，没有停顿', () => {
    const r = rig(1000);
    r.m.add(120);
    r.run(90);
    expect((r.st.top - 1000) / 120).toBeCloseTo(1 - Math.exp(-1), 1);
    const w = r.writes;
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThan(w[i - 1]);
    const steps = w.slice(1).map((v, i) => v - w[i]);
    for (let i = 1; i < steps.length - 1; i++)
      expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-9);
  });

  it('帧率不同，走的曲线一样（按毫秒算，不按帧数算）', () => {
    const at90 = (dt: number) => {
      const r = rig(0);
      r.m.add(120);
      r.run(90, dt);
      return r.st.top;
    };
    expect(Math.abs(at90(15) - at90(5))).toBeLessThan(0.01);
    expect(at90(15)).toBeCloseTo(120 * (1 - Math.exp(-1)), 3);
  });

  it('写进 scrollTop 的值被浏览器取整，总行程也不丢像素（内部用浮点数记）', () => {
    // 每格 53.4 px，连滚 7 格，一格之间 40 毫秒；取整的屏上最后停在 round(起点 + 总和)
    const r = rig(1000, 100000, true);
    for (let i = 0; i < 7; i++) {
      r.m.add(53.4);
      r.run(40);
    }
    r.run(1500);
    expect(r.st.top).toBe(Math.round(1000 + 7 * 53.4));
  });

  it('时间常数就是 90 毫秒', () => {
    expect(WHEEL_TAU).toBe(90);
  });
});

describe('WheelMotion：连滚、反向、到头', () => {
  it('连滚几格距离累加，速度自然变快，总量不变', () => {
    const one = rig(0);
    one.m.add(120);
    one.run(40);
    const fast = rig(0);
    for (let i = 0; i < 5; i++) {
      fast.m.add(120);
      fast.run(10);
    }
    fast.run(40);
    // 连滚 5 格以后同样的时间里走得比一格远得多
    expect(fast.st.top).toBeGreaterThan(one.st.top * 2);
    fast.run(2000);
    expect(fast.st.top).toBeCloseTo(600, 9);
  });

  it('连滚 3 格后反向 2 格：剩下的距离相应抵消，掉头时不停顿，总量是 1 格', () => {
    const r = rig(2000);
    for (let i = 0; i < 3; i++) r.m.add(120);
    r.run(20);
    r.m.add(-120);
    r.m.add(-120);
    expect(r.m.pending).toBeLessThan(360 - 240 + 1e-9);
    r.run(2000);
    expect(r.st.top).toBeCloseTo(2000 + 120, 9);
  });

  it('剩下的距离比反向的小：掉头往回走，不停顿', () => {
    const r = rig(2000);
    r.m.add(120);
    r.run(200);
    const mid = r.st.top;
    r.m.add(-300);
    r.run(1);
    expect(r.st.top).toBeLessThan(mid);
    r.run(2000);
    expect(r.st.top).toBeCloseTo(2000 + 120 - 300, 9);
  });

  it('滚到底：超出的清掉，不攒着，之后往上滚一格立刻有反应', () => {
    const r = rig(950, 1000);
    r.m.add(120);
    r.m.add(120);
    r.m.add(120);
    expect(r.m.pending).toBe(50);
    r.run(2000);
    expect(r.st.top).toBe(1000);
    expect(r.m.active).toBe(false);
    r.m.add(-120);
    r.run(7);
    expect(r.st.top).toBeLessThan(1000);
    r.run(2000);
    expect(r.st.top).toBeCloseTo(880, 9);
  });

  it('滚到顶同样清掉', () => {
    const r = rig(30, 1000);
    r.m.add(-120);
    r.m.add(-120);
    expect(r.m.pending).toBe(-30);
    r.run(2000);
    expect(r.st.top).toBe(0);
    r.m.add(120);
    r.run(2000);
    expect(r.st.top).toBeCloseTo(120, 9);
  });

  it('capacity：还能往这个方向走多远，算上没走完的', () => {
    const r = rig(900, 1000);
    expect(r.m.capacity(1)).toBe(100);
    expect(r.m.capacity(-1)).toBe(900);
    r.m.add(60);
    expect(r.m.capacity(1)).toBe(40);
    expect(r.m.capacity(-1)).toBe(960);
    r.m.add(60);
    expect(r.m.capacity(1)).toBe(0);
  });

  it('内容变高（最大值往下走）：到头时被夹住的距离不再被夹，已经清掉的不会回来', () => {
    const r = rig(900, 1000);
    r.m.add(300);
    expect(r.m.pending).toBe(100);
    r.st.max = 2000;
    r.m.add(120);
    expect(r.m.pending).toBe(220);
    r.run(2000);
    expect(r.st.top).toBeCloseTo(1120, 9);
  });
});

describe('WheelMotion：别处也动了位置', () => {
  it('外部把位置挪了（虚拟器补偿、取回更早的消息后校正）：剩下的距离不变，总行程 = deltaY 之和', () => {
    const r = rig(4000);
    r.m.add(120);
    r.run(60);
    const moved = r.st.top - 4000;
    expect(moved).toBeGreaterThan(20);
    r.st.top += 700; // 顶上插进来一批消息，位置被往下补偿了 700
    r.run(2000);
    expect(r.st.top).toBeCloseTo(4000 + 700 + 120, 9);
    // 往回补偿也一样
    const q = rig(4000);
    q.m.add(-150);
    q.run(40);
    q.st.top -= 500;
    q.run(2000);
    expect(q.st.top).toBeCloseTo(4000 - 500 - 150, 9);
  });

  it('外部连着挪几次也不影响', () => {
    const r = rig(10000);
    r.m.add(120);
    r.m.add(120);
    let ext = 0;
    for (let i = 0; i < 20; i++) {
      r.run(10);
      r.st.top += 33;
      ext += 33;
    }
    r.run(2000);
    expect(r.st.top).toBeCloseTo(10000 + 240 + ext, 9);
  });

  it('外部把位置挪到了边上：剩下的距离跟着夹住，不越界', () => {
    const r = rig(900, 1000);
    r.m.add(90);
    r.run(10);
    r.st.top = 1000; // 被别处滚到了底
    r.run(2000);
    expect(r.st.top).toBe(1000);
    expect(r.m.active).toBe(false);
  });
});

describe('WheelMotion：放手、dt 很大、关动画', () => {
  it('cancel：停在此刻的位置，剩下的清掉，之后不再写', () => {
    const r = rig(0);
    r.m.add(120);
    r.run(30);
    const at = r.st.top;
    const n = r.writes.length;
    r.m.cancel();
    expect(r.m.active).toBe(false);
    expect(r.m.pending).toBe(0);
    expect(r.idle()).toBe(1);
    r.run(500);
    expect(r.st.top).toBe(at);
    expect(r.writes.length).toBe(n);
    r.m.cancel();
    expect(r.idle()).toBe(1);
  });

  it('dt 很大（标签页在后台）时一步走完，不越界', () => {
    const r = rig(100, 500);
    r.m.add(300);
    r.advance(10_000);
    r.run(20, 10_000);
    expect(r.st.top).toBe(400);
    // 范围比要走的小：一步走到头，不越界
    const q = rig(100, 350);
    q.m.add(300);
    q.advance(5000);
    q.run(20, 5000);
    expect(q.st.top).toBe(350);
  });

  it('alive 为假（关了动画、形变开始了）：下一帧放手，不再动', () => {
    const r = rig(0);
    r.m.add(120);
    r.run(20);
    const at = r.st.top;
    r.kill();
    r.run(500);
    expect(r.st.top).toBe(at);
    expect(r.m.active).toBe(false);
  });

  it('没有地方可滚（已经在头上又往头的方向滚）：不起动画', () => {
    const r = rig(0, 1000);
    r.m.add(-120);
    expect(r.m.pending).toBe(0);
    r.run(100);
    expect(r.st.top).toBe(0);
    expect(r.m.active).toBe(false);
  });
});

describe('takesOver：接不接管', () => {
  it('普通的滚轮一格（像素 100、120）接管；行、页也接管', () => {
    expect(takesOver(ev({ deltaY: 120 }), true)).toBe(true);
    expect(takesOver(ev({ deltaY: -100 }), true)).toBe(true);
    expect(takesOver(ev({ deltaY: 40 }), true)).toBe(true);
    expect(takesOver(ev({ deltaY: 3, deltaMode: 1 }), true)).toBe(true);
    expect(takesOver(ev({ deltaY: 1, deltaMode: 2 }), true)).toBe(true);
  });
  it('像素级的小步（触控板）不接管：|deltaY| < 40', () => {
    expect(takesOver(ev({ deltaY: 10 }), true)).toBe(false);
    expect(takesOver(ev({ deltaY: -39.9 }), true)).toBe(false);
    // 行、页的单位不看 40 这个数
    expect(takesOver(ev({ deltaY: 1, deltaMode: 1 }), true)).toBe(true);
  });
  it('按着 Ctrl、Shift、Alt、Meta 不接管', () => {
    for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const)
      expect(takesOver(ev({ [k]: true }), true)).toBe(false);
  });
  it('关掉动画不接管；横着的、没有竖向距离的不接管', () => {
    expect(takesOver(ev(), false)).toBe(false);
    expect(takesOver(ev({ deltaX: 200, deltaY: 120 }), true)).toBe(false);
    expect(takesOver(ev({ deltaY: 0 }), true)).toBe(false);
  });
  it('wheelPixels：像素原样，行按 40 px，页按可视高度', () => {
    expect(wheelPixels({ deltaY: 119.9999974, deltaMode: 0 }, 500)).toBe(119.9999974);
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 500)).toBe(120);
    expect(wheelPixels({ deltaY: -1, deltaMode: 2 }, 500)).toBe(-500);
  });
});

describe('WheelStream：同一串事件接不接管只判一次', () => {
  /** 一串事件，事件之间隔 gap 毫秒，返回每个事件接不接管 */
  const decideAll = (
    evs: Partial<WheelLike>[],
    gap = 12,
    st = new WheelStream(),
    start = 1000,
    motion = true,
  ) => evs.map((o, i) => st.decide(ev(o), motion, start + i * gap));
  const dys = (...v: number[]) => v.map((deltaY) => ({ deltaY }));

  it('先大后小：整串都接管', () => {
    expect(decideAll(dys(120, 20, 10, 5, 1))).toEqual([true, true, true, true, true]);
  });
  it('先小后大：整串都交给浏览器，哪怕中间有大的', () => {
    expect(decideAll(dys(20, 120, 150, 10))).toEqual([false, false, false, false]);
  });
  it('大小交替：看第一个', () => {
    expect(decideAll(dys(120, 10, 120, 10, 120))).toEqual([true, true, true, true, true]);
    expect(decideAll(dys(10, 120, 10, 120, 10))).toEqual([false, false, false, false, false]);
  });
  it('方向反过来也是一串（deltaY 的正负不影响，只看大小）', () => {
    expect(decideAll(dys(-120, 20, -10, 30))).toEqual([true, true, true, true]);
    expect(decideAll(dys(-20, 120, 10))).toEqual([false, false, false]);
  });
  it('间隔超过窗口后重新判定；刚好等于窗口还是同一串', () => {
    const st = new WheelStream();
    expect(st.decide(ev({ deltaY: 120 }), true, 1000)).toBe(true);
    expect(st.decide(ev({ deltaY: 10 }), true, 1000 + WHEEL_STREAM_GAP)).toBe(true);
    // 再隔一个窗口多一点：新的一串，小步不接管
    expect(st.decide(ev({ deltaY: 10 }), true, 1000 + 2 * WHEEL_STREAM_GAP + 1)).toBe(false);
    expect(st.decide(ev({ deltaY: 120 }), true, 1000 + 2 * WHEEL_STREAM_GAP + 2)).toBe(false);
    // 又隔了窗口多一点：新的一串，大的接管
    expect(st.decide(ev({ deltaY: 120 }), true, 1000 + 3 * WHEEL_STREAM_GAP + 3)).toBe(true);
    expect(st.decide(ev({ deltaY: 3 }), true, 1000 + 3 * WHEEL_STREAM_GAP + 4)).toBe(true);
  });
  it('窗口按两个相邻事件的间隔算，不是从第一个事件起算：一直连着的长串不会中途重新判定', () => {
    const evs = dys(120, ...Array<number>(100).fill(5));
    // 101 个事件，每隔 100 毫秒一个，一共 10 秒
    expect(decideAll(evs, 100).every((v) => v)).toBe(true);
  });
  it('修饰键、横向为主、没有竖向距离、关掉动画的事件逐个判断为不接管，并结束这一串，下一个事件重新定', () => {
    for (const bad of [
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { deltaX: 300, deltaY: 120 },
      { deltaY: 0 },
    ] as Partial<WheelLike>[]) {
      // 接管的一串被它打断：后面的小步重新判定为不接管
      expect(decideAll([{ deltaY: 120 }, bad, { deltaY: 10 }])).toEqual([true, false, false]);
      // 不接管的一串被它打断：后面的大步重新判定为接管
      expect(decideAll([{ deltaY: 10 }, bad, { deltaY: 120 }])).toEqual([false, false, true]);
    }
    const st = new WheelStream();
    expect(st.decide(ev({ deltaY: 120 }), true, 0)).toBe(true);
    expect(st.decide(ev({ deltaY: 120 }), false, 10)).toBe(false);
    expect(st.decide(ev({ deltaY: 5 }), true, 20)).toBe(false);
  });
  it('行、页是整格，不看 40 这个数；一串里先小后行也不接管', () => {
    expect(isStep(ev({ deltaY: 1, deltaMode: 1 }))).toBe(true);
    expect(isStep(ev({ deltaY: 1, deltaMode: 2 }))).toBe(true);
    expect(decideAll([{ deltaY: 1, deltaMode: 1 }, { deltaY: 5 }])).toEqual([true, true]);
    expect(decideAll([{ deltaY: 5 }, { deltaY: 1, deltaMode: 1 }])).toEqual([false, false]);
  });
  it('reset 以后下一个事件重新定', () => {
    const st = new WheelStream();
    expect(st.decide(ev({ deltaY: 120 }), true, 0)).toBe(true);
    st.reset();
    expect(st.decide(ev({ deltaY: 5 }), true, 5)).toBe(false);
  });
});

/* 把一串事件按 scroll/install-wheel.ts 的做法喂给假的滚动区：接管的加进剩下的距离，不接管的清掉余量、由「浏览器」原样滚。
   事件之间隔 gap 毫秒，帧是 144 Hz，同时记下事件进行当中每一帧走了多少 */
function playback(seq: number[], gap: number, start = 5000) {
  const r = rig(start);
  const st = new WheelStream();
  const taken: boolean[] = [];
  const steps: number[] = [];
  const frame = () => {
    let prev = r.st.top;
    const n0 = r.writes.length;
    return () => {
      const w = r.writes;
      for (let i = n0; i < w.length; i++) {
        steps.push(w[i] - prev);
        prev = w[i];
      }
    };
  };
  for (const d of seq) {
    const take = st.decide(ev({ deltaY: d }), true, r.now());
    taken.push(take);
    if (take) r.m.add(d);
    else {
      r.m.cancel();
      r.st.top += d; // 浏览器原生一下子滚过去
    }
    const done = frame();
    if (r.m.active) r.run(gap);
    else r.advance(gap);
    done();
  }
  const inGesture = steps.length;
  r.run(3000);
  return { r, taken, steps, inGesture, sum: seq.reduce((a, b) => a + b, 0), start };
}

describe('一串大小混在一起的事件：总行程 = deltaY 之和，没有一脉一脉的毛刺', () => {
  // 触控板甩动的事件序列（QA 报告 F1 的三串），事件之间隔 12 毫秒
  const fast = [220, 180, 150, 120, 95, 75, 60, 48, 38, 30, 24, 19, 15, 12, 9, 7, 5, 4, 3, 2, 2, 1];
  const slow = [18, 22, 26, 30, 32, 34, 30, 26, 22, 18, 14, 10, 6, 3];
  const mid = [60, 52, 46, 41, 39, 43, 37, 42, 36, 40, 35, 30, 25, 20, 15, 10, 5];

  it('快甩（大步衰减到小步）：整串接管，走完恰好是事件之和，逐帧先升后降', () => {
    const p = playback(fast, 12);
    expect(p.taken.every((v) => v)).toBe(true);
    expect(p.sum).toBe(1119);
    expect(p.r.st.top).toBeCloseTo(p.start + p.sum, 6);
    const s = p.steps.filter((v) => Math.abs(v) > 1e-9);
    expect(s.every((v) => v > 0)).toBe(true);
    // 只有一个峰：峰之前不降、峰之后不升，只容帧和事件错开引起的小起伏（不超过峰值的 12%）
    const peak = Math.max(...s);
    const top = s.indexOf(peak);
    for (let i = 1; i <= top; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] - peak * 0.12);
    for (let i = top + 1; i < s.length; i++)
      expect(s[i]).toBeLessThanOrEqual(s[i - 1] + peak * 0.12);
    // 峰之后的趋势是一直往下走：每 5 帧的最大值比前 5 帧小
    for (let i = top + 5; i + 5 <= s.length; i += 5)
      expect(Math.max(...s.slice(i, i + 5))).toBeLessThan(Math.max(...s.slice(i - 5, i)));
  });

  it('慢滚（一直小步）：整串不接管，浏览器原样滚，总行程不变', () => {
    const p = playback(slow, 12);
    expect(p.taken.every((v) => !v)).toBe(true);
    expect(p.r.st.top).toBe(p.start + p.sum);
    expect(p.r.m.active).toBe(false);
  });

  it('中速（40 上下徘徊）：整串接管，走完恰好是事件之和，事件进行当中每帧的位移起伏很小', () => {
    const p = playback(mid, 12);
    expect(p.taken.every((v) => v)).toBe(true);
    expect(p.r.st.top).toBeCloseTo(p.start + p.sum, 6);
    // 暖起来以后（前 8 帧之后）到事件还在 40 上下的那一段（约 130 毫秒），每帧的位移都不低于峰值的 60%：
    // 以前大的缓动、小的原生，位移是 39, 3, 3, 37, 4, 2, 36 这样的脉冲
    const steady = p.steps.slice(8, 18);
    expect(steady.length).toBe(10);
    const peak = Math.max(...p.steps);
    for (const v of steady) expect(v).toBeGreaterThan(peak * 0.6);
  });

  it('先小后大、先大后小、大小交替：任何顺序走的总行程都等于事件之和', () => {
    const seqs: number[][] = [
      [20, 120, 150, 10, 5],
      [120, 150, 20, 10, 5, 3],
      [120, 10, 120, 10, 120, 10, 120, 10],
      [10, 120, 10, 120, 10, 120, 10],
      [50, 5, 5, 5, 60, 5, 5, 70, 5],
      [8, 8, 8, 8, 120, 120, 8, 8],
    ];
    for (const seq of seqs) {
      const p = playback(seq, 12);
      // 整串一致
      expect(new Set(p.taken).size).toBe(1);
      expect(p.r.st.top).toBeCloseTo(p.start + p.sum, 6);
    }
  });

  it('间隔超过窗口的两串各自判定：每串内部一致，总行程仍是事件之和', () => {
    const r = rig(8000);
    const st = new WheelStream();
    let browser = 0;
    let expected = 0;
    const feed = (d: number) => {
      expected += d;
      if (st.decide(ev({ deltaY: d }), true, r.now())) r.m.add(d);
      else {
        r.m.cancel();
        r.st.top += d;
        browser += d;
      }
      if (r.m.active) r.run(12);
      else r.advance(12);
    };
    // 第一串：大开头，带小步
    for (const d of [120, 20, 10]) feed(d);
    r.run(2000);
    r.advance(WHEEL_STREAM_GAP + 50);
    // 第二串：小开头（不接管），带大步
    for (const d of [20, 120, 10]) feed(d);
    r.advance(WHEEL_STREAM_GAP + 50);
    // 第三串：又是大开头
    for (const d of [120, 5, 5]) feed(d);
    r.run(3000);
    expect(browser).toBe(20 + 120 + 10);
    expect(r.st.top).toBeCloseTo(8000 + expected, 6);
  });
});

describe('滚轮缓动的登记', () => {
  it('isWheeling / wheelDir / cancelWheel 看得到没走完的滚轮缓动', () => {
    const el = {};
    const r = rig(1000);
    wheelRegistry.set(el, r.m);
    expect(isWheeling(el)).toBe(false);
    expect(wheelDir(el)).toBe(0);
    r.m.add(-120);
    expect(isWheeling(el)).toBe(true);
    expect(wheelDir(el)).toBe(-1);
    r.m.add(300);
    expect(wheelDir(el)).toBe(1);
    cancelWheel(el);
    expect(isWheeling(el)).toBe(false);
    expect(wheelDir(el)).toBe(0);
    // 没登记过的什么也不是
    expect(isWheeling({})).toBe(false);
    expect(wheelDir({})).toBe(0);
    cancelWheel({});
  });
});
