import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../controls/cx';
import { IconCheck } from '../icons';
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

/* 下拉菜单：Base UI 的 Menu 打底（方向键、到头循环、Home / End、输入首字母跳转、Esc、Enter 和空格、焦点进出、role="menu"、aria-expanded 都是它给的），
   这里加类名、样子、悬停的滑动高亮，和「长开」。
   - Menu：根。modal 默认改成 false（Base UI 默认 true，会锁页面滚动、让外面的东西不接指针；菜单不该这样）；自己管着 open（受控、不受控都认；
     长开时头要能点）。其余 props 原样给 Base UI；
   - MenuButton：库的下拉钮，打开菜单用它：kind="pill"（胶囊加小箭头，默认；操作菜单用）、kind="slot"（槽；选值的、钮上写着「现在选的是哪个」的用）、size（xs、sm、md 默认、lg，和库的按钮同样的高、字号、内边距）、
     icon（钮上只有一个图标：图标加小箭头）；children 是钮里的东西（字、图标），小箭头库自己加。样子见 dropdown.css。
     **用它打开的菜单会「长开」：钮自己的底长成菜单的底，然后项一项项落下来（见 grow.css）。**钮那一行在菜单里再画一份当「头」，画的是同一份 children
     的第二个实例，所以 children 应当是不带自己状态的东西（字、图标）；想让头画别的，MenuContent 的 head 整个换掉头里的内容（箭头也要自己画）。
     长开只支持一个根（<Menu>）里一个下拉钮：一个根里放了不止一个 MenuButton 时，这个根自动退回不长开（淡入加缩放，钮不藏、没有头），每个钮都能正常打开各自位置上的菜单；卸到只剩一个又恢复长开（开着时也一样），从一个变成两个当场退回；
   - MenuTrigger：渲染 <button>，没有样式（要库的按钮就 render={<Button … />}），自己给触发元素、触发按钮不在根里面（handle）的用它，**这样的菜单不长开**，
     照老样子淡入加一点缩放；createMenuHandle：触发按钮不在根里面时用；
   - MenuContent：Portal、Positioner、Popup 合成一个，默认 side="bottom"、align="start"、sideOffset 4、collisionPadding 8；container 指到某个元素里，菜单就留在里面。
     长开的菜单上边和钮的上边对齐（盖在钮上长开，sideOffset 不用；往下往上开才长开，往左右开、给了别的 anchor 时照老样子）；
     长开的菜单翻面本来就只在上下之间（Base UI 菜单的 collisionAvoidance 默认是 { fallbackAxisSide: 'none' }，100 项的菜单实测也不翻到左右），不用另外处理；
     自己传 collisionAvoidance 的话（Base UI 整个换成你传的），长开只支持上下，别让它翻到左右；
   - MenuItem：lead（左边的图标）、hint（右边的小字）、tone="danger"、current（「现在就在这一项」，写成 aria-current），其余透传；
     MenuCheckboxItem、MenuRadioGroup、MenuRadioItem：选中时右边一个勾；MenuSeparator、MenuGroup、MenuGroupLabel。
   悬停高亮和键盘高亮的并存：
   - 鼠标：一块高亮（库的 useGlide、.ll-glide）跟着鼠标从一项滑到另一项，带边光；关动画时每项自己淡入淡出（.ll-hl）。Base UI 的「鼠标移过去就高亮那一项」
     保持打开（highlightItemOnHover），所以鼠标停在一项上再按方向键，是从那一项接着走；
   - 键盘：走到的那一项是 Base UI 的 data-highlighted，画一圈强调色的框加淡底；
   - 两种高亮不同时出现：菜单（Popup）上有 data-nav，最近一次输入是键盘（方向键、Home、End、输入字母）就是 keyboard，是鼠标挪动（真的动了才算，
     布局变了浏览器补发的不算）或按下就是 pointer。keyboard 时滑动的那块和关动画时那一项的淡入都立刻藏起来（不淡出）、data-highlighted 才画框；
     pointer 时 data-highlighted 不画（Base UI 跟着鼠标移走的高亮只是为了让键盘接得上）。刚打开时是 keyboard：键盘打开时第一项马上有框，
     鼠标打开时本来就没有高亮的项。
   - useGlide 只在挂载时接一次，菜单的内容打开时才挂上：所以 useGlide 放在 Positioner 里面的 MenuPopup 里，和 Popup 同一刻挂上。
   样子见 menu.css、grow.css。入口加载时不碰 DOM。 */
export function Menu<Payload = unknown>({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...rest
}: BaseMenu.Root.Props<Payload>) {
  const grow = useGrowRoot({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    enabled: rest.handle == null,
  });
  return (
    <GrowProviders root={grow}>
      <BaseMenu.Root<Payload> modal={false} {...rest} {...grow.rootProps} />
    </GrowProviders>
  );
}
export const MenuTrigger = BaseMenu.Trigger;
export const createMenuHandle = BaseMenu.createHandle;

