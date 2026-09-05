import { createAnthropic } from "@ai-sdk/anthropic";
import { readFileSync } from "node:fs";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ToolLoopAgent, pruneMessages, stepCountIs, tool } from "ai";
import type {
  Instructions,
  LanguageModel,
  ModelMessage,
  Provider,
  ToolSet,
} from "ai";
type V4LanguageModel = Exclude<LanguageModel, string> & {
  specificationVersion: "v4";
};
import type { Config } from "../config/schema.js";
import type { Sqlite } from "@luoli/db";
import { modelAliasKey, readAppKv } from "@luoli/db";
import {
  escapeSystemInstructions,
  estimateStructureTokens,
  formatSpeakerIdentity,
  sanitizeIdentity,
  systemInstructions,
  type RuntimeTurnContext,
} from "@luoli/shared";
import type { PromptAssembler, PromptDocuments } from "../index.js";
import {
  runtimeBlock,
  type PromptBuildResult,
  type SdkOutputFormat,
  type SdkPromptBuildInput,
} from "../prompt/assembler.js";
import type {
  DeferredToolGroup,
  RegisteredTool,
  ToolCatalogView,
  ToolExecutionContext,
  ToolMedia,
  ToolRegistry,
} from "../tools/registry.js";
// `media` 的形状判据只有一份：注册表在序列化前用它，此处在落库前用同一个。判据写成两份会
// 导致注册表识别为图片、落库侧不识别的分歧。registry 不 import runtime，无循环依赖。
import { newToolScope, splitToolMedia } from "../tools/registry.js";
import {
  WORKER_INTERNAL_TOOLS,
  type AgentKind,
  type ToolName,
} from "../tools/policy.js";
import type { ProviderStore } from "../provider/store.js";
import {
  PROVIDER_FAILURES_TO_DOWN,
  recordProviderFailure,
  recordProviderServed,
} from "../provider/health.js";
import {
  type FallbackOptions,
  fallbackLanguageModel,
} from "./fallback-model.js";
import { createStepObservers, type StepFacts } from "./step-observers.js";
import {
  type AliasSettings,
  parseAliasSettings,
} from "../provider/alias-settings.js";
import { sandboxLabel, type ContainerManager } from "../sandbox/containers.js";
import type { UsageLedger } from "../ledger/usage.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import type { LogSink, LogSpan } from "../log/sink.js";
import { isImagePart, type ContextEngine } from "../context/engine.js";
import type { AgentManager } from "./manager.js";
import type { SkillLoader } from "../skills/loader.js";
import { TELEGRAM_SOURCE_ID } from "../memory/scope.js";
interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  headers: string | null;
}

interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: string;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
}

interface AliasRow {
  alias: string;
  modelIds: string;
  settings: string | null;
}

export class ModelRegistry {
  readonly #models = new Map<string, V4LanguageModel>();
  readonly #info = new Map<string, ModelRow>();
  readonly #chains = new Map<
    string,
    Array<{ model: V4LanguageModel; info: ModelRow }>
  >();
  readonly #settings = new Map<string, AliasSettings>();
  /** 当前处于 `down` 且仍在冷却期内的 `models.id`。派生自数据库：`rebuild()` 从库重算，
   *  `recordFailure()` 在写库的同一次调用中同步一份，进程内副本仅用于避免每次调用查库。 */
  readonly #down = new Set<string>();

  /** @param onProviderUnusable rebuild 跳过某个 provider 的原因，由装配方据此记录 warn。 */
  constructor(
    private readonly db: Sqlite,
    private readonly providers: ProviderStore,
    private readonly onProviderUnusable?: (
      providerId: string,
      reason: string,
    ) => void,
  ) {}

  /**
   * `provider.healthDownCooldownMinutes`：判为 `down` 的 provider 仅在冷却期内被排除，
   * 期满后下一次 `rebuild()` 重新纳入并再试一次。此前 `down` 是永久状态，一次网络抖动即可
   * 使某个 provider 从模型链中消失，直至运维在 WebUI 手工执行连通性测试。
   * `provider.healthCheckCron` 定期调用 `rebuild()`，冷却期因此可自愈。
   */
  rebuild(cooldownMinutes = 30): void {
    this.#models.clear();
    this.#info.clear();
    this.#chains.clear();
    this.#settings.clear();
    this.#down.clear();
    const cutoff = Date.now() - cooldownMinutes * 60_000;
    /**
     * 冷却期满必须写回数据库，不能仅在此处放行。此前判据只存在于下面这条 SELECT：冷却期满的
     * provider 重新进入模型链、也从 `#down` 移除，但库中该行仍为 `health_state='down'` 且
     * `health_fail_count>=3`。它带着已满的失败计数承接真实流量，下一次超时（4 >= 3）立即再次
     * down 30 分钟，形成 30 分钟 down / 一个 cron 间隔 up 的振荡，且 WebUI 全程显示 down。
     * `health_error` 保留作为界面上的上次失败原因，`health_checked_at` 不动（它记录上次判定时间）。
     */
    this.db
      .prepare(
        "UPDATE providers SET health_state='up',health_fail_count=0 WHERE health_state='down' AND COALESCE(health_checked_at,0) < ?",
      )
      .run(cutoff);
    const providerRows = this.db
      .prepare(
        `SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers
      WHERE enabled=1 AND COALESCE(health_state,'up') <> 'down'`,
      )
      .all() as ProviderRow[];
    // down 的 provider 已被上一条 SELECT 整体滤除，其模型不在任何链中，因此候选是否 down 必须
    // 单独查询，不能从链反推（`isDown` 判定的正是已不在链中的那些）。此处无需重复冷却期判据：
    // 期满的行已被上面那条 UPDATE 改回 `up`。
    for (const row of this.db
      .prepare(
        `SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id
      WHERE p.health_state='down'`,
      )
      .all() as Array<{ id: string }>)
      this.#down.add(row.id);
    const providerInstances = new Map<string, Provider>();
    for (const provider of providerRows) {
      /**
       * 单个 provider 失效不得波及全部别名。`ProviderStore.key()` 在密文解密失败时抛出
       * （更换 `LUOLI_MASTER_KEY` 后即会发生），`JSON.parse` 在 `headers_json` 非法时抛出；
       * 而注册表已在函数开头清空，异常上抛将导致所有别名同时丢失。调用点又是同步的
       * `POST /api/providers` / `PATCH /api/models/:id`，结果是端点 500 且运行时不再有任何可用
       * 模型，直到下一次 rebuild 成功（docs/27 · C-01）。`app.ts` 对同一列早已用 try/catch 兜底。
       *
       * 被跳过的 provider 记为 `down`：界面可展示原因，冷却期满后下一次 rebuild 会重试，
       * 而别名全部为空正是 `all_providers_down` 应当触发的条件。
       */
      try {
        const apiKey = this.providers.key(provider.id);
        const headers = provider.headers
          ? (JSON.parse(provider.headers) as Record<string, string>)
          : null;
        const common: {
          apiKey?: string;
          baseURL?: string;
          headers?: Record<string, string>;
        } = {};
        if (apiKey) common.apiKey = apiKey;
        if (provider.baseUrl) common.baseURL = provider.baseUrl;
        if (headers) common.headers = headers;
        const instance: Provider =
          provider.kind === "anthropic"
            ? createAnthropic(common)
            : provider.kind === "google"
              ? createGoogleGenerativeAI(common)
              : provider.kind === "openai-compatible"
                ? createOpenAICompatible({
                    name: provider.name,
                    baseURL: provider.baseUrl ?? "",
                    ...common,
                  })
                : createOpenAI(common);
        providerInstances.set(provider.id, instance);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.db
          .prepare(
            "UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?",
          )
          .run(Date.now(), reason.slice(0, 500), provider.id);
        this.onProviderUnusable?.(provider.id, reason);
      }
    }
    const modelRows = this.db
      .prepare(
        `SELECT id,provider_id AS providerId,model_id AS modelId,context_window AS contextWindow,
      max_output AS maxOutput,capabilities_json AS capabilities,price_in AS priceIn,price_out AS priceOut,
      price_cache_read AS priceCacheRead,price_cache_write AS priceCacheWrite FROM models WHERE enabled=1 ORDER BY sort`,
      )
      .all() as ModelRow[];
    const byId = new Map(modelRows.map((model) => [model.id, model]));
    const aliases = this.db
      .prepare(
        "SELECT alias,model_ids_json AS modelIds,settings_json AS settings FROM model_aliases",
      )
      .all() as AliasRow[];
    for (const alias of aliases) {
      const chain = (JSON.parse(alias.modelIds) as string[])
        .map((id) => byId.get(id))
        .filter((row): row is ModelRow => Boolean(row))
        .flatMap((info) => {
          const model = providerInstances
            .get(info.providerId)
            ?.languageModel(info.modelId);
          return model &&
            typeof model !== "string" &&
            model.specificationVersion === "v4"
            ? [{ model: model as V4LanguageModel, info }]
            : [];
        });
      const first = chain[0];
      if (!first) continue;
      this.#models.set(alias.alias, first.model);
      this.#info.set(alias.alias, first.info);
      this.#chains.set(alias.alias, chain);
      const settings = parseAliasSettings(alias.settings);
      if (settings) this.#settings.set(alias.alias, settings);
    }
  }

