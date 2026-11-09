import {
  type Conversation,
  type EventInput,
  type Logger,
  type Message,
  type Storage,
  type Task,
  type Trigger,
} from '../../core/index.js';
import {
  describeSchedule,
  formatDue,
  formatShort,
  nextDue,
  scheduleFrom,
  type ScheduleInput,
} from './schedule.js';

/** 晚了不超过这么久算到点，再晚算错过（服务停着、电脑睡着的那段时间） */
export const lateLimitMs = 5 * 60_000;
/** 定时器一次最多等这么久，到时候重新看一眼：电脑睡眠、系统改时间之后也能及时发现到点了 */
export const maxWaitMs = 60_000;
/** 每个会话最多几个进行中的任务 */
export const maxActiveTasks = 20;
/** 「做什么」最多几个字 */
export const maxActionChars = 200;
/** 周期任务错过的次数最多数到这么多（服务停了很久时不一直数下去） */
const maxMissedCount = 10_000;

/** 定时器用的时钟；测试里换成假的 */
export type Clock = {
  now(): Date;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemClock: Clock = {
  now: () => new Date(),
  // 不拖住进程退出
  setTimeout: (run, ms) => setTimeout(run, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 到点的一个任务：前端据此在「此刻」标出 */
export type DueTask = { id: number; action: string };

/**
 * 交给前端的一次到点：这个会话有任务到点了，事件已经写进去，前端当作一次触发。同一个会话同时到点的
 * 几个任务合在一次里（各写各的事件，前端照合并的规矩只回复一次）
 */
export type TaskDue = {
  conversationId: string;
  /** 按先后 */
  tasks: DueTask[];
  /** 这次写进去的第一条事件的序号；读不到时没有 */
  fromSeq?: number;
};

/** 前端的到点入口：按会话所在的平台登记。出错只记日志 */
export type TaskEntrance = (due: TaskDue) => void | Promise<void>;

/** 建任务的参数：工具给的，加上会话与触发者 */
export type CreateTaskInput = ScheduleInput & {
  conversationId: string | undefined;
  triggers: readonly Trigger[];
  action: string;
  /** 几个人一起触发时，写明是谁让建的：uid，没有 uid 时写名字 */
  requestedBy?: string;
};

type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });

/**
 * 任务服务（ADR-0010）：任务工具与面板经它建、列出、取消任务；定时器在这里。
 * - 定时器盯着最近的「下次到点」，等待封顶 maxWaitMs；任务增删时重排。到点时晚了不超过 lateMs 的
 *   算到点：写一条 task 事件，交给会话所在平台的前端（setEntrance 登记）当作一次触发；再晚的算错过：
 *   写一条 task-missed 事件，不触发，周期任务错过几次也只写一条，然后从现在起算下一次。
 * - 建任务、取消、到点的处理排成一串（一次只做一件），免得同时改同一个任务、超过限额。
 * - 存储用包过一层的那份：任务的写入经它推给面板。
 * 日志只记任务 id、会话 id、晚了多久，不记「做什么」
 */
export function createTaskService({
  storage,
  open,
  logger,
  clock = systemClock,
  lateMs = lateLimitMs,
  waitMs = maxWaitMs,
  maxActive = maxActiveTasks,
}: {
  storage: Storage;
  /** 打开会话（会话管理的 open），写事件用 */
  open: (conversationId: string) => Promise<Pick<Conversation, 'append'>>;
  logger: Logger;
  clock?: Clock;
  lateMs?: number;
  waitMs?: number;
  maxActive?: number;
}) {
  const entrances = new Map<string, TaskEntrance>();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: unknown;
  let started = false;
  let stopped = false;
  // 每个任务已经处理过的那一次到点（处理时的下次到点）：同一次不处理第二遍。更新任务失败时它还停在
  // 过去的下次到点，靠这个不再写事件、不再交给前端（不重试）。更新成功、下次到点变了就去掉
  const handled = new Map<number, string>();
  // 这一次看一眼时有任务出错、或者跳过了处理过的到点：下一次按 waitMs 等，不因为下次到点在过去
  // 就马上再看（否则会原地空转）
  let backOff = false;

  /** 排在前面的都做完再做；出错不影响后面的 */
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = chain.then(run);
    chain = result.catch(() => {});
    return result;
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  }

  /** 重排定时器：等到最近的下次到点（最多 waitMs）。没有要到点的任务时不等 */
  function rearm(): void {
    if (!started || stopped) return;
    void exclusive(async () => {
      if (!started || stopped) return;
      clearTimer();
      let wait: number | undefined;
      try {
        const next = await storage.nextDueAt();
        if (next !== undefined) {
          wait = backOff
            ? waitMs
            : Math.min(Math.max(0, Date.parse(next) - clock.now().getTime()), waitMs);
        }
      } catch (error) {
        logger.error({ error: describeError(error) }, 'task.timer_failed');
        wait = waitMs;
      }
      backOff = false;
      if (wait !== undefined) timer = clock.setTimeout(fire, wait);
    });
  }

  function fire(): void {
    timer = undefined;
    void exclusive(tick);
    rearm();
  }

  /** 写一条事件；返回它的序号（读不到时 undefined）。失败只记日志，返回 false */
  async function writeEvent(
    task: Task,
    input: EventInput,
  ): Promise<{ seq: number | undefined } | false> {
    try {
      const message: Message = await (await open(task.conversationId)).append(input);
      const entry = await (await storage.openConversation(task.conversationId)).entry(message.id);
      return { seq: entry?.seq };
    } catch (error) {
      logger.error(
        {
          taskId: task.id,
          conversationId: task.conversationId,
          type: input.event.type,
          error: describeError(error),
        },
        'task.event_failed',
      );
      return false;
    }
  }

  /**
   * 错过了：写一条 task-missed 事件（不触发）。一次性的改为已完成；周期的数一数错过了几次，
   * 下次到点改成第一个晚得不超过 lateMs 的，过了截止就完成。返回改过的任务
   */
  async function miss(task: Task, now: Date): Promise<Task> {
    const firstDue = new Date(task.nextDueAt!);
    let count = 0;
    let last = firstDue;
    let next: Date | undefined = firstDue;
    while (next && now.getTime() - next.getTime() > lateMs && count < maxMissedCount) {
      count++;
      last = next;
      next = task.schedule.kind === 'once' ? undefined : nextDue(task.schedule, next);
    }
    // 数到上限还没数完：直接从现在起算
    if (next && now.getTime() - next.getTime() > lateMs) {
      next = nextDue(task.schedule, new Date(now.getTime() - lateMs));
    }
    logger.info(
      {
        taskId: task.id,
        conversationId: task.conversationId,
        lateMs: now.getTime() - firstDue.getTime(),
        missed: count,
      },
      'task.missed',
    );
    await writeEvent(task, {
      event: { type: 'task-missed', taskId: task.id },
      text: missedText(task, { count, last, next }, now),
    });
    // 更新失败时抛出，由 tick 记日志；这一次到点已经记在 handled 里，不会再写一遍
    const updated = await storage.updateTask(
      task.id,
      next
        ? { nextDueAt: next.toISOString() }
        : { status: 'done', nextDueAt: null, endedAt: now.toISOString() },
    );
    handled.delete(task.id);
    return updated;
  }

  /**
   * 一个会话里同时到点的几个任务：各写一条 task 事件，各自往下走（到点次数加一、记上次到点；
   * 一次性的完成，周期的算出下一次，过了截止就完成），再交给前端一次
   */
  async function due(conversationId: string, tasks: Task[], now: Date): Promise<void> {
    let fromSeq: number | undefined;
    const written: DueTask[] = [];
    for (const task of tasks) {
      // 错过之后接着到点的那一次，在这里才记上
      handled.set(task.id, task.nextDueAt!);
      logger.info(
        { taskId: task.id, conversationId, lateMs: now.getTime() - Date.parse(task.nextDueAt!) },
        'task.due',
      );
      const event = await writeEvent(task, {
        event: { type: 'task', taskId: task.id },
        text: dueText(task, now),
      });
      if (event) {
        fromSeq ??= event.seq;
        written.push({ id: task.id, action: task.action });
      }
      const next = task.schedule.kind === 'once' ? undefined : nextDue(task.schedule, now);
      try {
        await storage.updateTask(task.id, {
          dueCount: task.dueCount + 1,
          lastDueAt: task.nextDueAt!,
          ...(next
            ? { nextDueAt: next.toISOString() }
            : { status: 'done', nextDueAt: null, endedAt: now.toISOString() }),
        });
        handled.delete(task.id);
      } catch (error) {
        // 不重试：任务停在这次到点，handled 记着它，之后看一眼时跳过
        backOff = true;
        logger.error(
          { taskId: task.id, conversationId, error: describeError(error) },
          'task.update_failed',
        );
      }
    }
    if (written.length === 0) return;
    const platform = (await storage.overview(conversationId))?.platform;
    const entrance = platform === undefined ? undefined : entrances.get(platform);
    if (!entrance) {
      logger.info({ conversationId, platform, tasks: written.length }, 'task.no_entrance');
      return;
    }
    try {
      await entrance({
        conversationId,
        tasks: written,
        ...(fromSeq === undefined ? {} : { fromSeq }),
      });
    } catch (error) {
      logger.error(
        { conversationId, platform, error: describeError(error) },
        'task.deliver_failed',
      );
    }
  }

  /**
   * 看一眼到点了没有：先处理错过的，再把到点的按会话合在一起处理。每个任务的同一次到点只处理一次
   * （见 handled）；出错只记日志，下一次按 waitMs 再看（见 backOff）
   */
  async function tick(): Promise<void> {
    if (stopped) return;
    const now = clock.now();
    let found: Task[];
    try {
      found = await storage.dueTasks(now.toISOString());
    } catch (error) {
      backOff = true;
      logger.error({ error: describeError(error) }, 'task.timer_failed');
      return;
    }
    const byConversation = new Map<string, Task[]>();
    for (let task of found) {
      if (handled.get(task.id) === task.nextDueAt) {
        backOff = true;
        continue;
      }
      handled.set(task.id, task.nextDueAt!);
      try {
        if (now.getTime() - Date.parse(task.nextDueAt!) > lateMs) {
          task = await miss(task, now);
          // 错过之后的下一次正好就在这几分钟里：照常到点
          if (task.status !== 'active' || Date.parse(task.nextDueAt!) > now.getTime()) continue;
        }
        byConversation.set(task.conversationId, [
          ...(byConversation.get(task.conversationId) ?? []),
          task,
        ]);
      } catch (error) {
        backOff = true;
        logger.error(
          { taskId: task.id, conversationId: task.conversationId, error: describeError(error) },
          'task.timer_failed',
        );
      }
    }
    for (const [conversationId, tasks] of byConversation) {
      try {
        await due(conversationId, tasks, now);
      } catch (error) {
        backOff = true;
        logger.error({ conversationId, error: describeError(error) }, 'task.timer_failed');
      }
    }
  }

  /** 会话要在，不能是 CLI 会话 */
  async function checkConversation(
    conversationId: string | undefined,
  ): Promise<Failure | undefined> {
    if (conversationId === undefined) return fail('不在任何会话里，用不了任务');
    const overview = await storage.overview(conversationId);
    if (!overview) return fail('没有这个会话');
    if (overview.platform === 'cli') return fail('CLI 会话不能建任务');
    return undefined;
  }

  return {
    /** 登记一个平台的到点入口（网页会话在服务里，Telegram 在第 4 步） */
    setEntrance(platform: string, entrance: TaskEntrance): void {
      entrances.set(platform, entrance);
    },

    /** 现在（定时器的时钟）：工具判断时刻、写结果时用 */
    now: () => clock.now(),

    /** 建任务：检查会话、触发者、做什么、时间、限额，都过了才建，定时器重排 */
    create(input: CreateTaskInput): Promise<{ ok: true; task: Task } | Failure> {
      return exclusive(async () => {
        const rejected = await checkConversation(input.conversationId);
        if (rejected) return rejected;
        const conversationId = input.conversationId!;
        const source = sourceOf(input.triggers, input.requestedBy);
        if (!source.ok) return source;
        const action = input.action.trim();
        if (!action) return fail('action 不能是空的：写明到点时要做什么');
        if ([...action].length > maxActionChars) {
          return fail(`action 最多 ${maxActionChars} 个字，写成一句话`);
        }
        const timing = scheduleFrom(input, clock.now());
        if (!timing.ok) return timing;
        const active = await storage.listTasks({ conversationId, status: 'active' });
        if (active.length >= maxActive) return fail('这个会话的任务满了，先取消几个');
        const task = await storage.createTask({
          conversationId,
          action,
          schedule: timing.schedule,
          source: source.trigger,
          nextDueAt: timing.next.toISOString(),
          createdAt: clock.now().toISOString(),
        });
        logger.info({ taskId: task.id, conversationId, kind: task.schedule.kind }, 'task.created');
        rearm();
        return { ok: true, task };
      });
    },

    /** 这个会话进行中的任务，按建立先后 */
    async list(conversationId: string | undefined): Promise<{ ok: true; tasks: Task[] } | Failure> {
      const rejected = await checkConversation(conversationId);
      if (rejected) return rejected;
      return { ok: true, tasks: await storage.listTasks({ conversationId, status: 'active' }) };
    },

    /**
     * 工具取消任务：ref 是 t7 或 7。只能取消这个会话进行中的任务；别的会话的、已经结束的、
     * 不存在的一律是「没有这个任务」，不透露别的会话有什么
     */
    cancelIn(
      conversationId: string | undefined,
      ref: string,
    ): Promise<{ ok: true; task: Task } | Failure> {
      return exclusive(async () => {
        const rejected = await checkConversation(conversationId);
        if (rejected) return rejected;
        const id = parseTaskRef(ref);
        const task = id === undefined ? undefined : await storage.getTask(id);
        if (!task || task.conversationId !== conversationId || task.status !== 'active') {
          return fail('没有这个任务');
        }
        return { ok: true, task: await end(task, 'tool') };
      });
    },

    /** 面板取消任务：任何会话的都行。没有这个任务、已经结束时说明是哪一种 */
    cancel(
      id: number,
    ): Promise<{ ok: true; task: Task } | { ok: false; reason: 'missing' | 'ended' }> {
      return exclusive(async () => {
        const task = await storage.getTask(id);
        if (!task) return { ok: false, reason: 'missing' };
        if (task.status !== 'active') return { ok: false, reason: 'ended' };
        return { ok: true, task: await end(task, 'panel') };
      });
    },

    /** 开始：先看一眼（处理停机期间错过的、正好到点的），再盯着最近的下次到点 */
    start(): void {
      if (started || stopped) return;
      started = true;
      void exclusive(tick);
      rearm();
    },

    /** 退出：停掉定时器，等正在处理的做完。之后不再到点（建、取消照常） */
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      await settle();
    },

    /** 排着的都做完（测试用） */
    settled: settle,
  };

  /** 取消：状态改为已取消，记下结束时间，定时器重排 */
  async function end(task: Task, by: 'tool' | 'panel'): Promise<Task> {
    const ended = await storage.updateTask(task.id, {
      status: 'cancelled',
      nextDueAt: null,
      endedAt: clock.now().toISOString(),
    });
    logger.info({ taskId: task.id, conversationId: task.conversationId, by }, 'task.cancelled');
    rearm();
    return ended;
  }

  async function settle(): Promise<void> {
    for (let last; last !== chain;) {
      last = chain;
      await last;
    }
  }
}

