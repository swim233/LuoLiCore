import { CHANGES2, NOTES2, UNCHANGED2 } from './changes2';
import { Group } from './shared';

/* 「面板上会变的地方」第二批（折叠、标签页、列表行、几样小件）：另起一组，和第一批分开。
   每行的 data- 属性给 QA 的脚本核对用（见 changes2.ts 开头）；data-motion="on" 的行只在动画开着时核对 */
export function ChangesTable2() {
  let lastPart = '';
  return (
    <Group id="ctl-changes2" title="面板上会变的地方（第二批）" sub={`${CHANGES2.length} 处`}>
      <p className="sc-note">
        第二批（折叠、标签页、列表行、几样小件）：b
        段换完以后，面板上除了下面这些，不会有别的变化（完全不变的不列，见表下面）。每一行的数字都是对着上面的对比块量出来的计算样式；对比块里「现在」那一边先拿真的面板页面核对过（计算样式、宽高、文字位置、悬停和键盘焦点都核过），b
        段清单里的每一条也在真面板里套过一遍。要你定的只有两处：列表行标题的字号（13 或 15，建议
        13）、选中标签的底（现在的或 --ll-ctl-bg-on，建议后者）。soft
        的按钮展开着时亮着的底（选会话的按钮、时间线上的「摘要」）已定在库的 button.css 里加一条，b
        段改库的按钮时再加，表里「soft 的按钮展开着时」一行写的是它带来的变化。
      </p>
      <div className="sc-table-wrap">
        <table className="sc-table sc-changes" data-changes="" data-batch="2">
          <thead>
            <tr>
              <th>部件</th>
              <th>东西</th>
              <th>变的是什么</th>
              <th>现在</th>
              <th>归并后</th>
              <th>差</th>
            </tr>
          </thead>
          <tbody>
            {CHANGES2.map((c) => {
              const first = c.part !== lastPart;
              lastPart = c.part;
              return (
                <tr
                  key={c.id}
                  className={first ? 'is-first' : undefined}
                  data-change={c.id}
                  data-targets={c.targets.join('|')}
                  data-props={c.props.join(',')}
                  data-now-num={c.nowNum}
                  data-after-num={c.afterNum}
                  data-motion={c.motion}
                >
                  <td className="sc-part">{first ? c.part : ''}</td>
                  <td>{c.where}</td>
                  <td>{c.what}</td>
                  <td>{c.now}</td>
                  <td className="sc-after">{c.after}</td>
                  <td className="sc-dim">{c.diff}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h4 className="sc-h4">没有变化的（第二批，脚本量过，两边一样）</h4>
      <ul className="sc-list" data-unchanged="2">
        {UNCHANGED2.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4 className="sc-h4">量不出来、或不是数值的变化（第二批，含行为上的变化）</h4>
      <ul className="sc-list" data-notes="2">
        {NOTES2.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Group>
  );
}