  /** 别名缺失时的回退顺序（04 §5.2）。模型与采样参数必须取自同一个别名，否则两者会错配。 */
  #pick(alias: string): string | null {
    return (
      [alias, "main", "high", "low"].find((candidate) =>
        this.#models.has(candidate),
      ) ?? null
    );
  }

  resolve(alias: string): LanguageModel {
    const picked = this.#pick(alias);
    if (!picked) throw new Error(`model alias unavailable: ${alias}`);
    return this.#models.get(picked)!;
  }

  settings(alias: string): AliasSettings {
    const picked = this.#pick(alias);
    return picked ? (this.#settings.get(picked) ?? {}) : {};
  }

  info(alias: string): ModelRow | null {
    return this.#info.get(alias) ?? null;
  }
  /** 链上每个候选都必须可反查：只扫描 `#info`（各别名的链首）会使 fallback 到第二个模型之后的
   *  计价与 `markProviderDown` 全部失效（docs/20 · W-AGENT-01 / W-LEDGER-01）。 */
  infoByModelId(modelId: string): ModelRow | null {
    for (const info of this.#info.values())
      if (info.modelId === modelId) return info;
    for (const chain of this.#chains.values())
      for (const candidate of chain)
        if (candidate.info.modelId === modelId) return candidate.info;
    return null;
  }
  /** modelId → 别名。`prefer` 命中时优先返回它：链内 fallback 更换的是模型，别名不变。 */
  aliasOf(modelId: string, prefer?: string): string | null {
    if (
      prefer &&
      this.#chains
        .get(prefer)
        ?.some((candidate) => candidate.info.modelId === modelId)
    )
      return prefer;
    for (const [alias, chain] of this.#chains)
      if (chain.some((candidate) => candidate.info.modelId === modelId))
        return alias;
    return null;
  }
  /**
   * `#down` 的粒度只有一种：provider 名下所有模型行同时加入、同时移除。401/403 路径
   * （`markProviderDown`）此前只加入命中的那一行，而按计数判定失效的路径（`recordFailure`）
   * 加入全部。当同一凭据被拒的 provider 在一条链上挂了两个模型时，第二个不会被 `isDown` 跳过，
   * 而 401 在中间件里是短路 `throw`：本轮既浪费一次必然 401 的往返，也不会继续向下 fallback。
   */
  #downRows(providerId: string, down: boolean): void {
    for (const row of this.db
      .prepare("SELECT id FROM models WHERE provider_id=?")
      .all(providerId) as Array<{ id: string }>) {
      if (down) this.#down.add(row.id);
      else this.#down.delete(row.id);
    }
  }
  markProviderDown(modelId: string, error: string): void {
    const row = this.infoByModelId(modelId);
    if (row) {
      this.db
        .prepare(
          "UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?",
        )
        .run(Date.now(), error.slice(0, 500), row.providerId);
      this.#downRows(row.providerId, true);
    }
  }
  /** `models.id` → `provider_id`。`recordFailure` / `recordSuccess` 均按行反查，不按模型名。 */
  #providerOf(candidate: { id: string; rowId?: string }): string | null {
    const rowId = candidate.rowId ?? this.infoByModelId(candidate.id)?.id;
    if (!rowId) return null;
    return (
      (this.db
        .prepare("SELECT provider_id FROM models WHERE id=?")
        .pluck()
        .get(rowId) as string) ?? null
    );
  }

  isDown(candidate: { id: string; rowId?: string }): boolean {
    if (candidate.rowId) return this.#down.has(candidate.rowId);
    const info = this.infoByModelId(candidate.id);
    return info ? this.#down.has(info.id) : false;
  }

  /**
   * 调用路径上的失败计入同一个连续失败计数器（`docs/04 §5.3`）。此处不调用 `rebuild()`：
   * 轮次中途替换 `#chains` 会使本步记账反查不到服务它的那一行，从而落到链首的价格上
   * （由 `step-observers` 的 `fallbackInfo` 兜底）。跳过失效候选由 `isDown` 负责，链本身留待
   * 下一次 `rebuild()`（健康检查 cron 或任意配置变更）重建。
   *
   * 代价是：若本次将最后一个 provider 标为 down，`all_providers_down` 要等下一次 cron 才触发
   * （`rebuildModels` 的收尾在 `main.ts`）。
   *
   * 一次调用中同一候选只记一次，重试不重复计数。该闸设在调用点（`onCandidateFailed` 的
   * `willRetry`），因为是否还会重试只有中间件知道。
   */
  recordFailure(
    candidate: { id: string; rowId?: string },
    reason: string,
    failuresToDown: number,
  ): boolean {
    const providerId = this.#providerOf(candidate);
    if (!providerId) return false;
    const { down } = recordProviderFailure(
      this.db,
      providerId,
      reason,
      failuresToDown,
    );
    if (down) this.#downRows(providerId, true);
    return down;
  }

  /**
   * 成功服务一次即将连续失败计数归零（`docs/04 §5.3`）。缺少这一条，连续失败会退化为累计失败：
   * 跨轮次零散累积三次超时即可判死一个持续正常服务的 provider，且计数存于库中、重启不清零。
   * 常态是 no-op（`recordProviderServed` 自带守卫），因此每步调用一次不会产生额外写入。
   */
  recordSuccess(candidate: { id: string; rowId?: string }): void {
    const providerId = this.#providerOf(candidate);
    if (providerId && recordProviderServed(this.db, providerId))
      this.#downRows(providerId, false);
  }

  estimate(alias: string, inputTokens: number): number | null {
    const info = this.info(alias);
    return info ? this.estimateModel(info, inputTokens) : null;
  }
  estimateModel(
    info: Pick<ModelRow, "priceIn" | "priceOut" | "maxOutput">,
    inputTokens: number,
  ): number | null {
    if (info.priceIn === null || info.priceOut === null) return null;
    const outputTokens = Math.min(
      info.maxOutput,
      Math.max(512, Math.ceil(inputTokens * 0.25)),
    );
    return (
      (inputTokens * info.priceIn + outputTokens * info.priceOut) / 1_000_000
    );
  }

  aliases(): string[] {
    return [...this.#models.keys()];
  }

  /**
   * 该别名当前服务的模型是否支持图像输入。`capabilities_json` 一直存于库中、SELECT 也一直在拉
   * （`ModelRow.capabilities`），只是从未被 `JSON.parse` 解析过 —— `docs/03:392` 所述运行时不读
   * 这一列即指此，而 `docs/04 §5.2` / `docs/08 §7.2` / `AC-PROV-009` 三处都要求含图轮次自动
   * 切换到 `vision`。
   *
   * 必须先执行 `has`：`info()` 走 `#pick`，别名不存在时会静默回落到 `main`，直接调用
   * `supportsVision('vision')` 将永远得到 main 的结果，使 vision 别名是否存在的判断恒为真。
   */
  supportsVision(alias: string): boolean {
    if (!this.#models.has(alias)) return false;
    const info = this.#info.get(alias);
    if (!info) return false;
    try {
      return (
        (JSON.parse(info.capabilities) as { vision?: unknown }).vision === true
      );
    } catch {
      return false;
    }
  }

  chain(alias: string): Array<{ model: V4LanguageModel; info: ModelRow }> {
    return this.#chains.get(alias) ?? [];
  }
}
/**
 * tool-result 的 output 必须是 SDK 的带类型形状（`{type:'json'|'text'|…, value}`），裸对象会使
 * 整个 prompt 无法通过 ModelMessage 校验。历史上写入库的是裸对象，而 parts 是持久化的：
 * 仅修改写入端的话，调用过工具的会话在 `/new` 之前每轮都会失败，因此读出侧也需兜底。
 * 只补 output，不修改判别字段（docs/02 不变量）。
 */
/**
 * 上下文中存引用而非字节。
 *
 * 带图的 tool-result 形如 `{type:'content', value:[…, {type:'file', data}]}`（由 `toolModelOutput`
 * 产出、SDK 原样发给 provider）。它写入 `context_messages.parts_json` 会引发两个问题：每次物化
 * 都重放数百 KB base64；硬截断 `truncatePartStrings` 进入 `output.value[].data` 会将其切断 ——
 * `tool-result` 不在 `OPAQUE_PART_TYPES` 中，得不到「原样保留或整体替换为占位」的保护，而截断
 * 结果是持久化的，该会话在 `/new` 之前每轮都会被 provider 拒收（docs/02 红线）。
 *
 * 图片跨轮依靠顶层的 `webasset://` part（`isImagePart` 可识别，因此 vision 切换、`capImages`、
 * `degradeImages` 均适用），不依赖工具结果，故此处摘除不丢失信息。
 * 置于 `normalizeToolOutput` 而非仅在写入侧：读出侧同样经过这一层，库中已有的数据也被覆盖。
 */
const PERSISTED_MEDIA_PLACEHOLDER =
  "[图片已另存为附件，工具结果中不重复存储字节]";
function stripToolResultMedia(output: { type: string; value: unknown }): {
  type: string;
  value: unknown;
} {
  if (output.type === "content" && Array.isArray(output.value)) {
    let touched = false;
    const value = output.value.map((entry) => {
      const part = entry as { type?: unknown } | null;
      if (part?.type !== "file" && part?.type !== "media") return entry;
      touched = true;
      return { type: "text", text: PERSISTED_MEDIA_PLACEHOLDER };
    });
    // 判别字段一律不动（docs/02 红线 14）：只替换 `value` 中的对应项，`type` 保持原样。
    return touched ? { ...output, value } : output;
  }
  /**
   * 落库走的是这一分支。AI SDK 对客户端执行的工具，将 `execute()` 的返回值原样放入
   * `step.content[].output`（`asContent`），`toModelOutput` 只作用于发给 provider 的 messages。
   * 因此 `stepToolResults` 拿到的是注册表那份带 `media` 的原始输出，`normalizeToolOutput` 为其
   * 套上 `{type:'json'}` 后即落库。若只识别上面的 `content` 形状，摘除的是一种从不落库的形状，
   * 数百 KB base64 仍会每轮重放（实测 `parts_json` 单条 300 KB）。
   *
   * 摘除不丢失信息：该结构的正文（`content` 字段）已包含工具自身的输出，图片跨轮依靠顶层的
   * `webasset://` part。替换为占位文本而非删除键，使模型知悉此处原本存在图片。
   */
  if (
    output.value &&
    typeof output.value === "object" &&
    !Array.isArray(output.value)
  ) {
    const { media, rest } = splitToolMedia(output.value as object);
    if (media.length)
      return {
        ...output,
        value: { ...rest, media: PERSISTED_MEDIA_PLACEHOLDER },
      };
  }
  return output;
}
export function normalizeToolOutput(output: unknown): {
  type: string;
  value: unknown;
} {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const typed = output as { type?: unknown; value?: unknown };
    if (typeof typed.type === "string" && "value" in typed)
      return stripToolResultMedia(typed as { type: string; value: unknown });
  }
  // 这一分支同样要执行摘除：注册表返回的原始输出（`{ok, content, truncated, media}`）没有 `type`
  // 字段，走的正是这里，而它就是落库的那一份。遗漏它等于只处理了一种从不落库的形状。
  return stripToolResultMedia({ type: "json", value: output ?? null });
}
export function toolResultPart(
  toolCallId: string,
  toolName: string,
  output: unknown,
): {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: string; value: unknown };
} {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output: normalizeToolOutput(output),
  };
}
/**
 * 工具输出 → SDK 的 tool-result 形状。带 `media` 时产出多模态的 `{type:'content'}`，
 * 否则遵循 SDK 默认行为（字符串走 `text`、其余走 `json`）。
 *
 * 这是图片在当步即可被模型看到的唯一通道：`context.appendDelta` 写入的是 `turn.delta`，而
 * `prepareStep` 拿到的 `messages` 由 SDK 提供，轮内注入的 part 无法进入本步请求体，只有附着在
 * 工具结果上才行。跨轮的那一份由顶层 `webasset://` part 负责。
 */
/**
 * SDK 的 `JSONValue` 只从 `@ai-sdk/provider-utils` 导出，而 core 不直接依赖该包。
 * 工具输出按约定是 JSON 可序列化的（`#normalizeOutput` 对其执行 `JSON.stringify`），因此此处
 * 定义一个等价的递归类型，而不是传入 `unknown` —— 后者等于关闭此处的全部类型检查。
 */
type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
type ToolModelOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | {
            type: "file";
            data: { type: "data"; data: string };
            mediaType: string;
          }
      >;
    };
export function toolModelOutput(output: unknown): ToolModelOutput {
  const media = (output as { media?: unknown } | null)?.media;
  if (!Array.isArray(media) || !media.length)
    return typeof output === "string"
      ? { type: "text", value: output }
      : { type: "json", value: (output ?? null) as JsonValue };
  const { media: _media, ...rest } = output as Record<string, unknown>;
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(rest) },
      ...media.map((entry) => ({
        type: "file" as const,
        data: { type: "data" as const, data: (entry as ToolMedia).data },
        mediaType: (entry as ToolMedia).mediaType,
      })),
    ],
  };
}
/**
 * 注册表工具 → SDK 的 `ToolSet`。实现只有一份：主 agent 与 worker 此前各写一遍相同的三行，
 * 而 `toModelOutput` 这类钩子漏加一处的表现是主 agent 能识别图片、worker 不能，且必须实际
 * 运行一次带图的 worker 才能发现。
 */
export function toolSetFor(
  registry: ToolRegistry,
  tools: readonly RegisteredTool[],
  context: ToolExecutionContext,
): ToolSet {
  const set: ToolSet = {};
  for (const registered of tools) {
    set[registered.name] = tool({
      description: registered.description,
      inputSchema: registered.inputSchema,
      execute: (input) => registry.execute(registered.name, input, context),
      toModelOutput: ({ output }) => toolModelOutput(output),
    });
  }
  return set;
}
/**
 * 单步的工具结果，`tool-error` 必须一并收集。
 *
 * AI SDK 的 `step.toolResults` 等价于 `content.filter(p => p.type === 'tool-result')`；工具抛错
 * 或输入校验失败时产出的是 `tool-error` part，会被整体滤除 —— `appendContext` 只将 tool-call
 * 追加进 delta，上下文中于是留下一条没有配对结果的 tool-call。该问题在轮内不可见（SDK 自身的
 * `responseMessages` 会把错误转成合法的 tool-result 发送），但从下一轮起该会话的每次请求都是
 * 畸形的：provider 返回 0 步 → `NoOutputGeneratedError` → 进程崩溃。实测于 logs/2026-08-18
 * 22:17 与 23:19 两次，起因是 `get_message({messageId:0})` 未通过 `z.number().int().positive()`。
 *
 * 形状与 SDK 实际发送的那份一致（`output: {type:'error-text', value}`），不另行定义。
 */
export function stepToolResults(
  content: readonly unknown[],
): StepFacts["toolResults"] {
  const results: StepFacts["toolResults"] = [];
  for (const raw of content) {
    const part = raw as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      output?: unknown;
      error?: unknown;
    };
    if (part?.type !== "tool-result" && part?.type !== "tool-error") continue;
    if (!part.toolCallId || !part.toolName) continue;
    const output =
      part.type === "tool-error"
        ? {
            type: "error-text",
            value:
              part.error instanceof Error
                ? `${part.error.name}: ${part.error.message}`
                : String(part.error),
          }
        : part.output;
    results.push({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      part: toolResultPart(part.toolCallId, part.toolName, output),
      preview: `${part.toolName}: ${JSON.stringify(output).slice(0, 180)}`,
    });
  }
  return results;
}
/**
 * 单步里被 AI SDK 自己拦下的工具调用（`tool-error`），供两条 agent 路径各记一条 `tool.error`。
 *
 * 模型给出非法工具参数时 `ToolRegistry.execute` 根本不会被调用 —— 校验发生在 AI SDK 内部
 * （`AI_InvalidToolInputError`），因此 `tool.call` 计数为 0，唯一痕迹是上下文里那条
 * `output.type='error-text'` 的 tool-result，而它下一轮即被 `prune_level=1` 清除。
 * 2026-08-18 导致进程崩溃的事故起点正是 `get_message({messageId:0})`（docs/28 · L-LOG-03）。
 *
 * 抽出来是因为 worker 那一侧此前整段缺失（`docs/00 §2` 的既有盲区），而重构之后 worker 是唯一
 * 有工具的那一侧 —— 两处各写一遍必然漂移成「同一件事在主路径记 warn、在 worker 侧无声」。
 */
export function stepToolErrors(content: readonly unknown[]): Array<{
  toolName: string | null;
  toolCallId: string | null;
  errorKind: string;
  message: string;
}> {
  const failures: Array<{
    toolName: string | null;
    toolCallId: string | null;
    errorKind: string;
    message: string;
  }> = [];
  for (const raw of content) {
    const part = raw as {
      type?: string;
      toolName?: string;
      toolCallId?: string;
      error?: unknown;
    };
    if (part?.type !== "tool-error") continue;
    failures.push({
      toolName: part.toolName ?? null,
      toolCallId: part.toolCallId ?? null,
      errorKind: part.error instanceof Error ? part.error.name : "unknown",
      message:
        part.error instanceof Error
          ? `${part.error.name}: ${part.error.message}`
          : String(part.error),
    });
  }
  return failures;
}
/**
 * 按别名构造带 fallback / 重试包装的模型。包装必须做在按别名解析这一层：`prepareStep` 每一步
 * 都会重设 model，只包装构造时的那一个等于整条链从第 0 步起就未被使用（docs/20 · W-AGENT-01）。
 * 别名没有链（registry 只识别其回退目标）时退回裸模型，行为与 `resolve()` 一致。
 */
export function aliasModel(
  registry: ModelRegistry,
  alias: string,
  options: FallbackOptions,
): LanguageModel {
  const candidates = registry.chain(alias);
  return candidates.length
    ? fallbackLanguageModel(
        candidates.map((candidate) => ({
          model: candidate.model,
          id: candidate.info.modelId,
          rowId: candidate.info.id,
        })),
        options,
      )
    : registry.resolve(alias);
}

