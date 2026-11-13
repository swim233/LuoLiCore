import { useState } from 'react';
import '../legacy/controls.css';
import { Seg } from '../components/Seg';
import { SectionHead } from '../components/SectionHead';
import type { StageKind } from '../components/Stage';
import { ButtonBlock, IconButtonBlock } from './controls/ButtonBlocks';
import { ChangesTable } from './controls/ChangesTable';
import { IconsBlock } from './controls/IconsBlock';
import { BadgeBlock, ChevronBlock, DotBlock, SpinnerBlock, TagBlock } from './controls/MarkBlocks';
import { StageCtx } from './controls/shared';
import { ConfirmBlock, SegBlock, SwitchBlock } from './controls/ToggleBlocks';

/* 第四节「基础控件」（第 4 步）：按钮、图标按钮、开关、分段选择、两步确认的按钮、标签、数字徽标、状态点、转圈、小箭头、图标。
   每个控件一块：所有样子 × 尺寸、各种状态（悬停和键盘焦点强制显示）、能点的演示、和面板现在写法的对比；
   最后一块是「面板上会变的地方」（请用户点头的清单）。左边的「现在」用的旧样式抄在 legacy/ 下（4b 结束时删掉）。 */
const INDEX: readonly (readonly [string, string])[] = [
  ['ctl-button', '按钮'],
  ['ctl-icon-button', '图标按钮'],
  ['ctl-switch', '开关'],
  ['ctl-seg', '分段选择'],
  ['ctl-confirm', '两步确认'],
  ['ctl-tag', '标签'],
  ['ctl-badge', '数字徽标'],
  ['ctl-dot', '状态点'],
  ['ctl-spin', '转圈'],
  ['ctl-chev', '小箭头'],
  ['ctl-icons', '图标'],
  ['ctl-changes', '面板上会变的地方'],
];

export function Controls() {
  const [kind, setKind] = useState<StageKind>('sky');
  return (
    <StageCtx.Provider value={kind}>
      <SectionHead title="基础控件">
        第 4
        步的第一段（4a）：控件在库里做好了，面板还没有换；你看过、点头以后才会换到面板上。每个控件下面有和面板现在的对比（左边是面板里的旧样式原样，右边是库的组件），
        最后一块是「面板上会变的地方」的清单。
      </SectionHead>
      <div className="sc-ctl-bar">
        <div className="sc-bar-group">
          <span className="sc-bar-label">舞台的底</span>
          <Seg<StageKind>
            label="舞台的底"
            value={kind}
            items={[
              ['page', '页面底'],
              ['sky', '夜空窗口'],
            ]}
            onPick={setKind}
          />
        </div>
        <nav className="sc-ctl-index" aria-label="这一节里的块" data-index="">
          {INDEX.map(([id, name]) => (
            <button
              key={id}
              type="button"
              className={id === 'ctl-changes' ? 'is-key' : undefined}
              onClick={() =>
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {name}
            </button>
          ))}
        </nav>
      </div>
      <ButtonBlock />
      <IconButtonBlock />
      <SwitchBlock />
      <SegBlock />
      <ConfirmBlock />
      <TagBlock />
      <BadgeBlock />
      <DotBlock />
      <SpinnerBlock />
      <ChevronBlock />
      <IconsBlock />
      <ChangesTable />
    </StageCtx.Provider>
  );
}
