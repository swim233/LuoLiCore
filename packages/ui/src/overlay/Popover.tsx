import { Popover as BasePopover } from '@base-ui/react/popover';
import { useCallback, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../controls/cx';
import { useGlide } from '../scroll/glide';
import {
  DropdownFace,
  GrowApiCtx,
  GrowHead,
  GrowLiveCtx,
  GrowProviders,
  overlapAnchor,
  useGrowPopup,
  useGrowRoot,
  useRegisterFace,
} from './grow';
import type { DropdownKind, DropdownSize } from './grow';

/* 弹出框：Base UI 的 Popover 打底（焦点、Esc、点外面关、aria-expanded / aria-controls / role="dialog" 都是它给的），这里加类名、样子，和「长开」。
   - Popover（根，不渲染元素）：自己管着 open（受控、不受控都认），其余 props 原样给 Base UI。hoverOnly：只认悬停，点击、键盘焦点都不打开；
   - PopoverButton：库的下拉钮，点开弹出框用它（kind、size、icon、children 同 MenuButton，放在 <Popover> 里面）。
     **用它点开的弹出框会「长开」**：钮自己的底长成弹出框的底，内容整块淡入（见 grow.css）。钮那一行在弹出框里再画一份当「头」，画的是同一份 children 的第二个实例，
     所以 children 应当是不带自己状态的东西（字、图标）；PopoverContent 的 head 可以整个换掉头里的内容（箭头也要自己画）。
     **不长开的**：悬停打开的（根的 hoverOnly、PopoverButton 的 openOnHover）、不接鼠标的（PopoverContent 的 passive）、触发按钮不在根里面或几个按钮共用一个弹出框的
     （handle）、自己用 PopoverTrigger 加 render 给触发元素的：这些照老样子淡入加一点缩放。
     长开只支持一个根（<Popover>）里一个下拉钮：一个根里放了不止一个 PopoverButton 时，这个根自动退回不长开（淡入加缩放，钮不藏、没有头），每个钮都能正常打开各自位置上的弹出框；卸到只剩一个又恢复长开（开着时也一样），从一个变成两个当场退回；
   - PopoverTrigger（渲染 <button>，没有样式：要库的按钮就 render={<Button … />}）、createPopoverHandle：原样转出；
   - 悬停打开只认「鼠标真的在动」：页面变了、触发按钮正好跑到不动的鼠标底下时（比如退出全屏），Chrome 会补发 pointerover / mouseover / mouseenter，
     Base UI 听的是 mouseenter，会当成鼠标移进来而打开；但补发的这一串后面没有带位移的 pointermove（movementX、movementY 都是 0），真的移进来时有
     （同一个时间戳，Chrome 里排在 mouseenter 后面）。根在这里看：悬停打开的前后 50 毫秒里有没有一次带位移的 pointermove，没有就不让它开
     （马上开的会先让它开，等这一轮事件发完再看一眼，没有就关掉，用户看不到；这一轮事件还没发完时主线程卡住也不会误拦）；和 hoverOnly 无关，所有悬停打开都这样；
     挂上根时才在 window 上接一个监听，全部卸载就拆。和原生 pointerenter 的差别：停着不动的补发不开，鼠标动一下才开（见「补开」）；
     滚轮把触发按钮滚到不动的鼠标底下时，原生会开、这里先不开，鼠标动一下才开；
     「补开」：悬停打开被拦下以后（记下这个触发元素），鼠标还在它上面、之后来了一次带位移的 pointermove，就把「鼠标移进来」补发一次（往触发元素上派发一个 mouseenter），
     所以补发的那种「停着不动」仍然不弹，轻轻一动就出；鼠标先离开了（下一次带位移的 pointermove 不在触发元素上）就作废。
     延迟 0 的悬停打开每次都是这样：布局变了、触发元素跑到不动的鼠标底下时，Chrome 补发一次可信的、位移为 0 的 mouseenter，库拦下，之后鼠标一动就派发补开的那一次；
     页面上第一个鼠标事件就落在触发元素上时也一样。延迟大于 0 的要分情形：布局变了的那种，Base UI 对 Chrome 补发的那一串根本没起计时，库不拦也不派发，
     鼠标再动以后由 Base UI 自己按延迟打开；页面上第一个鼠标事件就落在触发元素上（带位移的事件还没有过）时，那一次 mousemove 起了计时，延迟到了库才拦下并记下，
     鼠标是在延迟过了以后才动的才派发补开（延迟没到就动，不拦、不派发，照常按延迟开）；
     补开派发的 mouseenter 是不可信的（isTrusted 为 false）：用的地方要是自己在这个触发元素上用 addEventListener('mouseenter') 挂了监听，会多收一次
     （Chrome 在布局变了以后先补发一次可信的、位移为 0 的，库再补一次不可信的）；React 的 onMouseEnter 是从 mouseover、mouseout 推出来的，不会多收；行为不改；
   - PopoverContent：Portal、Positioner、Popup 合成一个。位置的 props（side、align、sideOffset 默认 8、alignOffset、collisionPadding 默认 8、
     collisionAvoidance、anchor……）给 Positioner，container 给 Portal，其余（className、children、initialFocus、finalFocus……）给 Popup；
     长开的弹出框上边和钮的上边对齐（盖在钮上长开，sideOffset 不用），align 默认 start；长开的弹出框翻面只在上下之间：collisionAvoidance 没传时默认
     { fallbackAxisSide: 'none' }（上下都放不下整块内容时留在原来那一侧、高度限在可用高度里、里面滚，不翻到左右；其余照 Base UI 的默认；不长开的弹出框不变）。
     长开只支持上下，所以自己传 collisionAvoidance 的话（照你传的），别让它翻到左右；
   - glide：里面是一列行（任务列表那种）时给行的选择器，悬停的滑动高亮就开在弹出框里（和菜单一样）；
   - 悬停打开：PopoverTrigger 的 openOnHover（delay 默认 300、closeDelay 默认 0），弹出框默认能移进去、不会马上关；
   - 挂在哪：默认挂到 <body>（Base UI 的默认）；container 指到某个元素里，浮层就留在那里面（被它裁、糊的是它里面的东西、它被复制时跟着走）。
   样子（玻璃、圆角、宽高上限、进出场）见 popover.css、grow.css。入口加载时不碰 DOM。 */
export type PopoverProps<Payload = unknown> = BasePopover.Root.Props<Payload> & {
  /** 只认悬停：点触发按钮、键盘焦点都不会打开（也不会让悬停打开的那个「粘住」不关）；
      触屏上也就不出。悬停打开的状态说明（触发按钮自己另有点击的作用）用它。这样的弹出框不长开 */
  hoverOnly?: boolean;
};

/* 悬停打开的真假：记下最近一次带位移的 pointermove 的时间戳。鼠标真的移进触发按钮时，这一次移动的 pointerover / mouseenter 和 pointermove 是同一个时间戳
   （Chrome 先发 mouseenter、后发 pointermove，别的浏览器可能反过来，所以前后各留 50 毫秒）；页面布局变了、触发按钮跑到不动的鼠标底下时，
   浏览器补发的 pointerover / mouseenter 后面没有带位移的 pointermove。只在有弹出框挂着时才在 window 上接这一个监听（入口加载时不碰 DOM）。 */
let lastRealMove = Number.NEGATIVE_INFINITY;
let watching = 0;
/* 被拦下的悬停打开，等着「补开」的那个触发元素：之后鼠标还在它上面时来了一次带位移的 pointermove，就把「鼠标移进来」补发一次（见 onPointerMove）。
   一次性的：下一次带位移的 pointermove 不管成不成都作废（鼠标已经移到别处就是不要了） */
let pendingHover: HTMLElement | null = null;
const onPointerMove = (e: PointerEvent) => {
  if (e.movementX === 0 && e.movementY === 0) return;
  lastRealMove = e.timeStamp;
  const el = pendingHover;
  if (!el) return;
  pendingHover = null;
  if (!el.isConnected || !(e.target instanceof Node) || !el.contains(e.target)) return;
  /* 补发的 mouseenter 和上面刚记下的 lastRealMove 同一轮，守卫（allowHover）会放行；Base UI 是在触发元素上原生监听 mouseenter 的 */
  el.dispatchEvent(new MouseEvent('mouseenter', { clientX: e.clientX, clientY: e.clientY }));
};
function watchPointer() {
  if (watching++ === 0)
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  return () => {
    if (--watching === 0) window.removeEventListener('pointermove', onPointerMove, true);
  };
}
/** 「同一次移动」的前后各留多少毫秒 */
const NEAR_MS = 50;
/** 这次悬停打开是不是鼠标真的移进来的：是（或还说不准，先让它开、等这一轮事件发完再查）就返回 true；确定不是就返回 false。
    事件还在派发（window.event 就是它）时说明还在同一轮里，卡住多久都不算晚 */
function allowHover(e: Event, close: () => void): boolean {
  if (lastRealMove >= e.timeStamp - NEAR_MS) return true;
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (window.event !== e && performance.now() - e.timeStamp > NEAR_MS) {
    pendingHover = el;
    return false;
  }
  setTimeout(() => {
    if (lastRealMove < e.timeStamp - NEAR_MS) {
      pendingHover = el;
      close();
    }
  }, 0);
  return true;
}

/** 弹出框的根。hoverOnly：只认悬停（见上）；其余 props 原样给 Base UI 的 Popover.Root */
export function Popover<Payload = unknown>({
  hoverOnly,
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  actionsRef,
  ...rest
}: PopoverProps<Payload>) {
  useEffect(watchPointer, []);
  const own = useRef<BasePopover.Root.Actions | null>(null);
  const actions = actionsRef ?? own;
  const guard = useCallback(
    (next: boolean, details: BasePopover.Root.ChangeEventDetails) => {
      /* 悬停打开后再点一下，Base UI 会让它「粘住」不关（stickIfOpen）：点击的作用是触发按钮自己的，弹出框不管 */
      if (hoverOnly && (details.reason === 'trigger-press' || details.reason === 'trigger-focus')) {
        details.cancel();
        return false;
      }
      if (
        next &&
        details.reason === 'trigger-hover' &&
        !allowHover(details.event, () => actions.current?.close())
      ) {
        details.cancel();
        return false;
      }
      return true;
    },
    [hoverOnly, actions],
  );
  const grow = useGrowRoot<BasePopover.Root.ChangeEventDetails>({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    enabled: rest.handle == null && !hoverOnly,
    guard,
  });
  return (
    <GrowProviders root={grow}>
      <BasePopover.Root<Payload> actionsRef={actions} {...rest} {...grow.rootProps} />
    </GrowProviders>
  );
}

export type PopoverButtonProps = Omit<BasePopover.Trigger.Props, 'className' | 'children'> & {
  /** pill 胶囊（默认）、slot 槽 */
  kind?: DropdownKind;
  /** 尺寸，和库的按钮一样四档：xs 18、sm 22、md 28（默认）、lg 32 */
  size?: DropdownSize;
  /** 钮上只有一个图标 */
  icon?: boolean;
  className?: string;
  children?: ReactNode;
};
/** 下拉钮：点开弹出框用，放在 <Popover> 里面。用它点开的弹出框会长开（悬停打开的除外：写了 openOnHover 就不长开） */
export function PopoverButton({
  kind = 'pill',
  size = 'md',
  icon,
  className,
  children,
  ref,
  ...rest
}: PopoverButtonProps) {
  const setTrigger = useRegisterFace(
    rest.openOnHover ? null : { kind, size, icon: !!icon, node: children },
  );
  const setRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      setTrigger(el);
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [setTrigger, ref],
  );
  return (
    <BasePopover.Trigger
      ref={setRefs}
      className={cx('ll-dd', className)}
      data-kind={kind}
      data-size={size}
      data-icon={icon ? '' : undefined}
      {...rest}
    >
      <DropdownFace>{children}</DropdownFace>
    </BasePopover.Trigger>
  );
}
export const PopoverTrigger = BasePopover.Trigger;
export const createPopoverHandle = BasePopover.createHandle;

