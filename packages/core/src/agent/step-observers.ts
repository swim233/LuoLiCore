import {
  estimateStructureTokens,
  type RuntimeTurnContext,
} from "@luoli/shared";
import type { UsageLedger } from "../ledger/usage.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import type { LogSink } from "../log/sink.js";
import type { ContextEngine } from "../context/engine.js";
import { TELEGRAM_SOURCE_ID } from "../memory/scope.js";

/**
 * 一步模型调用结束时要做的四件事，拆成四个可单独注入伪造 step 的观察者。
 *
 * `onStepEnd` 此前是一段三十行的回调，同时负责记账、配额提交、SSE 广播、上下文 delta 追加与
 * token 校准，而链内 fallback 时按谁计价（docs/20 · W-LEDGER-01）与校准两端必须是
 * 同一对象这两个历史缺陷都出在其中，两者都没有单测，因为测试它需要先构造一个完整的
 * `ToolLoopAgent`（docs/27 · D-05）。
 *
 * 因此入口是 `StepFacts` 而非 AI SDK 的 step 类型：那个类型无法手工构造，而这四件事真正需要的
 * 只有下面十余个字段。把 SDK 的 step 映射成 `StepFacts` 留在 `runtime.ts`（它是适配层）。
 */
export interface StepFacts {
  stepNumber: number;
  /** 这一步实际产出的模型 id。链内 fallback 更换的是模型而非别名，因此它不一定是链首。 */
  servedModelId: string;
  /** `inputTokens` 是 AI SDK 的 `inputTokens.total`，为超集，含 cacheRead。计价走 `noCacheTokens`。 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    noCacheTokens?: number | undefined;
    reasoningTokens: number;
  };
  latencyMs: number;
  finishReason: string | undefined;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    part: unknown;
    preview: string;
  }>;
  /** 实际发出的那份请求体。校准两端必须是同一对象，见 `calibrate`。 */
  requestBody: unknown;
}

/** 记账所需的那几列。`ModelRow` 结构上与之等价，因此无需导出那个内部类型。 */
export interface PricedModel {
  providerId: string;
  modelId: string;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
}

/** `record()` 计算出的、后面两个观察者都要读取的三项数据。 */
export interface StepResolution {
  info: PricedModel;
  alias: string;
  cost: number;
}

export interface StepObserverDependencies {
  ledger: UsageLedger;
  registry: {
    infoByModelId(modelId: string): PricedModel | null;
    aliasOf(modelId: string, prefer?: string): string | null;
  };
  context: Pick<ContextEngine, "appendDelta" | "calibrate">;
  log: Pick<LogSink, "publish" | "event">;
  quota?: QuotaGuard | undefined;
  reservation?: QuotaReservation | null;
  tokenRatioAlpha: number;
  /** 反查不到实际产出模型时的兜底（取链首）。 */
  fallbackInfo: PricedModel;
  /** 这一步请求使用的别名：`prepareStep` 中按降档计算得出，而非链首的别名。 */
  aliasForStep(stepNumber: number): string;
}

export interface StepObservers {
  /** 记账并把花费提交进本轮预留。返回后面三个观察者需读取的解析结果。 */
  record(facts: StepFacts): StepResolution;
  /** SSE：用量一条、有工具调用时进度一条。 */
  broadcast(facts: StepFacts, resolved: StepResolution): void;
  /** 上下文 delta：工具调用与工具结果各追加一条（各自的 pruneLevel 决定降级顺序）。 */
  appendContext(facts: StepFacts): void;
  /** token 校准。 */
  calibrate(facts: StepFacts): void;
}

