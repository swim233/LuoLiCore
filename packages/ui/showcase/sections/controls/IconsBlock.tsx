import type { ComponentType, SVGProps } from 'react';
import {
  IconAlert,
  IconArrange,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconEye,
  IconEyeOff,
  IconGrip,
  IconInfo,
  IconMax,
  IconMin,
  IconMinus,
  IconMore,
  IconPlus,
  IconRestore,
  IconSearch,
  IconX,
  Star4,
} from '../../../src/icons';
import { CopyName } from '../../components/CopyName';
import { Stage } from '../../components/Stage';
import { Group, useStageKind } from './shared';

/* 「图标」一块：一格一个，名字、来源；新抄的 Lucide 和面板手写的摆在一起，看粗细是不是一家 */
type Icon = ComponentType<SVGProps<SVGSVGElement>>;
const HAND: readonly (readonly [string, string, Icon])[] = [
  ['Star4', '四角星', Star4],
  ['IconMin', '缩小', IconMin],
  ['IconMax', '放大', IconMax],
  ['IconRestore', '还原', IconRestore],
  ['IconArrange', '整理', IconArrange],
  ['IconGrip', '拖动的把手', IconGrip],
];
const LUCIDE: readonly (readonly [string, string, Icon])[] = [
  ['IconCheck', '勾（check）', IconCheck],
  ['IconX', '叉（x）', IconX],
  ['IconSearch', '搜索（search）', IconSearch],
  ['IconEye', '眼睛（eye）', IconEye],
  ['IconEyeOff', '划掉的眼睛（eye-off）', IconEyeOff],
  ['IconPlus', '加（plus）', IconPlus],
  ['IconMinus', '减（minus）', IconMinus],
  ['IconMore', '三个点「更多」（ellipsis）', IconMore],
  ['IconChevronUp', '向上的箭头（chevron-up）', IconChevronUp],
  ['IconChevronDown', '向下的箭头（chevron-down）', IconChevronDown],
  ['IconChevronLeft', '向左的箭头（chevron-left）', IconChevronLeft],
  ['IconChevronRight', '向右的箭头（chevron-right）', IconChevronRight],
  ['IconAlert', '警告（triangle-alert）', IconAlert],
  ['IconInfo', '信息（info）', IconInfo],
];

function Cell({
  name,
  label,
  I,
  source,
}: {
  name: string;
  label: string;
  I: Icon;
  source: string;
}) {
  return (
    <div className="sc-icon" data-icon={name} data-source={source}>
      <div className="sc-icon-pic">
        <span className="sc-icon-24" data-size="24">
          <I style={{ width: 24, height: 24 }} />
        </span>
        <span className="sc-icon-15" data-size="15">
          <I style={{ width: 15, height: 15 }} />
        </span>
      </div>
      <CopyName name={name} />
      <span className="sc-icon-note">
        {label} · {source}
      </span>
    </div>
  );
}

export function IconsBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-icons" title="图标" sub="@luoli/ui/icons">
      <p className="sc-note">
        每个是一个 React 组件，画布大小默认 1em，颜色跟着文字。面板手写的（16 格、线宽
        1.4～1.6）照原样搬进库；从 Lucide 抄来的统一成 24 格、线宽 2（Lucide 自己的默认值；15px 下是
        1.25px，面板里 16 格手写的 1.4 线宽是 1.31px，几乎一样粗）、圆头圆角。 每格里左边 24px、右边
        15px（面板里图标按钮用的大小）。
      </p>
      <h4 className="sc-h4">面板手写的（{HAND.length} 个）</h4>
      <Stage kind={kind}>
        <div className="sc-icons" data-icons="hand">
          {HAND.map(([n, l, I]) => (
            <Cell key={n} name={n} label={l} I={I} source="手写" />
          ))}
        </div>
      </Stage>
      <h4 className="sc-h4">从 Lucide 抄来的（{LUCIDE.length} 个）</h4>
      <Stage kind={kind}>
        <div className="sc-icons" data-icons="lucide">
          {LUCIDE.map(([n, l, I]) => (
            <Cell key={n} name={n} label={l} I={I} source="Lucide" />
          ))}
        </div>
      </Stage>
      <h4 className="sc-h4">粗细对比：手写的和抄来的放在一起（放大到 48px，再原大小 15px）</h4>
      <Stage kind={kind}>
        <div className="sc-strokes" data-strokes="">
          {[
            ['手写', IconMax],
            ['手写', IconRestore],
            ['手写', IconArrange],
            ['Lucide', IconPlus],
            ['Lucide', IconCheck],
            ['Lucide', IconChevronDown],
            ['Lucide', IconSearch],
            ['Lucide', IconX],
          ].map(([src, I], i) => {
            const C = I as Icon;
            return (
              <span key={i} className="sc-stroke" data-source={src as string}>
                <C style={{ width: 48, height: 48 }} />
                <C style={{ width: 15, height: 15 }} />
                <em>{src as string}</em>
              </span>
            );
          })}
        </div>
      </Stage>
    </Group>
  );
}
