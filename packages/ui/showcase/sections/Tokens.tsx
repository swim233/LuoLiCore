import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  DUR_LAYER,
  DUR_MORPH,
  DUR_VANISH,
  EASE_GLIDE_BACK,
  EASE_GLIDE_GO,
  EASE_MORPH,
  GLIDE_OVERSHOOT,
  GLIDE_PEAK,
  LAYER_SHIFT,
  cssBezier,
} from '../../src/easing';
import { motionOn } from '../../src/motion';
import { CurvePlay } from '../components/CurvePlay';
import type { CurveSpec } from '../components/CurvePlay';
import { SectionHead } from '../components/SectionHead';
import { MissingCtx } from '../components/missing';
import { TokenTable } from '../components/TokenTable';
import { VarCard } from '../components/VarCard';
import { TOKEN_GROUPS } from '../data/tokens-groups';
import type { TokenGroup, TokenItem } from '../data/tokens-groups';
import { useAnimCheck } from '../lib/anim-check';
import { parseBezier, parseTimeMs } from '../lib/anim-math';
import { cssVar, useCssRev } from '../lib/css-read';
import { describeDiff, diffTokens } from '../lib/token-diff';
import { tokenNames } from '../lib/tokens-src';
import {
  BubbleDemo,
  CtlDemo,
  FontDemo,
  GlassDemo,
  InsetDemo,
  SkyDemo,
  TextDemo,
  WhoDemo,
} from './tokens-demos';

/* 第一节「变量」：tokens.css 里的每个变量按组摆出来——样子、名字（点一下复制）、页面上实际读到的值。
   运行时从样式表里读出 @layer ll.tokens 的全部变量，和分组的数据（data/tokens-groups.ts）对一遍：
   - tokens.css 里有、分组里没有：自动出现在最后一个「还没分组」的组里，并 console.error 一次；
   - 分组里有、tokens.css 里没有（名字写错了、变量删了）：那一格标红写「tokens.css 里没有这个变量」，并 console.error 一次；
   - 都对得上：没有这个组、没有报错。 */

const DEMOS: Record<string, () => ReactNode> = {
  text: TextDemo,
  ctl: CtlDemo,
  inset: InsetDemo,
  glass: GlassDemo,
  sky: SkyDemo,
  bubble: BubbleDemo,
  who: WhoDemo,
  font: FontDemo,
};

const listed = TOKEN_GROUPS.flatMap((g) => g.items.map((i) => i.name));

/** 最近一次报过的说明：同样的说明只报一次（样式热更新、重新渲染都不重复报；改好了再坏会再报） */
let reported = '';

/* 曲线：分组里登记的 CSS 变量曲线（名字从分组的数据来，tokens.css 里没有的会标红），加上 easing.ts 里没有 CSS 变量的几条 TS 常量 */
const CSS_CURVE_USAGE: Record<string, string> = {
  '--ll-ease-out':
    '出现、进入、到位：很快到位再收尾。部件出现、新行淡入、整理模式的位移、数字滚动。',
};
function curves(cssCurves: TokenItem[]): CurveSpec[] {
  return [
    ...cssCurves.map((item): CurveSpec => ({
      id: item.name.replace(/^--ll-/, ''),
      name: item.name,
      source: 'css',
      usage: CSS_CURVE_USAGE[item.name] ?? item.note ?? '',
      bezier: parseBezier(cssVar(item.name)),
      easing: () => cssVar(item.name),
      defaultMs: 300,
    })),
    {
      id: 'morph',
      name: 'EASE_MORPH',
      source: 'ts',
      usage: '形变、位移：外框形变、其他卡片让位。慢起步、长尾；基准时长 DUR_MORPH。',
      bezier: EASE_MORPH,
      easing: () => cssBezier(EASE_MORPH),
      defaultMs: DUR_MORPH,
    },
    {
      id: 'glide-go',
      name: 'EASE_GLIDE_GO',
      source: 'ts',
      usage: `悬停高亮滑向另一行：先滑过目标 ${GLIDE_OVERSHOOT}px，在全程的 ${GLIDE_PEAK * 100}% 处到最远、速度减到 0。`,
      bezier: EASE_GLIDE_GO,
      easing: () => cssBezier(EASE_GLIDE_GO),
      defaultMs: Math.round(GLIDE_PEAK * 300),
    },
    {
      id: 'glide-back',
      name: 'EASE_GLIDE_BACK',
      source: 'ts',
      usage: '悬停高亮从最远处回到目标（回弹的后半段）。',
      bezier: EASE_GLIDE_BACK,
      easing: () => cssBezier(EASE_GLIDE_BACK),
      defaultMs: Math.round((1 - GLIDE_PEAK) * 300),
    },
  ];
}

