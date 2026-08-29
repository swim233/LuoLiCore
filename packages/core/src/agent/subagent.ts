import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { ulid } from "ulid";
import type { Sqlite } from "@luoli/db";
import type { RuntimeTurnContext } from "@luoli/shared";
import type { AgentDefinition, AgentManager, AgentRun } from "./manager.js";
import { type ModelRegistry, aliasModel, toolSetFor } from "./runtime.js";
import { PROVIDER_FAILURES_TO_DOWN } from "../provider/health.js";
import { SUBAGENT_KERNEL } from "../prompt/assembler.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.js";
import type { UsageLedger } from "../ledger/usage.js";
import type { LogSink } from "../log/sink.js";
export type SubAgentRuntimeEvent =
  | {
      type: "step";
      step: number;
      finishReason: string;
      text: string;
      toolCalls: unknown[];
      toolResults: unknown[];
    }
  | {
      type: "usage";
      step: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };

export interface SubAgentDependencies {
  db: Sqlite;
  agents: AgentManager;
  registry: ModelRegistry;
  tools: ToolRegistry;
  ledger: UsageLedger;
  log: LogSink;
  workspace: string;
  /** 缺省时退回裸模型（无重试、无 fallback、无上游超时）；调用方应当传，主 agent 路径已经传了。 */
  provider?: {
    maxRetries: number;
    retryBaseMs: number;
    retryMaxMs: number;
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
  };
  quota?: QuotaGuard;
  reservation?: QuotaReservation | null;
  onEvent?: (event: SubAgentRuntimeEvent) => void | Promise<void>;
  /**
   * 派发它的那次 `tool.call` 的 span id（`spawn_agent` 从 `ToolExecutionContext.parentSpanId` 取）。
   * 依据 `docs/10 §7` 第 4 条：子 agent 的 span 挂在派发它的 `tool.call` 之下。
   * 缺省（试跑、直接调用）时 `agent.run` 即为本 trace 的一个根。
   */
  parentSpanId?: string;
}

