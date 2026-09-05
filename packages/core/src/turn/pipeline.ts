import { ulid } from "ulid";
import type { Role, RuntimeTurnContext } from "@luoli/shared";
import type {
  AppendedMessage,
  ArchivedMessage,
  TurnRepository,
} from "@luoli/db";
import type { Config } from "../config/schema.js";
import type { ContextEngine } from "../context/engine.js";
import type { LogSink } from "../log/sink.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import type { MemoryStore } from "../memory/store.js";
import { TELEGRAM_SOURCE_ID } from "../memory/scope.js";
import type { AgentKind } from "../tools/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { TurnFailureStreak } from "../alerts.js";
import type { TurnConcurrency } from "./concurrency.js";
import type { TurnRegistry } from "./registry.js";

/**
 * 轮次管线的唯一实现（`docs/12-sdk.md` §14.1 Q-A，`docs/02` §10.6）。
 *
 * 此前「配额预留 → 并发闸 → openTurn → turns.create → 产出 → appendDelta → commitTurn」这一段
 * 逻辑在 `packages/telegram/src/bot.ts` 与 `packages/core/src/schedule/runner.ts` 中各写一份，
 * 四条不变量（并发槽释放、配额释放、`abortTurn` 抛出后仍 `turns.finish`、`appendDelta`/
 * `commitTurn` 排在投递或静默分支的合流点之后）因此各维护两处，`R-BOT-01`（槽位泄漏）即由此产生。
 * 本函数抽出这一段，调用方（`schedule/runner.ts`、后续 SDK）只负责触发前的判定
 * （角色重算、配额是否需要预留、合成消息如何归档、投递通道是否可用）与产出/投递本身。
 *
 * 三处回调注入，其余步骤（并发获取/释放、`openTurn`/`turns.create`、通用日志、清理）由本函数
 * 自己完成，调用方不得也不需要重复实现：
 * - `buildTrigger()`：本轮触发消息如何归档、合成 id 如何分配与核对，完全是调用方的事
 *   （`docs/02` §10.2）。抛出与 `openTurn`/`turns.create` 抛出走同一条失败路径（`stage:'setup'`）。
 * - `produce()`：模型侧产出（或直接返回预写正文）。返回值统一 `.trim()` 后做空正文检查——
 *   空则 `model_returned_empty`，这道闸不为静默开例外（`docs/02` §10.5 第 ④ 条）。
 * - `deliver()`（可选）：投递失败以 `{ok:false, error}` 表达，统一转成 `delivery_failed:<error>`
 *   走失败路径；省略等价于「没有旁路投递动作」，调用方从返回值的 `answer` 自行处理。
 *   `turn.silenced === true` 时整体跳过，不算失败。
 *
 * `onQueued` 与 `turn.queued` 日志是两件事：前者在进入排队的那一刻（`acquire()` 之前，
 * 此时还没有 `turnId`）触发一次，只带 `{active, queued}`，供 T3.8 的 SSE `queued` 事件使用——
 * 排队时长可能长达数秒，事件必须在排队开始时就发给客户端；后者仍在 `openTurn` 成功之后记录
 * （需要 `turnId` 与 `waitedMs`），供事后排障使用。
 *
 * 不引入进程内状态（`docs/01` §3.1）：`reservation` 由调用方计算并传入，本函数只负责在恰当的
 * 时机释放它。
 */
export interface RunTurnDependencies {
  context: ContextEngine;
  turns: TurnRepository;
  registry: TurnRegistry;
  concurrency: TurnConcurrency;
  quota: QuotaGuard;
  tools: ToolRegistry;
  memory: MemoryStore;
  log: LogSink;
  approvals?: { releaseTurn(turnId: string): void };
  plugins?: { hook(name: string, payload: unknown): Promise<unknown> };
  /** 连续失败计数。调用方与 Telegram 轮次共用同一份时传入，否则省略（`docs/02` §10.1）。 */
  failures?: TurnFailureStreak;
}

