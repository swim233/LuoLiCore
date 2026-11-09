import { useEffect, useState } from 'react';
import { IconSessions } from '../../components/icons';
import { Pane } from '../../components/Pane';
import { bus } from '../../model/bus';
import type { BusEventName } from '../../model/bus';
import { db } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import type { LinkPhase } from '../../model/link';
import { useBusRev } from '../../model/rev';
import { TaskChip } from '../tasks/TaskChip';
import { ConvList, KIND_LABEL, lightUp } from './ConvList';
import { Timeline } from './Timeline';
import type { FullParams, ViewProps, WidgetDef } from '../types';

/* 列表没有内容时显示什么：加载中、连不上服务、确实没有会话 */
function emptyOf(phase: LinkPhase) {
  if (phase === 'loading')
    return (
      <div className="empty">
        <b>加载中…</b>
      </div>
    );
  if (phase === 'down')
    return (
      <div className="empty">
        <b>连不上洛璃服务</b>连上后会自动恢复
      </div>
    );
  return (
    <div className="empty">
      <b>还没有会话</b>群里有人发言后，会话会出现在这里
    </div>
  );
}
const EVENTS: BusEventName[] = [
  'message',
  'conv:add',
  'conv:remove',
  'conv:update',
  'unread',
  'reply:end',
  'reply:abort',
  'reply:error',
  'status',
  'data:reset',
  'link',
];

/* 普通：会话列表 */
function ListView({ handle }: { handle: ViewProps['handle'] }) {
  const rev = useBusRev(EVENTS);
  const phase = useLinkPhase();
  useEffect(
    () =>
      bus.on('message', ({ convId, row }) => {
        if (row && row.role === 'user') requestAnimationFrame(() => lightUp(convId));
      }),
    [],
  );
  /* 连不上服务时不显示旧的列表，免得当成现在的 */
  const convs = phase === 'ready' ? db.sorted() : [];
  return (
    <Pane>
      <ConvList
        convs={convs}
        onPick={(id) => handle.openFull('sessions', { convId: id })}
        rev={rev}
        label="会话列表"
        empty={emptyOf(phase)}
      />
    </Pane>
  );
}
/* 全屏：左边列表（宽 240–300px，标题「全部会话」加个数），右边选中会话的时间线；窄屏分两层。
   两栏各是一个窗格：窗口标题浮在两栏上面，各栏自己的头部浮在各自的内容上面 */
function FullView({ params }: { params: FullParams }) {
  const rev = useBusRev(EVENTS);
  const phase = useLinkPhase();
  const convs = phase === 'ready' ? db.sorted() : [];
  const [selected, setSelected] = useState<string | null>(() =>
    params?.convId && db.conv(params.convId) ? params.convId : (convs[0]?.id ?? null),
  );
  const [detail, setDetail] = useState(!!params?.convId);
  /* 选中一个会话只是打开它；算「看过」由时间线看有没有滚到最底下 */
  const select = (id: string | null) => {
    setSelected(id);
    if (id) setDetail(true);
  };
  /* 在「此刻」里点「在会话中打开」：全屏里同一个部件换参数 */
  useEffect(() => {
    if (params?.convId && db.conv(params.convId) && params.convId !== selected)
      select(params.convId);
  }, [params?.convId]);
  /* 没选过会话、数据后来才到：选第一个 */
  useEffect(() => {
    if (selected === null && convs.length) setSelected(convs[0].id);
  }, [selected, convs.length]);
  useEffect(
    () =>
      bus.on('conv:remove', ({ id }) => {
        if (id === selected) select(db.sorted()[0]?.id ?? null);
      }),
    [selected],
  );
  /* 整批换了数据（重新连上服务）：选中的会话还在就留着 */
  useEffect(
    () =>
      bus.on('data:reset', () => {
        setSelected((cur) => (cur && db.conv(cur) ? cur : (db.sorted()[0]?.id ?? null)));
      }),
    [],
  );
  useEffect(
    () =>
      bus.on('message', ({ convId, row }) => {
        if (convId !== selected && row && row.role === 'user')
          requestAnimationFrame(() => lightUp(convId));
      }),
    [selected],
  );
  const c = db.conv(selected);
  return (
    <div className={'sess' + (detail ? ' is-detail' : '')}>
      <Pane
        className="sess-side is-side"
        top={
          <div className="sess-side-head">
            <span>全部会话</span>
            <span>{phase === 'ready' ? `${convs.length} 个` : ''}</span>
          </div>
        }
      >
        <ConvList
          convs={convs}
          selectedId={selected}
          onPick={(id) => select(id)}
          rev={rev}
          label="会话列表"
          empty={emptyOf(phase)}
        />
      </Pane>
      <Pane
        className="sess-main is-main"
        top={
          <div className="sess-main-head">
            <button
              className="w-btn sess-back"
              type="button"
              title="返回列表"
              aria-label="返回列表"
              onClick={() => setDetail(false)}
            >
              ‹
            </button>
            <h3>{c ? c.title : '没有选中的会话'}</h3>
            {c && <span className="pchip">{KIND_LABEL[c.kind]}</span>}
            <span className="sess-meta">
              {c
                ? `${c.messages} 条消息 · ${c.segments} 段${c.platformConversationId ? ' · id ' + c.platformConversationId : ''}`
                : ''}
            </span>
            {c && <TaskChip convId={c.id} />}
          </div>
        }
      >
        <Timeline convId={selected} />
      </Pane>
    </div>
  );
}
function SessionsView({ mode, params, handle }: ViewProps) {
  return mode === 'full' ? <FullView params={params} /> : <ListView handle={handle} />;
}
export const SESSIONS_DEF: WidgetDef = {
  id: 'sessions',
  name: '会话',
  icon: IconSessions,
  defaultSize: '2x2',
  refreshOn: ['message', 'conv:add', 'conv:remove', 'conv:update', 'unread', 'data:reset', 'link'],
  init(w) {
    w.on('message', ({ row }) => {
      if (row && row.role === 'user') w.flash('stream');
    });
  },
  thumb() {
    const phase = link.get().phase;
    if (phase === 'down') return '连不上洛璃服务';
    if (phase === 'loading') return '加载中…';
    const n = db.conversations.filter((c) => c.unread > 0).length;
    return n ? (
      <>
        <em>{n}</em> 个会话有新消息
      </>
    ) : db.conversations.length ? (
      '没有新消息'
    ) : (
      '还没有会话'
    );
  },
  sub: () =>
    link.get().phase === 'ready' && db.conversations.length ? db.conversations.length + ' 个' : '',
  View: SessionsView,
};