export type TaskService = ReturnType<typeof createTaskService>;

/** t7 或 7 → 7；不对时 undefined */
export function parseTaskRef(ref: string): number | undefined {
  const match = /^t?(\d{1,15})$/i.exec(ref.trim());
  return match ? Number(match[1]) : undefined;
}

/** 发言人：名字，有 uid 时加上 */
export function personOf(author: Trigger['author']): string {
  return author.id === undefined ? author.name : `${author.name}（uid ${author.id}）`;
}

/**
 * 谁让建的：触发这次回复的消息里挑一条。只有一个人时就是他最后那条；几个人一起触发时看 requestedBy
 * （uid，没有 uid 时写名字），没写或对不上时说明怎么写
 */
function sourceOf(
  triggers: readonly Trigger[],
  requestedBy: string | undefined,
): { ok: true; trigger: Trigger } | Failure {
  if (triggers.length === 0) {
    return fail('只能在有人让你建任务时建：这次回复不是哪个人的消息触发的');
  }
  const keyOf = (trigger: Trigger) =>
    trigger.author.id === undefined ? `name:${trigger.author.name}` : `id:${trigger.author.id}`;
  const people = new Map(triggers.map((trigger) => [keyOf(trigger), trigger.author]));
  if (people.size === 1) return { ok: true, trigger: triggers.at(-1)! };
  const list = [...people.values()].map(personOf).join('、');
  const wanted = requestedBy?.trim();
  if (!wanted) {
    return fail(
      `这次回复是几个人的消息一起触发的（${list}），用 requested_by 写明是谁让建的：<message> 里的 uid，没有 uid 时写名字`,
    );
  }
  const byId = triggers.filter((trigger) => trigger.author.id === wanted);
  const matched = byId.length > 0 ? byId : triggers.filter((t) => t.author.name === wanted);
  if (matched.length === 0) return fail(`requested_by 对不上这次触发的人：${list}`);
  if (new Set(matched.map(keyOf)).size > 1) {
    return fail(`requested_by 对上了不止一个人，改写 uid：${list}`);
  }
  return { ok: true, trigger: matched.at(-1)! };
}

