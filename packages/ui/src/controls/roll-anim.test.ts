import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLL_HOLD_MS, ROLL_MS, rollTo, rollValue, runRoll } from './roll-anim';
import type { RollNode } from './roll-anim';

/* 数字滚动的动画：用假的计时器和假的节点（不需要 DOM）走一遍 */
function fakeNode() {
  const attrs = new Set<string>();
  const node: RollNode & { attrs: Set<string> } = {
    textContent: '',
    attrs,
    setAttribute: (n) => void attrs.add(n),
    removeAttribute: (n) => void attrs.delete(n),
  };
  return node;
}
const fmt = (n: number) => String(Math.round(n));

beforeEach(() => {
  /* node 里没有 requestAnimationFrame：用 16 毫秒的计时器顶（时间戳取假的 performance.now），和浏览器里一帧一帧的样子一样 */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) =>
    setTimeout(() => fn(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('rollValue', () => {
  it('起点是 from，终点是 to，中间走的是 EASE_OUT（起步快）', () => {
    expect(rollValue(0, 100, 0)).toBe(0);
    expect(rollValue(0, 100, ROLL_MS)).toBe(100);
    expect(rollValue(0, 100, ROLL_MS / 2)).toBeGreaterThan(90);
    expect(rollValue(100, 0, ROLL_MS / 2)).toBeLessThan(10);
  });
});

describe('runRoll', () => {
  it('滚动期间根上有 data-rolling，一路走到终点，结束半秒后去掉；每帧都有 onValue', () => {
    const node = fakeNode();
    const seen: number[] = [];
    runRoll(node, 0, 1000, fmt, (n) => seen.push(n));
    expect(node.attrs.has('data-rolling')).toBe(true);
    vi.advanceTimersByTime(ROLL_MS / 2);
    expect(node.attrs.has('data-rolling')).toBe(true);
    const mid = Number(node.textContent);
    expect(mid).toBeGreaterThan(500);
    expect(mid).toBeLessThan(1000);
    vi.advanceTimersByTime(ROLL_MS);
    expect(node.textContent).toBe('1000');
    expect(seen.at(-1)).toBe(1000);
    expect(node.attrs.has('data-rolling')).toBe(true);
    vi.advanceTimersByTime(ROLL_HOLD_MS + 10);
    expect(node.attrs.has('data-rolling')).toBe(false);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
  it('往小滚也行：从大数一路降到小数', () => {
    const node = fakeNode();
    runRoll(node, 500, 0, fmt, () => {});
    vi.advanceTimersByTime(ROLL_MS + 50);
    expect(node.textContent).toBe('0');
  });
  it('停掉：不再写字，也不去掉 data-rolling 的收尾计时（下一次滚动自己接着管）', () => {
    const node = fakeNode();
    const stop = runRoll(node, 0, 1000, fmt, () => {});
    vi.advanceTimersByTime(300);
    const frozen = node.textContent;
    stop();
    vi.advanceTimersByTime(ROLL_MS * 2);
    expect(node.textContent).toBe(frozen);
    expect(node.attrs.has('data-rolling')).toBe(true);
  });
  it('停在收尾的半秒里：收尾计时取消，不会去掉后面接着滚的那一次加上的 data-rolling', () => {
    const node = fakeNode();
    const stop = runRoll(node, 0, 10, fmt, () => {});
    vi.advanceTimersByTime(ROLL_MS + 50);
    stop();
    vi.advanceTimersByTime(ROLL_HOLD_MS * 2);
    expect(node.attrs.has('data-rolling')).toBe(true);
  });
  it('中途换值：从停下的那个数接着滚（调用方用 onValue 记着当前数）', () => {
    const node = fakeNode();
    let cur = 0;
    const stop = runRoll(node, 0, 1000, fmt, (n) => (cur = n));
    vi.advanceTimersByTime(200);
    stop();
    const from = cur;
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThan(1000);
    runRoll(node, from, 0, fmt, (n) => (cur = n));
    vi.advanceTimersByTime(ROLL_MS + 50);
    expect(cur).toBe(0);
    expect(node.textContent).toBe('0');
  });
});

describe('rollTo', () => {
  it('动画开着、值变了：滚过去（和 runRoll 一样），返回停掉的函数', () => {
    const node = fakeNode();
    const stop = rollTo(node, 0, 1000, fmt, true, () => {});
    expect(stop).toBeTypeOf('function');
    expect(node.attrs.has('data-rolling')).toBe(true);
    vi.advanceTimersByTime(ROLL_MS + 50);
    expect(node.textContent).toBe('1000');
  });
  it('动画关着：直接到新值，没有 data-rolling，没有计时器', () => {
    const node = fakeNode();
    node.attrs.add('data-rolling');
    let cur = 0;
    const stop = rollTo(node, 0, 1000, fmt, false, (n) => (cur = n));
    expect(stop).toBeUndefined();
    expect(node.textContent).toBe('1000');
    expect(cur).toBe(1000);
    expect(node.attrs.has('data-rolling')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('赶在第一帧之前又变回显示着的数（0→100→0）：前一次停掉，这一次不滚，data-rolling 不留下', () => {
    const node = fakeNode();
    node.textContent = '0';
    let cur = 0;
    const stopFirst = runRoll(node, 0, 100, fmt, (n) => (cur = n)); // 0→100 开始，一帧还没走
    expect(node.attrs.has('data-rolling')).toBe(true);
    stopFirst(); // effect 的清理
    const stop = rollTo(node, cur, 0, fmt, true, (n) => (cur = n)); // 值变回 0
    expect(stop).toBeUndefined();
    expect(node.attrs.has('data-rolling')).toBe(false);
    expect(node.textContent).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ROLL_MS * 2);
    expect(node.textContent).toBe('0');
  });
});