export type MenuButtonProps = Omit<BaseMenu.Trigger.Props, 'className' | 'children'> & {
  /** pill 胶囊（默认）、slot 槽 */
  kind?: DropdownKind;
  /** 尺寸，和库的按钮一样四档：xs 18、sm 22、md 28（默认）、lg 32 */
  size?: DropdownSize;
  /** 钮上只有一个图标 */
  icon?: boolean;
  className?: string;
  children?: ReactNode;
};
/** 下拉钮：打开菜单用，放在 <Menu> 里面。用它打开的菜单会长开（一个根里只有这一个下拉钮时；多于一个时退回不长开） */
export function MenuButton({
  kind = 'pill',
  size = 'md',
  icon,
  className,
  children,
  ref,
  ...rest
}: MenuButtonProps) {
  const setTrigger = useRegisterFace({ kind, size, icon: !!icon, node: children });
  const setRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      setTrigger(el);
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [setTrigger, ref],
  );
  return (
    <BaseMenu.Trigger
      ref={setRefs}
      className={cx('ll-dd', className)}
      data-kind={kind}
      data-size={size}
      data-icon={icon ? '' : undefined}
      {...rest}
    >
      <DropdownFace>{children}</DropdownFace>
    </BaseMenu.Trigger>
  );
}

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

/* 键盘在挪高亮的键：方向键、Home、End、翻页，和输入首字母（单个字符，不带 Ctrl / Meta / Alt） */
const isNavKey = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
  /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/.test(e.key) ||
  (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);

type PopupProps = Omit<BaseMenu.Popup.Props, 'className'> & { className?: string };

