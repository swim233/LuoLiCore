import { memo, useEffect, useRef, useState } from 'react';
import { Chat, useChat } from '@ai-sdk/react';
import { MsgBubble } from '../../components/Bubble';
import { EventLine } from '../../components/EventLine';
import { Thumb } from '../../components/Hl';
import { VirtualLog } from '../../components/VirtualLog';
import { Pane } from '../../components/Pane';
import { useGlide } from '../../components/glide';
import type { LogItem, ScrollState } from '../../components/VirtualLog';
import { IconChat } from '../../components/icons';
import { Button, Chevron, Empty, IconButton, Notice, Spinner } from '@luoli/ui/controls';
import { IconChevronLeft } from '@luoli/ui/icons';
import { useStore } from '@luoli/ui/store';
import { fmtDay, fmtShort } from '../../lib/util';
import { bus } from '../../model/bus';
import { partsOfChat, partsOfRow } from '../../model/bubble';
import { db } from '../../model/db';
import { eventOf } from '../../model/events';
import { link, useLinkPhase } from '../../model/link';
import { authorOf } from '../../model/parts';
import { useBusRev } from '../../model/rev';
import { replyInfo } from '../../model/replyInfo';
import { getSource } from '../../model/source';
import type { MsgRow } from '../../model/types';
import { useAssistantName, useWebAuthor } from '../../model/who';
import type { ChatMessage } from '../../../server/types';
import { ConvList } from '../sessions/ConvList';
import { TypingView } from '../sessions/Timeline';
import { stardustAt } from '../now/stardust';
import {
  abortChat,
  addFiles,
  anyBusy,
  awaitingReply,
  creatingReq,
  flightKey,
  flightsOf,
  isBusy,
  isBusyElsewhere,
  removeAtt,
  retryChat,
  retryIsDenied,
  sendChat,
  startedFrom,
} from './chatCore';
import type { Req } from './chatCore';
import {
  chatCur,
  chatState,
  draftChanged,
  draftKey,
  draftOf,
  newWebConv,
  switchTo,
  webConvs,
} from './chatState';
import type { ViewProps, WidgetDef } from '../types';

/* 网页自己的会话：和洛璃服务的对话接口（POST /api/chat）聊天。
   对话里的历史消息和「会话」部件一样从服务取（分批，往上翻取更早的），别的标签页发的消息、写入历史的回复经 SSE 推来；
   这个标签页发出的回复，逐字的过程用 useChat 接服务的流画（chatCore.ts），写入历史后同一个气泡改画历史里的。 */

/* 输入框还没有任何对话时（新对话）用的占位：没有消息的 Chat */
const NO_CHAT = new Chat<ChatMessage>({ messages: [] });

/** 出错的回复下面的「重试」：让洛璃对着同样的历史再回复一次，不用重新打字 */
function RetryBar({ convId, lastSeq }: { convId: string; lastSeq: number }) {
  return (
    <Button
      size="sm"
      className="chat-retry"
      onClick={() => {
        if (!isBusy(convId)) retryChat(convId);
      }}
      data-seq={lastSeq}
    >
      重试
    </Button>
  );
}

/** 用户（自己）的一条消息：名字取这条消息自己存的发言人（和时间线一样，以后改了 LUOLI_WEB_NAME，旧消息照旧）；
    生成中发的、还没被回复看到的标「排队中」 */
const UserBubble = memo(function UserBubble({
  row,
  queued,
  isNew,
}: {
  row: MsgRow;
  queued: boolean;
  isNew: boolean;
}) {
  const me = useWebAuthor();
  const who = authorOf(row);
  return (
    <MsgBubble
      isA={false}
      you
      name={who?.name ?? me}
      who={who?.id || who?.name || me}
      label={fmtDay(Date.parse(row.createdAt))}
      queued={queued}
      parts={partsOfRow(row)}
      abortMark=""
      isNew={isNew}
    />
  );
});

/** 刚发出的那条消息：还没有历史里的行时（新对话切过来、消息还没取到）先显示它（只有预览）。
    名字取服务告诉的网页发言人（和写进历史后的 UserBubble 是同一个名字、同一个颜色，换过去不闪） */
function PendingBubble({ req }: { req: Req }) {
  const me = useWebAuthor();
  return (
    <MsgBubble
      isA={false}
      you
      name={me}
      who={me}
      label={fmtDay(req.startedAt)}
      parts={[
        ...req.preview.images.map((src) => ({ kind: 'image' as const, info: { src } })),
        ...(req.preview.text ? [{ kind: 'text' as const, text: req.preview.text }] : []),
      ]}
      abortMark=""
      isNew
    />
  );
}

