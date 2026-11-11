import { memo, useLayoutEffect, useRef } from 'react';
import { attachBubbleFrame } from './bubble-frame';
import { Hl, Spin } from './Hl';
import { Typed } from './Typed';
import type { CursorRef } from './Typed';
import { Markdown } from './Markdown';
import { Pic } from './Pic';
import { motionOn } from '../lib/prefs';
import { isSliding, maxScrollTop, SLIDE_FOLLOW_TAU, sliderOf } from '../lib/slide';
import { nf } from '../lib/util';
import { argsLine } from '../model/parts';
import type { BPart } from '../model/bubble';
import { colorOf } from '../model/who';

/* 聊天气泡：时间线（会话部件）和对话部件共用。按段的先后画：思考、工具调用、文字各是一块，连着的图片并成一排。
   - 思考：折叠，写「思考了 N 秒」（消息里记了才有，以前的消息写「思考过程」），展开是思考的内容；
   - 工具调用：折叠，一行是工具名加给界面看的一句话（没有就是参数的前一截），右边是状态（转圈、✓ 0.8s、× 0.8s）；
     展开是参数、结果的开头与总长度、结果里的图片，出错时是错误说明；
   - 文字：洛璃的回复按 Markdown 画（components/Markdown.tsx），别人发的消息保留原样的文字和换行、只做高亮（网址是能点的链接）；
     live 时最后一段文字逐字落下（对话里自己这个标签页正在出的回复），出完以后换成静态的。 */
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
  useLayoutEffect(() => {
    const el = ref.current;
    if (!follow || !el || !stuck.current) return;
    if (motionOn()) sliderOf(el).to(() => maxScrollTop(el), { kind: 'exp', tau: SLIDE_FOLLOW_TAU });
    else el.scrollTop = el.scrollHeight;
  }, [text, follow]);
  return (
    <div
      className="fold-body"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        // 自己在滑的时候离底部还远，不算用户往上翻了
        if (isSliding(el)) return;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
      }}
    >
      {text}
    </div>
  );
}

function ThinkFold({
  p,
  ended,
}: {
  p: Extract<BPart, { kind: 'think' }>;
  ended: 'abort' | 'fail' | null;
}) {
  // 消息已经结束（中止、出错）还停在「思考中」的，写明是怎么断的
  if (p.streaming && ended)
    return (
      <div className="fold is-think">
        <span className="fold-tag">{ended === 'fail' ? '思考中断' : '思考被中止'}</span>
      </div>
    );
  if (!p.streaming && !p.text.trim()) return null;
  /* 思考中和思考结束是同一个 <details>：思考中点开了，结束后仍是打开的，里面的内容和滚动位置也接着用，只有标题换成「思考了 N 秒」。
     思考中的内容随流增长；刚展开时（思考中）跳到底部 */
  return (
    <details
      className="fold is-think"
      onToggle={(e) => {
        const body = e.currentTarget.querySelector<HTMLElement>('.fold-body');
        if (p.streaming && e.currentTarget.open && body) {
          sliderOf(body).cancel();
          body.scrollTop = body.scrollHeight;
        }
      }}
    >
      <summary>
        <span>{p.streaming ? '思考中…' : p.sec ? `思考了 ${p.sec} 秒` : '思考过程'}</span>
      </summary>
      {p.text.trim() && <ThinkBody text={p.text} follow={p.streaming} />}
    </details>
  );
}

function ToolFold({ p, ended }: { p: Extract<BPart, { kind: 'tool' }>; ended: boolean }) {
  const running = p.state === 'running';
  const err = p.state === 'error';
  const done = p.state === 'ok';
  const one = p.summary ?? argsLine(p.input);
  return (
    <details className="fold is-tool">
      <summary>
        <span>{`◇ ${p.name}${one ? ' · ' + one : ''}`}</span>
        {running ? (
          ended ? (
            <span>…</span>
          ) : (
            <Spin />
          )
        ) : (
          <span className={err ? 'bad' : 'ok'}>
            {err ? '×' : '✓'}
            {p.ms !== undefined ? ' ' + fmtMs(p.ms) : err ? ' 出错' : ''}
          </span>
        )}
      </summary>
      <div className="fold-body">
        <div className="fold-k">参数</div>
        <pre className="fold-pre">{prettyInput(p.input) || '（无）'}</pre>
        {done && (
          <>
            <div className="fold-k">
              {`结果 · 共 ${nf(p.chars ?? 0)} 字符${p.truncated ? '，这里只有开头' : ''}`}
            </div>
            {p.outText && <pre className="fold-pre">{p.outText}</pre>}
            {p.images.length > 0 && (
              <div className="msg-imgs is-out">
                {p.images.map((info, i) => (
                  <Pic key={i} info={info} />
                ))}
              </div>
            )}
          </>
        )}
        {err && (
          <>
            <div className="fold-k bad">出错</div>
            <pre className="fold-pre">{p.errorText || '（没有错误说明）'}</pre>
          </>
        )}
        {running && <div>{ended ? '工具调用未完成' : '正在调用…'}</div>}
      </div>
    </details>
  );
}

