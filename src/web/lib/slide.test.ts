import { describe, expect, it } from 'vitest';
import { easeOutCubic, Slider, slideSendMs, SLIDE_SEND_MAX } from './slide';
import type { EndReason, SlideHost } from './slide';

/* 假的滚动区和时钟：一帧一帧往前走，scrollTop 夹在 [0, max] 里 */
function rig(start = 0, max = 100000) {
  let t = 0;
  let pending: (() => void) | null = null;
  const log: number[] = [];
  const st = { top: start, max };
  const host: SlideHost = {
    get: () => st.top,
    set: (v) => {
      st.top = Math.min(st.max, Math.max(0, v));
      log.push(st.top);
    },
    now: () => t,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    caf: () => {
      pending = null;
    },
  };
  const slider = new Slider(host);
  /** 往前走 ms 毫秒，每帧 dt 毫秒 */
  const run = (ms: number, dt = 1000 / 144) => {
    const end = t + ms;
    while (t < end - 1e-9 && pending) {
      t += dt;
      const cb = pending;
      pending = null;
      cb();
    }
  };
  return { slider, st, run, log, now: () => t, advance: (ms: number) => (t += ms) };
}

describe('Slider：ease（固定时长，ease-out）', () => {
  it('在时长内到位，单调，前半程走得比后半程多', () => {
    const r = rig(0);
    const ends: EndReason[] = [];
    r.slider.to(1000, { kind: 'ease', ms: 400 }, (e) => ends.push(e));
    r.run(190);
    expect(r.st.top).toBeGreaterThan(500);
    r.run(300);
    expect(r.st.top).toBe(1000);
    expect(ends).toEqual(['done']);
    expect(r.slider.active).toBe(false);
    for (let i = 1; i < r.log.length; i++) expect(r.log[i]).toBeGreaterThanOrEqual(r.log[i - 1]);
  });

  it('目标是函数时每帧重新取：目标在途中往下走，最后停在新的目标上，位置不倒退', () => {
    const r = rig(0);
    let bottom = 500;
    r.slider.to(() => bottom, { kind: 'ease', ms: 300 });
    r.run(100);
    bottom = 900;
    r.run(100);
    expect(r.st.top).toBeLessThanOrEqual(900);
    r.run(600);
    expect(r.st.top).toBe(900);
    for (let i = 1; i < r.log.length; i++)
      expect(r.log[i]).toBeGreaterThanOrEqual(r.log[i - 1] - 1e-9);
  });

  it('快滑完时目标一下子长了一大截：位置不跟着跳，新长的部分接着滑完', () => {
    const r = rig(0);
    let bottom = 1000;
    r.slider.to(() => bottom, { kind: 'ease', ms: 300 });
    r.run(270); // 进度 90%，位置已经几乎到了
    const before = r.st.top;
    bottom += 80; // 回复的气泡换上来，底部又往下 80
    r.run(1);
    // 这一帧只往前走一点，不是一步跳 80
    expect(r.st.top - before).toBeLessThan(40);
    r.run(40);
    const mid = r.st.top;
    expect(mid).toBeLessThan(bottom);
    r.run(600);
    expect(r.st.top).toBe(bottom);
    expect(r.slider.active).toBe(false);
    // 全程单调，没有任何一帧的位移超过 60 px（起步那几帧最快）
    for (let i = 1; i < r.log.length; i++) {
      expect(r.log[i]).toBeGreaterThanOrEqual(r.log[i - 1] - 1e-9);
    }
    const tail = r.log.slice(-60);
    for (let i = 1; i < tail.length; i++) expect(tail[i] - tail[i - 1]).toBeLessThan(40);
  });

  it('时长到了以后才长高：原样跟上，不拖着，滑动能结束', () => {
    const r = rig(0);
    let bottom = 400;
    const ends: EndReason[] = [];
    r.slider.to(
      () => bottom,
      { kind: 'ease', ms: 200 },
      (e) => ends.push(e),
    );
    r.run(220);
    for (let i = 0; i < 100 && r.slider.active; i++) {
      bottom += 3;
      r.run(1);
    }
    expect(r.slider.active).toBe(false);
    expect(r.st.top).toBe(bottom);
    expect(ends).toEqual(['done']);
  });

  it('时长按距离算，最长 0.45 秒', () => {
    expect(slideSendMs(0)).toBeGreaterThanOrEqual(100);
    expect(slideSendMs(100)).toBeLessThan(slideSendMs(1000));
    expect(slideSendMs(1e6)).toBe(SLIDE_SEND_MAX);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
});

describe('Slider：exp（逐帧趋近）', () => {
  it('约 0.2 秒内收敛到目标，不超过目标', () => {
    const r = rig(0);
    r.slider.to(300, { kind: 'exp', tau: 40 });
    r.run(200);
    expect(r.st.top).toBeGreaterThan(295);
    r.run(100);
    expect(r.st.top).toBe(300);
    expect(r.slider.active).toBe(false);
    for (const v of r.log) expect(v).toBeLessThanOrEqual(300);
  });

  it('不从 scrollTop 读回来：每帧不到 1 px 的挪动也不会停在半路（读回来会取整）', () => {
    const r = rig(0);
    // 假装 scrollTop 只存整数
    const host = r.slider as unknown as { host: SlideHost };
    const raw = host.host.set;
    host.host.set = (v) => raw(Math.round(v));
    r.slider.to(40, { kind: 'exp', tau: 90 });
    r.run(3000);
    expect(r.st.top).toBe(40);
  });

  it('变小（往回滑）同样收敛', () => {
    const r = rig(800);
    r.slider.to(100, { kind: 'exp', tau: 40 });
    r.run(500);
    expect(r.st.top).toBe(100);
  });

  it('dt 很大（标签页在后台）时直接到位', () => {
    const r = rig(0);
    r.slider.to(5000, { kind: 'exp', tau: 40 });
    r.run(10, 10);
    r.advance(5000);
    r.run(20, 10);
    expect(r.st.top).toBe(5000);
    expect(r.slider.active).toBe(false);
  });
});

describe('Slider：换目标、放手', () => {
  it('中途换目标：从此刻的位置接着走，不回起点也不跳到新目标', () => {
    const r = rig(0);
    const ends: EndReason[] = [];
    r.slider.to(1000, { kind: 'exp', tau: 60 }, (e) => ends.push(e));
    r.run(100);
    const before = r.st.top;
    r.slider.to(1500, { kind: 'exp', tau: 60 }, (e) => ends.push(e));
    expect(ends).toEqual(['replace']);
    r.run(1);
    // 换目标的那一帧只在原位置附近往前动一点
    expect(r.st.top).toBeGreaterThanOrEqual(before);
    expect(r.st.top - before).toBeLessThan(100);
    r.run(1000);
    expect(r.st.top).toBe(1500);
    expect(ends).toEqual(['replace', 'done']);
  });

  it('中途换成更近的目标（要往回走）：收敛到新目标，不跑到它的另一侧', () => {
    const r = rig(0);
    r.slider.to(1000, { kind: 'exp', tau: 60 });
    r.run(100);
    r.slider.to(400, { kind: 'exp', tau: 60 });
    r.run(1000);
    expect(r.st.top).toBe(400);
    expect(Math.min(...r.log.slice(-40))).toBeGreaterThanOrEqual(400);
  });

  it('换成别的走法也一样（ease 换 exp）', () => {
    const r = rig(0);
    r.slider.to(1000, { kind: 'ease', ms: 400 });
    r.run(100);
    const before = r.st.top;
    r.slider.to(1200, { kind: 'exp', tau: 40 });
    r.run(10);
    expect(r.st.top).toBeGreaterThanOrEqual(before);
    r.run(500);
    expect(r.st.top).toBe(1200);
  });

  it('cancel：停在此刻的位置，之后不再写，onEnd 收到 cancel', () => {
    const r = rig(0);
    const ends: EndReason[] = [];
    r.slider.to(1000, { kind: 'ease', ms: 400 }, (e) => ends.push(e));
    r.run(100);
    const at = r.st.top;
    const n = r.log.length;
    r.slider.cancel();
    expect(ends).toEqual(['cancel']);
    expect(r.slider.active).toBe(false);
    r.run(500);
    expect(r.st.top).toBe(at);
    expect(r.log.length).toBe(n);
    // 没在滑时 cancel 什么也不做
    r.slider.cancel();
    expect(ends).toEqual(['cancel']);
  });

  it('已经在目标上：不起动画，直接结束', () => {
    const r = rig(250);
    const ends: EndReason[] = [];
    r.slider.to(250.2, { kind: 'ease', ms: 400 }, (e) => ends.push(e));
    expect(ends).toEqual(['done']);
    expect(r.slider.active).toBe(false);
    expect(r.st.top).toBeCloseTo(250.2, 3);
  });

  it('目标超出滚动范围时被夹住，不卡住：目标函数给的是当前的最大值', () => {
    const r = rig(0, 300);
    r.slider.to(() => r.st.max, { kind: 'exp', tau: 40 });
    r.run(100);
    r.st.max = 600; // 内容变高了
    r.run(600);
    expect(r.st.top).toBe(600);
  });

  it('active：滑的途中为真，到位或放手后为假', () => {
    const r = rig(0);
    expect(r.slider.active).toBe(false);
    r.slider.to(500, { kind: 'exp', tau: 40 });
    expect(r.slider.active).toBe(true);
    expect(r.slider.target).toBe(500);
    r.run(1000);
    expect(r.slider.active).toBe(false);
    expect(r.slider.target).toBeNull();
  });
});

describe('Slider：passthrough（目标一直在长）', () => {
  it('目标每帧往下走一点（内容逐字长高）：开始时已有的差距按时间常数滑完，长高的部分原样跟上，滑动能结束', () => {
    const r = rig(0);
    let bottom = 200; // 新来的一条把底部推下去 200
    r.slider.to(() => bottom, { kind: 'exp', tau: 40, passthrough: true });
    const lag: number[] = [];
    let frames = 0;
    while (r.slider.active && frames < 200) {
      bottom += 3; // 每帧长 3 px
      r.run(1);
      frames++;
      if (r.slider.active) lag.push(bottom - r.st.top);
    }
    expect(r.slider.active).toBe(false);
    // 约 0.2 秒（144 Hz 下 30 帧左右）滑完，不是一直拖着
    expect(frames).toBeLessThan(45);
    expect(r.st.top).toBe(bottom);
    // 差距从 200 左右单调变小
    expect(lag[0]).toBeGreaterThan(150);
    for (let i = 1; i < lag.length; i++) expect(lag[i]).toBeLessThanOrEqual(lag[i - 1] + 1e-6);

    // 不带 passthrough 时，目标一直在长就永远追不上：差距稳定在 τ × 速度（每毫秒 0.43 px × 40 ms ≈ 17 px）左右，滑动停不下来
    const q = rig(0);
    let b2 = 200;
    q.slider.to(() => b2, { kind: 'exp', tau: 40 });
    for (let i = 0; i < 80; i++) {
      b2 += 3;
      q.run(1);
    }
    expect(q.slider.active).toBe(true);
    expect(b2 - q.st.top).toBeGreaterThan(12);
  });

  it('长高停了以后很快滑完，滑动结束', () => {
    const r = rig(0);
    let bottom = 100;
    const ends: EndReason[] = [];
    r.slider.to(
      () => bottom,
      { kind: 'exp', tau: 40, passthrough: true },
      (e) => ends.push(e),
    );
    for (let i = 0; i < 20; i++) {
      bottom += 2;
      r.run(1);
    }
    r.run(500);
    expect(r.st.top).toBe(bottom);
    expect(ends).toEqual(['done']);
  });

  it('sync：同一帧里目标变了，马上写进位置，不等下一帧', () => {
    const r = rig(0);
    let bottom = 100;
    r.slider.to(() => bottom, { kind: 'exp', tau: 40, passthrough: true });
    r.run(50);
    const before = r.st.top;
    bottom += 30;
    r.slider.sync();
    expect(r.st.top).toBeCloseTo(before + 30, 6);
    // 没在滑时什么也不做
    const q = rig(5);
    q.slider.sync();
    expect(q.st.top).toBe(5);
  });

  it('别处也写了 scrollTop（被夹住、别的代码在写）：差按原样算进位置，不被旧的内部位置盖回去', () => {
    const r = rig(0);
    r.slider.to(2000, { kind: 'exp', tau: 200 });
    r.run(30);
    r.st.top += 100; // 别处把位置往下挪了 100
    const before = r.st.top;
    r.run(7);
    expect(r.st.top).toBeGreaterThanOrEqual(before);
  });
});
