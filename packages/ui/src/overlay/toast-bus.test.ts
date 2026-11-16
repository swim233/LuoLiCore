import { describe, expect, it } from 'vitest';
import { MAX_PENDING, createToastBus } from './toast-bus';
import type { ToastCommand } from './toast-bus';

/* toast 的指令缓冲：纯逻辑，不碰 DOM。试的是「没人接着时存着、有人接上时补发」的各种情况 */
const put = (id: string, item = id): ToastCommand<string> => ({ type: 'put', id, item });
const close = (id?: string): ToastCommand<string> => ({ type: 'close', id });

function setup() {
  const bus = createToastBus<string>();
  const got: ToastCommand<string>[] = [];
  const sink = (c: ToastCommand<string>) => void got.push(c);
  return { bus, got, sink };
}

describe('没人接着时：先存着', () => {
  it('接上以后按顺序补发，之后的直接送过去', () => {
    const { bus, got, sink } = setup();
    bus.post(put('a'));
    bus.post(put('b'));
    expect(got).toEqual([]);
    expect(bus.pending()).toBe(2);
    bus.attach(sink);
    expect(got.map((c) => c.type === 'put' && c.id)).toEqual(['a', 'b']);
    expect(bus.pending()).toBe(0);
    bus.post(put('c'));
    expect(got.map((c) => c.type === 'put' && c.id)).toEqual(['a', 'b', 'c']);
  });
  it('同一个 id 的 put 合并成一条：后面的盖前面的，位置不变', () => {
    const { bus, got, sink } = setup();
    bus.post(put('a', '一'));
    bus.post(put('b'));
    bus.post(put('a', '二'));
    expect(bus.pending()).toBe(2);
    bus.attach(sink);
    expect(got).toEqual([put('a', '二'), put('b')]);
  });
  it('close(id) 撤掉存着的同一个 id 的 put：没显示过的不用「先出现再消失」', () => {
    const { bus, got, sink } = setup();
    bus.post(put('a'));
    bus.post(put('b'));
    bus.post(close('a'));
    bus.attach(sink);
    expect(got).toEqual([put('b')]);
  });
  it('close(id) 对没存着的 id：不存，补发时也没有它', () => {
    const { bus, got, sink } = setup();
    bus.post(close('nobody'));
    expect(bus.pending()).toBe(0);
    bus.attach(sink);
    expect(got).toEqual([]);
  });
  it('close() 不带 id：存着的全部清掉', () => {
    const { bus, got, sink } = setup();
    bus.post(put('a'));
    bus.post(put('b'));
    bus.post(close());
    expect(bus.pending()).toBe(0);
    bus.post(put('c'));
    bus.attach(sink);
    expect(got).toEqual([put('c')]);
  });
  it('存着的有上限：满了丢最旧的', () => {
    const { bus, got, sink } = setup();
    for (let i = 0; i < MAX_PENDING + 5; i++) bus.post(put(`t${i}`));
    expect(bus.pending()).toBe(MAX_PENDING);
    bus.attach(sink);
    expect(got).toHaveLength(MAX_PENDING);
    expect(got[0]).toEqual(put('t5'));
    expect(got.at(-1)).toEqual(put(`t${MAX_PENDING + 4}`));
  });
});

describe('有人接着时：直接送，不存', () => {
  it('put 和 close 都原样送给接着的人', () => {
    const { bus, got, sink } = setup();
    bus.attach(sink);
    bus.post(put('a'));
    bus.post(close('a'));
    bus.post(close());
    expect(got).toEqual([put('a'), close('a'), close()]);
    expect(bus.pending()).toBe(0);
  });
});

describe('接着的人走了（比如 Toaster 卸载）', () => {
  it('走了以后再来的又先存着，下一个接上的人补发', () => {
    const { bus, got, sink } = setup();
    const off = bus.attach(sink);
    bus.post(put('a'));
    off();
    bus.post(put('b'));
    expect(bus.pending()).toBe(1);
    const second: ToastCommand<string>[] = [];
    bus.attach((c) => void second.push(c));
    expect(second).toEqual([put('b')]);
    expect(got).toEqual([put('a')]);
  });
  it('旧的「不接了」函数在别人接上以后不会把新的接着的人撤掉', () => {
    const { bus, sink } = setup();
    const offFirst = bus.attach(sink);
    const second: ToastCommand<string>[] = [];
    bus.attach((c) => void second.push(c));
    offFirst();
    bus.post(put('x'));
    expect(second).toEqual([put('x')]);
    expect(bus.pending()).toBe(0);
  });
  it('同时有两个人接着：指令送给后接上的，后接上的先走，先接上的接着收，不会存着不送', () => {
    const { bus, got, sink } = setup();
    bus.attach(sink);
    const second: ToastCommand<string>[] = [];
    const offSecond = bus.attach((c) => void second.push(c));
    bus.post(put('x'));
    expect(second).toEqual([put('x')]);
    offSecond();
    bus.post(put('y'));
    expect(got).toEqual([put('y')]);
    expect(bus.pending()).toBe(0);
  });
  it('同一个函数接了两次：撤掉一次，另一次还接着', () => {
    const { bus, got, sink } = setup();
    const offA = bus.attach(sink);
    const offB = bus.attach(sink);
    offA();
    bus.post(put('x'));
    expect(got).toEqual([put('x')]);
    offB();
    bus.post(put('y'));
    expect(bus.pending()).toBe(1);
  });
  it('补发的时候接着的人又发了新的：直接送过去，不丢', () => {
    const bus = createToastBus<string>();
    const seen: string[] = [];
    bus.post(put('a'));
    bus.attach((c) => {
      if (c.type === 'put') {
        seen.push(c.id);
        if (c.id === 'a') bus.post(put('later'));
      }
    });
    expect(seen).toEqual(['a', 'later']);
  });
});
