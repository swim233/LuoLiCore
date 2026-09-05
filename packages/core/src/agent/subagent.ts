import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { ulid } from "ulid";
import type { Sqlite } from "@luoli/db";
import type { RuntimeTurnContext } from "@luoli/shared";
import type { AgentManager, AgentRun } from "./manager.js";
import {
  type ModelRegistry,
  aliasModel,
  stepToolErrors,
  stepToolResults,
  toolSetFor,
} from "./runtime.js";
import { PROVIDER_FAILURES_TO_DOWN } from "../provider/health.js";
import { LW_WORKER_KERNEL } from "../prompt/assembler.js";
import { TELEGRAM_SOURCE_ID } from "../memory/scope.js";
import type { Config } from "../config/schema.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import { newToolScope } from "../tools/registry.js";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.js";
import { SKILL_NARROWING_EXEMPT } from "../tools/policy.js";
import type { UsageLedger } from "../ledger/usage.js";
import type { LogSink } from "../log/sink.js";
export type LwWorkerRuntimeEvent =
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

export interface LwWorkerDependencies {
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
  onEvent?: (event: LwWorkerRuntimeEvent) => void | Promise<void>;
  /**
   * 派发它的那次 `tool.call` 的 span id（`spawn_worker` 从 `ToolExecutionContext.parentSpanId` 取）。
   * 依据 `docs/10 §7` 第 4 条：worker 的 span 挂在派发它的 `tool.call` 之下。
   * 缺省（试跑、直接调用）时 `agent.run` 即为本 trace 的一个根。
   */
  parentSpanId?: string;
}

/**
 * lw-worker：主 agent 唯一的执行面（`docs/04 §3`）。
 *
 * 与旧的子 agent 相比少了「是哪一个 agent」这件事 —— 没有定义、没有名字，`spawn_worker` 这条路
 * 也不带工具白名单，权限与派它的那一轮完全相同。它多出来的是折叠机制：目录的展开集与 skill 的
 * 收窄集现在挂在**本次 run** 上（`newToolScope()`），因此 `activeTools` 必须每步重算，而不是
 * 开轮时定死一次。
 *
 * `options.tools` 只有 WebUI 的隔离试跑会传（面板上勾一组工具跑一遍）。它走注册表既有的 `allow`
 * 通道：`#eligible()` 与 `admit()` 各判一次，因此是一道真的收窄而不只是目录过滤。
 */
