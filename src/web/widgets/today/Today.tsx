import { useEffect, useState } from 'react';
import { Energy, Roll } from '../../components/Roll';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import { IconToday } from '../../components/icons';
import { Pane } from '../../components/Pane';
import type { TodaySummary } from '../../model/types';
import type { ViewProps, WidgetDef } from '../types';

/* 今日概况：数字来自服务算好的汇总（今天按服务器的时区，从当天 0 点算起；回复数只算回复，token 是回复加摘要）。
   打开时取一次（启动时已经在 db 里），之后服务推「今日概况变了」就换新的；服务器的日期变了（过了 0 点）由数据源重新取。 */
const zero = (): TodaySummary => ({
  date: '',
  timeZone: '',
  since: '',
  replies: 0,
  failedReplies: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  conversations: [],
});

function Notice({ phase }: { phase: 'loading' | 'down' }) {
  return (
    <Pane>
      <div className="today pane-sc">
        <div className="empty">
          {phase === 'down' ? (
            <>
              <b>连不上洛璃服务</b>连上后会自动恢复
            </>
          ) : (
            <b>加载中…</b>
          )}
        </div>
      </div>
    </Pane>
  );
}

function TodayView({ mode, handle }: ViewProps) {
  const full = mode === 'full';
  const phase = useLinkPhase();
  const [t, setT] = useState<TodaySummary>(zero);
  /* 打开 80 ms 后放进数字，数字从 0 滚上来；之后每次服务推来新的汇总就换。
     这个部件自己正在形变（从胶囊展开、打开全屏）时，形变期间看到的是挂上那一刻的画面，数字要等形变结束再放，用户才看得到从 0 滚完的整段；
     等的时候服务推来新的汇总不用记：放进去的那一刻读的就是最新的（db.today） */
  useEffect(() => {
    let landed = false;
    let offMorph: (() => void) | undefined;
    const take = () => {
      if (db.today) setT(db.today);
    };
    const timer = setTimeout(() => {
      offMorph = handle.afterMorph(() => {
        landed = true;
        take();
      });
    }, 80);
    const off = bus.on('today:update', () => landed && take());
    return () => {
      clearTimeout(timer);
      offMorph?.();
      off();
    };
  }, []);
  if (phase === 'down') return <Notice phase="down" />;
  if (!db.today && phase === 'loading') return <Notice phase="loading" />;
  const s = {
    replies: t.replies,
    failed: t.failedReplies,
    input: t.inputTokens,
    cache: t.cacheReadTokens,
    output: t.outputTokens,
  };
  const hit = s.input ? s.cache / s.input : 0;
  const failRate = s.replies + s.failed ? s.failed / (s.replies + s.failed) : 0;
  if (!full) {
    return (
      <Pane>
        <div className="today pane-sc">
          <div className="today-hero">
            <Roll value={s.replies} />
            <span>次回复</span>
          </div>
          <div className="stat-row">
            <span>token</span>
            <span>
              输入{' '}
              <b>
                <Roll value={s.input} />
              </b>{' '}
              · 输出{' '}
              <b>
                <Roll value={s.output} />
              </b>
            </span>
          </div>
          <div className="stat">
            <div className="stat-row">
              <span>缓存命中率</span>
              <b>
                <Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />
              </b>
            </div>
            <Energy value={hit} label="缓存命中率" />
          </div>
          <div className="stat">
            <div className="stat-row">
              <span>失败</span>
              <span>
                <b>
                  <Roll value={s.failed} />
                </b>{' '}
                次
              </span>
            </div>
            <Energy value={failRate} bad label="失败率" />
          </div>
        </div>
      </Pane>
    );
  }
  const rows = [...t.conversations].sort((a, b) => b.replies - a.replies).slice(0, 12);
  const max = rows.length ? rows[0].replies : 1;
  return (
    <Pane>
      <div className="today is-full pane-sc">
        <div className="today-grid">
          <div className="tile">
            <small>今天的回复</small>
            <Roll value={s.replies} />
          </div>
          <div className="tile">
            <small>输入 token</small>
            <Roll value={s.input} />
          </div>
          <div className="tile">
            <small>输出 token</small>
            <Roll value={s.output} />
          </div>
          <div className="tile">
            <small>缓存命中率</small>
            <Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />
            <Energy value={hit} label="缓存命中率" />
          </div>
          <div className="tile">
            <small>失败</small>
            <Roll value={s.failed} />
            <Energy value={failRate} bad label="失败率" />
          </div>
        </div>
        <div className="stat">
          <div className="stat-row">
            <b>各会话今天的回复</b>
          </div>
          <div className="per-conv">
            {!rows.length && <div className="empty is-flat">今天还没有回复</div>}
            {rows.map((c) => {
              const title = c.title || db.conv(c.id)?.title || '会话';
              return (
                <div className="per-row" key={c.id}>
                  <span>{title}</span>
                  <Energy value={c.replies / max} label={title} />
                  <span>
                    <Roll value={c.replies} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Pane>
  );
}
export const TODAY_DEF: WidgetDef = {
  id: 'today',
  name: '今日概况',
  icon: IconToday,
  defaultSize: '1x1',
  refreshOn: ['today:update', 'data:reset', 'link'],
  thumb: () =>
    link.get().phase === 'down' ? (
      '连不上洛璃服务'
    ) : (
      <>
        今天 <em>{db.today?.replies ?? 0}</em> 次回复
      </>
    ),
  View: TodayView,
};
