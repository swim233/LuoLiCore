import { afterEach, describe, expect, it, vi } from 'vitest';

/* 偏好存在 localStorage 里的格式：改之前存下的照样读得出来；动画开关只有用户拨过才存，没拨过就跟随系统 */
const KEY = 'luoli-webui-demo-prefs-v2';

/* 每个用例一份新的模块（偏好和动画开关的状态都在模块里），localStorage 换成假的；
   没有 window，跟随系统时动画是开着的 */
async function load(stored?: object) {
  vi.resetModules();
  const map = new Map<string, string>();
  if (stored) map.set(KEY, JSON.stringify(stored));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  });
  const prefs = await import('./prefs');
  const motion = await import('@luoli/ui/motion');
  return { ...prefs, ...motion, saved: () => JSON.parse(map.get(KEY) ?? 'null') };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('偏好的读写', () => {
  it('读得出改之前存下的偏好，拨过的动画开关交给组件库', async () => {
    const p = await load({ hover: 'B', collapse: 5, autoNow: false, fps: true, motion: false });
    expect(p.prefs.get()).toEqual({ hover: 'B', collapse: 5, autoNow: false, fps: true });
    expect(p.getMotionMode()).toBe('off');
    expect(p.motionOn()).toBe(false);
    const q = await load({ hover: 'D', collapse: 30, autoNow: true, fps: false, motion: true });
    expect(q.getMotionMode()).toBe('on');
  });

  it('没存过动画开关时跟随系统', async () => {
    const p = await load({ hover: 'C', collapse: 30, autoNow: true, fps: false });
    expect(p.getMotionMode()).toBe('system');
    expect(p.motionOn()).toBe(true);
    const q = await load();
    expect(q.getMotionMode()).toBe('system');
    expect(q.prefs.get()).toEqual({ hover: 'C', collapse: 30, autoNow: true, fps: false });
  });

  it('改别的偏好时照原来的格式存，没拨过动画开关就不存这一项', async () => {
    const p = await load();
    p.setPrefs({ fps: true });
    expect(p.saved()).toEqual({ hover: 'C', collapse: 30, autoNow: true, fps: true });
  });

  it('拨动画开关时改组件库的开关并存下来，下次打开还记得', async () => {
    const p = await load({ hover: 'B', collapse: 5, autoNow: true, fps: false });
    const fn = vi.fn();
    p.subscribeMotion(fn);
    p.chooseMotion(false);
    expect(p.motionOn()).toBe(false);
    expect(fn).toHaveBeenCalled();
    const saved = p.saved();
    expect(saved).toEqual({ hover: 'B', collapse: 5, autoNow: true, fps: false, motion: false });
    p.setPrefs({ hover: 'D' });
    expect(p.saved().motion).toBe(false);
    const again = await load(p.saved());
    expect(again.motionOn()).toBe(false);
    expect(again.getMotionMode()).toBe('off');
  });
});
