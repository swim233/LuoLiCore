import {
  type Conversation,
  type EventInput,
  type Logger,
  type Message,
  type Storage,
  type Task,
  type TaskChanges,
  type Trigger,
} from '../../core/index.js';
import type { FeedsDb } from '../feeds-db.js';
import { checkMonitor, type MonitorDescription } from '../monitors/describe.js';
import {
  createMonitorEngine,
  monitorOf,
  sourceSpec,
  type MonitorStatus,
} from '../monitors/engine.js';
import { monitorFactList, monitorLine, serviceTitles } from '../monitors/format.js';
import type { MonitorItem } from '../monitors/items.js';
import type { TaskMonitor } from '../types.js';
import { fetchFailureText, fetchItems } from '../monitors/trial.js';
import { sourceIdentity } from '../feeds-db.js';
import type { ServiceLayer } from '../services/layer.js';
import {
  describeSchedule,
  formatDue,
  formatShort,
  nextDue,
  scheduleFrom,
  type ScheduleInput,
  type ScheduleKind,
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

/**
 * 到点的一个任务：前端据此在「此刻」标出。platformMessageId 是任务来源消息在平台上的 id
 * （Telegram 的回复引用它）；来源没有时没有。event：监视任务写的是哪种事件（monitor 查到了新的东西，
 * monitor-failed 连续查不到）；定时任务没有
 */
export type DueTask = {
  id: number;
  action: string;
  platformMessageId?: string;
  event?: 'monitor' | 'monitor-failed';
};

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

/**
 * 前端的到点入口：按会话所在的平台登记。出错只记日志
 * - deliver：交给前端当作一次触发；
 * - accepts：这个会话现在还收不收到点（如 Telegram 的群已经被移出白名单就不收）。到点时（准时的、
 *   超时的都算）在写事件之前先问；不收时这次到点的任务取消，不写事件、不触发。前端正在退出不算不收。
 *   任务服务不认识白名单，由前端回答
 */
export type TaskEntrance = {
  deliver(due: TaskDue): void | Promise<void>;
  accepts(conversationId: string): boolean | Promise<boolean>;
};

/**
 * 建任务的参数：工具给的，加上会话与触发者。kind 是 monitor 时是监视任务，描述在 monitor 里
 * （ADR-0014），时间的几项不写
 */
export type CreateTaskInput = Omit<ScheduleInput, 'kind'> & {
  kind: ScheduleKind | 'monitor';
  monitor?: unknown;
  conversationId: string | undefined;
  triggers: readonly Trigger[];
  action: string;
  /** 几个人一起触发时，写明是谁让建的：uid，没有 uid 时写名字 */
  requestedBy?: string;
  /** 建监视任务时要真的查一次：工具的中止信号 */
  signal?: AbortSignal;
};

/** 建好的任务；监视任务还有建的时候查到了几条（算已有的）、取条目时的提醒 */
export type Created = { ok: true; task: Task; existing?: number; warnings?: string[] };

/**
 * 改任务的参数：工具给的，加上会话。ref 是 t7 或 7；action 是新的「做什么」；时间的几项（kind、at、
 * time、weekday、day、until）给了任何一项就是整个时间换成新的。空的字符串当作没给
 */
export type UpdateTaskInput = Partial<Omit<ScheduleInput, 'kind'>> & {
  kind?: ScheduleKind | 'monitor';
  conversationId: string | undefined;
  ref: string;
  action?: string;
  /** 监视任务：只写要改的字段，和原来的描述合起来再检查；null 是去掉这个字段 */
  monitor?: Readonly<Record<string, unknown>>;
  /** 改监视任务的来源时要真的查一次：工具的中止信号 */
  signal?: AbortSignal;
};

/** 时间的几项：改任务时给了其中任何一项，就是要换时间 */
const scheduleKeys = ['kind', 'at', 'time', 'weekday', 'day', 'until'] as const;

type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });

