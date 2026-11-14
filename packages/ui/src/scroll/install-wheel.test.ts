import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickScroller } from './install-wheel';

/* 假的节点：只有 pickScroller 用到的那几样（标签、父节点、closest、scrollHeight 等、算出的样式）。
   找滚动区的规则不碰真 DOM 的别的东西，所以不用浏览器也能试 */
interface Fake {
  tagName: string;
  parentElement: Fake | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  native?: boolean;
  isConnected: boolean;
  cs: { overflowY: string; overscrollBehaviorY: string };
  closest(sel: string): Fake | null;
  contains(o: unknown): boolean;
}
const node = (
  tag: string,
  parent: Fake | null,
  o: Partial<{
    overflowY: string;
    overscroll: string;
    sh: number;
    ch: number;
    top: number;
    native: boolean;
  }> = {},
): Fake => {
  const n: Fake = {
    tagName: tag.toUpperCase(),
    parentElement: parent,
    scrollHeight: o.sh ?? 100,
    clientHeight: o.ch ?? 100,
    scrollTop: o.top ?? 0,
    native: o.native,
    isConnected: true,
    cs: { overflowY: o.overflowY ?? 'visible', overscrollBehaviorY: o.overscroll ?? 'auto' },
    closest(sel: string) {
      if (sel !== '[data-native-wheel]') throw new Error('不认识的选择器 ' + sel);
      for (let e: Fake | null = n; e; e = e.parentElement) if (e.native) return e;
      return null;
    },
    contains(x: unknown) {
      for (let e = x as Fake | null; e; e = e.parentElement) if (e === n) return true;
      return false;
    },
  };
  return n;
};

const g = globalThis as unknown as Record<string, unknown>;
let html: Fake, body: Fake;
beforeEach(() => {
  html = node('html', null, { overflowY: 'visible', sh: 3000, ch: 900 });
  body = node('body', html);
  g.document = { body, documentElement: html, scrollingElement: html };
  g.getComputedStyle = (el: Fake) => el.cs;
});
afterEach(() => {
  delete g.document;
  delete g.getComputedStyle;
});
const pick = (t: Fake, dir: 1 | -1 = 1) => pickScroller(t as unknown as Element, dir, 0);
const same = (a: unknown, b: Fake | null) => expect(a === b).toBe(true);

describe('找滚动区', () => {
  it('从目标往外找第一个 overflow-y 是 auto、内容真的超出的元素', () => {
    const pane = node('div', body, { overflowY: 'auto', sh: 800, ch: 300, overscroll: 'contain' });
    const row = node('div', pane);
    const text = node('span', row);
    same(pick(text), pane);
  });
  it('内容放得下的 auto 不算，接着往外找', () => {
    const outer = node('div', body, { overflowY: 'auto', sh: 800, ch: 300 });
    const inner = node('div', outer, { overflowY: 'auto', sh: 100, ch: 100 });
    same(pick(node('span', inner)), outer);
  });
  it('带 data-native-wheel 的里面不接管', () => {
    const pane = node('div', body, { overflowY: 'auto', sh: 800, ch: 300 });
    const atts = node('div', pane, { native: true });
    expect(pick(node('img', atts))).toBeNull();
  });
  it('输入框自己能滚的，整个交给浏览器；放得下的就接着往外找', () => {
    const pane = node('div', body, { overflowY: 'auto', sh: 800, ch: 300 });
    const tall = node('textarea', pane, { overflowY: 'auto', sh: 400, ch: 100 });
    expect(pick(tall)).toBeNull();
    const short = node('textarea', pane, { overflowY: 'auto', sh: 100, ch: 100 });
    same(pick(short), pane);
  });
  it('滚到头了：设了 contain 的停在这里（吞掉），没设的接着找外面一层', () => {
    const outer = node('div', body, { overflowY: 'auto', sh: 800, ch: 300 });
    const contained = node('div', outer, {
      overflowY: 'auto',
      sh: 500,
      ch: 100,
      top: 400,
      overscroll: 'contain',
    });
    same(pick(node('p', contained), 1), contained);
    const loose = node('div', outer, { overflowY: 'auto', sh: 500, ch: 100, top: 400 });
    same(pick(node('p', loose), 1), outer);
    // 反方向还能滚：照常是它自己
    same(pick(node('p', loose), -1), loose);
  });
  it('找到页面根：用 document.scrollingElement；全屏锁了滚动（overflow-y hidden）就不算', () => {
    const lonely = node('div', body);
    same(pick(lonely), html);
    html.cs.overflowY = 'hidden';
    expect(pick(lonely)).toBeNull();
  });
  it('overflow: hidden 又设了 contain 的：浏览器什么也不滚，交给浏览器', () => {
    const lid = node('div', body, { overflowY: 'hidden', overscroll: 'contain' });
    expect(pick(node('p', lid))).toBeNull();
  });
  it('横着滚的（没有可滚的竖向内容）不算，滚的是外面那个竖向的', () => {
    const pane = node('div', body, { overflowY: 'auto', sh: 800, ch: 300 });
    const code = node('pre', pane, { overflowY: 'auto', sh: 20, ch: 20 });
    same(pick(node('code', code)), pane);
  });
});
