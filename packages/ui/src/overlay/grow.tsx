import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { Chevron } from '../controls/Chevron';

/* 「长开」的内部零件（菜单和弹出框共用；不对外导出）。样子和原理见 grow.css，这里是要 JS 做的几件事：
   1. 下拉钮把自己的内容登记给同一个根（GrowFace），浮层里的头由库画，用的地方不用传两遍；
   2. 根（Menu、Popover）自己管着 open（受控、不受控都认），因为头要能点（点头相当于点钮：开着时关、关到一半时再开）；
   3. 浮层挂上之后：量一下钮和头的差（小数像素），量好、位置也到了的那一个 requestAnimationFrame 里，同时写 data-ready（浮层亮、开始长）和钮的 data-away（钮藏起来）——
      同一次提交，所以交接的那一帧不会钮和头都没有、或都在；关到最后浮层卸载时，在同一次提交里撤掉钮的 data-away；
   4. 鼠标此刻在不在钮上（data-hot）：面在 s=0 时要和钮此刻的样子（悬停的、平常的）一样。
   长开只支持「一个根里一个下拉钮」：头里画的、藏起来的都是那一个钮。一个根里登记了不止一个下拉钮（Base UI 的 Menu、Popover 允许多个触发按钮）时，这个根不长开，
   退回淡入加缩放（钮不藏、没有头），每个钮打开的浮层都在自己的位置上。登记的钮是几个随时在变：卸到只剩一个就恢复长开（triggerRef 跟着指到剩下的那个，开着时也一样），
   从一个变成两个就当场退回不长开（开着的浮层也是：钮的 data-away 当场撤掉）。 */
export type DropdownKind = 'pill' | 'slot';
/** 尺寸，和库的按钮 Button 的四档一样 */
export type DropdownSize = 'xs' | 'sm' | 'md' | 'lg';

/** 长开：弹出框的上边和钮的上边对齐（往上翻时下边对下边）：沿着主轴退一个钮高（给 Positioner 的 sideOffset） */
export const overlapAnchor = ({ anchor }: { anchor: { height: number } }) => -anchor.height;

/** 下拉钮登记给根的内容：样子、是不是只有图标、钮里的东西（头里再画一份） */
export interface GrowFace {
  kind: DropdownKind;
  size: DropdownSize;
  icon: boolean;
  node: ReactNode;
}
/** 登记在根里的一项：钮的内容加钮自己的元素（元素跟着内容一起登记、一起撤，根里只剩一个钮时 triggerRef 就指到它） */
interface GrowEntry extends GrowFace {
  el: RefObject<HTMLElement | null>;
}

interface GrowApi {
  /** 钮的元素（量位置、藏起来都用它）。只读，由根算出来：根里登记的下拉钮正好一个时是那个钮的元素，别的时候（没有、多于一个）是 null；
      因为长开只在「正好一个钮」时开，用它的地方（useGrowPopup）本来也只在那时起作用。不是各个钮抢着写的一个 ref：
      那样卸掉一个钮时它会把别的钮的位置写成 null（剩下的钮点开就是看不见的浮层）。不要往 current 里写 */
  triggerRef: RefObject<HTMLElement | null>;
  /** 一个下拉钮登记（key 是这个钮自己的，f 为 null 是撤掉）。根里登记了不止一个钮时不长开，见 useGrowRoot */
  setFace: (key: object, f: GrowEntry | null) => void;
  /** 点头：开着就关，关到一半就再开 */
  toggle: (e: Event) => void;
}
interface GrowLive {
  /** 能长开吗（根没有 handle、没有悬停打开等） */
  enabled: boolean;
  face: GrowFace | null;
  open: boolean;
}
const NO_API: GrowApi | null = null;
export const GrowApiCtx = createContext<GrowApi | null>(NO_API);
export const GrowLiveCtx = createContext<GrowLive>({
  enabled: false,
  face: null,
  open: false,
});

interface RootArgs<D> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: D) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  /** 能长开吗：不能时什么都不接管，原样给 Base UI */
  enabled: boolean;
  /** 开关变化先过一遍：返回 false 就拦下（这时守卫自己已经 details.cancel() 了），状态不动、也不通知 onOpenChange */
  guard?: (open: boolean, details: D) => boolean;
}