/**
 * 洛璃的一条回复：历史里的行，或者这个标签页正在逐字出的回复（req），或者两者都有（刚写入历史、光标还在停）。
 * 同一个气泡（同一个键）从逐字出的样子变成历史里的样子，不重建：折叠的展开状态、逐字落下的字都留着。
 * 没有 req 时 useChat 接一个空的 Chat（hook 不能有条件地调用）
 */
const ReplyBubble = memo(function ReplyBubble({
  convId,
  row,
  req,
  isNew,
  retry,
}: {
  convId: string;
  row?: MsgRow;
  req?: Req;
  isNew: boolean;
  retry: boolean;
}) {
  const luoli = useAssistantName();
  const { messages } = useChat<ChatMessage>({ chat: req?.chat ?? NO_CHAT, throttle: 30 });
  useBusRev(['reply:info', 'chat:flight']);
  const m = messages.findLast((x) => x.role === 'assistant');
  const info = replyInfo.details(convId);
  const entry = req && info && info.replyId === req.replyId ? info : undefined;
  const parts = row ? partsOfRow(row) : m ? partsOfChat(m, entry) : [];
  const streaming = !!req && !req.finished;
  const meta = row?.message.metadata;
  const aborted = row ? !!meta?.aborted : req?.how === 'abort';
  const failed = row ? !!meta?.failed : req?.how === 'error';
  const at = row ? Date.parse(row.createdAt) : (req?.startedAt ?? 0);
  return (
    <MsgBubble
      isA
      you={false}
      name={luoli}
      label={streaming ? '正在回复' : fmtDay(at)}
      parts={parts}
      live={
        req
          ? {
              convId,
              streaming,
              lingerUntil: req.lingerUntil,
              onRevealed: req.how === 'end' ? (cursor) => stardustAt(convId, cursor) : undefined,
            }
          : undefined
      }
      aborted={aborted}
      failed={failed}
      abortMark="（已中止）"
      isNew={isNew}
      below={retry ? <RetryBar convId={convId} lastSeq={row?.seq ?? 0} /> : undefined}
    />
  );
});

function SegLine({ convId }: { convId: string }) {
  const seg = db.segs(convId)[0];
  if (!seg) return null;
  return (
    <div className="seg">
      <div className="seg-line">
        <span>{`会话开始 · ${fmtDay(Date.parse(seg.createdAt))}`}</span>
      </div>
    </div>
  );
}

const note = (title: string, text?: string, action?: React.ReactNode) => (
  <div className="tline pane-sc" role="log" aria-live="polite" aria-label="对话">
    <Empty title={title} action={action}>
      {text}
    </Empty>
  </div>
);
const emptyItem = (): LogItem => ({
  key: 'empty',
  node: <Empty title="还没有消息">在下面说点什么吧</Empty>,
});

/* 这个会话里发出了消息、点了重试：时间线要滚到最底下（窗口里的和全屏里的两份都收到）。返回的数交给 VirtualLog 的 jumpKey */
function useJumpOnSend(convId: string | null) {
  const [n, setN] = useState(0);
  useEffect(
    () =>
      bus.on('chat:sent', (e) => {
        if (e.convId === convId) setN((x) => x + 1);
      }),
    [convId],
  );
  return n;
}

/* 刚发出的第一句和它的回复：新对话发出以后，服务回应（收下）之前；收下后对话马上换成这个会话，但它的消息还没取到时也先这样显示 */
function startedItems(req: Req): LogItem[] {
  const items: LogItem[] = [{ key: 'pending', node: <PendingBubble req={req} /> }];
  for (const f of flightsOf(req.convId))
    items.push({
      key: flightKey(f),
      node: <ReplyBubble convId={f.convId!} req={f} isNew={false} retry={false} />,
    });
  return items;
}

/* 还没建的新对话：发出第一句以后，服务还没回应时，先显示发出的那条 */
function NewLog() {
  useBusRev(['chat:flight', 'reply:info', 'conv:messages']);
  useStore(chatState, (s) => s.creating);
  const jump = useJumpOnSend(null);
  const req = creatingReq();
  return (
    <VirtualLog
      items={req ? startedItems(req) : [emptyItem()]}
      resetKey="new"
      label="对话"
      live
      jumpKey={jump}
    />
  );
}