const SENDABLE_ROLES = new Set(["user", "assistant", "tool"]);
/** 系统旁白标记。`load_skill` 注入 skill 正文时复用它 —— 同一个 wire 标记只能有一份定义。 */
export const NOTE_PREFIX = "（系统提示）";
/**
 * AI SDK v7 起 `image` part 已废弃：`convertToLanguageModelPrompt` 每遇到一个即输出一条
 * DeprecationWarning，随后原样转成 `{type:'file', data, mediaType}` 发出。写入侧
 * （`telegram/media.ts`）已直接产出 `file`，此处兜底的是库中的历史 part —— parts 是持久化的，
 * 不在读出侧转换的话，旧会话会持续输出警告，直到图片滚出上下文窗口。
 */
function imageToFilePart(
  part: Record<string, unknown>,
): Record<string, unknown> {
  const { image, type: _type, ...rest } = part;
  return {
    ...rest,
    type: "file",
    data: image,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "image",
  };
}
/**
 * system 只能出现在 instructions 中：AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages`
 * 未开启时直接拒收 messages 里的 system 消息，整轮请求立即 InvalidPromptError（docs/20 · W-CTX-01）。
 * 写入侧已不再产生这类消息（由 `assertValidShape` 的 role 白名单拦截），此处兜底的是 0006 之前
 * 写入库且未执行迁移的历史数据 —— parts 是持久化的，读出侧不兜底即为会话级永久损坏。
 */
/**
 * `attachment://<id>` / `webasset://<id>` 还原为 base64。文件丢失时整体降级为占位文本，
 * 不得抛出 —— parts 是持久化的，此处抛出一次即导致该会话在 `/new` 之前每轮都失败；而不透明
 * part 要么原样保留、要么整体替换为占位文本，正是 docs/02 的不变量（docs/24 · R-MEDIA-01）。
 *
 * 两个 scheme 共用同一个函数与同一条兜底：`attachment://` 是 Telegram 发来的附件
 * （`attachments` 表），`webasset://` 是 `web_fetch` / MCP 抓取的图片（`web_assets` 表）。
 * 分表是因为 `attachments` 整体是 Telegram 形状的（`message_id NOT NULL`、`tg_file_id NOT NULL`），
 * 网页图片只能填入伪造值，而本仓库的先例是摘除比伪造安全。
 */
/** `web_fetch` / MCP 抓取的图片。同一个 wire 标记只能有一份定义（沿用 `NOTE_PREFIX` 的先例）：
 *  写入侧在 `media/web-assets.ts`、读出侧在下方，各写一份将导致存入与取出的前缀不一致。 */
export const WEB_ASSET_SCHEME = "webasset://";
const ASSET_SCHEMES = ["attachment://", WEB_ASSET_SCHEME] as const;
function assetRef(part: Record<string, unknown>): string | null {
  return typeof part.ref === "string" &&
    ASSET_SCHEMES.some((scheme) => (part.ref as string).startsWith(scheme))
    ? part.ref
    : null;
}
function hydrateAttachment(
  part: Record<string, unknown>,
  attachments?: Sqlite,
): Record<string, unknown> {
  const missing = { type: "text", text: "[图片已不可用：附件文件已丢失]" };
  if (!attachments) return missing;
  const ref = part.ref as string;
  const web = ref.startsWith(WEB_ASSET_SCHEME);
  const id = ref.slice(ref.indexOf("//") + 2);
  const path = web
    ? (attachments
        .prepare("SELECT local_path FROM web_assets WHERE id=?")
        .pluck()
        .get(id) as string | undefined)
    : (attachments
        .prepare(
          "SELECT local_path FROM attachments WHERE id=? AND download_state='done'",
        )
        .pluck()
        .get(id) as string | undefined);
  if (!path) return missing;
  const { ref: _ref, ...rest } = part;
  try {
    return { ...rest, data: readFileSync(path).toString("base64") };
  } catch {
    return missing;
  }
}

export interface ContextMessageOptions {
  /**
   * 易变段正文（TOOL CATALOG + 记忆 + RUNTIME）。传入时带 nonce 信封追加为请求体的最后一条
   * user 消息，不传则不追加任何内容。它是每轮实时计算的渲染产物，不入库、不进 delta ——
   * 持久化它等于把上一轮的时钟固化成历史事实。
   */
  volatile?: string;
  /** Anthropic 专用：在已提交历史的最后一条消息上设置移动缓存断点（其余 provider 用隐式前缀缓存，无需设置）。 */
  cacheBreakpoint?: boolean;
  /** 读出侧自愈补齐的缺失 tool-result 条数。传入后可在日志中观察到该会话历史已损坏。 */
  onOrphanToolCalls?(toolCallIds: string[]): void;
  /**
   * 将图片整体替换为占位文本。把不透明 part 原样发给不支持它的模型，宽容的 provider 静默忽略、
   * 严格的直接返回 400，两者都比明确告知不支持图像更糟（`docs/08 §7.2`）。
   *
   * - `'all'`：本轮图片与历史图片一并替换。含图轮次既没有 `vision` 别名、当前别名本身也不支持
   *   图像输入时走这一档，回复末尾还需追加一句提示。
   * - `'history'`：仅替换 snapshot 中的图片（即更早轮次留在窗口内的）。`media.visionScope='turn'`
   *   且本轮无新图、而本轮模型不支持图像输入时走这一档 —— 用户本轮发送的是纯文本，没有理由
   *   为三轮前的一张图切换到成本更高的别名，也没有理由提示用户图片未被查看。
   */
  degradeImages?: "all" | "history";
}

/** 补齐结果的正文。不伪造成功，只如实说明结果已丢失（沿用 `hydrateAttachment` 的占位先例）。 */
const ORPHAN_TOOL_RESULT = "[工具结果缺失：本次调用的结果未被记录]";
/** `degradeImages` 替换图片时使用的占位文本，以及回复末尾的提示语（`docs/08 §7.2`）。 */
const IMAGE_UNSUPPORTED = "[图片：当前模型不支持看图，本轮未能查看]";
export const VISION_UNSUPPORTED_NOTICE =
  "（当前模型不支持看图，这张图未能查看。）";
/**
 * `degradeImages:'history'` 的占位文本。需明确写出恢复方式：在这一档下重新发送或引用该条消息
 * 会被计为本轮图片，从而切回支持图像输入的别名。若不写明，模型只知道自身无法查看，只能猜测或
 * 绕行（`docs/00 §2` 记录的 11 步操作即由此而来）。
 */
const HISTORY_IMAGE_UNSUPPORTED =
  "[图片：更早轮次的图片，当前模型不支持看图。如需查看，请用户重新发送或引用那条消息]";

/**
 * 在已物化为 `ModelMessage` 的结构中将图片 part 整体替换为占位文本，用作 `prepareStep` 的当步
 * 兜底（降档到不支持图像输入的别名时）。判据仍为 `isImagePart`：`contextMessages` 产出的图片是
 * `{type:'file', data, mediaType:'image/…'}`，与库中的判据一致。
 * 不含图片的消息原样返回同一对象：这一层每步都执行，多余的浅拷贝会替换整段前缀的引用。
 */
function degradeImageParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some((part) => isImagePart(part)))
      return message;
    return {
      ...message,
      content: content.map((part) =>
        isImagePart(part)
          ? { type: "text", text: HISTORY_IMAGE_UNSUPPORTED }
          : part,
      ),
    } as ModelMessage;
  });
}

export function contextMessages(
  turn: RuntimeTurnContext,
  attachments?: Sqlite,
  options?: ContextMessageOptions,
): ModelMessage[] {
  const source = [...turn.snapshot.messages, ...turn.delta];
  // 读出侧自愈：为没有配对结果的 tool-call 现场补一条。provider 遇到这种形状会拒收整个请求
  // （中转站的表现是 200 + 0 步），而 parts 是持久化的：读出侧不兜底，该会话在 `/new` 之前每轮
  // 都会失败，实测可导致进程终止。写入侧的 `assertPairedToolCalls` 只保证不再产生新的，
  // 库中已存在的只能在此处修复。
  /**
   * 按位置配对，而非全局集合。此处曾使用 `Set<toolCallId>`：窗口内任意位置存在同名 `toolCallId`
   * 的 tool-result，真正缺少结果的那条 tool-call 就不会被补齐。而 AI SDK 的
   * `convertToLanguageModelPrompt` 执行的是有序校验，会在发送请求前直接抛出
   * `MissingToolResultsError` —— 该会话每一轮都以 `Tool result is missing for tool call <id>.`
   * 失败、`steps=0`，且不会产生任何 `ctx.orphan_tool_call` 日志（本应修复它的这段代码认为它已被
   * 回答），直到窗口推过该条或执行 `/new`。真实 provider 的 id 是随机的，故触发概率较低，
   * 但修复成本很小（docs/28 · L-CTX-01）。
   *
   * 判据两条：一条结果只认领一次；一条结果只认领排在它之前的调用。
   */
  const unclaimed = new Map<string, number>();
  for (const message of source) {
    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (part?.type === "tool-result" && typeof part.toolCallId === "string")
        unclaimed.set(
          part.toolCallId,
          (unclaimed.get(part.toolCallId) ?? 0) + 1,
        );
    }
  }
  const forget = (id: string): void => {
    const left = (unclaimed.get(id) ?? 0) - 1;
    if (left > 0) unclaimed.set(id, left);
    else unclaimed.delete(id);
  };
  /** 处理某条消息时先扣除该条内的结果：它们属于更早的调用，不能再认领其后的调用。 */
  const passResults = (parts: Array<Record<string, unknown>>): void => {
    for (const part of parts)
      if (part?.type === "tool-result" && typeof part.toolCallId === "string")
        forget(part.toolCallId);
  };
  const claim = (id: string): boolean => {
    if (!(unclaimed.get(id) ?? 0)) return false;
    forget(id);
    return true;
  };
  const messages: ModelMessage[] = [];
  const repaired: string[] = [];
  // 断点设在已提交历史的最后一条，而非整个数组的最后一条：本轮 delta 与工具循环的产出均排在
  // 其后，因此这段前缀在下一轮原样存在、可整段命中缓存。跟随最后一条则每步都会变更位置，
  // 等同于未设置。补齐的结果会使下标偏移，因此 `stored` 统计的是产出侧的条数而非 snapshot 的条数。
  let stored = 0;
  for (const [index, message] of source.entries()) {
    // `'history'` 只作用于 snapshot 段。判据取下标而非 `origin`：被回复的那条消息渲染后同样是
    // `origin:'background'`（`renderArchivedMessage`），按 origin 划分会把用户当前正引用的图片
    // 一并当作历史抹除。
    const historical = index < turn.snapshot.messages.length;
    const degradeThis =
      options?.degradeImages === "all" ||
      (options?.degradeImages === "history" && historical);
    const content = (message.parts as Array<Record<string, unknown>>).map(
      (part) => {
        if (part?.type === "tool-result")
          return { ...part, output: normalizeToolOutput(part.output) };
        if (degradeThis && isImagePart(part))
          return {
            type: "text",
            text:
              options?.degradeImages === "history"
                ? HISTORY_IMAGE_UNSUPPORTED
                : IMAGE_UNSUPPORTED,
          };
        if (part?.type === "image") return imageToFilePart(part);
        if (part?.type === "file" && assetRef(part))
          return hydrateAttachment(part, attachments);
        // 易变段现与用户正文同处 user role，正文中若能写出 `<system-instructions` 即可伪造它。
        // 只修改 text 字符串，判别字段一律不动（docs/02 红线 14）。
        if (typeof part?.text === "string")
          return { ...part, text: escapeSystemInstructions(part.text) };
        return part;
      },
    );
    if (SENDABLE_ROLES.has(message.role))
      messages.push({ role: message.role, content } as ModelMessage);
    else {
      const text = content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      messages.push({
        role: "user",
        content: [{ type: "text", text: `${NOTE_PREFIX}${text}` }],
      } as ModelMessage);
    }
    passResults(message.parts as Array<Record<string, unknown>>);
    const orphans = content.filter(
      (part) =>
        part?.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        !claim(part.toolCallId),
    );
    if (orphans.length) {
      repaired.push(...orphans.map((part) => part.toolCallId as string));
      messages.push({
        role: "tool",
        content: orphans.map((part) =>
          toolResultPart(
            part.toolCallId as string,
            typeof part.toolName === "string" ? part.toolName : "unknown",
            { type: "error-text", value: ORPHAN_TOOL_RESULT },
          ),
        ),
      } as ModelMessage);
    }
    if (index < turn.snapshot.messages.length) stored = messages.length;
  }
  if (repaired.length) options?.onOrphanToolCalls?.(repaired);
  if (options?.cacheBreakpoint && stored > 0)
    messages[stored - 1] = {
      ...messages[stored - 1]!,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    } as ModelMessage;
  if (options?.volatile)
    messages.push({
      role: "user",
      content: [{ type: "text", text: systemInstructions(options.volatile) }],
    } as ModelMessage);
  return messages;
}