export interface RunTurnInput {
  dependencies: RunTurnDependencies;
  chatId: string;
  threadId: number | null;
  key: string;
  initiatorUserId: string;
  effectiveRole: Role;
  isPrivate: boolean;
  chatTitle?: string;
  quoted?: ArchivedMessage;
  /** 只有允许静默的定时轮次会传入 `true`（`docs/02` §10.5 第 ②条，fail-closed）。 */
  silenceable?: boolean;
  config: Readonly<Config>;
  /** `TurnRegistry.register` 的超时——两次 register（排队态、已开轮态）共用同一个值。 */
  turnTimeoutMs: number;
  /** 落 `turns.trigger_reason`，并进入 `turn.start` 日志的 `data.triggerReason`。 */
  triggerReason: string;
  /** 由调用方计算并预留；本函数只负责在每条退出路径上释放它。 */
  reservation: QuotaReservation | null;
  /** 缺省 `'main'`；透传给 `produce()`，本函数自身不据此改变行为。 */
  agentKind?: AgentKind;
  /** 缺省 telegram（下游按 `?? TELEGRAM_SOURCE_ID` 兜底）；提供时写回 `turn.sourceId`。 */
  sourceId?: string;
  /** 额外并入 `turn.end` / `ctx.abort` 日志 `data` 的字段（如 schedule 侧的 `{schedule: job.id}`）。 */
  logExtra?: Record<string, unknown>;
  buildTrigger(): AppendedMessage | Promise<AppendedMessage>;
  produce(
    turn: RuntimeTurnContext,
    reservation: QuotaReservation | null,
    meta: { agentKind: AgentKind; sourceId: string },
  ): Promise<string>;
  deliver?(
    turn: RuntimeTurnContext,
    answer: string,
  ): Promise<{ ok?: boolean; error?: string } | void>;
  /**
   * 排队时触发一次（`acquire()` 之前），供流式协议发 `queued` 事件；与 `turn.queued` 日志无关。
   * 判据是 `!concurrency.available(key)`，即「这一轮不会立即拿到槽位」——`acquire()` 本身
   * 尚未调用，因此无法区分「会排队等待」与「队列已满、即将被拒」：`queueMax` 配得很小的部署里，
   * 触发后紧跟着 `stage:'queue'` 失败是预期行为，不是缺陷。
   */
  onQueued?(info: { active: number; queued: number }): void;
  /**
   * `TurnRegistry.register` 的排队态 id 一经分配即触发一次（`acquire()` 之前，早于 `onQueued`）。
   * 供需要支持「排队阶段取消」的调用方（SDK 的客户端断连处理，docs/12-sdk.md T3.6/T3.7）记下这个 id：
   * 排队期间没有 `turnId` 可用，`registry.cancel(pendingId, ...)` 是此时唯一能触发
   * `pending.controller.signal` 中止、进而让 `concurrency.acquire()` 以 `turn_queue_cancelled`
   * 拒绝的入口。`onOpened` 触发后应改用其 `turn.turnId`——`pendingId` 在那之后已经
   * `registry.finish()`，继续用它取消不再有效。
   */
  onPending?(pendingId: string): void;
  /** `openTurn`/`turns.create` 成功后、产出开始前触发一次（如 schedule 侧的 `schedule.fired`）。
   *  抛出会被视为本轮失败（`abortTurn` → `turns.finish` → 清理），不会绕过任何一条不变量。 */
  onOpened?(turn: RuntimeTurnContext): void;
}

