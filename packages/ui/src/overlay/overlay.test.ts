import { describe, expect, it } from 'vitest';

/* 入口加载时不碰 DOM：这里是 node 环境，没有 window、document。import 能成功、拿得到东西，就说明没碰。
   导出清单不写死：逐个看每个导出是组件（函数）、对象（Base UI 的部件、handle 的工厂函数……）还是别的，有没有 undefined */
describe('@luoli/ui/overlay 在没有 DOM 的环境里', () => {
  it('能加载，导出的都不是 undefined', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const m = await import('./index');
    const entries = Object.entries(m);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, v] of entries) {
      expect(['function', 'object'], `${name} 是 ${typeof v}`).toContain(typeof v);
      expect(v, name).not.toBeNull();
    }
  });
  it('toast() 在没有 Toaster、没有 DOM 时也能调：返回 id、不抛错', async () => {
    const { toast } = await import('./index');
    const a = toast('一句话');
    const b = toast('另一句', { tone: 'danger', title: '标题', duration: 0 });
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
    expect(() => toast.dismiss(a)).not.toThrow();
    expect(() => toast.dismiss()).not.toThrow();
  });
  it('toast() 给了 id 就用这个 id（原地更新靠它）', async () => {
    const { toast } = await import('./index');
    expect(toast('第一次', { id: 'same' })).toBe('same');
    expect(toast('第二次', { id: 'same' })).toBe('same');
    toast.dismiss();
  });
});
