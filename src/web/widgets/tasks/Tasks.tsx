import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useGlide } from '@luoli/ui/scroll';
import { IconTasks } from '../../components/icons';
import { Pane } from '@luoli/ui/scroll';
import { Button, Chevron, Empty, Fold, Tag } from '@luoli/ui/controls';
import { DUR_VANISH, EASE_OUT } from '@luoli/ui/easing';
import { useMotionOn } from '@luoli/ui/motion';
import { db, defaultTitle } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import { useBusRev } from '../../model/rev';
import { refreshTasks } from '../../model/sync';
import {
  activeTasks,
  endedTasks,
  groupTasks,
  tasksProblem,
  tasksReady,
  tasksThumb,
} from '../../model/tasks';
import type { TaskRow } from '../../model/types';
import { useAssistantName } from '../../model/who';
import { KIND_LABEL } from '../sessions/ConvList';
import { TaskItem, useClockTick } from './TaskItem';
import type { ViewProps, WidgetDef } from '../types';

/* 任务部件：进行中的任务按会话分组（组按最近的下次到点排，组内也是），每一行能取消；
   下面收着「已结束（N）」，默认折叠，展开后是最近 30 天里完成和取消的任务。
   数据来自服务（GET /api/tasks，SSE 的 task 事件整行替换），连不上服务时显示提示，重连后自动恢复。
   行的悬停高亮和会话列表是同一块（@luoli/ui/scroll 的 useGlide）；列表元素一直在，连不上、加载中也是它里面的提示（高亮挂在它上面） */
const EVENTS = [
  'tasks:update',
  'data:reset',
  'link',
  'conv:update',
  'conv:add',
  'today:update',
] as const;

/** 会话的名字：列表里现在的标题（网页会话改了标题跟着变），没有就用任务带的，再没有写平台 */
export function convTitleOf(c: TaskRow['conversation']): string {
  return db.conv(c.id)?.title || c.title || KIND_LABEL[c.kind] || defaultTitle(c.kind);
}

/* 行、组进出场：高度从 0 长出来、淡入（和会话列表一样，420 ms）；收起时高度收到 0、淡出（320 ms）；动画关掉时只淡出。
   整批到的（第一次连上、重连后，db.taskBulk）直接出现，只有之后新来的才放进场动画。key：任务 id 或会话 id */
function useCollapse() {
  const motionOn = useMotionOn();
  return (key?: number | string) =>
    ({
      initial:
        motionOn && !(key !== undefined && db.taskBulk.has(key))
          ? { height: 0, opacity: 0 }
          : false,
      animate: { height: 'auto', opacity: 1 },
      exit: motionOn
        ? {
            height: 0,
            opacity: 0,
            transition: { duration: DUR_VANISH / 1000, ease: 'easeIn' as const },
          }
        : { opacity: 0, transition: { duration: 0 } },
      transition: { duration: 0.42, ease: EASE_OUT },
    }) as const;
}

function Ended({
  list,
  now,
  open,
  setOpen,
}: {
  list: TaskRow[];
  now: number;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  if (!list.length) return null;
  return (
    <Fold
      className="task-ended"
      headClassName="task-more"
      open={open}
      onOpenChange={setOpen}
      head={
        <>
          {`已结束（${list.length}）`}
          <Chevron />
        </>
      }
    >
      <div className="task-wrap" role="list" aria-label="已结束的任务">
        {list.map((t) => (
          <div role="listitem" key={t.id}>
            <TaskItem task={t} now={now} where={convTitleOf(t.conversation)} />
          </div>
        ))}
      </div>
    </Fold>
  );
}

function TasksView({ mode }: ViewProps) {
  const full = mode === 'full';
  const phase = useLinkPhase();
  useBusRev([...EVENTS]);
  const now = useClockTick();
  const name = useAssistantName();
  const g = useGlide('.task-row.is-live');
  const c = useCollapse();
  // 「已结束」展开着：连不上服务又恢复时列表换了提示再换回来，展开的状态留着
  const [endedOpen, setEndedOpen] = useState(false);
  // 取任务失败只影响这个部件（写原因），和连接状态分开
  const ready = phase === 'ready' && tasksReady();
  const problem = phase === 'ready' ? tasksProblem() : null;
  const active = ready ? activeTasks() : [];
  const ended = ready ? endedTasks(now) : [];
  const groups = groupTasks(active);
  let notice: React.ReactNode = null;
  if (phase === 'loading' || (phase === 'ready' && !ready && !problem))
    notice = <Empty title="加载中…" />;
  else if (phase === 'down') notice = <Empty title="连不上洛璃服务">连上后会自动恢复</Empty>;
  else if (problem)
    notice = (
      <Empty
        title={problem.title}
        action={
          <Button size="sm" onClick={() => void refreshTasks()}>
            重试
          </Button>
        }
      >
        {problem.detail && <div>{problem.detail}</div>}
      </Empty>
    );
  else if (!active.length)
    notice = ended.length ? (
      <Empty flat>没有进行中的任务</Empty>
    ) : (
      <Empty title="还没有任务">
        在对话里跟{name}说「明早 9 点提醒我交周报」，任务就会出现在这里。
      </Empty>
    );
  return (
    <Pane>
      <div
        className={'tasks ll-pane-sc' + (full ? ' is-full' : '')}
        ref={(el) => {
          g.list.current = el;
        }}
      >
        <i className="ll-glide" ref={(el) => void (g.glide.current = el)} aria-hidden="true" />
        <AnimatePresence initial={false}>
          {groups.map((grp) => (
            <motion.section
              key={grp.conv.id}
              className="task-group"
              role="group"
              aria-label={convTitleOf(grp.conv)}
              {...c(grp.conv.id)}
            >
              <div className="task-gh">
                <span className="task-gt">{convTitleOf(grp.conv)}</span>
                <Tag>{KIND_LABEL[grp.conv.kind]}</Tag>
              </div>
              <div role="list">
                <AnimatePresence initial={false}>
                  {grp.tasks.map((t) => (
                    <motion.div key={t.id} className="task-wrap" role="listitem" {...c(t.id)}>
                      <TaskItem task={t} now={now} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </motion.section>
          ))}
        </AnimatePresence>
        {notice}
        {ready && <Ended list={ended} now={now} open={endedOpen} setOpen={setEndedOpen} />}
      </div>
    </Pane>
  );
}

export const TASKS_DEF: WidgetDef = {
  id: 'tasks',
  name: '任务',
  icon: IconTasks,
  defaultSize: '1x2',
  refreshOn: ['tasks:update', 'data:reset', 'link', 'today:update'],
  thumb() {
    const phase = link.get().phase;
    if (phase === 'down') return '连不上洛璃服务';
    if (phase === 'loading' || !(tasksReady() || tasksProblem())) return '加载中…';
    return tasksThumb();
  },
  sub() {
    if (link.get().phase !== 'ready' || !tasksReady()) return '';
    const n = activeTasks().length;
    return n ? `${n} 个` : '';
  },
  View: TasksView,
};
