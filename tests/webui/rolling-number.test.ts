import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import UiRollingNumber from '../../packages/webui/src/ui/UiRollingNumber.vue';

let nextFrameId = 0;
let frames = new Map<number, FrameRequestCallback>();
let nowSpy: ReturnType<typeof vi.spyOn>;

function motionPreference(reduced: boolean): MediaQueryList {
  return {
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

async function advance(at: number): Promise<void> {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(at);
  await Promise.resolve();
}

describe('UiRollingNumber', () => {
  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    vi.stubGlobal('matchMedia', vi.fn(() => motionPreference(false)));
    nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('就绪后按非线性 ease-out 从 0 增长到目标值', async () => {
    const wrapper = mount(UiRollingNumber, { props: { value: 100, ready: false, duration: 1000 } });
    expect(wrapper.attributes('data-current-value')).toBe('0');

    await wrapper.setProps({ ready: true });
    await advance(0);
    await advance(250);
    const quarter = Number(wrapper.attributes('data-current-value'));
    expect(quarter).toBeGreaterThan(25);
    expect(quarter).toBeLessThan(100);

    await advance(1000);
    expect(wrapper.attributes('data-current-value')).toBe('100');
    expect(wrapper.findAll('.rolling-digit')).toHaveLength(3);
    wrapper.unmount();
  });

  it('首轮结束后的数据变化直接更新，不重复从零播放', async () => {
    const wrapper = mount(UiRollingNumber, { props: { value: 12, ready: true, animate: false } });
    expect(wrapper.attributes('data-current-value')).toBe('12');
    await wrapper.setProps({ value: 38 });
    expect(wrapper.attributes('data-current-value')).toBe('38');
    expect(frames.size).toBe(0);
    wrapper.unmount();
  });

  it('减少动态效果时直接显示最终数值', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => motionPreference(true)));
    const wrapper = mount(UiRollingNumber, { props: { value: 0.42, prefix: '$', fractionDigits: 4 } });
    expect(wrapper.attributes('data-current-value')).toBe('$0.4200');
    expect(frames.size).toBe(0);
    wrapper.unmount();
  });
});
