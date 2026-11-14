import { useRef, useState } from 'react';
import { Button, Chevron, Fold, Tag } from '../../../src/controls';
import { LegacyEnded } from '../../legacy/step5b-parts';
import { Compare } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import { Group, Merged, Now, useStageKind } from './shared';

/* 「折叠」一块（带和面板现在写法的对比）：气泡里思考和工具调用的折叠、任务部件的「已结束」 */

const THINK = '先看一下群里刚才聊到哪儿了，再决定要不要查一下那个网址。';
const ARGS = '{\n  "url": "https://example.com/post/42"\n}';
const OUT = '# 一篇文章\n\n正文一共 1,203 个字符……';

/* 折叠的几种状态：收着、展开、悬停（强制成悬停的样子）、键盘焦点（强制成键盘焦点的样子） */
const FOLD_STATES: readonly (readonly [string, boolean, string])[] = [
  ['closed', false, ''],
  ['open', true, ''],
  ['hover', false, 'sc-hover'],
  ['focus', false, 'sc-focus'],
];

/** 现在：气泡里思考的折叠（原样：summary 里一枚强调色的小胶囊，箭头是 ::after） */
function LegacyThink({ open, st, cls }: { open: boolean; st: string; cls: string }) {
  return (
    <details className="fold is-think" open={open} data-item="fold" data-state={st}>
      <summary className={cls} data-item="pill" data-state={st}>
        <span>思考了 3 秒</span>
      </summary>
      <div className="fold-body" data-item="body" data-state={st}>
        {THINK}
      </div>
    </details>
  );
}
/** 归并后：Fold，头是一枚 soft、accent 的 Tag（里面带 Chevron，箭头在胶囊里面，和现在一样），展开的框是 inset（sm） */
function MergedThink({ open, st, cls }: { open: boolean; st: string; cls: string }) {
  return (
    <Fold
      className="sc-m-fold sc-m-think"
      defaultOpen={open}
      data-item="fold"
      data-state={st}
      head={
        <Tag variant="soft" tone="accent" className="sc-m-tag-gap">
          思考了 3 秒
          <Chevron />
        </Tag>
      }
      headClassName={`sc-m-think-head ${cls}`}
    >
      <div className="ll-inset sc-m-foldbody" data-size="sm" data-item="body" data-state={st}>
        {THINK}
      </div>
    </Fold>
  );
}
function LegacyTool({ open, st, cls }: { open: boolean; st: string; cls: string }) {
  return (
    <details className="fold is-tool" open={open} data-item="fold" data-state={st}>
      <summary className={cls} data-item="head" data-state={st}>
        <span>◇ fetch · https://example.com/post/42</span>
        <span className="ok">✓ 0.8s</span>
      </summary>
      <div className="fold-body" data-item="body" data-state={st}>
        <div className="fold-k">参数</div>
        <pre className="fold-pre">{ARGS}</pre>
        <div className="fold-k">结果 · 共 1,203 字符</div>
        <pre className="fold-pre">{OUT}</pre>
      </div>
    </details>
  );
}
function MergedTool({ open, st, cls }: { open: boolean; st: string; cls: string }) {
  return (
    <Fold
      className="sc-m-fold sc-m-tool"
      headClassName={cls}
      defaultOpen={open}
      data-item="fold"
      data-state={st}
      head={
        <>
          <span>◇ fetch · https://example.com/post/42</span>
          <span className="ok">✓ 0.8s</span>
          <Chevron />
        </>
      }
    >
      <div className="ll-inset sc-m-foldbody" data-size="sm" data-item="body" data-state={st}>
        <div className="fold-k">参数</div>
        <pre className="fold-pre">{ARGS}</pre>
        <div className="fold-k">结果 · 共 1,203 字符</div>
        <pre className="fold-pre">{OUT}</pre>
      </div>
    </Fold>
  );
}

const ENDED_ROWS = ['每天 08:00 说说天气', '周五提醒小明交周报', '下周一 09:00 开会前提醒'];
/* 展开后的内容：几行任务（行的样子是下面「列表行」那一块的事，这里只用来撑出高度） */
const legacyRows = () =>
  ENDED_ROWS.map((t) => (
    <div role="listitem" key={t} className="sc-ended-row">
      {t}
    </div>
  ));

const ENDED_STATES = FOLD_STATES;

