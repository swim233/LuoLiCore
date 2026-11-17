import type { EventInput, Logger, Task } from '../../core/index.js';
import {
  sourceIdentity,
  type FeedsDb,
  type FeedSource,
  type SourceSpec,
  type Watcher,
} from '../feeds-db.js';
import { isJsonObject, parseJson, stringifyJson, type JsonObject } from '../services/json.js';
import type { ServiceLayer } from '../services/layer.js';
import type { Clock, DueTask } from '../tasks/service.js';
import type { MonitorDescription } from './describe.js';
import { monitorEventText, monitorFailedText } from './format.js';
import type { MonitorItem } from './items.js';
import { fetchItems, type FetchResult } from './trial.js';
import { matches } from './where.js';

// 监听的引擎（ADR-0014）：照每个监听任务的描述定时去查，这一段不请求模型。
// - 来源：服务、接口、参数、条目在哪、认新旧都相同的一处（feeds.db 的 sources），只查一次，按盯着它的
//   任务里最短的间隔；没有任务盯着时不查。服务没在运行时不查，也不补；重启后到了时间的尽快查一次。
// - 查一次：经服务层调接口 → 取条目 → 没见过的编号存进动态 → 对每个盯着它的任务，取游标之后的新条目，
//   按 where 过滤，有符合的就到点一次 → 推进游标（不符合的也算看过）。
// - 到点：先问会话所在平台的前端还收不收，不收的取消任务；收的写一条 monitor 事件，记上次到点、到点次数，
//   reply 的交给前端当作一次触发（同一个会话的几个合在一次），record 的只写事件。
// - 查不到：记下原因，拉长间隔再试；连续满 6 小时在会话里说一次（monitor-failed，触发回复）。6 小时只算
//   一直在查的时候：比排好的时间晚了超过 lateMs 才开始的检查（中间服务停过、电脑睡过）又失败时，这一轮
//   从这一次重新算（说过没有不变）。
// - 动态和任务不在一个库里：先写事件，再推进游标（不会丢，最多重一次）。重启时照游标补。游标写不进去时
//   这次运行里以内存里记着的为准，不再为同一批条目写事件。
// - 引擎自己出错（feeds.db 读写不了、改任务出错……）只记日志（monitor.check_failed），不让进程退出；
//   这一次按查不到（internal）处理、照常拉长间隔，连这个也记不了时在内存里拦着，不马上再查。
// 请求在外面发，处理结果、建、改、取消、对账都排进任务服务的那一串（host.run），不互相踩

/** 连续查不到这么久，在会话里说一次 */
export const failureReportMs = 6 * 3_600_000;
/** 查不到时最长隔多久再试；认证、额度的问题直接等这么久 */
const longestRetryMs = 3_600_000;
/** 引擎自己出错、连失败都记不下时，这个来源最少隔多久再查 */
const shortestHoldMs = 60_000;
/** 引擎自己出错时记的那一次失败 */
const internalFailure = { ok: false, kind: 'internal', text: '监听引擎发生错误' } as const;

/** 引擎要任务服务做的几件事；除了 run，都只在那一串里调用 */
export type EngineHost = {
  /** 排进任务服务的那一串 */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** 写一条事件，返回序号；失败时只记日志，返回 false */
  writeEvent(task: Task, input: EventInput): Promise<{ seq: number | undefined } | false>;
  /** 会话所在平台的前端还收不收这个会话的到点 */
  accepts(conversationId: string): Promise<boolean>;
  /** 交给会话所在平台的前端当作一次触发 */
  deliver(conversationId: string, tasks: DueTask[], fromSeq: number | undefined): Promise<void>;
  /** 会话不收了：取消这个任务（会调回 unwatch） */
  cancel(task: Task): Promise<void>;
  /** 改任务（记上次到点、到点次数），返回改过的 */
  update(task: Task, changes: { lastDueAt: string; dueCount: number }): Promise<Task>;
};

/** 一个监听任务的检查状态（给 list_tasks、面板） */
export type MonitorStatus = {
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  /** 正在查不到时有：从什么时候起、最近一次的原因 */
  failing?: { since: string; reason: string };
};