/* 消息列表：虚拟滚动。历史消息分批取（打开时取最近一批，滚到顶取更早的），
   这个标签页正在出的回复放在它该在的位置：排队的消息（生成中又发的）在它后面 */
function ChatLog({ convId }: { convId: string }) {
  useBusRev([
    'message',
    'conv:messages',
    'conv:update',
    'conv:remove',
    'chat:flight',
    'reply:info',
    'data:reset',
    'link',
  ]);
  const phase = useLinkPhase();
  const jump = useJumpOnSend(convId);
  const conv = db.conv(convId);
  const info = db.msgInfo.get(convId);
  const hasInfo = !!info;
  /* 打开对话：取最近一批消息。重新连上服务（数据整批换了）后重新取 */
  useEffect(() => {
    if (conv && phase === 'ready') getSource().openConversation(convId);
  }, [convId, !!conv, phase, hasInfo]);
  const resetKey = info ? `${convId}:${info.token}` : null;
  /* 新来的气泡淡入；打开时已有的、往上翻取回的更早的消息不放 */
  const seen = useRef<{ key: string | null; ids: Set<string>; minSeq: number }>({
    key: null,
    ids: new Set(),
    minSeq: 0,
  });
  /* 滚动位置（VirtualLog 报告）：快到顶就取更早的 */
  const scroll = useRef<ScrollState>({ atBottom: false, nearTop: false });
  const lastReset = useRef<string | null>(null);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    scroll.current = { atBottom: false, nearTop: false };
  }
  const onScrollState = (s: ScrollState) => {
    scroll.current = s;
    const i = db.msgInfo.get(convId);
    if (
      s.nearTop &&
      i?.state === 'ready' &&
      i.hasMore &&
      i.older === 'idle' &&
      link.get().phase === 'ready'
    )
      getSource().loadOlder(convId);
  };

  if (!conv) return note('没有选中的对话');
  // 刚从新对话发出第一句、切过来，消息还没取到（服务的 SSE 不通时 phase 也是 down，但这个请求是通的）：先显示发出的那句和它的回复
  const started = !info || info.state === 'loading' ? startedFrom(convId) : undefined;
  if (started)
    return (
      <VirtualLog
        items={startedItems(started)}
        resetKey={'new:' + convId}
        label="对话"
        live
        jumpKey={jump}
      />
    );
  if (phase === 'down' && info?.state !== 'ready')
    return note('连不上洛璃服务', '连上后会自动恢复');
  if (!info || info.state === 'loading') return note('加载中…');
  if (info.state === 'error')
    return note(
      '这个对话的消息没取到',
      info.error,
      <Button size="sm" onClick={() => getSource().openConversation(convId)}>
        重试
      </Button>,
    );

  const rows = db.msgs(convId);
  if (seen.current.key !== resetKey)
    seen.current = {
      key: resetKey,
      ids: new Set(rows.map((r) => r.id)),
      minSeq: rows[0]?.seq ?? 0,
    };
  const flights = flightsOf(convId);
  const queuedFrom = replyInfo.queuedFrom(convId);
  const busy = isBusy(convId);
  // 还没写进历史的回复，放在第一条排队的消息前面（回复开始之后写入的消息排在它后面），没有排队的就放最后
  const written = new Set(rows.map((r) => r.id));
  const inflight = flights.filter((f) => !written.has(flightKey(f)));
  const flightOf = new Map(flights.map((f) => [flightKey(f), f]));
  type Entry = { key: string; row?: MsgRow; req?: Req; typing?: boolean };
  const entries: Entry[] = [];
  let placed = false;
  // 这个标签页发的请求在等回复，可它的内容还没有（刚发出还没有第一段）：先显示「正在回复」，位置和有内容时一样。
  // 回复已经写进历史、请求的流还没收尾的那一小段不画（历史里已经有这条回复了，画出来会闪一下，时间线跟着跳）；
  // 别的标签页发的、任务到点触发的（这个标签页没有请求）不画，输入框上方有「正在回复」那一行（ReplyingBar）
  const typing = awaitingReply(convId, written) && !inflight.length;
  const placeInflight = () => {
    placed = true;
    for (const f of inflight) entries.push({ key: flightKey(f), req: f });
    if (typing) entries.push({ key: 'typing', typing: true });
  };
  for (const row of rows) {
    if (!placed && (inflight.length || typing) && queuedFrom !== undefined && row.seq >= queuedFrom)
      placeInflight();
    entries.push({ key: row.id, row, req: flightOf.get(row.id) });
  }
  if (!placed) placeInflight();
  // 「重试」：最后一条是出错的回复，没有在生成，服务也没拒绝过
  const lastE = entries.at(-1);
  const lastFailed = lastE
    ? lastE.row
      ? lastE.row.role === 'assistant' && !!lastE.row.message.metadata?.failed
      : lastE.req?.how === 'error'
    : false;
  const lastSeq = rows.at(-1)?.seq ?? 0;
  const canRetry = lastFailed && !busy && !retryIsDenied(convId, lastSeq);
  const items: LogItem[] = [];
  if (!info.hasMore) items.push({ key: 'seg', est: 40, node: <SegLine convId={convId} /> });
  if (!entries.length) items.push(emptyItem());
  entries.forEach((e, i) => {
    if (e.typing) {
      items.push({ key: e.key, node: <TypingView /> });
      return;
    }
    const isNew = !seen.current.ids.has(e.key) && (e.row ? e.row.seq > seen.current.minSeq : true);
    seen.current.ids.add(e.key);
    const row = e.row;
    const retry = canRetry && i === entries.length - 1;
    // 事件（任务到点）：居中的一行灰字，不是自己发的消息，不带「排队中」
    if (row && eventOf(row))
      items.push({ key: e.key, node: <EventLine row={row} isNew={isNew} /> });
    else if (row?.role === 'user')
      items.push({
        key: e.key,
        node: (
          <UserBubble
            row={row}
            queued={queuedFrom !== undefined && row.seq >= queuedFrom}
            isNew={isNew}
          />
        ),
      });
    else
      items.push({
        key: e.key,
        node: <ReplyBubble convId={convId} row={row} req={e.req} isNew={isNew} retry={retry} />,
      });
  });
  const topNotice =
    phase === 'down' ? (
      <Notice tone="danger" className="log-pill">
        连不上洛璃服务，连上后会自动恢复
      </Notice>
    ) : info.older === 'loading' ? (
      <Notice role="status" className="log-pill">
        加载更早的消息…
      </Notice>
    ) : info.older === 'error' ? (
      <Notice tone="danger" className="log-pill">
        更早的消息没取到
        <Button size="xs" onClick={() => getSource().loadOlder(convId, true)}>
          重试
        </Button>
      </Notice>
    ) : null;
  return (
    <VirtualLog
      items={items}
      resetKey={resetKey}
      label="对话"
      live
      topNotice={topNotice}
      onScrollState={onScrollState}
      jumpKey={jump}
    />
  );
}

