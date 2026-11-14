import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconSessions } from '../../components/icons';
import { BakedGlass } from '../../components/Bubble';
import { Pane } from '@luoli/ui/scroll';
import { Button, Empty, IconButton, Tag } from '@luoli/ui/controls';
import { DUR_LAYER, EASE_OUT_CSS, LAYER_SHIFT } from '@luoli/ui/easing';
import { IconChevronLeft } from '@luoli/ui/icons';
import { SLOW } from '../../lib/debug';
import { useNarrow } from '@luoli/ui/env';
import { glassMode } from '../../lib/glass';
import { motionOn } from '@luoli/ui/motion';
import { useStore } from '@luoli/ui/store';
import { bus } from '../../model/bus';
import type { BusEventName } from '../../model/bus';
import { db } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import type { LinkPhase } from '../../model/link';
import { useBusRev } from '../../model/rev';
import { TaskChip } from '../tasks/TaskChip';
import { ConvList, KIND_LABEL, lightUp } from './ConvList';
import { backToList, dropGone, pickConv, sessState } from './sessionsState';
import { Timeline } from './Timeline';
import type { FullParams, ViewProps, WidgetDef } from '../types';

/* 列表没有内容时显示什么：加载中、连不上服务、确实没有会话 */
function emptyOf(phase: LinkPhase) {
  if (phase === 'loading') return <Empty title="加载中…" />;
  if (phase === 'down') return <Empty title="连不上洛璃服务">连上后会自动恢复</Empty>;
  return <Empty title="还没有会话">群里有人发言后，会话会出现在这里</Empty>;
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

/* 普通：窗口里分两层，列表和选中会话的时间线（不分栏，所有大小的窗口都一样）。
   - 点一行：在窗口里打开这个会话的时间线；头部浮在内容上面，左边「‹ 返回」，然后是标题、平台标记、这个会话的任务数。
   - 两层都铺满窗口，切换时进来的从一边滑到位加淡入、出去的滑向另一边加淡出（关掉动画时直接切）；
     列表那层一直挂着、只是隐藏（visibility），返回时滚动位置原样还在；时间线那层返回后才卸载（卸载以后不会在后台把消息标成已读）。
   - 选中的会话和停在哪一层存在 sessionsState.ts 里：放大到全屏时全屏选中它，从全屏退回来、缩成胶囊再展开都停在原处。
   - 窄屏（小于 720px）不分层：点一行进全屏。Esc 不绑定（对话部件的 Esc 是中止回复） */
function WindowView({ handle }: { handle: ViewProps['handle'] }) {
  const rev = useBusRev(EVENTS);
  const phase = useLinkPhase();
  const narrow = useNarrow();
  const st = useStore(sessState, (s) => s);
  const cur = st.cur && db.conv(st.cur) ? st.cur : null;
  const open = !narrow && st.detail && !!cur;
  /* 时间线那层挂着没有、挂的是哪个会话：返回后要等退场的动画放完才卸载，期间会话 id 不能跟着变没 */
  const [layer, setLayer] = useState<{ tl: boolean; conv: string | null }>({
    tl: open,
    conv: open ? cur : null,
  });
  if (open && (!layer.tl || layer.conv !== cur)) setLayer({ tl: true, conv: cur });
  const listEl = useRef<HTMLDivElement>(null);
  const detEl = useRef<HTMLDivElement>(null);
  const prevOpen = useRef(open);
  const anims = useRef<Animation[]>([]);
  /* 两层切换的动画放着时为真：时间线里的气泡暂时按「预先糊好」画（见 components/Bubble.tsx 的 BakedGlass）。
     只有实时模糊才用得上（那时整层在淡入淡出，气泡拿不到窗口的星空；预先糊好的气泡本来就没有这个问题），其余情形不动它，免得白白多渲染一次。
     open 变了的那一次渲染里就置上（不等动画开始的 layout effect 里再置）：刚挂上的时间线一开始就按预先糊好的画，不先挂一遍实时模糊的再整个换掉，
     少一次整层气泡的重渲染（第一次点开会话那一下的长任务因此比先挂后换短一些） */
  const [fading, setFading] = useState(false);
  const [fadeOpen, setFadeOpen] = useState(open);
  if (fadeOpen !== open) {
    setFadeOpen(open);
    setFading(motionOn() && glassMode() === 'live');
  }
  const fadeTok = useRef(0);
  useLayoutEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    for (const a of anims.current) a.cancel();
    anims.current = [];
    const tok = ++fadeTok.current;
    const l = listEl.current;
    const d = detEl.current;
    if (!l || !d || !motionOn()) {
      setFading(false);
      if (!open) setLayer({ tl: false, conv: null });
      return;
    }
    /* 样式表里这一刻两层已经是切换后的样子（一层 is-off），动画只是从切换前的样子过渡过来；visibility 写成一直可见，退场的那层才画得出来 */
    const run = (el: HTMLElement, x0: number, x1: number, o0: number, o1: number) => {
      const a = el.animate(
        {
          opacity: [o0, o1],
          transform: [`translateX(${x0}px)`, `translateX(${x1}px)`],
          visibility: ['visible', 'visible'],
        },
        { duration: DUR_LAYER * SLOW, easing: EASE_OUT_CSS },
      );
      anims.current.push(a);
      return a;
    };
    if (open) {
      run(l, 0, -LAYER_SHIFT, 1, 0);
      run(d, LAYER_SHIFT, 0, 0, 1);
    } else {
      run(l, -LAYER_SHIFT, 0, 0, 1);
      run(d, 0, LAYER_SHIFT, 1, 0).onfinish = () => setLayer({ tl: false, conv: null });
    }
    // 放完（或者被取消）就换回去；中途又开始了新的切换（fadeTok 变了）由新的那次管
    void Promise.allSettled(anims.current.map((a) => a.finished)).then(() => {
      if (fadeTok.current === tok) setFading(false);
    });
  }, [open]);
  /* 离开时取消没放完的动画 */
  useEffect(
    () => () => {
      for (const a of anims.current) a.cancel();
    },
    [],
  );
  /* 列表上有新用户消息的那一行亮一下：窗口停在列表时（cur 只是上次开过的）每个会话都亮，开着某个会话的时间线时那个会话不亮 */
  useEffect(
    () =>
      bus.on('message', ({ convId, row }) => {
        if ((!open || convId !== cur) && row && row.role === 'user')
          requestAnimationFrame(() => lightUp(convId));
      }),
    [open, cur],
  );
  /* 连不上服务时不显示旧的列表，免得当成现在的 */
  const convs = phase === 'ready' ? db.sorted() : [];
  const c = db.conv(layer.conv);
  return (
    <div className="sess-win">
      <div className={'sess-layer' + (open ? ' is-off' : '')} ref={listEl} inert={open}>
        <Pane>
          <ConvList
            convs={convs}
            onPick={(id) => (narrow ? handle.openFull('sessions', { convId: id }) : pickConv(id))}
            rev={rev}
            label="会话列表"
            empty={emptyOf(phase)}
          />
        </Pane>
      </div>
      {layer.tl && c && (
        <div className={'sess-layer' + (open ? '' : ' is-off')} ref={detEl} inert={!open}>
          <Pane
            className="sess-main"
            top={
              <div className="sess-main-head sess-win-head">
                <Button
                  variant="ghost"
                  className="sess-back"
                  title="返回列表"
                  aria-label="返回列表"
                  onClick={backToList}
                >
                  <IconChevronLeft />
                  返回
                </Button>
                <h3>{c.title}</h3>
                <Tag>{KIND_LABEL[c.kind]}</Tag>
                <TaskChip convId={c.id} />
              </div>
            }
          >
            <BakedGlass.Provider value={fading}>
              <Timeline convId={c.id} />
            </BakedGlass.Provider>
          </Pane>
        </div>
      )}
    </div>
  );
}
/* 全屏：左边列表（宽 240–300px，标题「全部会话」加个数），右边选中会话的时间线；窄屏分两层。
   两栏各是一个窗格：窗口标题浮在两栏上面，各栏自己的头部浮在各自的内容上面 */