export function FoldBlock() {
  const kind = useStageKind();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const [baseN, setBaseN] = useState(0);
  const [lockedN, setLockedN] = useState(0);
  const lockedWrap = useRef<HTMLDivElement>(null);
  return (
    <Group id="ctl-fold" title="折叠" sub="Fold · .ll-fold">
      <p className="sc-note">
        <code>&lt;details class="ll-fold"&gt;</code> 加{' '}
        <code>&lt;summary class="ll-fold-head"&gt;</code>
        ，内容直接放在后面。展开收起时内容自己缓缓撑开、收起（高度 0 → auto 的过渡，0.2 秒，
        <code>::details-content</code> 加 <code>interpolate-size</code>，不引
        Motion）；动画关掉时直接到位；收起时里面的东西 Tab
        键走不到。头：没有浏览器自带的三角，默认一行暗色的小字（12px、<code>--ll-fg-dim</code>
        ，悬停变亮）；
        头里的内容、颜色用的地方可以整个换掉（放一枚标签、一行等宽字都行）。小箭头不自己画：头里放库的
        Chevron，展开时它转向下。展开的内容不带样子，要一块底就自己加 <code>.ll-inset</code>。React
        的 Fold：<code>head</code>、<code>open</code>（受控）或 <code>defaultOpen</code>（不受控）、
        <code>onOpenChange</code>、<code>headClassName</code>；多余的属性传给 details（
        <code>onToggle</code> 等）。页面内查找（Ctrl+F）命中收着的内容时浏览器会自己打开
        details：不受控的跟着改并调 <code>onOpenChange</code>
        ，受控的只调回调、用的地方没跟着改就关回去。
      </p>
      <Stage kind={kind}>
        <div className="sc-fold-demos">
          <div data-demo="fold-basic-wrap">
            <span className="sc-stage-tag">
              默认的头（不受控；回调了 <b data-demo-count="fold-basic">{baseN}</b> 次）
            </span>
            <Fold
              onOpenChange={() => setBaseN((c) => c + 1)}
              head={
                <>
                  已结束（3）
                  <Chevron />
                </>
              }
              data-demo="fold-basic"
            >
              <p className="sc-fold-p">收起时这里 Tab 键走不到：</p>
              <button type="button" className="ll-btn" data-demo="fold-inner-btn">
                里面的按钮
              </button>
            </Fold>
          </div>
          <div data-demo="fold-controlled-wrap">
            <span className="sc-stage-tag">受控（外面的按钮也能开合）</span>
            <Fold
              open={open}
              onOpenChange={(v) => {
                setOpen(v);
                setN((c) => c + 1);
              }}
              head={
                <>
                  受控的折叠
                  <Chevron />
                </>
              }
              data-demo="fold-controlled"
            >
              <div className="ll-inset sc-m-foldbody" data-size="sm">
                展开着：{String(open)}
              </div>
            </Fold>
            <div className="sc-pill-row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => setOpen(true)} data-demo="fold-ext-open">
                展开
              </Button>
              <Button size="sm" onClick={() => setOpen(false)} data-demo="fold-ext-close">
                收起
              </Button>
              <span className="sc-stage-tag">
                头被点了 <b data-demo-count="fold">{n}</b> 次
              </span>
            </div>
          </div>
          <div data-demo="fold-locked-wrap" ref={lockedWrap}>
            <span className="sc-stage-tag">
              受控但不让开（open 一直是
              false）：页面内查找（Ctrl+F）命中里面的字，浏览器会自己把它打开，库调一次回调再把它关回去（回调了{' '}
              <b data-demo-count="fold-locked">{lockedN}</b> 次）。不按 Ctrl+F
              也能看：点下面的按钮，等于浏览器自己把它打开
            </span>
            <Fold
              open={false}
              onOpenChange={() => setLockedN((c) => c + 1)}
              head={
                <>
                  锁着的折叠
                  <Chevron />
                </>
              }
              data-demo="fold-locked"
            >
              <div className="ll-inset sc-m-foldbody" data-size="sm">
                星尘落进口袋，只在查找里命中的这一行。
              </div>
            </Fold>
            <div className="sc-pill-row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                onClick={() => {
                  /* 浏览器页面内查找命中收着的内容时做的就是这件事：把 details 的 open 改成 true（随后发 toggle 事件） */
                  const el = lockedWrap.current?.querySelector('details');
                  if (el) el.open = true;
                }}
                data-demo="fold-locked-sim"
              >
                模拟浏览器自己把它打开
              </Button>
            </div>
          </div>
          <div data-demo="fold-defaultopen-wrap">
            <span className="sc-stage-tag">defaultOpen、换了头的样子（标签）</span>
            <Fold
              defaultOpen
              data-demo="fold-tagged"
              head={
                <Tag variant="soft" tone="accent" className="sc-m-tag-gap">
                  思考了 3 秒
                  <Chevron />
                </Tag>
              }
            >
              <div className="ll-inset sc-m-foldbody" data-size="sm">
                {THINK}
              </div>
            </Fold>
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="fold-think"
        title="折叠：气泡里的思考（.fold.is-think），收着、展开、悬停、键盘焦点"
        note="换成库的 Fold：头里的小药丸换成库的 Tag（soft、accent，和中止时已经在用的 .fold-tag 同一个），里面放 Chevron（箭头还在药丸里面）；自己画的箭头（summary::after）换成 Chevron；展开的内容框换成 .ll-inset（sm）。机制不变（details）。思考内容框最高 240、跟到底、头上的字号等是聊天内容自己的，留在面板（第 9 步再搬）。"
        now={
          <Now>
            <div className="sc-env-text">
              {FOLD_STATES.map(([st, open, cls]) => (
                <LegacyThink key={st} open={open} st={st} cls={cls} />
              ))}
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-text">
              {FOLD_STATES.map(([st, open, cls]) => (
                <MergedThink key={st} open={open} st={st} cls={cls} />
              ))}
            </div>
          </Merged>
        }
      />
      <Compare
        id="fold-tool"
        title="折叠：气泡里的工具调用（.fold.is-tool），收着、展开、悬停、键盘焦点"
        note="换成库的 Fold：头里的内容（等宽字、颜色、「✓ 0.8s」）是聊天内容自己的，留在面板；自己画的箭头换成 Chevron；展开的框换成 .ll-inset（sm）。头窄 1.15px（箭头少了左边距）；气泡是按内容收缩的，头是气泡里最宽的东西时，气泡、气泡里的时间、展开的内容框也各窄 1.14px（这里的舞台量不出来，变化表里写了）。"
        now={
          <Now>
            <div className="sc-env-text">
              {FOLD_STATES.map(([st, open, cls]) => (
                <LegacyTool key={st} open={open} st={st} cls={cls} />
              ))}
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-text">
              {FOLD_STATES.map(([st, open, cls]) => (
                <MergedTool key={st} open={open} st={st} cls={cls} />
              ))}
            </div>
          </Merged>
        }
      />
      <Compare
        id="fold-ended"
        title="折叠：任务部件的「已结束（3）」，收着、展开、悬停、键盘焦点（静止的样子）"
        note="换成库的 Fold：头默认的样子就是现在这一行（12px、暗色、悬停变亮），外边距 2 10、内边距 4 0 是布局，留在面板。展开收起的动画变了，见下面「试试看」和变化表后面「量不出来」的那一条。"
        now={
          <Now>
            <div className="sc-env-col sc-env-ended">
              {ENDED_STATES.map(([st, open, cls]) => (
                <div className="task-ended sc-m-ended" data-item="ended" data-state={st} key={st}>
                  <button
                    className={`task-more ${cls}`}
                    type="button"
                    aria-expanded={open}
                    data-item="head"
                    data-state={st}
                  >
                    已结束（3）
                    <Chevron />
                  </button>
                  {open && (
                    <div className="task-wrap" role="list">
                      {legacyRows()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-col sc-env-ended">
              {ENDED_STATES.map(([st, open, cls]) => (
                <Fold
                  key={st}
                  className="task-ended sc-m-ended"
                  headClassName={`sc-m-more ${cls}`}
                  defaultOpen={open}
                  data-item="ended"
                  data-state={st}
                  head={
                    <>
                      已结束（3）
                      <Chevron />
                    </>
                  }
                >
                  <div className="sc-m-wrap">{legacyRows()}</div>
                </Fold>
              ))}
            </div>
          </Merged>
        }
      />
      <h4 className="sc-h4">试试看：「已结束」展开收起的动画（左边是仿的）</h4>
      <Stage kind={kind}>
        <div className="sc-fold-demos">
          <div data-demo="ended-now">
            <span className="sc-stage-tag">
              现在（Motion：0.42 秒进、0.32 秒出，带淡入淡出；展示页用同样的时长和曲线仿的）
            </span>
            <div className="sc-ctx sc-legacy sc-env-col sc-env-ended-live">
              <LegacyEnded label="已结束（3）">{legacyRows()}</LegacyEnded>
            </div>
          </div>
          <div data-demo="ended-merged">
            <span className="sc-stage-tag">
              归并后（库的 Fold：展开收起都是 0.2
              秒，没有淡入淡出；收起以后内容还留在页面里，只是不显示）
            </span>
            <div className="sc-ctx sc-env-col sc-env-ended-live">
              <Fold
                className="task-ended sc-m-ended"
                headClassName="sc-m-more"
                data-demo="ended-fold"
                head={
                  <>
                    已结束（3）
                    <Chevron />
                  </>
                }
              >
                <div className="sc-m-wrap">{legacyRows()}</div>
              </Fold>
            </div>
          </div>
        </div>
      </Stage>
    </Group>
  );
}
