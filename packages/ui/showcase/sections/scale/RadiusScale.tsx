import { Compare } from '../../components/Compare';
import { CopyName } from '../../components/CopyName';
import { ProposalCells, ProposalNote } from '../../components/Proposal';
import { Stage } from '../../components/Stage';
import { RADIUS_OTHER, RADIUS_STATS, RADIUS_WINDOW } from '../../data/scale-stats';
import { nearestTier, radiusTiers } from '../../lib/tiers';

/* 圆角：每档一个方块，专用值单独一排，一张对照表，几个对比块 */

function RowSample({ radius }: { radius: string }) {
  return (
    <div className="sc-rowsample" style={{ borderRadius: radius }}>
      <b>周末打球</b>
      <span className="sc-dim">胖虎：那就先按不下雨准备</span>
    </div>
  );
}

const PAIRS = [12, 18, 16, 9];

export function RadiusScale() {
  const tiers = radiusTiers();
  const sum = RADIUS_STATS.reduce((n, s) => n + s.decl, 0);
  const sumBubble = RADIUS_STATS.reduce((n, s) => n + s.bubble, 0);
  return (
    <section className="sc-group" id="scale-radius" data-group="scale-radius">
      <h3 className="sc-h3">
        圆角 <span className="sc-count">{tiers.length} 档</span>
      </h3>
      <div className="sc-tiers is-squares">
        {tiers.map((t) => (
          <div className="sc-tier" key={t.name} data-tier={t.name}>
            <div className="sc-square" style={{ borderRadius: `var(${t.name})` }} />
            <div className="sc-tier-name">
              <CopyName name={t.name} />
              <span className="sc-px">{t.px}px</span>
            </div>
          </div>
        ))}
      </div>

      <h4 className="sc-h4">专用值（专用，不并）</h4>
      <div className="sc-tiers is-squares is-special">
        <div className="sc-tier" data-tier="--ll-radius-window">
          <Stage kind="page" className="sc-square-stage">
            <div className="sc-square is-sky" style={{ borderRadius: 'var(--ll-radius-window)' }} />
          </Stage>
          <div className="sc-tier-name">
            <CopyName name="--ll-radius-window" />
            <span className="sc-px">22px</span>
          </div>
          <span className="sc-tag is-ded">专用，不并</span>
        </div>
        <div className="sc-tier" data-tier="--ll-bubble-radius">
          <Stage kind="sky" className="sc-square-stage">
            <div
              className="sc-square is-bubble"
              style={{
                borderRadius:
                  'var(--ll-bubble-radius) var(--ll-bubble-radius) var(--ll-bubble-radius) var(--ll-bubble-radius-tail)',
              }}
            />
          </Stage>
          <div className="sc-tier-name">
            <CopyName name="--ll-bubble-radius" />
            <span className="sc-px">16px</span>
          </div>
          <div className="sc-tier-name">
            <CopyName name="--ll-bubble-radius-tail" />
            <span className="sc-px">5px</span>
          </div>
          <span className="sc-tag is-ded">专用，不并</span>
        </div>
      </div>

      <h4 className="sc-h4">面板现在的圆角，并到哪一档</h4>
      <ProposalNote how="数 border-radius 和四个角各自的圆角声明；同一个值在一条声明里只数一次；气泡的 16 和 5 分开列，50%、inherit、var() 单独列。" />
      <div className="sc-scroll">
        <table className="sc-table" data-table="radius">
          <thead>
            <tr>
              <th>现在的圆角</th>
              <th className="sc-num">条数</th>
              <th className="sc-num">气泡里的（专用）</th>
              <th>并到</th>
              <th className="sc-num">差</th>
            </tr>
          </thead>
          <tbody>
            {RADIUS_STATS.map((s) => (
              <tr key={s.px} data-row={s.px} data-decl={s.decl} data-bubble={s.bubble}>
                <td className="sc-mono">{s.px}px</td>
                <td className="sc-mono sc-num">{s.decl || '—'}</td>
                <td className="sc-mono sc-num">{s.bubble || '—'}</td>
                {s.px === 999 ? (
                  <>
                    <td data-merge="--ll-radius-full">
                      <code className="sc-merge">--ll-radius-full</code>{' '}
                      <span className="sc-dim sc-mono">999px</span>
                    </td>
                    <td className="sc-mono sc-num sc-dim">已在档上</td>
                  </>
                ) : (
                  <ProposalCells value={s.px} tiers={tiers} />
                )}
              </tr>
            ))}
            <tr data-row="window" data-decl={RADIUS_WINDOW.decl}>
              <td className="sc-mono">22px</td>
              <td className="sc-mono sc-num">{RADIUS_WINDOW.decl}</td>
              <td className="sc-mono sc-num">—</td>
              <td colSpan={2}>
                <code className="sc-merge">--ll-radius-window</code>{' '}
                <span className="sc-tag is-ded">专用，不并</span>
                <span className="sc-dim">
                  {' '}
                  面板里写成 var(--ll-radius-window)，共被引用 {RADIUS_WINDOW.refs} 处
                </span>
              </td>
            </tr>
            {RADIUS_OTHER.map((o) => (
              <tr key={o.value} data-row={o.value} data-decl={o.count}>
                <td className="sc-mono">{o.value}</td>
                <td className="sc-mono sc-num">{o.count}</td>
                <td className="sc-mono sc-num">—</td>
                <td colSpan={2} className="sc-dim">
                  {o.note}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>合计（px 的）</td>
              <td className="sc-mono sc-num" data-total-decl="">
                {sum}
              </td>
              <td className="sc-mono sc-num" data-total-bubble="">
                {sumBubble}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sc-foot">
        border-radius 和四个角各自的 border-top-left-radius 等，同一个值在一条声明里只数一次。气泡的
        16 和 5 是 .bubble、.msg.is-me .bubble、.chat .msg.is-luoli .bubble
        三条声明，放在「气泡里的」那一列， 不并；条数那一列只算别的地方。数法见 data/scale-stats.ts
        开头。
      </p>

      <h4 className="sc-h4">几个用得多、又不在档上的值</h4>
      <div className="sc-cmps">
        {PAIRS.map((px) => {
          const t = nearestTier(px, tiers);
          const n = RADIUS_STATS.find((s) => s.px === px)?.decl ?? 0;
          return (
            <Compare
              key={px}
              title={`${px}px → ${t.px}px`}
              nowLabel={`现在 ${px}px（${n} 处）`}
              mergedLabel={`并到 ${t.name} · ${t.px}px`}
              now={<RowSample radius={`${px}px`} />}
              merged={<RowSample radius={`var(${t.name})`} />}
            />
          );
        })}
      </div>
    </section>
  );
}