/** 任务里的描述（建、改时检查过；核心只当它是数据） */
export function monitorOf(task: Task): MonitorDescription | undefined {
  return task.schedule.kind === 'monitor'
    ? (task.schedule.monitor as unknown as MonitorDescription)
    : undefined;
}

/** 描述里认来源的那几项 */
export function sourceSpec(monitor: MonitorDescription): SourceSpec {
  return {
    service: monitor.service,
    endpoint: monitor.endpoint,
    params: monitor.params ?? {},
    items: monitor.items,
    key: monitor.key,
  };
}

/** 一次检查的结果：取到的条目，或者失败的类别、状态码、说明 */
type CheckResult =
  { ok: true; items: MonitorItem[] } | { ok: false; kind: string; status?: number; text: string };

export type MonitorEngine = ReturnType<typeof createMonitorEngine>;

export function createMonitorEngine({
  feeds,
  layer,
  host,
  logger,
  clock,
  waitMs,
  lateMs,
  notify = () => {},
}: {
  feeds: FeedsDb;
  layer: Pick<ServiceLayer, 'services' | 'call'>;
  host: EngineHost;
  logger: Logger;
  clock: Clock;
  /** 定时器一次最多等多久，到时重新看一眼 */
  waitMs: number;
  /** 检查比排好的时间晚了超过这么久才开始，说明中间服务停过或电脑睡过（同任务的「超时」） */
  lateMs: number;
  /** 一个监听任务的检查状态变了（面板要知道） */
  notify?: (task: Task) => void;
}) {
  /** 进行中的监听任务（对账时从任务表读一遍，之后由建、改、取消保持） */
  const known = new Map<number, Task>();
  /** 正在查的来源 */
  const inFlight = new Set<number>();
  /** 正在查的那几次（测试、退出时等它们做完） */
  const checks = new Set<Promise<void>>();
  /** 引擎自己出错、连失败都记不下的来源：最早什么时候能再查（毫秒） */
  const held = new Map<number, number>();
  /**
   * 每个任务的事件写到了哪一条动态（这次运行里）：游标写不进 feeds.db 时以它为准，同一批条目不再写一遍
   * 事件。重启以后没了，照游标补（最多重一次）
   */
  const written = new Map<number, number>();
  const controller = new AbortController();
  let timer: unknown;
  let started = false;
  let stopped = false;

  /** 盯着这个来源的进行中的任务，连同它们的游标 */
  function watchersOf(sourceId: number): Array<{ watcher: Watcher; task: Task }> {
    return feeds.watchers().flatMap((watcher) => {
      const task = known.get(watcher.taskId);
      return watcher.sourceId === sourceId && task ? [{ watcher, task }] : [];
    });
  }

  /** 有任务盯着的来源 */
  function watchedSources(): number[] {
    return [
      ...new Set(
        feeds
          .watchers()
          .filter(({ taskId }) => known.has(taskId))
          .map(({ sourceId }) => sourceId),
      ),
    ];
  }

  /** 下一次隔多久：平时是间隔；查不到时拉长，认证、额度的问题直接等最长的 */
  function delayOf(source: FeedSource, intervalMs: number): number {
    const failure = source.failure;
    if (!failure) return intervalMs;
    const status = failure.status;
    if (
      failure.kind === 'quota' ||
      failure.kind === 'unavailable' ||
      status === 401 ||
      status === 403 ||
      status === 429
    ) {
      return Math.max(intervalMs, longestRetryMs);
    }
    return Math.max(intervalMs, Math.min(longestRetryMs, intervalMs * 2 ** failure.count));
  }

  /**
   * 重算一个来源下次什么时候查：按盯着它的任务里最短的间隔，从上次检查起算；没检查过就是现在。
   * 任务增删、改间隔时（notBefore 是现在）不排到过去：晚了的检查只该是服务停过、电脑睡过造成的
   */
  function reschedule(sourceId: number, notBefore?: number): void {
    const source = feeds.source(sourceId);
    if (!source) return;
    const intervals = watchersOf(sourceId).flatMap(({ task }) => {
      const minutes = monitorOf(task)?.interval_minutes;
      return typeof minutes === 'number' && minutes > 0 ? [minutes] : [];
    });
    if (intervals.length === 0) {
      feeds.setNextCheck(sourceId, undefined);
      return;
    }
    const intervalMs = Math.min(...intervals) * 60_000;
    const base = source.lastCheckedAt ? Date.parse(source.lastCheckedAt) : clock.now().getTime();
    const next = source.lastCheckedAt ? base + delayOf(source, intervalMs) : base;
    feeds.setNextCheck(sourceId, new Date(Math.max(next, notBefore ?? next)).toISOString());
  }

  /** 什么时候该查（毫秒）：排好的下次检查，和内存里拦着的时间，取晚的；都没有时是现在 */
  function dueAt(source: FeedSource, now: number): number {
    const next = source.nextCheckAt ? Date.parse(source.nextCheckAt) : now;
    return Math.max(next, held.get(source.id) ?? next);
  }

  /** 盯着这个来源的任务里最短的间隔（毫秒），只看内存里的任务（feeds.db 坏了也算得出） */
  function intervalOf(source: FeedSource): number {
    const identity = sourceIdentity(source);
    const minutes = [...known.values()].flatMap((task) => {
      const monitor = monitorOf(task);
      const interval = monitor?.interval_minutes;
      return monitor &&
        typeof interval === 'number' &&
        interval > 0 &&
        sourceIdentity(sourceSpec(monitor)) === identity
        ? [interval]
        : [];
    });
    return minutes.length > 0 ? Math.min(...minutes) * 60_000 : 0;
  }

  /** 引擎自己出错：只记日志（来源知道时带上，step 是哪一步） */
  function failed(sourceId: number | undefined, step: string, error: unknown): void {
    logger.error(
      {
        ...(sourceId === undefined ? {} : { source: sourceId }),
        step,
        error: describeError(error),
      },
      'monitor.check_failed',
    );
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  }

  /** 重排定时器：等到最近的下次检查（最多 waitMs）；没有要查的来源时不等 */
  function rearm(): void {
    clearTimer();
    if (!started || stopped) return;
    const now = clock.now().getTime();
    const times = watchedSources()
      .filter((id) => !inFlight.has(id))
      .flatMap((id) => {
        try {
          const source = feeds.source(id);
          return source ? [dueAt(source, now)] : [];
        } catch (error) {
          // 读不出来的来源只记日志，过 waitMs 再看一眼；别的照常
          failed(id, 'rearm', error);
          return [now + waitMs];
        }
      });
    if (times.length === 0) return;
    const wait = Math.min(Math.max(0, Math.min(...times) - now), waitMs);
    timer = clock.setTimeout(fire, wait);
  }

  /** 重排定时器；出错（读不了 feeds.db）时记日志，按 waitMs 再看一眼 */
  function rearmSafely(): void {
    try {
      rearm();
    } catch (error) {
      failed(undefined, 'rearm', error);
      clearTimer();
      if (started && !stopped) timer = clock.setTimeout(fire, waitMs);
    }
  }

  /** 看一眼，出错只记日志 */
  function tickSafely(): void {
    try {
      tick();
    } catch (error) {
      failed(undefined, 'tick', error);
    }
  }

  function fire(): void {
    timer = undefined;
    void host
      .run(async () => {
        tickSafely();
        rearmSafely();
      })
      .catch((error: unknown) => failed(undefined, 'timer', error));
  }

  /** 看一眼：到了时间、没在查的来源开始查（请求在这一串外面发） */
  function tick(): void {
    if (stopped) return;
    const now = clock.now().getTime();
    for (const id of watchedSources()) {
      if (inFlight.has(id)) continue;
      // 一个来源读不出来只记日志、跳过，别的照常查
      try {
        let source = feeds.source(id);
        if (!source) continue;
        if (!source.nextCheckAt) {
          reschedule(id);
          source = feeds.source(id)!;
        }
        const due = dueAt(source, now);
        if (due <= now) check(source, now - due > lateMs);
      } catch (error) {
        failed(id, 'tick', error);
      }
    }
  }

  /**
   * 查一个来源：请求在外面发，结果排进那一串里处理。late：比排好的时间晚了超过 lateMs 才开始。
   * 处理结果时出错：只记日志，这一次按查不到处理（见 recover），不会马上再查
   */
  function check(source: FeedSource, late: boolean): void {
    inFlight.add(source.id);
    held.delete(source.id);
    const begun = performance.now();
    const job = (async () => {
      let result: CheckResult;
      try {
        result = await request(source);
      } catch (error) {
        failed(source.id, 'request', error);
        result = internalFailure;
      }
      if (stopped) return;
      const durationMs = Math.round(performance.now() - begun);
      try {
        await host.run(() => apply(source.id, result, durationMs, late));
      } catch (error) {
        failed(source.id, 'apply', error);
        if (!stopped) await host.run(() => recover(source, late));
      }
    })()
      .catch((error: unknown) => failed(source.id, 'check', error))
      .finally(() => {
        inFlight.delete(source.id);
        checks.delete(job);
        if (!stopped) {
          void host
            .run(async () => rearmSafely())
            .catch((error: unknown) => failed(source.id, 'rearm', error));
        }
      });
    checks.add(job);
  }

  /**
   * 处理结果时出错（在那一串里）：这一次按查不到（internal）记下、照常拉长间隔，满 6 小时照样说。
   * 连这个也做不了（feeds.db 写不了）时，在内存里拦着：至少隔一个间隔（不少于 shortestHoldMs）再查
   */
  async function recover(source: FeedSource, late: boolean): Promise<void> {
    const now = clock.now();
    try {
      feeds.recordFailure(source.id, now.toISOString(), {
        kind: internalFailure.kind,
        text: internalFailure.text,
        restart: late,
      });
      reschedule(source.id);
    } catch (error) {
      failed(source.id, 'recover', error);
      held.set(source.id, now.getTime() + Math.max(intervalOf(source), shortestHoldMs));
      return;
    }
    try {
      await reportFailure(source.id, now);
    } catch (error) {
      failed(source.id, 'report', error);
    }
    for (const task of watchingTasks(source.id)) notifySafely(task);
  }

  /** 盯着这个来源的任务（读不了时没有） */
  function watchingTasks(sourceId: number): Task[] {
    try {
      return watchersOf(sourceId).map(({ task }) => task);
    } catch {
      return [];
    }
  }

  /** 告诉面板检查的状态变了；出错只记日志 */
  function notifySafely(task: Task): void {
    try {
      notify(task);
    } catch (error) {
      failed(undefined, 'notify', error);
    }
  }

  /** 发请求、取条目。服务没装上时不发请求 */
  async function request(source: FeedSource): Promise<CheckResult> {
    if (!layer.services.some(({ name }) => name === source.service)) {
      return { ok: false, kind: 'unavailable', text: `服务 ${source.service} 未安装` };
    }
    const fetched: FetchResult = await fetchItems(layer, source, { signal: controller.signal });
    if (fetched.ok) return { ok: true, items: fetched.items };
    return {
      ok: false,
      kind: fetched.step === 'call' ? (fetched.kind ?? 'network') : 'shape',
      ...(fetched.status === undefined ? {} : { status: fetched.status }),
      text: fetched.error,
    };
  }

  /** 处理一次检查的结果（在那一串里）；late 的检查失败时，这一轮故障从这一次重新算 */
  async function apply(
    sourceId: number,
    result: CheckResult,
    durationMs: number,
    late: boolean,
  ): Promise<void> {
    if (stopped) return;
    const now = clock.now();
    const at = now.toISOString();
    const source = feeds.source(sourceId);
    if (!source) return;
    let fresh = 0;
    if (result.ok) {
      fresh = feeds.storeItems(
        sourceId,
        result.items.map(({ key, data }) => ({ key, data: stringifyJson(data) })),
        at,
      );
      const latest = new Map(result.items.map(({ key, data }) => [key, data]));
      // 刚补上的（对账时）：这一次查到的只存不到点
      const ready = watchersOf(sourceId).filter(({ watcher, task }) => {
        if (watcher.cursor !== undefined) return true;
        feeds.setCursor(task.id, feeds.lastItemId(sourceId));
        return false;
      });
      await deliverNew(sourceId, ready, latest, now);
      // 到点做完才算成功：中间出错时按查不到记，失败的次数接着上一次的往上加
      feeds.recordSuccess(sourceId, at);
    } else {
      feeds.recordFailure(sourceId, at, {
        kind: result.kind,
        ...(result.status === undefined ? {} : { status: result.status }),
        text: result.text,
        restart: late,
      });
      await reportFailure(sourceId, now);
    }
    reschedule(sourceId);
    logger.info(
      {
        source: sourceId,
        service: source.service,
        endpoint: source.endpoint,
        outcome: result.ok ? 'ok' : result.kind,
        ...(!result.ok && result.status !== undefined ? { status: result.status } : {}),
        items: result.ok ? result.items.length : 0,
        new: fresh,
        durationMs,
      },
      'monitor.check',
    );
    for (const { task } of watchersOf(sourceId)) notifySafely(task);
  }

  /** 存着的一条动态的数据；存的时候截掉了、解析不了时没有 */
  function storedData(data: string, truncated: boolean): JsonObject | undefined {
    if (truncated) return undefined;
    try {
      const value = parseJson(data);
      return isJsonObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 对盯着这个来源的任务：游标之后的新条目按 where 过滤，有符合的到点（同一个会话的合在一起问、
   * 合在一次触发里），推进游标。latest 是这一次查到的数据（没有的从动态里读）。
   * 游标写不进去时：内存里记着写到了哪一条（不再为同一批条目写事件），这一批照常做完（交给前端），
   * 最后抛出，这一次按查不到记；之后每次再试着把游标写进去
   */
  async function deliverNew(
    sourceId: number,
    watching: Array<{ watcher: Watcher; task: Task }>,
    latest: Map<string, JsonObject>,
    now: Date,
  ): Promise<void> {
    let cursorError: unknown;
    /** 推进游标：先记在内存里，再写进 feeds.db；写不进去的记下错误，接着做 */
    const advance = (taskId: number, last: number) => {
      written.set(taskId, Math.max(last, written.get(taskId) ?? 0));
      try {
        feeds.setCursor(taskId, last);
      } catch (error) {
        cursorError ??= error;
      }
    };
    const byConversation = new Map<
      string,
      Array<{ task: Task; monitor: MonitorDescription; items: JsonObject[]; last: number }>
    >();
    for (const { watcher, task } of watching) {
      const monitor = monitorOf(task);
      if (!monitor) continue;
      const cursor = Math.max(watcher.cursor ?? 0, written.get(task.id) ?? 0);
      // 上次没写进去的游标，这次再试着写
      if (cursor > (watcher.cursor ?? 0)) advance(task.id, cursor);
      const pending = feeds.itemsAfter(sourceId, cursor);
      if (pending.length === 0) continue;
      const last = pending.at(-1)!.id;
      const items = pending.flatMap(({ key, data, truncated }) => {
        const value = latest.get(key) ?? storedData(data, truncated);
        return value && matches(value, monitor.where) ? [value] : [];
      });
      if (items.length === 0) {
        advance(task.id, last);
        continue;
      }
      const list = byConversation.get(task.conversationId) ?? [];
      list.push({ task, monitor, items, last });
      byConversation.set(task.conversationId, list);
    }

    for (const [conversationId, entries] of byConversation) {
      if (!(await host.accepts(conversationId))) {
        for (const { task } of entries) await host.cancel(task);
        continue;
      }
      let fromSeq: number | undefined;
      const replies: DueTask[] = [];
      for (const { task, monitor, items, last } of entries) {
        const event = await host.writeEvent(task, {
          event: { type: 'monitor', taskId: task.id },
          text: monitorEventText(task.action, `t${task.id}`, items, monitor),
        });
        // 没写进去：游标不动，下一次查完再试
        if (!event) continue;
        fromSeq ??= event.seq;
        advance(task.id, last);
        logger.info({ taskId: task.id, conversationId, items: items.length }, 'monitor.due');
        try {
          const updated = await host.update(task, {
            lastDueAt: now.toISOString(),
            dueCount: task.dueCount + 1,
          });
          if (known.has(task.id)) known.set(task.id, updated);
        } catch (error) {
          logger.error(
            { taskId: task.id, conversationId, error: describeError(error) },
            'task.update_failed',
          );
        }
        if (monitor.mode !== 'record') replies.push(dueTask(task, 'monitor'));
      }
      if (replies.length > 0) await host.deliver(conversationId, replies, fromSeq);
    }
    if (cursorError !== undefined) throw cursorError;
  }

  /** 交给前端的一个任务：标出是监听任务的哪种事件（查到了新的、查不到） */
  function dueTask(task: Task, event: 'monitor' | 'monitor-failed'): DueTask {
    const { platformMessageId } = task.source;
    return {
      id: task.id,
      action: task.action,
      ...(platformMessageId === undefined ? {} : { platformMessageId }),
      event,
    };
  }

  /** 连续查不到满 6 小时：盯着这个来源的每个任务，在它的会话里说一次（触发回复，不管 mode） */
  async function reportFailure(sourceId: number, now: Date): Promise<void> {
    const failure = feeds.source(sourceId)?.failure;
    if (!failure || failure.reported) return;
    if (now.getTime() - Date.parse(failure.since) < failureReportMs) return;
    const byConversation = new Map<string, Task[]>();
    for (const { task } of watchersOf(sourceId)) {
      byConversation.set(task.conversationId, [
        ...(byConversation.get(task.conversationId) ?? []),
        task,
      ]);
    }
    for (const [conversationId, tasks] of byConversation) {
      if (!(await host.accepts(conversationId))) {
        for (const task of tasks) await host.cancel(task);
        continue;
      }
      let fromSeq: number | undefined;
      const replies: DueTask[] = [];
      for (const task of tasks) {
        const written = await host.writeEvent(task, {
          event: { type: 'monitor-failed', taskId: task.id },
          text: monitorFailedText(task.action, `t${task.id}`, {
            since: new Date(failure.since),
            text: failure.text,
          }),
        });
        if (!written) continue;
        fromSeq ??= written.seq;
        logger.info(
          { taskId: task.id, conversationId, source: sourceId },
          'monitor.failed_reported',
        );
        replies.push(dueTask(task, 'monitor-failed'));
      }
      if (replies.length > 0) await host.deliver(conversationId, replies, fromSeq);
    }
    feeds.markReported(sourceId);
  }

  /**
   * 对账（启动时，在那一串里）：进行中的监听任务都要有「谁在盯」的记录，没有的补上（游标空着：
   * 下一次查到的只存不到点）；盯的来源和描述对不上的换过去；任务已经不在进行中的去掉记录。
   * 然后照游标补：游标后面还有符合条件的条目，照常到点一次
   */
  async function reconcile(tasks: readonly Task[]): Promise<void> {
    const at = clock.now().toISOString();
    known.clear();
    for (const task of tasks) if (monitorOf(task)) known.set(task.id, task);
    for (const watcher of feeds.watchers()) {
      if (known.has(watcher.taskId)) continue;
      feeds.unwatch(watcher.taskId);
      logger.info({ taskId: watcher.taskId, source: watcher.sourceId }, 'monitor.unwatched');
    }
    for (const task of known.values()) {
      const source = feeds.ensureSource(sourceSpec(monitorOf(task)!), at);
      const watcher = feeds.watcher(task.id);
      if (watcher?.sourceId === source.id) continue;
      feeds.watch(task.id, source.id, undefined, at);
      logger.info({ taskId: task.id, source: source.id }, 'monitor.rewatched');
    }
    const now = clock.now();
    for (const sourceId of watchedSources()) {
      try {
        reschedule(sourceId);
        // 上次因为服务没装上查不到、这次装上了：排好的下次检查还没到的，挪到现在马上查（别的失败照旧等）。
        // 已经过了时间的不挪：它本来就马上查，而且算晚了（再失败时这一轮从这一次重新算）
        const source = feeds.source(sourceId);
        if (
          source?.failure?.kind === 'unavailable' &&
          layer.services.some(({ name }) => name === source.service) &&
          (!source.nextCheckAt || Date.parse(source.nextCheckAt) > now.getTime())
        ) {
          feeds.setNextCheck(sourceId, now.toISOString());
        }
        const ready = watchersOf(sourceId).filter(({ watcher }) => watcher.cursor !== undefined);
        await deliverNew(sourceId, ready, new Map(), now);
      } catch (error) {
        // 补不了的下一次查完再补（游标没动）
        failed(sourceId, 'start', error);
      }
    }
  }

  async function settle(): Promise<void> {
    while (checks.size > 0) await Promise.allSettled([...checks]);
  }

  return {
    /**
     * 开始：对账，然后照常查（tasks 是任务表里进行中的任务）。在那一串里调用
     */
    async start(tasks: readonly Task[]): Promise<void> {
      if (started || stopped) return;
      started = true;
      try {
        await reconcile(tasks);
      } catch (error) {
        failed(undefined, 'start', error);
      }
      tickSafely();
      rearmSafely();
    },

    /**
     * 开始盯一个任务（建监听任务；改了来源时也是它）：这次查到的条目存进动态、算已有的（不到点），
     * 也算这个来源查过一次（成功）；游标指到最后一条。在那一串里调用
     */
    watch(task: Task, items: readonly MonitorItem[]): void {
      const monitor = monitorOf(task);
      if (!monitor) return;
      known.set(task.id, task);
      written.delete(task.id);
      // 任务已经存好了：这里出错只记日志（重启时对账补上「谁在盯」）
      try {
        const now = clock.now();
        const at = now.toISOString();
        const before = feeds.watcher(task.id);
        const source = feeds.ensureSource(sourceSpec(monitor), at);
        feeds.storeItems(
          source.id,
          items.map(({ key, data }) => ({ key, data: stringifyJson(data) })),
          at,
        );
        feeds.recordSuccess(source.id, at);
        feeds.watch(task.id, source.id, feeds.lastItemId(source.id), at);
        reschedule(source.id, now.getTime());
        if (before && before.sourceId !== source.id) reschedule(before.sourceId, now.getTime());
      } catch (error) {
        failed(undefined, 'watch', error);
      }
      rearmSafely();
    },

    /** 任务改了（间隔、条件、做什么……，来源没变）：马上生效。在那一串里调用；出错只记日志 */
    changed(task: Task): void {
      if (!known.has(task.id) || !monitorOf(task)) return;
      known.set(task.id, task);
      try {
        const watcher = feeds.watcher(task.id);
        if (watcher) reschedule(watcher.sourceId, clock.now().getTime());
      } catch (error) {
        failed(undefined, 'changed', error);
      }
      rearmSafely();
    },

    /** 不再盯（取消了）：没有任务盯着的来源不再查。在那一串里调用；出错只记日志 */
    unwatch(taskId: number): void {
      known.delete(taskId);
      written.delete(taskId);
      try {
        const watcher = feeds.watcher(taskId);
        if (!watcher) return;
        feeds.unwatch(taskId);
        reschedule(watcher.sourceId, clock.now().getTime());
      } catch (error) {
        failed(undefined, 'unwatch', error);
      }
      rearmSafely();
    },

    /** 一个监听任务的检查状态；没在盯、读不了时没有 */
    status(taskId: number): MonitorStatus | undefined {
      try {
        const watcher = feeds.watcher(taskId);
        const source = watcher && feeds.source(watcher.sourceId);
        if (!source) return undefined;
        return {
          ...(source.lastCheckedAt ? { lastCheckedAt: source.lastCheckedAt } : {}),
          ...(source.lastSuccessAt ? { lastSuccessAt: source.lastSuccessAt } : {}),
          ...(source.failure
            ? { failing: { since: source.failure.since, reason: source.failure.text } }
            : {}),
        };
      } catch (error) {
        failed(undefined, 'status', error);
        return undefined;
      }
    },

    /** 退出：停掉定时器，中止进行中的请求，等它们收尾 */
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      controller.abort();
      await settle();
    },

    /** 正在查的都做完（测试用） */
    settled: settle,

    /** 有正在查的 */
    busy: () => checks.size > 0,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
