import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import type { ToolSet } from 'ai';
import type { Sqlite } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';
import type { AgentDefinition, AgentManager, AgentRun } from './manager.js';
import type { ModelRegistry } from './runtime.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/registry.js';
import type { UsageLedger } from '../ledger/usage.js';
import type { LogSink } from '../log/sink.js';

export interface SubAgentDependencies {
  db: Sqlite;
  agents: AgentManager;
  registry: ModelRegistry;
  tools: ToolRegistry;
  ledger: UsageLedger;
  log: LogSink;
  workspace: string;
}

export async function runSubAgent(run: AgentRun, definition: AgentDefinition, task: string, context: string | undefined, turn: RuntimeTurnContext, dependencies: SubAgentDependencies, modelAlias?: string): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const alias = modelAlias ?? definition.modelAlias;
  const model = dependencies.registry.resolve(alias);
  const toolContext: ToolExecutionContext = { turn, workspace: dependencies.workspace, agentKind: 'sub', agentRunId: run.id };
  const toolSet: ToolSet = {};
  for (const registered of dependencies.tools.active(run.effectiveRole, toolContext, definition.tools)) {
    toolSet[registered.name] = tool({ description: registered.description, inputSchema: registered.inputSchema, execute: (input) => dependencies.tools.execute(registered.name, input, toolContext) });
  }
  const agent = new ToolLoopAgent({ model, ...dependencies.registry.settings(alias), instructions: definition.instructions, tools: toolSet, activeTools: Object.keys(toolSet), stopWhen: stepCountIs(definition.maxSteps),
    onStepEnd: (step) => {
      const info = dependencies.registry.infoByModelId(step.model.modelId) ?? dependencies.registry.info(alias);
      if (!info) return;
      dependencies.ledger.record({ turnId: turn.turnId, agentRunId: run.id, chatId: turn.chatId, userId: turn.initiatorUserId,
        providerId: info.providerId, modelId: info.modelId, modelAlias: alias, inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0, cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0, reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0,
        priceIn: info.priceIn, priceOut: info.priceOut, priceCacheRead: info.priceCacheRead, priceCacheWrite: info.priceCacheWrite,
        latencyMs: step.performance.responseTimeMs, finishReason: step.finishReason, ok: true });
      dependencies.db.prepare('UPDATE agent_runs SET steps=steps+1,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE id=?').run(step.usage.inputTokens ?? 0, step.usage.outputTokens ?? 0, run.id);
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
