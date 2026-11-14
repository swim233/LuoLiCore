import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Empty, Field, Notice, Skeleton, Switch } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, Matrix, PanelEnv, useStageKind } from './shared';

/* 「提示条」「空状态」「骨架条」三块 */

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
      <NoticeLeaveDemo />
    </Group>
  );
}

/* 重放整理提示条退出时那一下（面板的做法：state/actions.ts 的 setArranging 和 shell/Overlays.tsx 的 ArrangeBar）：
   点条上的「完成」→ 先量整个条的宽和位置（getBoundingClientRect）→ 写进 style.width、固定在原处（面板用 position: fixed，
   这里用 absolute：相对放这个条的外壳，展示页的缩放下也对得上）→ 去掉 is-on：透明度 0.26 秒、位移 0.34 秒的过渡淡出、上滑 14px
   （数值照面板的 .arrange-bar）→ 过了一段时间（340 + 150 + 40 毫秒）回到平常的样子，可以再点。
   库的提示条是 border-box，量到的整条宽原样写回 style.width 就对（不用再加内边距）；条本身是 inline-flex，要居中的话用的地方自己写 display: flex。
   动画关掉时照面板的 .still：只淡出 0.12 秒、不滑（样式在 showcase.css 的 .sc-leave-go）；慢放把这些时间都乘 5。 */
interface LeaveRun {
  phase: 'go' | 'back';
  /** 固定在原处的样式（phase go）；外壳的最小高，免得条脱离文档流以后下面跳一下 */
  style: CSSProperties;
  hold: number;
}
const LEAVE_KEEP_MS = 340 + 150 + 40;
const LEAVE_SLOW = 5;

function useLeaveDemo(slow: boolean) {
  const [run, setRun] = useState<LeaveRun | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);
  const play = () => {
    const el = box.current;
    const bar = el?.querySelector<HTMLElement>('.ll-notice');
    if (!bar || !el || run || !el.offsetWidth) return;
    const r = bar.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    /* 展示页的缩放（CSS zoom）下，量到的是放大后的数，写回去要除掉 */
    const z = Math.round((c.width / el.offsetWidth) * 100) / 100 || 1;
    const tf = getComputedStyle(bar).transform;
    const ty = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0;
    setRun({
      phase: 'go',
      hold: c.height / z,
      style: {
        position: 'absolute',
        top: (r.top - ty - c.top) / z,
        left: (r.left - c.left) / z,
        width: r.width / z,
        margin: 0,
      },
    });
    timers.current.push(
      window.setTimeout(
        () => {
          /* 回到平常的样子：这一帧不要过渡 */
          setRun((s) => (s ? { ...s, phase: 'back' } : s));
          requestAnimationFrame(() => requestAnimationFrame(() => setRun(null)));
        },
        LEAVE_KEEP_MS * (slow ? LEAVE_SLOW : 1),
      ),
    );
  };
  return { run, box, play };
}

/* 「试试看」：条先是平常的样子（整理模式里在文档流里、宽是自己的内容宽），点条上的「完成」放一遍退出 */
function NoticeLeaveDemo() {
  const kind = useStageKind();
  const [slow, setSlow] = useState(false);
  const { run, box, play } = useLeaveDemo(slow);
  const going = run?.phase === 'go';
  const barStyle: CSSProperties | undefined = run
    ? going
      ? run.style
      : { transition: 'none' }
    : undefined;
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
        <PanelEnv>
          <div
            className="sc-env-leave"
            style={{ minHeight: run?.hold, ['--sc-slow' as string]: slow ? LEAVE_SLOW : 1 }}
            ref={box}
          >
            <Notice
              size="lg"
              className={`sc-m-ab sc-leave-flex ${going ? 'sc-leave-go' : ''}`}
              style={barStyle}
            >
              <span>
                <b>整理中</b>：{ARRANGE}
              </span>
              <Button pressed data-demo="leave-demo" onClick={play}>
                完成
              </Button>
            </Notice>
          </div>
        </PanelEnv>
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
    </Group>
  );
}
