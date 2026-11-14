import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Empty, Field, Notice, Skeleton, Switch } from '../../../src/controls';
import { Compare } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import { Group, Matrix, Merged, Now, useStageKind } from './shared';

/* 「提示条」「空状态」「骨架条」三块（带和面板现在写法的对比） */

const ARRANGE = '拖动部件换位置，点尺寸调大小，拖进收纳盒隐藏';

export function NoticeBlock() {
  const [n, setN] = useState(0);
  return (
    <Group id="ctl-notice" title="提示条" sub="Notice · .ll-notice">
      <p className="sc-note">
        玻璃的小药丸：一句话，后面可以带一个按钮。data-size：sm（默认，最小高 24、字 12、左右
        12、字和按钮隔 8）、lg（字 13、上下 8、左右 16、字和按钮隔 12，末尾是按钮时右边收成
        8）；data-tone：默认、danger（危险色的字）。 背后的模糊是玻璃面板的
        --ll-glass-blur。位置（贴顶、居中）、进出场动画由用的地方定。
      </p>
      <Matrix
        name="notice"
        rows={[
          ['sm', 'sm'],
          ['lg', 'lg'],
        ]}
        cols={[
          ['text', '一句话'],
          ['danger', 'danger'],
          ['btn', '带按钮'],
          ['danger-btn', 'danger 带按钮'],
        ]}
        render={(size, col) => (
          <Notice
            size={size === 'lg' ? 'lg' : undefined}
            tone={col.startsWith('danger') ? 'danger' : undefined}
            role="status"
          >
            {col.startsWith('danger') ? '没取到' : '加载中…'}
            {col.endsWith('btn') && <Button size={size === 'lg' ? 'md' : 'xs'}>重试</Button>}
          </Notice>
        )}
      />
      <h4 className="sc-h4">试试看（真的能点）</h4>
      <Stage kind={useStageKind()}>
        <Notice size="lg" role="status" data-demo="notice">
          <span>
            点右边的按钮，数字加一：<b data-demo-count="notice">{n}</b>
          </span>
          <Button onClick={() => setN(n + 1)}>点我</Button>
        </Notice>
      </Stage>
      <NoticeCompares />
    </Group>
  );
}

function NoticeCompares() {
  return (
    <>
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="notice-sm"
        title="提示条 sm（时间线、对话顶上的小提示，三种）"
        note="模糊 12px（没有饱和度）→ 玻璃统一的 16px 加饱和度 1.2；高 24.59 → 24（行高带出来的零点几像素，最小高写成 24）；带按钮的那种，按钮由 inline-block 加 margin-left 8 换成 flex 的 gap 8，按钮的位置和旁边文字的对齐可能差零点几像素（量过，见变化表）。"
        now={
          <Now>
            <div className="sc-env-stack">
              <div className="sc-env-center">
                <span className="log-pill" data-item="pill">
                  加载更早的消息…
                </span>
              </div>
              <div className="sc-env-center">
                <span className="log-pill is-err" data-item="pill-err">
                  连不上洛璃服务，连上后会自动恢复
                </span>
              </div>
              <div className="sc-env-center">
                <span className="log-pill is-err" data-item="pill-retry">
                  更早的消息没取到
                  <Button size="xs" data-item="pill-retry-btn">
                    重试
                  </Button>
                </span>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-stack">
              <div className="sc-env-center">
                <Notice data-item="pill">加载更早的消息…</Notice>
              </div>
              <div className="sc-env-center">
                <Notice tone="danger" data-item="pill-err">
                  连不上洛璃服务，连上后会自动恢复
                </Notice>
              </div>
              <div className="sc-env-center">
                <Notice tone="danger" data-item="pill-retry">
                  更早的消息没取到
                  <Button size="xs" data-item="pill-retry-btn">
                    重试
                  </Button>
                </Notice>
              </div>
            </div>
          </Merged>
        }
      />
      <Compare
        id="notice-lg"
        title="提示条 lg（整理模式的提示条）"
        note="圆角 999 不变；模糊本来就是 16px 加饱和度，一样；高度 44 不变。贴顶（sticky）、进出场动画、窄屏圆角 16 留在面板。"
        now={
          <Now>
            <div className="arrange-bar is-on" data-item="bar">
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-item="bar-btn">
                完成
              </Button>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <Notice size="lg" className="sc-m-ab" data-item="bar">
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-item="bar-btn">
                完成
              </Button>
            </Notice>
          </Merged>
        }
      />
      <Compare
        id="notice-lg-narrow"
        title="提示条 lg 在窄窗口里（整理模式的提示条的最宽：现在和归并后一样）"
        note="面板现在写的最宽是 calc(100% - 32px)，面板的 div 没有全局的 box-sizing，所以那是内容宽，加上左右内边距 24，整个条是 100% - 8px。库的提示条是 border-box，b 段面板里要写成 calc(100% - 8px)，整个条的宽才和现在一样（已定）；这里归并后那边就是这样写的：320px 宽的容器里两边都是 312px，折行一样。"
        now={
          <Now>
            <div className="sc-env-w320">
              <div className="arrange-bar is-on" data-item="bar-narrow">
                <span>
                  <b>整理中</b>：{ARRANGE}
                </span>
                <Button pressed data-item="bar-narrow-btn">
                  完成
                </Button>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-w320">
              <Notice size="lg" className="sc-m-ab" data-item="bar-narrow">
                <span>
                  <b>整理中</b>：{ARRANGE}
                </span>
                <Button pressed data-item="bar-narrow-btn">
                  完成
                </Button>
              </Notice>
            </div>
          </Merged>
        }
      />
      <NoticeLeaveCompare />
    </>
  );
}