/** 根上的 open 状态（受控、不受控都认）。返回要给 Base UI 的 open、onOpenChange、onOpenChangeComplete，和要包在外面的 Provider 的值 */
export function useGrowRoot<D>({
  open: openProp,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  enabled,
  guard,
}: RootArgs<D>) {
  const [inner, setInner] = useState(!!defaultOpen);
  const open = openProp ?? inner;
  /* 登记着的下拉钮：一个根里只有一个时才长开（头和藏起来的钮都只认一个）；多于一个时 face 是 null，浮层退回淡入加缩放，钮不藏、没有头 */
  const facesRef = useRef<ReadonlyMap<object, GrowEntry>>(new Map());
  const [faces, setFaces] = useState(facesRef.current);
  const face = faces.size === 1 ? (faces.values().next().value ?? null) : null;
  /* triggerRef 读的是 facesRef（登记、撤掉的当下就变），不是上面的 state（要等下一次渲染）：
     卸掉一个钮的那次提交里，各处的清理函数、下一个 effect 马上就能读到剩下的那个钮 */
  const triggerRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        const m = facesRef.current;
        return m.size === 1 ? (m.values().next().value?.el.current ?? null) : null;
      },
    }),
    [],
  );
  const latest = useRef({ open, openProp, onOpenChange, guard });
  latest.current = { open, openProp, onOpenChange, guard };

  const change = useCallback((next: boolean, details: D) => {
    const { openProp: controlled, onOpenChange: cb, guard: block } = latest.current;
    if (block && block(next, details) === false) return;
    if (controlled === undefined) setInner(next);
    cb?.(next, details);
  }, []);
  const setFace = useCallback((key: object, f: GrowEntry | null) => {
    const prev = facesRef.current;
    const cur = prev.get(key) ?? null;
    if (
      cur === f ||
      (cur &&
        f &&
        cur.kind === f.kind &&
        cur.size === f.size &&
        cur.icon === f.icon &&
        cur.node === f.node &&
        cur.el === f.el)
    )
      return;
    const next = new Map(prev);
    if (f) next.set(key, f);
    else next.delete(key);
    facesRef.current = next;
    setFaces(next);
  }, []);
  const toggle = useCallback(
    (e: Event) => {
      /* 头不是 Base UI 的触发按钮，没有现成的变化详情：给一个最小的（原因当作按了触发按钮） */
      change(!latest.current.open, { reason: 'trigger-press', event: e } as D);
    },
    [change],
  );
  const api = useMemo<GrowApi>(() => ({ triggerRef, setFace, toggle }), [setFace, toggle]);
  const live = useMemo<GrowLive>(() => ({ enabled, face, open }), [enabled, face, open]);
  const passThrough = useCallback((next: boolean, details: D) => {
    const { onOpenChange: cb, guard: block } = latest.current;
    if (block && block(next, details) === false) return;
    cb?.(next, details);
  }, []);
  const rootProps = enabled
    ? { open, onOpenChange: change, onOpenChangeComplete }
    : { open: openProp, defaultOpen, onOpenChange: passThrough, onOpenChangeComplete };
  return { rootProps, api, live };
}

export function GrowProviders({
  root,
  children,
}: {
  root: { api: GrowApi; live: GrowLive };
  children: ReactNode;
}) {
  return (
    <GrowApiCtx.Provider value={root.api}>
      <GrowLiveCtx.Provider value={root.live}>{children}</GrowLiveCtx.Provider>
    </GrowApiCtx.Provider>
  );
}

