import type { CSSProperties } from 'react';

/* 对比块里「面板里真实用到这个值的东西」的样子：照面板里那个元素的样式画（尺寸、底、内边距、圆角都是面板现在的写法，
   只有被对比的那一个值由参数传进来）。只是示意的图，不是库的组件；类名都在 showcase.css 的「刻度的例子」一段。
   data-probe 是被对比的那个元素，QA 用它读计算值（border-radius、gap、padding） */

/* ---------- 圆角 ---------- */

/** 对话里选会话的菜单（.chat-menu）：玻璃底，里面几项（项自己的 9px 圆角照旧） */
export function MenuSample({ radius }: { radius: string }) {
  return (
    <div className="sc-s-menu" style={{ borderRadius: radius }} data-probe="">
      <div className="sc-s-menu-item is-on">星空观测站</div>
      <div className="sc-s-menu-item">周末打球</div>
      <div className="sc-s-menu-item">读书会</div>
    </div>
  );
}

/** 整理时从底部滑上来的收纳盒（.tray）：玻璃底，一个标签加几个收起来的胶囊 */
export function TraySample({ radius }: { radius: string }) {
  return (
    <div className="sc-s-tray" style={{ borderRadius: radius }} data-probe="">
      <span className="sc-s-tray-label">收纳盒</span>
      <span className="sc-s-minicap">设置</span>
      <span className="sc-s-minicap">任务</span>
    </div>
  );
}

/** 分段选择（.seg-ctl）：外框一个圆角，里面选中的按钮另一个圆角 */
export function SegSample({ outer, inner }: { outer: string; inner: string }) {
  return (
    <div className="sc-s-seg" style={{ borderRadius: outer }} data-probe="">
      <span>跟随系统</span>
      <span className="is-on" style={{ borderRadius: inner }} data-probe-inner="">
        开
      </span>
      <span>关</span>
    </div>
  );
}

/** 今日概况的能量槽（.energy，高 6px）和键盘焦点环（链接上的 .md-a:focus-visible）：两个都是很小的圆角 */
export function SmallSample({ radius }: { radius: string }) {
  return (
    <div className="sc-s-small">
      <div className="sc-s-energy" style={{ borderRadius: radius }} data-probe="">
        <i style={{ width: '62%', borderRadius: 'inherit' }} />
      </div>
      <span className="sc-s-focus" style={{ borderRadius: radius }} data-probe-focus="">
        https://example.com/sky
      </span>
    </div>
  );
}

/* ---------- 间距 ---------- */

/** 胶囊（.cap，收起来的部件）：右边的内边距 */
export function CapSample({ right }: { right: string }) {
  return (
    <div className="sc-s-cap" style={{ paddingRight: right }} data-probe="">
      <span className="sc-s-cap-icon" />
      <b>此刻</b>
      <span className="sc-dim">空闲</span>
    </div>
  );
}

/** 全屏的今日概况（.today.is-full）：几块内容之间的间距 */
export function TodaySample({ gap }: { gap: string }) {
  return (
    <div className="sc-s-today" style={{ gap }} data-probe="">
      <div className="sc-s-hero">
        <b>128</b>
        <span className="sc-dim">今天的回复</span>
      </div>
      <div className="sc-s-tiles">
        <div className="sc-s-tile">
          <small>输入</small>
          <b>1.2M</b>
        </div>
        <div className="sc-s-tile">
          <small>输出</small>
          <b>86K</b>
        </div>
      </div>
      <div className="sc-s-perconv">
        <span>读书会</span>
        <i style={{ width: '70%' }} />
      </div>
    </div>
  );
}

/** 会话列表的一行（.conv-item）：上下的内边距，几行叠在一起 */
export function ConvSample({ padV }: { padV: string }) {
  const rows: [string, string][] = [
    ['星空观测站', '小雨：我可以！'],
    ['周末打球', '胖虎：那就先按不下雨准备'],
    ['读书会', '洛璃：到点啦～ 记得带书'],
  ];
  return (
    <div className="sc-s-conv">
      {rows.map(([t, p], i) => (
        <div
          className="sc-s-convrow"
          key={t}
          style={{ paddingBlock: padV } as CSSProperties}
          data-probe={i === 0 ? '' : undefined}
        >
          <i className="sc-s-avatar" />
          <div>
            <b>{t}</b>
            <div className="sc-dim">{p}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 窗口的尺寸按钮（.chip）：左右的内边距 */
export function ChipsSample({ padX }: { padX: string }) {
  return (
    <div className="sc-s-chips">
      {['1×1', '2×1', '1×2', '2×2', '通栏'].map((t, i) => (
        <span
          className="sc-s-chip"
          key={t}
          style={{ paddingInline: padX }}
          data-probe={i === 0 ? '' : undefined}
        >
          {t}
        </span>
      ))}
    </div>
  );
}