/* 整理提示条退出时：面板把量到的整条宽度写进 style.width（见 state/actions.ts 的 barPos），旧写法是 content-box，那是内容宽，
   再加左右内边距 24，条在退出的一瞬间宽 24px；库的提示条是 border-box，同样的数就是整条宽。
   这里也先量一遍（用一个看不见的、没有指定宽的提示条量它自然的宽，字体加载完再量），再把量到的数写上去，和面板的做法一样。 */
function useNaturalWidth() {
  const ref = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    let live = true;
    const measure = () => {
      if (live && ref.current) setW(ref.current.getBoundingClientRect().width);
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, []);
  return [ref, w] as const;
}

/* 重放整理提示条退出时那一下（照面板 state/actions.ts 的 setArranging 和 shell/Overlays.tsx 的 ArrangeBar）：
   点条上的「完成」→ 先量整个条的宽和位置（getBoundingClientRect）→ 写进 style.width、固定在原处（面板用 position: fixed，
   这里用 absolute：相对放这个条的外壳，展示页的缩放下也对得上）→ 去掉 is-on：透明度 0.26 秒、位移 0.34 秒的过渡淡出、上滑 14px
   （数值照 .arrange-bar）→ 过了面板留着它的那段时间（ARR_DUR 340 + ARR_MAX 150 + 40 毫秒）回到平常的样子，可以再点。
   动画关掉时照面板的 .still：只淡出 0.12 秒、不滑（样式在 showcase.css 的 .sc-leave-go）；慢放把这些时间都乘 5。
   三个条的写法：现在（旧的 content-box，量到的宽被当成内容宽）、B（库的 border-box，同样的数就是整个条）、A（量到的宽加 24）。 */
type LeaveKey = 'now' | 'b' | 'a';
interface LeaveRun {
  phase: 'go' | 'back';
  /** 固定在原处的样式（phase go）；外壳的最小高，免得条脱离文档流以后下面跳一下 */
  style: CSSProperties;
  hold: number;
}
const LEAVE_KEEP_MS = 340 + 150 + 40;
const LEAVE_SLOW = 5;