export interface RunTurnSuccess {
  ok: true;
  turn: RuntimeTurnContext;
  answer: string;
  commitId: string;
  rebased: boolean;
  silenced: boolean;
}
export interface RunTurnQueueRejected {
  ok: false;
  stage: "queue";
  code: "turn_queue_full" | "turn_queue_cancelled";
  error: string;
}
export interface RunTurnSetupFailed {
  ok: false;
  stage: "setup";
  error: string;
}
export interface RunTurnFailed {
  ok: false;
  stage: "turn";
  turn: RuntimeTurnContext;
  code: "cancelled" | "failed";
  timedOut: boolean;
  error: string;
}
export type RunTurnResult =
  | RunTurnSuccess
  | RunTurnQueueRejected
  | RunTurnSetupFailed
  | RunTurnFailed;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    context,
    turns,
    registry,
    concurrency,
    quota,
    tools,
    memory,
    log,
    approvals,
    plugins,
    failures,
  } = input.dependencies;

  const pendingId = ulid();
  const pending = registry.register(
    {
      id: pendingId,
      key: input.key,
      chatId: input.chatId,
      userId: input.initiatorUserId,
      role: input.effectiveRole,
    },
    input.turnTimeoutMs,
  );
  input.onPending?.(pendingId);
  // 与两个既有开轮入口使用同一判据（`docs/10` §2 · L-LOG-01）：只有确实排队时才记录，
  // `turn.start` 一律携带 `waitedMs`。
  const queuedAt = Date.now();
  const wasQueued = !concurrency.available(input.key);
  const queueSnapshot = { active: concurrency.active, queued: concurrency.queued };

  let release: (() => void) | null = null;
  try {
    // 在排队判定已知、`acquire()` 尚未返回之前触发：排队可能长达数秒，流式协议的 `queued`
    // 事件必须在这一刻就发给客户端，等 `turnId` 产生（`acquire()` 返回之后）再发已无意义。
    if (wasQueued) input.onQueued?.(queueSnapshot);
    release = await concurrency.acquire(input.key, pending.controller.signal);
  } catch (error) {
    registry.finish(pendingId);
    if (input.reservation) quota.release(input.reservation);
    const message = errorMessage(error);
    return {
      ok: false,
      stage: "queue",
      code: message === "turn_queue_full" ? "turn_queue_full" : "turn_queue_cancelled",
      error: message,
    };
  }

  // openTurn 之后到这里之间的任何一行都可能抛出（非法时区、形状异常的快照、DB 约束、调用方的
  // `buildTrigger` 本身）。置于 try 之外会永久泄漏并发槽与配额预留（`docs/19` · R-BOT-01）。
  let turn: RuntimeTurnContext;
  // 若 `openTurn` 成功但随后 `turns.create` 抛出，`turn.turnId` 已经注册进 `TurnRegistry`——
  // 只记它的 id（而不是在 catch 里引用可能未完全初始化的 `turn`），失败时一并释放，
  // 否则这条记录会与排队阶段的 `pendingId` 一起被处理，唯独它自己永久卡在注册表里。
  let trackedId: string | null = null;
  try {
    const trigger = await input.buildTrigger();
    turn = await context.openTurn({
      chatId: input.chatId,
      threadId: input.threadId,
      key: input.key,
      initiatorUserId: input.initiatorUserId,
      effectiveRole: input.effectiveRole,
      isPrivate: input.isPrivate,
      trigger,
      ...(input.chatTitle ? { chatTitle: input.chatTitle } : {}),
      ...(input.quoted ? { quoted: input.quoted } : {}),
      ...(input.silenceable ? { silenceable: true } : {}),
      abortSignal: pending.controller.signal,
      config: input.config,
    });
    if (input.sourceId) Object.assign(turn, { sourceId: input.sourceId });
    registry.finish(pendingId);
    const tracked = registry.register(
      {
        id: turn.turnId,
        key: input.key,
        chatId: input.chatId,
        userId: input.initiatorUserId,
        role: input.effectiveRole,
      },
      input.turnTimeoutMs,
    );
    trackedId = tracked.id;
    Object.assign(turn, { abortSignal: tracked.controller.signal });
    turns.create({
      id: turn.turnId,
      key: input.key,
      chatId: input.chatId,
      threadId: input.threadId,
      userId: input.initiatorUserId,
      role: input.effectiveRole,
      triggerMessageId: trigger.id,
      triggerReason: input.triggerReason,
      baseCommitId: turn.baseCommitId,
    });
  } catch (error) {
    registry.finish(pendingId);
    if (trackedId) registry.finish(trackedId);
    release();
    if (input.reservation) quota.release(input.reservation);
    return { ok: false, stage: "setup", error: errorMessage(error) };
  }

  const waitedMs = Date.now() - queuedAt;
  if (wasQueued)
    log.event({
      level: "info",
      kind: "turn.queued",
      summary: `Turn ${turn.turnId} waited ${waitedMs}ms in queue`,
      traceId: turn.turnId,
      ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
      chatId: input.chatId,
      userId: input.initiatorUserId,
      key: input.key,
      durationMs: waitedMs,
      data: { active: queueSnapshot.active, queued: queueSnapshot.queued, waitedMs },
    });
  log.event({
    level: "info",
    kind: "turn.start",
    summary: `Turn ${turn.turnId} started`,
    traceId: turn.turnId,
    ...(turn.rootSpanId ? { spanId: turn.rootSpanId } : {}),
    chatId: input.chatId,
    userId: input.initiatorUserId,
    key: input.key,
    data: { role: input.effectiveRole, triggerReason: input.triggerReason, waitedMs },
  });
  log.publish("turn.started", {
    turnId: turn.turnId,
    key: input.key,
    chatId: input.chatId,
    user: input.initiatorUserId,
    role: input.effectiveRole,
    triggerReason: input.triggerReason,
    at: Date.now(),
  });

  try {
    // 抛出与产出/投递/提交失败走同一条路径（abortTurn → turns.finish → 清理），不绕过任何
    // 一条不变量——调用方若在这里出错（例如 schedule 侧的 `schedule.fired` 日志写入失败），
    // 本轮仍会被正确记为失败并释放全部资源。
    input.onOpened?.(turn);
    const answer = (
      await input.produce(turn, input.reservation, {
        agentKind: input.agentKind ?? "main",
        sourceId: input.sourceId ?? TELEGRAM_SOURCE_ID,
      })
    ).trim();
    // 空正文视为失败：无法投递，且会在上下文中留下一条无法解释的空消息（`docs/16` §5
    // 「摘除比伪造安全」）。这道闸不为静默开例外——静默加空正文等于本轮在上下文中一个字都不留，
    // 而让下一轮知晓本轮执行过正是静默机制的全部目的（`docs/02` §10.5 第 ④ 条）。
    if (!answer) throw new Error("model_returned_empty");
    const silenced = turn.silenced === true;
    if (!silenced) {
      const sent = input.deliver ? await input.deliver(turn, answer) : undefined;
      if (sent && sent.ok === false)
        throw new Error(`delivery_failed:${sent.error ?? "unknown"}`);
    }
    // 两条路径（投递、静默）在此合流，`appendDelta` / `commitTurn` 必须位于合流点之后
    // （`docs/02` §10.1）：提前分支会让静默与投递分别对应不同的上下文写入结果。
    context.appendDelta(turn, {
      id: turn.turnId,
      role: "assistant",
      origin: "assistant",
      parts: [{ type: "text", text: answer }],
      textPreview: answer.slice(0, 240),
      pruneLevel: 0,
    });
    const committed = await context.commitTurn(turn);
    const settled = turns.finish(turn.turnId, {
      state: "committed",
      commitId: committed.commit.id,
      rebased: committed.rebased,
    });
    await plugins?.hook("afterCommit", { turn, committed });
    // `silenced` 写入 `data`：否则完整 trace 中会缺少投递这一跳，读取者无从解释。
    log.event({
      level: "info",
      kind: "turn.end",
      summary: "turn committed",
      traceId: turn.turnId,
      ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
      chatId: input.chatId,
      userId: input.initiatorUserId,
      key: input.key,
      data: {
        state: "committed",
        rebased: committed.rebased,
        waitedMs,
        ...(input.logExtra ?? {}),
        ...(silenced ? { silenced: true } : {}),
      },
    });
    log.publish("turn.finished", {
      turnId: turn.turnId,
      key: input.key,
      chatId: input.chatId,
      state: "committed",
      steps: settled?.steps ?? 0,
      toolCalls: settled?.toolCalls ?? 0,
      costUsd: settled?.costUsd ?? 0,
      rebased: committed.rebased,
      durationMs: settled?.durationMs ?? 0,
    });
    // 工具已实际执行且结果已进入已提交的上下文：记忆写入随提交一并落库。
    memory.flush(turn.turnId);
    failures?.succeeded();
    return {
      ok: true,
      turn,
      answer,
      commitId: committed.commit.id,
      rebased: committed.rebased,
      silenced,
    };
  } catch (error) {
    // 超时不等于取消（`docs/04` §5.3 的三档）。`abortTurn` 自身抛出会使下方的 `turns.finish`
    // 不执行——清理是尽力而为，状态记录不是。
    const timedOut = turn.abortSignal.reason === "timeout";
    const cancelled = turn.abortSignal.aborted && !timedOut;
    try {
      await context.abortTurn(turn, cancelled ? "cancelled" : "failed", error);
    } catch (cleanup) {
      log.event({
        level: "error",
        kind: "ctx.abort",
        summary: "abortTurn failed; turn still recorded as ended",
        traceId: turn.turnId,
        chatId: input.chatId,
        key: input.key,
        data: { error: errorMessage(cleanup), ...(input.logExtra ?? {}) },
      });
    }
    const settled = turns.finish(
      turn.turnId,
      cancelled
        ? {
            state: "cancelled",
            cancelReason: String(turn.abortSignal.reason ?? "cancelled"),
          }
        : {
            state: "failed",
            error: timedOut ? "turn_timeout" : errorMessage(error),
            ...(timedOut ? { cancelReason: "timeout" } : {}),
          },
    );
    log.event({
      level: cancelled ? "warn" : "error",
      kind: "turn.end",
      summary: cancelled
        ? "turn cancelled"
        : timedOut
          ? "turn timed out"
          : errorMessage(error),
      traceId: turn.turnId,
      ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
      chatId: input.chatId,
      userId: input.initiatorUserId,
      key: input.key,
      data: {
        state: cancelled ? "cancelled" : "failed",
        waitedMs,
        ...(input.logExtra ?? {}),
      },
    });
    log.publish("turn.finished", {
      turnId: turn.turnId,
      key: input.key,
      chatId: input.chatId,
      state: cancelled ? "cancelled" : "failed",
      steps: settled?.steps ?? 0,
      toolCalls: settled?.toolCalls ?? 0,
      costUsd: settled?.costUsd ?? 0,
      rebased: false,
      durationMs: settled?.durationMs ?? 0,
    });
    // 取消不计为故障，超时计入（`docs/04` §5.3 的三档）——上游无响应导致每次触发都超时，
    // 正是该告警最需要覆盖的场景。
    if (!cancelled)
      failures?.failed(timedOut ? "turn_timeout" : errorMessage(error));
    return {
      ok: false,
      stage: "turn",
      turn,
      code: cancelled ? "cancelled" : "failed",
      timedOut,
      error: errorMessage(error),
    };
  } finally {
    tools.releaseTurn(turn.turnId);
    approvals?.releaseTurn(turn.turnId);
    memory.discard(turn.turnId);
    registry.finish(turn.turnId);
    release();
    if (input.reservation) quota.release(input.reservation);
  }
}
