import type { ReactNode } from 'react';
import { Compare } from '../../components/Compare';
import { CopyName } from '../../components/CopyName';
import { ProposalCells, ProposalNote, SpecialCells } from '../../components/Proposal';
import { SPACE_KEEP, SPACE_OTHER, SPACE_STATS } from '../../data/scale-stats';
import { nearestTier, spaceTiers } from '../../lib/tiers';
import { CapSample, ChipsSample, ConvSample, TodaySample } from './samples';

/* 间距：每档一个条块，一张对照表（gap 和内边距），几个对比块 */

/* 对比块：面板里真实用到这个值的东西（照面板现在的样子画，样例在 samples.tsx）。[哪种间距, 现在的 px, 画什么, 在哪用到] */
const PAIRS: {
  kind: 'gap' | 'padding';
  px: number;
  what: string;
  where: string;
  render: (v: string) => ReactNode;
}[] = [
  {
    kind: 'padding',
    px: 18,
    what: '胶囊的右内边距',
    where: '收起来的部件（.cap）；窗口标题栏（.w-head）、「此刻」的头部等也是 18px',
    render: (v) => <CapSample right={v} />,
  },
  {
    kind: 'gap',
    px: 22,
    what: '今日概况各块之间',
    where: '全屏的今日概况（.today.is-full）',
    render: (v) => <TodaySample gap={v} />,
  },
  {
    kind: 'padding',
    px: 9,
    what: '会话列表一行的上下内边距',
    where: '会话列表的一行（.conv-item）；任务的一行（.task-row）也是 9px',
    render: (v) => <ConvSample padV={v} />,
  },
  {
    kind: 'padding',
    px: 11,
    what: '尺寸按钮的左右内边距',
    where: '窗口的尺寸按钮（.chip）；「此刻」的标签（.now-tab）、对话选会话的按钮也是 11px',
    render: (v) => <ChipsSample padX={v} />,
  },
];

export function SpaceScale() {
  const tiers = spaceTiers();
  const sum = (k: 'gap' | 'padding') => SPACE_STATS.reduce((n, s) => n + s[k], 0);
  return (
    <section className="sc-group" id="scale-space" data-group="scale-space">
      <h3 className="sc-h3">
        间距 <span className="sc-count">{tiers.length} 档</span>
      </h3>
      <div className="sc-tiers is-bars">
        {tiers.map((t) => (
          <div className="sc-tier" key={t.name} data-tier={t.name}>
            <div className="sc-tier-name">
              <CopyName name={t.name} />
              <span className="sc-px">{t.px}px</span>
            </div>
            <div className="sc-space-viz">
              <div className="sc-space-cell" data-viz="bar">
                <span className="sc-space-cap">实际像素</span>
                <div className="sc-bar-track">
                  <i className="sc-bar-fill" style={{ width: `var(${t.name})` }} />
                </div>
              </div>
              <div className="sc-space-cell" data-viz="gap">
                <span className="sc-space-cap">两个 24px 的方块，中间隔这么宽</span>
                <div className="sc-gap-demo" style={{ gap: `var(${t.name})` }}>
                  <i />
                  <i />
                </div>
              </div>
              <div className="sc-space-cell" data-viz="x4">
                <span className="sc-space-cap">放大 4 倍</span>
                <div className="sc-bar-track">
                  <i className="sc-bar-fill" style={{ width: `calc(var(${t.name}) * 4)` }} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <h4 className="sc-h4">面板现在的 gap 和内边距，并到哪一档</h4>
      <ProposalNote how="数 gap 和 padding 的声明（不数 margin）；每条声明里每个 px 数值数一处，同一个值在一条声明里只数一次；0 不数；含 calc、var、max、env 或 em、ch 的整条声明不统计。" />
      <div className="sc-scroll">
        <table className="sc-table" data-table="space">
          <thead>
            <tr>
              <th>现在的值</th>
              <th className="sc-num">gap 处数</th>
              <th className="sc-num">内边距处数</th>
              <th className="sc-num">合计</th>
              <th>并到</th>
              <th className="sc-num">差</th>
            </tr>
          </thead>
          <tbody>
            {SPACE_STATS.map((s) => (
              <tr key={s.px} data-row={s.px} data-gap={s.gap} data-padding={s.padding}>
                <td className="sc-mono">{s.px}px</td>
                <td className="sc-mono sc-num">{s.gap || '—'}</td>
                <td className="sc-mono sc-num">{s.padding || '—'}</td>
                <td className="sc-mono sc-num">{s.gap + s.padding}</td>
                {SPACE_KEEP.has(s.px) ? (
                  <SpecialCells>
                    <span className="sc-tag is-keep">原样保留，不并</span>
                    <span className="sc-dim">版面上个别的留白，不做成变量</span>
                  </SpecialCells>
                ) : (
                  <ProposalCells value={s.px} tiers={tiers} />
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>合计（px 的）</td>
              <td className="sc-mono sc-num" data-total-gap="">
                {sum('gap')}
              </td>
              <td className="sc-mono sc-num" data-total-padding="">
                {sum('padding')}
              </td>
              <td className="sc-mono sc-num">{sum('gap') + sum('padding')}</td>
              <td colSpan={2} />
            </tr>
            <tr>
              <td className="sc-dim">其他写法（不统计）</td>
              <td className="sc-mono sc-num sc-dim">{SPACE_OTHER.gap}</td>
              <td className="sc-mono sc-num sc-dim">{SPACE_OTHER.padding}</td>
              <td colSpan={3} className="sc-dim">
                含 calc、var、max、env，或 em、ch 这样的写法的整条声明
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sc-foot">
        每条声明里的每个 px 数值各数一处，同一个值在一条声明里只数一次（padding: 8px 8px 8px 16px 数
        8 一处、16 一处）；0 不统计。数法见 data/scale-stats.ts 开头。
      </p>

      <h4 className="sc-h4">几个不在档上的值，拿面板里真实用到它的东西来看</h4>
      <div className="sc-cmps">
        {PAIRS.map(({ kind, px, what, where, render }) => {
          const t = nearestTier(px, tiers);
          const n = SPACE_STATS.find((s) => s.px === px)?.[kind] ?? 0;
          return (
            <Compare
              key={`${kind}-${px}`}
              title={`${what} ${px}px → ${t.px}px`}
              nowLabel={`现在 ${px}px（${kind === 'gap' ? 'gap' : '内边距'} ${n} 处）`}
              mergedLabel={`并到 ${t.name} · ${t.px}px`}
              now={render(`${px}px`)}
              merged={render(`var(${t.name})`)}
              note={where}
            />
          );
        })}
      </div>
    </section>
  );
}
