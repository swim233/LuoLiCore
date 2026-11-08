import { memo, useEffect, useRef, useState } from 'react';
import { VirtualLog } from '../../components/VirtualLog';
import type { LogItem } from '../../components/VirtualLog';
import { Hl, Thumb } from '../../components/Hl';
import { motionOn } from '../../lib/prefs';
import { fmtDay, nf } from '../../lib/util';
import { useBusRev } from '../../model/rev';
import { db } from '../../model/db';
import { status } from '../../model/status';
import type { ImagePart, MsgRow, Segment, TextPart, ToolPart } from '../../model/types';
import { colorOf, LUOLI } from '../../model/who';

/* 时间线：聊天气泡、段分隔与摘要、折叠的工具调用和思考内容。用 @tanstack/react-virtual 排（动态高度，贴底） */
const SEG_REASON = {
  first: '会话开始',
  idle: '空闲 4 小时后开始新的一段',
  compress: '上下文太长，压缩后开始新的一段',
};

function SegView({ seg }: { seg: Segment }) {
  const [open, setOpen] = useState(false);
  const sumRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && motionOn() && sumRef.current)
      sumRef.current.animate(
        [
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 260, easing: 'ease-out' },
      );
  }, [open]);
  return (
    <div className="seg">
      <div className="seg-line">
        <span>{`${SEG_REASON[seg.start_reason]} · ${fmtDay(Date.parse(seg.created_at))}`}</span>
        {seg.prior_summary && (
          <button
            className="seg-btn"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            摘要
            <span className="chev" aria-hidden="true" />
          </button>
        )}
      </div>
      {seg.prior_summary && open && (
        <div className="seg-sum" ref={sumRef}>
          <b>这一段开始时的摘要</b>
          {seg.prior_summary}
        </div>
      )}
    </div>
  );
}
function ToolFold({ p }: { p: ToolPart }) {
  const ok = p.state !== 'output-error';
  return (
    <details className="fold">
      <summary>
        <span>{`◇ fetch · ${p.input.url}`}</span>
        <span className={ok ? 'ok' : 'bad'}>
          {(ok ? '✓ ' : '× ') + (((p.demo && p.demo.ms) || 800) / 1000).toFixed(1) + 's'}
        </span>
      </summary>
      <div className="fold-body">
        <div>{p.output ? p.output.summary : '工具调用未完成'}</div>
        {p.output && p.output.chars ? (
          <div
            style={{ color: 'var(--fg-3)', fontSize: 12, marginTop: 2 }}
          >{`结果 ${nf(p.output.chars)} 字符`}</div>
        ) : null}
        {p.demo?.image && (
          <div className="msg-imgs" style={{ marginTop: 6 }}>
            <Thumb part={p.demo.image} />
          </div>
        )}
      </div>
    </details>
  );
}
export const MsgView = memo(function MsgView({
  row,
  web,
  isNew,
}: {
  row: MsgRow;
  web: boolean;
  isNew: boolean;
}) {
  const conv = db.conv(row.conversation_id);
  const m = row.ui_message;
  const isA = row.role === 'assistant';
  const who = m.metadata.author || { name: '', uid: null };
  const you = !isA && conv && conv.platform === 'web';
  const imgs = m.parts.filter((p): p is ImagePart => p.type === 'file');
  const text = m.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const cls =
    'msg' +
    (isA ? ' is-luoli is-me' : '') +
    (you ? ' is-you is-me' : '') +
    (isNew && motionOn() ? ' is-new' : '');
  return (
    <div className={cls} style={!isA ? { '--who': colorOf(who.uid || who.name) } : undefined}>
      <div className="msg-meta">
        <b>{isA ? LUOLI : who.name}</b>
        <time>{fmtDay(Date.parse(row.created_at))}</time>
      </div>
      <div className="bubble">
        {m.parts.map((p, i) => {
          if (p.type === 'reasoning')
            return (
              <details className="fold" key={i}>
                <summary>
                  <span>{`思考了 ${p.demo?.sec || 2} 秒`}</span>
                </summary>
                <div className="fold-body">{p.text}</div>
              </details>
            );
          if (p.type === 'tool-fetch') return <ToolFold p={p} key={i} />;
          return null;
        })}
        {imgs.length > 0 && (
          <div className="msg-imgs">
            {imgs.map((p, i) => (
              <Thumb part={p} key={i} />
            ))}
          </div>
        )}
        {text && (
          <span>
            <Hl text={text} hits={!isA} />
          </span>
        )}
        {m.metadata.aborted && (
          <span className="mark">{web ? '（已中止）' : '（回复被中止）'}</span>
        )}
        {m.metadata.failed && <span className="mark is-err">（回复出错中断）</span>}
      </div>
    </div>
  );
});
function TypingView() {
  return (
    <div className="msg is-luoli is-me typing-msg">
      <div className="msg-meta">
        <b>{LUOLI}</b>
        <time>正在回复</time>
      </div>
      <div className="bubble">
        <span className="typing" aria-label="正在回复">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
/* 时间线的条目：段分隔、空状态、打字气泡直接带着要画的节点；消息只带 row，画的时候再决定是不是新来的 */
type Entry = LogItem | { key: string; row: MsgRow };
function entriesOf(convId: string | null, web: boolean): Entry[] {
  if (!convId || !db.conv(convId)) return [];
  const segs = db.segs(convId),
    list = db.msgs(convId);
  const out: Entry[] = [];
  let si = 0;
  for (const row of list) {
    while (si < segs.length && segs[si].start_seq <= row.seq) {
      const seg = segs[si++];
      out.push({ key: seg.id, est: 40, node: <SegView seg={seg} /> });
    }
    out.push({ key: row.id, row });
  }
  while (si < segs.length) {
    const seg = segs[si++];
    out.push({ key: seg.id, est: 40, node: <SegView seg={seg} /> });
  }
  if (!list.length)
    out.push({
      key: 'empty',
      node: (
        <div className="empty">
          <b>还没有消息</b>
          {web ? '在下面说点什么吧' : '有人发言后会出现在这里'}
        </div>
      ),
    });
  if (!web && status.conv.has(convId)) out.push({ key: 'typing', node: <TypingView /> });
  return out;
}
export function Timeline({ convId, web = false }: { convId: string | null; web?: boolean }) {
  useBusRev([
    'message',
    'reply:end',
    'reply:abort',
    'reply:error',
    'status',
    'conv:update',
    'conv:remove',
    'data:reset',
  ]);
  const seen = useRef<{ conv: string | null; ids: Set<string> }>({ conv: null, ids: new Set() });
  const raw = entriesOf(convId, web);
  if (seen.current.conv !== convId)
    seen.current = { conv: convId, ids: new Set(raw.filter((e) => 'row' in e).map((e) => e.key)) };
  /* 新消息进来的气泡从下面淡入上来；之前就有的不放 */
  const items = raw.map((e): LogItem => {
    if (!('row' in e)) return e;
    const isNew = !seen.current.ids.has(e.key);
    seen.current.ids.add(e.key);
    return { key: e.key, node: <MsgView row={e.row} web={web} isNew={isNew} /> };
  });
  if (!convId || !db.conv(convId)) {
    return (
      <div className="tline" role="log" aria-label="时间线">
        <div className="empty">
          <b>没有选中的会话</b>从左边选一个
        </div>
      </div>
    );
  }
  return <VirtualLog items={items} resetKey={convId} label="时间线" live={web} />;
}
