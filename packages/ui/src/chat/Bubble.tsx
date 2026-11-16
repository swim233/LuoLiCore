import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Chevron, Fold, Spinner, Tag } from '../controls';
import { motionOn } from '../motion';
import { isSliding, maxScrollTop, SLIDE_FOLLOW_TAU, sliderOf } from '../slide';
import { WHEEL_EVENT, wheelDir } from '../wheel';
import { attachBubbleFrame } from './bubble-frame';
import { colorOf } from './colors';
import { Hl } from './Hl';
import { useLabels } from './labels';
import type { ChatLabels } from './labels';
import { Markdown } from './Markdown';
import { Pic } from './Pic';
import { Typed } from './Typed';
import type { ChatEnded, ChatGlass, ChatLive, ChatPart, ChatRole, ChatSide } from './types';

/* 聊天气泡：按段的先后画。思考、工具调用、文字各是一块，连着的图片并成一排。
   - 思考：折叠，写「思考了 N 秒」（消息里记了才有，以前的消息写「思考过程」），展开是思考的内容；
   - 工具调用：折叠，一行是工具名加一句话（part.label：给界面看的一句话，没有就是参数的前一截，由用的项目算好），右边是状态（转圈、✓ 0.8s、× 0.8s）；
     展开是参数、结果的开头与总长度、结果里的图片，出错时是错误说明；
   - 文字：助手的回复按 Markdown 画（Markdown.tsx），别人发的消息保留原样的文字和换行、只做高亮（网址是能点的链接）；
     live 时最后一段文字逐字落下（自己这一处正在出的回复），出完以后换成静态的。
   角色（role）：other 别人、self 自己、assistant 助手，决定底色和名字的颜色（other、self 的名字颜色取自 colorKey）；
   靠哪边（side）：start 靠左、end 靠右，靠近说话人的那个下角收尖。角色和靠哪边分开，各用的地方自己说（面板的对话部件里助手在左、时间线里在右）。
   写死的话（排队中、思考中……）都能经 labels 换，见 labels.ts。 */
const fmtMs = (ms: number) => (ms / 1000).toFixed(1) + 's';

/** 工具参数的全文（太长截短） */
function prettyInput(input: unknown) {
  const s = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  return s.length > 1000 ? s.slice(0, 1000) + '…' : s;
}

/* 思考的内容：高度有上限、自己滚动。思考中（follow）展开着时，停在它的底部就跟着滑到最新（不是跳），往上翻了就不拉回来 */
const NEAR_BOTTOM = 24;
function ThinkBody({ text, follow }: { text: string; follow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  /* 用户的滚轮缓动往上滚：马上不再跟着（同步的事件，比第一帧的滚动事件早） */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: Event) => {
      if ((e as CustomEvent<{ dy: number }>).detail.dy < 0) stuck.current = false;
    };
    el.addEventListener(WHEEL_EVENT, on);
    return () => el.removeEventListener(WHEEL_EVENT, on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!follow || !el || !stuck.current) return;
    if (motionOn()) sliderOf(el).to(() => maxScrollTop(el), { kind: 'exp', tau: SLIDE_FOLLOW_TAU });
    else el.scrollTop = el.scrollHeight;
  }, [text, follow]);
  return (
    <div
      className="ll-cfold-body ll-inset"
      data-size="sm"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        // 自己在滑的时候离底部还远，不算用户往上翻了
        if (isSliding(el)) return;
        stuck.current =
          wheelDir(el) < 0 ? false : el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
      }}
    >
      {text}
    </div>
  );
}

function ThinkFold({
  p,
  ended,
  L,
}: {
  p: Extract<ChatPart, { kind: 'think' }>;
  ended: ChatEnded;
  L: ChatLabels;
}) {
  // 消息已经结束（中止、出错）还停在「思考中」的，写明是怎么断的
  if (p.streaming && ended)
    return (
      <div className="ll-cfold" data-kind="think">
        <Tag variant="soft" tone="accent" className="ll-cfold-tag">
          {ended === 'fail' ? L.thinkBroken : L.thinkAborted}
        </Tag>
      </div>
    );
  if (!p.streaming && !p.text.trim()) return null;
  /* 思考中和思考结束是同一个 <details>：思考中点开了，结束后仍是打开的，里面的内容和滚动位置也接着用，只有标题换成「思考了 N 秒」。
     思考中的内容随流增长；刚展开时（思考中）跳到底部 */
  return (
    <Fold
      className="ll-cfold"
      data-kind="think"
      onToggle={(e) => {
        const body = e.currentTarget.querySelector<HTMLElement>('.ll-cfold-body');
        if (p.streaming && e.currentTarget.open && body) {
          sliderOf(body).cancel();
          body.scrollTop = body.scrollHeight;
        }
      }}
      head={
        <Tag variant="soft" tone="accent">
          {p.streaming ? L.thinking : p.sec ? L.thought(p.sec) : L.thoughtPlain}
          <Chevron />
        </Tag>
      }
    >
      {p.text.trim() && <ThinkBody text={p.text} follow={p.streaming} />}
    </Fold>
  );
}

