import { memo, useEffect, useRef, useState } from 'react';
import { VirtualLog } from '../../components/VirtualLog';
import type { LogItem, ScrollState } from '../../components/VirtualLog';
import { MsgBubble } from '../../components/Bubble';
import { EASE_OUT_CSS } from '../../lib/easing';
import { motionOn } from '../../lib/prefs';
import { fmtDay } from '../../lib/util';
import { useBusRev } from '../../model/rev';
import { db } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import { partsOfRow } from '../../model/bubble';
import { authorOf } from '../../model/parts';
import { getSource } from '../../model/source';
import { status } from '../../model/status';
import type { MsgRow, Segment } from '../../model/types';
import { useAssistantName } from '../../model/who';

/* 时间线：聊天气泡、段分隔与摘要、折叠的工具调用和思考内容。用 @tanstack/react-virtual 排（动态高度，贴底）。
   数据按需取：打开会话时取最近一批（有未读就一次取到分隔线那条），滚到顶部时取更早的一批。
   打开时：有未读（未读数大于 0）停在分隔线「以下是新消息」那里，它在已读位置之后的第一条消息前面，不管是谁发的；没有未读就到底，不画分隔线。
   滚到最底下才算看过：已读位置落后于最后一条消息就标已读，不管未读数是不是 0（只有洛璃新回复的会话，已读位置也要往前走）。 */
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
        { duration: 260, easing: EASE_OUT_CSS },
      );
  }, [open]);
  return (
    <div className="seg">
      <div className="seg-line">
        <span>{`${SEG_REASON[seg.startReason]} · ${fmtDay(Date.parse(seg.createdAt))}`}</span>
        {seg.priorSummary && (
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
      {seg.priorSummary && open && (
        <div className="seg-sum" ref={sumRef}>
          <b>这一段开始时的摘要</b>
          {seg.priorSummary}
        </div>
      )}
    </div>
  );
}
function NewDivider() {
  return (
    <div className="seg">
      <div className="seg-line is-new">
        <span>以下是新消息</span>
      </div>
    </div>
  );
}

/* 一条消息：段的画法（思考、工具调用、文字、图片）与对话部件共用，见 components/Bubble.tsx */
export const MsgView = memo(function MsgView({
  row,
  convId,
  web,
  isNew,
}: {
  row: MsgRow;
  convId: string;
  web: boolean;
  isNew: boolean;
}) {
  const luoli = useAssistantName();
  const conv = db.conv(convId);
  const isA = row.role === 'assistant';
  const who = authorOf(row);
  const you = !isA && !!conv && conv.platform === 'web';
  const meta = row.message.metadata;
  return (
    <MsgBubble
      isA={isA}
      you={you}
      name={isA ? luoli : (who?.name ?? '')}
      who={who?.id || who?.name || ''}
      label={fmtDay(Date.parse(row.createdAt))}
      parts={partsOfRow(row)}
      aborted={meta?.aborted}
      failed={meta?.failed}
      abortMark={web ? '（已中止）' : '（回复被中止）'}
      isNew={isNew}
    />
  );
});
export function TypingView() {
  const luoli = useAssistantName();
  return (
    <div className="msg is-luoli is-me typing-msg">
      <div className="msg-meta">
        <b>{luoli}</b>
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
function entriesOf(convId: string, web: boolean, unreadSeq: number | null): Entry[] {
  const segs = db.segs(convId),
    list = db.msgs(convId);
  const hasMore = db.msgInfo.get(convId)?.hasMore ?? false;
  const firstSeq = list[0]?.seq ?? 0;
  const out: Entry[] = [];
  const segLine = (seg: Segment) => {
    // 还有更早的消息没取：开始在已取到的最早一条之前的段，它的分隔线在更上面
    if (hasMore && seg.startSeq < firstSeq) return;
    out.push({ key: 'seg-' + seg.startSeq, est: 40, node: <SegView seg={seg} /> });
  };
  let si = 0;
  for (const row of list) {
    while (si < segs.length && segs[si].startSeq <= row.seq) segLine(segs[si++]);
    if (unreadSeq !== null && row.seq === unreadSeq)
      out.push({ key: 'new-divider', est: 40, node: <NewDivider /> });
    out.push({ key: row.id, row });
  }
  while (si < segs.length) segLine(segs[si++]);
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
    'conv:messages',
    'conv:update',
    'conv:remove',
    'reply:end',
    'reply:abort',
    'reply:error',
    'status',
    'data:reset',
    'link',
  ]);
  const phase = useLinkPhase();
  const conv = db.conv(convId);
  const info = convId ? db.msgInfo.get(convId) : undefined;
  const hasInfo = !!info;
  /* 打开会话：取最近一批消息。重新连上服务（数据整批换了）后重新取 */
  useEffect(() => {
    if (convId && conv && phase === 'ready') getSource().openConversation(convId);
  }, [convId, !!conv, phase, hasInfo]);

  /* 「打开」的那一刻定下的：有没有未读、当时的已读位置、停在哪一条。之后标了已读分隔线也不动，换会话或重新取才重算。
     已读位置之后的第一条消息还没取到时（未读超过一次能取的 1000 条）：先不画分隔线，停在取到的最上面；
     往上翻取到它以后再画 */
  const open = useRef<{
    conv: string;
    token: number;
    hadUnread: boolean;
    readSeq: number;
    anchorId: string | null;
  } | null>(null);
  if (convId && conv && info?.state === 'ready') {
    if (open.current?.conv !== convId || open.current.token !== info.token) {
      const rows = db.msgs(convId);
      const hadUnread = conv.unread > 0;
      const covered = !info.hasMore || (rows[0] !== undefined && rows[0].seq <= conv.readSeq);
      const stop = hadUnread
        ? covered
          ? rows.find((r) => r.seq > conv.readSeq)
          : rows[0]
        : undefined;
      open.current = {
        conv: convId,
        token: info.token,
        hadUnread,
        readSeq: conv.readSeq,
        anchorId: stop?.id ?? null,
      };
    }
  }
  const resetKey = convId && info ? `${convId}:${info.token}` : null;
  /* 新来的气泡淡入；打开时已有的、往上翻取回的更早的消息不放 */
  const seen = useRef<{ key: string | null; ids: Set<string>; minSeq: number }>({
    key: null,
    ids: new Set(),
    minSeq: 0,
  });
  /* 滚动位置（VirtualLog 报告）：在最底下就标已读，快到顶就取更早的 */
  const scroll = useRef<ScrollState>({ atBottom: false, nearTop: false });
  const lastReset = useRef<string | null>(null);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    scroll.current = { atBottom: false, nearTop: false };
  }
  const check = () => {
    if (!convId) return;
    const c = db.conv(convId);
    const i = db.msgInfo.get(convId);
    if (!c || i?.state !== 'ready' || link.get().phase !== 'ready') return;
    const { atBottom, nearTop } = scroll.current;
    if (nearTop && i.hasMore && i.older === 'idle') getSource().loadOlder(convId);
    const last = c.last;
    if (
      atBottom &&
      last &&
      c.readSeq < last.seq &&
      (db.msgs(convId).at(-1)?.seq ?? 0) >= last.seq &&
      document.visibilityState === 'visible'
    )
      getSource().markRead(convId, last.seq);
  };
  const onScrollState = (s: ScrollState) => {
    scroll.current = s;
    check();
  };
  useEffect(() => {
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [convId]);

  const note = (title: string, text?: string, action?: React.ReactNode) => (
    <div className="tline" role="log" aria-label="时间线">
      <div className="empty">
        <b>{title}</b>
        {text}
        {action}
      </div>
    </div>
  );
  if (!convId || !conv) return note('没有选中的会话', '从左边选一个');
  // 消息已经取到的，连不上时还留着（阅读位置不丢），顶上贴一条提示；还没取到的才整个换成提示
  if (phase === 'down' && info?.state !== 'ready')
    return note('连不上洛璃服务', '连上后会自动恢复');
  if (!info || info.state === 'loading') return note('加载中…');
  if (info.state === 'error')
    return note(
      '这个会话的消息没取到',
      info.error,
      <button
        className="log-retry"
        type="button"
        onClick={() => getSource().openConversation(convId)}
      >
        重试
      </button>,
    );

  const rows = db.msgs(convId);
  const o = open.current;
  // 分隔线：已读位置之后的第一条消息前面；它还没取到（更早的消息没取完）时先不画
  const covered = !info.hasMore || (rows[0] !== undefined && rows[0].seq <= (o?.readSeq ?? 0));
  const dividerSeq =
    o?.hadUnread && covered ? (rows.find((r) => r.seq > o.readSeq)?.seq ?? null) : null;
  const raw = entriesOf(convId, web, dividerSeq);
  if (seen.current.key !== resetKey) {
    seen.current = {
      key: resetKey,
      ids: new Set(rows.map((r) => r.id)),
      minSeq: rows[0]?.seq ?? 0,
    };
  }
  const items = raw.map((e): LogItem => {
    if (!('row' in e)) return e;
    const isNew = !seen.current.ids.has(e.key) && e.row.seq > seen.current.minSeq;
    seen.current.ids.add(e.key);
    return {
      key: e.key,
      node: <MsgView row={e.row} convId={convId} web={web} isNew={isNew} />,
    };
  });
  const anchorKey = o?.anchorId ?? null;
  const topNotice =
    phase === 'down' ? (
      <span className="log-pill is-err">连不上洛璃服务，连上后会自动恢复</span>
    ) : info.older === 'loading' ? (
      <span className="log-pill">加载中…</span>
    ) : info.older === 'error' ? (
      <span className="log-pill is-err">
        更早的消息没取到
        <button
          className="log-retry"
          type="button"
          onClick={() => getSource().loadOlder(convId, true)}
        >
          重试
        </button>
      </span>
    ) : null;
  return (
    <VirtualLog
      items={items}
      resetKey={resetKey}
      label="时间线"
      live={web}
      anchorKey={anchorKey}
      topNotice={topNotice}
      onScrollState={onScrollState}
    />
  );
}