function MenuPopup({
  className,
  children,
  ref,
  head,
  growOk,
  onKeyDown,
  onPointerMove,
  onPointerDown,
  ...rest
}: PopupProps & { head?: ReactNode; growOk: boolean }) {
  const live = useContext(GrowLiveCtx);
  const api = useContext(GrowApiCtx);
  const face = growOk ? live.face : null;
  const grow = face !== null && api !== null;
  const g = useGlide('.ll-menu-item:not([data-disabled])');
  const popRef = useRef<HTMLDivElement | null>(null);
  const hot = useGrowPopup(popRef, api?.triggerRef ?? NO_REF, face?.node, grow);
  const [nav, setNav] = useState<'keyboard' | 'pointer'>('keyboard');
  /* 合并外面传进来的 ref：函数要稳定，不然每次渲染都是新的函数，React 会先传 null 再传元素 */
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      popRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const setList = useCallback(
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
  /* 平常的菜单：Popup 自己是列表（滑动高亮的容器）；长开的：列表是 Popup 里面单独的一层 */
  const setPopupAsList = useCallback(
    (el: HTMLDivElement | null) => {
      setRefs(el);
      if (!grow) g.list.current = el;
    },
    [setRefs, grow, g.list],
  );
  return (
    <BaseMenu.Popup
      ref={setPopupAsList}
      className={cx(grow ? 'll-menu ll-grow' : 'll-glass ll-menu ll-scrollbar', className)}
      data-nav={nav}
      data-kind={face?.kind}
      data-size={face?.size}
      data-hot={grow && hot ? '' : undefined}
      onKeyDown={(e) => {
        if (isNavKey(e)) setNav('keyboard');
        onKeyDown?.(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse' && (e.movementX !== 0 || e.movementY !== 0))
          setNav('pointer');
        onPointerMove?.(e);
      }}
      onPointerDown={(e) => {
        setNav('pointer');
        onPointerDown?.(e);
      }}
      {...rest}
    >
      {grow ? (
        <>
          <i className="ll-grow-surf" aria-hidden="true" />
          <GrowHead face={face} head={head} />
          <div className="ll-menu-list ll-scrollbar" ref={setList}>
            <i className="ll-glide" ref={setGlide} aria-hidden="true" />
            {children}
          </div>
        </>
      ) : (
        <>
          <i className="ll-glide" ref={setGlide} aria-hidden="true" />
          {children}
        </>
      )}
    </BaseMenu.Popup>
  );
}
const NO_REF = { current: null };

export type MenuContentProps = PopupProps &
  Pick<BaseMenu.Positioner.Props, PositionerKeys> &
  Pick<BaseMenu.Portal.Props, 'container'> & {
    /** 长开的菜单里头（钮那一行）画什么：不给就是钮里的东西再画一份；给了就整个换掉（箭头也要自己画）。没有用下拉钮时没有头，这个也不起作用 */
    head?: ReactNode;
  };

export function MenuContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset,
  collisionPadding = 8,
  collisionAvoidance,
  collisionBoundary,
  anchor,
  sticky,
  positionMethod,
  disableAnchorTracking,
  container,
  ...rest
}: MenuContentProps) {
  const live = useContext(GrowLiveCtx);
  /* 长开只管往下、往上开、锚点就是钮的：往左右开、给了别的 anchor 时照老样子 */
  const grow =
    live.enabled &&
    live.face !== null &&
    (side === 'top' || side === 'bottom') &&
    anchor === undefined;
  return (
    <BaseMenu.Portal container={container}>
      <BaseMenu.Positioner
        className="ll-menu-pos"
        side={side}
        align={align}
        sideOffset={grow ? overlapAnchor : sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        collisionBoundary={collisionBoundary}
        anchor={anchor}
        sticky={sticky}
        positionMethod={positionMethod}
        disableAnchorTracking={disableAnchorTracking}
      >
        <MenuPopup growOk={grow} {...rest} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

interface ItemExtras {
  className?: string;
  /** 左边的图标（@luoli/ui/icons 里的，14px） */
  lead?: ReactNode;
  /** 右边的小字：时间、快捷键…… */
  hint?: ReactNode;
  /** danger：危险的操作，字是危险色 */
  tone?: 'danger';
  children?: ReactNode;
}

function ItemBody({ lead, hint, children }: Pick<ItemExtras, 'lead' | 'hint' | 'children'>) {
  return (
    <>
      {lead != null && (
        <span className="ll-menu-lead" aria-hidden="true">
          {lead}
        </span>
      )}
      <span className="ll-menu-label">{children}</span>
      {hint != null && <span className="ll-menu-hint">{hint}</span>}
    </>
  );
}

export type MenuItemProps = Omit<BaseMenu.Item.Props, 'className' | 'children'> &
  ItemExtras & {
    /** 「现在就在这一项」（比如选会话的菜单里当前的会话）：写成 aria-current，底和字亮一档 */
    current?: boolean;
  };
export function MenuItem({
  lead,
  hint,
  tone,
  current,
  className,
  children,
  ...rest
}: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cx('ll-menu-item ll-glide-item', className)}
      data-tone={tone}
      aria-current={current ? 'true' : undefined}
      {...rest}
    >
      <ItemBody lead={lead} hint={hint}>
        {children}
      </ItemBody>
    </BaseMenu.Item>
  );
}

export type MenuCheckboxItemProps = Omit<BaseMenu.CheckboxItem.Props, 'className' | 'children'> &
  ItemExtras;
/** 勾选项：选中时右边一个勾；点一下不关菜单要写 closeOnClick={false} */
export function MenuCheckboxItem({
  lead,
  hint,
  tone,
  className,
  children,
  ...rest
}: MenuCheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem
      className={cx('ll-menu-item ll-glide-item', className)}
      data-tone={tone}
      {...rest}
    >
      <ItemBody lead={lead} hint={hint}>
        {children}
      </ItemBody>
      <BaseMenu.CheckboxItemIndicator className="ll-menu-tick" keepMounted>
        <IconCheck />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

export type MenuRadioGroupProps = Omit<BaseMenu.RadioGroup.Props, 'className'> & {
  className?: string;
};
/** 单选组：value、onValueChange 在这里，里面放 MenuRadioItem */
export function MenuRadioGroup({ className, ...rest }: MenuRadioGroupProps) {
  return <BaseMenu.RadioGroup className={cx('ll-menu-group', className)} {...rest} />;
}

export type MenuRadioItemProps = Omit<BaseMenu.RadioItem.Props, 'className' | 'children'> &
  ItemExtras;
export function MenuRadioItem({
  lead,
  hint,
  tone,
  className,
  children,
  ...rest
}: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem
      className={cx('ll-menu-item ll-glide-item', className)}
      data-tone={tone}
      {...rest}
    >
      <ItemBody lead={lead} hint={hint}>
        {children}
      </ItemBody>
      <BaseMenu.RadioItemIndicator className="ll-menu-tick" keepMounted>
        <IconCheck />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

export type MenuSeparatorProps = Omit<BaseMenu.Separator.Props, 'className'> & {
  className?: string;
};
export function MenuSeparator({ className, ...rest }: MenuSeparatorProps) {
  return <BaseMenu.Separator className={cx('ll-menu-sep', className)} {...rest} />;
}

export type MenuGroupProps = Omit<BaseMenu.Group.Props, 'className'> & { className?: string };
export function MenuGroup({ className, ...rest }: MenuGroupProps) {
  return <BaseMenu.Group className={cx('ll-menu-group', className)} {...rest} />;
}

export type MenuGroupLabelProps = Omit<BaseMenu.GroupLabel.Props, 'className'> & {
  className?: string;
};
export function MenuGroupLabel({ className, ...rest }: MenuGroupLabelProps) {
  return <BaseMenu.GroupLabel className={cx('ll-menu-group-label', className)} {...rest} />;
}
