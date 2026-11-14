import { CHANGES, NOTES, UNCHANGED } from './changes';
import { Group } from './shared';

/* 「面板上会变的地方」：请用户点头的清单。每行的 data- 属性给 QA 的脚本核对用（见 changes.ts 开头） */
export function ChangesTable() {
  let lastPart = '';
  return (
    <Group id="ctl-changes" title="面板上会变的地方" sub={`${CHANGES.length} 处`}>
      <p className="sc-note">
        这是请你点头的清单（第 5 步第一批）：b
        段把面板换成库的面和控件以后，面板上除了下面这些，不会有别的变化（完全不变的不列，见表下面）。
        每一行的数字都是对着上面的对比块量出来的计算样式，不是估的；对比块里「现在」那一边先拿真的面板页面核对过。
        想留着原样的行，告诉我是哪一行，我在库里加一个变体或者在面板里单独写。
      </p>
      <div className="sc-table-wrap">
        <table className="sc-table sc-changes" data-changes="">
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
            {CHANGES.map((c) => {
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
      <h4 className="sc-h4">没有变化的（脚本量过，两边一样）</h4>
      <ul className="sc-list" data-unchanged="">
        {UNCHANGED.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4 className="sc-h4">量不出来、或不是数值的变化</h4>
      <ul className="sc-list" data-notes="">
        {NOTES.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Group>
  );
}
