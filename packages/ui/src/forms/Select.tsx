import { Select as BaseSelect } from '@base-ui/react/select';
import {
  Fragment,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, Ref } from 'react';
import { cx } from '../controls/cx';
import { IconCheck } from '../icons';
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
} from '../overlay/grow';
import { useGlide } from '../scroll/glide';
import { useFormConfig } from './config';
import type { FormSize } from './config';

/* 下拉选择 Select：Base UI 的 Select（键盘、输入首字母跳到那一项、读屏的 listbox 角色、接 Field 的校验和表单提交都是它给的）。
   打开它的钮就是库的下拉钮的「槽」（.ll-dd，data-kind='slot'）加小箭头，打开时用「长开」（钮的底长成浮层的底，约 0.5 秒；见 overlay/grow.css）：
   和菜单、弹出框共用同一套零件（overlay/grow.tsx 的 useGrowRoot、useRegisterFace、useGrowPopup、GrowHead），浮层的样子（玻璃面、项、悬停高亮、键盘高亮）
   用菜单的类名（.ll-menu、.ll-menu-list、.ll-menu-item），所以 Select 打开来和选会话的菜单是一个样子，只是项右边多一个勾（当前项）。
   - 选项：options 是 { value, label, disabled?, hint? } 的数组；要分组就给 { label, options } 的数组（标题是组名，组之间有一道细线）；
   - 选项多了：浮层高度限在可用高度里，里面滚（库的细滚动条）；
   - 位置：Base UI 的 Select 默认让浮层盖住钮、把选中那一项和钮上的字对齐（alignItemWithTrigger），这里关掉：长开要的是「浮层的上边和钮的上边对齐」，
     所以只往下、往上开（放不下整块时留在原来那一侧、里面滚，不翻到左右）；
   - 不是模态的（modal=false）：页面不锁滚动、不因为浮层多出一条滚动条而抖，和菜单一致；
   - placeholder：没选时钮上写的字（淡色）；value 是选项的 value，没选是 null；onValueChange 只给新的 value。
   其余属性（name、required、disabled、readOnly、id、aria-label……）见 Base UI。 */
export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** 右边的小字（说明、快捷键……） */
  hint?: ReactNode;
}
export interface SelectGroup {
  label: string;
  options: readonly SelectOption[];
}
export type SelectItems = readonly (SelectOption | SelectGroup)[];

const isGroup = (x: SelectOption | SelectGroup): x is SelectGroup => 'options' in x;

/** 把选项（可能带分组）摊平成一维：Base UI 用它把 value 对到 label */
export function flattenOptions(items: SelectItems): SelectOption[] {
  return items.flatMap((x) => (isGroup(x) ? [...x.options] : [x]));
}

export interface SelectProps {
  options: SelectItems;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  size?: FormSize;
  className?: string;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  'aria-label'?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 浮层放哪（默认 <body>） */
  container?: HTMLElement | null | React.RefObject<HTMLElement | null>;
  ref?: Ref<HTMLButtonElement>;
}

type OpenDetails = BaseSelect.Root.OpenChangeEventDetails;

const NO_REF = { current: null };

/* 长开写在浮层上的东西（data-ready、量出来的位置差、起点的颜色），浮层不在开着、也不在关的过程中时清掉 */
const GROW_PROPS = [
  '--ll-grow-w',
  '--ll-grow-h',
  '--ll-grow-dx',
  '--ll-grow-dy',
  '--ll-grow-bg0',
  '--ll-grow-fg0',
  '--ll-grow-edge0',
];

/* 浮层的窗体：长开的（有登记的槽）是「面 + 头 + 列表」三层，没有登记（理论上不会出现）退回平常的玻璃面。
   active：浮层在开着或者关的动画还没走完。Base UI 的 Select 和菜单不一样：钮第一次得到焦点以后浮层就一直挂在页面里（藏着，为了钮上直接打字能选），
   不是开一次挂一次、关完卸载；所以长开的零件（量位置、藏钮）只在 active 时才跑，不然钮一得到焦点就被藏起来了；
   不 active 了要把上一次写在浮层上的 data-ready 等清掉，下一次打开才是从头长。 */
