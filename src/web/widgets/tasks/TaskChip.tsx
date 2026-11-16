import { useEffect, useState } from 'react';
import { Popover, PopoverButton, PopoverContent } from '@luoli/ui/overlay';
import { useLinkPhase } from '../../model/link';
import { useBusRev } from '../../model/rev';
import { activeTasks, tasksReady } from '../../model/tasks';
import { TaskItem, useClockTick } from './TaskItem';

/* 全屏会话的头部：这个会话进行中的任务数（「2 个任务」，没有就不显示），点开是一个小浮层，列出这些任务，样子和任务部件里的行一样，
   也能取消（在行里确认）。用库的下拉钮和弹出框（@luoli/ui/overlay 的 PopoverButton、PopoverContent）：钮自己的底长成浮层的底，然后任务行才出来（长开）；
   点外面、按 Esc 关（Esc 只关浮层，不连带退出全屏，库的弹出框自己管着焦点），悬停高亮一块滑动（glide）也是库的。
   浮层用 container 留在这个窗口的卡片里：窗口形变、整理时跟着卡片走；宽度、内边距、行的圆角写在样式表的 .task-pop 里 */
export function TaskChip({ convId }: { convId: string }) {
  useBusRev(['tasks:update', 'data:reset', 'link']);
  const phase = useLinkPhase();
  const now = useClockTick();
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<HTMLElement | null>(null);
  // 取任务失败（版本旧、没取到）时不显示任务数
  const list = phase === 'ready' && tasksReady() ? activeTasks(convId) : [];
  const shown = open && list.length > 0;
  useEffect(() => setOpen(false), [convId]);
  if (!list.length) return null;
  return (
    <span className="task-chip">
      <Popover open={shown} onOpenChange={setOpen}>
        <PopoverButton
          size="xs"
          ref={(el: HTMLButtonElement | null) => {
            const c = el ? el.closest<HTMLElement>('.w-card') : null;
            setCard((p) => (p === c ? p : c));
          }}
          title="这个会话进行中的任务"
        >
          {list.length} 个任务
        </PopoverButton>
        <PopoverContent
          container={card}
          glide=".task-row.is-live"
          align="end"
          className="task-pop"
          aria-label="这个会话的任务"
        >
          {list.map((t) => (
            <TaskItem key={t.id} task={t} now={now} />
          ))}
        </PopoverContent>
      </Popover>
    </span>
  );
}