function MotionBody({ g }: { g: TokenGroup }) {
  const check = useAnimCheck();
  const curveItems = g.items.filter((i) => i.kind === 'curve');
  const timeItems = g.items.filter((i) => i.kind === 'time');
  return (
    <>
      {!check.ok && (
        <div className="sc-alert" role="alert" data-anim-alert="">
          <b>动画变量的两处来源对不上</b>（tokens.css 里静态写的一份，和 easing.ts 写进 head
          的一份，按数值比）：
          <ul>
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <h4 className="sc-h4">曲线（点「播放」按这条曲线和选的时长走一遍）</h4>
      <div className="sc-curves">
        {curves(curveItems).map((c) => (
          <CurvePlay key={c.id} spec={c} />
        ))}
      </div>
      <h4 className="sc-h4">时长</h4>
      <TokenTable
        items={timeItems}
        extraHead={<th className="sc-num">毫秒</th>}
        extra={(_, v) => (
          <td className="sc-mono sc-num" data-ms="">
            {parseTimeMs(v) ?? '—'}
          </td>
        )}
      />
      <h4 className="sc-h4">easing.ts 里别的常量（TS 里用，没有 CSS 变量）</h4>
      <div className="sc-scroll">
        <table className="sc-table">
          <thead>
            <tr>
              <th>名字</th>
              <th className="sc-num">值</th>
              <th>用在哪</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['DUR_MORPH', `${DUR_MORPH} ms`, '外框形变的基准时长（桌面上的形变比它略长）'],
              [
                'DUR_VANISH',
                `${DUR_VANISH} ms`,
                '消失（ease-in）：部件消失的空壳、「新」标记、被移除的条目',
              ],
              [
                'DUR_LAYER',
                `${DUR_LAYER} ms`,
                '会话部件在窗口里两层（列表、时间线）互相切换：位移加淡入',
              ],
              ['LAYER_SHIFT', `${LAYER_SHIFT} px`, '切换时两层各自平移的距离'],
              ['GLIDE_PEAK', String(GLIDE_PEAK), '悬停高亮回弹：在全程的这个位置到最远'],
              ['GLIDE_OVERSHOOT', `${GLIDE_OVERSHOOT} px`, '悬停高亮回弹：过冲的距离，固定'],
            ].map(([name, value, note]) => (
              <tr key={name}>
                <td className="sc-mono">{name}</td>
                <td className="sc-mono sc-num">{value}</td>
                <td className="sc-dim">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Group({ g }: { g: TokenGroup }) {
  const Demo = DEMOS[g.id];
  let body: ReactNode;
  if (g.id === 'motion') body = <MotionBody g={g} />;
  else if (g.id === 'z' || g.id === 'scale') body = <TokenTable items={g.items} />;
  else
    body = (
      <div className="sc-vgrid">
        {g.items.map((i) => (
          <VarCard key={i.name} item={i} />
        ))}
      </div>
    );
  return (
    <section className="sc-group" id={`g-${g.id}`} data-group={g.id}>
      <h3 className="sc-h3">
        {g.title} <span className="sc-count">{g.items.length}</span>
        {g.id === 'scale' && (
          <a className="sc-more" href="#scale">
            去「刻度」一节看 →
          </a>
        )}
      </h3>
      {g.note && <p className="sc-note">{g.note}</p>}
      {Demo && <Demo />}
      {body}
    </section>
  );
}

export function Tokens() {
  const rev = useCssRev();
  /* 每次样式更新（热更新）重新从样式表里读 */
  const names = useMemo(() => tokenNames(), [rev]);
  const diff = useMemo(() => (names ? diffTokens(names, listed) : null), [names]);
  const message = diff ? describeDiff(diff) : '';
  useEffect(() => {
    if (message && message !== reported) console.error(message);
    reported = message;
  }, [message]);
  const absent = useMemo(() => new Set(diff?.absent ?? []), [diff]);
  const groups = useMemo<TokenGroup[]>(() => {
    if (!diff?.ungrouped.length) return TOKEN_GROUPS;
    return [
      ...TOKEN_GROUPS,
      {
        id: 'ungrouped',
        title: '还没分组',
        note: 'tokens.css 里有、展示页的分组里还没登记的变量（到 data/tokens-groups.ts 里加进对应的组）。',
        items: diff.ungrouped.map((name) => ({ name, kind: 'text' as const })),
      },
    ];
  }, [diff]);
  const go = (id: string) =>
    document
      .getElementById(`g-${id}`)
      ?.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
  const grouped = names ? names.length - (diff?.ungrouped.length ?? 0) : 0;
  return (
    <MissingCtx.Provider value={absent}>
      <SectionHead title="变量">
        tokens.css
        里的全部变量，按用途分组。每个变量一张卡：样子、名字（点一下复制）、页面上实际读到的值。
      </SectionHead>
      <div className="sc-summary" data-summary="">
        {names ? (
          <>
            <span>
              tokens.css 里共 <b data-total="">{names.length}</b> 个变量，已分组{' '}
              <b data-shown="">{grouped}</b> 个
            </span>
            {message === '' ? (
              <span className="sc-ok">对得上</span>
            ) : (
              <span className="sc-bad" role="alert" data-diff-alert="">
                {diff?.ungrouped.length ? `还没分组 ${diff.ungrouped.join('、')}；` : ''}
                {diff?.absent.length ? `tokens.css 里没有 ${diff.absent.join('、')}；` : ''}
                {diff?.duplicated.length ? `登记了不止一次 ${diff.duplicated.join('、')}` : ''}
              </span>
            )}
          </>
        ) : (
          <span className="sc-bad" role="alert" data-diff-alert="">
            样式表里找不到 @layer ll.tokens（库的 styles.css 没有加载？）
          </span>
        )}
      </div>
      <nav className="sc-chips" aria-label="分组">
        {groups.map((g) => (
          <button key={g.id} type="button" className="sc-chip" onClick={() => go(g.id)}>
            {g.title}
          </button>
        ))}
      </nav>
      {groups.map((g) => (
        <Group key={g.id} g={g} />
      ))}
    </MissingCtx.Provider>
  );
}