/** 输入框上方的一行「洛璃正在回复…」加「中止」：这个会话在回复，但不是这个标签页发的请求（别的标签页发的、任务到点触发的），
    这里收不到它的流，看不到逐字的过程；回复写进历史后这一行消失，回复照常出现。中止走服务的中止接口（同时取消排队的补回复） */
function ReplyingBar({ convId }: { convId: string | null }) {
  const luoli = useAssistantName();
  useBusRev(['reply:info', 'chat:flight']);
  if (!isBusyElsewhere(convId)) return null;
  return (
    <div className="chat-live" role="status">
      <Spinner className="spin" />
      <span>{luoli}正在回复…</span>
      <Button size="xs" onClick={() => void abortChat(convId)}>
        中止
      </Button>
    </div>
  );
}

/* 输入：Enter 发送、Shift+Enter 换行（输入法组词中不发送）；粘贴或拖入图片（最多 10 张、每张不超过 20 MB）；
   生成中也能发（服务把它排队，当前回复结束后再回复一次）；生成中按 Esc 或点「中止」中止并取消排队的回复 */
function Composer({ convId, fullId }: { convId: string | null; fullId: string }) {
  const luoli = useAssistantName();
  const key = draftKey(convId);
  useBusRev(['chat:draft', 'chat:flight', 'reply:info']);
  const d = draftOf(key);
  const text = d.text;
  const busy = isBusy(convId);
  const [drop, setDrop] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(140, el.scrollHeight) + 'px';
    }
  }, [text]);
  /* 待发的图片是横着的一行：鼠标滚轮竖着滚时也横着走（能滚的时候才接管，滚到头了让页面接着滚）。
     这一行带 data-native-wheel：全局的滚轮缓动（shell/wheel.ts）不处理它里面的滚轮，留给这里 */
  const attsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = attsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (
        max <= 0 ||
        (e.deltaY < 0 && el.scrollLeft <= 0) ||
        (e.deltaY > 0 && el.scrollLeft >= max)
      )
        return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const hasContent = !!text.trim() || d.atts.length > 0;
  // 输入框空着、在生成时发送键是「中止」。不是这个标签页发的请求（别的标签页、任务到点触发的）时，输入框上方已经有「正在回复」那一行带「中止」（ReplyingBar），
  // 这里不再重复，发送键照常
  const stop = busy && !hasContent && !isBusyElsewhere(convId);
  const canSend = hasContent && !d.sending;
  const send = () => {
    if (canSend) void sendChat(convId, text);
  };
  const abort = () => void abortChat(convId);
  const uploading = d.atts.some((a) => a.state === 'uploading');
  return (
    <div
      className={'chat-in' + (drop ? ' is-drop' : '')}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDrop(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDrop(false);
        addFiles(key, [...e.dataTransfer.files]);
      }}
    >
      {d.note && (
        <div className={'chat-note' + (d.note.err ? ' is-err' : '')} role="status">
          {d.note.text}
        </div>
      )}
      <div className="chat-atts" ref={attsRef} data-native-wheel="">
        {d.atts.map((a) => (
          <span
            className={'att' + (a.state === 'failed' ? ' is-bad' : '')}
            key={a.id}
            title={a.state === 'failed' ? `${a.name}：${a.error ?? '上传失败'}` : a.name}
          >
            <Thumb part={{ blob: a.url, name: a.name }} w={56} h={56} />
            {a.state === 'uploading' && (
              <span className="att-state" aria-label="上传中">
                <Spinner className="spin" />
              </span>
            )}
            {a.state === 'failed' && (
              <span className="att-state is-bad" aria-label="上传失败">
                !
              </span>
            )}
            <button
              type="button"
              title="移除这张图片"
              aria-label={'移除图片 ' + a.name}
              onClick={() => {
                removeAtt(key, a.id);
                ta.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="chat-row">
        <textarea
          ref={ta}
          className="chat-ta"
          rows={1}
          id={fullId}
          placeholder={`和${luoli}说点什么…`}
          aria-label={`给${luoli}的消息`}
          value={text}
          onChange={(e) => {
            draftOf(key).text = e.target.value;
            draftChanged();
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape' && busy) {
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              abort();
            }
          }}
          onPaste={(e) => {
            const fs = [...(e.clipboardData?.files || [])].filter((f) =>
              f.type.startsWith('image/'),
            );
            if (fs.length) {
              e.preventDefault();
              addFiles(key, fs);
            }
          }}
        />
        <Button
          variant={stop ? 'danger' : 'primary'}
          className="chat-send"
          disabled={d.sending}
          title={
            stop ? '中止生成（Esc）' : busy ? '发送：排在当前回复后面（Enter）' : '发送（Enter）'
          }
          onClick={() => {
            if (stop) abort();
            else send();
          }}
        >
          {d.sending ? (uploading ? '上传中' : '发送中') : stop ? '中止' : '发送'}
        </Button>
      </div>
      <div className="chat-hint">
        <span className="chat-hint-keys">Enter 发送 · Shift+Enter 换行 · 可以粘贴或拖入图片</span>
        {busy && (
          <span className="chat-hint-busy">
            {hasContent ? '生成中 · 发出的会排队 · Esc 中止' : '生成中 · Esc 中止'}
          </span>
        )}
      </div>
    </div>
  );
}

/* 输入框的键：换会话就重建（草稿按会话分开）；唯一的例外是新对话发出第一句、服务把会话建好切过来：
   输入框接着用，它还握着焦点，接着打的字要进输入框（带过去的字见 chatCore.ts 的 carryNewDraft） */
function useInputKey(cur: string | null) {
  const s = useRef({ cur, n: 0 });
  if (s.current.cur !== cur) {
    const created = s.current.cur === null && cur !== null && !!startedFrom(cur);
    s.current = { cur, n: created ? s.current.n : s.current.n + 1 };
  }
  return 'input-' + s.current.n;
}

function ChatView({ mode }: ViewProps) {
  const full = mode === 'full';
  useBusRev(['chat:switch', 'conv:add', 'conv:update', 'conv:remove', 'data:reset', 'message']);
  useStore(chatState, (s) => s.cur + (s.isNew ? '*' : ''));
  const cur = chatCur();
  const inputKey = useInputKey(cur);
  const c = db.conv(cur);
  const [menu, setMenu] = useState(false);
  const [detail, setDetail] = useState(true);
  const barRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (barRef.current?.querySelector('.chat-menu')?.contains(t) || pickRef.current?.contains(t))
        return;
      setMenu(false);
    };
    document.addEventListener('pointerdown', outside, true);
    const off = bus.on('chat:switch', () => setMenu(false));
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      off();
    };
  }, [menu]);
  const convs = webConvs();
  const title = c ? c.title : '新对话';
  const body = cur ? <ChatLog key={'log-' + cur} convId={cur} /> : <NewLog key="log-new" />;
  const composer = (
    <Composer key={inputKey} convId={cur} fullId={full ? 'chat-input-full' : 'chat-input'} />
  );
  const bottom = (
    <>
      <ReplyingBar convId={cur} />
      {composer}
    </>
  );
  if (!full) {
    return (
      <Pane
        className="chat"
        top={
          <div className="chat-bar" ref={barRef}>
            <Button
              className="chat-pick"
              ref={pickRef}
              aria-haspopup="true"
              aria-expanded={menu}
              title="切换对话"
              onClick={() => setMenu(!menu)}
            >
              <span className="chat-pick-label">{title}</span>
              <Chevron dir="down" />
            </Button>
            <Button
              className="chat-new"
              onClick={() => {
                newWebConv();
                setTimeout(() => document.getElementById('chat-input')?.focus());
              }}
            >
              ＋ 新对话
            </Button>
            {menu && <ChatMenu convs={convs} cur={cur} close={() => setMenu(false)} />}
          </div>
        }
        bottom={bottom}
      >
        {body}
      </Pane>
    );
  }
  return (
    <div className={'chat-full' + (detail ? ' is-detail' : '')}>
      <Pane
        className="sess-side is-side"
        top={
          <>
            <div className="sess-side-head">
              <span>网页对话</span>
              <span>{convs.length} 个</span>
            </div>
            <Button
              className="chat-new is-side"
              onClick={() => {
                newWebConv();
                setDetail(true);
                setTimeout(() => document.getElementById('chat-input-full')?.focus());
              }}
            >
              ＋ 新对话
            </Button>
          </>
        }
      >
        <ConvList
          convs={convs}
          selectedId={cur}
          onPick={(id) => {
            switchTo(id);
            setDetail(true);
          }}
          rev={db.rev}
          label="对话列表"
        />
      </Pane>
      <Pane
        className="chat sess-main is-main"
        top={
          <div className="chat-bar">
            <IconButton
              className="sess-back"
              title="返回列表"
              aria-label="返回列表"
              onClick={() => setDetail(false)}
            >
              <IconChevronLeft />
            </IconButton>
            <h3 className="chat-title">{title}</h3>
          </div>
        }
        bottom={bottom}
      >
        {body}
      </Pane>
    </div>
  );
}

