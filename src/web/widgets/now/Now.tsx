import { useCallback, useEffect, useState } from 'react';
import { Badge, ToolName } from '../../components/Badge';
import { Pane } from '../../components/Pane';
import { IconNow } from '../../components/icons';
import { env } from '../../lib/env';
import { pulse } from '../../lib/fx-dom';
import { lastReplyText, recentReply, relTime } from '../../lib/util';
import { prefs } from '../../lib/prefs';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { nowModel } from '../../model/nowModel';
import type { Session } from '../../model/nowModel';
import { lastOnlineText, STATE_TEXT, status, useStatus } from '../../model/status';
import { useAssistantName } from '../../model/who';
import { nowCtl } from '../../state/actions';
import { pop } from '../../state/ui';
import { stardustAtEnd, stardustStart } from './stardust';
import { Terminal } from './Terminal';
import type { ViewProps, WidgetDef } from '../types';

/* 「此刻」的版面：窗口里上面一块（大徽记、状态名、一行说明）、下面是终端；全屏时最多 3 栏并排。
   上面那一块和窗口标题一起浮在终端上面（贴在标题栏下面）；终端是窗格，它顶上空出的高度（--pane-head）是标题栏加这一块，
   量出来写在 .now 上，全屏时几栏共用 */
function useNowSessions() {
  const [n, setN] = useState(0);
  useEffect(
    () =>
      nowModel.sub((type) => {
        if (type === 'sessions') setN((x) => x + 1);
      }),
    [],
  );
  useEffect(() => {
    const off = bus.on('data:reset', () => setN((x) => x + 1));
    return off;
  }, []);
  return n;
}
/* 终端的键：一个会话对象一个。会话被拿掉（空闲清理、缩回）后还在显示时对象没变，键也不变，终端不重建（滚动位置、贴底状态都在）；
   同一个会话再回复时接着用原来的对象（nowModel 的 retained），也不重建；换成别的对象才重建（从底部开始） */
const sessKeys = new WeakMap<Session, number>();
let sessKeyN = 0;
const sessKey = (s: Session) => {
  let k = sessKeys.get(s);
  if (k === undefined) sessKeys.set(s, (k = ++sessKeyN));
  return s.convId + '#' + k;
};
const sessionFor = (id: string | null) =>
  id
    ? nowModel.get(id) || (nowModel.last && nowModel.last.convId === id ? nowModel.last : null)
    : null;

