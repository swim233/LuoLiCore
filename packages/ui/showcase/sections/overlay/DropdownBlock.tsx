import { Button, Chevron } from '../../../src/controls';
import { IconMore } from '../../../src/icons';
import {
  Menu,
  MenuButton,
  MenuContent,
  MenuItem,
  Popover,
  PopoverButton,
  PopoverContent,
  PopoverDescription,
} from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import './dropdown-demo.css';

/* 「下拉钮」一块：库里专门用来打开菜单、弹出框的钮（MenuButton、PopoverButton）长什么样：两种、只有图标的、五种状态。
   这里摆的是静态的（同样的类名和属性，不是真菜单），好并排看；真的能点开的在「下拉菜单」「弹出框」两块里。 */
const STATE_COLS: readonly (readonly [string, string])[] = [
  ['rest', '平时'],
  ['hover', '悬停'],
  ['focus', '键盘焦点'],
  ['open', '打开着'],
  ['disabled', '禁用'],
];
type Kind = 'pill' | 'slot';
type Size = 'xs' | 'sm' | 'md' | 'lg';
const SIZES: readonly (readonly [Size, string])[] = [
  ['xs', 'xs 18'],
  ['sm', 'sm 22'],
  ['md', 'md 28（默认）'],
  ['lg', 'lg 32'],
];

function Static({
  kind,
  state,
  icon,
  size = 'md',
}: {
  kind: Kind;
  state: string;
  icon?: boolean;
  size?: Size;
}) {
  const cls =
    'll-dd' + (state === 'hover' ? ' sc-dd-hover' : '') + (state === 'focus' ? ' sc-dd-focus' : '');
  return (
    <button
      type="button"
      className={cls}
      data-kind={kind}
      data-size={size}
      data-icon={icon ? '' : undefined}
      aria-expanded={state === 'open' ? 'true' : 'false'}
      disabled={state === 'disabled'}
      tabIndex={-1}
      style={
        !icon && kind === 'slot' ? ({ '--ll-dd-min': '150px' } as React.CSSProperties) : undefined
      }
    >
      <span className="ll-dd-main">{icon ? <IconMore /> : '星空观测站'}</span>
      <Chevron dir="down" className="ll-dd-chev" />
    </button>
  );
}

export function DropdownBlock() {
  const rows: [Kind, boolean, string][] = [
    ['pill', false, 'pill 胶囊（带字）'],
    ['pill', true, 'pill 胶囊（只有图标）'],
    ['slot', false, 'slot 槽（带字）'],
    ['slot', true, 'slot 槽（只有图标）'],
  ];
  return (
    <Group id="ov-dd" title="下拉钮" sub="MenuButton · PopoverButton · .ll-dd">
      <p className="sc-note">
        打开菜单、弹出框的钮，专门做了一种样子，和普通按钮（<code>Button</code>
        ，没有边的有底色的胶囊）分得开：右边有一个小箭头，打开着箭头朝上。<code>MenuButton</code>、
        <code>PopoverButton</code> 放在 <code>&lt;Menu&gt;</code>、<code>&lt;Popover&gt;</code>{' '}
        里面代替 <code>MenuTrigger</code>、<code>PopoverTrigger</code>。两种：
        <b>pill 胶囊</b>（默认）用在「做一件事」的操作菜单上（「更多操作」「3 个任务」）；
        <b>slot 槽</b>
        用在「选一个值」上（钮上写着现在选的是哪个，比如选会话），凹进去的一格，更像表单里的选择框；
        <code>icon</code> 是钮上只有一个图标（「⋯
        ˅」：图标加紧挨着的小箭头，不用圆钮）。槽想像格子可以给最小宽度：
        <code>--ll-dd-min</code>。
      </p>
      <p className="sc-note">
        <b>四档尺寸</b>（<code>size</code>：xs、sm、md 默认、lg）和 <code>Button</code>{' '}
        的四档一样：高
        18、22、28、32，字号、左右内边距都对齐（下面一排摆在一起看是齐的）。槽的圆角随尺寸：xs 4、sm
        6、md 和 lg 10；图标 xs 12、其余 14，只有图标时 xs 12、sm 14、md 和 lg
        16。长开时头那一行跟着钮的尺寸。
      </p>
      <p className="sc-note">
        用它打开的菜单、弹出框会<b>长开</b>
        ：钮自己的底长成浮层的底，然后内容才出来；钮那一行留在浮层最上面当头。用法的细节见「下拉菜单」。
        钮上没有「按下」的样子（点下去的那一刻浮层就开始长了，按下的样子只会让钮和头对不上）。
      </p>
      <Stage kind="sky">
        <div className="sc-dd-states" data-demo="dd-states">
          <span />
          {STATE_COLS.map(([k, label]) => (
            <span key={k}>{label}</span>
          ))}
          {rows.map(([kind, icon, label]) => (
            <StateRow key={label} kind={kind} icon={icon} label={label} />
          ))}
        </div>
      </Stage>
      <h4 className="sc-h4">四档尺寸：和 Button 摆在一排（下拉钮都是真的，能点开）</h4>
      <Stage kind="sky">
        <div className="sc-dd-sizes" data-demo="dd-sizes">
          {SIZES.map(([size, label]) => (
            <div className="sc-dd-sizes-row" key={size} data-size-row={size}>
              <span>{label}</span>
              <Button size={size}>按钮</Button>
              <Live kind="pill" size={size} />
              <Live kind="pill" size={size} icon />
              <Live kind="slot" size={size} />
              <Live kind="slot" size={size} icon />
              <LivePop size={size} />
              <Button size={size} variant="primary">
                确定
              </Button>
            </div>
          ))}
        </div>
      </Stage>
    </Group>
  );
}

/* 四档尺寸那一排里真的能点开的钮 */
function Live({ kind, size, icon }: { kind: Kind; size: Size; icon?: boolean }) {
  return (
    <Menu>
      <MenuButton
        kind={kind}
        size={size}
        icon={icon}
        aria-label={icon ? '更多' : undefined}
        data-dd={`${kind}-${size}${icon ? '-icon' : ''}`}
        style={
          !icon && kind === 'slot' ? ({ '--ll-dd-min': '120px' } as React.CSSProperties) : undefined
        }
      >
        {icon ? <IconMore /> : '星空观测站'}
      </MenuButton>
      <MenuContent align={icon ? 'end' : 'start'}>
        <MenuItem>第一项</MenuItem>
        <MenuItem>第二项</MenuItem>
        <MenuItem>第三项</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function LivePop({ size }: { size: Size }) {
  return (
    <Popover>
      <PopoverButton size={size} data-dd={`pop-${size}`}>
        3 个任务
      </PopoverButton>
      <PopoverContent>
        <PopoverDescription>弹出框也一样：头那一行跟着钮的尺寸。</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}

function StateRow({ kind, icon, label }: { kind: Kind; icon: boolean; label: string }) {
  return (
    <>
      <span>{label}</span>
      {STATE_COLS.map(([k]) => (
        <Static key={k} kind={kind} state={k} icon={icon} />
      ))}
    </>
  );
}
