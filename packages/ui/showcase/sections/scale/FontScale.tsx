import { Compare } from '../../components/Compare';
import { CopyName } from '../../components/CopyName';
import { ProposalCells, ProposalNote } from '../../components/Proposal';
import { FONT_OTHER, FONT_STATS } from '../../data/scale-stats';
import { nearestTier, textTiers } from '../../lib/tiers';

/* 字号：每档两行示例（界面字体、等宽字体），一张对照表，半号的字各一个对比块 */

const HALF = [10.5, 11.5, 12.5, 13.5];

function Sample({ size }: { size: string }) {
  return (
    <div className="sc-sample" style={{ fontSize: size }}>
      <div>
        <b className="sc-who0">洛璃</b> <span className="sc-dim">11:46</span>
      </div>
      <div>英仙座流星雨极大期在 8 月 12 日前后</div>
      <div>Perseids peak 12–13 Aug · 约 100 颗/小时</div>
    </div>
  );
}

export function FontScale() {
  const tiers = textTiers();
  const decl = FONT_STATS.reduce((n, s) => n + s.decl, 0);
  const sh = FONT_STATS.reduce((n, s) => n + s.shorthand, 0);
  return (
    <section className="sc-group" id="scale-font" data-group="scale-font">
      <h3 className="sc-h3">
        字号 <span className="sc-count">{tiers.length} 档</span>
      </h3>
      <div className="sc-tiers">
        {tiers.map((t) => (
          <div className="sc-tier" key={t.name} data-tier={t.name}>
            <div className="sc-tier-name">
              <CopyName name={t.name} />
              <span className="sc-px">{t.px}px</span>
            </div>
            <div className="sc-tier-samples">
              <div style={{ fontSize: `var(${t.name})`, fontFamily: 'var(--ll-font-ui)' }}>
                星空观测站 Stargazing Club 12:30 · 0123456789
              </div>
              <div
                className="sc-dim"
                style={{ fontSize: `var(${t.name})`, fontFamily: 'var(--ll-font-mono)' }}
              >
                星空观测站 const stars = 12.5; // 0123456789
              </div>
            </div>
          </div>
        ))}
      </div>

      <h4 className="sc-h4">面板现在的字号，并到哪一档</h4>
      <ProposalNote how="数 app.css 里每条 font-size 声明（只数 px 的）；font 简写里的字号另数一列，不混进去；em 这样的相对写法不统计。" />
      <div className="sc-scroll">
        <table className="sc-table" data-table="font">
          <thead>
            <tr>
              <th>现在的字号</th>
              <th className="sc-num">font-size 处数</th>
              <th className="sc-num">font 简写里</th>
              <th>并到</th>
              <th className="sc-num">差</th>
            </tr>
          </thead>
          <tbody>
            {FONT_STATS.map((s) => (
              <tr key={s.px} data-row={s.px} data-decl={s.decl} data-shorthand={s.shorthand}>
                <td className="sc-mono">{s.px}px</td>
                <td className="sc-mono sc-num">{s.decl || '—'}</td>
                <td className="sc-mono sc-num">{s.shorthand || '—'}</td>
                <ProposalCells value={s.px} tiers={tiers} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>合计（px 的）</td>
              <td className="sc-mono sc-num" data-total-decl="">
                {decl}
              </td>
              <td className="sc-mono sc-num">{sh}</td>
              <td colSpan={2} />
            </tr>
            <tr>
              <td className="sc-dim">其他写法（不统计）</td>
              <td colSpan={4} className="sc-dim sc-mono">
                {FONT_OTHER.map((o) => `${o.value} ×${o.count}`).join('　')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sc-foot">
        统计的是 src/web/styles/app.css（写报告那天数的一次性数字）。「font-size 处数」是 font-size
        声明的条数，「font 简写里」是 font: 12px/1.45 … 这样的简写里的字号；怎么数的见
        data/scale-stats.ts 开头。
      </p>

      <h4 className="sc-h4">半号的字：同一段文字，左边现在的字号，右边并过去以后</h4>
      <div className="sc-cmps">
        {HALF.map((px) => {
          const t = nearestTier(px, tiers);
          const n = FONT_STATS.find((s) => s.px === px);
          return (
            <Compare
              key={px}
              title={`${px}px → ${t.px}px`}
              nowLabel={`现在 ${px}px${n ? `（font-size ${n.decl} 处）` : ''}`}
              mergedLabel={`并到 ${t.name} · ${t.px}px`}
              now={<Sample size={`${px}px`} />}
              merged={<Sample size={`var(${t.name})`} />}
              note={`差 ${Math.abs(t.px - px)}px，约 ${Math.round((Math.abs(t.px - px) / px) * 100)}%。`}
            />
          );
        })}
      </div>
    </section>
  );
}