/* 量浮着的那一块：它排在终端前面，ref 比终端里的 layout effect 先执行 */
function useNowTop() {
  return useCallback((el: HTMLDivElement | null) => {
    const now = el?.parentElement;
    if (!el || !now) return;
    const fit = () => {
      const v = `calc(var(--head-h) + ${el.offsetHeight}px)`;
      if (now.style.getPropertyValue('--pane-head') !== v) now.style.setProperty('--pane-head', v);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
}

function Empty() {
  const name = useAssistantName();
  return (
    <div className="now-empty pane-sc">
      <div>
        <div className="now-empty-t">{status.online ? '现在很安静' : `${name}离线了`}</div>
        {status.online
          ? `有人叫${name}时，这里会实时显示那个会话的对话`
          : '连上 Telegram 后，这里会实时显示进行中的对话'}
      </div>
    </div>
  );
}
function NowView({ mode, handle }: ViewProps) {
  const full = mode === 'full';
  const snap = useStatus();
  useNowSessions();
  const [sel, setSel] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const list = nowModel.list();
  const last = nowModel.last;
  let where: string;
  if (snap.state === 'offline') where = '连不上 Telegram · ' + lastOnlineText();
  else if (snap.count >= 2)
    where = snap.count + ' 个会话在回复：' + snap.list.map((x) => x.title).join('、');
  else if (snap.count === 1) where = snap.list[0].title;
  else if (status.lastReplyAt) {
    // 上次回复由服务告诉面板（启动时从数据库取，之后每次回复结束时更新）
    const title = db.conv(status.lastReplyConv)?.title;
    where = !title
      ? lastReplyText(status.lastReplyAt)
      : recentReply(status.lastReplyAt)
        ? `刚刚回复过 · ${title}`
        : `上次回复 · ${title} · ${relTime(status.lastReplyAt)}`;
  } else where = '没有进行中的对话';

  const pickSel = () => {
    if (!list.length) return last ? last.convId : null;
    if (sel && list.some((x) => x.convId === sel)) return sel;
    const act = list.filter((x) => x.active);
    return (act.length ? act[act.length - 1] : list[list.length - 1]).convId;
  };
  const curId = pickSel();
  const topRef = useNowTop();
  const badgeEl = (
    <span
      onPointerEnter={(e) => {
        if (env.hover) pop.show(e.currentTarget as HTMLElement);
      }}
      onPointerLeave={() => pop.hide()}
      style={{ display: 'inline-grid' }}
    >
      <Badge size={full ? 52 : 44} />
    </span>
  );
  let host: React.ReactNode;
  if (!full) {
    const s = sessionFor(curId);
    host = <Pane>{s ? <Terminal key={sessKey(s)} session={s} /> : <Empty />}</Pane>;
  } else {
    let cols: Session[] = list.slice(-3);
    if (!cols.length && last) cols = [last];
    host = (
      <div className="now-cols" style={{ '--n': Math.max(1, cols.length) }}>
        {!cols.length && (
          <Pane className="now-col">
            <Empty />
          </Pane>
        )}
        {cols.map((s) => {
          const x = status.conv.get(s.convId);
          return (
            <Pane
              className="now-col"
              key={sessKey(s)}
              top={
                <div className="now-col-head">
                  <span className="sdot" data-s={x ? x.state : 'idle'} />
                  <b>{s.title}</b>
                  <span className="st">
                    {x
                      ? x.state === 'tool'
                        ? '调用 ' + (x.tool || '工具')
                        : STATE_TEXT[x.state]
                      : s.active
                        ? ''
                        : '已回复'}
                  </span>
                  <button
                    className="now-open"
                    type="button"
                    onClick={() => handle.openFull('sessions', { convId: s.convId })}
                  >
                    在会话中打开
                  </button>
                </div>
              }
            >
              <Terminal session={s} />
            </Pane>
          );
        })}
      </div>
    );
  }
  return (
    <div className={'now' + (full ? ' is-full' : '')}>
      <div className="now-top" ref={topRef}>
        {badgeEl}
        <div className="now-meta">
          <div className="now-state">
            {snap.state === 'tool' ? '调用工具' : STATE_TEXT[snap.state]}
            <ToolName />
          </div>
          <div className="now-where">{where}</div>
        </div>
        {!full && list.length >= 2 && (
          <div className="now-tabs" role="tablist" aria-label="进行中的对话">
            {list.map((ss) => {
              const st = status.conv.get(ss.convId);
              return (
                <button
                  key={ss.convId}
                  className="now-tab"
                  role="tab"
                  type="button"
                  aria-selected={ss.convId === curId}
                  onClick={() => setSel(ss.convId)}
                >
                  <span className="sdot" data-s={st ? st.state : 'idle'} />
                  {ss.title}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {host}
    </div>
  );
}

export const NOW_DEF: WidgetDef = {
  id: 'now',
  name: '此刻',
  icon: IconNow,
  defaultSize: '2x2',
  sky: true,
  refreshOn: ['status'],
  init(w) {
    /* 有人触发洛璃（等待合并，或者不等待、直接开始的回复；任务到点也一样，Telegram 里它先有等待合并）：「此刻」自动展开成浮窗，
       受设置里的开关控制；网页会话里的回复不自动展开；刷新、重连时按现场补发的（replay）是已经在进行的回复，不展开 */
    const expand = ({ convId, replay }: { convId: string; replay?: boolean }) => {
      const c = db.conv(convId);
      if (!replay && prefs.get().autoNow && c && c.platform !== 'web') nowCtl.autoExpand();
    };
    w.on('reply:wait', expand);
    w.on('reply:start', expand);
    w.on('reply:start', ({ convId }) => stardustStart(convId));
    /* 回复正常完成时的星尘：最后一个字出现时从光标散开（逐字放完的那一刻，Typed.tsx 各处各自调 stardustAt）；这里只管没有光标可散的情况 */
    w.on('reply:end', ({ convId }) => stardustAtEnd(convId));
    w.on('reply:error', () => {
      w.flash('error');
      pulse(document.getElementById('top-status'));
    });
  },
  thumb() {
    const s = status.snapshot();
    const short = env.narrow;
    if (s.state === 'offline') return short ? '离线' : `离线 · ${lastOnlineText()}`;
    if (!s.count) {
      if (!status.lastReplyAt) return short ? '空闲' : '空闲 · 今天还没有新的回复';
      return short
        ? '空闲 · ' + (recentReply(status.lastReplyAt) ? '刚刚回复过' : relTime(status.lastReplyAt))
        : '空闲 · ' + lastReplyText(status.lastReplyAt);
    }
    const name = s.state === 'tool' ? '调用 ' + (s.tool || '工具') : STATE_TEXT[s.state];
    return (
      <>
        <em>{name}</em> · {s.count >= 2 ? s.count + ' 个会话' : s.list[0].title}
      </>
    );
  },
  View: NowView,
};
