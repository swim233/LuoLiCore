import { clamp } from './util';

/* 帧率显示：演示控制里的开关，默认关。关着的时候没有 rAF、没有元素、没有监听，不产生任何开销。
   打开后在左下角显示当前帧率，和最近一次转场（全屏进出、切换、缩略 ↔ 普通的形变）里的最长帧、掉帧数。
   量的是 requestAnimationFrame 的间隔，也就是页面实际出帧的节奏：高刷屏上应接近 144 或 165，无头 Chrome（锁 60 Hz）里约 60。
   掉帧数：每个间隔里错过的刷新周期之和（间隔超过 1.5 个周期才算）；刷新周期取平时帧间隔的中位数。 */
let on = false,
  el: HTMLElement | null = null,
  raf = 0,
  last = 0,
  depth = 0,
  winT = 0,
  winN = 0;
let tr: { max: number; dropped: number } | null = null;
let res: { max: number; dropped: number } | null = null;
const idle: number[] = [];
let period = 16.7;
const median = (a: number[]) => {
  const b = a.slice().sort((x, y) => x - y);
  return b[b.length >> 1];
};
function paint(fps: number | string) {
  if (!el) return;
  const t = res ? `转场 最长帧 ${res.max.toFixed(1)} ms · 掉帧 ${res.dropped}` : '转场 —';
  el.textContent = `${fps} fps\n${t}`;
}
function loop(t: number) {
  raf = requestAnimationFrame(loop);
  if (last) {
    const d = t - last;
    if (d < 1000) {
      if (tr) {
        tr.max = Math.max(tr.max, d);
        if (d > period * 1.5) tr.dropped += Math.max(1, Math.round(d / period) - 1);
      } else {
        idle.push(d);
        if (idle.length > 90) idle.shift();
        if (idle.length >= 20) period = clamp(median(idle), 4, 34);
      }
    }
  }
  last = t;
  winN++;
  if (!winT) winT = t;
  if (t - winT >= 500) {
    paint(Math.round((winN * 1000) / (t - winT)));
    winT = t;
    winN = 0;
  }
}
export const fpsMeter = {
  set(v: boolean) {
    if (v === on) return;
    on = v;
    if (on) {
      el = document.createElement('div');
      el.className = 'fps';
      el.setAttribute('aria-hidden', 'true');
      el.title = '帧率、最近一次转场的最长帧和掉帧数（错过的刷新周期）';
      document.body.append(el);
      last = 0;
      winT = 0;
      winN = 0;
      paint('--');
      raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(raf);
      raf = 0;
      depth = 0;
      tr = null;
      el?.remove();
      el = null;
    }
  },
  /* 转场开始、结束（可以嵌套：几个部件同时形变算一次） */
  begin() {
    if (!on) return;
    if (!depth++) tr = { max: 0, dropped: 0 };
  },
  end() {
    if (!on || !depth) return;
    if (!--depth) {
      res = tr;
      tr = null;
      paint(winN ? Math.round((winN * 1000) / Math.max(1, performance.now() - winT)) : '--');
    }
  },
};