type PositionerKeys =
  | 'side'
  | 'align'
  | 'sideOffset'
  | 'alignOffset'
  | 'collisionPadding'
  | 'collisionAvoidance'
  | 'collisionBoundary'
  | 'anchor'
  | 'sticky'
  | 'positionMethod'
  | 'disableAnchorTracking';

export type PopoverContentProps = Omit<BasePopover.Popup.Props, 'className'> &
  Pick<BasePopover.Positioner.Props, PositionerKeys> &
  Pick<BasePopover.Portal.Props, 'container'> & {
    className?: string;
    /** 不接鼠标（只是给人看的说明：悬停弹出的状态那种）：弹出框和它外面那层都不接，鼠标穿过去。这样的弹出框不长开 */
    passive?: boolean;
    /** 里面是一列行（任务列表那种）时给行的选择器：鼠标悬停的滑动高亮（库的 useGlide，第一个子元素是 .ll-glide）就开在弹出框里，
        行要是库的 .ll-row（或带 .ll-glide-item）；不给就没有。弹出框自己滚时高亮跟着内容走 */
    glide?: string;
    /** 长开的弹出框里头（钮那一行）画什么：不给就是钮里的东西再画一份；给了就整个换掉（箭头也要自己画）。没有用下拉钮时没有头，这个也不起作用 */
    head?: ReactNode;
  };