/**
 * 任务服务（ADR-0010）：任务工具与面板经它建、列出、改、取消任务；定时器在这里。
 * - 定时器盯着最近的「下次到点」，等待封顶 maxWaitMs；任务增删、改时间时重排。到点时先问会话所在
 *   平台的前端（setEntrance 登记）还收不收这个会话，不收的取消（ADR-0014）。收的：晚了不超过 lateMs
 *   的算到点，写一条 task 事件，交给前端当作一次触发；再晚的算错过：写一条 task-missed 事件，不触发，
 *   周期任务错过几次也只写一条，然后从现在起算下一次。
 * - 建任务、改任务、取消、到点的处理排成一串（一次只做一件），免得同时改同一个任务、超过限额，
 *   也不会刚改好的下次到点被到点的处理拿旧的算出来的盖掉。
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
  monitors,
}: {
  storage: Storage;
  /** 打开会话（会话管理的 open），写事件用 */
  open: (conversationId: string) => Promise<Pick<Conversation, 'append'>>;
  logger: Logger;
  clock?: Clock;
  lateMs?: number;
  waitMs?: number;
  maxActive?: number;
  /**
   * 监视（ADR-0014）：给了就建引擎（洛璃服务总是给，一个服务都没装上时 layer 里没有服务：留着的
   * 监视任务照查不到处理）。layer 是服务层，feeds 存来源、动态、谁在盯；notify 在监视任务的检查状态
   * 变了时调（面板要知道）
   */
  monitors?: {
    layer: Pick<ServiceLayer, 'services' | 'check' | 'call'>;
    feeds: FeedsDb;
    notify?: (task: Task) => void;
  };
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

  // 监视的引擎：处理查的结果、建、改、取消都排进这一串
  const engine =
    monitors &&
    createMonitorEngine({
      feeds: monitors.feeds,
      layer: monitors.layer,
      logger,
      clock,
      waitMs,
      lateMs,
      notify: monitors.notify,
      host: {
        run: exclusive,
        writeEvent,
        accepts,
        deliver,
        cancel: async (task) => {
          await end(task, 'timer', 'not_accepted');
        },
        update: (task, changes) => storage.updateTask(task.id, changes),
      },
    });

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
        const { platformMessageId } = task.source;
        written.push({
          id: task.id,
          action: task.action,
          ...(platformMessageId === undefined ? {} : { platformMessageId }),
        });
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
    // 只记日志、不用 backOff：事件写了，任务也已经往下走了（改任务失败的上面已经记了），
    // 下一次看一眼时不会再拿出这一次到点
    await deliver(conversationId, written, fromSeq);
  }

  /** 交给会话所在平台的前端当作一次触发；没登记入口的平台只记日志，入口出错只记日志 */
  async function deliver(
    conversationId: string,
    tasks: DueTask[],
    fromSeq: number | undefined,
  ): Promise<void> {
    if (tasks.length === 0) return;
    const platform = (await storage.overview(conversationId))?.platform;
    const entrance = platform === undefined ? undefined : entrances.get(platform);
    if (!entrance) {
      logger.info({ conversationId, platform, tasks: tasks.length }, 'task.no_entrance');
      return;
    }
    try {
      await entrance.deliver({
        conversationId,
        tasks,
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
   * 看一眼到点了没有：先问前端收不收、不收的取消，再处理错过的，再把到点的按会话合在一起处理。
   * 每个任务的同一次到点只处理一次（见 handled）；出错只记日志，下一次按 waitMs 再看（见 backOff）
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
    const fresh = found.filter((task) => {
      if (handled.get(task.id) !== task.nextDueAt) return true;
      backOff = true;
      return false;
    });
    // 先问前端这些会话还收不收（ADR-0014）：不收的，这次到点的任务取消，不写事件、不触发
    const refused = new Set<string>();
    for (const conversationId of new Set(fresh.map((task) => task.conversationId))) {
      if (!(await accepts(conversationId))) refused.add(conversationId);
    }
    const byConversation = new Map<string, Task[]>();
    for (let task of fresh) {
      handled.set(task.id, task.nextDueAt!);
      try {
        if (refused.has(task.conversationId)) {
          await end(task, 'timer', 'not_accepted');
          handled.delete(task.id);
          continue;
        }
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
        // 取消失败的下一次再试：没写事件，再来一遍也不会多写
        if (refused.has(task.conversationId)) handled.delete(task.id);
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

  /**
   * 会话所在平台的前端还收不收这个会话的到点。没登记入口的平台照旧（算收）；问不了（读不到会话、
   * 前端出错）时也算收，照原来的做法写事件、交给前端，只记一行日志
   */
  async function accepts(conversationId: string): Promise<boolean> {
    try {
      const platform = (await storage.overview(conversationId))?.platform;
      const entrance = platform === undefined ? undefined : entrances.get(platform);
      return entrance === undefined || (await entrance.accepts(conversationId));
    } catch (error) {
      logger.error({ conversationId, error: describeError(error) }, 'task.accepts_failed');
      return true;
    }
  }

  /** 会话要在，不能是 CLI 会话 */
  async function checkConversation(
    conversationId: string | undefined,
  ): Promise<Failure | undefined> {
    if (conversationId === undefined) return fail('当前不在任何会话中，无法使用任务');
    const overview = await storage.overview(conversationId);
    if (!overview) return fail('会话不存在');
    if (overview.platform === 'cli') return fail('CLI 会话不能创建任务');
    return undefined;
  }

  return {
    /**
     * 登记一个平台的到点入口（网页会话的在服务里登记，Telegram 的在它启动时登记）。入口的两个函数
     * 都在这一串里被 await：要马上返回，不等合并、不等回复
     */
    setEntrance(platform: string, entrance: TaskEntrance): void {
      entrances.set(platform, entrance);
    },

    /** 现在（定时器的时钟）：工具判断时刻、写结果时用 */
    now: () => clock.now(),

    /**
     * 建任务：检查会话、触发者、做什么、时间、限额，都过了才建，定时器重排。监视任务（kind 为 monitor）
     * 另走 createMonitor
     */
    create(input: CreateTaskInput): Promise<Created | Failure> {
      if (input.kind === 'monitor') return createMonitor(input);
      return exclusive(async () => {
        const rejected = await checkConversation(input.conversationId);
        if (rejected) return rejected;
        const conversationId = input.conversationId!;
        const source = sourceOf(input.triggers, input.requestedBy);
        if (!source.ok) return source;
        const action = checkAction(input.action);
        if (!action.ok) return action;
        if (input.monitor !== undefined) {
          return fail('monitor 仅在 kind 为 monitor 时填写：定时任务无需描述');
        }
        const timing = scheduleFrom({ ...input, kind: input.kind as ScheduleKind }, clock.now());
        if (!timing.ok) return timing;
        const active = await storage.listTasks({ conversationId, status: 'active' });
        if (active.length >= maxActive) return fail('此会话的任务已达上限，请先取消几个');
        const task = await storage.createTask({
          conversationId,
          action: action.text,
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
          return fail('任务不存在');
        }
        return { ok: true, task: await end(task, 'tool') };
      });
    },

    /**
     * 工具改任务：只能改这个会话进行中的任务（别的一律「没有这个任务」，同 cancelIn）。只给 action
     * 时只换「做什么」，下次到点不变；给了时间的任何一项时整个时间换成新的，照建任务的规则检查，
     * 下次到点从现在重新算。谁让建的、来源消息、到点次数不变。改完定时器重排。
     * 监视任务另走 updateMonitor；定时任务和监视任务不能互相改
     */
    async update(input: UpdateTaskInput): Promise<Created | Failure> {
      // 先看一眼是哪种任务（改定时任务的检查都在那一串里重做一遍）
      const found = await findIn(input.conversationId, input.ref);
      if (found.ok && monitorOf(found.task)) return updateMonitor(input, found.task);
      return exclusive(async () => {
        const { conversationId } = input;
        const current = await findIn(conversationId, input.ref);
        if (!current.ok) return current;
        const { task } = current;
        if (input.monitor !== undefined || input.kind === 'monitor') {
          return fail(
            '此任务为定时任务，不能改为监听任务：需要监听时，取消此任务后另行创建监听任务',
          );
        }
        const action = input.action?.trim();
        const timed = scheduleKeys.some((key) => given(input[key]));
        if (!action && !timed) {
          return fail('至少修改一项：填写新的 action，或者新的时间（kind 及其需要的参数）');
        }
        const changes: TaskChanges = {};
        if (action) {
          if ([...action].length > maxActionChars) {
            return fail(`action 最多 ${maxActionChars} 个字，请写成一句话`);
          }
          changes.action = action;
        }
        if (timed) {
          if (input.kind === undefined) {
            return fail('修改时间须填写 kind：时间整体替换，kind 及其需要的参数都要填写');
          }
          const timing = scheduleFrom({ ...input, kind: input.kind }, clock.now());
          if (!timing.ok) return timing;
          changes.schedule = timing.schedule;
          changes.nextDueAt = timing.next.toISOString();
        }
        const updated = await storage.updateTask(task.id, changes);
        logUpdated(updated, changes);
        rearm();
        return { ok: true, task: updated };
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

    /**
     * 能不能在这个会话里用任务（建、试跑监视）：不能时是给她看的原因（如 CLI 会话），能时 undefined
     */
    async allows(conversationId: string | undefined): Promise<string | undefined> {
      return (await checkConversation(conversationId))?.error;
    },

    /** 监视任务的检查状态（上次检查、上次成功、是不是查不到）；不是监视任务、没在盯时没有 */
    monitorStatus(taskId: number): MonitorStatus | undefined {
      return engine?.status(taskId);
    },

    /**
     * 监视任务在任务列表里的样子（给面板）：描述、写成人话的一行、检查的状态；不是监视任务时没有。
     * 没在盯（已经结束了）时只有描述和那一行
     */
    monitorView(task: Task): TaskMonitor | undefined {
      const monitor = monitorOf(task);
      if (!monitor || task.schedule.kind !== 'monitor') return undefined;
      const titles = serviceTitles(monitors?.layer.services ?? []);
      return {
        description: task.schedule.monitor,
        line: monitorLine(monitor, titles),
        facts: monitorFactList(monitor, titles),
        ...engine?.status(task.id),
      };
    },

    /**
     * 开始：先看一眼（处理停机期间错过的、正好到点的），再盯着最近的下次到点；监视的引擎对账、
     * 开始查
     */
    start(): void {
      if (started || stopped) return;
      started = true;
      void exclusive(tick);
      rearm();
      if (engine) {
        void exclusive(async () => {
          try {
            await engine.start(await storage.listTasks({ status: 'active' }));
          } catch (error) {
            logger.error({ error: describeError(error) }, 'monitor.start_failed');
          }
        });
      }
    },

    /** 退出：停掉定时器和监视的引擎（中止进行中的请求），等正在处理的做完。之后不再到点 */
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      await engine?.stop();
      await settle();
    },

    /** 排着的都做完（测试用） */
    settled: settle,
  };

  /**
   * 取消：状态改为已取消，记下结束时间，定时器重排。by 是谁取消的：工具、面板，或者定时器
   * （到点时会话的前端不收了，reason 写原因）
   */
  async function end(
    task: Task,
    by: 'tool' | 'panel' | 'timer',
    reason?: 'not_accepted',
  ): Promise<Task> {
    const ended = await storage.updateTask(task.id, {
      status: 'cancelled',
      nextDueAt: null,
      endedAt: clock.now().toISOString(),
    });
    logger.info(
      {
        taskId: task.id,
        conversationId: task.conversationId,
        by,
        ...(reason === undefined ? {} : { reason }),
      },
      'task.cancelled',
    );
    engine?.unwatch(task.id);
    rearm();
    return ended;
  }

  /** 排着的都做完，监视正在查的也做完（查完的结果又会排进来，所以两边轮流等，直到都没有） */
  async function settle(): Promise<void> {
    for (;;) {
      const last = chain;
      await last;
      if (engine?.busy()) {
        await engine.settled();
        continue;
      }
      if (last === chain) return;
    }
  }

  /** 「做什么」：去掉首尾空白，不能是空的，不能太长 */
  function checkAction(raw: string): { ok: true; text: string } | Failure {
    const text = raw.trim();
    if (!text) return fail('action 不能为空：写明触发时要做什么');
    if ([...text].length > maxActionChars) {
      return fail(`action 最多 ${maxActionChars} 个字，请写成一句话`);
    }
    return { ok: true, text };
  }

  /** 这个会话里进行中的这个任务（ref 是 t7 或 7）；不能用任务的会话、找不到时是说明 */
  async function findIn(
    conversationId: string | undefined,
    ref: string,
  ): Promise<{ ok: true; task: Task } | Failure> {
    const rejected = await checkConversation(conversationId);
    if (rejected) return rejected;
    const id = parseTaskRef(ref);
    const task = id === undefined ? undefined : await storage.getTask(id);
    if (!task || task.conversationId !== conversationId || task.status !== 'active') {
      return fail('任务不存在');
    }
    return { ok: true, task };
  }

  /** 改任务的日志：只记改了哪几样（和新时间的种类），不记「做什么」、不记描述 */
  function logUpdated(task: Task, changes: TaskChanges): void {
    logger.info(
      {
        taskId: task.id,
        conversationId: task.conversationId,
        changed: Object.keys(changes).filter((key) => key !== 'nextDueAt'),
        ...(changes.schedule ? { kind: changes.schedule.kind } : {}),
      },
      'task.updated',
    );
  }

  /** 照描述真的查一次（建、改来源时）；没通过时是说明 */
  async function fetchFor(
    monitor: MonitorDescription,
    signal: AbortSignal | undefined,
    doing: string,
  ): Promise<{ ok: true; items: MonitorItem[]; warnings: string[] } | Failure> {
    const fetched = await fetchItems(monitors!.layer, monitor, { signal });
    if (fetched.ok) return fetched;
    return fail(`${doing}：按描述实际执行了一次请求，未通过。${fetchFailureText(fetched)}`);
  }

  /**
   * 建监视任务（ADR-0014）：静态检查 → 查上限等 → 照描述真的查一次（和试跑同一套，查不通就不建）→
   * 存任务 → 让引擎开始盯。这次查到的条目存进动态，算已有的，不到点。请求在这一串外面发，
   * 进了这一串再查一次上限
   */
  async function createMonitor(input: CreateTaskInput): Promise<Created | Failure> {
    const rejected = await checkConversation(input.conversationId);
    if (rejected) return rejected;
    const conversationId = input.conversationId!;
    const source = sourceOf(input.triggers, input.requestedBy);
    if (!source.ok) return source;
    const action = checkAction(input.action);
    if (!action.ok) return action;
    if (!monitors || monitors.layer.services.length === 0) {
      return fail('当前没有已安装的服务，无法创建监听任务');
    }
    const extra = scheduleKeys.filter((key) => key !== 'kind' && given(input[key]));
    if (extra.length > 0) {
      return fail(
        `监听任务无需填写时间相关的参数（${extra.join('、')}）：监听间隔填在 monitor 的 interval_minutes 里`,
      );
    }
    if (input.monitor === undefined) {
      return fail('kind 为 monitor 时须填写 monitor：监听任务的描述，写法见 read_docs 的 monitor');
    }
    const checked = checkMonitor(input.monitor, { services: monitors.layer, purpose: 'task' });
    if (!checked.ok)
      return fail(`描述有问题，请修改后重新创建：\n${problemLines(checked.problems)}`);
    const full = async () =>
      (await storage.listTasks({ conversationId, status: 'active' })).length >= maxActive;
    if (await full()) return fail('此会话的任务已达上限，请先取消几个');
    const fetched = await fetchFor(checked.monitor, input.signal, '未创建');
    if (!fetched.ok) return fetched;
    return exclusive(async () => {
      if (await full()) return fail('此会话的任务已达上限，请先取消几个');
      const task = await storage.createTask({
        conversationId,
        action: action.text,
        schedule: { kind: 'monitor', monitor: checked.monitor },
        source: source.trigger,
        createdAt: clock.now().toISOString(),
      });
      engine!.watch(task, fetched.items);
      logger.info({ taskId: task.id, conversationId, kind: 'monitor' }, 'task.created');
      return { ok: true, task, existing: fetched.items.length, warnings: fetched.warnings };
    });
  }

  /**
   * 改监视任务：monitor 里只写要改的字段（null 是去掉），和原来的描述合起来再检查。改了 service、
   * endpoint、params、items、key 中的任何一个：照新的描述真的查一次，通过才生效，算换了来源，这次查到的
   * 只存不到点。只改别的、或只改 action：马上生效，不发请求。不能改成定时任务。
   * 合并、检查都对着那一串里重新读到的任务做（同一步里两个修改不会互相盖掉）。要换来源时请求在外面发，
   * 外面照看到的样子先合一次；进了那一串重新合出来的来源和查过的不一样（期间别人改过来源）时不改
   */
  async function updateMonitor(input: UpdateTaskInput, peeked: Task): Promise<Created | Failure> {
    const timed = scheduleKeys.filter(
      (key) => given(input[key]) && !(key === 'kind' && input.kind === 'monitor'),
    );
    if (timed.length > 0) {
      return fail(
        '此任务为监听任务，不能改为定时任务，也无需填写时间相关的参数（监听间隔填在 monitor 的 interval_minutes 里）；需要定时任务时，取消此任务后另行创建',
      );
    }
    const action = input.action?.trim();
    const patch = input.monitor;
    const patched = patch !== undefined && Object.keys(patch).length > 0;
    if (!action && !patched) {
      return fail('至少修改一项：填写新的 action，或者在 monitor 里填写要修改的字段');
    }
    if (action && [...action].length > maxActionChars) {
      return fail(`action 最多 ${maxActionChars} 个字，请写成一句话`);
    }
    if (patched && (!monitors || monitors.layer.services.length === 0)) {
      return fail('当前没有已安装的服务，无法修改监听任务的描述');
    }
    const check = (base: MonitorDescription) =>
      checkMonitor(mergeMonitor(base, patch!), { services: monitors!.layer, purpose: 'task' });
    // 外面先照看到的样子合一次：换了来源时在这一串外面查
    let fetched: { identity: string; items: MonitorItem[]; warnings: string[] } | undefined;
    if (patched) {
      const old = monitorOf(peeked)!;
      const draft = check(old);
      const identity = draft.ok ? sourceIdentity(sourceSpec(draft.monitor)) : undefined;
      if (draft.ok && identity !== sourceIdentity(sourceSpec(old))) {
        const result = await fetchFor(draft.monitor, input.signal, '未修改');
        if (!result.ok) return result;
        fetched = { identity: identity!, items: result.items, warnings: result.warnings };
      }
    }
    return exclusive(async () => {
      const current = await findIn(input.conversationId, input.ref);
      if (!current.ok) return current;
      const old = monitorOf(current.task);
      if (!old) return fail('任务不存在');
      const changes: TaskChanges = {};
      if (action) changes.action = action;
      let moved = false;
      if (patched) {
        const checked = check(old);
        if (!checked.ok) return fail(`描述有问题，未修改：\n${problemLines(checked.problems)}`);
        const identity = sourceIdentity(sourceSpec(checked.monitor));
        moved = identity !== sourceIdentity(sourceSpec(old));
        if (moved && fetched?.identity !== identity) {
          return fail('未修改：此任务刚被修改过，请重新修改一次');
        }
        changes.schedule = { kind: 'monitor', monitor: checked.monitor };
      }
      const updated = await storage.updateTask(current.task.id, changes);
      if (moved) engine?.watch(updated, fetched!.items);
      else engine?.changed(updated);
      logUpdated(updated, changes);
      return moved
        ? { ok: true, task: updated, existing: fetched!.items.length, warnings: fetched!.warnings }
        : { ok: true, task: updated };
    });
  }
}

/** 原来的描述加上修改：写了的字段换掉，null 的去掉 */
function mergeMonitor(
  base: MonitorDescription,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete merged[name];
    else if (value !== undefined) merged[name] = value;
  }
  return merged;
}

/** 给了：不是 undefined，也不是空字符串（模型常给可选参数填空字符串） */
function given(value: unknown): boolean {
  return value !== undefined && value !== '';
}

/** 问题逐条列出 */
function problemLines(problems: readonly string[]): string {
  return problems.map((line) => `- ${line}`).join('\n');
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
    return fail('只能在有人要求时创建任务：本次回复由任务触发之类的事件引起，不是某个人发来的消息');
  }
  const keyOf = (trigger: Trigger) =>
    trigger.author.id === undefined ? `name:${trigger.author.name}` : `id:${trigger.author.id}`;
  const people = new Map(triggers.map((trigger) => [keyOf(trigger), trigger.author]));
  if (people.size === 1) return { ok: true, trigger: triggers.at(-1)! };
  const list = [...people.values()].map(personOf).join('、');
  const wanted = requestedBy?.trim();
  if (!wanted) {
    return fail(
      `本次回复由多人的消息共同触发（${list}），请用 requested_by 写明是谁要求创建的：填 <message> 里的 uid，没有 uid 时填名字`,
    );
  }
  const byId = triggers.filter((trigger) => trigger.author.id === wanted);
  const matched = byId.length > 0 ? byId : triggers.filter((t) => t.author.name === wanted);
  if (matched.length === 0) return fail(`requested_by 与本次触发的人不匹配：${list}`);
  if (new Set(matched.map(keyOf)).size > 1) {
    return fail(`requested_by 匹配到不止一个人，请改填 uid：${list}`);
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
  return `任务触发：${clause(task.action)}。由${personOf(task.source.author)}于 ${formatShort(new Date(task.createdAt))} 创建，${kind}。`;
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
    return `任务超时：${action}（原定 ${formatShort(last)} 触发，当时核心服务未运行）。此一次性任务已结束。`;
  }
  const times = count > 1 ? `超时 ${count} 次，最近一次` : '';
  const after = next ? `下次触发的时间是 ${formatDue(next)}。` : '已过截止日期，任务已结束。';
  return `任务超时：${action}（${describeSchedule(task.schedule, now)}；${times}原定 ${formatShort(last)} 触发，当时核心服务未运行）。${after}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
