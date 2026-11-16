import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Dot, RowButton, Switch } from '../../../src/controls';
import {
  Popover,
  PopoverButton,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  createPopoverHandle,
} from '../../../src/overlay';
import type { PopoverContentProps } from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import './dropdown-demo.css';

/* 「弹出框」一块：用下拉钮点开的（长开）、悬停打开的和不接鼠标的（不长开）、四个方向三种对齐、长开的对齐、内容很长、贴边翻面、多个按钮共用一个 */
const SIDES: readonly [NonNullable<PopoverContentProps['side']>, string][] = [
  ['top', '上'],
  ['right', '右'],
  ['bottom', '下'],
  ['left', '左'],
];
const ALIGNS: readonly [NonNullable<PopoverContentProps['align']>, string][] = [
  ['start', '起'],
  ['center', '中'],
  ['end', '末'],
];

function Rows() {
  return (
    <>
      <PopoverTitle>各群的状态</PopoverTitle>
      {[
        ['tool', '星空观测站', '调用工具'],
        ['star', '周末打球', '回复中'],
        ['', '读书会', '空闲'],
      ].map(([tone, name, st]) => (
        <div className="sc-ov-row" key={name}>
          <Dot tone={(tone || undefined) as 'tool' | 'star' | undefined} />
          <b>{name}</b>
          <span>{st}</span>
        </div>
      ))}
    </>
  );
}

const shared = createPopoverHandle<string>();

