import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Button, Chevron, Fold, Row, Tag } from '@luoli/ui/controls';
import { fmtWhen } from '../../lib/zone';
import { getSource } from '../../model/source';
import {
  END_TEXT,
  checkBrief,
  checkSentence,
  descriptionText,
  dueSentence,
  endKind,
  scheduleLine,
  serverZone,
} from '../../model/tasks';
import type { TaskRow } from '../../model/types';

/* 任务的一行：做什么（完整显示，长了换行）、周期、谁让建的，右边是下次到点和「取消」。
   取消在这一行里确认（「取消此任务？」「确认」「返回」），不用 confirm()；确认后调接口，成功了这一行移到「已结束」，
   失败时在这一行里写原因。有鼠标时「取消」悬停才出现，触屏和窄屏一直显示（样式表）。
   已结束的行变暗，写明已完成、已超时或已取消和结束的时间，不能操作。
   监视任务（ADR-0014）没有下次到点：右边放检查的情况（「上次执行 21:38」「尚未执行」「执行失败」），旁边一个展开的小箭头（带 aria-expanded 的按钮），
   展开后在行下面整行宽：服务写成人话的几行、检查的情况、到点的次数、描述原文（默认收着）。已结束的监视任务也能展开，没有检查的情况。
   展开着的行，数据更新（每次检查之后服务会推）时不收起：展开的状态在这个组件里，组件按任务 id 一直在。
   任务部件和全屏会话头部的浮层用的是同一个。 */

/** 每隔一会儿重画一次：「今天、明天」过了零点要跟着变 */
export function useClockTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    const wake = () => document.visibilityState === 'visible' && setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [ms]);
  return now;
}

const ERR_MS = 6000;

export function TaskItem({
  task,
  now,
  where,
}: {
  task: TaskRow;
  now: number;
  /** 已结束的列表里没有会话分组，行里写它在哪个会话 */
  where?: string;
}) {
  const [ask, setAsk] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const alive = useRef(true);
  const errTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      alive.current = false;
      clearTimeout(errTimer.current);
    },
    [],
  );
  const tz = serverZone();
  const end = endKind(task);
  const next = task.nextDueAt ? Date.parse(task.nextDueAt) : 0;

  const cancel = async () => {
    setAsk('busy');
    setErr('');
    try {
      await getSource().cancelTask(task.id);
      // 成功：服务的新样子已经放进数据层，这一行换到「已结束」里，这个组件随之卸载
    } catch (e) {
      if (!alive.current) return;
      setAsk('idle');
      setErr(e instanceof Error ? e.message : '取消失败');
      clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => alive.current && setErr(''), ERR_MS);
    }
  };

  const meta = [scheduleLine(task, tz), `由 ${task.requestedBy.name} 创建`];
  if (where) meta.push(where);
  const mon = task.monitor;
  const brief = mon && !end ? checkBrief(mon, tz, now) : null;
  const toggle = mon ? (
    <Button
      size="sm"
      variant="ghost"
      className="task-toggle"
      aria-label={open ? '收起详情' : '展开详情'}
      aria-expanded={open}
      aria-controls={detailId}
      onClick={() => setOpen((v) => !v)}
    >
      <Chevron />
    </Button>
  ) : null;
  return (
    <Row
      wrap
      className={
        'task-row' +
        (end ? ' is-ended' : ' is-live') +
        (mon ? ' is-monitor' : '') +
        (ask !== 'idle' ? ' is-asking' : '')
      }
      data-id={task.id}
      title={task.action}
      sub={meta.join(' · ')}
      side={
        end ? (
          <>
            <span className="task-side-top">
              <span className="task-state">{END_TEXT[end]}</span>
              {toggle}
            </span>
            {task.endedAt && (
              <span className="task-at">{fmtWhen(Date.parse(task.endedAt), tz, now)}</span>
            )}
          </>
        ) : (
          <>
            <span className="task-side-top">
              {brief ? (
                brief.kind === 'failing' ? (
                  <Tag variant="soft" className="task-fail" title={brief.hint}>
                    {brief.text}
                  </Tag>
                ) : (
                  <span className="ll-row-meta" title={brief.hint}>
                    {brief.text}
                  </span>
                )
              ) : (
                <span className="task-next" title="下次触发">
                  {next ? fmtWhen(next, tz, now) : ''}
                </span>
              )}
              {toggle}
            </span>
            {ask === 'idle' && (
              <Button size="sm" className="task-cancel" onClick={() => setAsk('confirm')}>
                取消
              </Button>
            )}
          </>
        )
      }
    >
      {ask !== 'idle' && (
        <div className="task-ask ll-row-full" role="group" aria-label="取消此任务？">
          <span>取消此任务？</span>
          <Button
            size="sm"
            variant="danger"
            data-armed
            disabled={ask === 'busy'}
            onClick={() => void cancel()}
          >
            {ask === 'busy' ? '取消中…' : '确认'}
          </Button>
          <Button size="sm" disabled={ask === 'busy'} onClick={() => setAsk('idle')}>
            返回
          </Button>
        </div>
      )}
      {err && (
        <div className="task-err ll-row-full" role="status">
          取消失败：{err}
        </div>
      )}
      {mon && <MonitorDetail task={task} id={detailId} open={open} now={now} />}
    </Row>
  );
}

/* 监视任务展开后的内容：整行宽，高度平滑地长出来（样式表里 .task-detail，写法同库里折叠的高度过渡，关动画时直接到位）；
   收着的时候 inert：Tab 走不进去，读屏也不念 */
function MonitorDetail({
  task,
  id,
  open,
  now,
}: {
  task: TaskRow;
  id: string;
  open: boolean;
  now: number;
}) {
  const mon = task.monitor!;
  const tz = serverZone();
  const live = task.status === 'active';
  const due = live ? dueSentence(task, tz, now) : null;
  return (
    <div
      id={id}
      className="task-detail ll-row-full"
      data-open={open ? '' : undefined}
      inert={!open}
    >
      <div className="task-detail-in ll-inset" data-size="sm">
        <dl className="task-facts">
          {mon.facts.map((f) => (
            <Fragment key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.text}</dd>
            </Fragment>
          ))}
        </dl>
        {live && (
          <p className="task-check" data-kind={mon.failing ? 'failing' : undefined}>
            {checkSentence(mon, tz, now)}
          </p>
        )}
        {due && <p className="task-due">{due}</p>}
        <Fold
          className="task-desc"
          headClassName="task-desc-head"
          head={
            <>
              描述原文
              <Chevron />
            </>
          }
        >
          <pre className="task-json ll-scrollbar" tabIndex={0}>
            {descriptionText(mon)}
          </pre>
        </Fold>
      </div>
    </div>
  );
}
