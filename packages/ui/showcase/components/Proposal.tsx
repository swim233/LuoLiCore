import type { ReactNode } from 'react';
import { diffText, nearestTier } from '../lib/tiers';
import type { Tier } from '../lib/tiers';

/** 并过去差这么多（px）以上的，标「差得多，建议留成专用值」 */
export const BIG_DIFF = 3;

/* 对照表里「并到哪一档、差多少」两格：最近的一档，一样近时取小的（提案）。已经在档上的写「已在档上」；
   差 BIG_DIFF 像素以上的在「并到」那一格里标出来（并到哪一档照旧填最近的一档） */
export function ProposalCells({
  value,
  tiers,
  unit = 'px',
}: {
  value: number;
  tiers: readonly Tier[];
  unit?: string;
}) {
  const t = nearestTier(value, tiers);
  const same = t.px === value;
  const big = Math.round(Math.abs(t.px - value) * 100) / 100 >= BIG_DIFF;
  return (
    <>
      <td data-merge={t.name} data-big={big ? '' : undefined}>
        <code className="sc-merge">{t.name}</code>{' '}
        <span className="sc-dim sc-mono">
          {t.px}
          {unit}
        </span>
        {big && (
          <span className="sc-tag is-warn" data-warn="">
            差得多，建议留成专用值
          </span>
        )}
      </td>
      <td className={`sc-mono sc-num ${same ? 'sc-dim' : ''}`} data-diff="">
        {same ? '已在档上' : diffText(value, t.px)}
      </td>
    </>
  );
}

/** 对照表里不并的行（专用值、原样保留）：「并到」和「差」两格合成一格 */
export function SpecialCells({ children }: { children: ReactNode }) {
  return (
    <td colSpan={2} data-special="">
      {children}
    </td>
  );
}

/** 每张对照表上面那一段：这是提案、怎么数的、标记是什么意思。how 是这张表的数法 */
export function ProposalNote({ how }: { how: string }) {
  return (
    <p className="sc-proposal" data-proposal="">
      这是提案：并到哪一档按「最近的一档，一样近时取小的」先填；定稿以后才会在第 4、5
      步逐批套用到面板上。
      <span className="sc-proposal-line">数法：{how}</span>
      <span className="sc-proposal-line">
        并过去差 {BIG_DIFF}px 以上的行标了
        <span className="sc-tag is-warn">差得多，建议留成专用值</span>
        ，并到哪一档那一列仍填最近的一档，要不要留成专用值等你看表定。
      </span>
    </p>
  );
}