const NO_REF = { current: null };

/* 弹出框的窗体：useGlide 只在挂载时接一次，弹出框的内容打开时才挂上，所以放在 Positioner 里面的这一层，和 Popup 同一刻挂上（菜单同理） */
function PopoverPopup({
  glide,
  className,
  children,
  ref,
  head,
  passive,
  growOk,
  ...rest
}: Omit<PopoverContentProps, 'container'> & { growOk: boolean }) {
  const live = useContext(GrowLiveCtx);
  const api = useContext(GrowApiCtx);
  const face = growOk ? live.face : null;
  const grow = face !== null && api !== null;
  const g = useGlide(glide ?? '');
  const popRef = useRef<HTMLDivElement | null>(null);
  const hot = useGrowPopup(popRef, api?.triggerRef ?? NO_REF, face?.node, grow);
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      popRef.current = el;
      if (!grow) g.list.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [g.list, grow, ref],
  );
  const setBody = useCallback(
    (el: HTMLElement | null) => {
      g.list.current = el;
    },
    [g.list],
  );
  const setGlide = useCallback(
    (el: HTMLElement | null) => {
      g.glide.current = el;
    },
    [g.glide],
  );
  return (
    <BasePopover.Popup
      ref={setRefs}
      className={cx(grow ? 'll-popover ll-grow' : 'll-glass ll-popover ll-scrollbar', className)}
      data-passive={passive ? '' : undefined}
      data-kind={face?.kind}
      data-size={face?.size}
      data-hot={grow && hot ? '' : undefined}
      {...rest}
    >
      {grow ? (
        <>
          <i className="ll-grow-surf" aria-hidden="true" />
          <GrowHead face={face} head={head} />
          <div className="ll-popover-body ll-scrollbar" ref={setBody}>
            {glide && <i className="ll-glide" ref={setGlide} aria-hidden="true" />}
            {children}
          </div>
        </>
      ) : (
        <>
          {glide && <i className="ll-glide" ref={setGlide} aria-hidden="true" />}
          {children}
        </>
      )}
    </BasePopover.Popup>
  );
}

