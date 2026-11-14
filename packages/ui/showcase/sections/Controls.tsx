import { useState } from 'react';
import { Seg } from '../components/Seg';
import { SectionHead } from '../components/SectionHead';
import type { StageKind } from '../components/Stage';
import { ButtonBlock, IconButtonBlock } from './controls/ButtonBlocks';
import { FieldBlock, LinkBlock } from './controls/FormBlocks';
import { FoldBlock } from './controls/FoldBlocks';
import { IconsBlock } from './controls/IconsBlock';
import { BadgeBlock, ChevronBlock, DotBlock, SpinnerBlock, TagBlock } from './controls/MarkBlocks';
import { EmptyBlock, NoticeBlock, SkeletonBlock } from './controls/NoticeBlocks';
import { StageCtx } from './controls/shared';
import { RowBlock } from './controls/RowBlocks';
import { SmallBlock } from './controls/SmallBlocks';
import { MeterBlock, RollBlock, StatBlock } from './controls/StatBlocks';
import { TabsBlock } from './controls/TabBlocks';
import { ConfirmBlock, SegBlock, SwitchBlock } from './controls/ToggleBlocks';

/* 「基础控件」一节：按钮、图标按钮、开关、分段选择、两步确认的按钮、标签、数字徽标、状态点、转圈、小箭头、图标，
   提示条、空状态、骨架条、表单项、链接、统计格、数字滚动、能量槽，折叠、标签页、列表行、几样小件（面板都在用）。
   每个控件一块：所有样子 × 尺寸、各种状态（悬停和键盘焦点强制显示）、能点的演示。 */
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
  ['ctl-notice', '提示条'],
  ['ctl-empty', '空状态'],
  ['ctl-skeleton', '骨架条'],
  ['ctl-field', '表单项'],
  ['ctl-link', '链接'],
  ['ctl-stat', '统计格'],
  ['ctl-roll', '数字滚动'],
  ['ctl-meter', '能量槽'],
  ['ctl-fold', '折叠'],
  ['ctl-tabs', '标签页'],
  ['ctl-row', '列表行'],
  ['ctl-small', '小件'],
];

export function Controls() {
  const [kind, setKind] = useState<StageKind>('sky');
  return (
    <StageCtx.Provider value={kind}>
      <SectionHead title="基础控件">
        面板里用到的基础控件都在这里，一个控件一块：所有样子 ×
        尺寸、各种状态（悬停和键盘焦点是强制显示的）、能点的演示。
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
      <NoticeBlock />
      <EmptyBlock />
      <SkeletonBlock />
      <FieldBlock />
      <LinkBlock />
      <StatBlock />
      <RollBlock />
      <MeterBlock />
      <FoldBlock />
      <TabsBlock />
      <RowBlock />
      <SmallBlock />
    </StageCtx.Provider>
  );
}