function FullView({ params }: { params: FullParams }) {
  const rev = useBusRev(EVENTS);
  const phase = useLinkPhase();
  const convs = phase === 'ready' ? db.sorted() : [];
  const st = useStore(sessState, (s) => s);
  /* 窄屏的两层（列表、详情）：从会话列表点一行、「此刻」里「在会话中打开」带着会话进来时直接看详情，其余看列表 */
  const [detail, setDetail] = useState(!!params?.convId);
  /* 从「此刻」点「在会话中打开」带来的会话：这一帧先照它显示，layout effect 里再写进共用的状态，之后以共用的状态为准 */
  const asked = params?.convId && db.conv(params.convId) ? params.convId : null;
  const applied = useRef<string | null>(null);
  const fromParams = asked && applied.current !== asked ? asked : null;
  /* 选中哪个：共用状态里的（窗口里开着、上次选过的），不在了或没选过就第一个 */
  const selected = fromParams ?? (db.conv(st.cur) ? st.cur : (convs[0]?.id ?? null));
  useLayoutEffect(() => {
    if (fromParams) {
      applied.current = fromParams;
      pickConv(fromParams);
      setDetail(true);
    } else if (selected && st.cur !== selected) {
      /* 自动选的第一个也记下来，免得之后第一个换了、选中的跟着跳；不算「选过」，不改窗口停在哪一层 */
      sessState.set({ cur: selected });
    }
  }, [fromParams, selected, st.cur]);
  /* 选中一个会话只是打开它；算「看过」由时间线看有没有滚到最底下 */
  const select = (id: string) => {
    pickConv(id);
    setDetail(true);
  };
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
            <IconButton
              className="sess-back"
              title="返回列表"
              aria-label="返回列表"
              onClick={() => {
                setDetail(false);
                backToList();
              }}
            >
              <IconChevronLeft />
            </IconButton>
            <h3>{c ? c.title : '没有选中的会话'}</h3>
            {c && <Tag>{KIND_LABEL[c.kind]}</Tag>}
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
  return mode === 'full' ? <FullView params={params} /> : <WindowView handle={handle} />;
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
    /* 选中的会话被删、整批换了数据以后找不到：窗口回到列表（部件没挂在页面上时也要管） */
    w.on('conv:remove', dropGone);
    w.on('data:reset', dropGone);
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