/** 下拉钮挂上、内容变了就登记给根；卸载时撤掉。返回一个 ref 函数，钮要把它接到自己的元素上（元素和内容一起登记，根里只剩这一个钮时 triggerRef 指到它） */
export function useRegisterFace(face: GrowFace | null): (el: HTMLElement | null) => void {
  const api = useContext(GrowApiCtx);
  const [key] = useState(() => ({}));
  const elRef = useRef<HTMLElement | null>(null);
  const setEl = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);
  const kind = face?.kind;
  const size = face?.size;
  const icon = face?.icon;
  const node = face?.node;
  useLayoutEffect(() => {
    if (!api) return;
    api.setFace(
      key,
      kind === undefined || size === undefined
        ? null
        : { kind, size, icon: !!icon, node, el: elRef },
    );
  }, [api, key, kind, size, icon, node]);
  useLayoutEffect(() => {
    if (!api) return;
    return () => api.setFace(key, null);
  }, [api, key]);
  return setEl;
}

/** 钮里的东西：内容加小箭头。钮和浮层里的头都画这个（同一份节点的两个实例，所以钮的内容应当是不带自己状态的东西：字、图标） */
export function DropdownFace({ children }: { children?: ReactNode }) {
  return (
    <>
      <span className="ll-dd-main">{children}</span>
      <Chevron dir="down" className="ll-dd-chev" />
    </>
  );
}

/** 浮层里的头：钮那一行。head 给了就整个换成它（箭头也要自己画） */
export function GrowHead({ face, head }: { face: GrowFace; head?: ReactNode }) {
  const api = useContext(GrowApiCtx);
  return (
    <div
      className="ll-dd-head"
      data-kind={face.kind}
      data-size={face.size}
      data-icon={face.icon ? '' : undefined}
      aria-hidden="true"
      onClick={(e) => api?.toggle(e.nativeEvent)}
    >
      {head ?? <DropdownFace>{face.node}</DropdownFace>}
    </div>
  );
}

/** 算出来的 box-shadow 的第一个颜色（钮的细线画在 inset 阴影里）；没有阴影就是透明 */
function shadowColor(v: string): string {
  const m =
    /^(rgba?\([^)]*\)|color\([^)]*\)|hsla?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-fA-F]+)/.exec(
      v.trim(),
    );
  return m ? m[1] : 'transparent';
}

/* 头要补的位置差（头相对钮差多少，--ll-grow-dx、--ll-grow-dy）怎么取。
   版面用的单位是「1/64 个设备像素」（物理像素，不是 css 像素：缩放 125% 时一个单位是 0.0125 css 像素），位置都是这个单位的整数倍；头的位置 = 弹出框自己的位置
   （Base UI 取整到设备像素）+ 头自己的 left、top。所以：把钮和头的字的位置都换成这个单位的整数，补的差就取它们的差（整数个单位），头的字就正好落在钮的字的位置上。
   以前补的差是任意小数，版面又按零的方向舍到格子里，差了零点几个单位，字就差了一点点；字形是按格子画的（横向 1/4 设备像素一格，竖向一设备像素一格），
   钮的字正好落在两格的分界上时（缩放 125%、钮的 x 是 42.5，字的起点在 53.125 个设备像素上，是 1/4 格的分界），差的那一点点把头的字推到另一格，
   交接那一帧字就抖 1/4 个设备像素（实测 125% 缩放下一个周期 256 个位置里有 9 个会抖）；
   弹出框自己不写 will-change: transform（Base UI 只在缩放 150% 以上自己写）：试过在 100% 到 150% 之间让它成一层，页面级的弹出框用不着（字按格子取整以后，
   125%、110%、90% 下扫过一整个周期的位置，交接那一帧没有一个抖），放在别的元素里（container）、那个元素又落在小数设备像素上时反而会抖：弹出框成了一层，
   这一层的原点取整到整数设备像素，里面的头的字就和那个元素那一层里钮的字差了零点几个设备像素（实测交接那一帧整行字差 1 个设备像素）。
   长度写成 css 时多加（负数多减）四分之一个单位：版面把长度换成整数时往零的方向舍，不加的话浮点误差会把它舍到隔壁一格。 */
function luCss(n: number, dpr: number): number {
  return (n + (n >= 0 ? 0.25 : -0.25)) / (64 * dpr);
}
function offsetCss(trig: number, head: number, dpr: number): number {
  return luCss(Math.round(trig * dpr * 64) - Math.round(head * dpr * 64), dpr);
}