function ToolFold({
  p,
  ended,
  L,
}: {
  p: Extract<ChatPart, { kind: 'tool' }>;
  ended: boolean;
  L: ChatLabels;
}) {
  const running = p.state === 'running';
  const err = p.state === 'error';
  const done = p.state === 'ok';
  const one = p.label;
  return (
    <Fold
      className="ll-cfold"
      data-kind="tool"
      head={
        <>
          <span>{`◇ ${p.name}${one ? ' · ' + one : ''}`}</span>
          {running ? (
            ended ? (
              <span>…</span>
            ) : (
              <Spinner className="ll-cfold-spin" />
            )
          ) : (
            <span className={err ? 'll-cfold-bad' : 'll-cfold-ok'}>
              {err ? '×' : '✓'}
              {p.ms !== undefined ? ' ' + fmtMs(p.ms) : err ? ' ' + L.errorShort : ''}
            </span>
          )}
          <Chevron />
        </>
      }
    >
      <div className="ll-cfold-body ll-inset" data-size="sm">
        <div className="ll-cfold-k">{L.params}</div>
        <pre className="ll-cfold-pre">{prettyInput(p.input) || L.noParams}</pre>
        {done && (
          <>
            <div className="ll-cfold-k">{L.result(p.chars ?? 0, !!p.truncated)}</div>
            {p.outText && <pre className="ll-cfold-pre">{p.outText}</pre>}
            {p.images.length > 0 && (
              <div className="ll-msg-imgs" data-out="">
                {p.images.map((info, i) => (
                  <Pic key={i} info={info} labels={L} />
                ))}
              </div>
            )}
          </>
        )}
        {err && (
          <>
            <div className="ll-cfold-k" data-bad="">
              {L.error}
            </div>
            <pre className="ll-cfold-pre">{p.errorText || L.noErrorText}</pre>
          </>
        )}
        {running && <div>{ended ? L.callUnfinished : L.calling}</div>}
      </div>
    </Fold>
  );
}

function Blocks({
  parts,
  hits,
  md,
  live,
  ended,
  L,
}: {
  parts: ChatPart[];
  hits: boolean;
  /** 文字按 Markdown 画（助手的回复）；否则原样显示 */
  md: boolean;
  live?: ChatLive;
  /** 这条消息已经结束的方式：中止、出错；还在进行或正常结束为 null */
  ended: ChatEnded;
  L: ChatLabels;
}) {
  const blocks: ReactNode[] = [];
  let imgs: Extract<ChatPart, { kind: 'image' }>[] = [];
  const flush = () => {
    if (!imgs.length) return;
    const group = imgs;
    imgs = [];
    blocks.push(
      <div className="ll-msg-imgs" key={'i' + blocks.length}>
        {group.map((f, j) => (
          <Pic key={j} info={f.info} name={f.name} labels={L} />
        ))}
      </div>,
    );
  };
  // 逐字出的是最后一段文字
  let liveAt = -1;
  if (live) parts.forEach((p, i) => p.kind === 'text' && p.text && (liveAt = i));
  parts.forEach((p, i) => {
    if (p.kind === 'image') {
      imgs.push(p);
      return;
    }
    flush();
    if (p.kind === 'think') blocks.push(<ThinkFold p={p} ended={ended} L={L} key={i} />);
    else if (p.kind === 'tool') blocks.push(<ToolFold p={p} ended={!!ended} L={L} key={i} />);
    else if (p.text) {
      blocks.push(
        i === liveAt && live ? (
          <div className="ll-msg-text" key={i}>
            <Typed
              streamId={live.streamId}
              text={p.text}
              streaming={live.streaming}
              lingerUntil={live.lingerUntil}
              onRevealed={live.onRevealed}
              labels={L}
            />
          </div>
        ) : (
          <div className="ll-msg-text" key={i}>
            {md ? (
              <Markdown text={p.text} hits={hits} labels={L} />
            ) : (
              <Hl text={p.text} hits={hits} />
            )}
          </div>
        ),
      );
    }
  });
  flush();
  return <>{blocks}</>;
}

/* 气泡的外框与里面的内容分两层（外框的补间见 bubble-frame.ts）。平时 .ll-bubble-in 只是个普通的块 */
function useBubbleFrame() {
  const frame = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const f = frame.current,
      c = inner.current;
    if (f && c) return attachBubbleFrame(f, c);
  }, []);
  return { frame, inner };
}