/** 句末的标点去掉，接在别的话里 */
function clause(text: string): string {
  return text.replace(/[。.！!？?；;，,\s]+$/u, '');
}

/** 到点的事件：做什么、谁什么时候让建的、是一次性的还是周期的 */
export function dueText(task: Task, now: Date): string {
  const kind =
    task.schedule.kind === 'once'
      ? '一次性任务'
      : `周期任务（${describeSchedule(task.schedule, now)}）`;
  return `任务到点：${clause(task.action)}。${personOf(task.source.author)}在 ${formatShort(new Date(task.createdAt))} 让你建的，${kind}。`;
}

/**
 * 错过的事件：哪个任务、本该几点（周期的超时几次、最近一次），之后怎样。给人看的说法一律叫
 * 「任务超时」，不说「错过了」（用户定的）
 */
export function missedText(
  task: Task,
  { count, last, next }: { count: number; last: Date; next: Date | undefined },
  now: Date,
): string {
  const action = clause(task.action);
  if (task.schedule.kind === 'once') {
    return `任务超时：${action}（本该 ${formatShort(last)} 到点，那时洛璃服务没在运行）。这个一次性任务已经结束。`;
  }
  const times = count > 1 ? `超时 ${count} 次，最近一次` : '';
  const after = next ? `下次到点是 ${formatDue(next)}。` : '已经过了截止日期，任务结束。';
  return `任务超时：${action}（${describeSchedule(task.schedule, now)}；${times}本该 ${formatShort(last)} 到点，那时洛璃服务没在运行）。${after}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