/* 对话里选会话的下拉菜单：玻璃底；悬停时一块高亮跟着鼠标从一项滑到另一项（和会话列表同一套，components/glide.ts） */
function ChatMenu({
  convs,
  cur,
  close,
}: {
  convs: ReturnType<typeof webConvs>;
  cur: string | null;
  close: () => void;
}) {
  const g = useGlide('.chat-menu > button');
  return (
    <div
      className="chat-menu"
      role="menu"
      ref={(el) => {
        g.list.current = el;
      }}
    >
      <i className="glide" ref={(el) => void (g.glide.current = el)} aria-hidden="true" />
      {convs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="menuitem"
          aria-current={x.id === cur}
          onClick={() => {
            close();
            switchTo(x.id);
          }}
        >
          <span>{x.title}</span>
          <time>{fmtShort(db.lastAt(x.id))}</time>
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          close();
          newWebConv();
        }}
      >
        <span className="chat-menu-new">＋ 新对话</span>
      </button>
    </div>
  );
}

export const CHAT_DEF: WidgetDef = {
  id: 'chat',
  name: '对话',
  icon: IconChat,
  defaultSize: '1x2',
  refreshOn: [
    'conv:add',
    'conv:remove',
    'conv:update',
    'data:reset',
    'chat:switch',
    'chat:flight',
    'reply:info',
    'reply:end',
    'reply:abort',
    'reply:error',
    'message',
  ],
  thumb() {
    const n = webConvs().length;
    if (anyBusy())
      return (
        <>
          <em>正在回复</em> · {n} 个对话
        </>
      );
    return n ? `${n} 个对话` : '还没有对话';
  },
  sub() {
    const id = chatCur();
    return id ? (db.conv(id)?.title ?? '') : chatState.get().isNew ? '新对话' : '';
  },
  View: ChatView,
};