/* 毛玻璃：气泡自己实时模糊（backdrop-filter，.ll-bubble[data-blur]），气泡后面的星空被糊开。
   glass 是个可选的槽：用的项目有别的做法时传进来，blur: false 就不模糊，layer 是垫在气泡里第一个子元素位置的一层（见 types.ts 的 ChatGlass）。
   实时模糊有个限制：气泡的祖先（背景那层以内、气泡以外）带 opacity < 1、filter、mask、clip-path 之类时，气泡拿不到它外面的画面，模糊没有了，
   那层效果去掉的一瞬又突然糊上。所以气泡和它后面那层背景之间的祖先上不能有这些；要淡入淡出的话放在气泡自己身上（气泡自己的 opacity 会连它的模糊一起淡）：
   新消息的出现动画就是这样（chat.css 的 ll-msg-in-*，淡入在气泡自己身上，.ll-msg 只做位移）。 */
function glassOf(glass?: ChatGlass) {
  return { blur: glass?.blur ?? true, layer: glass?.layer };
}

export interface ChatBubbleProps {
  /** 角色：决定底色和名字的颜色 */
  role: ChatRole;
  /** 靠哪边：靠近说话人的那个下角收尖 */
  side: ChatSide;
  name: string;
  /** 名字的颜色取自它（用户 id 或名字）；助手的名字是固定的颜色，不用它 */
  colorKey?: string;
  /** 名字旁边的时间，或「正在回复」 */
  label: string;
  /** 排队中：生成中又发的消息，还没被回复看到 */
  queued?: boolean;
  parts: ChatPart[];
  live?: ChatLive;
  aborted?: boolean;
  failed?: boolean;
  /** 中止的标记文字 */
  abortMark: string;
  isNew: boolean;
  /** 气泡下面的东西（出错时的重试钮） */
  below?: ReactNode;
  glass?: ChatGlass;
  labels?: Partial<ChatLabels>;
}

/** 一条消息：名字与时间一行，气泡，标记，（出错时）下面的东西 */
export const ChatBubble = memo(function ChatBubble({
  role,
  side,
  name,
  colorKey,
  label,
  queued,
  parts,
  live,
  aborted,
  failed,
  abortMark,
  isNew,
  below,
  glass,
  labels,
}: ChatBubbleProps) {
  const L = useLabels(labels);
  const { blur, layer } = glassOf(glass);
  const isA = role === 'assistant';
  const ended: ChatEnded = failed ? 'fail' : aborted ? 'abort' : null;
  const { frame, inner } = useBubbleFrame();
  return (
    <div
      className="ll-msg"
      data-role={role}
      data-side={side}
      data-blur={blur ? '' : undefined}
      data-new={isNew && motionOn() ? '' : undefined}
      style={!isA ? ({ '--ll-msg-who': colorOf(colorKey ?? '') } as CSSProperties) : undefined}
    >
      <div className="ll-msg-meta">
        <b>{name}</b>
        {queued ? (
          <Tag variant="soft" title={L.queuedTip}>
            {L.queued}
          </Tag>
        ) : (
          <time>{label}</time>
        )}
      </div>
      <div className="ll-bubble" data-blur={blur ? '' : undefined} ref={frame}>
        {layer}
        <div className="ll-bubble-in" ref={inner}>
          <Blocks parts={parts} hits={!isA} md={isA} live={live} ended={ended} L={L} />
          {aborted && <span className="ll-mark">{abortMark}</span>}
          {failed && (
            <span className="ll-mark" data-err="">
              {L.failedMark}
            </span>
          )}
        </div>
      </div>
      {below}
    </div>
  );
});

/** 「正在回复」：助手的气泡里三个点（和有内容的气泡一样糊）。label 是名字旁边的字（默认「正在回复」） */
export function ChatTyping({
  role = 'assistant',
  side,
  name,
  label,
  glass,
  labels,
}: {
  role?: ChatRole;
  side: ChatSide;
  name: string;
  label?: string;
  glass?: ChatGlass;
  labels?: Partial<ChatLabels>;
}) {
  const L = useLabels(labels);
  const { blur, layer } = glassOf(glass);
  return (
    <div
      className="ll-msg"
      data-role={role}
      data-side={side}
      data-blur={blur ? '' : undefined}
      data-typing=""
    >
      <div className="ll-msg-meta">
        <b>{name}</b>
        <time>{label ?? L.typing}</time>
      </div>
      <div className="ll-bubble" data-blur={blur ? '' : undefined}>
        {layer}
        <span className="ll-typing" aria-label={L.typing}>
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
