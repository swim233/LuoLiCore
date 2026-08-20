import { ToolLoopAgent, stepCountIs } from 'ai';
import { ulid } from 'ulid';
import type { Sqlite } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';
import type { AgentDefinition, AgentManager, AgentRun } from './manager.js';
import { type ModelRegistry, aliasModel, toolSetFor } from './runtime.js';
import { PROVIDER_FAILURES_TO_DOWN } from '../provider/health.js';
import { SUBAGENT_KERNEL } from '../prompt/assembler.js';
import type { QuotaGuard, QuotaReservation } from '../ledger/quota.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/registry.js';
import type { UsageLedger } from '../ledger/usage.js';
import type { LogSink } from '../log/sink.js';
export type SubAgentRuntimeEvent =
  | { type: 'step'; step: number; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }
  | { type: 'usage'; step: number; inputTokens: number; outputTokens: number; costUsd: number };


export interface SubAgentDependencies {
  db: Sqlite;
  agents: AgentManager;
  registry: ModelRegistry;
  tools: ToolRegistry;
  ledger: UsageLedger;
  log: LogSink;
  workspace: string;
  /** 缺省时退回裸模型（无重试、无 fallback、无上游超时）—— 调用方应当传，主 agent 路径已经传了。 */
  provider?: { maxRetries: number; retryBaseMs: number; retryMaxMs: number; requestTimeoutMs?: number; streamIdleTimeoutMs?: number };
  quota?: QuotaGuard;
  reservation?: QuotaReservation | null;
  onEvent?: (event: SubAgentRuntimeEvent) => void | Promise<void>;
  /**
   * 派发它的那次 `tool.call` 的 span id（`spawn_agent` 从 `ToolExecutionContext.parentSpanId` 拿）。
   * `docs/10 §7` 第 4 条：「子 agent 的 span 挂在派发它的 `tool.call` 之下」。
   * 缺省（试跑、直接调用）时 `agent.run` 就是本 trace 的一个根。
   */
  parentSpanId?: string;
}

