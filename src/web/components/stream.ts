import { motionOn } from '../lib/prefs';
import { chars } from '../lib/util';
import { hlTokens } from './Hl';
import { STAR_PATH } from './icons';

/* 终端里洛璃的回复逐字落下：命令式的小岛，React 不碰它里面的节点。
   字用 Web Animations 落下，不用 CSS 动画：WAAPI 的动画属于元素本身，元素被搬进别的外层 span 时接着原来的进度播，不会从头再落一次。
   高亮按词元加：每个词元一个外层 span（@提及是一整块圆角底），字仍各自落下；只重排词元变了的那一段，被搬动的字的落下动画不受影响。 */
const STAR_SVG = `<svg class="st4" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false"><path d="${STAR_PATH}"/></svg>`;
type CharNode = (HTMLSpanElement | Text) & { _drop?: number; _placed?: boolean };
interface Tk {
  wrap: HTMLElement;
  cls: string;
  count: number;
}
export class StreamText {
  nodes: CharNode[] = [];
  toks: Tk[] = [];
  cur: HTMLElement;
  constructor(
    public el: HTMLElement,
    text: string,
    convId: string,
  ) {
    this.cur = document.createElement('span');
    this.cur.className = 'cur';
    this.cur.dataset.conv = convId;
    this.cur.setAttribute('aria-hidden', 'true');
    this.cur.innerHTML = STAR_SVG;
    el.append(this.cur);
    this.nodes = chars(text).map((c) => this.charNode(c, false));
    this.regroup(text);
  }
  private charNode(c: string, anim: boolean, delay = 0): CharNode {
    if (c === ' ' || c === '\n') return document.createTextNode(' ');
    const s = document.createElement('span') as HTMLSpanElement & {
      _drop?: number;
      _placed?: boolean;
    };
    s.className = 'ch is-waapi';
    s.textContent = c;
    if (anim) s._drop = delay;
    return s;
  }
  private drop(nd: HTMLElement & { _drop?: number }) {
    nd.animate(
      [
        { transform: 'translateY(-8px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 300, delay: nd._drop, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
    );
  }
  /* 收到新的片段：几个字按到达顺序每个晚 28 ms 开始落下 */
  delta(chunk: string, fullText: string) {
    let k = 0;
    for (const c of chars(chunk)) this.nodes.push(this.charNode(c, motionOn(), k++ * 28));
    this.regroup(fullText);
  }
  private regroup(text: string) {
    const nodes = this.nodes,
      old = this.toks;
    const nt = hlTokens(text, false).map((t) => ({ cls: t.c, count: chars(t.t).length }));
    let j = 0;
    while (
      j < old.length &&
      j < nt.length &&
      old[j].cls === nt[j].cls &&
      old[j].count === nt[j].count
    )
      j++;
    const grow =
      j === old.length - 1 &&
      j < nt.length &&
      old[j].cls === nt[j].cls &&
      nt[j].count > old[j].count;
    const keep = grow ? j + 1 : j;
    for (let k = keep; k < old.length; k++) old[k].wrap.remove();
    const toks = old.slice(0, keep);
    let idx = toks.reduce((a, t) => a + t.count, 0);
    const put = (w: HTMLElement, nd?: CharNode) => {
      if (!nd) return;
      w.appendChild(nd);
      if (nd.nodeType === 1 && nd._drop != null && !nd._placed) this.drop(nd as HTMLElement);
      nd._placed = true;
    };
    if (grow) {
      const t = toks[j];
      for (let q = t.count; q < nt[j].count; q++) put(t.wrap, nodes[idx++]);
      t.count = nt[j].count;
    }
    for (let k = keep; k < nt.length; k++) {
      const w = document.createElement('span');
      w.className = 'tk' + (nt[k].cls ? ' ' + nt[k].cls : '');
      for (let q = 0; q < nt[k].count; q++) put(w, nodes[idx++]);
      this.el.insertBefore(w, this.cur);
      toks.push({ wrap: w, cls: nt[k].cls, count: nt[k].count });
    }
    this.toks = toks;
  }
  /* 回复出完后光标再停一会儿，淡出消失；之后由调用方换成静态的高亮文字 */
  finish(lingerMs: number, fadeMs: number, done: () => void) {
    const t1 = setTimeout(() => {
      if (!this.cur.isConnected) return;
      this.cur.classList.add('is-gone');
      setTimeout(() => {
        this.cur.remove();
        done();
      }, fadeMs);
    }, lingerMs);
    return () => clearTimeout(t1);
  }
}
export { STAR_SVG };
