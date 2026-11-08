import { useEffect, useState } from 'react';
import { IconSessions } from '../../components/icons';
import { bus } from '../../model/bus';
import type { BusEventName } from '../../model/bus';
import { db } from '../../model/db';
import { getSource } from '../../model/source';
import { useBusRev } from '../../model/rev';
import { ConvList, KIND_LABEL, lightUp } from './ConvList';
import { Timeline } from './Timeline';
import type { FullParams, ViewProps, WidgetDef } from '../types';

const EMPTY = (
  <div className="empty">
    <b>还没有会话</b>群里有人发言后，会话会出现在这里
  </div>
);
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
];

/* 普通：会话列表 */
function ListView({ handle }: { handle: ViewProps['handle'] }) {
  const rev = useBusRev(EVENTS);
  useEffect(
    () =>
      bus.on('message', ({ convId, row }) => {
        if (row && row.role === 'user') requestAnimationFrame(() => lightUp(convId));
      }),
    [],
  );
  const convs = db.sorted();
  return (
    <ConvList
      convs={convs}
      onPick={(id) => handle.openFull('sessions', { convId: id })}
      rev={rev}
      label="会话列表"
      empty={EMPTY}
    />
  );
}
/* 全屏：左边列表（宽 240–300px，标题「全部会话」加个数），右边选中会话的时间线；窄屏分两层 */
function FullView({ params }: { params: FullParams }) {
  const rev = useBusRev(EVENTS);
  const convs = db.sorted();
  const [selected, setSelected] = useState<string | null>(() =>
    params?.convId && db.conv(params.convId) ? params.convId : (convs[0]?.id ?? null),
  );
  const [detail, setDetail] = useState(!!params?.convId);
  const select = (id: string | null) => {
    setSelected(id);
    if (id) getSource().markRead(id);
    if (id) setDetail(true);
  };
  useEffect(() => {
    if (selected) getSource().markRead(selected);
  }, [selected]);
  /* 在「此刻」里点「在会话中打开」：全屏里同一个部件换参数 */
  useEffect(() => {
    if (params?.convId && db.conv(params.convId) && params.convId !== selected)
      select(params.convId);
  }, [params?.convId]);
  useEffect(
    () =>
      bus.on('conv:remove', ({ id }) => {
        if (id === selected) select(db.sorted()[0]?.id ?? null);
      }),
    [selected],
  );
  useEffect(
    () =>
      bus.on('data:reset', () => {
        setDetail(false);
        setSelected(db.sorted()[0]?.id ?? null);
      }),
    [],
  );
  useEffect(
    () =>
      bus.on('message', ({ convId, row }) => {
        if (convId === selected) {
          db.unread.delete(convId);
        } else if (row && row.role === 'user') requestAnimationFrame(() => lightUp(convId));
      }),
    [selected],
  );
  const c = db.conv(selected);
  return (
    <div className={'sess' + (detail ? ' is-detail' : '')}>
      <aside className="sess-side">
        <div className="sess-side-head">
          <span>全部会话</span>
          <span>{convs.length} 个</span>
        </div>
        <ConvList
          convs={convs}
          selectedId={selected}
          onPick={(id) => select(id)}
          rev={rev}
          label="会话列表"
          empty={EMPTY}
        />
      </aside>
      <section className="sess-main">
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
              ? `${db.msgs(c.id).length} 条消息 · ${db.segs(c.id).length} 段${c.platform_conversation_id ? ' · id ' + c.platform_conversation_id : ''}`
              : ''}
          </span>
        </div>
        <Timeline convId={selected} />
      </section>
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
  refreshOn: ['message', 'conv:add', 'conv:remove', 'unread', 'data:reset'],
  init(w) {
    w.on('message', ({ row }) => {
      if (row && row.role === 'user') w.flash('stream');
    });
  },
  thumb() {
    const n = db.conversations.filter((c) => db.unread.get(c.id)).length;
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
  sub: () => (db.conversations.length ? db.conversations.length + ' 个' : ''),
  View: SessionsView,
};