function useLeaveDemo(slow: boolean) {
  const [run, setRun] = useState<Partial<Record<LeaveKey, LeaveRun>>>({});
  const boxes = useRef<Record<LeaveKey, HTMLElement | null>>({ now: null, b: null, a: null });
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);
  const play = (k: LeaveKey) => {
    /* 外壳里的条（旧的 .arrange-bar，或库的 .ll-notice） */
    const box = boxes.current[k];
    const bar = box?.querySelector<HTMLElement>('.arrange-bar, .ll-notice');
    if (!bar || !box || run[k] || !box.offsetWidth) return;
    const r = bar.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    /* 展示页的缩放（CSS zoom）下，量到的是放大后的数，写回去要除掉 */
    const z = Math.round((c.width / box.offsetWidth) * 100) / 100 || 1;
    const tf = getComputedStyle(bar).transform;
    const ty = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0;
    const width = r.width / z + (k === 'a' ? 24 : 0);
    setRun((s) => ({
      ...s,
      [k]: {
        phase: 'go',
        hold: c.height / z,
        style: {
          position: 'absolute',
          top: (r.top - ty - c.top) / z,
          left: (r.left - c.left) / z,
          width,
          margin: 0,
        },
      },
    }));
    const f = slow ? LEAVE_SLOW : 1;
    timers.current.push(
      window.setTimeout(() => {
        /* 回到平常的样子：这一帧不要过渡（旧的条在平常的样子里带着淡入的过渡，不然会再淡入一遍） */
        setRun((s) => (s[k] ? { ...s, [k]: { ...s[k], phase: 'back' } } : s));
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            setRun((s) => {
              const n = { ...s };
              delete n[k];
              return n;
            }),
          ),
        );
      }, LEAVE_KEEP_MS * f),
    );
  };
  return { run, boxes, play };
}

function NoticeLeaveCompare() {
  const [twin, W] = useNaturalWidth();
  const wide = W ? `${W + 24}px` : undefined;
  const natural = W ? `${W}px` : undefined;
  return (
    <>
      <span ref={twin} className="ll-notice sc-twin" data-size="lg" aria-hidden="true">
        <span>
          <b>整理中</b>：{ARRANGE}
        </span>
        <Button pressed tabIndex={-1}>
          完成
        </Button>
      </span>

      <Compare
        id="notice-lg-leave"
        title="提示条 lg 退出时的宽度（整理模式点「完成」，条脱离文档流、固定在原处淡出；这里有两种写法要定一种）"
        mergedLabel="归并后：B 和 A 两种写法（建议 B）"
        note={
          <>
            面板退出整理模式时，先量下整个条的宽（border-box 的 422.05px），再把这个数写进条的
            style.width。旧的写法是 content-box，这个数被当成内容宽，条在淡出的一瞬间变成
            446.05px（宽了 24px），里面的字和按钮也跟着向右挪 12px。 库的提示条是
            border-box，同样的数就是整个条的宽，条在退出前后一样宽。
            <b> B </b>面板的代码不变，只是不再多出 24px：退出的 0.26 秒里条窄
            24px（不再先宽一下），字和按钮不再挪。
            <b> A </b>面板量宽以后加 24（style.width 写成 barPos.width +
            24）：和现在逐像素一样，但代码里带着一个补这个差的 24。 建议 B（多出来的 24px
            是旧盒模型的副作用，不是设计，只有淡出的 0.26 秒里能看出差别）；A
            是保持和现在逐像素一样的写法。这一块里是退出那一刻的静止样子；
            <b>点条上的「完成」重放</b>在下面「试试看」里（带慢放开关）。
          </>
        }
        now={
          <Now>
            <div className="sc-env-leave">
              <div className="arrange-bar is-on" data-item="bar-leave" style={{ width: natural }}>
                <span>
                  <b>整理中</b>：{ARRANGE}
                </span>
                <Button pressed data-item="bar-leave-btn">
                  完成
                </Button>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-leave" data-variant-tag="B">
              <span className="sc-stage-tag">
                B：width 就是量到的宽{W ? `（${W.toFixed(2)}px）` : ''}
              </span>
              <Notice
                size="lg"
                className="sc-m-ab"
                data-item="bar-leave"
                style={{ width: natural }}
              >
                <span>
                  <b>整理中</b>：{ARRANGE}
                </span>
                <Button pressed data-item="bar-leave-btn">
                  完成
                </Button>
              </Notice>
            </div>
            <div className="sc-env-leave" data-variant-tag="A">
              <span className="sc-stage-tag">
                A：width 写成量到的宽加 24{W ? `（${(W + 24).toFixed(2)}px）` : ''}
              </span>
              <Notice size="lg" className="sc-m-ab" data-item="bar-leave-a" style={{ width: wide }}>
                <span>
                  <b>整理中</b>：{ARRANGE}
                </span>
                <Button pressed data-item="bar-leave-a-btn">
                  完成
                </Button>
              </Notice>
            </div>
          </Merged>
        }
      />
      <NoticeLeaveDemo />
    </>
  );
}