function Edge() {
  return (
    <div className="sc-ov-edge" data-demo="pop-edge">
      <Popover>
        <PopoverButton data-edge="br">右下角，向下</PopoverButton>
        <PopoverContent side="bottom" align="end">
          <PopoverTitle>向下放不下</PopoverTitle>
          <PopoverDescription>
            触发按钮贴着视口的下边缘，下面放不下，自动翻到上面。
          </PopoverDescription>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button size="sm" data-edge="r" />}>右边，向右</PopoverTrigger>
        <PopoverContent side="right" align="center">
          <PopoverTitle>向右放不下</PopoverTitle>
          <PopoverDescription>触发按钮贴着视口的右边缘，自动翻到左边。</PopoverDescription>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverButton data-edge="bl">左下角，向下</PopoverButton>
        <PopoverContent side="bottom" align="start">
          <PopoverTitle>向下放不下</PopoverTitle>
          <PopoverDescription>翻到上面；左边留着 8 像素的边距，不会贴到视口上。</PopoverDescription>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function PopoverBlock() {
  const [edge, setEdge] = useState(false);
  return (
    <Group id="ov-popover" title="弹出框" sub="Popover · .ll-popover">
      <p className="sc-note">
        点一下（或悬停）触发按钮出来的一小块浮层，放说明、几个状态、一两个选项。点外面、按 Esc
        关，打开时焦点进去、关了回到按钮（Base UI 给的）。样子是玻璃面，圆角 16、内边距
        12，宽度不超过 <code>min(320px, 可用宽度)</code>
        ，高度不超过可用高度、超出的在里面滚。悬停打开只认鼠标真的在动：页面变了、按钮正好跑到不动的鼠标底下（比如退出全屏）时，它不会自己弹出来；鼠标在按钮上轻轻动一下就出（被拦下以后，只要鼠标还在按钮上、之后来了一次带位移的移动，库就补开），不用挪出去再移进来。
      </p>
      <p className="sc-note">
        <b>长开</b>
        ：用库的下拉钮 <code>PopoverButton</code>（放在 <code>&lt;Popover&gt;</code> 里面，代替{' '}
        <code>PopoverTrigger</code>，参数同 <code>MenuButton</code>：<code>kind</code>、
        <code>icon</code>
        ）点开的弹出框，钮自己的底长成弹出框的底，约 0.5 秒（关约 0.35
        秒），然后里面的内容整块淡入、落下一点（弹出框是整块内容，不像菜单一项项错开）；钮那一行留在弹出框最上面当头，
        头和菜单一样由库画（<code>PopoverContent</code> 的 <code>head</code>{' '}
        可以换掉）。中途能反向；还没出来的内容点不到。上边和钮的上边对齐（往上开时下边对下边），
        <code>align</code> 默认 <code>start</code>。关了动画时整块淡入淡出 0.12 秒。
        <b>不长开的</b>：悬停打开的（<code>PopoverTrigger</code> 的 <code>openOnHover</code>、根的{' '}
        <code>hoverOnly</code>）、不接鼠标的（<code>passive</code>）、几个按钮共用一个弹出框的（
        <code>handle</code>）、触发元素自己给的（<code>PopoverTrigger</code> 加 <code>render</code>
        ）、往左右开的、给了别的 <code>anchor</code> 的：照老样子，0.14 秒、0.1
        秒的淡入淡出加一点缩放（从触发按钮那一侧缩放）。
      </p>
      <p className="sc-note">
        用法：
        <code>
          &lt;Popover&gt;&lt;PopoverButton&gt;…&lt;/PopoverButton&gt;&lt;PopoverContent&gt;…&lt;/PopoverContent&gt;&lt;/Popover&gt;
        </code>
        。<code>PopoverContent</code> 把 Portal、Positioner、Popup 合成了一个：<code>side</code>、
        <code>align</code>、<code>sideOffset</code>（默认 8）、<code>alignOffset</code>、
        <code>collisionPadding</code>（默认 8）、<code>anchor</code> 给定位，<code>container</code>{' '}
        指到某个元素里浮层就留在那里面（见「在窗口里」），其余给弹出框本身（
        <code>initialFocus</code>、<code>finalFocus</code>
        ……）。触发按钮不在根里面、或几个按钮共用一个弹出框：
        <code>createPopoverHandle()</code> 造一个 handle，根和每个触发按钮都传它（带{' '}
        <code>payload</code>）。
        <code>PopoverTrigger</code> 没有样式，要库的按钮就 <code>render</code> 成{' '}
        <code>Button</code>。
      </p>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="pop-basic">
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">点开的（下拉钮，长开）：标题、说明、关闭</span>
            <Popover>
              <PopoverButton data-pop="click">点开弹出框</PopoverButton>
              <PopoverContent>
                <PopoverTitle>删除之前</PopoverTitle>
                <PopoverDescription>
                  这个会话的全部消息都会一起删掉。点外面或按 Esc 可以关掉这块浮层，什么都不会发生。
                </PopoverDescription>
                <div className="sc-ov-actions">
                  <PopoverClose render={<Button size="sm" />}>知道了</PopoverClose>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">
              悬停打开的（延迟 200 毫秒，不长开）：悬停打开以后再点一下，它会粘住
            </span>
            <Popover>
              <PopoverTrigger
                openOnHover
                delay={200}
                closeDelay={100}
                render={<Button variant="glass" />}
                data-pop="hover"
              >
                悬停看各群状态
              </PopoverTrigger>
              <PopoverContent>
                <Rows />
              </PopoverContent>
            </Popover>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">
              悬停打开、不接鼠标（passive）、只认悬停（hoverOnly），不长开
            </span>
            <Popover hoverOnly>
              <PopoverTrigger
                openOnHover
                delay={200}
                render={<Button variant="glass" />}
                data-pop="passive"
              >
                悬停（不接鼠标）
              </PopoverTrigger>
              <PopoverContent passive>
                <Rows />
              </PopoverContent>
            </Popover>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">里面是一列行（长开）：glide 给它悬停的滑动高亮</span>
            <Popover>
              <PopoverButton data-pop="glide">一列行</PopoverButton>
              <PopoverContent
                glide=".ll-row"
                style={{ width: 300, '--ll-popover-pad': '6px' } as CSSProperties}
              >
                {[
                  ['提醒大家周日晚上聊聊这周读到的章节', '每周日 20:00'],
                  ['提醒大家周六下午 3 点聚会', '11-16 10:00'],
                  ['提醒小雨早点睡', '每天 22:30'],
                ].map(([t, sub]) => (
                  <RowButton key={t} title={t} sub={sub} />
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">四个方向、三种对齐（不长开的：用 PopoverTrigger 加 Button）</h4>
      <Stage kind="page">
        <div className="sc-ov-grid" data-demo="pop-grid">
          {SIDES.map(([side, sn]) =>
            ALIGNS.map(([align, an]) => (
              <Popover key={`${side}-${align}`}>
                <PopoverTrigger render={<Button size="sm" variant="soft" />}>
                  {sn}·{an}
                </PopoverTrigger>
                <PopoverContent side={side} align={align}>
                  <PopoverDescription>
                    side={side}，align={align}
                  </PopoverDescription>
                </PopoverContent>
              </Popover>
            )),
          )}
        </div>
      </Stage>
      <h4 className="sc-h4">长开的：对齐、往上往下</h4>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="pop-grow-align">
          {(
            [
              ['start', 'bottom', '起·下'],
              ['center', 'bottom', '中·下'],
              ['end', 'bottom', '末·下'],
              ['start', 'top', '起·上'],
              ['end', 'top', '末·上'],
            ] as const
          ).map(([align, side, label]) => (
            <Popover key={`${side}-${align}`}>
              <PopoverButton data-pop={`grow-${side}-${align}`}>{label}</PopoverButton>
              <PopoverContent side={side} align={align}>
                <PopoverTitle>
                  {side}·{align}
                </PopoverTitle>
                <PopoverDescription>
                  长开的弹出框上边（往上开时下边）和钮的边对齐，align
                  决定对齐钮的左边、中间还是右边。
                </PopoverDescription>
              </PopoverContent>
            </Popover>
          ))}
          <span className="sc-dd-cap">
            往左右开（side=left、right）和给了别的 anchor 的，不长开，照上面「四个方向」那样淡入。
          </span>
        </div>
      </Stage>
      <h4 className="sc-h4">内容很长，自己滚</h4>
      <Stage kind="page">
        <div className="sc-ov-row-demo">
          <Popover>
            <PopoverButton data-pop="long">很长的内容</PopoverButton>
            <PopoverContent>
              <PopoverTitle>四十行</PopoverTitle>
              {Array.from({ length: 40 }, (_, i) => (
                <p className="sc-ov-p" key={i}>
                  第 {i + 1} 行：高度超过可用高度的部分在弹出框里面滚，不会伸出视口。
                </p>
              ))}
            </PopoverContent>
          </Popover>
          <Popover handle={shared}>
            {({ payload }) => (
              <PopoverContent>
                <PopoverTitle>共用的弹出框</PopoverTitle>
                <PopoverDescription>
                  这是第「{payload}」个按钮打开的：每个触发按钮带自己的 payload，内容跟着换。
                </PopoverDescription>
              </PopoverContent>
            )}
          </Popover>
          <PopoverTrigger handle={shared} payload="一" render={<Button size="sm" />}>
            共用·一
          </PopoverTrigger>
          <PopoverTrigger handle={shared} payload="二" render={<Button size="sm" />}>
            共用·二
          </PopoverTrigger>
          <span className="sc-ov-cap">（两个触发按钮共用一个根，用 handle 连起来）</span>
        </div>
      </Stage>
      <h4 className="sc-h4">贴着视口边缘：会翻面、会挪</h4>
      <p className="sc-note">
        打开下面的开关，视口的右下角、右边、左下角各出现一个试验按钮（固定在视口上，开关关掉就消失；两个在下面的是下拉钮，长开，右边的是往右开的、不长开）。点开看：下面放不下翻到上面（长开的就往上长），右边放不下翻到左边，贴边时留
        8 像素的边距。
      </p>
      <div className="sc-pill-row">
        <Switch
          checked={edge}
          onChange={setEdge}
          label="显示贴着视口边缘的试验按钮"
          data-demo="pop-edge-switch"
        />
      </div>
      {edge && <Edge />}
    </Group>
  );
}