export async function runLwWorker(
  run: AgentRun,
  task: string,
  context: string | undefined,
  turn: RuntimeTurnContext,
  dependencies: LwWorkerDependencies,
  options?: {
    modelAlias?: string;
    resultLimit?: number;
    tools?: readonly string[];
  },
): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const live = turn.config as Readonly<Config>;
  const alias = options?.modelAlias ?? live.agent.worker.modelAlias;
  const allow = options?.tools?.length ? [...options.tools] : undefined;
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
              agentRunId: run.id,
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
              agentRunId: run.id,
              data: {
                alias: name,
                agentRunId: run.id,
                from: from.id,
                to: to.id,
                reason: "candidate_exhausted",
              },
            }),
          // 与主 agent 同一规则：每次失败落一行、只有超时计入连续失败、一次调用一个候选只记一次
          // （`docs/04 §5.3`）。worker 走的是同一批 provider，此处漏记的表现是主轮不再阻塞而
          // worker 每一步仍耗满超时；按尝试计数则会让一次慢调用（worker 全走非流式）误判该候选失效。
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
              agentRunId: run.id,
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
              agentRunId: run.id,
              data: { alias: name, agentRunId: run.id },
            }),
        })
      : dependencies.registry.resolve(name);
  const model = modelFor(alias);
  /**
   * worker 同样需要 vision 切换。它常跑在 `low` 上，而它自己 `web_fetch` 取回的图片挂在工具
   * 结果上进入下一步的请求体；此处缺少判据时该图片会落到不具备视觉能力的模型上
   * （`docs/08 §7.2` 禁止的正是这件事；`degradeImageParts` 兜底也覆盖不到：`isImagePart`
   * 只识别顶层 part，识别不出嵌在 tool-result 里的图片，`docs/02 §9` 红线 22）。
   *
   * 候选集只有 `{当前别名, vision}` 两个，比主 agent 少一个降档前的别名，因为 worker
   * 没有 `downgradeAfterStep` 那类机械降档：它不具备视觉能力只可能源于 `spawn_worker` 显式
   * 指定了该别名，此时把它换回 `agent.worker.modelAlias` 不是修复而是另一种错配。
   * 注入侧必须查询同一集合（`ToolExecutionContext.worker.alias` + `vision`）；两侧不一致
   * 会导致图片已存储却无模型可读，或模型本可读图却声明不支持。
   *
   * 判据是本次 run 自身注入过图片（`toolContext.worker.onMediaInjected`），而非父轮的
   * `turn.mediaInjected`：父轮的图片不在 worker 的 messages 里（它只接收任务文本），跟随切换
   * 只会多付一次高价别名的开销；反向同理，worker 的图片也不应把父轮固定到 vision 上。
   */
  let mediaImages = 0;
  let mediaInjected = false;
  const visionAlias = (): string | null => {
    if (!mediaInjected || dependencies.registry.supportsVision(alias))
      return null;
    return dependencies.registry.supportsVision("vision") ? "vision" : null;
  };
  /** 当步实际使用的别名。记账与日志以它为准；已切换却按原别名记账会把费用计到未执行的模型上。 */
  let stepAlias = alias;
  let visionSwitchLogged = false;
  /**
   * `docs/10 §1` 的 span E：worker 整段执行的容器，它的 id 是内部 `model.call` / `tool.call`
   * 的父。span 只在结束时才落库，因此派发瞬间另记一条 `agent.spawn`；否则卡住的
   * worker 在日志里不留任何痕迹（docs/28 · L-LOG-01）。
   */
  const parent = dependencies.parentSpanId
    ? { parentSpanId: dependencies.parentSpanId }
    : {};
  const label = `${run.agentName}-worker (run ${run.id.slice(0, 8)})`;
  dependencies.log.event({
    level: "info",
    kind: "agent.spawn",
    summary: label,
    traceId: turn.turnId,
    agentRunId: run.id,
    ...parent,
    chatId: turn.chatId,
    userId: turn.initiatorUserId,
    key: turn.key,
    data: {
      runId: run.id,
      name: run.agentName,
      depth: run.depth,
      modelAlias: alias,
      taskChars: task.length,
    },
  });
  const runSpan = dependencies.log.span({
    level: "info",
    kind: "agent.run",
    summary: label,
    traceId: turn.turnId,
    agentRunId: run.id,
    ...parent,
    chatId: turn.chatId,
    userId: turn.initiatorUserId,
    key: turn.key,
    data: { runId: run.id, name: run.agentName, depth: run.depth, alias },
  });
  /**
   * 内部的工具调用挂在 `agent.run` 之下（`docs/10 §1` 的 `tool.call span G parent=E`）。
   *
   * 没有 `allow` 白名单：worker 拿的是它这个有效角色下的全集，减去 `MAIN_ONLY_TOOLS`
   * （由 `toolCallableBy('lw', …)` 在 `#eligible()` 与 `admit()` 两处判定）。
   *
   * `newToolScope()` 的三个 Set 是 **per-run** 的：worker 与主轮共享同一个 `turn` 对象，挂在
   * turn 上时它载入一个带 `allowed-tools` 的 skill 会去收窄主轮、它展开的工具会写进主轮的展开集
   * （`docs/05 §3.12` 不变量 4）。随本次 run 的函数帧消亡，不属于进程内状态（`docs/01 §3.1`）。
   *
   * `worker` 这一组服务于图片路径（`docs/04 §5.2`）：按 worker 自身的别名查询能力位（按主轮
   * 别名查询等于查询了无关模型）、父轮痕迹要记明取图方、张数与是否注入过图均按本次 run 计。
   */
  const toolContext: ToolExecutionContext = {
    turn,
    workspace: dependencies.workspace,
    agentKind: "lw",
    agentRunId: run.id,
    ...newToolScope(),
    ...(allow ? { allow: new Set(allow) } : {}),
    parentSpanId: runSpan.id,
    worker: {
      alias,
      name: run.agentName,
      images: () => mediaImages,
      onMediaInjected: () => {
        mediaImages += 1;
        mediaInjected = true;
      },
    },
  };
  // 与主 agent 共用 `toolSetFor`：`toModelOutput`（带图的工具结果）这类钩子若只加一处，表现为
  // 主 agent 能读图而 worker 不能，且只有实际运行一次带图的 worker 才会暴露。
  const toolSet = toolSetFor(
    dependencies.tools,
    dependencies.tools.active(run.effectiveRole, toolContext, allow),
    toolContext,
  );
  const perTurn = live.quota.perTurn;
  const maxSteps = Math.min(live.agent.worker.maxSteps, perTurn.maxSteps);
  const resultLimit = options?.resultLimit ?? live.agent.worker.resultMaxChars;
  let stepNumber = 0;
  let spentUsd = 0;
  /**
   * `repairToolCall` 本次 run 已改写过的名字（判据 ⓿，见该钩子的注释）。随本次 run 的函数帧消亡。
   */
  const repairedThisRun = new Set<string>();
  // 与主 agent 同理：重试由 fallbackLanguageModel 负责，SDK 层再叠一遍会把单次故障的墙钟耗时乘三。
  const agent = new ToolLoopAgent({
    model,
    ...dependencies.registry.settings(alias),
    maxRetries: 0,
    instructions: LW_WORKER_KERNEL,
    tools: toolSet,
    stopWhen: stepCountIs(maxSteps),
    /**
     * 折叠工具被直接调用时自愈为一次检索（docs/05 §3.12 的自愈段）。整段自主 agent 搬来 ——
     * 折叠机制现在只在 worker 这一侧，留在主 agent 那边是恒返回 `null` 的死代码。
     *
     * 背景：SDK 先按本步 `activeTools` 过滤 toolSet，再用过滤后的集合执行 `parseToolCall` ——
     * 因此模型调用折叠工具时在解析阶段即撞上 `NoSuchToolError`，根本到不了 `registry.execute()`。
     * 折叠使该情形从罕见幻觉变为常规事件，仅靠提示词引导等于寄希望于模型主动想到去检索。
     * 本钩子将其改写为 `search_tools({ names: [原名] })`：调用被自动展开，下一步即可真正调用该
     * 工具，模型无需先掌握 `search_tools`。代价与模型自行先检索一次相同（多一个 step）。
     *
     * 回调参数中的 `tools` 是已按 activeTools 过滤的 stepToolSet，折叠集不在其中 ——
     * 因此折叠判据只能从注册表实时计算，不能依赖该参数。
     */
    repairToolCall: ({ toolCall, tools: stepTools }) => {
      /**
       * 四条改写无效的判据排在最前，因为它们成本最低，而下方的 `activeView()` 需要跑完整条过滤
       * 链（含每个工具的 `available()`）—— 且最常见的入场情形恰好是幻觉名字，该档位要判到最后
       * 才能确定不应改写。
       *
       * ⚠ 这四条都用于防止死循环，而非优化。统一判据是本次改写能否真正推进状态：改写为检索而
       * 检索又不产生任何变化，就会形成「模型调用 X → NoSuchToolError → 改写为检索 → 检索原地
       * 返回 → 模型再次调用 X → …」的循环，直至耗尽步数上限或触发熔断。退回一次正常的
       * `NoSuchToolError` 更优 —— 模型得到的是明确失败，而不是一次看似有进展的往复。
       *
       * ⓿ 同一名字本次 run 只改写一次。这一条是兜底，且必须排在首位：①②③ 各自对应一种检索无法
       *    推进状态的成因，而成因不止这三种 —— `search_tools` 自身也会在 `admit()` 处失败
       *    （`tools.maxCallsPerTurn` 耗尽、运维将其 `approval` 覆盖为 `always` 且审批被拒、
       *    轮内连续失败达到 `maxConsecutiveErrors` 之前的若干次），这些档位一律不写入
       *    `expandedTools`，因此 ① 无法拦住第二次。实测（`tests/tools.catalog.wiring.test.ts`
       *    中的 `maxCallsPerTurn` 用例）：额度耗尽后同一个折叠工具被连续改写 11 次，仅由
       *    `maxSteps` 兜住 —— 11 次无效的模型调用。按名字判定一次即可，无需枚举全部成因。
       *    正常路径上它与 ① 等价（改写成功 ⇒ 名字进入 `expandedTools` ⇒ ① 本就会拦截），
       *    因此增加它不会阻断任何一次有效改写；同时也将同一步内并列的两次同名调用合并为一次。
       * ① 本次 run 已展开过它。`tools/catalog-meta.ts` 中「被 skill 收窄拦截的仍记入
       *    `expandedTools`」那段注释是这一条的另一半：单独看任一处都会认为对方多余（那边看似
       *    白占额度，这边看似可以顺带判一次 narrowed），两处需一并修改才成立。narrowed 的判据
       *    刻意不在此处再写一份 —— 它已有两份（`admit()` 与 `catalog-meta.ts`）且必须逐字对齐。
       * ② 本轮展开额度已耗尽。该档位下 `search_tools` 会返回 `expansion_limit` 且不写入
       *    `expandedTools`，因此 ① 拦不住它；而它的 hint 是用 names 精确指定，改写产生的调用本就是
       *    `names:[X]` —— 模型即使遵循 hint 也无出路。
       *    判据写作 `size >= budget`，在 `fresh` 恒为 1（此处永远只指定一个名字）时与
       *    `catalog-meta.ts` 的 `size + fresh > budget` 逐字等价，改动任一侧都需检查另一侧。
       *    ⓿ 同样能兜住它，但这一条使第一次即退回明确失败，省去一次无用检索。
       * ③ `search_tools` 本步无法发出。常态下成立（它常驻且豁免收窄），但成本闸门会将
       *    `activeTools` 整体清空 —— 那一档下改写只是换个名字撞同一个错误。
       */
      if (repairedThisRun.has(toolCall.toolName)) return Promise.resolve(null);
      if (toolContext.expandedTools.has(toolCall.toolName))
        return Promise.resolve(null);
      if (
        toolContext.expandedTools.size >= live.tools.catalog.maxExpandedPerTurn
      )
        return Promise.resolve(null);
      if (!("search_tools" in stepTools)) return Promise.resolve(null);
      // 幻觉名字（注册表中不存在的）不改写：将不存在的名字送去检索只会得到空结果，而模型会认为
      // 自己已经检索过。它照旧走 `NoSuchToolError`，那是一次明确的失败。
      if (
        !dependencies.tools
          .activeView(run.effectiveRole, toolContext, allow)
          .deferred.some((entry) => entry.name === toolCall.toolName)
      )
        return Promise.resolve(null);
      repairedThisRun.add(toolCall.toolName);
      dependencies.log.event({
        level: "info",
        kind: "tool.repaired",
        summary: `${toolCall.toolName} → search_tools`,
        traceId: turn.turnId,
        agentRunId: run.id,
        parentSpanId: runSpan.id,
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        key: turn.key,
        data: {
          tool: toolCall.toolName,
          into: "search_tools",
          reason: "deferred_not_expanded",
          agentRunId: run.id,
        },
      });
      // 逐字段列出而非 `...toolCall`：原调用上的 `providerExecuted` / `providerMetadata` 属于原
      // 工具的元数据，整份透传给 `search_tools` 等于挂到错误的工具上。`input` 必须是 JSON 字符串
      // —— 下游执行的是 `safeParseJSON({ text: toolCall.input, schema })`。
      return Promise.resolve({
        type: "tool-call" as const,
        toolCallId: toolCall.toolCallId,
        toolName: "search_tools",
        input: JSON.stringify({ names: [toolCall.toolName] }),
      });
    },
    prepareStep: async () => {
      /**
       * 每步重算，不能像此前那样用 `Object.keys(toolSet)` 一次定死：折叠机制转到 worker 这一侧
       * 之后，`search_tools` 展开的名字要在下一步真正可发出，而 `load_skill` 的收窄要在下一步
       * 真正生效。先扩张后收窄，收窄始终优先（docs/07 §2.2）：载入 `allowed-tools: [bash]` 的
       * skill 之后，已展开的 MCP 工具照样被滤除 —— 展开改变的是可见性，不是权限。
       *
       * 收窄集读 `toolContext.skillAllowedTools`（per-run）而不是 `turn` 上的那一份：turn 上
       * 已经没有这三个 Set 了，而共享它们正是 worker 会去收窄主轮的成因。
       *
       * 末尾那道 `name in toolSet` 是护栏：`toolSet` 在开轮时即冻结，而这一行算出的合格集每步
       * 都是实时的（轮中 MCP reconcile、热更新放宽 `tools.overrides` 都会让它多出名字）。
       * `filterActiveTools` 是纯交集、多报的名字被静默丢弃，因此问题不是报错而是结果失真：
       * `search_tools` 会对轮中新挂载的工具返回 `status:'expanded'`，而它根本不在冻结的 toolSet 中。
       */
      const skillAllow = toolContext.skillAllowedTools.size
        ? new Set<string>([
            ...toolContext.skillAllowedTools,
            ...SKILL_NARROWING_EXEMPT,
          ])
        : null;
      const activeForStep = dependencies.tools
        .activeNamesForStep(
          run.effectiveRole,
          toolContext,
          toolContext.expandedTools,
          allow,
        )
        .filter((name) => !skillAllow || skillAllow.has(name))
        .filter((name) => name in toolSet);
      const stopped =
        dependencies.ledger.turnCost(turn.turnId) >= perTurn.maxCostUsd
          ? { activeTools: [], toolChoice: "none" as const }
          : { activeTools: activeForStep };
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
          agentRunId: run.id,
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
      /**
       * `stepToolResults` 而不是 `step.toolResults`：后者等价于
       * `content.filter(p => p.type === 'tool-result')`，工具抛错或输入校验失败时产出的
       * `tool-error` part 会被整体滤除。worker 现在是唯一有工具的那一侧，滤掉它等于把
       * 「模型反复用错参数」这件事从试跑面板与日志里一并抹掉（`docs/00 §2` 的既有盲区）。
       */
      const toolResults = stepToolResults(step.content);
      await dependencies.onEvent?.({
        type: "step",
        step: currentStep,
        finishReason: step.finishReason,
        text: step.text,
        toolCalls: step.toolCalls as unknown[],
        toolResults: toolResults as unknown[],
      });
      // 模型给出非法工具参数时 `ToolRegistry.execute` 根本不会被调用（校验在 AI SDK 内部），
      // 因此 `tool.call` 计数为 0，唯一痕迹是上下文里那条下一轮就被裁掉的 `error-text`。
      for (const failure of stepToolErrors(step.content))
        dependencies.log.event({
          level: "warn",
          kind: "tool.error",
          summary: `${failure.toolName ?? "unknown"}: ${failure.message}`.slice(
            0,
            300,
          ),
          traceId: turn.turnId,
          agentRunId: run.id,
          parentSpanId: runSpan.id,
          chatId: turn.chatId,
          userId: turn.initiatorUserId,
          key: turn.key,
          data: {
            tool: failure.toolName,
            toolCallId: failure.toolCallId,
            errorKind: failure.errorKind,
            message: failure.message.slice(0, 500),
            agentRunId: run.id,
          },
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
        sourceId: turn.sourceId ?? TELEGRAM_SOURCE_ID,
      });
      // 只 record 不 commit 时，用量报表能看到这笔花费而配额拦不住它：日/月计数器只在
      // commit() 里递增，一轮十个 worker 会在账本上不计费用地跑完（docs/20 · W-QUOTA-01）。
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
      // worker 的模型调用此前没有任何日志，只在 `usage_ledger` 留一行，而
      // `docs/10 §1` 定义了 `model.call span F parent=E`，`AC-LOG-001` 的期望链也点名它。
      // 用 event 而非 span：这条路只有 `onStepEnd` 一个钩子，耗时取 SDK 报告的 `responseTimeMs`。
      dependencies.log.event({
        level: "info",
        kind: "model.call",
        summary: `${info.providerId}/${info.modelId}`,
        traceId: turn.turnId,
        agentRunId: run.id,
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
        summary: `${run.agentName} step ${currentStep}/${maxSteps}`,
        traceId: turn.turnId,
        agentRunId: run.id,
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
      name: run.agentName,
      steps: stepNumber,
      costUsd: spentUsd,
      ok,
      ...extra,
    };
    runSpan.end(payload, undefined, ok ? undefined : { level: "warn" });
    dependencies.log.event({
      level: ok ? "info" : "warn",
      kind: "agent.end",
      summary: `${run.agentName} ${ok ? "done" : "failed"} · ${stepNumber} 步 · $${spentUsd.toFixed(4)}`,
      traceId: turn.turnId,
      agentRunId: run.id,
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
    const finished = dependencies.agents.finish(run, result.text, resultLimit);
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
