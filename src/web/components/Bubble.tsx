import { memo } from 'react';
import { Hl, Spin } from './Hl';
import { LiveText } from './LiveText';
import { Pic } from './Pic';
import { motionOn } from '../lib/prefs';
import { nf } from '../lib/util';
import { argsLine } from '../model/parts';
import type { BPart } from '../model/bubble';
import { colorOf } from '../model/who';

/* 聊天气泡：时间线（会话部件）和对话部件共用。按段的先后画：思考、工具调用、文字各是一块，连着的图片并成一排。
   - 思考：折叠，写「思考了 N 秒」（消息里记了才有，以前的消息写「思考过程」），展开是思考的内容；
   - 工具调用：折叠，一行是工具名加给界面看的一句话（没有就是参数的前一截），右边是状态（转圈、✓ 0.8s、× 0.8s）；
     展开是参数、结果的开头与总长度、结果里的图片，出错时是错误说明；
   - 文字：live 时最后一段文字逐字落下（对话里自己这个标签页正在出的回复），其余静态高亮。 */
const fmtMs = (ms: number) => (ms / 1000).toFixed(1) + 's';

/** 工具参数的全文（太长截短） */
function prettyInput(input: unknown) {
  const s = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  return s.length > 1000 ? s.slice(0, 1000) + '…' : s;
}

function ThinkFold({
  p,
  ended,
}: {
  p: Extract<BPart, { kind: 'think' }>;
  ended: 'abort' | 'fail' | null;
}) {
  if (p.streaming) {
    // 还在想：没出结果时只有一行「思考中…」；消息已经结束（中止、出错）还停在这里的，写明是怎么断的
    if (ended)
      return (
        <div className="fold is-think">
          <span className="fold-tag">{ended === 'fail' ? '思考中断' : '思考被中止'}</span>
        </div>
      );
    return (
      <details className="fold is-think">
        <summary>
          <span>思考中…</span>
        </summary>
      </details>
    );
  }
  if (!p.text.trim()) return null;
  return (
    <details className="fold is-think">
      <summary>
        <span>{p.sec ? `思考了 ${p.sec} 秒` : '思考过程'}</span>
      </summary>
      <div className="fold-body">{p.text}</div>
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
}

export function Blocks({
  parts,
  hits,
  live,
  ended,
}: {
  parts: BPart[];
  hits: boolean;
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
          <span className="msg-text" key={i}>
            <LiveText
              convId={live.convId}
              text={p.text}
              streaming={live.streaming}
              lingerUntil={live.lingerUntil}
            />
          </span>
        ) : (
          <span className="msg-text" key={i}>
            <Hl text={p.text} hits={hits} />
          </span>
        ),
      );
    }
  });
  flush();
  return <>{blocks}</>;
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
      <div className="bubble">
        <Blocks parts={parts} hits={!isA} live={live} ended={ended} />
        {aborted && <span className="mark">{abortMark}</span>}
        {failed && <span className="mark is-err">（回复出错中断）</span>}
      </div>
      {below}
    </div>
  );
});
