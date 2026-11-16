import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '../../../src/controls';
import { IconAlert, IconEye, IconMore, IconPlus, IconSearch, IconX } from '../../../src/icons';
import {
  Menu,
  MenuButton,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import './dropdown-demo.css';

/* 「下拉菜单」一块：全用库的下拉钮（选值的用槽、操作菜单用胶囊、只有图标的「⋯ ˅」），点开长开；钮很宽菜单很窄、靠边往上往左长、三十项的长菜单、
   自己给触发元素的（不长开）、各状态静态摆出来、键盘说明 */
/* 槽的最小宽度（--ll-dd-min）：让选值的钮像一个格子 */
const dd = (w: number) => ({ '--ll-dd-min': `${w}px` }) as CSSProperties;

const CONVS: [string, string][] = [
  ['星空观测站', '14:02'],
  ['周末打球', '昨天'],
  ['读书会', '周二'],
  ['推荐几部科幻小说', '周一'],
];

function General() {
  return (
    <Menu>
      <MenuButton data-menu="general">更多操作</MenuButton>
      <MenuContent>
        <MenuItem lead={<IconPlus />} hint="⌘N">
          新建对话
        </MenuItem>
        <MenuItem lead={<IconSearch />} hint="⌘K">
          搜索
        </MenuItem>
        <MenuItem lead={<IconEye />}>查看详情（后面是一段很长的字，会被省略号截断）</MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>更多</MenuGroupLabel>
          <MenuItem disabled>已经归档（禁用）</MenuItem>
          <MenuItem tone="danger" lead={<IconX />}>
            删除这个会话
          </MenuItem>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

function Current() {
  const [cur, setCur] = useState(CONVS[0][0]);
  return (
    <Menu>
      <MenuButton kind="slot" style={dd(168)} data-menu="current">
        {cur}
      </MenuButton>
      <MenuContent>
        {CONVS.map(([t, time]) => (
          <MenuItem key={t} current={t === cur} hint={time} onClick={() => setCur(t)}>
            {t}
          </MenuItem>
        ))}
        <MenuItem lead={<IconPlus />}>新对话</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Checks() {
  const [time, setTime] = useState(true);
  const [avatar, setAvatar] = useState(false);
  const [density, setDensity] = useState('std');
  return (
    <div className="sc-ov-cell">
      <Menu>
        <MenuButton data-menu="checks">勾选和单选</MenuButton>
        <MenuContent>
          <MenuCheckboxItem checked={time} onCheckedChange={setTime} closeOnClick={false}>
            显示时间
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={avatar} onCheckedChange={setAvatar} closeOnClick={false}>
            显示头像
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuRadioGroup value={density} onValueChange={(v) => setDensity(String(v))}>
            <MenuGroupLabel>密度</MenuGroupLabel>
            <MenuRadioItem value="tight" closeOnClick={false}>
              紧凑
            </MenuRadioItem>
            <MenuRadioItem value="std" closeOnClick={false}>
              标准
            </MenuRadioItem>
            <MenuRadioItem value="loose" closeOnClick={false}>
              宽松
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <span className="sc-ov-cap" data-demo="menu-checks-state">
        时间 {time ? '开' : '关'} · 头像 {avatar ? '开' : '关'} · 密度 {density}
      </span>
    </div>
  );
}

function Long() {
  return (
    <Menu>
      <MenuButton data-menu="long">三十项</MenuButton>
      <MenuContent>
        {Array.from({ length: 30 }, (_, i) => (
          <MenuItem key={i} hint={i % 5 === 0 ? `#${i + 1}` : undefined}>
            第 {i + 1} 项
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function Wide() {
  return (
    <Menu>
      <MenuButton kind="slot" data-menu="wide" style={{ maxWidth: 260 }}>
        推荐几部科幻小说，以及它们的后续讨论和书单整理
      </MenuButton>
      <MenuContent>
        <MenuItem>全部标为已读</MenuItem>
        <MenuItem>静音</MenuItem>
        <MenuItem tone="danger">离开</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Dots() {
  return (
    <Menu>
      <MenuButton icon aria-label="更多" data-menu="icon">
        <IconMore />
      </MenuButton>
      <MenuContent align="end">
        <MenuItem lead={<IconPlus />}>新建对话</MenuItem>
        <MenuItem lead={<IconSearch />}>搜索</MenuItem>
        <MenuSeparator />
        <MenuItem tone="danger" lead={<IconX />}>
          删除
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Own() {
  return (
    <Menu>
      <MenuTrigger render={<Button />} data-menu="own">
        自己给触发元素
      </MenuTrigger>
      <MenuContent>
        <MenuItem>用 MenuTrigger 加 render</MenuItem>
        <MenuItem>不是下拉钮，不长开</MenuItem>
        <MenuItem>淡入加一点缩放</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/* 用舞台自己当「边界」：钮靠着舞台的下边、右边，菜单就得往上、往左开（真页面里是视口的边） */
function Bound() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const items = (
    <>
      <MenuItem lead={<IconPlus />}>新建对话</MenuItem>
      <MenuItem lead={<IconSearch />}>搜索</MenuItem>
      <MenuItem>查看详情</MenuItem>
      <MenuItem>导出记录</MenuItem>
      <MenuItem tone="danger">删除</MenuItem>
    </>
  );
  const corner = (at: string, label: string) => (
    <div className="sc-dd-corner" data-at={at}>
      <Menu>
        <MenuButton data-menu={`bound-${at}`}>{label}</MenuButton>
        <MenuContent collisionBoundary={box ?? undefined}>{items}</MenuContent>
      </Menu>
    </div>
  );
  return (
    <div className="sc-dd-bound" ref={setBox} data-demo="menu-bound">
      {corner('tl', '靠左上')}
      {corner('tr', '靠右上')}
      {corner('bl', '靠下')}
      {corner('br', '靠右下')}
      <span className="sc-dd-bound-tag">虚线框当「视口」：钮靠哪边，菜单就往另一边开</span>
    </div>
  );
}

/* 各状态静态摆出来：不是真菜单（没有 Base UI），只是同样的类名和属性，方便一眼看清每种状态的样子 */
function Static({ nav }: { nav: 'keyboard' | 'pointer' }) {
  const Item = ({
    label,
    attrs,
    hint,
    lead,
  }: {
    label: string;
    attrs?: Record<string, string>;
    hint?: string;
    lead?: React.ReactNode;
  }) => (
    <div className="ll-menu-item ll-glide-item" role="presentation" {...attrs}>
      {lead && <span className="ll-menu-lead">{lead}</span>}
      <span className="ll-menu-label">{label}</span>
      {hint && <span className="ll-menu-hint">{hint}</span>}
    </div>
  );
  return (
    <div
      className="ll-glass ll-menu sc-ov-static"
      data-nav={nav}
      aria-hidden="true"
      data-demo={`menu-static-${nav}`}
    >
      <Item label="平常的一项" hint="⌘K" lead={<IconSearch />} />
      <Item label="键盘走到的一项（data-highlighted）" attrs={{ 'data-highlighted': '' }} />
      <Item
        label="现在就在这一项（aria-current）"
        attrs={{ 'aria-current': 'true' }}
        hint="14:02"
      />
      <Item label="危险的一项" attrs={{ 'data-tone': 'danger' }} lead={<IconAlert />} />
      <Item
        label="危险项被键盘走到"
        attrs={{ 'data-tone': 'danger', 'data-highlighted': '' }}
        lead={<IconAlert />}
      />
      <Item label="禁用的一项" attrs={{ 'data-disabled': '' }} />
    </div>
  );
}

export function MenuBlock() {
  return (
    <Group id="ov-menu" title="下拉菜单" sub="Menu · MenuButton · .ll-menu">
      <p className="sc-note">
        点一下下拉钮出来的一列操作，键盘走法是 Base UI 给的：方向键上下、到头循环、Home / End
        到头尾、输入首字母跳到那一项、Enter 或空格选中、Esc
        关；打开时焦点进菜单、关了回到钮。样子：玻璃面，圆角 16、内边距 6，项高 32、圆角 10（外 16
        减内边距 6，正好同心）。<b>菜单不锁页面滚动</b>（Base UI 默认锁，这里把 <code>modal</code>{' '}
        默认改成了 <code>false</code>）。
      </p>
      <p className="sc-note">
        用法：
        <code>
          &lt;Menu&gt;&lt;MenuButton kind
          icon&gt;…&lt;/MenuButton&gt;&lt;MenuContent&gt;&lt;MenuItem lead hint tone current&gt;…
        </code>
        。<code>MenuButton</code> 是库的下拉钮（见上一块「下拉钮」）：<code>kind</code>{' '}
        <code>pill</code>（默认，操作菜单）或 <code>slot</code>（选值），<code>icon</code>{' '}
        是只有图标的「⋯ ˅」。<code>MenuItem</code> 的 <code>lead</code> 是左边的图标、
        <code>hint</code> 是右边的小字、<code>tone="danger"</code> 是危险项、<code>current</code>{' '}
        是「现在就在这一项」（写成 aria-current）、<code>disabled</code> 禁用；勾选项{' '}
        <code>MenuCheckboxItem</code>、单选组 <code>MenuRadioGroup</code> 加{' '}
        <code>MenuRadioItem</code>，选中时右边一个勾；<code>MenuSeparator</code>、
        <code>MenuGroup</code>、<code>MenuGroupLabel</code>
        。不做：子菜单、带输入框筛选的菜单、右键菜单。
      </p>
      <p className="sc-note">
        <b>长开</b>
        ：用 <code>MenuButton</code>{' '}
        打开的菜单，钮自己的底长成菜单的底（大小、圆角、颜色、模糊、边光一起过渡），长到六成多时菜单项一个接一个轻轻落下来（错开有上限，三十项也不用等）；钮那一行留在菜单最上面当「头」，文字和箭头不动、箭头转过去。
        头是库画的：<code>MenuButton</code> 把自己的内容登记给同一个 <code>Menu</code>
        ，用的地方不用写两遍（头里是同一份内容的第二个实例，所以钮上放字、图标这种不带自己状态的东西）；要把头换成别的就给{' '}
        <code>MenuContent</code> 传 <code>head</code>
        （箭头也要自己画）。菜单盖在钮上而不是在钮下面：靠下的钮往上长，靠右的往左长，
        钮靠上、靠右时都留在视口里。菜单至少和钮一样宽（最窄 180）；钮上的字很长时菜单跟着钮宽，最宽
        320（钮比 320 还宽就跟钮）。 打开约 0.5 秒、关约 0.35 秒；<b>中途能反向</b>
        （正在开时再点一下钮或头、按
        Esc，从当前的样子掉头，不跳）。还没落下来的项点不到（鼠标穿过去点到后面的页面，键盘照常能走）。
        关了动画（上面的「动画」开关）时不长，整块只淡入淡出 0.12 秒。
        <b>不长开的</b>：触发元素是自己给的（<code>MenuTrigger</code> 加 <code>render</code>
        ），或几个按钮共用一个菜单（<code>createMenuHandle</code>）：照老样子淡入加一点缩放。
      </p>
      <p className="sc-note">
        <b>鼠标高亮和键盘高亮不叠在一起</b>
        ：鼠标移过去，一块带边光的高亮跟着从一项滑到另一项（和会话列表一样，关动画时每项自己淡入淡出）；
        键盘走到的那一项画一圈强调色的框加淡底，这时鼠标那块高亮藏起来。两种高亮在菜单上用{' '}
        <code>data-nav</code>{' '}
        区分（最近一次输入是谁）。鼠标停在一项上再按方向键，是从那一项接着走。长开时高亮要等内容出得差不多了才出现（内容还在淡入时鼠标已经在某一项上，不会先闪一块没有字的高亮）。
      </p>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="menu-basic">
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">
              操作菜单（pill）：图标、小字、危险项、禁用项、分隔线、分组标题
            </span>
            <General />
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">
              选值（slot）：带「现在这一项」，选了以后钮上的字跟着换
            </span>
            <Current />
          </div>
          <Checks />
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">三十项的长菜单（高度不超过可用高度，里面滚）</span>
            <Long />
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">钮上的字很长、菜单项很短：菜单至少和钮一样宽</span>
            <Wide />
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">只有图标（⋯ ˅），靠右对齐</span>
            <Dots />
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">自己给触发元素（MenuTrigger 加 render）：不长开</span>
            <Own />
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">靠边：往上长、往左长</h4>
      <Stage kind="page">
        <Bound />
      </Stage>
      <h4 className="sc-h4">各状态（静态摆出来的）</h4>
      <Stage kind="sky">
        <div className="sc-ov-row-demo">
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">键盘在走（data-nav=keyboard）</span>
            <Static nav="keyboard" />
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">鼠标在用（data-nav=pointer）：data-highlighted 不画</span>
            <Static nav="pointer" />
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">键盘怎么走</h4>
      <ul className="sc-note sc-ov-list">
        <li>
          焦点在下拉钮上：Enter、空格、↓ 打开，焦点进第一项；↑
          打开，焦点进最后一项。用鼠标打开时没有预选的项（鼠标移到哪一项高亮就到哪一项）。
        </li>
        <li>
          菜单里：↑ ↓ 走（到头循环），Home / End
          到第一项、最后一项，输入英文字母、数字跳到以它开头的项（连着输几个算一个词；用输入法打中文不行，输入法组词时拿不到单个的字），Enter
          或空格选中并关菜单，Esc 关。
        </li>
        <li>
          Tab
          关掉菜单，焦点往下一个可聚焦的元素走；关了（选中、Esc、点外面）焦点都回到下拉钮。禁用的项也走得到（Base
          UI 的做法：禁用只是选不中），要跳过它写在业务里。
        </li>
      </ul>
    </Group>
  );
}