export async function runSubAgent(run: AgentRun, definition: AgentDefinition, task: string, context: string | undefined, turn: RuntimeTurnContext, dependencies: SubAgentDependencies, modelAlias?: string): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const alias = modelAlias ?? definition.modelAlias;
  // 与主 agent 同一套包装：直接 resolve() 拿到的是裸模型，重试与 fallback 链一次都不会走。
  const model = dependencies.provider
    ? aliasModel(dependencies.registry, alias, { maxRetries: dependencies.provider.maxRetries, retryBaseMs: dependencies.provider.retryBaseMs, retryMaxMs: dependencies.provider.retryMaxMs, abortSignal: turn.abortSignal,
      ...(dependencies.provider.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: dependencies.provider.requestTimeoutMs }),
      ...(dependencies.provider.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: dependencies.provider.streamIdleTimeoutMs }),
      isDown: (candidate) => dependencies.registry.isDown(candidate),
      onServed: (served) => dependencies.registry.recordSuccess(served),
      onSkipped: (candidate, next) => dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${candidate.id} 已判 down，跳过${next ? ` → ${next.id}` : ''}`,
        traceId: turn.turnId, data: { alias, agentRunId: run.id, from: candidate.id, to: next?.id ?? null, reason: 'skipped_down' } }),
      onFallback: (from, to) => dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${from.id} 试完仍失败，换 ${to.id}`,
        traceId: turn.turnId, data: { alias, agentRunId: run.id, from: from.id, to: to.id, reason: 'candidate_exhausted' } }),
      // 与主 agent 同一条：每次失败落一行、只有超时计入连续失败、一次调用一个候选只记一次
      // （`docs/04 §5.3`）。子 agent 走的是同一批 provider，漏在这里等于「主轮不再卡了，
      // researcher 还在每一步熬满超时」；而按尝试记又会让一次慢调用（子 agent 全走非流式）判死它。
      onCandidateFailed: (candidate, failure) => {
        dependencies.log.event({ level: 'warn', kind: 'model.error',
          summary: `${candidate.id} 第 ${failure.attempt + 1} 次尝试失败：${failure.error instanceof Error ? failure.error.message : String(failure.error)}`.slice(0, 300),
          traceId: turn.turnId, data: { alias, agentRunId: run.id, modelId: candidate.id, errorKind: failure.kind, status: failure.status, retryAttempt: failure.attempt, willRetry: failure.willRetry, willFallback: failure.willFallback, ms: failure.elapsedMs } });
        if (failure.kind === 'timeout' && !failure.willRetry) dependencies.registry.recordFailure(candidate, failure.error instanceof Error ? failure.error.message : String(failure.error), PROVIDER_FAILURES_TO_DOWN);
      },
      onUnavailable: (candidate, error) => dependencies.registry.markProviderDown(candidate.id, error instanceof Error ? error.message : 'authentication_failed'),
      onExhausted: (error) => dependencies.log.event({ level: 'error', kind: 'model.error', summary: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300), traceId: turn.turnId, data: { alias, agentRunId: run.id } }) })
    : dependencies.registry.resolve(alias);
  const allow = new Set(definition.tools);
  /**
   * `docs/10 §1` 的 span E：子 agent 那一整段的容器，它的 id 就是内部 `model.call` / `tool.call`
   * 的父。**span 只在结束时才落库**，所以派出去那一刻另记一条 `agent.spawn` —— 一个卡住的
   * 子 agent 否则在日志里完全不存在（docs/28 · L-LOG-01）。
   */
  const parent = dependencies.parentSpanId ? { parentSpanId: dependencies.parentSpanId } : {};
  dependencies.log.event({ level: 'info', kind: 'agent.spawn', summary: `${definition.name} (run ${run.id.slice(0, 8)})`, traceId: turn.turnId, ...parent,
    chatId: turn.chatId, userId: turn.initiatorUserId, key: turn.key,
    data: { runId: run.id, name: definition.name, depth: run.depth, modelAlias: alias, taskChars: task.length } });
  const runSpan = dependencies.log.span({ level: 'info', kind: 'agent.run', summary: `${definition.name} (run ${run.id.slice(0, 8)})`, traceId: turn.turnId, ...parent,
    chatId: turn.chatId, userId: turn.initiatorUserId, key: turn.key, data: { runId: run.id, name: definition.name, depth: run.depth, alias } });
  // 内部的工具调用挂在 `agent.run` 之下（`docs/10 §1` 里 `tool.call span G parent=E`）。
  const toolContext: ToolExecutionContext = { turn, workspace: dependencies.workspace, agentKind: 'sub', agentRunId: run.id, allow, parentSpanId: runSpan.id };
  // 与主 agent 共用 `toolSetFor`：`toModelOutput`（带图的工具结果）这类钩子加漏一处的表现是
  // 「主 agent 能看图、子 agent 不能」，而且要真跑一次带图的子 agent 才看得见。
  const toolSet = toolSetFor(dependencies.tools, dependencies.tools.active(run.effectiveRole, toolContext, definition.tools), toolContext);
  const perTurn = (turn.config as { quota: { perTurn: { maxSteps: number; maxCostUsd: number } } }).quota.perTurn;
  const maxSteps = Math.min(definition.maxSteps, perTurn.maxSteps);
  let stepNumber = 0;
  let spentUsd = 0;
  // 与主 agent 同理：重试归 fallbackLanguageModel，SDK 那层再叠一遍等于把一次故障的墙钟乘三。
  // 子 agent 此前只拿到 `definition.instructions`（配置里通常是一句话），既不知道
  // `<untrusted-content>` 的边界语义，也不知道工具报错该重试几次 —— 而它跑的是同一批工具、
  // 读的是同一批网页。`docs/06 §3.1` 的注入矩阵早写着这里该有 `KERNEL(精简)`。
  const instructions = `${SUBAGENT_KERNEL}\n\n${definition.instructions}`;
  const agent = new ToolLoopAgent({ model, ...dependencies.registry.settings(alias), maxRetries: 0, instructions, tools: toolSet, activeTools: Object.keys(toolSet), stopWhen: stepCountIs(maxSteps),
    prepareStep: async () => dependencies.ledger.turnCost(turn.turnId) >= perTurn.maxCostUsd ? { activeTools: [], toolChoice: 'none' as const } : {},
    onStepEnd: async (step) => {
      const currentStep = ++stepNumber;
      await dependencies.onEvent?.({ type: 'step', step: currentStep, finishReason: step.finishReason, text: step.text,
        toolCalls: step.toolCalls as unknown[], toolResults: step.toolResults as unknown[] });
      const info = dependencies.registry.infoByModelId(step.model.modelId) ?? dependencies.registry.info(alias);
      if (!info) return;
      const cost = dependencies.ledger.record({ turnId: turn.turnId, agentRunId: run.id, chatId: turn.chatId, userId: turn.initiatorUserId,
        providerId: info.providerId, modelId: info.modelId, modelAlias: alias, inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0, cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        // `inputTokens` 是 total（超集）；计价用这一份互斥的（`pricedInputTokens`，docs/10 §4.1）。
        noCacheTokens: step.usage.inputTokenDetails.noCacheTokens ?? undefined, reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0,
        priceIn: info.priceIn, priceOut: info.priceOut, priceCacheRead: info.priceCacheRead, priceCacheWrite: info.priceCacheWrite,
        latencyMs: step.performance.responseTimeMs, finishReason: step.finishReason, ok: true });
      // 只 record 不 commit 的话，用量报表看得见这笔花费、配额却拦不住它：日/月计数器只在
      // commit() 里递增，一轮十个子 agent 可以在账本上「免费」跑掉（docs/20 · W-QUOTA-01）。
      if (dependencies.quota && dependencies.reservation) dependencies.quota.commit(dependencies.reservation, cost);
      dependencies.db.prepare('UPDATE agent_runs SET steps=steps+1,input_tokens=input_tokens+?,output_tokens=output_tokens+?,cost_usd=cost_usd+? WHERE id=?')
        .run(step.usage.inputTokens ?? 0, step.usage.outputTokens ?? 0, cost, run.id);
      spentUsd += cost;
      // 子 agent 的模型调用此前**一条日志都没有**：只有 `usage_ledger` 里那一行，而
      // `docs/10 §1` 画着 `model.call span F parent=E`，`AC-LOG-001` 的期望链也点名它。
      // 用 event 而不是 span：这条路只有 `onStepEnd` 一个钩子，耗时取 SDK 报的 `responseTimeMs`。
      dependencies.log.event({ level: 'info', kind: 'model.call', summary: `${info.providerId}/${info.modelId}`, traceId: turn.turnId,
        spanId: ulid(), parentSpanId: runSpan.id, chatId: turn.chatId, userId: turn.initiatorUserId, key: turn.key, durationMs: step.performance.responseTimeMs,
        data: { agentRunId: run.id, stepNumber: currentStep, alias, servedProvider: info.providerId, servedModelId: info.modelId, usage: step.usage, cost, finishReason: step.finishReason } });
      dependencies.log.event({ level: 'debug', kind: 'agent.progress', summary: `${definition.name} step ${currentStep}/${maxSteps}`, traceId: turn.turnId,
        parentSpanId: runSpan.id, key: turn.key, data: { agentRunId: run.id, phase: 'step', done: currentStep, total: maxSteps } });
      await dependencies.onEvent?.({ type: 'usage', step: currentStep, inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0, costUsd: cost });
    },
  });
  const content = context ? `${task}\n\n---\n参考资料:\n${context}` : task;
  /** `agent.end` 与 `agent.run` 的收尾共用同一份数字，两条一起落 —— 缺一条树上就少一个端点。 */
  const settle = (ok: boolean, extra: Record<string, unknown>): void => {
    const payload = { runId: run.id, name: definition.name, steps: stepNumber, costUsd: spentUsd, ok, ...extra };
    runSpan.end(payload, undefined, ok ? undefined : { level: 'warn' });
    dependencies.log.event({ level: ok ? 'info' : 'warn', kind: 'agent.end', summary: `${definition.name} ${ok ? 'done' : 'failed'} · ${stepNumber} 步 · $${spentUsd.toFixed(4)}`,
      traceId: turn.turnId, parentSpanId: runSpan.id, chatId: turn.chatId, userId: turn.initiatorUserId, key: turn.key, data: payload });
  };
  try {
    const result = await agent.generate({ messages: [{ role: 'user', content }], abortSignal: turn.abortSignal });
    const finished = dependencies.agents.finish(run, result.text);
    settle(true, { summaryChars: finished.summary.length, truncated: finished.truncated });
    return finished;
  } catch (error) {
    dependencies.agents.fail(run, error instanceof Error ? error.message : String(error));
    settle(false, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    throw error;
  }
}