function SelectPopup({ children, active }: { children: ReactNode; active: boolean }) {
  const live = useContext(GrowLiveCtx);
  const api = useContext(GrowApiCtx);
  const face = live.face;
  const grow = face !== null && api !== null;
  const g = useGlide('.ll-menu-item:not([data-disabled])');
  const popRef = useRef<HTMLDivElement | null>(null);
  const hot = useGrowPopup(popRef, api?.triggerRef ?? NO_REF, face?.node, grow && active);
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (active || !pop) return;
    pop.removeAttribute('data-ready');
    pop.removeAttribute('data-seed');
    for (const p of GROW_PROPS) pop.style.removeProperty(p);
  }, [active]);
  const [nav, setNav] = useState<'keyboard' | 'pointer'>('keyboard');
  const setPopup = useCallback(
    (el: HTMLDivElement | null) => {
      popRef.current = el;
      if (!grow) g.list.current = el;
    },
    [grow, g.list],
  );
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      if (grow) g.list.current = el;
    },
    [grow, g.list],
  );
  const setGlide = useCallback(
    (el: HTMLElement | null) => {
      g.glide.current = el;
    },
    [g.glide],
  );
  return (
    <BaseSelect.Popup
      ref={setPopup}
      className={
        grow ? 'll-menu ll-grow ll-select-popup' : 'll-glass ll-menu ll-select-popup ll-scrollbar'
      }
      data-nav={nav}
      data-kind={face?.kind}
      data-size={face?.size}
      data-hot={grow && hot ? '' : undefined}
      onKeyDown={() => setNav('keyboard')}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse' && (e.movementX !== 0 || e.movementY !== 0))
          setNav('pointer');
      }}
      onPointerDown={() => setNav('pointer')}
    >
      {grow && (
        <>
          <i className="ll-grow-surf" aria-hidden="true" />
          <GrowHead face={face} />
        </>
      )}
      <BaseSelect.List ref={setList} className={grow ? 'll-menu-list ll-scrollbar' : undefined}>
        <i className="ll-glide" ref={setGlide} aria-hidden="true" />
        {children}
      </BaseSelect.List>
    </BaseSelect.Popup>
  );
}

function Item({ o }: { o: SelectOption }) {
  return (
    <BaseSelect.Item
      value={o.value}
      disabled={o.disabled}
      className="ll-menu-item ll-glide-item ll-select-item"
    >
      <BaseSelect.ItemText className="ll-menu-label">{o.label}</BaseSelect.ItemText>
      {o.hint != null && <span className="ll-menu-hint">{o.hint}</span>}
      <BaseSelect.ItemIndicator className="ll-menu-tick">
        <IconCheck />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

/** 长开只往上、往下：上下都放不下整块内容时留在原来那一侧、里面滚，不翻到左右（和菜单一样） */
const COLLISION = { fallbackAxisSide: 'none' } as const;

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  size,
  className,
  invalid,
  disabled,
  readOnly,
  required,
  name,
  id,
  'aria-label': ariaLabel,
  open,
  defaultOpen,
  onOpenChange,
  container,
  ref,
}: SelectProps) {
  const cfg = useFormConfig({ size });
  const flat = useMemo(() => flattenOptions(options), [options]);
  /* 浮层在不在「开着或关的动画还没走完」：打开时置为 true，Base UI 报告关完了（onOpenChangeComplete(false)）时置为 false */
  const [active, setActive] = useState(!!(open ?? defaultOpen));
  const grow = useGrowRoot<OpenDetails>({
    open,
    defaultOpen,
    onOpenChange: (o) => {
      if (o) setActive(true);
      onOpenChange?.(o);
    },
    onOpenChangeComplete: (o) => {
      if (!o) setActive(false);
    },
    enabled: true,
  });
  return (
    <GrowProviders root={grow}>
      <BaseSelect.Root
        modal={false}
        items={flat}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(v) => onValueChange?.(v as string | null)}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        name={name}
        id={id}
        {...grow.rootProps}
      >
        <SelectTrigger
          ref={ref}
          size={cfg.size}
          className={className}
          invalid={invalid}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
        />
        <BaseSelect.Portal container={container}>
          <BaseSelect.Positioner
            className="ll-menu-pos"
            alignItemWithTrigger={false}
            side="bottom"
            align="start"
            sideOffset={overlapAnchor}
            collisionPadding={8}
            collisionAvoidance={COLLISION}
          >
            <SelectPopup active={active || grow.live.open}>
              {options.map((x, i) =>
                isGroup(x) ? (
                  <Fragment key={`g${i}`}>
                    {i > 0 && <BaseSelect.Separator className="ll-menu-sep" />}
                    <BaseSelect.Group className="ll-menu-group">
                      <BaseSelect.GroupLabel className="ll-menu-group-label">
                        {x.label}
                      </BaseSelect.GroupLabel>
                      {x.options.map((o) => (
                        <Item key={o.value} o={o} />
                      ))}
                    </BaseSelect.Group>
                  </Fragment>
                ) : (
                  <Item key={x.value} o={x} />
                ),
              )}
            </SelectPopup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </GrowProviders>
  );
}

function SelectTrigger({
  size,
  className,
  invalid,
  placeholder,
  ariaLabel,
  ref,
}: {
  size: FormSize;
  className?: string;
  invalid?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  /* 钮里的内容（头里再画一份）：Select.Value 自己读选中的是哪一项，两个实例各读各的，所以头和钮上的字总是一样；
     用 useMemo 让它在 placeholder 不变时是同一个元素，不用每次渲染都重新登记、重新量 */
  const node = useMemo(() => <BaseSelect.Value placeholder={placeholder} />, [placeholder]);
  const setTrigger = useRegisterFace({ kind: 'slot', size, icon: false, node });
  const setRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      setTrigger(el);
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [setTrigger, ref],
  );
  return (
    <BaseSelect.Trigger
      ref={setRefs}
      className={cx('ll-dd ll-select', className)}
      data-kind="slot"
      data-size={size}
      data-invalid={invalid ? '' : undefined}
      aria-label={ariaLabel}
      aria-invalid={invalid ? true : undefined}
    >
      <DropdownFace>{node}</DropdownFace>
    </BaseSelect.Trigger>
  );
}
