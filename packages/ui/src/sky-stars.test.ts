import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKY_DOTS, SKY_H, SKY_TILES, SKY_W } from './sky-stars';

/* 没有 DOM 的环境里能 import（上面这行能过就说明加载时不碰 DOM）。画的部分用假的 document、window、canvas 看它写了什么 */
afterEach(() => vi.unstubAllGlobals());

/* 每个用例一份新的模块（画过没有、DPR 记在模块里） */
async function load() {
  vi.resetModules();
  return (await import('./sky-stars')).startSkyStars;
}

function fakeBrowser(dpr: number) {
  const canvases: { width: number; height: number }[] = [];
  const styles: { id: string; textContent: string }[] = [];
  const listeners: (() => void)[] = [];
  const g = {
    scale() {},
    beginPath() {},
    arc() {},
    fill() {},
    fillStyle: '',
    globalAlpha: 1,
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const c = {
          width: 0,
          height: 0,
          getContext: () => g,
          toDataURL: () => 'data:image/png;base64,AAAA',
        };
        canvases.push(c);
        return c;
      }
      const s = { id: '', textContent: '' };
      styles.push(s);
      return s;
    },
    head: { append() {} },
  });
  const win = {
    devicePixelRatio: dpr,
    matchMedia: () => ({ addEventListener: (_: string, fn: () => void) => listeners.push(fn) }),
  };
  vi.stubGlobal('window', win);
  return { canvases, styles, listeners, win };
}

describe('星点', () => {
  it('固定的种子：每次都是同样的 170 颗，都在画布里，九成是小星', () => {
    expect(SKY_DOTS).toHaveLength(170);
    for (const d of SKY_DOTS) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThan(SKY_W);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThan(SKY_H);
      expect(d.a).toBeGreaterThanOrEqual(0.25);
      expect(d.a).toBeLessThanOrEqual(0.85);
    }
    const small = SKY_DOTS.filter((d) => d.r <= 1.2).length;
    expect(small / SKY_DOTS.length).toBeGreaterThan(0.8);
  });
  it('两层贴图的变量名、大小、起点', () => {
    expect(SKY_TILES.map((t) => [...t])).toEqual([
      ['--ll-sky-stars-a', 640, 390, -40, -30],
      ['--ll-sky-stars-b', 900, 548, -200, -90],
    ]);
  });
});

describe('startSkyStars', () => {
  it('按 devicePixelRatio 画两张贴图，写进 :root 的两个变量（data: 地址）', async () => {
    const b = fakeBrowser(2);
    const startSkyStars = await load();
    startSkyStars();
    expect(b.canvases.map((c) => [c.width, c.height])).toEqual([
      [1280, 780],
      [1800, 1096],
    ]);
    expect(b.styles).toHaveLength(1);
    expect(b.styles[0].id).toBe('ll-sky-stars');
    expect(b.styles[0].textContent).toBe(
      ':root{--ll-sky-stars-a:url(data:image/png;base64,AAAA);--ll-sky-stars-b:url(data:image/png;base64,AAAA)}',
    );
  });
  it('DPR 没变不重画；DPR 变了（缩放、换屏幕）收到通知后重画', async () => {
    const b = fakeBrowser(1);
    const startSkyStars = await load();
    startSkyStars();
    expect(b.canvases).toHaveLength(2);
    startSkyStars();
    expect(b.canvases).toHaveLength(2);
    b.win.devicePixelRatio = 1.25;
    b.listeners[0]();
    await Promise.resolve();
    expect(b.canvases).toHaveLength(4);
    expect(b.canvases[2].width).toBe(800);
    expect(b.styles).toHaveLength(1);
  });
});
