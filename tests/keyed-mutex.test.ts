import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '@luoli/core';

/**
 * `KeyedMutex` 的键空间由调用方决定，而 `AcpManager` 是第一个把**模型选的路径**当键的调用方
 * （`dir:<realpath>`）。所以「用完之后条目要回收」从一条洁癖变成了一条真约束：不回收的话，
 * 模型每换一个目录就在 map 里多留一条，进程生命周期内只增不减。
 *
 * 互斥本身此前一直是对的（`get` 到的始终是真尾巴），坏的只有回收 —— 这也是它能长期不被发现的原因。
 */
describe('KeyedMutex', () => {
  it('同一个键跑完之后 map 里不再留条目', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('dir:/srv/app', async () => 'done');
    // 存进 map 的曾经是 `previous.then(() => current)` 而 `finally` 比的是 `current` ——
    // 两者永远不相等，于是这一条断言在修复前恒假。
    expect(mutex.pending('dir:/srv/app')).toBe(false);
  });

  it('串行执行：同一个键上的两次调用不重叠', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = mutex.run('k', async () => {
      order.push('first:in');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first:out');
    });
    const second = mutex.run('k', async () => { order.push('second:in'); });
    await Promise.all([first, second]);
    expect(order).toEqual(['first:in', 'first:out', 'second:in']);
    expect(mutex.pending('k')).toBe(false);
  });

  it('不同键之间不互斥', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0, peak = 0;
    const enter = async (): Promise<void> => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    };
    await Promise.all([mutex.run('a', enter), mutex.run('b', enter)]);
    expect(peak).toBe(2);
    expect(mutex.pending('a')).toBe(false);
    expect(mutex.pending('b')).toBe(false);
  });

  it('operation 抛异常时锁照旧释放、条目照旧回收', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(mutex.pending('k')).toBe(false);
    // 前一次抛了不该把这个键堵死。
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('后面还有人排队时不误删 —— 删的判据是「我是最后一个」', async () => {
    const mutex = new KeyedMutex();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = mutex.run('k', () => gate);
    const second = mutex.run('k', async () => 'second');
    // 第一个还占着、第二个在排队：这一刻条目必须在，否则第三个调用会与第二个并行跑。
    expect(mutex.pending('k')).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
    expect(mutex.pending('k')).toBe(false);
  });
});
