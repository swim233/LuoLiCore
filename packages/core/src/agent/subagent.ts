import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import type { ToolSet } from 'ai';
import type { Sqlite } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';
import type { AgentDefinition, AgentManager, AgentRun } from './manager.js';
import { type ModelRegistry, aliasModel } from './runtime.js';
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
  /** 缺省时退回裸模型（无重试、无 fallback）—— 调用方应当传，主 agent 路径已经传了。 */
  provider?: { maxRetries: number; retryBaseMs: number; retryMaxMs: number };
  quota?: QuotaGuard;
  reservation?: QuotaReservation | null;
  onEvent?: (event: SubAgentRuntimeEvent) => void | Promise<void>;
}

export async function runSubAgent(run: AgentRun, definition: AgentDefinition, task: string, context: string | undefined, turn: RuntimeTurnContext, dependencies: SubAgentDependencies, modelAlias?: string): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const alias = modelAlias ?? definition.modelAlias;
  // 与主 agent 同一套包装：直接 resolve() 拿到的是裸模型，重试与 fallback 链一次都不会走。
  const model = dependencies.provider
    ? aliasModel(dependencies.registry, alias, { maxRetries: dependencies.provider.maxRetries, retryBaseMs: dependencies.provider.retryBaseMs, retryMaxMs: dependencies.provider.retryMaxMs, abortSignal: turn.abortSignal,
      onFallback: (from, to) => dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${from.id} → ${to.id}`, traceId: turn.turnId, data: { alias, agentRunId: run.id, from: from.id, to: to.id } }),
      onUnavailable: (candidate, error) => dependencies.registry.markProviderDown(candidate.id, error instanceof Error ? error.message : 'authentication_failed'),
      onExhausted: (error) => dependencies.log.event({ level: 'error', kind: 'model.error', summary: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300), traceId: turn.turnId, data: { alias, agentRunId: run.id } }) })
    : dependencies.registry.resolve(alias);
  const toolContext: ToolExecutionContext = { turn, workspace: dependencies.workspace, agentKind: 'sub', agentRunId: run.id };
  const toolSet: ToolSet = {};
  for (const registered of dependencies.tools.active(run.effectiveRole, toolContext, definition.tools)) {
    toolSet[registered.name] = tool({ description: registered.description, inputSchema: registered.inputSchema, execute: (input) => dependencies.tools.execute(registered.name, input, toolContext) });
  }
  let stepNumber = 0;
  const agent = new ToolLoopAgent({ model, ...dependencies.registry.settings(alias), instructions: definition.instructions, tools: toolSet, activeTools: Object.keys(toolSet), stopWhen: stepCountIs(definition.maxSteps),
    onStepEnd: async (step) => {
      const currentStep = ++stepNumber;
      await dependencies.onEvent?.({ type: 'step', step: currentStep, finishReason: step.finishReason, text: step.text,
        toolCalls: step.toolCalls as unknown[], toolResults: step.toolResults as unknown[] });
      const info = dependencies.registry.infoByModelId(step.model.modelId) ?? dependencies.registry.info(alias);
      if (!info) return;
      const cost = dependencies.ledger.record({ turnId: turn.turnId, agentRunId: run.id, chatId: turn.chatId, userId: turn.initiatorUserId,
        providerId: info.providerId, modelId: info.modelId, modelAlias: alias, inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0, cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0, reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0,
        priceIn: info.priceIn, priceOut: info.priceOut, priceCacheRead: info.priceCacheRead, priceCacheWrite: info.priceCacheWrite,
        latencyMs: step.performance.responseTimeMs, finishReason: step.finishReason, ok: true });
      // 只 record 不 commit 的话，用量报表看得见这笔花费、配额却拦不住它：日/月计数器只在
      // commit() 里递增，一轮十个子 agent 可以在账本上「免费」跑掉（docs/20 · W-QUOTA-01）。
      if (dependencies.quota && dependencies.reservation) dependencies.quota.commit(dependencies.reservation, cost);
      dependencies.db.prepare('UPDATE agent_runs SET steps=steps+1,input_tokens=input_tokens+?,output_tokens=output_tokens+?,cost_usd=cost_usd+? WHERE id=?')
        .run(step.usage.inputTokens ?? 0, step.usage.outputTokens ?? 0, cost, run.id);
      await dependencies.onEvent?.({ type: 'usage', step: currentStep, inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0, costUsd: cost });
    },
  });
  const content = context ? `${task}\n\n---\n参考资料:\n${context}` : task;
  try {
    const result = await agent.generate({ messages: [{ role: 'user', content }], abortSignal: turn.abortSignal });
    return dependencies.agents.finish(run, result.text);
  } catch (error) {
    dependencies.agents.fail(run, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