export async function runSubAgent(
  run: AgentRun,
  definition: AgentDefinition,
  task: string,
  context: string | undefined,
  turn: RuntimeTurnContext,
  dependencies: SubAgentDependencies,
  modelAlias?: string,
): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const alias = modelAlias ?? definition.modelAlias;
  // 与主 agent 同一套包装：直接 resolve() 拿到的是裸模型，重试与 fallback 链一次都不会走。
  // 按别名建而不是只建一个：vision 切换要替换当步的模型，替换后的模型同样需要重试与
  // fallback 链（主 agent 侧 `wrappedFor` 同理，docs/20 · W-AGENT-01）。
  const modelFor = (name: string): LanguageModel =>
    dependencies.provider
      ? aliasModel(dependencies.registry, name, {
          maxRetries: dependencies.provider.maxRetries,
          retryBaseMs: dependencies.provider.retryBaseMs,
          retryMaxMs: dependencies.provider.retryMaxMs,
          abortSignal: turn.abortSignal,
          ...(dependencies.provider.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: dependencies.provider.requestTimeoutMs }),
          ...(dependencies.provider.streamIdleTimeoutMs === undefined
            ? {}
            : {
                streamIdleTimeoutMs: dependencies.provider.streamIdleTimeoutMs,
              }),
          isDown: (candidate) => dependencies.registry.isDown(candidate),
          onServed: (served) => dependencies.registry.recordSuccess(served),
          onSkipped: (candidate, next) =>
            dependencies.log.event({
              level: "warn",
              kind: "provider.fallback",
              summary: `${candidate.id} 已判 down，跳过${next ? ` → ${next.id}` : ""}`,
              traceId: turn.turnId,
              data: {
                alias: name,
                agentRunId: run.id,
                from: candidate.id,
                to: next?.id ?? null,
                reason: "skipped_down",
              },
            }),
          onFallback: (from, to) =>
            dependencies.log.event({
              level: "warn",
              kind: "provider.fallback",
              summary: `${from.id} 重试用尽仍失败，切换至 ${to.id}`,
              traceId: turn.turnId,
              data: {
                alias: name,
                agentRunId: run.id,
                from: from.id,
                to: to.id,
                reason: "candidate_exhausted",
              },
            }),
          // 与主 agent 同一规则：每次失败落一行、只有超时计入连续失败、一次调用一个候选只记一次
          // （`docs/04 §5.3`）。子 agent 走的是同一批 provider，此处漏记的表现是主轮不再阻塞而
          // 子 agent 每一步仍耗满超时；按尝试计数则会让一次慢调用（子 agent 全走非流式）误判该候选失效。
          onCandidateFailed: (candidate, failure) => {
            dependencies.log.event({
              level: "warn",
              kind: "model.error",
              summary:
                `${candidate.id} 第 ${failure.attempt + 1} 次尝试失败：${failure.error instanceof Error ? failure.error.message : String(failure.error)}`.slice(
                  0,
                  300,
                ),
              traceId: turn.turnId,
              data: {
                alias: name,
                agentRunId: run.id,
                modelId: candidate.id,
                errorKind: failure.kind,
                status: failure.status,
                retryAttempt: failure.attempt,
                willRetry: failure.willRetry,
                willFallback: failure.willFallback,
                ms: failure.elapsedMs,
              },
            });
            if (failure.kind === "timeout" && !failure.willRetry)
              dependencies.registry.recordFailure(
                candidate,
                failure.error instanceof Error
                  ? failure.error.message
                  : String(failure.error),
                PROVIDER_FAILURES_TO_DOWN,
              );
          },
          onUnavailable: (candidate, error) =>
            dependencies.registry.markProviderDown(
              candidate.id,
              error instanceof Error ? error.message : "authentication_failed",
            ),
          onExhausted: (error) =>
            dependencies.log.event({
              level: "error",
              kind: "model.error",
              summary:
                error instanceof Error
                  ? `${error.name}: ${error.message}`.slice(0, 300)
                  : String(error).slice(0, 300),
              traceId: turn.turnId,
              data: { alias: name, agentRunId: run.id },
            }),
        })
      : dependencies.registry.resolve(name);
  const model = modelFor(alias);
  /**
   * 子 agent 同样需要 vision 切换。它常跑在 `low` 上，而它自己 `web_fetch` 取回的图片挂在工具
   * 结果上进入下一步的请求体；此处缺少判据时该图片会落到不具备视觉能力的模型上
   * （`docs/08 §7.2` 禁止的正是这件事；`degradeImageParts` 兜底也覆盖不到：`isImagePart`
   * 只识别顶层 part，识别不出嵌在 tool-result 里的图片，`docs/02 §9` 红线 22）。
   *
   * 候选集只有 `{当前别名, vision}` 两个，比主 agent 少一个降档前的别名，因为子 agent
   * 没有 `downgradeAfterStep` 那类机械降档：它不具备视觉能力只可能源于它被显式指定为该别名，
   * 此时把 `spawn_agent` 指定的别名替换成定义里的别名不是修复而是另一种错配。
   * 注入侧必须查询同一集合（`ToolExecutionContext.agentAlias` + `vision`）；两侧不一致
   * 会导致图片已存储却无模型可读，或模型本可读图却声明不支持。
   */
  /**
   * 判据是本次 run 自身注入过图片（`toolContext.subAgent.onMediaInjected`），而非父轮的
   * `turn.mediaInjected`：父轮的图片不在子 agent 的 messages 里（它只接收任务文本），跟随切换
   * 只会多付一次高价别名的开销；反向同理，子 agent 的图片也不应把父轮固定到 vision 上。
   */
  let mediaImages = 0;
  let mediaInjected = false;
  const visionAlias = (): string | null => {
    if (!mediaInjected || dependencies.registry.supportsVision(alias))
      return null;
    return dependencies.registry.supportsVision("vision") ? "vision" : null;
  };
  /** 当步实际使用的别名。记账与日志以它为准；已切换却按定义里的别名记账会把费用计到未执行的模型上。 */
  let stepAlias = alias;
  let visionSwitchLogged = false;
  const allow = new Set(definition.tools);
  /**
   * `docs/10 §1` 的 span E：子 agent 整段执行的容器，它的 id 是内部 `model.call` / `tool.call`
   * 的父。span 只在结束时才落库，因此派发瞬间另记一条 `agent.spawn`；否则卡住的
   * 子 agent 在日志里不留任何痕迹（docs/28 · L-LOG-01）。
   */
  const parent = dependencies.parentSpanId
    ? { parentSpanId: dependencies.parentSpanId }
    : {};
  dependencies.log.event({
    level: "info",
    kind: "agent.spawn",
    summary: `${definition.name} (run ${run.id.slice(0, 8)})`,
    traceId: turn.turnId,
    ...parent,
    chatId: turn.chatId,
    userId: turn.initiatorUserId,
    key: turn.key,
    data: {
      runId: run.id,
      name: definition.name,
      depth: run.depth,
      modelAlias: alias,
      taskChars: task.length,
    },
  });
  const runSpan = dependencies.log.span({
    level: "info",
    kind: "agent.run",
    summary: `${definition.name} (run ${run.id.slice(0, 8)})`,
    traceId: turn.turnId,
    ...parent,
    chatId: turn.chatId,
    userId: turn.initiatorUserId,
    key: turn.key,
    data: { runId: run.id, name: definition.name, depth: run.depth, alias },
  });
  // 内部的工具调用挂在 `agent.run` 之下（`docs/10 §1` 的 `tool.call span G parent=E`）。
  // `subAgent` 这一组服务于图片路径（`docs/04 §5.2`）：按子 agent 自身的别名查询能力位（按主轮
  // 别名查询等于查询了无关模型）、父轮痕迹要记明取图方、张数与是否注入过图均按本次 run 计。
  const toolContext: ToolExecutionContext = {
    turn,
    workspace: dependencies.workspace,
    agentKind: "sub",
    agentRunId: run.id,
    allow,
    parentSpanId: runSpan.id,
    subAgent: {
      alias,
      name: definition.name,
      images: () => mediaImages,
      onMediaInjected: () => {
        mediaImages += 1;
        mediaInjected = true;
      },
    },
  };
  // 与主 agent 共用 `toolSetFor`：`toModelOutput`（带图的工具结果）这类钩子若只加一处，表现为
  // 主 agent 能读图而子 agent 不能，且只有实际运行一次带图的子 agent 才会暴露。
  const toolSet = toolSetFor(
    dependencies.tools,
    dependencies.tools.active(run.effectiveRole, toolContext, definition.tools),
    toolContext,
  );
  const perTurn = (
    turn.config as {
      quota: { perTurn: { maxSteps: number; maxCostUsd: number } };
    }
  ).quota.perTurn;
  const maxSteps = Math.min(definition.maxSteps, perTurn.maxSteps);
  let stepNumber = 0;
  let spentUsd = 0;
  // 与主 agent 同理：重试由 fallbackLanguageModel 负责，SDK 层再叠一遍会把单次故障的墙钟耗时乘三。
  // 子 agent 此前只拿到 `definition.instructions`（配置里通常是一句话），既不掌握
  // `<untrusted-content>` 的边界语义，也不知道工具报错该重试几次，而它使用同一批工具、
  // 读取同一批网页。`docs/06 §3.1` 的注入矩阵要求此处提供 `KERNEL(精简)`。
  const instructions = `${SUBAGENT_KERNEL}\n\n${definition.instructions}`;
  const agent = new ToolLoopAgent({
    model,
    ...dependencies.registry.settings(alias),
    maxRetries: 0,
    instructions,
    tools: toolSet,
    activeTools: Object.keys(toolSet),
    stopWhen: stepCountIs(maxSteps),
    prepareStep: async () => {
      const stopped =
        dependencies.ledger.turnCost(turn.turnId) >= perTurn.maxCostUsd
          ? { activeTools: [], toolChoice: "none" as const }
          : {};
      const seeing = visionAlias();
      stepAlias = seeing ?? alias;
      if (!seeing) return stopped;
      if (!visionSwitchLogged) {
        visionSwitchLogged = true;
        dependencies.log.event({
          level: "info",
          kind: "provider.fallback",
          summary: `${alias} → ${seeing}`,
          traceId: turn.turnId,
          parentSpanId: runSpan.id,
          key: turn.key,
          data: {
            alias,
            agentRunId: run.id,
            from: alias,
            to: seeing,
            reason: "vision_required",
          },
        });
      }
      // 采样参数跟随当步别名（`docs/04 §5.2.1`）：切换模型后仍按原别名的参数下发是另一种错配。
      return {
        ...stopped,
        model: modelFor(seeing),
        ...dependencies.registry.settings(seeing),
      };
    },
    onStepEnd: async (step) => {
      const currentStep = ++stepNumber;
      await dependencies.onEvent?.({
        type: "step",
        step: currentStep,
        finishReason: step.finishReason,
        text: step.text,
        toolCalls: step.toolCalls as unknown[],
        toolResults: step.toolResults as unknown[],
      });
      const info =
        dependencies.registry.infoByModelId(step.model.modelId) ??
        dependencies.registry.info(stepAlias);
      if (!info) return;
      const cost = dependencies.ledger.record({
        turnId: turn.turnId,
        agentRunId: run.id,
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        providerId: info.providerId,
        modelId: info.modelId,
        modelAlias: stepAlias,
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        // `inputTokens` 是 total（超集）；计价使用互斥的那一份（`pricedInputTokens`，docs/10 §4.1）。
        noCacheTokens: step.usage.inputTokenDetails.noCacheTokens ?? undefined,
        reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0,
        priceIn: info.priceIn,
        priceOut: info.priceOut,
        priceCacheRead: info.priceCacheRead,
        priceCacheWrite: info.priceCacheWrite,
        latencyMs: step.performance.responseTimeMs,
        finishReason: step.finishReason,
        ok: true,
      });
      // 只 record 不 commit 时，用量报表能看到这笔花费而配额拦不住它：日/月计数器只在
      // commit() 里递增，一轮十个子 agent 会在账本上不计费用地跑完（docs/20 · W-QUOTA-01）。
      if (dependencies.quota && dependencies.reservation)
        dependencies.quota.commit(dependencies.reservation, cost);
      dependencies.db
        .prepare(
          "UPDATE agent_runs SET steps=steps+1,input_tokens=input_tokens+?,output_tokens=output_tokens+?,cost_usd=cost_usd+? WHERE id=?",
        )
        .run(
          step.usage.inputTokens ?? 0,
          step.usage.outputTokens ?? 0,
          cost,
          run.id,
        );
      spentUsd += cost;
      // 子 agent 的模型调用此前没有任何日志，只在 `usage_ledger` 留一行，而
      // `docs/10 §1` 定义了 `model.call span F parent=E`，`AC-LOG-001` 的期望链也点名它。
      // 用 event 而非 span：这条路只有 `onStepEnd` 一个钩子，耗时取 SDK 报告的 `responseTimeMs`。
      dependencies.log.event({
        level: "info",
        kind: "model.call",
        summary: `${info.providerId}/${info.modelId}`,
        traceId: turn.turnId,
        spanId: ulid(),
        parentSpanId: runSpan.id,
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        key: turn.key,
        durationMs: step.performance.responseTimeMs,
        data: {
          agentRunId: run.id,
          stepNumber: currentStep,
          alias: stepAlias,
          servedProvider: info.providerId,
          servedModelId: info.modelId,
          usage: step.usage,
          cost,
          finishReason: step.finishReason,
        },
      });
      dependencies.log.event({
        level: "debug",
        kind: "agent.progress",
        summary: `${definition.name} step ${currentStep}/${maxSteps}`,
        traceId: turn.turnId,
        parentSpanId: runSpan.id,
        key: turn.key,
        data: {
          agentRunId: run.id,
          phase: "step",
          done: currentStep,
          total: maxSteps,
        },
      });
      await dependencies.onEvent?.({
        type: "usage",
        step: currentStep,
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        costUsd: cost,
      });
    },
  });
  const content = context ? `${task}\n\n---\n参考资料:\n${context}` : task;
  /** `agent.end` 与 `agent.run` 的收尾共用同一份数据，两条一起落库；缺一条 trace 树上就少一个端点。 */
  const settle = (ok: boolean, extra: Record<string, unknown>): void => {
    const payload = {
      runId: run.id,
      name: definition.name,
      steps: stepNumber,
      costUsd: spentUsd,
      ok,
      ...extra,
    };
    runSpan.end(payload, undefined, ok ? undefined : { level: "warn" });
    dependencies.log.event({
      level: ok ? "info" : "warn",
      kind: "agent.end",
      summary: `${definition.name} ${ok ? "done" : "failed"} · ${stepNumber} 步 · $${spentUsd.toFixed(4)}`,
      traceId: turn.turnId,
      parentSpanId: runSpan.id,
      chatId: turn.chatId,
      userId: turn.initiatorUserId,
      key: turn.key,
      data: payload,
    });
  };
  try {
    const result = await agent.generate({
      messages: [{ role: "user", content }],
      abortSignal: turn.abortSignal,
    });
    const finished = dependencies.agents.finish(run, result.text);
    settle(true, {
      summaryChars: finished.summary.length,
      truncated: finished.truncated,
    });
    return finished;
  } catch (error) {
    dependencies.agents.fail(
      run,
      error instanceof Error ? error.message : String(error),
    );
    settle(false, {
      error:
        error instanceof Error
          ? error.message.slice(0, 300)
          : String(error).slice(0, 300),
    });
    throw error;
  }
}