export interface MainAgentDependencies {
  config: Readonly<Config>;
  db: Sqlite;
  registry: ModelRegistry;
  tools: ToolRegistry;
  prompts: PromptAssembler;
  documents: PromptDocuments;
  ledger: UsageLedger;
  log: LogSink;
  workspace: string;
  quota?: QuotaGuard;
  reservation?: QuotaReservation | null;
  skills?: SkillLoader;
  plugins?: {
    hook(name: string, ...arguments_: unknown[]): Promise<unknown[]>;
  };
  context: ContextEngine;
  agents?: AgentManager;
  /** 自撰写工具的注册器。每轮开始时同步一次，见 `runMainAgentInternal` 开头的调用。 */
  customTools?: { syncIfChanged(): void };
  /**
   * 持久容器（docs/05 §5.5）。仅由 RUNTIME 块的工作目录行使用：模型若不知道自己可以启动常驻
   * 进程，该功能等同于未实现（docs/06 §1）。可选，未绑定时该行退回原措辞。
   */
  containers?: ContainerManager;
  /** 仅用于记录 `turns.steps`（此前无任何写入方）。可选：worker 与测试均无需提供。 */
  turns?: { countStep(id: string, steps: number): void };
  /**
   * 缺省 `'main'`（既有调用方零变化）。SDK 路径（docs/12-sdk.md T3.6/T3.7）传 `'sdk'`：
   * `assembleMainPrompt` 据此改走 `prompts.buildSdk()` 而非 `prompts.build()`，本函数自身
   * （工具集解析、模型链、`ToolLoopAgent` 步循环、ledger 记账）不区分 `agentKind`——
   * 白名单收窄已经在 `ToolRegistry` 那一层（`toolContext.agentKind` 决定 `activeTools`）完成。
   */
  agentKind?: AgentKind;
  /** 仅 `agentKind:'sdk'` 时读取，决定 `SDK_KERNEL` 与输出格式段选哪一档，缺省 `'markdown'`。 */
  outputFormat?: SdkOutputFormat;
}
export interface MainPromptAssembly extends PromptBuildResult {
  /** 主 agent 第 0 步真正能发出的工具（`agentKind: 'main'` 视角）。 */
  activeTools: string[];
  /**
   * TOOL CATALOG 里列出的名字（`agentKind: 'lw'` 视角，滤掉 `WORKER_INTERNAL_TOOLS`）。
   *
   * 与 `activeTools` 是两份数据：block 3 描述的是 **worker 能做什么**（主 agent 据此判断值不值得
   * 派一个出去），而 `activeTools` 是主 agent 自己这一步的可发出集。共用一份的话，要么目录里
   * 只剩对话与派发那几个（模型于是认为这个部署没有任何工具），要么主 agent 的 `activeTools`
   * 混进它调不到的名字（每一次调用都撞 `tool_requires_worker`）。
   */
  catalogTools: string[];
  catalog: string;
  runtime: string;
}

type PromptAssemblyDependencies = Pick<
  MainAgentDependencies,
  | "config"
  | "tools"
  | "prompts"
  | "documents"
  | "workspace"
  | "skills"
  | "agents"
  | "quota"
  | "reservation"
  | "containers"
  | "outputFormat"
>;

/**
 * RUNTIME 块中的发起人。昵称与用户名是用户可控内容，`formatSpeakerIdentity` 已清除换行与
 * 方括号 —— 带换行的昵称在此处可向 RUNTIME 块注入一整行伪造的权限声明。
 */
function initiatorDescription(turn: RuntimeTurnContext): string {
  return formatSpeakerIdentity({
    name: turn.initiator?.name ?? null,
    username: turn.initiator?.username ?? null,
    userId: turn.initiatorUserId,
  });
}

/**
 * RUNTIME 块的会话行。此前只有裸 `chatId / key`，模型无法区分私聊与群聊，而人格与 KERNEL 中
 * 大量规则按此分支（群聊仅在被触发时发言、私聊才有私有记忆）。群名需经 `sanitizeIdentity`：
 * 它与昵称同为用户可控内容，带换行的群名可向该块注入一行伪造的权限声明。
 */
export function chatDescription(turn: RuntimeTurnContext): string {
  const topic = turn.threadId === null ? "topic 无" : `topic ${turn.threadId}`;
  const title = turn.chatTitle ? sanitizeIdentity(turn.chatTitle) : "";
  const where = turn.isPrivate ? "私聊" : title ? `群聊「${title}」` : "群聊";
  return `${where}(chat ${turn.chatId}, ${topic})  上下文键 ${turn.key}`;
}

/**
 * TOOL CATALOG 的常驻段（docs/06 §1）。
 *
 * `tools.catalog.residentDescriptions=false` 时压缩为一行名字清单：同一份 description 此前在
 * 两处各发送一遍 —— provider 的 tools 数组那份位于请求体头部、属可缓存前缀，这一份位于易变段、
 * 每步重发。重复的成本主要在后者，而描述的权威副本本就是 tools 数组那份（且带完整 JSON Schema）。
 * 默认仍为 `true`：折叠与去重是两个独立变量，同时启用会导致模型行为下降时无法归因。
 *
 * 名字清单一档的抬头写「worker 常驻工具」而不是「常驻工具（可直接调用）」：这份目录现在描述的是
 * worker 能做什么，主 agent 自己一个都调不到（`docs/04 §1`）。写成「可直接调用」是把 worker 的
 * 能力说成读者的能力，而读者是主 agent。
 */
function residentCatalog(
  resident: readonly RegisteredTool[],
  withDescriptions: boolean,
): string {
  if (!resident.length) return "";
  return withDescriptions
    ? resident.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
    : `worker 常驻工具：${resident.map((tool) => tool.name).join(", ")}`;
}
/** 单组超过此数即只列出前 `DEFERRED_GROUP_HEAD` 个（docs/06 §1）：摘要行同处易变段，每步重发。 */
const DEFERRED_GROUP_CAP = 12;
const DEFERRED_GROUP_HEAD = 10;
/**
 * 折叠段：每组一行、只列名字、不带 per-tool 描述（形状见 docs/06 §1）。
 *
 * 不带描述是该机制的本体，而非排版偏好：MCP 工具名本身相当自描述，而上游 description 动辄
 * 数 KB、每步重发正是要消除的开销。
 *
 * **行首那句引导是给谁的，随工具下沉换过一次人。** 此前写「本步不可直接调用；用 `search_tools`
 * 展开」，读者是手里握着折叠工具的主 agent。现在这份目录读者仍是主 agent，而 `search_tools`
 * 在 worker 那一侧 —— 照原样写，模型会去调一个它没有的工具，撞 `NoSuchToolError`
 * （`docs/05 §3.12` 不变量 5 那条路径）。所以这句改成说清「这些要派 worker」，
 * 展开那一跳的引导留在 `LW_WORKER_KERNEL` 里，由真正做得到的那一方收。
 *
 * 组的顺序沿用 `activeView()` 返回的原序（`sourcePriority desc, name asc` 的首次出现顺序），
 * 不要重排：这一段位于易变段内，无谓的重排等于每步修改一次提示词。
 */
function deferredCatalog(
  groups: readonly DeferredToolGroup[],
  total: number,
): string {
  if (!total) return "";
  const lines = groups.map((group) => {
    const shown =
      group.total > DEFERRED_GROUP_CAP
        ? group.names.slice(0, DEFERRED_GROUP_HEAD)
        : group.names;
    return `- [${group.key}] ${group.total} 个：${shown.join(", ")}${shown.length < group.total ? `, …等 ${group.total} 个` : ""}`;
  });
  return [
    `【折叠工具 · 共 ${total} 个，worker 检索后才可用；需要其中任何一项，把要求写进 task 派 worker】`,
    ...lines,
  ].join("\n");
}

/**
 * Runtime 与 WebUI 预览共用这条组装路径；预览产出的 block 必须与下一轮发给模型的 block 一致。
 *
 * `agentKind` 只在未传 `executionContext` 时生效，缺省 `main`：既有调用方（`runMainAgentInternal`
 * 与不带第三参的 WebUI 预览）零变化。SDK 路径（`docs/12-sdk.md` T3.6/T3.7）尚无完整的
 * `ToolExecutionContext` 可传时，直接传 `'sdk'` 走这条缺省分支。
 */
export function assembleMainPrompt(
  turn: RuntimeTurnContext,
  dependencies: PromptAssemblyDependencies,
  executionContext?: ToolExecutionContext,
  agentKind: AgentKind = "main",
): MainPromptAssembly {
  const toolContext = executionContext ?? {
    turn,
    workspace: dependencies.workspace,
    agentKind,
    ...newToolScope(),
  };
  // 与 `prepareStep` 逐字同一个调用，只是那边每步重算一次：主 agent 没有 `search_tools`，展开集
  // 恒为空，因此第 0 步与其后每一步的合格集本就相同 —— 两处写法不同会让它们在某个配置下分叉。
  const activeTools = dependencies.tools.activeNamesForStep(
    turn.effectiveRole,
    toolContext,
  );
  // `perChat.<key>.character`：会话级人格文件名。它在 `perChat` 白名单内，但不是 schema 叶子键
  // （`perChat` 为 `z.record(z.unknown())`），因此从合并后的本轮配置中按名字读取（docs/27 · C-08）。
  // 形态校验在 `PromptDocuments.paths`：该值会被用作 `memory/` 下的路径段。
  const characterOverride = (turn.config as Record<string, unknown>).character;
  const documents = dependencies.documents.readForPrompt({
    userId: turn.initiatorUserId,
    isPrivate: turn.isPrivate,
    ...(turn.sourceId ? { sourceId: turn.sourceId } : {}),
    ...(typeof characterOverride === "string" && characterOverride
      ? { characterOverride }
      : {}),
  });
  /**
   * SDK 会话（`agentKind:'sdk'`）没有 TOOL CATALOG 块：白名单只有记忆三件，没有派工可言，
   * 目录描述的是「worker 能做什么」这件事对 SDK 不存在（`docs/06 §1.3`，`docs/12-sdk.md` T3.5
   * 验收 4 要求装配结果不含该块）。因此跳过下面这一整段 worker 视角的目录计算——
   * `catalogTools`/`catalog` 保持空，`runtime` 里的折叠计数与截断提示也随之为零/无。
   */
  let catalogTools: string[] = [];
  let catalog = "";
  let catalogTruncated: ToolCatalogView["truncated"] = null;
  let deferredCount = 0;
  if (toolContext.agentKind !== "sdk") {
    /**
     * 目录与 `activeTools` 现在是两次取数，两个视角。
     *
     * 目录（block 3）用 worker 的视角：主 agent 自己不调工具了，它需要知道的是**派出去能做什么** ——
     * 按主 agent 的视角取数，目录里只剩 `send_message` / `spawn_worker` 那几个，模型会据此认为
     * 这个部署没有文件、没有沙箱、不能上网。折叠视图也随之按 worker 的合格集切分，因为真正会去
     * `search_tools` 展开它们的是 worker。
     *
     * 主 agent 的合格集另取一次（`toolContext` 本身就是 `agentKind: 'main'`）。
     */
    const workerView = dependencies.tools.activeView(turn.effectiveRole, {
      ...toolContext,
      agentKind: "lw",
    });
    const view: ToolCatalogView = {
      ...workerView,
      // `ask_parent` / `report_progress` / `search_tools` 是 worker→父的内部通道。列进主 agent 的
      // 目录会让模型以为自己可以派一个 worker 去上报进度（`WORKER_INTERNAL_TOOLS` 的注释是另一半）。
      resident: workerView.resident.filter(
        (tool) => !WORKER_INTERNAL_TOOLS.includes(tool.name as ToolName),
      ),
    };
    catalogTools = view.resident.map((tool) => tool.name);
    // 目录按本轮实际可用的工具过滤：一份讲解 `install_mcp` 的说明在该工具未启用时出现在目录中，
    // 只会把模型引入死路（实测：它读完说明找不到工具，转而用 bash 逆向代码库）。
    // 过滤依据是全量名字（常驻 + 折叠）：讲解某个折叠 MCP 工具的 skill 仍应出现在目录中 ——
    // 折叠意味着需要先展开一次，而非不存在，模型读完 skill 正文恰好知道该展开哪个。
    const skillCatalog =
      dependencies.skills
        ?.catalog(turn.effectiveRole, [
          ...catalogTools,
          ...view.deferred.map((tool) => tool.name),
        ])
        .map((skill) => `- skill:${skill.name}: ${skill.description}`)
        .join("\n") ?? "";
    // `prompt.includeToolCatalog=false` 时只发送工具名（RUNTIME 中的那一行），不发送描述。节省的是
    // 每轮数百至数千 token，代价是模型失去参数用法的提示，因此默认开启。
    //
    // skill 目录不随工具目录一起关闭（docs/06 §1）：它此前置于该三元表达式的 then 分支中，导致
    // 关闭工具目录会连带关闭 skill 清单 —— 而 skill 目录不与任何内容重复（RUNTIME 的可用工具行
    // 只列工具），关闭后模型无从知晓有哪些 skill 可载入。因此两段各自渲染，最后拼接。
    catalog = [
      ...(dependencies.config.prompt.includeToolCatalog
        ? [
            residentCatalog(
              view.resident,
              dependencies.config.tools.catalog.residentDescriptions,
            ),
            deferredCatalog(view.groups, view.deferred.length),
          ]
        : []),
      skillCatalog,
    ]
      .filter(Boolean)
      .join("\n");
    catalogTruncated = view.truncated;
    deferredCount = view.deferred.length;
  }
  const runtimeShow = dependencies.config.prompt.runtimeBlock;
  const spent =
    dependencies.quota && dependencies.reservation
      ? dependencies.quota.status(dependencies.reservation)
      : null;
  const runtime = runtimeBlock({
    now: new Date(),
    timezone: dependencies.config.general.timezone,
    chatDescription: chatDescription(turn),
    triggerDescription: initiatorDescription(turn),
    role: turn.effectiveRole,
    tools: activeTools,
    contextMessages: turn.snapshot.messages.length,
    contextTokens: turn.snapshot.tokens,
    maxMessages: dependencies.config.context.limit.maxMessages,
    maxTokens: dependencies.config.context.limit.tokens,
    workspace: dependencies.workspace,
    // 持久容器一档需说明常驻状态、剩余时长与出网能力，否则模型不会主动启动常驻进程（docs/06 §1）。
    sandbox: sandboxLabel(
      dependencies.config.sandbox.mode,
      dependencies.config.sandbox.persistent,
      dependencies.containers?.expiryHintFor(turn.chatId) ?? { state: "none" },
    ),
    // 只有存在本轮预留时才能给出额度；WebUI 的提示词预览没有预留，该行本就不应出现。
    ...(spent
      ? {
          quota: `本轮已用 $${spent.committed.toFixed(4)} / 上限 $${dependencies.config.quota.perTurn.maxCostUsd.toFixed(2)}`,
        }
      : {}),
    // 刚被清空的那一轮需给出说明。措辞按 `context.recallBarrier` 分支：隔断开启时归档同样不可
    // 检索，不说明清楚模型会在该死路上反复尝试（`read_messages` 返回空，而它无从得知原因）。
    ...(turn.contextCleared
      ? {
          contextCleared: dependencies.config.context.recallBarrier
            ? "刚被清空。之前的对话不在你当前上下文中，归档检索也查不到清空之前的消息 —— 不要反复尝试，需要时请用户重新描述。"
            : "刚被清空。之前的对话不在你当前上下文中；必要时可使用 read_messages / search_messages 检索归档。",
        }
      : {}),
    // 这一行现在恒真。它此前只在目录关闭时出现（开着时 TOOL CATALOG 的常驻段已列出同一份名字，
    // 属重复计费）—— 而 block 3 描述的已经是 worker 能做什么，两处不再同源：RUNTIME 的
    // 「可用工具」是主 agent 自己那一步唯一的清单，缺了它模型只能从目录里挑一个名字直接调，
    // 每次都撞 `tool_requires_worker`。
    show: {
      quota: runtimeShow.showQuota,
      contextWatermark: runtimeShow.showContextWatermark,
      workspace: runtimeShow.showWorkspace,
      toolNames: true,
    },
    // 截断告知与折叠计数均取自 worker 视角那次 `activeView()`（SDK 会话恒为零/无，上面已跳过该计算）。
    // 折叠数为 0 时 `runtimeBlock` 自身不添加后缀，因此此处无条件传入。
    ...(catalogTruncated ? { catalogTruncated } : {}),
    deferredTools: deferredCount,
  });
  // SDK 会话装配走 `buildSdk()`（`SDK_KERNEL` + 按 `outputFormat` 分档），不是 `build()`——
  // 两者都不接受另一方专有的字段（`buildSdk` 类型层拒收 `catalog`/`includeCatalog`，
  // 见 `SdkPromptBuildInput`），因此这里在调用处整体分叉，而不是把两条路径的入参强行合并成一份。
  if (toolContext.agentKind === "sdk") {
    const sdkPromptInput: SdkPromptBuildInput = {
      character: documents.character,
      assist: documents.assist,
      publicMemory: documents.publicMemory,
      runtime,
      maxTokens: dependencies.config.prompt.maxTokens,
      outputFormat: dependencies.outputFormat ?? "markdown",
    };
    if (documents.privateMemory !== undefined)
      Object.assign(sdkPromptInput, { privateMemory: documents.privateMemory });
    return {
      ...dependencies.prompts.buildSdk(sdkPromptInput),
      activeTools,
      catalogTools,
      catalog,
      runtime,
    };
  }
  const promptInput = {
    character: documents.character,
    assist: documents.assist,
    catalog,
    publicMemory: documents.publicMemory,
    runtime,
    maxTokens: dependencies.config.prompt.maxTokens,
    // 判据不能只看 `includeToolCatalog`：关闭工具目录后该块中仍有 skill 清单，整块跳过即为上述
    // 耦合的另一半。两部分都为空时才真正不渲染（`includeToolCatalog=false` 且未安装 skill 的情形，
    // 与改动前逐字节一致）。
    includeCatalog:
      dependencies.config.prompt.includeToolCatalog || Boolean(catalog),
  };
  if (documents.privateMemory !== undefined)
    Object.assign(promptInput, { privateMemory: documents.privateMemory });
  return {
    ...dependencies.prompts.build(promptInput),
    activeTools,
    catalogTools,
    catalog,
    runtime,
  };
}