/* 「试试看」：三个条先是平常的样子（整理模式里在文档流里、宽是自己的内容宽），点条上的「完成」放一遍退出。
   和上面的静止对比块是分开的（那里的三个条就是退出那一刻的样子，核对脚本量它们），这里的条不带 data-item。 */
function NoticeLeaveDemo() {
  const kind = useStageKind();
  const [slow, setSlow] = useState(false);
  const { run, boxes, play } = useLeaveDemo(slow);
  const boxStyle = (k: LeaveKey): CSSProperties => ({
    minHeight: run[k]?.hold,
    ['--sc-slow' as string]: slow ? LEAVE_SLOW : 1,
  });
  /* 条自己的样式：平常没有写宽（内容宽）；放的时候是固定在原处的那一份；回到平常的那一帧不要过渡 */
  const barStyle = (k: LeaveKey): CSSProperties | undefined => {
    const r = run[k];
    if (!r) return undefined;
    return r.phase === 'go' ? r.style : { transition: 'none' };
  };
  const going = (k: LeaveKey) => run[k]?.phase === 'go';
  const setBox = (k: LeaveKey) => (el: HTMLElement | null) => {
    boxes.current[k] = el;
  };
  return (
    <>
      <h4 className="sc-h4">试试看：点条上的「完成」重放退出的那一下</h4>
      <Stage kind={kind}>
        <div className="sc-pill-row sc-leave-ctl">
          <Switch
            checked={slow}
            onChange={setSlow}
            label={`慢放（${LEAVE_SLOW} 倍）`}
            data-demo="leave-slow"
          />
          <span className="sc-stage-tag">
            放完自动回到平常的样子，可以反复点；动画关掉时只淡出 0.12 秒、不滑（照面板关动画的样子）
          </span>
        </div>
        <Now>
          <div className="sc-env-leave" style={boxStyle('now')} ref={setBox('now')}>
            <span className="sc-stage-tag">
              现在：量到的宽写进 style.width，旧的盒模型把它当内容宽
            </span>
            <div
              className={`arrange-bar ${going('now') ? 'is-leaving sc-leave-go' : 'is-on'}`}
              style={barStyle('now')}
            >
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-demo="leave-now" onClick={() => play('now')}>
                完成
              </Button>
            </div>
          </div>
        </Now>
        <Merged>
          <div className="sc-env-leave" style={boxStyle('b')} ref={setBox('b')}>
            <span className="sc-stage-tag">B（建议）：量到的宽就是整个条的宽</span>
            <Notice
              size="lg"
              className={`sc-m-ab sc-leave-flex ${going('b') ? 'sc-leave-go' : ''}`}
              style={barStyle('b')}
            >
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-demo="leave-b" onClick={() => play('b')}>
                完成
              </Button>
            </Notice>
          </div>
          <div className="sc-env-leave" style={boxStyle('a')} ref={setBox('a')}>
            <span className="sc-stage-tag">A：量到的宽加 24，和现在逐像素一样</span>
            <Notice
              size="lg"
              className={`sc-m-ab sc-leave-flex ${going('a') ? 'sc-leave-go' : ''}`}
              style={barStyle('a')}
            >
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-demo="leave-a" onClick={() => play('a')}>
                完成
              </Button>
            </Notice>
          </div>
        </Merged>
      </Stage>
    </>
  );
}

