import { describe, expect, it } from 'vitest';
import { makeRandom, seededRandom } from './random';

describe('@luoli/ui/fx 在没有 DOM 的环境里', () => {
  it('能加载，导出的东西都在', async () => {
    expect(typeof window).toBe('undefined');
    const m = await import('./index');
    expect(Object.keys(m).sort()).toEqual(
      [
        'edgeRun',
        'fx',
        'hoverHandlers',
        'makeRandom',
        'particleMessage',
        'seededRandom',
        'setHoverEffect',
        'sky',
      ].sort(),
    );
    expect(typeof m.sky.start).toBe('function');
    expect(typeof m.fx.start).toBe('function');
  });

  it('不认得的消息返回 false（不碰画布）', async () => {
    const { particleMessage } = await import('./index');
    expect(particleMessage({ type: 'bd-add' })).toBe(false);
    expect(particleMessage({ type: 'nothing' })).toBe(false);
  });

  it('没有启动时 sky、fx 的调用都什么也不做', async () => {
    const { sky, fx } = await import('./index');
    expect(() => {
      sky.size();
      sky.hold(true);
      sky.sync();
      fx.burst(1, 2);
      fx.scatter({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 });
    }).not.toThrow();
    await expect(
      fx.assemble({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }),
    ).resolves.toBeUndefined();
  });

  it('fx.onResize：size 时调用登记的函数，取消以后不再调', async () => {
    const { fx } = await import('./index');
    let n = 0;
    const off = fx.onResize(() => n++);
    fx.size();
    fx.size();
    off();
    fx.size();
    expect(n).toBe(2);
  });
});

describe('固定种子的随机数', () => {
  it('同一个种子永远是同一个序列，值在 [0, 1) 里', () => {
    const a = seededRandom(1),
      b = seededRandom(1);
    for (let i = 0; i < 2000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('前几个值固定下来（mulberry32，种子 1）：对照的人照这个公式写就能得到同一个序列', () => {
    const r = seededRandom(1);
    expect([r(), r(), r()].map((x) => x.toFixed(10))).toEqual([
      '0.6270739406',
      '0.0027357212',
      '0.5274470400',
    ]);
  });
  it('不同的种子是不同的序列', () => {
    const a = seededRandom(1),
      b = seededRandom(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });
  it('makeRandom：不给种子每次现取 Math.random，给了种子就是固定序列', () => {
    const real = Math.random;
    try {
      const un = makeRandom();
      Math.random = () => 0.25;
      expect(un()).toBe(0.25); // 和直接写 Math.random() 一样，每次调用时才取
      const s = makeRandom(7),
        t = seededRandom(7);
      expect([s(), s()]).toEqual([t(), t()]);
    } finally {
      Math.random = real;
    }
  });
});
