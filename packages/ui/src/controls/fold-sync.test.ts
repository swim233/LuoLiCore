import { describe, expect, it } from 'vitest';
import { syncOpen } from './fold-sync';

describe('折叠的开合和浏览器自己的开合对上', () => {
  it('DOM 和记着的一样：什么都不做（自己点头开合以后浏览器发的 toggle 就是这种）', () => {
    expect(syncOpen({ dom: true, now: true, controlled: false })).toEqual({});
    expect(syncOpen({ dom: false, now: false, controlled: true })).toEqual({});
  });

  it('不受控：查找命中把收着的打开了 → 记着的跟着改成开，并通知一次', () => {
    expect(syncOpen({ dom: true, now: false, controlled: false })).toEqual({
      adopt: true,
      notify: true,
    });
  });

  it('不受控：开着的被外面关了 → 记着的跟着改成关，并通知一次', () => {
    expect(syncOpen({ dom: false, now: true, controlled: false })).toEqual({
      adopt: false,
      notify: false,
    });
  });

  it('受控：只通知，不自己改；用的地方没跟着改就要把 DOM 改回去（下一帧再看）', () => {
    expect(syncOpen({ dom: true, now: false, controlled: true })).toEqual({
      notify: true,
      revertIfUnchanged: true,
    });
    expect(syncOpen({ dom: false, now: true, controlled: true })).toEqual({
      notify: false,
      revertIfUnchanged: true,
    });
  });
});