/**
 * `instructions` 中只放稳定段（KERNEL/CHARACTER/ASSIST）。易变段（TOOL CATALOG + 记忆 + RUNTIME）
 * 经 `contextMessages` 追加到请求体末尾，因为前缀缓存的判据是请求体的物理顺序：易变段留在
 * system #2 时，它每轮变化的那几个字节位于整个历史之前，其后数万 token 的对话一条都无法命中
 * 缓存（实测跨轮只命中 128 token，同一轮内前缀不变时命中 12,672，docs/06 §1）。移到末尾之后，
 * 稳定段加全部历史才构成一条逐轮只增不改的前缀。
 *
 * 仍传入数组而非裸字符串：Anthropic 的 `cache_control` 需挂在消息对象上。
 */
function stableInstructions(
  prompt: { stable: string },
  providerKind: string,
): Instructions {
  return [
    providerKind === "anthropic"
      ? {
          role: "system" as const,
          content: prompt.stable,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        }
      : { role: "system" as const, content: prompt.stable },
  ];
}

function estimateModelMessages(messages: ModelMessage[]): number {
  return estimateStructureTokens(messages);
}

function bodyForLog(value: unknown, enabled: boolean): unknown {
  return enabled ? value : undefined;
}
/** 轮次级 span 的父边（`docs/10 §1`）。合成 turn（WebUI 预览、试跑）没有根 span，此时不添加。 */
function turnParent(turn: RuntimeTurnContext): { parentSpanId?: string } {
  return turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {};
}
export interface MainAgentStreamResult {
  stream: AsyncIterable<string>;
  final: Promise<string>;
  interrupt(): void;
}

/** `result.stream` 中只处理 `text-delta`、`finish-step` 与 `error`；其余（reasoning、tool-call）一律跳过。 */
interface StreamPartLike {
  type: string;
  text?: string;
  error?: unknown;
}

/**
 * 将逐 step 的旁白拼接成一条消息，步边界处恰好一个空行。
 *
 * 收口两个历史缺陷：
 *
 * ① `result.textStream` 基于 `toTextStream`，只透出 `text-delta` 的裸字符串，`finish-step`
 *    之类的边界全部丢失 —— 投递侧的 `text += step.value` 因此把每一步的旁白无缝拼成一段
 *    （logs/2026-08-18 · turn 01M09QBZVK…）。
 * ② 补上分隔后又出现空行膨胀：KERNEL 中的段间空一行规则使模型每一步的正文都以 `\n\n\n` 结尾，
 *    而纯工具步的正文就是 `\n\n\n`。实测一条 11 步的回复（logs/2026-08-18 · turn 01M0AKMXG4…）
 *    开头 10 个换行、中段 12 个连续换行，全部是模型写出的空白被原样透传 —— 该函数并未插入
 *    任何分隔符。
 *
 * 因此判据从条件补分隔改为扣留尾部空白并在边界处补齐：
 *
 * - 一段正文的尾部空白先扣留不发送（`held`），跨过 step 边界即丢弃并替换为恰好一个 `\n\n`；
 *   未跨越边界则原样发送 —— 同一步内的增量、列表缩进、围栏代码块中的空行均不修改。
 * - 纯空白正文不计为已输出：不置 `wrote`、不标记边界、不透传。
 * - 第一段非空白正文之前不发送任何内容，流结束时扣留的尾部空白直接丢弃（首尾无空白）。
 *
 * `error` 部件同样要透出（`onError`）：AI SDK 将步骤级失败吞入内部 onError（默认实现仅
 * `console.error`），流仍正常结束 —— 此前此处显式跳过它，导致上游故障这条路径在日志中不可见，
 * 0 步的那次连 `model.error` 都未留下。
 */
export async function* stepSeparatedText(
  full: AsyncIterable<StreamPartLike>,
  trailing?: () => Promise<string>,
  onChunk?: (chunk: string) => void,
  onError?: (error: unknown) => void,
): AsyncGenerator<string> {
  let wrote = false; // 本轮是否产出过非空白正文
  let pendingBreak = false; // 上次产出正文之后已跨过 step 边界
  let held = ""; // 扣留未发送的尾部空白
  function* emit(text: string): Generator<string> {
    if (onChunk) onChunk(text);
    yield text;
  }
  for await (const part of full) {
    if (part.type === "error") {
      onError?.(part.error);
      continue;
    }
    // 到达边界后上一步的尾部空白即作废：它将被替换为恰好一个空行。连续多个空步只标记一次。
    if (part.type === "finish-step") {
      held = "";
      if (wrote) pendingBreak = true;
      continue;
    }
    if (part.type !== "text-delta" || !part.text) continue;
    const core = part.text.trim();
    if (!core) {
      if (wrote && !pendingBreak) held += part.text;
      continue;
    }
    const lead = /^\s*/.exec(part.text)![0];
    const gap = wrote ? (pendingBreak ? "\n\n" : held + lead) : "";
    yield* emit(gap + core);
    held = /\s*$/.exec(part.text)![0];
    wrote = true;
    pendingBreak = false;
  }
  // 收尾补跑（§2）同样要走这套分隔逻辑，否则它会直接紧贴在最后一句旁白之后。
  if (!trailing) return;
  const extra = (await trailing()).trim();
  if (!extra) return;
  yield* emit(wrote ? `\n\n${extra}` : extra);
}

/**
 * 主 run 的 `result_summary` 上限。它只是 trace 上的一段留痕（真正的回复走投递侧，不受它约束），
 * 与 `agent.worker.resultMaxChars` 不是同一个数：那个决定 worker 的产出有多少字进主 agent 的上下文。
 * 保持 4000 —— 改动前 `finish()` 查不到定义时用的就是这个兜底值。
 */
const MAIN_RESULT_SUMMARY_CHARS = 4000;

const WRAP_UP_INSTRUCTION =
  "工具调用已经结束，但你还没有给出结论。向用户说明结果：哪些已成功，未成功的问题出在哪里。不要再调用工具，不要复述过程。";

export async function streamMainAgent(
  turn: RuntimeTurnContext,
  dependencies: MainAgentDependencies,
): Promise<MainAgentStreamResult> {
  return runMainAgentInternal(
    turn,
    dependencies,
    true,
  ) as Promise<MainAgentStreamResult>;
}
export async function runMainAgent(
  turn: RuntimeTurnContext,
  dependencies: MainAgentDependencies,
): Promise<string> {
  return runMainAgentInternal(turn, dependencies, false) as Promise<string>;
}