export function createStepObservers(
  turn: RuntimeTurnContext,
  dependencies: StepObserverDependencies,
): StepObservers {
  return {
    record(facts) {
      const info =
        dependencies.registry.infoByModelId(facts.servedModelId) ??
        dependencies.fallbackInfo;
      // 按别名分组的用量报表需要的是别名，而链内 fallback 更换的是模型：按是否为链首判定会把
      // 第二个候选记成 low，而它可能并非降档（docs/20 · W-LEDGER-01）。
      const alias =
        dependencies.registry.aliasOf(
          facts.servedModelId,
          dependencies.aliasForStep(facts.stepNumber),
        ) ?? "unknown";
      const cost = dependencies.ledger.record({
        turnId: turn.turnId,
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        providerId: info.providerId,
        modelId: info.modelId,
        modelAlias: alias,
        inputTokens: facts.usage.inputTokens,
        outputTokens: facts.usage.outputTokens,
        cacheReadTokens: facts.usage.cacheReadTokens,
        cacheWriteTokens: facts.usage.cacheWriteTokens,
        noCacheTokens: facts.usage.noCacheTokens,
        reasoningTokens: facts.usage.reasoningTokens,
        priceIn: info.priceIn,
        priceOut: info.priceOut,
        priceCacheRead: info.priceCacheRead,
        priceCacheWrite: info.priceCacheWrite,
        latencyMs: facts.latencyMs,
        ...(facts.finishReason ? { finishReason: facts.finishReason } : {}),
        ok: true,
        sourceId: turn.sourceId ?? TELEGRAM_SOURCE_ID,
      });
      if (dependencies.quota && dependencies.reservation)
        dependencies.quota.commit(dependencies.reservation, cost);
      return { info, alias, cost };
    },
    broadcast(facts, resolved) {
      dependencies.log.publish("usage", {
        turnId: turn.turnId,
        model: resolved.info.modelId,
        alias: dependencies.aliasForStep(facts.stepNumber),
        in: facts.usage.inputTokens,
        out: facts.usage.outputTokens,
        costUsd: resolved.cost,
      });
      if (facts.toolCalls.length)
        dependencies.log.publish("turn.progress", {
          turnId: turn.turnId,
          phase: "tools",
          step: facts.stepNumber,
          note: facts.toolCalls.map((call) => call.toolName).join(", "),
        });
    },
    appendContext(facts) {
      for (const call of facts.toolCalls) {
        dependencies.context.appendDelta(turn, {
          id: `call:${call.toolCallId}`,
          role: "assistant",
          origin: "tool_call",
          parts: [
            {
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            },
          ],
          textPreview: `${call.toolName}(${JSON.stringify(call.input).slice(0, 180)})`,
          pruneLevel: 2,
        });
      }
      for (const result of facts.toolResults) {
        dependencies.context.appendDelta(turn, {
          id: `result:${result.toolCallId}`,
          role: "tool",
          origin: "tool_result",
          parts: [result.part],
          textPreview: result.preview,
          pruneLevel: 1,
        });
      }
    },
    /**
     * 校准两端必须是同一对象。此前左侧是窗口内消息的估算、右侧是 `usage.inputTokens`，
     * 而后者还包含系统提示词与全部工具 schema（本机实测约 12,000 token 中有 9,500 属于这两项）。
     * 首轮上下文为空时左侧只有几十，一次采样就把 ratio 推到 26，此后每条消息按 26 倍存入数据库
     * （logs/2026-08-16 的 ctx.token_calibration 记录了这条曲线）。改为按实际发出的整个
     * 请求体估算：用同一度量衡量同一段内容，得到的才是分词器差异本身。
     */
    calibrate(facts) {
      const estimatedInput =
        facts.requestBody === undefined
          ? 0
          : estimateStructureTokens(facts.requestBody);
      const realInput = facts.usage.inputTokens;
      // 小样本的相对误差被常数项主导，校准它只会引入噪声。
      if (estimatedInput < 200 || realInput <= 0) return;
      const ratio = dependencies.context.calibrate(
        turn.key,
        realInput,
        estimatedInput,
        dependencies.tokenRatioAlpha,
      );
      if (Math.abs(realInput / estimatedInput - 1) > 0.2) {
        dependencies.log.event({
          level: "warn",
          kind: "ctx.token_calibration",
          summary: `token ratio ${ratio.toFixed(3)}`,
          traceId: turn.turnId,
          key: turn.key,
          data: { estimatedInput, realInput, ratio },
        });
      }
    },
  };
}
