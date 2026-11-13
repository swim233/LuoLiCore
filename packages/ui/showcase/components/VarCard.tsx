import { useState } from 'react';
import type { ReactNode } from 'react';
import { parseBezier, parseTimeMs } from '../lib/anim-math';
import { cssVar } from '../lib/css-read';
import type { TokenItem } from '../data/tokens-groups';
import { CopyName } from './CopyName';
import { CurveGraph } from './CurveGraph';
import { MISSING_TEXT, useIsMissing } from './missing';

/* 当前的值：页面上实际读到的计算值。很长的（玻璃的边光、夜空窗口的底、字体栈）先收成几行，点一下展开 */
function Value({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90;
  return (
    <code
      className={`sc-value ${long ? 'is-long' : ''} ${open ? 'is-open' : ''}`}
      data-value=""
      title={long ? (open ? '点一下收起' : '点一下展开') : undefined}
      onClick={long ? () => setOpen(!open) : undefined}
    >
      {text || '（空）'}
    </code>
  );
}

const ref = (name: string) => `var(${name})`;

/* 样子：按变量的种类画 */
function Look({ item, value }: { item: TokenItem; value: string }) {
  const { name, kind } = item;
  switch (kind) {
    case 'color':
      return (
        <div className="sc-sw">
          <i style={{ background: ref(name) }} />
        </div>
      );
    case 'fill':
      return (
        <div className={`sc-fillbox is-${item.stage ?? 'page'}`}>
          <i style={{ background: ref(name) }} />
        </div>
      );
    case 'shadow':
      return (
        <div className="sc-shadowbox">
          <i style={{ boxShadow: ref(name), background: item.base ? ref(item.base) : undefined }} />
        </div>
      );
    case 'font':
      return (
        <div className="sc-fontlook" style={{ fontFamily: ref(name) }}>
          星空观测站 Stargazing 12:30 0123456789
        </div>
      );
    case 'length': {
      return (
        <div className="sc-lenbox">
          <i style={{ width: `min(${ref(name)}, 100%)` }} />
        </div>
      );
    }
    case 'time': {
      const ms = parseTimeMs(value);
      return (
        <div className="sc-lenbox is-time">
          <i style={{ width: `${Math.min(100, ((ms ?? 0) / 600) * 100)}%` }} />
        </div>
      );
    }
    case 'curve':
      return <CurveGraph bezier={parseBezier(value)} size={96} />;
    default:
      return null;
  }
}

/* 「变量」一节里的一个变量：样子、名字（点一下复制）、当前的值、说明。data-token 是名字，QA 数它 */
export function VarCard({ item, extra }: { item: TokenItem; extra?: ReactNode }) {
  const missing = useIsMissing(item.name);
  const value = cssVar(item.name);
  if (missing)
    return (
      <div className="sc-var is-missing" data-token={item.name} data-missing="">
        <CopyName name={item.name} />
        <div className="sc-missing">{MISSING_TEXT}</div>
        {item.note && <div className="sc-var-note">{item.note}</div>}
      </div>
    );
  return (
    <div className={`sc-var is-${item.kind}`} data-token={item.name}>
      <Look item={item} value={value} />
      <CopyName name={item.name} />
      <Value text={value} />
      {item.note && <div className="sc-var-note">{item.note}</div>}
      {extra}
    </div>
  );
}
