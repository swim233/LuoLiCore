import { afterEach, describe, expect, it, vi } from 'vitest';

/* 假的「减少动态效果」媒体查询：set() 改它，改了发 change */
function fakeSystem(reduced: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: reduced,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  return {
    window: { matchMedia: () => mql },
    set(v: boolean) {
      mql.matches = v;
      listeners.forEach((f) => f());
    },
  };
}

/* 每个用例一份新的模块（开关的状态在模块里）；reduced 不给时没有 window，像 node 里 */
async function load(reduced?: boolean) {
  vi.resetModules();
  const sys = reduced === undefined ? null : fakeSystem(reduced);
  if (sys) vi.stubGlobal('window', sys.window);
  const m = await import('./motion');
  return { ...m, sys: sys! };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('动画开关', () => {
  it('默认跟随系统：系统没开「减少动态效果」时开着，开了时关着', async () => {
    const a = await load(false);
    expect(a.getMotionMode()).toBe('system');
    expect(a.motionOn()).toBe(true);
    const b = await load(true);
    expect(b.motionOn()).toBe(false);
  });

  it('跟随系统时，系统那边改了，读到的跟着变，订阅的人收到通知', async () => {
    const m = await load(false);
    const fn = vi.fn();
    m.subscribeMotion(fn);
    m.sys.set(true);
    expect(m.motionOn()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    m.sys.set(false);
    expect(m.motionOn()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('强制开、强制关不看系统，系统改了也不通知', async () => {
    const m = await load(true);
    m.setMotionMode('on');
    expect(m.motionOn()).toBe(true);
    const fn = vi.fn();
    m.subscribeMotion(fn);
    m.sys.set(false);
    m.sys.set(true);
    expect(fn).not.toHaveBeenCalled();
    expect(m.motionOn()).toBe(true);
    m.setMotionMode('off');
    m.sys.set(false);
    expect(m.motionOn()).toBe(false);
  });

  it('换回跟随系统后照系统的来', async () => {
    const m = await load(true);
    m.setMotionMode('on');
    m.setMotionMode('system');
    expect(m.getMotionMode()).toBe('system');
    expect(m.motionOn()).toBe(false);
  });

  it('换状态时通知订阅的人，换成同一种不通知，取消订阅后不再通知', async () => {
    const m = await load(false);
    const fn = vi.fn();
    const off = m.subscribeMotion(fn);
    m.setMotionMode('off');
    expect(fn).toHaveBeenCalledTimes(1);
    m.setMotionMode('off');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    m.setMotionMode('on');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('没有 window 时也能加载，跟随系统当作开着', async () => {
    const m = await load();
    expect(m.motionOn()).toBe(true);
    m.setMotionMode('off');
    expect(m.motionOn()).toBe(false);
  });
});