/** 长开的弹出框只支持往上、往下开：上下都放不下整块内容时留在原来那一侧、里面滚，不翻到左右（Base UI 弹出框的默认是可以翻到左右的，菜单的默认本来就不翻）。
    用的地方自己传了 collisionAvoidance 的照它的 */
const GROW_COLLISION: NonNullable<BasePopover.Positioner.Props['collisionAvoidance']> = {
  fallbackAxisSide: 'none',
};

export function PopoverContent({
  side,
  align,
  sideOffset = 8,
  alignOffset,
  collisionPadding = 8,
  collisionAvoidance,
  collisionBoundary,
  anchor,
  sticky,
  positionMethod,
  disableAnchorTracking,
  container,
  passive,
  ...rest
}: PopoverContentProps) {
  const live = useContext(GrowLiveCtx);
  /* 长开只管往下、往上开、锚点就是钮的、接鼠标的：往左右开、给了别的 anchor、不接鼠标的照老样子 */
  const grow =
    live.enabled &&
    live.face !== null &&
    !passive &&
    (side === undefined || side === 'top' || side === 'bottom') &&
    anchor === undefined;
  return (
    <BasePopover.Portal container={container}>
      <BasePopover.Positioner
        className="ll-popover-pos"
        data-passive={passive ? '' : undefined}
        side={side}
        align={grow ? (align ?? 'start') : align}
        sideOffset={grow ? overlapAnchor : sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance ?? (grow ? GROW_COLLISION : undefined)}
        collisionBoundary={collisionBoundary}
        anchor={anchor}
        sticky={sticky}
        positionMethod={positionMethod}
        disableAnchorTracking={disableAnchorTracking}
      >
        <PopoverPopup passive={passive} growOk={grow} {...rest} />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export type PopoverTitleProps = Omit<BasePopover.Title.Props, 'className'> & { className?: string };
/** 标题（<h2>，Base UI 把它接到弹出框的 aria-labelledby） */
export function PopoverTitle({ className, ...rest }: PopoverTitleProps) {
  return <BasePopover.Title className={cx('ll-popover-title', className)} {...rest} />;
}

export type PopoverDescriptionProps = Omit<BasePopover.Description.Props, 'className'> & {
  className?: string;
};
/** 说明（<p>，接到 aria-describedby） */
export function PopoverDescription({ className, ...rest }: PopoverDescriptionProps) {
  return <BasePopover.Description className={cx('ll-popover-desc', className)} {...rest} />;
}

/** 关闭按钮（渲染 <button>，没有样式：render={<Button …/>} 或 render={<IconButton …/>}） */
export const PopoverClose = BasePopover.Close;