export function EmptyBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-empty" title="空状态" sub="Empty · .ll-empty">
      <p className="sc-note">
        居中的一块：标题（可没有）、说明、可带一个按钮。外边距 auto（在竖排的 flex
        列里上下居中）、内边距 24 / 16、字 13、颜色 fg-3；标题 fg-2、粗 500、和说明隔
        4。data-flat：没有外边距和内边距。
      </p>
      <Stage kind={kind}>
        <div className="sc-pill-row">
          {(
            [
              ['title-text', '标题 + 说明', { title: '连不上洛璃服务' }, '连上后会自动恢复'],
              ['title', '只有标题', { title: '加载中…' }, null],
              [
                'action',
                '带按钮',
                { title: '这个会话的消息没取到', action: <Button size="sm">重试</Button> },
                '请求超时',
              ],
              ['text', '只有说明', {}, '还没有会话，群里有人发言后会出现在这里'],
            ] as const
          ).map(([id, name, props, text]) => (
            <div key={id} className="sc-env-col" style={{ width: 220 }} data-demo={`empty-${id}`}>
              <span className="sc-stage-tag">{name}</span>
              <Empty {...props}>{text}</Empty>
            </div>
          ))}
          <div className="sc-env-stack" style={{ width: 220 }}>
            <span className="sc-stage-tag">flat</span>
            <Empty flat data-demo="empty-flat">
              今天还没有回复
            </Empty>
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="empty-basic"
        title="空状态：标题加说明（会话列表里，竖排的 flex 列）"
        note="标记换了（说明由直接跟在 <b> 后面的文字，变成 Empty 的 children），画出来的位置不变。"
        now={
          <Now>
            <div className="sc-env-col">
              <div className="empty" data-item="empty">
                <b data-item="empty-title">连不上洛璃服务</b>连上后会自动恢复
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-col">
              <Empty title="连不上洛璃服务" data-item="empty">
                连上后会自动恢复
              </Empty>
            </div>
          </Merged>
        }
      />
      <Compare
        id="empty-action"
        title="空状态：带「重试」"
        now={
          <Now>
            <div className="sc-env-col">
              <div className="empty" data-item="empty">
                <b data-item="empty-title">这个会话的消息没取到</b>请求超时
                <Button size="sm" data-item="empty-btn">
                  重试
                </Button>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-col">
              <Empty
                title="这个会话的消息没取到"
                data-item="empty"
                action={
                  <Button size="sm" data-item="empty-btn">
                    重试
                  </Button>
                }
              >
                请求超时
              </Empty>
            </div>
          </Merged>
        }
      />
      <Compare
        id="empty-flat"
        title="空状态：flat（今天还没有回复）"
        now={
          <Now>
            <div className="sc-env-stack">
              <div className="empty is-flat" data-item="empty-flat">
                今天还没有回复
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-stack">
              <Empty flat data-item="empty-flat">
                今天还没有回复
              </Empty>
            </div>
          </Merged>
        }
      />
      <Compare
        id="empty-now"
        title="「此刻」的空（.now-empty：标题 14px 不加粗）"
        note="标题 14px、不加粗、fg-2 → 和别处一样 13px、粗 500（空状态只有这一种标题）。整块居中的 grid 留在面板，里面换成 flat 的 Empty。"
        now={
          <Now>
            <div className="sc-env-col" style={{ padding: 0 }}>
              <div className="now-empty" style={{ flex: '1 1 0' }} data-item="now-empty-box">
                <div data-item="now-empty">
                  <div className="now-empty-t" data-item="now-empty-title">
                    现在很安静
                  </div>
                  有人叫洛璃时，这里会实时显示那个会话的对话
                </div>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-col" style={{ padding: 0 }}>
              <div
                style={{
                  flex: '1 1 0',
                  display: 'grid',
                  placeItems: 'center',
                  paddingInline: 16,
                }}
                data-item="now-empty-box"
              >
                <Empty flat title="现在很安静" data-item="now-empty">
                  有人叫洛璃时，这里会实时显示那个会话的对话
                </Empty>
              </div>
            </div>
          </Merged>
        }
      />
      <Compare
        id="empty-desk"
        title="桌面空着时的空（.desk-empty）"
        note='字 14px（继承页面）→ 13px，颜色不变；同一个元素：<Empty flat className="desk-empty">，横跨整行（grid-column）和上下留白 48 是布局，留在面板的 .desk-empty 里（这里写成 .sc-m-desk）。'
        now={
          <Now>
            <div className="sc-env-grid">
              <div className="desk-empty" data-item="desk-empty">
                桌面是空的，从上面的「收纳盒」拖一个部件回来
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-grid">
              <Empty flat className="sc-m-desk" data-item="desk-empty">
                桌面是空的，从上面的「收纳盒」拖一个部件回来
              </Empty>
            </div>
          </Merged>
        }
      />
    </Group>
  );
}