async function runMainAgentInternal(
  turn: RuntimeTurnContext,
  dependencies: MainAgentDependencies,
  streaming: boolean,
): Promise<string | MainAgentStreamResult> {
  // 自撰写工具在开轮前同步进注册表：`toolSet` 在下方即冻结，轮内再注册只会让 `prepareStep` 的
  // `activeTools` 报出 `toolSet` 中不存在的名字。仅在主 agent 执行 —— worker 运行于父轮内部，
  // 在其中重新扫描会使父轮已冻结的工具集失去一致性。
  dependencies.customTools?.syncIfChanged();
  /**
   * `newToolScope()` 的三个 Set 在主 agent 与 SDK 这两侧恒为空：`load_skill` 与 `search_tools`
   * 都不在 `MAIN_AGENT_TOOLS` / `SDK_AGENT_TOOLS` 里，唯一的写入方是 worker 各自那份。留着是
   * 因为它们在 `ToolExecutionContext` 上是必填 —— 写成可选的话，惰性建出来的 Set 会落在
   * `execute()` 交给工具的那份浅拷贝上。
   *
   * `agentKind` 缺省 `'main'`（既有调用方零变化）；SDK 路径（`docs/12-sdk.md` T3.6/T3.7）传入
   * `dependencies.agentKind:'sdk'`，白名单收窄（工具目录、`activeTools`）由 `ToolRegistry`
   * 那一层依据它自行完成，本函数其余部分（模型链、`ToolLoopAgent` 步循环、ledger 记账）不分叉。
   */
  const toolContext: ToolExecutionContext = {
    turn,
    workspace: dependencies.workspace,
    agentKind: dependencies.agentKind ?? "main",
    ...newToolScope(),
  };
  // worker 从 turn 上读取同一份预留：spawn_worker 在工具层执行，无法访问此处的 dependencies。
  turn.reservation = dependencies.reservation ?? null;
  await dependencies.plugins?.hook("beforeTurn", { turn });
  // `docs/10 §1` 图中的 span B。抛出异常时同样要记录一行 —— 组装是同步的，但会读取磁盘（人格、
  // 记忆、skill 目录），不可读的 CHARACTER.md 此前在 trace 中不留任何记录。
  const promptSpan = dependencies.log.span({
    level: "debug",
    kind: "prompt.build",
    summary: `Assembled prompt for ${turn.key}`,
    traceId: turn.turnId,
    ...turnParent(turn),
    chatId: turn.chatId,
    userId: turn.initiatorUserId,
    key: turn.key,
  });
  let prompt: MainPromptAssembly;
  try {
    prompt = assembleMainPrompt(turn, dependencies, toolContext);
  } catch (error) {
    promptSpan.end(undefined, error);
    throw error;
  }
  promptSpan.end({
    blockTokens: prompt.blocks,
    total: Object.values(prompt.blocks).reduce((sum, value) => sum + value, 0),
    truncated: prompt.truncated,
  });
  const activeNames = prompt.activeTools;
  // 预算被 catalog + runtime 占满时，CHARACTER.md 会被整段截断为一句「（记忆已截断…）」，
  // 人格静默消失且日志中无任何记录（docs/20 · W-PROMPT-01）。
  if (prompt.truncated.length)
    dependencies.log.event({
      level: "warn",
      kind: "prompt.truncated",
      summary: `Prompt blocks truncated: ${prompt.truncated.join(", ")}`,
      traceId: turn.turnId,
      ...turnParent(turn),
      key: turn.key,
      data: {
        truncated: prompt.truncated,
        blocks: prompt.blocks,
        maxTokens: dependencies.config.prompt.maxTokens,
      },
    });
  const toolSet = toolSetFor(
    dependencies.tools,
    dependencies.tools.active(turn.effectiveRole, toolContext),
    toolContext,
  );
  const persistedAlias = readAppKv<string>(
    dependencies.db,
    modelAliasKey(turn.key),
  );
  const alias =
    turn.modelAliasOverride ??
    persistedAlias ??
    dependencies.config.agent.main.modelAlias;
  const mainRun = dependencies.agents?.createMain(
    turn.turnId,
    turn.effectiveRole,
    alias,
  );
  const chain = dependencies.registry.chain(alias);
  if (!chain.length) throw new Error(`model alias unavailable: ${alias}`);
  if (
    dependencies.config.quota.requirePricing &&
    turn.effectiveRole !== "owner" &&
    chain.some(
      (candidate) =>
        candidate.info.priceIn === null || candidate.info.priceOut === null,
    )
  )
    throw new Error("model_pricing_required");
  /**
   * 含图轮次的 vision 自动切换（`docs/04 §5.2`、`docs/08 §7.2`、`AC-PROV-009`）。
   *
   * 三处文档均有规定而代码中此前没有实现：`capabilities_json` 只有 WebUI 的徽章在读取。表现是
   * 用户向 `vision=false` 的模型发送图片，模型看不到图片且不知道自己看不到 —— 实测它执行
   * `cp` 复制文件、用 `python` 读取尺寸、启动本地 http 服务、用 `agent-browser` 截图，共绕行
   * 11 步（logs/2026-08-18 · turn `01M0AKMXG4…`）。它也尝试过自行调用 `set_model('vision')`，
   * 但该覆盖只在当轮生效（`docs/04 §5.2`），下一轮（真正带图的那一轮）又回到 `main`。
   *
   * 判据在轮次级计算一次：图片就在 `snapshot` 与 `delta` 中，`prepareStep` 每步重算属于浪费。
   *
   * `media.visionScope` 决定本轮含图的统计范围（默认 `window`，即两段合并统计，为既有行为）。
   * 取 `turn` 时只统计 `delta`：一张图不应使其后的每一轮都固定在 vision 别名上 —— 实测某私聊中
   * 4 条带图消息留在窗口内，此后每一轮纯文本都记录 `vision_required`（logs/2026-08-19 ·
   * `01M0CKPECYZMM…` 附近），而未配置任何 vision 别名时，那些轮次的回复末尾还会附加一句图片
   * 未被查看的提示 —— 用户那一轮根本没有发送图片。
   */
  const freshImages = turn.delta.some((message) =>
    (message.parts as unknown[]).some(isImagePart),
  );
  const historyImages = turn.snapshot.messages.some((message) =>
    (message.parts as unknown[]).some(isImagePart),
  );
  const turnHasImages =
    dependencies.config.media.visionScope === "turn"
      ? freshImages
      : freshImages || historyImages;
  // 只有完全无法处理图像时才降级：未配置 `vision` 别名，且当前别名本身也不支持。
  const visionDegraded =
    turnHasImages &&
    !dependencies.registry.supportsVision("vision") &&
    !dependencies.registry.supportsVision(alias);
  if (visionDegraded)
    dependencies.log.event({
      level: "warn",
      kind: "provider.fallback",
      summary: `${alias} 不支持看图且无 vision 别名`,
      traceId: turn.turnId,
      key: turn.key,
      data: { alias, reason: "vision_unavailable" },
    });
  /**
   * `visionScope='turn'` 的另一半：本轮没有新图，因此不切换别名 —— 那么更早轮次留在窗口内的
   * 图片也不能原样发给这个不支持图像的模型（宽容的 provider 静默忽略、严格的直接返回 400）。
   * 判据只看本轮实际使用的别名是否支持：支持则原样带上，用户要求重看上文图片的场景照常可用。
   * `visionDegraded` 优先 —— 该档位本就将两段一并替换，再叠加一次没有意义。
   */
  const historyDegraded =
    !visionDegraded &&
    historyImages &&
    !freshImages &&
    dependencies.config.media.visionScope === "turn" &&
    !dependencies.registry.supportsVision(alias);
  if (historyDegraded)
    dependencies.log.event({
      level: "info",
      kind: "ctx.image_placeholder",
      summary: `${alias} 不支持看图，历史图片替换为占位文本`,
      traceId: turn.turnId,
      ...turnParent(turn),
      key: turn.key,
      data: { alias, scope: "turn", reason: "history_only" },
    });
  // 步骤级失败（上游 5xx、重试耗尽）不会从 textStream 抛出：AI SDK 将其吞入内部 onError，
  // 使 result.text 静默解析为空串。不捕获这一份的话，彻底的上游故障与模型无输出在调用方看来
  // 完全相同 —— 上一次事故正是由此表现为不回复。
  let streamFailure: unknown = null;
  // 收尾补跑（§2）的三个状态：最后一步是否有正文、本轮是否执行过操作、当前是否正处于补跑。
  let lastStepHadText = false;
  let sawToolCall = false;
  let wrapUpMode = false;
  /** 主轮已执行的步数。补跑那次 `agent.generate` 的 stepNumber 从 0 重新计数，据此换算为全轮编号。 */
  let mainStepCount = 0;
  /**
   * 记录第一份步骤级失败，并写入一条 `model.error`。`onExhausted` 路径自身会记录，其余两条
   * 此前不留任何记录：流中的 `error` 部件（SDK 默认 onError 仅 `console.error`）以及 0 步空流。
   * 两次进程崩溃（logs/2026-08-18 22:17 / 23:19）因此在 `model.jsonl` 中完全不可见。
   */
  const noteStreamFailure = (error: unknown): void => {
    if (streamFailure) return;
    streamFailure = error;
    dependencies.log.event({
      level: "error",
      kind: "model.error",
      summary:
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 300)
          : String(error).slice(0, 300),
      traceId: turn.turnId,
      key: turn.key,
      data: {
        alias,
        modelId:
          dependencies.registry.info(alias)?.modelId ?? initialInfo.modelId,
        source: "stream",
      },
    });
  };
  const initialInfo = chain[0]!.info;
  // 包装必须做在按别名解析这一层：`prepareStep` 每一步都无条件设置 model，若只包装构造时的那个，
  // 整条 fallback / 重试链从第 0 步起即不再被使用 —— 重试次数、别名 fallback、markProviderDown，
  // 以及区分上游故障与模型无输出所依赖的 onExhausted 全部成为死代码（docs/20 · W-AGENT-01）。
  const wrapped = new Map<string, LanguageModel>();
  // 包装之后 `step.model.modelId` 恒等于链首，无法看出本步实际由谁服务。中间件上报一份，
  // 记账才能落到真正提供服务的模型上（计价、别名、markProviderDown 均依赖它）。
  let servedModelId: string | null = null;
  const wrappedFor = (aliasName: string): LanguageModel => {
    const cached = wrapped.get(aliasName);
    if (cached) return cached;
    const built = aliasModel(dependencies.registry, aliasName, {
      maxRetries: dependencies.config.provider.maxRetries,
      retryBaseMs: dependencies.config.provider.retryBaseMs,
      retryMaxMs: dependencies.config.provider.retryMaxMs,
      abortSignal: turn.abortSignal,
      requestTimeoutMs: dependencies.config.provider.requestTimeoutMs,
      streamIdleTimeoutMs: dependencies.config.provider.streamIdleTimeoutMs,
      // 服务成功表明上游仍在响应，连续失败计数归零（`docs/04 §5.3`）。常态下是一次 no-op 写入。
      onServed: (served) => {
        servedModelId = served.id;
        dependencies.registry.recordSuccess(served);
      },
      isDown: (candidate) => dependencies.registry.isDown(candidate),
      // 跳过行为必须留下记录，且 `to` 上报的是实际将被尝试的候选（docs/10 · provider.fallback）。
      onSkipped: (candidate, next) => {
        dependencies.log.event({
          level: "warn",
          kind: "provider.fallback",
          summary: `${candidate.id} 已判 down，跳过${next ? ` → ${next.id}` : ""}`,
          traceId: turn.turnId,
          key: turn.key,
          data: {
            alias: aliasName,
            from: candidate.id,
            to: next?.id ?? null,
            reason: "skipped_down",
          },
        });
      },
      // 每一次失败尝试记录一行（`docs/10` 为 `model.error` 定义的 `retryAttempt` / `willFallback`）。
      // 缺少它时，三次超时后才 fallback 的过程在日志中是一段空白：本次事故的 363 秒内只有开头的
      // `turn.start` 与结尾的 `provider.fallback`（docs/00 §2.3 属同类）。
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
          key: turn.key,
          data: {
            alias: aliasName,
            modelId: candidate.id,
            errorKind: failure.kind,
            status: failure.status,
            retryAttempt: failure.attempt,
            willRetry: failure.willRetry,
            willFallback: failure.willFallback,
            ms: failure.elapsedMs,
          },
        });
        // 只有超时计入连续失败。5xx / 429 表明上游仍在响应，链内 fallback 会立即更换候选，代价
        // 仅一次往返；真正昂贵的是连接成功但不返回 —— 每一步都要耗满
        // `(maxRetries+1) × requestTimeoutMs`。且一次调用中同一候选只记一次：仍会重试时先不记录。
        // 按尝试计数的话，`maxRetries: 2` 时一次请求即产生三次增量，一个合法超过 `requestTimeoutMs`
        // 的调用（定时任务、worker、收尾补跑均走非流式，`deadline.guard` 覆盖的是整段生成）
        // 会立即将整个 provider 判死 30 分钟。
        if (failure.kind !== "timeout" || failure.willRetry) return;
        const down = dependencies.registry.recordFailure(
          candidate,
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error),
          PROVIDER_FAILURES_TO_DOWN,
        );
        if (down) {
          dependencies.log.event({
            level: "error",
            kind: "provider.health",
            summary: `${candidate.id} 连续超时，已标 down 并从模型链跳过`,
            traceId: turn.turnId,
            data: {
              modelId: candidate.id,
              state: "down",
              reason: "request_timeout",
            },
          });
        }
      },
      // 该回调此前没有任何消费方 —— `provider.fallback` 是 `docs/10` 中有定义但生产侧无任何产出的
      // 事件，导致链首耗尽后切换到了哪个候选在日志中无法读出（本次事故中靠推算还原的那一半）。
      onFallback: (from, to) => {
        dependencies.log.event({
          level: "warn",
          kind: "provider.fallback",
          summary: `${from.id} 重试用尽仍失败，切换至 ${to.id}`,
          traceId: turn.turnId,
          key: turn.key,
          data: {
            alias: aliasName,
            from: from.id,
            to: to.id,
            reason: "candidate_exhausted",
          },
        });
      },
      onUnavailable: (candidate, error) => {
        dependencies.registry.markProviderDown(
          candidate.id,
          error instanceof Error ? error.message : "authentication_failed",
        );
        dependencies.log.event({
          level: "error",
          kind: "provider.health",
          summary: `${candidate.id} credentials rejected`,
          traceId: turn.turnId,
          data: { modelId: candidate.id },
        });
      },
      onExhausted: (error) => {
        streamFailure ??= error;
        dependencies.log.event({
          level: "error",
          kind: "model.error",
          summary:
            error instanceof Error
              ? `${error.name}: ${error.message}`.slice(0, 300)
              : String(error).slice(0, 300),
          traceId: turn.turnId,
          key: turn.key,
          data: {
            alias: aliasName,
            modelId:
              dependencies.registry.info(aliasName)?.modelId ??
              initialInfo.modelId,
            cause:
              error instanceof Error && error.cause instanceof Error
                ? error.cause.message.slice(0, 300)
                : undefined,
          },
        });
      },
    });
    wrapped.set(aliasName, built);
    return built;
  };
  const model = wrappedFor(alias);
  const providerKind =
    (dependencies.db
      .prepare("SELECT kind FROM providers WHERE id=?")
      .pluck()
      .get(initialInfo.providerId) as string) ?? "";
  const instructions = stableInstructions(prompt, providerKind);
  // 同一轮中 `contextMessages` 最多被调用三次（主流程 / 收尾补跑 / 非流式），损坏历史只上报一次。
  let reportedOrphans = false;
  const messageOptions: ContextMessageOptions = {
    volatile: prompt.volatile,
    cacheBreakpoint: providerKind === "anthropic",
    ...(visionDegraded
      ? { degradeImages: "all" as const }
      : historyDegraded
        ? { degradeImages: "history" as const }
        : {}),
    onOrphanToolCalls: (toolCallIds) => {
      if (reportedOrphans) return;
      reportedOrphans = true;
      dependencies.log.event({
        level: "warn",
        kind: "ctx.orphan_tool_call",
        summary: `Repaired ${toolCallIds.length} tool-call(s) with no result`,
        traceId: turn.turnId,
        key: turn.key,
        data: { toolCallIds: toolCallIds.slice(0, 20) },
      });
    },
  };
  const stepSpans = new Map<number, LogSpan>();
  const stepAlias = new Map<number, string>();
  /** vision 切换每轮只记录一条：`prepareStep` 每一步都会重算出同一结论。 */
  let visionSwitchLogged = false;
  const observers = createStepObservers(turn, {
    ledger: dependencies.ledger,
    registry: dependencies.registry,
    context: dependencies.context,
    log: dependencies.log,
    quota: dependencies.quota,
    reservation: dependencies.reservation ?? null,
    tokenRatioAlpha: dependencies.config.context.tokenRatioAlpha,
    fallbackInfo: initialInfo,
    aliasForStep: (stepNumber) => stepAlias.get(stepNumber) ?? alias,
  });
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: toolSet,
    activeTools: activeNames,
    // 重试与 fallback 由 `fallbackLanguageModel` 负责（它识别 Retry-After、带随机抖动、401 短路、
    // 链内切换模型）。SDK 默认会额外重试 2 次，两层相乘意味着同一次故障需耗满
    // 3×(候选数×尝试数) 次上游超时才结束 —— logs/2026-08-17 的几轮卡死即由此产生：
    // fallback→model.error 的 62 秒节拍完整走了两遍，第三遍仍在等待时用户已重启进程。
    maxRetries: 0,
    /**
     * 第二条判据是收尾补跑的硬边界：`docs/00 §2` 与 `docs/08 §5.2` 均规定追加一次禁用工具的
     * 模型调用，而 `agent.generate(...)` 是 `ToolLoopAgent` 的整个循环 —— 实测上游在 `tools:[]`
     * 的请求中仍返回 tool_calls，收尾阶段又执行了 12 步（`steps=24`），最终得到
     * `turn.wrap_up chars=0` 与 `model_returned_empty`。真实模型通常不会如此，但最多一次是
     * 判据而非预期；`perTurn.maxCostUsd` 只是兜底（docs/28 · L-AGT-01）。
     * `stopWhen` 不是 per-call 选项，而 `wrapUpMode` 仅在补跑期间为真，因此判据置于此处；
     * 补跑调用的 `steps` 独立计数（从 0 起，与 `mainStepCount` 的重编号一致）。
     */
    stopWhen: [
      stepCountIs(
        Math.min(
          dependencies.config.agent.main.maxSteps,
          dependencies.config.quota.perTurn.maxSteps,
        ),
      ),
      ({ steps }) => wrapUpMode && steps.length >= 1,
    ],
    include: { requestMessages: true, requestBody: true, responseBody: true },
    prepareStep: async ({ stepNumber: rawStep, messages }) => {
      // 收尾补跑是另一次 `agent.generate`，其 stepNumber 从 0 重新计数。不换算会导致：
      // ① `stepSpans.set(0, …)` 覆盖主轮 step 0 那条已结束的 span（出错时还会被 end 第二次）；
      // ② `stepAlias.set(0, …)` 改写 step 0 实际使用的别名，记账落到错误的模型上；
      // ③ `downgrade` 判据回到 0，从 step 8 起就在使用 low 的会话，其最终结论反而按主别名计价。
      const stepNumber = wrapUpMode ? mainStepCount + rawStep : rawStep;
      await dependencies.plugins?.hook("beforeModelCall", {
        turn,
        step: stepNumber,
      });
      // 不传展开集、也不再做 skill 收窄：`search_tools` 与 `load_skill` 都不在 `MAIN_AGENT_TOOLS`
      // 里，主 agent 这一侧两者都没有写入方，渐进披露整体在 worker 那边（`agent/subagent.ts`）。
      const activeForStep = dependencies.tools
        .activeNamesForStep(turn.effectiveRole, toolContext)
        // 护栏：`toolSet` 在开轮时即冻结，而这一行计算出的合格集每步都是实时的。轮中 MCP
        // reconcile 新接入一台 server、或热更新放宽了 `tools.overrides`，都会使实时集合中出现
        // 冻结集之外的名字。此前只有自撰写工具一条路做了防护（开轮前 `syncIfChanged`）。
        //
        // ⚠ 该交集在 ai@7.0.65 上的作用是明确语义，而非防止崩溃：`filterActiveTools`
        // （`ai/dist/index.js`）执行的是 `Object.entries(tools).filter(([n]) => activeTools.includes(n))`
        // —— 纯交集，多报的名字被静默丢弃，SDK 不给出任何提示。因此真正的问题不是报错而是结果
        // 失真：`search_tools` 会对轮中新挂载的工具返回 `status:'expanded'`，而它根本不在冻结的
        // toolSet 中，本轮永远无法发出。显式写出这道交集，是为了让本步可发出的工具集只有一个
        // 答案，也为了不把正确性寄托于某个 SDK 版本恰好采用了宽容语义。
        .filter((name) => name in toolSet);
      const requestedAlias = turn.modelAliasOverride ?? alias;
      const downgrade =
        stepNumber >= dependencies.config.agent.main.downgradeAfterStep &&
        dependencies.registry.aliases().includes("low");
      let selectedAlias = downgrade ? "low" : requestedAlias;
      // vision 优先级高于其它一切（`docs/04 §5.2`）：`low` 大概率不支持图像，`set_model` 指定的
      // 别名同样可能不支持 —— 不支持图像的模型拿到这一轮只能猜测或绕行。优先取 `vision`，
      // 其次取降档前那个自身即支持的别名：为省成本而降档却牺牲图像能力是最不划算的取舍。
      // `turn.mediaInjected` 表示轮内注入的图像（`web_fetch` 抓取的图、MCP 的截图）。
      // `turnHasImages` 只是轮首快照，结构上无法识别它 —— 而这一步正是该图被读取的一步：
      // step N 调用 web_fetch → 图片附着在工具结果上 → step N+1 的请求体中携带它。不在此处补判
      // 一次，该图就会落在不支持图像的别名上（`docs/08 §7.2` 禁止的正是这一情形）。
      if (
        (turnHasImages || turn.mediaInjected) &&
        !dependencies.registry.supportsVision(selectedAlias)
      ) {
        // 候选中包含 `alias`（本轮解析出的那个）：`set_model('low')` 替换 `requestedAlias` 之后，
        // 降档前的别名只剩它。
        const seeing = ["vision", requestedAlias, alias].find((name) =>
          dependencies.registry.supportsVision(name),
        );
        if (seeing) {
          if (!visionSwitchLogged) {
            visionSwitchLogged = true;
            dependencies.log.event({
              level: "info",
              kind: "provider.fallback",
              summary: `${selectedAlias} → ${seeing}`,
              traceId: turn.turnId,
              key: turn.key,
              data: {
                alias: selectedAlias,
                from: selectedAlias,
                to: seeing,
                reason: "vision_required",
              },
            });
          }
          selectedAlias = seeing;
        }
      }
      // 采样参数取自当步实际选中的别名：降档到 low 之后即应使用 low 的参数（04 §5.2.1）。
      stepAlias.set(stepNumber, selectedAlias);
      const patch: {
        activeTools?: string[];
        model?: LanguageModel;
        messages?: ModelMessage[];
        toolChoice?: "none";
      } & AliasSettings = {
        activeTools: activeForStep,
        model: wrappedFor(selectedAlias),
        ...dependencies.registry.settings(selectedAlias),
      };
      // 单轮成本闸门读取 ledger：`reservation.committed` 只包含主 agent 的花费，子 agent 全部遗漏
      // （docs/20 · W-QUOTA-01）。`turnCost` 已将主 agent 与该轮所有子 agent 的花费一并计入。
      const cost = dependencies.ledger.turnCost(turn.turnId);
      if (
        cost >= dependencies.config.quota.perTurn.maxCostUsd ||
        (dependencies.quota &&
          dependencies.reservation &&
          !dependencies.quota.canSpend(
            dependencies.reservation,
            dependencies.config.quota.perTurn.maxCostUsd,
          ))
      ) {
        patch.activeTools = [];
        patch.toolChoice = "none";
      }
      // 收尾补跑（§2）复用同一条禁用工具的路径，不另建一套：该次调用只允许输出文本，若再调用
      // 工具就可能再次以工具调用收尾，重复同一问题。
      if (wrapUpMode) {
        patch.activeTools = [];
        patch.toolChoice = "none";
      }
      // 推理条目一律不回传。openai responses provider 会将上一步的 reasoning 写成
      // `{type:'item_reference', id:'rs_…'}` —— 该内容存于 OpenAI 服务端，第三方兼容网关没有，
      // 无法解析即导致整个请求 502。表现为模型一旦调用工具就不再输出文本：后续那一步重试三次
      // 全部失败，而 AI SDK 将 RetryError 吞为空结果，调用方只看到无任何生成。
      // reasoning 本就只在一轮的步骤之间有意义（不写入上下文），摘除它换来的是工具调用之后仍有回复。
      patch.messages = pruneMessages({ messages, reasoning: "all" });
      /**
       * 当步别名不支持图像时，请求体中也不能保留不透明 part。上面的 vision 覆盖只在
       * `turnHasImages` 为真时生效；`media.visionScope='turn'` 下「窗口内有图但本轮无新图」
       * 恰好是它不为真的档位 —— 而 `downgradeAfterStep` 到点降为 `low`（或 `set_model('low')`）
       * 同样会把不支持图像的模型置于仍带历史图的请求之前，正是 `docs/08 §7.2` 禁止的情形。
       * `window` 档下此处恒为 no-op：那时要么已切换到支持图像的别名，要么 `visionDegraded`
       * 已将两段图片全部替换为文本。判据包含本轮是否有图 —— 纯文本轮次无需查询能力位。
       *
       * `mediaInjected` 同样要计入：轮内注入的 `webasset://` part 就在 `turn.delta` 中，
       * 下一轮它是历史图，而本轮它已进入 `messages`（`contextMessages` 会物化 delta）。
       * 遗漏它意味着上面的别名切换未找到支持图像的别名时，这道兜底也失效。
       */
      if (
        (freshImages || historyImages || turn.mediaInjected) &&
        !dependencies.registry.supportsVision(selectedAlias)
      )
        patch.messages = degradeImageParts(patch.messages);
      const selected = dependencies.registry.info(selectedAlias) ?? initialInfo;
      const cap =
        selected.contextWindow * dependencies.config.context.hardCapRatio;
      if (estimateModelMessages(patch.messages) > cap) {
        patch.messages = pruneMessages({
          messages: patch.messages,
          toolCalls: "before-last-3-messages",
          emptyMessages: "remove",
        });
        dependencies.log.event({
          level: "warn",
          kind: "ctx.hardcap",
          summary: "Pruned in-flight model messages",
          traceId: turn.turnId,
          key: turn.key,
          data: {
            stepNumber,
            cap,
            before: estimateModelMessages(messages),
            after: estimateModelMessages(patch.messages),
          },
        });
      }
      return patch;
    },
    onStepStart: (event) => {
      const stepNumber = wrapUpMode
        ? mainStepCount + event.stepNumber
        : event.stepNumber;
      const span = dependencies.log.span({
        level: "info",
        kind: "model.call",
        summary: `${event.provider}/${event.modelId}`,
        traceId: turn.turnId,
        ...turnParent(turn),
        chatId: turn.chatId,
        userId: turn.initiatorUserId,
        key: turn.key,
        data: {
          stepNumber,
          wrapUp: wrapUpMode || undefined,
          modelId: event.modelId,
          provider: event.provider,
          messages: bodyForLog(
            event.messages,
            dependencies.config.logs.captureBodies,
          ),
          instructions: bodyForLog(
            event.instructions,
            dependencies.config.logs.captureBodies,
          ),
        },
      });
      stepSpans.set(stepNumber, span);
      // 本步的工具调用挂在这条 `model.call` 之下（`docs/10 §1` 的第二条边）。步是串行执行的，
      // 因此原地修改该项是安全的；同一步内并行的工具调用共享同一个父，这正是它们的真实关系。
      toolContext.parentSpanId = span.id;
      dependencies.log.publish("turn.progress", {
        turnId: turn.turnId,
        phase: "model",
        step: stepNumber,
        note: `${event.provider}/${event.modelId}`,
      });
    },
    // 四项职责拆成四个可单独注入合成 step 的观察者（`step-observers.ts`，docs/27 · D-05）。
    // 此处只保留将 AI SDK 的 step 映射为 StepFacts 的适配层 —— 该 step 类型无法手工构造，
    // 而记账 / 广播 / 上下文 / 校准实际需要的只有十余个字段。
    onStepEnd: (step) => {
      const stepNumber = wrapUpMode
        ? mainStepCount + step.stepNumber
        : step.stepNumber;
      if (!wrapUpMode)
        mainStepCount = Math.max(mainStepCount, step.stepNumber + 1);
      const facts: StepFacts = {
        stepNumber,
        servedModelId: servedModelId ?? step.model.modelId,
        usage: {
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
          cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
          // `inputTokens` 是总量（超集），计价须用这份互斥值。三家 provider 表现一致，见 `pricedInputTokens`。
          noCacheTokens:
            step.usage.inputTokenDetails.noCacheTokens ?? undefined,
          reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0,
        },
        latencyMs: step.performance.responseTimeMs,
        finishReason: step.finishReason,
        toolCalls: step.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })),
        toolResults: stepToolResults(step.content),
        requestBody: (step.request as { body?: unknown } | undefined)?.body,
      };
      // 收尾判据取自最后一步，因此每步覆写而非累积。`sawToolCall` 则需累积：它判定本轮是否
      // 执行过操作，只有执行过才值得补一句结论。
      lastStepHadText = step.text.trim() !== "";
      if (step.toolCalls.length) sawToolCall = true;
      // `turns.steps` 此前没有任何写入方（全库 steps>0 的行数为 0），WebUI 轮次列表与
      // `turn.finished` 事件中该数值恒为 0 —— 本次排查因此只能翻查 blob 还原步骤。
      // 使用换算后的编号：收尾补跑那一步同样产生了真实开销，不应在该计数中缺失。
      dependencies.turns?.countStep(turn.turnId, stepNumber + 1);
      const resolved = observers.record(facts);
      observers.broadcast(facts, resolved);
      /**
       * 摘要写入真正提供服务的候选，而非链首。`onStepStart` 拿到的 `event.provider/modelId`
       * 是 AI SDK 可见的模型，而链内 fallback 发生在 `fallbackLanguageModel` 中间件内部
       * （`wrapLanguageModel` 使 SDK 可见的永远是链首）—— 实测链 `fake-bad → deepseek-v4-flash`
       * 时日志记录 `rig-fake-bad.chat/fake-bad`、`usage_ledger` 记录 `deepseek-v4-flash@ksm-api`，
       * 同一次调用在两处指向不同的 provider（docs/28 · L-PROV-01）。`resolved` 来自 `onServed`
       * 上报的 `servedModelId`，即真实服务方；`docs/10 §7` 第 3 条要求摘要中可见，
       * 因此此处用 `end()` 的 override 修改该列（`summary` 是列而非载荷）。
       */
      const fellBack = facts.servedModelId !== step.model.modelId;
      stepSpans.get(stepNumber)?.end(
        {
          model: step.model,
          servedProvider: resolved.info.providerId,
          servedModelId: resolved.info.modelId,
          alias: resolved.alias,
          usage: step.usage,
          cost: resolved.cost,
          request: bodyForLog(
            step.request,
            dependencies.config.logs.captureBodies,
          ),
          response: bodyForLog(
            step.response,
            dependencies.config.logs.captureBodies,
          ),
        },
        undefined,
        {
          summary: `${resolved.info.providerId}/${resolved.info.modelId}${fellBack ? ` ← fallback from ${step.model.modelId}` : ""}`,
          ...(fellBack ? { level: "warn" as const } : {}),
        },
      );
      for (const failure of stepToolErrors(step.content))
        dependencies.log.event({
          level: "warn",
          kind: "tool.error",
          summary: `${failure.toolName ?? "unknown"}: ${failure.message}`.slice(
            0,
            300,
          ),
          traceId: turn.turnId,
          ...(stepSpans.get(stepNumber)
            ? { parentSpanId: stepSpans.get(stepNumber)!.id }
            : {}),
          chatId: turn.chatId,
          userId: turn.initiatorUserId,
          key: turn.key,
          data: {
            tool: failure.toolName,
            toolCallId: failure.toolCallId,
            errorKind: failure.errorKind,
            message: failure.message.slice(0, 500),
          },
        });
      observers.appendContext(facts);
      observers.calibrate(facts);
    },
  });
  /**
   * 最后一步只有 reasoning 或只有工具调用时，补跑一次收尾（§2）。四道闸全部通过才执行，最多一次：
   * ① 最后一步没有正文；② 本轮确实执行过操作；③ 上游未故障（`streamFailure` 非空时再跑一次
   * 只会继续消耗成本）；④ 单轮成本闸仍有余量。不伪造答复 —— 由模型自行写出结论（docs/16 §5）。
   */
  const wrapUpIfNeeded = async (): Promise<string> => {
    if (lastStepHadText || !sawToolCall || streamFailure) return "";
    if (
      dependencies.ledger.turnCost(turn.turnId) >=
      dependencies.config.quota.perTurn.maxCostUsd
    )
      return "";
    if (turn.abortSignal.aborted) return "";
    wrapUpMode = true;
    try {
      // 不要再拼入 `result.responseMessages`：`observers.appendContext` 每一步都已将
      // tool-call / tool-result 追加进 `turn.delta`，而 `contextMessages` 读取的正是
      // `snapshot + delta` —— 再拼一遍会使同一个 `toolCallId` 出现两次，Anthropic 直接返回 400，
      // 该补跑于是永远静默失败；宽容的 provider 则会为每份工具输出重复计费。
      // 收尾指令置于易变段内部而非追加为新消息：KERNEL 规定只有请求末尾的那个 system-instructions
      // 块可信，在其后再挂一个等于让模型把自己的 RUNTIME、权限行与工具目录当作伪造的用户正文
      // （同时也保住了易变段位于物理末尾这一缓存前提）。
      const messages = contextMessages(turn, dependencies.db, {
        ...messageOptions,
        volatile: `${prompt.volatile}\n\n${WRAP_UP_INSTRUCTION}`,
      });
      const wrapped = await agent.generate({
        messages,
        abortSignal: turn.abortSignal,
      });
      const text = wrapped.text.trim();
      dependencies.log.event({
        level: "warn",
        kind: "turn.wrap_up",
        summary: text
          ? "Wrapped up a turn that ended without text"
          : "Wrap-up produced nothing",
        traceId: turn.turnId,
        key: turn.key,
        data: { chars: text.length },
      });
      return text;
    } catch (error) {
      // 补跑失败不能影响整轮：旁白已发送，此处抛出会让用户既看到回复又收到本轮失败的提示。
      dependencies.log.event({
        level: "warn",
        kind: "turn.wrap_up",
        summary: "Wrap-up call failed",
        traceId: turn.turnId,
        key: turn.key,
        data: {
          error:
            error instanceof Error
              ? error.message.slice(0, 300)
              : String(error).slice(0, 300),
        },
      });
      return "";
    } finally {
      wrapUpMode = false;
    }
  };
  try {
    if (streaming) {
      const result = await agent.stream({
        messages: contextMessages(turn, dependencies.db, messageOptions),
        abortSignal: turn.abortSignal,
      });
      let settled = false;
      const finish = (text: string): string => {
        if (!settled && mainRun)
          dependencies.agents?.finish(mainRun, text, MAIN_RESULT_SUMMARY_CHARS);
        settled = true;
        return text;
      };
      const fail = (error: unknown): never => {
        if (!settled && mainRun)
          dependencies.agents?.fail(
            mainRun,
            error instanceof Error ? error.message : String(error),
          );
        settled = true;
        throw error;
      };
      // `final` 必须绑定在流结束上，而非直接绑定 `result.text`：收尾补跑发生在流耗尽之后，
      // 而 `result.text` 在此之前已 resolve —— 直接绑定会每次都读到补跑之前的空串。
      let streamDone!: () => void;
      const drained = new Promise<void>((resolve) => {
        streamDone = resolve;
      });
      let wrapUp = "";
      let delivered = (): string => "";
      // 空正文加上已捕获的步骤失败，表明是上游故障而非模型无输出。抛出真实原因，
      // 使轮次记为 failed 并向用户给出可理解的说明，而不是含糊的未产出正文。
      const final = drained
        .then(() => result.text)
        .then((text) => {
          if (!text.trim() && streamFailure) throw streamFailure;
          // `result.text` 是 AI SDK v7 的最后一步正文，而非全轮拼接。最后一步以工具调用收尾时
          // 它即为空串，此前 `bot.ts` 因此回落到将过程旁白当作答复（本次事故）。
          // 触发补跑时使用整条已发送的文本（旁白 + 分隔 + 结论），而非仅结论段：归档与上下文
          // 存储的必须是用户屏幕上的那条消息，否则下一轮模型看不到自己的旁白，用户引用其中某段
          // 时将无法对应。
          return text.trim() ? text : delivered();
        })
        .then(finish, fail);
      /**
       * `final` 必须在创建处即被认领。
       *
       * `fail` 会 rethrow，因此这条链会 reject；唯一的 catch 位于 `bot.ts`，且全部排在
       * `await output.consume(...)` 之后 —— `consume` 开头还阻塞在 `sendChatAction`（实测 561ms）。
       * 中间这段即为无人认领的窗口：返回 0 步时 AI SDK 在 flush 中用 `NoOutputGeneratedError`
       * reject `result.text`（那是 `steps.then().then()` 的派生 promise，SDK 只将基础 promise 标为
       * handled），`main.ts` 的 unhandledRejection 处理器于是先一步终止进程 —— `bot.ts` 的三处
       * catch 一次都未执行，`model.error` 也来不及写入。
       * 实测 logs/2026-08-18 22:17:29 与 23:19:43，两次均发生在 `sendChatAction` 结束后 1ms。
       *
       * 认领后语义不变：`bot.ts` 中的 `await generated.final` 照旧得到该 rejection
       * （已被观测的 promise 再次 await 同样抛出）。
       */
      void final.catch(() => undefined);
      let emitted = "";
      const stream = stepSeparatedText(
        result.stream as AsyncIterable<StreamPartLike>,
        async () => {
          /**
           * 一步都未完成表明上游返回了空流，而非模型无输出。`fallback-model` 的 `reporting()`
           * 只在 `doStream` 抛出时上报 `onExhausted`；中转站返回 200 但流内 0 步即关闭这条路径
           * 既不抛出也不触发 `idleGuarded`，于是 `streamFailure` 恒为 null、日志中没有任何
           * `model.error`，用户只看到沉默。补上这一条后它走下方既有的 `broken` 路径：
           * 轮次记为 failed、用户得到可理解的原因、日志中有 `model.error`。
           * 必须排在 `wrapUpIfNeeded` 之前 —— 那里的第一道闸即读取 `streamFailure`。
           */
          if (mainStepCount === 0 && !turn.abortSignal.aborted)
            noteStreamFailure(new Error("upstream_no_output"));
          // `wrapUpIfNeeded` 自身吞掉全部异常，此处不会因它而将流记为 interrupted。
          try {
            wrapUp = await wrapUpIfNeeded();
          } finally {
            streamDone();
          }
          /**
           * 中断的轮次必须让投递侧感知。步骤级失败与轮次中止都不会使 `result.stream` 抛出：
           * AI SDK 将其吞入内部 onError，流照常正常结束，而 `result.text` 仍是上一步的正文
           * —— 于是已输出内容后中断这条路径在 `bot.ts` 看来与正常收尾完全相同：用户既不会看到
           * 「（生成中断）」也没有超时提示，`turns` 那行还记为 committed。实测
           * logs/2026-08-18 · B8F92Z：600 秒到点 abort（`model.error timeout`），3 分钟后
           * `turn.end turn committed`。此处抛出即对应 `TelegramOutput.consume` 的 `interrupted`，
           * 也就是 docs/04 §5.3 所述已输出部分内容后失败的路径。
           *
           * 抛出前先调用 `fail`：`streamDone()` 已释放 `drained`，`final` 链在下一个微任务即会用
           * `finish` 将 agent run 记为完成 —— 不在同一同步块内抢先置位 `settled`，`agent_runs`
           * 会记录本次子运行成功。被丢弃的 `wrapUp` 恒为空串（中断时 `wrapUpIfNeeded` 第一道闸
           * 即返回）。
           */
          const broken = turn.abortSignal.aborted
            ? (turn.abortSignal.reason ?? "aborted")
            : streamFailure;
          if (broken)
            fail(broken instanceof Error ? broken : new Error(String(broken)));
          // 图片降级提示走同一条收尾通道（`docs/08 §7.2` 要求其位于回复末尾）：
          // 仅为追加一行文本另开一条 core→telegram 通道，会使两侧各多出一个概念。
          if (visionDegraded)
            return wrapUp
              ? `${wrapUp}\n\n${VISION_UNSUPPORTED_NOTICE}`
              : VISION_UNSUPPORTED_NOTICE;
          return wrapUp;
        },
        (chunk) => {
          emitted += chunk;
        },
        noteStreamFailure,
      );
      // 尾部只要实际追加过内容（补跑的结论，或图像不支持的提示），`final` 就应是整条已发送的
      // 文本而非最后一步的正文 —— 归档与上下文存储的内容必须与用户屏幕一致。
      delivered = () => (wrapUp || visionDegraded ? emitted : "");
      // `interrupt()` 同样要释放 `drained`：被打断的路径（`bot.ts` 中的
      // `void generated.final.catch()`）不会再读完生成器，不释放会使该 promise 永久挂起。
      return {
        stream,
        final,
        interrupt: () => {
          streamDone();
          if (!settled && mainRun)
            dependencies.agents?.fail(mainRun, "stream_interrupted");
          settled = true;
        },
      };
    }
    const result = await agent.generate({
      messages: contextMessages(turn, dependencies.db, messageOptions),
      abortSignal: turn.abortSignal,
    });
    // 非流式路径（定时任务走这条）同样受 `result.text` 等于最后一步正文这一语义影响：以工具调用
    // 收尾的定时任务此前会得到空正文 → `model_returned_empty`，整条任务静默失败。
    // 非流式路径也要附带该提示：这条路径同样可能收到图片（被回复消息中的那张）。
    const withVisionNotice = (text: string): string =>
      visionDegraded && text.trim()
        ? `${text}\n\n${VISION_UNSUPPORTED_NOTICE}`
        : text;
    if (!result.text.trim()) {
      const wrapUp = withVisionNotice(await wrapUpIfNeeded());
      if (wrapUp) {
        if (mainRun)
          dependencies.agents?.finish(
            mainRun,
            wrapUp,
            MAIN_RESULT_SUMMARY_CHARS,
          );
        return wrapUp;
      }
    }
    if (!result.text.trim() && streamFailure) throw streamFailure;
    const answer = withVisionNotice(result.text);
    if (mainRun)
      dependencies.agents?.finish(mainRun, answer, MAIN_RESULT_SUMMARY_CHARS);
    return answer;
  } catch (error) {
    if (mainRun)
      dependencies.agents?.fail(
        mainRun,
        error instanceof Error ? error.message : String(error),
      );
    for (const span of stepSpans.values()) span.end(undefined, error);
    const info = initialInfo;
    dependencies.ledger.record({
      turnId: turn.turnId,
      chatId: turn.chatId,
      userId: turn.initiatorUserId,
      providerId: info.providerId,
      modelId: info.modelId,
      modelAlias: alias,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      priceIn: info.priceIn,
      priceOut: info.priceOut,
      priceCacheRead: info.priceCacheRead,
      priceCacheWrite: info.priceCacheWrite,
      latencyMs: 0,
      ok: false,
      errorKind: error instanceof Error ? error.name : "unknown",
      sourceId: turn.sourceId ?? TELEGRAM_SOURCE_ID,
    });
    throw error;
  }
}