/** 对话里自己这个标签页正在逐字出的回复的状态 */
export interface LiveInfo {
  convId: string;
  streaming: boolean;
  lingerUntil: number;
  /** 回复正常完成、最后一个字出现的那一刻（星尘从这一处的光标散开，参数是取光标的函数）。中止、出错不给 */
  onRevealed?: (cursor: CursorRef) => void;
}

export function Blocks({
  parts,
  hits,
  md,
  live,
  ended,
}: {
  parts: BPart[];
  hits: boolean;
  /** 文字按 Markdown 画（洛璃的回复）；否则原样显示 */
  md: boolean;
  live?: LiveInfo;
  /** 这条消息已经结束的方式：中止、出错；还在进行或正常结束为 null */
  ended: 'abort' | 'fail' | null;
}) {
  const blocks: React.ReactNode[] = [];
  let imgs: Extract<BPart, { kind: 'image' }>[] = [];
  const flush = () => {
    if (!imgs.length) return;
    const group = imgs;
    imgs = [];
    blocks.push(
      <div className="msg-imgs" key={'i' + blocks.length}>
        {group.map((f, j) => (
          <Pic key={j} info={f.info} name={f.name} />
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
    if (p.kind === 'think') blocks.push(<ThinkFold p={p} ended={ended} key={i} />);
    else if (p.kind === 'tool') blocks.push(<ToolFold p={p} ended={!!ended} key={i} />);
    else if (p.text) {
      blocks.push(
        i === liveAt && live ? (
          <div className="msg-text" key={i}>
            <Typed
              convId={live.convId}
              text={p.text}
              streaming={live.streaming}
              lingerUntil={live.lingerUntil}
              onRevealed={live.onRevealed}
            />
          </div>
        ) : (
          <div className="msg-text" key={i}>
            {md ? <Markdown text={p.text} hits={hits} /> : <Hl text={p.text} hits={hits} />}
          </div>
        ),
      );
    }
  });
  flush();
  return <>{blocks}</>;
}

/* 气泡的外框与里面的内容分两层（外框的补间见 bubble-frame.ts）。平时 .bubble-in 只是个普通的块 */
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

/** 一条消息：名字与时间一行，气泡，标记，（出错时）下面的按钮 */
export const MsgBubble = memo(function MsgBubble({
  isA,
  you,
  name,
  who,
  label,
  queued,
  parts,
  live,
  aborted,
  failed,
  abortMark,
  isNew,
  below,
}: {
  /** 洛璃的消息 */
  isA: boolean;
  /** 自己（网页会话里的用户）：靠右、蓝色气泡 */
  you: boolean;
  name: string;
  /** 名字的颜色取自它（用户 id 或名字） */
  who?: string;
  /** 名字旁边的时间，或「正在回复」 */
  label: string;
  /** 排队中：生成中又发的消息，还没被回复看到 */
  queued?: boolean;
  parts: BPart[];
  live?: LiveInfo;
  aborted?: boolean;
  failed?: boolean;
  /** 中止的标记文字 */
  abortMark: string;
  isNew: boolean;
  below?: React.ReactNode;
}) {
  const cls =
    'msg' +
    (isA ? ' is-luoli is-me' : '') +
    (you ? ' is-you is-me' : '') +
    (isNew && motionOn() ? ' is-new' : '');
  const ended = failed ? 'fail' : aborted ? 'abort' : null;
  const { frame, inner } = useBubbleFrame();
  return (
    <div className={cls} style={!isA ? { '--who': colorOf(who ?? '') } : undefined}>
      <div className="msg-meta">
        <b>{name}</b>
        {queued ? (
          <span className="queued" title="洛璃正在回复上一条，这条等她说完再回复">
            排队中
          </span>
        ) : (
          <time>{label}</time>
        )}
      </div>
      <div className="bubble" ref={frame}>
        <div className="bubble-in" ref={inner}>
          <Blocks parts={parts} hits={!isA} md={isA} live={live} ended={ended} />
          {aborted && <span className="mark">{abortMark}</span>}
          {failed && <span className="mark is-err">（回复出错中断）</span>}
        </div>
      </div>
      {below}
    </div>
  );
});
