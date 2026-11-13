import { useContext } from 'react';
import type { ReactNode } from 'react';
import { cssVar } from '../lib/css-read';
import type { TokenItem } from '../data/tokens-groups';
import { CopyName } from './CopyName';
import { MISSING_TEXT, MissingCtx } from './missing';

/* 一组变量列成表：名字（点一下复制）、当前的值、说明，可以再加几列。每行带 data-token，和卡片一样被 QA 数 */
export function TokenTable({
  items,
  extraHead,
  extra,
}: {
  items: TokenItem[];
  extraHead?: ReactNode;
  extra?: (item: TokenItem, value: string) => ReactNode;
}) {
  const missing = useContext(MissingCtx);
  return (
    <div className="sc-scroll">
      <table className="sc-table">
        <thead>
          <tr>
            <th>名字</th>
            <th>当前的值</th>
            {extraHead}
            <th>用在哪</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            if (missing.has(item.name))
              return (
                <tr key={item.name} className="is-missing" data-token={item.name} data-missing="">
                  <td>
                    <CopyName name={item.name} />
                  </td>
                  <td className="sc-missing" colSpan={extraHead ? 3 : 2}>
                    {MISSING_TEXT}
                  </td>
                  <td className="sc-dim">{item.note ?? ''}</td>
                </tr>
              );
            const value = cssVar(item.name);
            return (
              <tr key={item.name} data-token={item.name}>
                <td>
                  <CopyName name={item.name} />
                </td>
                <td className="sc-mono" data-value="">
                  {value}
                </td>
                {extra?.(item, value)}
                <td className="sc-dim">{item.note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
