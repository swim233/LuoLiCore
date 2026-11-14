import { describe, expect, it } from 'vitest';

/* 入口加载时不碰 DOM：这里是 node 环境，没有 window、document。import 能成功、拿得到东西，就说明没碰 */
describe('@luoli/ui/scroll 在没有 DOM 的环境里', () => {
  it('能加载', async () => {
    expect(typeof window).toBe('undefined');
    const m = await import('./index');
    expect(typeof m.Pane).toBe('function');
    expect(typeof m.VirtualLog).toBe('function');
    expect(typeof m.useGlide).toBe('function');
    expect(typeof m.hideGlides).toBe('function');
    expect(typeof m.installWheel).toBe('function');
  });
  it('没有挂着的高亮时 hideGlides 什么也不做', async () => {
    const { hideGlides } = await import('./index');
    expect(() => hideGlides()).not.toThrow();
  });
  it('@luoli/ui/slide 也能加载', async () => {
    const m = await import('../slide');
    expect(typeof m.Slider).toBe('function');
  });
});