export function SkeletonBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-skeleton" title="骨架条" sub="Skeleton · .ll-skel">
      <p className="sc-note">
        还没做的东西的占位，静态的、没有微光、只是装饰（aria-hidden）。默认是一条灰线（高
        6、全圆角、--ll-line）；data-shape="block" 是一块占位的输入框（半透明面板的样子、圆角
        --ll-radius-md、高 34，高可以用 style 改）。
      </p>
      <Stage kind={kind}>
        <div className="sc-env-stack" style={{ maxWidth: 360 }}>
          <Field label="一条线（默认）">
            <Skeleton data-demo="skel-line" />
          </Field>
          <Field label="一块输入框（block）">
            <Skeleton shape="block" data-demo="skel-block" />
          </Field>
          <Field label="高改成 120（多行的输入框）">
            <Skeleton shape="block" style={{ height: 120 }} data-demo="skel-tall" />
          </Field>
        </div>
      </Stage>
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="skel-line"
        title="骨架线（设置里没做的分组 .skel-group 里的 .skel-bar）"
        note="灰线本身一样（高 6、全圆角、--ll-line）；外面那个分组框是半透明面板，在「面」一节对比。线占满剩下的宽（flex）是布局，留在面板。"
        now={
          <Now>
            <div className="sc-env-stack">
              <div className="skel-group" data-item="group">
                <b>人设</b>
                <span className="skel-bar" style={{ maxWidth: '80%' }} data-item="bar" />
              </div>
              <div className="skel-group" data-item="group2">
                <b>白名单</b>
                <span className="skel-bar" style={{ maxWidth: '62%' }} data-item="bar2" />
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-stack">
              <div className="ll-inset sc-m-skel-group" data-item="group">
                <b>人设</b>
                <Skeleton style={{ maxWidth: '80%' }} data-item="bar" />
              </div>
              <div className="ll-inset sc-m-skel-group" data-item="group2">
                <b>白名单</b>
                <Skeleton style={{ maxWidth: '62%' }} data-item="bar2" />
              </div>
            </div>
          </Merged>
        }
      />
      <Compare
        id="skel-input"
        title="占位输入框（全屏设置里没做的字段 .set-input）"
        note="高 34、圆角 10、半透明的底加细线：都一样。「高」那条在表里单列：库的高 34 写死，高 120 的那个由面板用 style 改。标签 12px 的 <label>，和 .set-field 一起对比（下面「表单项」）。"
        now={
          <Now>
            <div className="sc-env-fields">
              <div className="set-field" data-item="field">
                <label data-item="label">名字</label>
                <div className="set-input" aria-hidden="true" data-item="input" />
              </div>
              <div className="set-field" data-item="field-tall">
                <label data-item="label-tall">人设</label>
                <div className="set-input is-tall" aria-hidden="true" data-item="input-tall" />
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged className="sc-m-fields">
            <div className="sc-env-fields">
              <Field label="名字" htmlFor="x1" data-item="field">
                <Skeleton shape="block" data-item="input" />
              </Field>
              <Field label="人设" htmlFor="x2" data-item="field-tall">
                <Skeleton shape="block" style={{ height: 120 }} data-item="input-tall" />
              </Field>
            </div>
          </Merged>
        }
      />
    </Group>
  );
}