/* 卸载以后钮上的 data-hot 什么时候撤：浏览器补上了真的 :hover、鼠标动了一下、或者过了一秒（兜底）。重新长开时先取消 */
const releasing = new WeakMap<HTMLElement, () => void>();
function cancelRelease(trig: HTMLElement) {
  releasing.get(trig)?.();
}
function releaseHotLater(trig: HTMLElement) {
  cancelRelease(trig);
  let raf = 0;
  const timer = window.setTimeout(done, 1000);
  const onMove = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(done);
  };
  const poll = () => {
    if (trig.matches(':hover')) done();
    else raf = requestAnimationFrame(poll);
  };
  function cancel() {
    window.removeEventListener('pointermove', onMove, true);
    window.clearTimeout(timer);
    cancelAnimationFrame(raf);
    releasing.delete(trig);
  }
  function done() {
    cancel();
    trig.removeAttribute('data-hot');
  }
  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  releasing.set(trig, cancel);
  raf = requestAnimationFrame(poll);
}

/** 弹出框（Popup）里要做的事：量位置和大小、亮起来的同一帧藏钮、记着鼠标在不在钮上。返回 data-hot 要不要写 */
export function useGrowPopup(
  popRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  faceNode: unknown,
  enabled: boolean,
): boolean {
  const [hot, setHot] = useState(() => (enabled && triggerRef.current?.matches(':hover')) || false);
  const hotRef = useRef(hot);
  hotRef.current = hot;
  /* 钮也跟着「鼠标在不在钮上」亮（data-hot，样子同悬停）：弹出框开着时钮被头盖住，浏览器认为鼠标不在钮上；
     关到最后钮回来的那一帧，鼠标还停在原地时浏览器要过一阵才会补上 :hover，这一段钮会先暗一下再亮回去。所以开着时就让藏着的钮保持和头一样的亮，
     关完卸载时鼠标还在钮上的就留着 data-hot，等浏览器补上真的 :hover、或鼠标一动，再撤 */
  useLayoutEffect(() => {
    const trig = triggerRef.current;
    if (!enabled || !trig) return;
    cancelRelease(trig);
    if (hot) trig.setAttribute('data-hot', '');
    else trig.removeAttribute('data-hot');
  }, [enabled, hot, triggerRef]);
  useLayoutEffect(() => {
    const trig = triggerRef.current;
    if (!enabled || !trig) return;
    return () => {
      if (hotRef.current) releaseHotLater(trig);
      else trig.removeAttribute('data-hot');
    };
  }, [enabled, triggerRef]);
  useEffect(() => {
    if (!enabled) return;
    const onMove = (e: PointerEvent) => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setHot(
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
      );
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [enabled, triggerRef]);

  /* 量：钮实际的宽高（Base UI 的 --anchor-width 取了整），再量头和钮的位置差。先写宽高再清零位移再读位置，次序不能乱：
     靠右对齐时头的位置和它的宽有关 */
  const measure = useCallback(() => {
    const pop = popRef.current;
    const trig = triggerRef.current;
    if (!pop || !trig) return;
    const r = trig.getBoundingClientRect();
    pop.style.setProperty('--ll-grow-w', `${r.width}px`);
    pop.style.setProperty('--ll-grow-h', `${r.height}px`);
    const head = pop.querySelector<HTMLElement>('.ll-dd-head');
    if (!head) return;
    pop.style.setProperty('--ll-grow-dx', '0px');
    pop.style.setProperty('--ll-grow-dy', '0px');
    const dpr = window.devicePixelRatio || 1;
    const headText = (head.querySelector('.ll-dd-main') ?? head).getBoundingClientRect();
    const trigText = (trig.querySelector('.ll-dd-main') ?? trig).getBoundingClientRect();
    pop.style.setProperty('--ll-grow-dx', `${offsetCss(trigText.left, headText.left, dpr)}px`);
    pop.style.setProperty('--ll-grow-dy', `${offsetCss(trigText.top, headText.top, dpr)}px`);
  }, [popRef, triggerRef]);

  /* 挂上：位置是 Base UI 在提交之后的微任务里定的（floating-ui 算完同步刷新），绘制之前的下一个 requestAnimationFrame 里已经到位——在那里量、
     同时写 data-ready（浮层亮、开始长）和钮的 data-away。再连量几帧（字体、滚动条出现等可能让位置再挪一点）。
     例外：放在别的元素里（container）时，Base UI 第一次算出来的位置是按视口算的、下一帧才改成按那个元素算（实测第一帧 translate 是 (321, 251)，下一帧才是 (20, 130)），
     第一个 requestAnimationFrame 里量到的差是错的，亮起来的那一帧头就错位了、又被那个元素裁掉，钮藏了、头却看不见，一帧的空洞（钮闪一下）。
     所以亮起来之前先看一眼位置到没到：弹出框盖在钮上长开，往下开时上边、往上开时下边对着钮的那条边，左边（靠右对齐时右边、居中时中线）也对着钮，差不到 1.5 像素就是到了，
     马上亮（平常的情形第一个 requestAnimationFrame 就到位，不多等）；没对上（被碰撞挪过位置、给了 alignOffset……）就看位置在不在动，连着两个 requestAnimationFrame 一样才亮；
     最多等三个，免得永远不亮。卸载时在同一次提交里撤掉 data-away（钮回来的那一帧，浮层正好没了）。 */
  useLayoutEffect(() => {
    const pop = popRef.current;
    const trig = triggerRef.current;
    if (!enabled || !pop || !trig) return;
    let id = 0;
    let n = 0;
    let waits = 0;
    let lastPos = '';
    /* 浮层盖在钮上：对着钮的那几条边对上了没有 */
    const covers = () => {
      const t = trig.getBoundingClientRect();
      const p = pop.getBoundingClientRect();
      const v = pop.dataset.side === 'top' ? p.bottom - t.bottom : p.top - t.top;
      const h =
        pop.dataset.align === 'end'
          ? p.right - t.right
          : pop.dataset.align === 'center'
            ? (p.left + p.right - t.left - t.right) / 2
            : p.left - t.left;
      return Math.abs(v) < 1.5 && Math.abs(h) < 1.5;
    };
    const tick = () => {
      measure();
      if (!pop.hasAttribute('data-ready')) {
        const p = pop.getBoundingClientRect();
        const here = `${p.left},${p.top}`;
        const still = here === lastPos;
        lastPos = here;
        if (!covers() && !still && waits < 3) {
          waits++;
          id = requestAnimationFrame(tick);
          return;
        }
        /* 面的起点（底色、细线、字色）取钮此刻真实的样子：鼠标刚移上钮就点（悬停的 0.12 秒过渡才走到一半）时，起点不能直接是悬停的样子，
           不然头出现的那一帧字、底会比钮亮一截。写成行内变量；data-seed 期间起点的颜色过渡先关掉（不然从 class 里的值慢慢过渡到这个值），
           下一帧撤掉，起点再按 0.3 秒的过渡走向悬停（或平常）的样子 */
        const cs = getComputedStyle(trig);
        pop.setAttribute('data-seed', '');
        pop.style.setProperty('--ll-grow-bg0', cs.backgroundColor);
        pop.style.setProperty('--ll-grow-fg0', cs.color);
        pop.style.setProperty('--ll-grow-edge0', shadowColor(cs.boxShadow));
        /* 先让浏览器按 s=0 算一次样式（过渡要有「变之前」的样式才会开始），再写 data-ready */
        void getComputedStyle(pop).getPropertyValue('--ll-grow-s');
        pop.setAttribute('data-ready', '');
        trig.setAttribute('data-away', '');
      } else if (pop.hasAttribute('data-seed')) {
        pop.removeAttribute('data-seed');
        pop.style.removeProperty('--ll-grow-bg0');
        pop.style.removeProperty('--ll-grow-fg0');
        pop.style.removeProperty('--ll-grow-edge0');
      }
      if (++n < 4) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(id);
      trig.removeAttribute('data-away');
    };
  }, [enabled, popRef, triggerRef, measure]);

  /* 钮里的内容变了（选了一项，钮上的字跟着变）：钮和头同时变，重新量，头缩回的终点是新的钮 */
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (enabled) measure();
  }, [enabled, faceNode, measure]);
  return hot;
}
