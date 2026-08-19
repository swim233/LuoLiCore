import { createAnthropic } from '@ai-sdk/anthropic';
import { readFileSync } from 'node:fs';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, pruneMessages, stepCountIs, tool } from 'ai';
import type { Instructions, LanguageModel, ModelMessage, Provider, ToolSet } from 'ai';
type V4LanguageModel = Exclude<LanguageModel, string> & { specificationVersion: 'v4' };
import type { Config } from '../config/schema.js';
import type { Sqlite } from '@luoli/db';
import { modelAliasKey, readAppKv } from '@luoli/db';
import { escapeSystemInstructions, estimateStructureTokens, formatSpeakerIdentity, sanitizeIdentity, systemInstructions, type RuntimeTurnContext } from '@luoli/shared';
import type { PromptAssembler, PromptDocuments } from '../index.js';
import { runtimeBlock, type PromptBuildResult } from '../prompt/assembler.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/registry.js';
import { SKILL_NARROWING_EXEMPT } from '../tools/policy.js';
import type { ProviderStore } from '../provider/store.js';
import { PROVIDER_FAILURES_TO_DOWN, recordProviderFailure, recordProviderServed } from '../provider/health.js';
import { type FallbackOptions, fallbackLanguageModel } from './fallback-model.js';
import { createStepObservers, type StepFacts } from './step-observers.js';
import { type AliasSettings, parseAliasSettings } from '../provider/alias-settings.js';
import type { UsageLedger } from '../ledger/usage.js';
import type { QuotaGuard, QuotaReservation } from '../ledger/quota.js';
import type { LogSink } from '../log/sink.js';
import { isImagePart, type ContextEngine } from '../context/engine.js';
import type { AgentManager } from './manager.js';
import type { SkillLoader } from '../skills/loader.js';
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
  readonly #chains = new Map<string, Array<{ model: V4LanguageModel; info: ModelRow }>>();
  readonly #settings = new Map<string, AliasSettings>();
  /** 每个 provider 一个裸候选，只给健康探测用（`provider/health.ts`）。 */
  readonly #probes = new Map<string, { model: V4LanguageModel; info: ModelRow }>();
  /** 当前处于 `down` 且还在冷却期内的 `models.id`。**派生自库**：`rebuild()` 从库里重算，
   *  `recordFailure()` 写库的同一次调用里补一份 —— 进程内这份只是让调用路径不必每次查库。 */
  readonly #down = new Set<string>();

  /** @param onProviderUnusable rebuild 时跳过某个 provider 的原因。装配方拿它记一条 warn。 */
  constructor(private readonly db: Sqlite, private readonly providers: ProviderStore, private readonly onProviderUnusable?: (providerId: string, reason: string) => void) {}

  /**
   * `provider.healthDownCooldownMinutes`：判成 `down` 的 provider 只在冷却期内被排除，过期后
   * 下一次 `rebuild()` 放它回来再试一次。此前 `down` 是**永久**的 —— 一次网络抖动就能让一个
   * provider 从模型链里消失，直到有人去 WebUI 手工点「测试连通性」。
   * `provider.healthCheckCron` 定期调 `rebuild()`，冷却因此是自愈的。
   */
  rebuild(cooldownMinutes = 30): void {
    this.#models.clear();
    this.#info.clear();
    this.#chains.clear();
    this.#settings.clear();
    this.#probes.clear();
    this.#down.clear();
    const cutoff = Date.now() - cooldownMinutes * 60_000;
    /**
     * **冷却到期要写回库，不能只在这里放行。** 此前判据只在这一句 SELECT 里：过了冷却的 provider
     * 重新进链、也从 `#down` 消失，可库里那行仍是 `health_state='down'` 且 `health_fail_count>=3`
     * —— 于是它带着满格计数承接真实流量，下一次超时（4 >= 3）当场再 down 30 分钟，成了
     * 「30 分钟 down / 一个 cron 间隔 up」的抖动，而 WebUI 全程显示 down。`health_error` 留着
     * 当「上次失败原因」给界面看，`health_checked_at` 不动（它是上次判定的时间）。
     */
    this.db.prepare("UPDATE providers SET health_state='up',health_fail_count=0 WHERE health_state='down' AND COALESCE(health_checked_at,0) < ?").run(cutoff);
    const providerRows = this.db.prepare(`SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers
      WHERE enabled=1 AND COALESCE(health_state,'up') <> 'down'`).all() as ProviderRow[];
    // down 的 provider 被上面那句整条滤掉，它的模型也就不在任何链里 —— 所以「这个候选是不是
    // down」必须单独查一次，不能反过来从链里推（`isDown` 判的正是已经不在链里的那些）。
    // 冷却判据不用在这里重复：过了期的行上面那句 UPDATE 已经改回 `up` 了。
    for (const row of this.db.prepare(`SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id
      WHERE p.health_state='down'`).all() as Array<{ id: string }>) this.#down.add(row.id);
    const providerInstances = new Map<string, Provider>();
    for (const provider of providerRows) {
      /**
       * **一个 provider 坏掉不能带走全部别名。** `ProviderStore.key()` 在密文解不开时抛（换过
       * `LUOLI_MASTER_KEY` 就会），`JSON.parse` 在 `headers_json` 是坏 JSON 时抛 —— 而注册表在
       * 函数开头已经清空了，异常往上抛的结果是**所有别名一起没了**；调用点又是同步的
       * `POST /api/providers` / `PATCH /api/models/:id`，于是端点 500 且运行时从此没有任何可用
       * 模型，直到下一次成功的 rebuild（docs/27 · C-01）。`app.ts` 对同一列早就是 try/catch 兜的。
       *
       * 跳过的那一个记成 `down`：界面能说出原因，冷却期过后下一次 rebuild 会再试一次，
       * 而「一个别名都不剩」正是 `all_providers_down` 该响的条件。
       */
      try {
        const apiKey = this.providers.key(provider.id);
        const headers = provider.headers ? JSON.parse(provider.headers) as Record<string, string> : null;
        const common: { apiKey?: string; baseURL?: string; headers?: Record<string, string> } = {};
        if (apiKey) common.apiKey = apiKey;
        if (provider.baseUrl) common.baseURL = provider.baseUrl;
        if (headers) common.headers = headers;
        const instance: Provider = provider.kind === 'anthropic'
          ? createAnthropic(common)
          : provider.kind === 'google'
            ? createGoogleGenerativeAI(common)
            : provider.kind === 'openai-compatible'
              ? createOpenAICompatible({ name: provider.name, baseURL: provider.baseUrl ?? '', ...common })
              : createOpenAI(common);
        providerInstances.set(provider.id, instance);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?").run(Date.now(), reason.slice(0, 500), provider.id);
        this.onProviderUnusable?.(provider.id, reason);
      }
    }
    const modelRows = this.db.prepare(`SELECT id,provider_id AS providerId,model_id AS modelId,context_window AS contextWindow,
      max_output AS maxOutput,capabilities_json AS capabilities,price_in AS priceIn,price_out AS priceOut,
      price_cache_read AS priceCacheRead,price_cache_write AS priceCacheWrite FROM models WHERE enabled=1 ORDER BY sort`).all() as ModelRow[];
    const byId = new Map(modelRows.map((model) => [model.id, model]));
    // 探测用的候选按 `sort` 取每个 provider 的第一个启用模型 —— 与它在哪个别名链里无关：
    // 一个还没进任何别名的 provider 同样该被探（否则它永远是 `up`，直到有人手工点测试连接）。
    for (const info of modelRows) {
      if (this.#probes.has(info.providerId)) continue;
      const probe = providerInstances.get(info.providerId)?.languageModel(info.modelId);
      if (probe && typeof probe !== 'string' && probe.specificationVersion === 'v4') this.#probes.set(info.providerId, { model: probe as V4LanguageModel, info });
    }
    const aliases = this.db.prepare('SELECT alias,model_ids_json AS modelIds,settings_json AS settings FROM model_aliases').all() as AliasRow[];
    for (const alias of aliases) {
      const chain = (JSON.parse(alias.modelIds) as string[]).map((id) => byId.get(id)).filter((row): row is ModelRow => Boolean(row))
        .flatMap((info) => {
          const model = providerInstances.get(info.providerId)?.languageModel(info.modelId);
          return model && typeof model !== 'string' && model.specificationVersion === 'v4' ? [{ model: model as V4LanguageModel, info }] : [];
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

  /** 别名缺失时的回退顺序（04 §5.2）。模型和采样参数必须落在同一个别名上，否则会串味。 */
  #pick(alias: string): string | null {
    return [alias, 'main', 'high', 'low'].find((candidate) => this.#models.has(candidate)) ?? null;
  }

  resolve(alias: string): LanguageModel {
    const picked = this.#pick(alias);
    if (!picked) throw new Error(`model alias unavailable: ${alias}`);
    return this.#models.get(picked)!;
  }

  settings(alias: string): AliasSettings {
    const picked = this.#pick(alias);
    return picked ? this.#settings.get(picked) ?? {} : {};
  }

  info(alias: string): ModelRow | null {
    return this.#info.get(alias) ?? null;
  }
  /** 链上的每一个候选都要能反查到：只扫 `#info`（每个别名的链首）会让 fallback 到第二个模型之后的
   *  计价、`markProviderDown` 全部落空（docs/20 · W-AGENT-01 / W-LEDGER-01）。 */
  infoByModelId(modelId: string): ModelRow | null {
    for (const info of this.#info.values()) if (info.modelId === modelId) return info;
    for (const chain of this.#chains.values()) for (const candidate of chain) if (candidate.info.modelId === modelId) return candidate.info;
    return null;
  }
  /** modelId → 别名。`prefer` 命中时优先返回它：链内 fallback 换的是模型，别名没变。 */
  aliasOf(modelId: string, prefer?: string): string | null {
    if (prefer && this.#chains.get(prefer)?.some((candidate) => candidate.info.modelId === modelId)) return prefer;
    for (const [alias, chain] of this.#chains) if (chain.some((candidate) => candidate.info.modelId === modelId)) return alias;
    return null;
  }
  /**
   * `#down` 的粒度**只有这一份**：provider 名下所有模型行一起进、一起出。401/403 那条路
   * （`markProviderDown`）曾经只加命中的那一行，而按计数判死那条路（`recordFailure`）加的是全部
   * —— 同一个凭据被拒的 provider 在一条链上挂了两个模型时，第二个不被 `isDown` 跳过，而 401 在
   * 中间件里是短路 `throw`：这一轮既白烧一次注定 401 的往返，也不会继续往下 fallback。
   */
  #downRows(providerId: string, down: boolean): void {
    for (const row of this.db.prepare('SELECT id FROM models WHERE provider_id=?').all(providerId) as Array<{ id: string }>) {
      if (down) this.#down.add(row.id); else this.#down.delete(row.id);
    }
  }
  markProviderDown(modelId: string, error: string): void {
    const row = this.infoByModelId(modelId);
    if (row) {
      this.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?").run(Date.now(), error.slice(0, 500), row.providerId);
      this.#downRows(row.providerId, true);
    }
  }
  /** `models.id` → `provider_id`。`recordFailure` / `recordSuccess` 都按行反查，不认模型名。 */
  #providerOf(candidate: { id: string; rowId?: string }): string | null {
    const rowId = candidate.rowId ?? this.infoByModelId(candidate.id)?.id;
    if (!rowId) return null;
    return this.db.prepare('SELECT provider_id FROM models WHERE id=?').pluck().get(rowId) as string ?? null;
  }

  /** 健康探测用的裸候选（`provider/health.ts` 的 `ProbeSource`）。 */
  probeCandidate(providerId: string): { model: V4LanguageModel; modelId: string } | null {
    const probe = this.#probes.get(providerId);
    return probe ? { model: probe.model, modelId: probe.info.modelId } : null;
  }

  isDown(candidate: { id: string; rowId?: string }): boolean {
    if (candidate.rowId) return this.#down.has(candidate.rowId);
    const info = this.infoByModelId(candidate.id);
    return info ? this.#down.has(info.id) : false;
  }

  /**
   * 调用路径上的失败计入同一个「连续失败」计数器（`docs/04 §5.3`）。**不在这里 `rebuild()`**：
   * 轮次中途换掉 `#chains` 会让这一步的记账反查不到服务它的那一行，落到链首的价格上
   * （`step-observers` 的 `fallbackInfo` 兜底）。跳过失效候选靠 `isDown`，链本身等下一次
   * `rebuild()`（健康检查 cron 或任何配置改动）收拾。
   *
   * 代价是：如果这一次把最后一个 provider 标成了 down，`all_providers_down` 要等下一次 cron
   * 才响（`rebuildModels` 那条尾巴在 `main.ts`）。
   *
   * **一次调用一个候选只记一次**，重试不各记一次 —— 那道闸在调用点（`onCandidateFailed` 的
   * `willRetry`），因为「还会不会再试」只有中间件知道。
   */
  recordFailure(candidate: { id: string; rowId?: string }, reason: string, failuresToDown: number): boolean {
    const providerId = this.#providerOf(candidate);
    if (!providerId) return false;
    const { down } = recordProviderFailure(this.db, providerId, reason, failuresToDown);
    if (down) this.#downRows(providerId, true);
    return down;
  }

  /**
   * 成功服务一次就把连续失败计数归零（`docs/04 §5.3`）。**少了这一条，「连续」就是「累计」**：
   * 跨轮次零散攒够三次超时也能判死一个一直在服务的 provider，而计数在库里、重启也不清。
   * 常态是 no-op（`recordProviderServed` 自己带守卫），所以每一步调一次不会多一次真实写入。
   */
  recordSuccess(candidate: { id: string; rowId?: string }): void {
    const providerId = this.#providerOf(candidate);
    if (providerId && recordProviderServed(this.db, providerId)) this.#downRows(providerId, false);
  }

  estimate(alias: string, inputTokens: number): number | null {
    const info = this.info(alias);
    return info ? this.estimateModel(info, inputTokens) : null;
  }
  estimateModel(info: Pick<ModelRow, 'priceIn' | 'priceOut' | 'maxOutput'>, inputTokens: number): number | null {
    if (info.priceIn === null || info.priceOut === null) return null;
    const outputTokens = Math.min(info.maxOutput, Math.max(512, Math.ceil(inputTokens * 0.25)));
    return (inputTokens * info.priceIn + outputTokens * info.priceOut) / 1_000_000;
  }

  aliases(): string[] {
    return [...this.#models.keys()];
  }

  /**
   * 这个别名**当前服务的那个模型**支不支持看图。`capabilities_json` 一直在库里、SELECT 也一直
   * 在拉（`ModelRow.capabilities`），只是从来没人 `JSON.parse` 过 —— `docs/03:392` 那句
   * 「运行时不读这一列」说的就是它，而 `docs/04 §5.2` / `docs/08 §7.2` / `AC-PROV-009`
   * 三处都要求含图轮次自动切 `vision`。
   *
   * **必须先 `has`**：`info()` 走 `#pick`，别名不存在时会静默回落到 `main`，直接问
   * `supportsVision('vision')` 于是永远得到 main 的答案 —— 「有没有 vision 别名」这个判断会恒为真。
   */
  supportsVision(alias: string): boolean {
    if (!this.#models.has(alias)) return false;
    const info = this.#info.get(alias);
    if (!info) return false;
    try { return (JSON.parse(info.capabilities) as { vision?: unknown }).vision === true; } catch { return false; }
  }

  chain(alias: string): Array<{ model: V4LanguageModel; info: ModelRow }> {
    return this.#chains.get(alias) ?? [];
  }
}
/**
 * tool-result 的 output 必须是 SDK 的带类型形状（`{type:'json'|'text'|…, value}`），裸对象会让
 * 整个 prompt 过不了 ModelMessage 校验。历史上写进库的是裸对象，而 parts 是持久化的 ——
 * 只改写入端的话，凡是调过一次工具的会话在 `/new` 之前每轮都会失败，所以读出侧也要兜一层。
 * 只补 output，不碰判别字段（docs/02 不变量）。
 */
export function normalizeToolOutput(output: unknown): { type: string; value: unknown } {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const typed = output as { type?: unknown; value?: unknown };
    if (typeof typed.type === 'string' && 'value' in typed) return typed as { type: string; value: unknown };
  }
  return { type: 'json', value: output ?? null };
}
export function toolResultPart(toolCallId: string, toolName: string, output: unknown): { type: 'tool-result'; toolCallId: string; toolName: string; output: { type: string; value: unknown } } {
  return { type: 'tool-result', toolCallId, toolName, output: normalizeToolOutput(output) };
}
/**
 * 一步的工具结果，**`tool-error` 必须一起收**。
 *
 * AI SDK 的 `step.toolResults` 是 `content.filter(p => p.type === 'tool-result')`；工具抛错
 * 或输入校验失败时产出的是 `tool-error` part，于是被整个滤掉 —— `appendContext` 只把
 * tool-call 追进 delta，上下文里就留下一条**没有配对结果的 tool-call**。轮内看不出来
 * （SDK 自己的 `responseMessages` 会把错误转成合法的 tool-result 发上线），下一轮起该会话
 * 每次请求都是畸形的：provider 0 步返回 → `NoOutputGeneratedError` → 进程崩。实测
 * logs/2026-08-18 22:17 与 23:19 两次，起因是 `get_message({messageId:0})` 撞上
 * `z.number().int().positive()`。
 *
 * 形状照 SDK 真正发上线的那份来（`output: {type:'error-text', value}`），不另造一种。
 */
function stepToolResults(content: readonly unknown[]): StepFacts['toolResults'] {
  const results: StepFacts['toolResults'] = [];
  for (const raw of content) {
    const part = raw as { type?: string; toolCallId?: string; toolName?: string; output?: unknown; error?: unknown };
    if (part?.type !== 'tool-result' && part?.type !== 'tool-error') continue;
    if (!part.toolCallId || !part.toolName) continue;
    const output = part.type === 'tool-error'
      ? { type: 'error-text', value: part.error instanceof Error ? `${part.error.name}: ${part.error.message}` : String(part.error) }
      : part.output;
    results.push({ toolCallId: part.toolCallId, toolName: part.toolName,
      part: toolResultPart(part.toolCallId, part.toolName, output), preview: `${part.toolName}: ${JSON.stringify(output).slice(0, 180)}` });
  }
  return results;
}
/**
 * 按别名构造带 fallback / 重试包装的模型。包装必须做在「按别名解析」这一层：`prepareStep` 每一步
 * 都会重设 model，只包构造时那一个等于整条链从第 0 步起就没被用过（docs/20 · W-AGENT-01）。
 * 别名没有链（registry 只认识它的回退目标）时退回裸模型，行为与 `resolve()` 一致。
 */
export function aliasModel(registry: ModelRegistry, alias: string, options: FallbackOptions): LanguageModel {
  const candidates = registry.chain(alias);
  return candidates.length
    ? fallbackLanguageModel(candidates.map((candidate) => ({ model: candidate.model, id: candidate.info.modelId, rowId: candidate.info.id })), options)
    : registry.resolve(alias);
}

const SENDABLE_ROLES = new Set(['user', 'assistant', 'tool']);
/** 系统旁白的标记。`load_skill` 注入 skill 正文时也用它 —— 同一个 wire 标记只能有一份定义。 */
export const NOTE_PREFIX = '（系统提示）';
/**
 * AI SDK v7 起 `image` part 已废弃：`convertToLanguageModelPrompt` 每遇到一个就打一条
 * DeprecationWarning，然后原样转成 `{type:'file', data, mediaType}` 再发出去。写入侧
 * （`telegram/media.ts`）已经直接产出 `file`，这里兜的是库里那些历史 part —— parts 是持久化的，
 * 不在读出侧转，老会话就得一直刷警告到图片滚出窗口为止。
 */
function imageToFilePart(part: Record<string, unknown>): Record<string, unknown> {
  const { image, type: _type, ...rest } = part;
  return { ...rest, type: 'file', data: image, mediaType: typeof part.mediaType === 'string' ? part.mediaType : 'image' };
}
/**
 * system 只能出现在 instructions 里：AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages`
 * 未开启时直接拒收 messages 里的 system 消息，整轮请求当场 InvalidPromptError（docs/20 · W-CTX-01）。
 * 写入侧已经不再产生这种消息（`assertValidShape` 的 role 白名单挡着），这里兜的是 0006 之前
 * 写进库、又没跑迁移的历史数据 —— parts 是持久化的，读出侧不兜就是会话级永久损坏。
 */
/**
 * `attachment://<id>` 换回 base64。文件丢了就整体降级成一句占位文本，**不能抛** ——
 * parts 是持久化的，这里抛一次等于该会话在 `/new` 之前每轮都失败；而「不透明 part 要么原样保留、
 * 要么整体换成占位文本」正是 docs/02 的不变量（docs/24 · R-MEDIA-01）。
 */
function hydrateAttachment(part: Record<string, unknown>, attachments?: Sqlite): Record<string, unknown> {
  const missing = { type: 'text', text: '[图片已不可用：附件文件已丢失]' };
  if (!attachments) return missing;
  const id = (part.ref as string).slice('attachment://'.length);
  const path = attachments.prepare("SELECT local_path FROM attachments WHERE id=? AND download_state='done'").pluck().get(id) as string | undefined;
  if (!path) return missing;
  const { ref: _ref, ...rest } = part;
  try { return { ...rest, data: readFileSync(path).toString('base64') }; } catch { return missing; }
}

export interface ContextMessageOptions {
  /**
   * 易变段正文（TOOL CATALOG + 记忆 + RUNTIME）。给了就带 nonce 信封追加成请求体**最后一条**
   * user 消息；不给就一条都不追加。它是每轮现算的渲染产物，**绝不入库、不进 delta** ——
   * 持久化它等于把上一轮的时钟腌成历史事实。
   */
  volatile?: string;
  /** Anthropic 专用：在已提交历史的最后一条消息上打移动缓存断点（其余 provider 是隐式前缀缓存，不需要）。 */
  cacheBreakpoint?: boolean;
  /** 读出侧自愈补了几条缺失的 tool-result。给了就能在日志里看见「这个会话的历史是坏的」。 */
  onOrphanToolCalls?(toolCallIds: string[]): void;
  /**
   * 图片整体换成占位文本。含图轮次既没有 `vision` 别名、当前别名自己也不支持看图时才开
   * （`docs/08 §7.2`）—— 把不透明 part 原样发给一个不认它的模型，宽容的 provider 静默忽略、
   * 严格的直接 400，两种都比一句「我看不了图」糟。
   */
  degradeImages?: boolean;
}

/** 补出来的那条结果的正文。不伪造成功，只如实说结果没了（照 `hydrateAttachment` 的占位先例）。 */
const ORPHAN_TOOL_RESULT = '[工具结果缺失：这次调用的结果没有被记录下来]';
/** `degradeImages` 时替掉图片的占位文本，以及回复末尾那句提示（`docs/08 §7.2`）。 */
const IMAGE_UNSUPPORTED = '[图片：当前模型不支持看图，本轮没能查看]';
export const VISION_UNSUPPORTED_NOTICE = '（当前模型不支持看图，这张图我没能真的看到。）';

export function contextMessages(turn: RuntimeTurnContext, attachments?: Sqlite, options?: ContextMessageOptions): ModelMessage[] {
  const source = [...turn.snapshot.messages, ...turn.delta];
  // **读出侧自愈：没有配对结果的 tool-call 现补一条。** provider 见到这种形状会拒收整个请求
  // （中转站的表现是 200 + 0 步），而 parts 是持久化的 —— 不在读出侧兜，该会话在 `/new` 之前
  // 每轮都失败，实测能一路崩到进程被带走。写入侧的 `assertPairedToolCalls` 只管「不再产生新的」，
  // 库里已经有的那些只能在这里救。
  const answered = new Set<string>();
  for (const message of source) {
    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') answered.add(part.toolCallId);
    }
  }
  const messages: ModelMessage[] = [];
  const repaired: string[] = [];
  // 断点打在「已提交历史的最后一条」而不是整个数组的最后一条：本轮 delta 与工具循环的产出都排在
  // 它之后，所以这段前缀下一轮原样还在，能整段命中。跟着最后一条走的话每步都换位置，等于没打。
  // 补出来的结果会让下标漂移，所以 `stored` 数的是**产出侧**的条数，不是 snapshot 的条数。
  let stored = 0;
  for (const [index, message] of source.entries()) {
    const content = (message.parts as Array<Record<string, unknown>>).map((part) => {
      if (part?.type === 'tool-result') return { ...part, output: normalizeToolOutput(part.output) };
      if (options?.degradeImages && isImagePart(part)) return { type: 'text', text: IMAGE_UNSUPPORTED };
      if (part?.type === 'image') return imageToFilePart(part);
      if (part?.type === 'file' && typeof part.ref === 'string' && part.ref.startsWith('attachment://')) return hydrateAttachment(part, attachments);
      // 易变段现在和用户正文同处 user role，正文里能写出 `<system-instructions` 就等于能伪造它。
      // 只改 text 字符串，判别字段一个不碰（docs/02 红线 14）。
      if (typeof part?.text === 'string') return { ...part, text: escapeSystemInstructions(part.text) };
      return part;
    });
    if (SENDABLE_ROLES.has(message.role)) messages.push({ role: message.role, content } as ModelMessage);
    else {
      const text = content.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
      messages.push({ role: 'user', content: [{ type: 'text', text: `${NOTE_PREFIX}${text}` }] } as ModelMessage);
    }
    const orphans = content.filter((part) => part?.type === 'tool-call' && typeof part.toolCallId === 'string' && !answered.has(part.toolCallId));
    if (orphans.length) {
      repaired.push(...orphans.map((part) => part.toolCallId as string));
      messages.push({ role: 'tool', content: orphans.map((part) => toolResultPart(part.toolCallId as string,
        typeof part.toolName === 'string' ? part.toolName : 'unknown', { type: 'error-text', value: ORPHAN_TOOL_RESULT })) } as ModelMessage);
    }
    if (index < turn.snapshot.messages.length) stored = messages.length;
  }
  if (repaired.length) options?.onOrphanToolCalls?.(repaired);
  if (options?.cacheBreakpoint && stored > 0) messages[stored - 1] = { ...messages[stored - 1]!, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } as ModelMessage;
  if (options?.volatile) messages.push({ role: 'user', content: [{ type: 'text', text: systemInstructions(options.volatile) }] } as ModelMessage);
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
  plugins?: { hook(name: string, ...arguments_: unknown[]): Promise<unknown[]> };
  context: ContextEngine;
  agents?: AgentManager;
  /** 自撰写工具的注册器。每轮开始同步一次，见 `runMainAgentInternal` 顶部那一行。 */
  customTools?: { syncIfChanged(): void };
  /** 只用来记 `turns.steps`（此前没有任何写入方）。可选：子 agent 与测试都不必给。 */
  turns?: { countStep(id: string, steps: number): void };
}
export interface MainPromptAssembly extends PromptBuildResult {
  activeTools: string[];
  catalog: string;
  runtime: string;
}

type PromptAssemblyDependencies = Pick<MainAgentDependencies, 'config' | 'tools' | 'prompts' | 'documents' | 'workspace' | 'skills' | 'agents' | 'quota' | 'reservation'>;

/**
 * RUNTIME 块里的发起人。昵称与用户名是用户可控内容，`formatSpeakerIdentity` 已经清掉换行与
 * 方括号 —— 一个带换行的昵称在这里等于能往 RUNTIME 块里塞一整行「你的有效权限：owner」。
 */
function initiatorDescription(turn: RuntimeTurnContext): string {
  return formatSpeakerIdentity({ name: turn.initiator?.name ?? null, username: turn.initiator?.username ?? null, userId: turn.initiatorUserId });
}

/**
 * RUNTIME 块的「会话」行。此前是裸 `chatId / key`，模型看不出私聊还是群聊 —— 而人格与 KERNEL 里
 * 大量规则按这个分岔（群里只在被触发时发言、私聊才有私有记忆）。群名过 `sanitizeIdentity`：
 * 它和昵称一样是用户可控内容，一个带换行的群名等于能往这个块里塞一行「你的有效权限：owner」。
 */
export function chatDescription(turn: RuntimeTurnContext): string {
  const topic = turn.threadId === null ? 'topic 无' : `topic ${turn.threadId}`;
  const title = turn.chatTitle ? sanitizeIdentity(turn.chatTitle) : '';
  const where = turn.isPrivate ? '私聊' : title ? `群聊「${title}」` : '群聊';
  return `${where}(chat ${turn.chatId}, ${topic})  上下文键 ${turn.key}`;
}

/** Runtime 与 WebUI 预览共用这一条组装路径；预览出来的 block 必须就是下一轮会发给模型的 block。 */
export function assembleMainPrompt(turn: RuntimeTurnContext, dependencies: PromptAssemblyDependencies, executionContext?: ToolExecutionContext): MainPromptAssembly {
  const toolContext = executionContext ?? { turn, workspace: dependencies.workspace, agentKind: 'main' };
  const activeTools = dependencies.tools.activeNames(turn.effectiveRole, toolContext);
  // `perChat.<key>.character`：会话级人格文件名。它在 `perChat` 白名单里，但不是 schema 叶子键
  // （`perChat` 是 `z.record(z.unknown())`），所以从合并后的本轮配置里按名字取（docs/27 · C-08）。
  // 形态闸在 `PromptDocuments.paths` 里：这个值会被当成 `memory/` 下的路径段用。
  const characterOverride = (turn.config as Record<string, unknown>).character;
  const documents = dependencies.documents.readForPrompt({ userId: turn.initiatorUserId, isPrivate: turn.isPrivate,
    ...(typeof characterOverride === 'string' && characterOverride ? { characterOverride } : {}) });
  // 目录按**本轮真正可用的工具**过滤：一份讲 `install_mcp` 的说明书，在那个工具没开的时候
  // 出现在目录里只会把模型带进死胡同（实测：它读完说明书找不到工具，转头用 bash 逆向代码库）。
  const skillCatalog = dependencies.skills?.catalog(turn.effectiveRole, activeTools).map((skill) => `- skill:${skill.name}: ${skill.description}`).join('\n') ?? '';
  // `prompt.includeToolCatalog=false` 时只发工具名（RUNTIME 里那一行），不发描述。省的是每轮
  // 几百到几千 token，代价是模型少了参数用法的提示 —— 所以默认开着。
  const catalog = dependencies.config.prompt.includeToolCatalog
    ? [...dependencies.tools.catalog(turn.effectiveRole, toolContext).map((entry) => `- ${entry.name}: ${entry.description}`), skillCatalog].filter(Boolean).join('\n')
    : '';
  const runtimeShow = dependencies.config.prompt.runtimeBlock;
  const spent = dependencies.quota && dependencies.reservation ? dependencies.quota.status(dependencies.reservation) : null;
  const runtime = runtimeBlock({ now: new Date(), timezone: dependencies.config.general.timezone,
    chatDescription: chatDescription(turn), triggerDescription: initiatorDescription(turn), role: turn.effectiveRole,
    tools: activeTools, agents: dependencies.config.agent.agents.filter((agent) => ['blocked', 'limited', 'trusted', 'owner'].indexOf(turn.effectiveRole) >= ['blocked', 'limited', 'trusted', 'owner'].indexOf(agent.minRole)).map((agent) => `${agent.name}(${agent.description})`),
    contextMessages: turn.snapshot.messages.length, contextTokens: turn.snapshot.tokens, maxMessages: dependencies.config.context.limit.maxMessages,
    maxTokens: dependencies.config.context.limit.tokens, workspace: dependencies.workspace, sandbox: dependencies.config.sandbox.mode,
    // 只在真有本轮预留时才给得出额度；WebUI 的提示词预览没有预留，那一行本来就不该出现。
    ...(spent ? { quota: `本轮已用 $${spent.committed.toFixed(4)} / 上限 $${dependencies.config.quota.perTurn.maxCostUsd.toFixed(2)}` } : {}),
    // 工具名只在目录关掉时才列进 RUNTIME：开着的时候 TOOL CATALOG 已经一行一个带描述地列过了，
    // 两处同源（都是 `active(role, ctx)`），重复一遍等于每轮白付一份易变段的钱（docs/06 §1.2）。
    show: { quota: runtimeShow.showQuota, contextWatermark: runtimeShow.showContextWatermark, workspace: runtimeShow.showWorkspace,
      toolNames: !dependencies.config.prompt.includeToolCatalog } });
  const promptInput = { character: documents.character, assist: documents.assist, catalog, publicMemory: documents.publicMemory, runtime,
    maxTokens: dependencies.config.prompt.maxTokens, includeCatalog: dependencies.config.prompt.includeToolCatalog };
  if (documents.privateMemory !== undefined) Object.assign(promptInput, { privateMemory: documents.privateMemory });
  return { ...dependencies.prompts.build(promptInput), activeTools, catalog, runtime };
}

/**
 * `instructions` 里只放稳定段（KERNEL/CHARACTER/ASSIST）。易变段（TOOL CATALOG + 记忆 + RUNTIME）
 * 走 `contextMessages` 追加到请求体**最后**，因为前缀缓存的判据是请求体的物理顺序：易变段留在
 * system #2 时，它每轮都变的那几个字节位于整个历史之前，后面几万 token 的对话一条都缓存不到
 * （实测跨轮只命中 128 token，同一轮内前缀不变时命中 12,672，docs/06 §1）。挪到末尾之后
 * 「稳定段 + 全部历史」才凑成一条逐轮只增不改的前缀。
 *
 * 仍传数组而不是裸字符串：Anthropic 的 `cache_control` 要挂在消息对象上。
 */
function stableInstructions(prompt: { stable: string }, providerKind: string): Instructions {
  return [providerKind === 'anthropic'
    ? { role: 'system' as const, content: prompt.stable, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
    : { role: 'system' as const, content: prompt.stable }];
}

function estimateModelMessages(messages: ModelMessage[]): number {
  return estimateStructureTokens(messages);
}

function bodyForLog(value: unknown, enabled: boolean): unknown {
  return enabled ? value : undefined;
}
export interface MainAgentStreamResult {
  stream: AsyncIterable<string>;
  final: Promise<string>;
  interrupt(): void;
}

/** `result.stream` 里我们只认 `text-delta`、`finish-step` 与 `error`；其余（reasoning、tool-call）一概跳过。 */
interface StreamPartLike { type: string; text?: string; error?: unknown }

/**
 * 把逐 step 的旁白拼成一条消息，**步边界恰好一个空行**。
 *
 * 两个历史坑，这一版都在这里收口：
 *
 * ① `result.textStream` 走的是 `toTextStream`，它只把 `text-delta` 的裸字符串透出去，
 *    `finish-step` 之类的边界全丢了 —— 投递侧那一行 `text += step.value` 于是把每一步的旁白
 *    无缝粘成一段（logs/2026-08-18 · turn 01M09QBZVK…）。
 * ② 补上分隔之后反过来空行爆炸：KERNEL 那条「段间空一行」把模型教成**每一步的正文都以
 *    `\n\n\n` 收尾**，而纯工具步的「正文」就是 `\n\n\n`。实测一条 11 步的回复
 *    （logs/2026-08-18 · turn 01M0AKMXG4…）开头 10 个换行、中段 12 连换行，这些全是模型自己
 *    写的空白被原样透传 —— 这个函数一个分隔符都没插。
 *
 * 所以判据从「条件补分隔」改成**扣住尾部空白 + 到点补齐**：
 *
 * - 一段正文的尾部空白先扣住不发（`held`），跨过 step 边界就直接丢掉，换成恰好一个 `\n\n`；
 *   没跨过边界就原样发出去 —— 同一步内的增量、列表缩进、围栏代码块里的空行一个字都不动。
 * - 纯空白的「正文」不算说过话：不置 `wrote`、不 arm 边界、不透传。
 * - 第一段非空白正文之前什么都不发，流结束时扣住的尾部空白直接丢弃（首尾无空白）。
 *
 * `error` 部件也要透出去（`onError`）：AI SDK 把步骤级失败吞进内部 onError（默认实现只
 * `console.error`），流照常正常结束 —— 此前这里明文跳过它，于是「上游挂了」这条路在日志里
 * 是隐形的，0 步的那次连 `model.error` 都没留下。
 */
export async function* stepSeparatedText(full: AsyncIterable<StreamPartLike>, trailing?: () => Promise<string>, onChunk?: (chunk: string) => void,
  onError?: (error: unknown) => void): AsyncGenerator<string> {
  let wrote = false;        // 这一轮到底产出过**非空白**正文没有
  let pendingBreak = false; // 上次产出正文之后跨过了 step 边界
  let held = '';            // 扣住不发的尾部空白
  function* emit(text: string): Generator<string> { if (onChunk) onChunk(text); yield text; }
  for await (const part of full) {
    if (part.type === 'error') { onError?.(part.error); continue; }
    // 边界一到，上一步的尾部空白就作废：它要被换成恰好一个空行。连续多个空步只 arm 一次。
    if (part.type === 'finish-step') { held = ''; if (wrote) pendingBreak = true; continue; }
    if (part.type !== 'text-delta' || !part.text) continue;
    const core = part.text.trim();
    if (!core) { if (wrote && !pendingBreak) held += part.text; continue; }
    const lead = /^\s*/.exec(part.text)![0];
    const gap = wrote ? (pendingBreak ? '\n\n' : held + lead) : '';
    yield* emit(gap + core);
    held = /\s*$/.exec(part.text)![0];
    wrote = true;
    pendingBreak = false;
  }
  // 收尾补跑那一次（§2）也要走同一道分隔逻辑，否则它会直接贴在最后一句旁白后面。
  if (!trailing) return;
  const extra = (await trailing()).trim();
  if (!extra) return;
  yield* emit(wrote ? `\n\n${extra}` : extra);
}

const WRAP_UP_INSTRUCTION = '刚才的工具调用已经结束，但你还没有给出结论。把结果告诉用户：成了是什么，没成是卡在哪。不要再调用工具，不要复述过程。';

export async function streamMainAgent(turn: RuntimeTurnContext, dependencies: MainAgentDependencies): Promise<MainAgentStreamResult> {
  return runMainAgentInternal(turn, dependencies, true) as Promise<MainAgentStreamResult>;
}
export async function runMainAgent(turn: RuntimeTurnContext, dependencies: MainAgentDependencies): Promise<string> {
  return runMainAgentInternal(turn, dependencies, false) as Promise<string>;
}

async function runMainAgentInternal(turn: RuntimeTurnContext, dependencies: MainAgentDependencies, streaming: boolean): Promise<string | MainAgentStreamResult> {
  // 自撰写的工具在**开轮前**同步进注册表：`toolSet` 下面就冻结了，轮内再注册只会让
  // `prepareStep` 的 `activeTools` 报出一个 `toolSet` 里没有的名字。**只在主 agent 做** ——
  // 子 agent 跑在父轮内部，在那里重扫会把父轮已经冻结的那份工具集弄脱节。
  dependencies.customTools?.syncIfChanged();
  const toolContext: ToolExecutionContext = { turn, workspace: dependencies.workspace, agentKind: 'main' };
  // 子 agent 从 turn 上取同一份预留：spawn_agent 在工具层执行，拿不到这里的 dependencies。
  turn.reservation = dependencies.reservation ?? null;
  await dependencies.plugins?.hook('beforeTurn', { turn });
  const prompt = assembleMainPrompt(turn, dependencies, toolContext);
  const activeNames = prompt.activeTools;
  // 预算被 catalog + runtime 吃满时 CHARACTER.md 会被整段截成一句「（记忆已截断…）」——
  // 人格静默消失，而日志里一个字都没有（docs/20 · W-PROMPT-01）。
  if (prompt.truncated.length) dependencies.log.event({ level: 'warn', kind: 'prompt.truncated', summary: `Prompt blocks truncated: ${prompt.truncated.join(', ')}`, traceId: turn.turnId, key: turn.key, data: { truncated: prompt.truncated, blocks: prompt.blocks, maxTokens: dependencies.config.prompt.maxTokens } });
  const toolSet: ToolSet = {};
  for (const registered of dependencies.tools.active(turn.effectiveRole, toolContext)) {
    toolSet[registered.name] = tool({ description: registered.description, inputSchema: registered.inputSchema, execute: (input) => dependencies.tools.execute(registered.name, input, toolContext) });
  }
  const persistedAlias = readAppKv<string>(dependencies.db, modelAliasKey(turn.key));
  const alias = turn.modelAliasOverride ?? persistedAlias ?? dependencies.config.agent.main.modelAlias;
  const mainRun = dependencies.agents?.createMain(turn.turnId, turn.effectiveRole, alias);
  const chain = dependencies.registry.chain(alias);
  if (!chain.length) throw new Error(`model alias unavailable: ${alias}`);
  if (dependencies.config.quota.requirePricing && turn.effectiveRole !== 'owner' && chain.some((candidate) => candidate.info.priceIn === null || candidate.info.priceOut === null)) throw new Error('model_pricing_required');
  /**
   * **含图轮次的 vision 自动切换**（`docs/04 §5.2`、`docs/08 §7.2`、`AC-PROV-009`）。
   *
   * 三处文档都写了、代码里此前一行都没有：`capabilities_json` 只有 WebUI 的徽章在读。表现是
   * 用户发图给一个 `vision=false` 的模型，模型看不见图却又不知道自己看不见 —— 实测它去
   * `cp` 文件、`python` 读尺寸、开本地 http 服务器、拿 `agent-browser` 截图，绕了 11 步
   * （logs/2026-08-18 · turn `01M0AKMXG4…`）。它也试过自己 `set_model('vision')`，但那个
   * 覆盖只在**当轮**生效（`docs/04 §5.2`），下一轮（真正带图那一轮）又回到了 `main`。
   *
   * 判据在轮次级算一次：图片在 `snapshot + delta` 里，`prepareStep` 每步重算纯属浪费。
   */
  const turnHasImages = [...turn.snapshot.messages, ...turn.delta].some((message) => (message.parts as unknown[]).some(isImagePart));
  // 一张都看不了的时候才降级：`vision` 别名没配、当前别名自己也不支持。
  const visionDegraded = turnHasImages && !dependencies.registry.supportsVision('vision') && !dependencies.registry.supportsVision(alias);
  if (visionDegraded) dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${alias} 不支持看图且无 vision 别名`,
    traceId: turn.turnId, key: turn.key, data: { alias, reason: 'vision_unavailable' } });
  // 步骤级失败（上游 5xx、重试耗尽）不会从 textStream 抛出来：AI SDK 把它吞进内部的 onError，
  // 让 result.text 安静地解析成空串。不抓住这一份，一次彻底的上游故障和「模型没话说」
  // 在调用方眼里长得一模一样 —— 上一次就是这样变成「不回复」的。
  let streamFailure: unknown = null;
  // 收尾补跑（§2）的三个状态：最后一步有没有正文、这一轮做过事没有、当前是不是正在补跑那一次。
  let lastStepHadText = false;
  let sawToolCall = false;
  let wrapUpMode = false;
  /** 主轮跑了几步。补跑那次 `agent.generate` 的 stepNumber 从 0 重新起，靠它换算成全轮编号。 */
  let mainStepCount = 0;
  /**
   * 记下第一份步骤级失败，**并且落一条 `model.error`**。`onExhausted` 那条路自己会记，剩下两条
   * 此前一个字都不落：流里的 `error` 部件（SDK 默认 onError 只 `console.error`）、以及 0 步空流。
   * 两次进程崩溃（logs/2026-08-18 22:17 / 23:19）在 `model.jsonl` 里因此完全隐形。
   */
  const noteStreamFailure = (error: unknown): void => {
    if (streamFailure) return;
    streamFailure = error;
    dependencies.log.event({ level: 'error', kind: 'model.error', summary: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300),
      traceId: turn.turnId, key: turn.key, data: { alias, modelId: dependencies.registry.info(alias)?.modelId ?? initialInfo.modelId, source: 'stream' } });
  };
  const initialInfo = chain[0]!.info;
  // 包装必须做在「按别名解析」这一层：`prepareStep` 每一步都无条件设置 model，只包装构造时那一个的话，
  // 整条 fallback / 重试链从第 0 步起就再没被用过 —— 重试次数、别名 fallback、markProviderDown、
  // 以及区分「上游挂了」和「模型没话说」所依赖的 onExhausted，全都是死代码（docs/20 · W-AGENT-01）。
  const wrapped = new Map<string, LanguageModel>();
  // 包装之后 `step.model.modelId` 恒等于链首，看不出这一步实际是谁服务的。中间件报一份，
  // 记账才能落到真正出力的那个模型上（计价、别名、markProviderDown 都靠它）。
  let servedModelId: string | null = null;
  const wrappedFor = (aliasName: string): LanguageModel => {
    const cached = wrapped.get(aliasName);
    if (cached) return cached;
    const built = aliasModel(dependencies.registry, aliasName, {
      maxRetries: dependencies.config.provider.maxRetries, retryBaseMs: dependencies.config.provider.retryBaseMs,
      retryMaxMs: dependencies.config.provider.retryMaxMs, abortSignal: turn.abortSignal,
      requestTimeoutMs: dependencies.config.provider.requestTimeoutMs, streamIdleTimeoutMs: dependencies.config.provider.streamIdleTimeoutMs,
      // 服务成功 = 上游还答话，连续失败计数归零（`docs/04 §5.3`）。常态是一次 no-op 写。
      onServed: (served) => { servedModelId = served.id; dependencies.registry.recordSuccess(served); },
      isDown: (candidate) => dependencies.registry.isDown(candidate),
      // 跳过这件事必须有痕迹，而且 `to` 报的是真正会被试的那个（docs/10 · provider.fallback）。
      onSkipped: (candidate, next) => {
        dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${candidate.id} 已判 down，跳过${next ? ` → ${next.id}` : ''}`,
          traceId: turn.turnId, key: turn.key, data: { alias: aliasName, from: candidate.id, to: next?.id ?? null, reason: 'skipped_down' } });
      },
      // 每一次失败的尝试落一行（`docs/10` 给 `model.error` 定的 `retryAttempt` / `willFallback`）。
      // 少了它，「熬满三次超时再 fallback」在日志里是一段空白：本次事故 363 秒里只有开头的
      // `turn.start` 与结尾的 `provider.fallback`（docs/00 §2.3 同一类）。
      onCandidateFailed: (candidate, failure) => {
        dependencies.log.event({ level: 'warn', kind: 'model.error',
          summary: `${candidate.id} 第 ${failure.attempt + 1} 次尝试失败：${failure.error instanceof Error ? failure.error.message : String(failure.error)}`.slice(0, 300),
          traceId: turn.turnId, key: turn.key,
          data: { alias: aliasName, modelId: candidate.id, errorKind: failure.kind, status: failure.status, retryAttempt: failure.attempt, willRetry: failure.willRetry, willFallback: failure.willFallback, ms: failure.elapsedMs } });
        // **只有超时计入连续失败。** 5xx / 429 是上游在说话，链内 fallback 当场就换人、代价是一次
        // 往返；真正贵的是「连上了但不返回」—— 每一步都要熬满 `(maxRetries+1) × requestTimeoutMs`。
        // **而且一次调用一个候选只记一次**：还会再试就先不记。按尝试记的话 `maxRetries: 2` 时一次
        // 请求就是三次增量，一个合法地超过 `requestTimeoutMs` 的调用（定时任务、子 agent、收尾
        // 补跑都走非流式，`deadline.guard` 罩的是整段生成）当场就把整个 provider 判死 30 分钟。
        if (failure.kind !== 'timeout' || failure.willRetry) return;
        const down = dependencies.registry.recordFailure(candidate, failure.error instanceof Error ? failure.error.message : String(failure.error), PROVIDER_FAILURES_TO_DOWN);
        if (down) {
          dependencies.log.event({ level: 'error', kind: 'provider.health', summary: `${candidate.id} 连续超时，已标 down 并从模型链跳过`,
            traceId: turn.turnId, data: { modelId: candidate.id, state: 'down', reason: 'request_timeout' } });
        }
      },
      // 这条以前一个消费方都没有 —— `provider.fallback` 是 `docs/10` 里有定义、生产侧却没有任何
      // 产出的事件，于是「链首熬完之后换了谁」在日志里根本读不出来（本次事故靠算术反推的那一半）。
      onFallback: (from, to) => {
        dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${from.id} 试完仍失败，换 ${to.id}`,
          traceId: turn.turnId, key: turn.key, data: { alias: aliasName, from: from.id, to: to.id, reason: 'candidate_exhausted' } });
      },
      onUnavailable: (candidate, error) => {
        dependencies.registry.markProviderDown(candidate.id, error instanceof Error ? error.message : 'authentication_failed');
        dependencies.log.event({ level: 'error', kind: 'provider.health', summary: `${candidate.id} credentials rejected`, traceId: turn.turnId, data: { modelId: candidate.id } });
      },
      onExhausted: (error) => {
        streamFailure ??= error;
        dependencies.log.event({ level: 'error', kind: 'model.error', summary: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300),
          traceId: turn.turnId, key: turn.key, data: { alias: aliasName, modelId: dependencies.registry.info(aliasName)?.modelId ?? initialInfo.modelId, cause: error instanceof Error && error.cause instanceof Error ? error.cause.message.slice(0, 300) : undefined } });
      },
    });
    wrapped.set(aliasName, built);
    return built;
  };
  const model = wrappedFor(alias);
  const providerKind = dependencies.db.prepare('SELECT kind FROM providers WHERE id=?').pluck().get(initialInfo.providerId) as string ?? '';
  const instructions = stableInstructions(prompt, providerKind);
  // 同一轮里 `contextMessages` 会被调最多三次（主流 / 收尾补跑 / 非流式），坏历史只报一次。
  let reportedOrphans = false;
  const messageOptions: ContextMessageOptions = { volatile: prompt.volatile, cacheBreakpoint: providerKind === 'anthropic', degradeImages: visionDegraded,
    onOrphanToolCalls: (toolCallIds) => {
      if (reportedOrphans) return;
      reportedOrphans = true;
      dependencies.log.event({ level: 'warn', kind: 'ctx.orphan_tool_call', summary: `Repaired ${toolCallIds.length} tool-call(s) with no result`,
        traceId: turn.turnId, key: turn.key, data: { toolCallIds: toolCallIds.slice(0, 20) } });
    } };
  const stepSpans = new Map<number, { id: string; end: (data?: unknown, error?: unknown) => void }>();
  const stepAlias = new Map<number, string>();
  /** vision 切换每轮只记一条：`prepareStep` 每一步都会重算同一个结论。 */
  let visionSwitchLogged = false;
  const observers = createStepObservers(turn, { ledger: dependencies.ledger, registry: dependencies.registry, context: dependencies.context,
    log: dependencies.log, quota: dependencies.quota, reservation: dependencies.reservation ?? null,
    tokenRatioAlpha: dependencies.config.context.tokenRatioAlpha, fallbackInfo: initialInfo,
    aliasForStep: (stepNumber) => stepAlias.get(stepNumber) ?? alias });
  const agent = new ToolLoopAgent({ model, instructions, tools: toolSet, activeTools: activeNames,
    // 重试与 fallback 归 `fallbackLanguageModel` 管（它认 Retry-After、带真随机抖动、401 短路、
    // 链内换模型）。SDK 默认还会自己再重试 2 次，两层相乘 = 同一次故障要熬 3×(候选数×尝试数) 次
    // 上游超时才收场 —— logs/2026-08-17 那几轮卡死就是这么来的：fallback→model.error 的 62 秒
    // 节拍整整走了两遍，第三遍还在等的时候用户已经去重启进程了。
    maxRetries: 0,
    stopWhen: stepCountIs(Math.min(dependencies.config.agent.main.maxSteps, dependencies.config.quota.perTurn.maxSteps)),
    include: { requestMessages: true, requestBody: true, responseBody: true },
    prepareStep: async ({ stepNumber: rawStep, messages }) => {
      // 收尾补跑是**另一次** `agent.generate`，它的 stepNumber 从 0 重新起。不换算的话：
      // ① `stepSpans.set(0, …)` 会顶掉主轮 step 0 那条已经结束的 span（出错时还会被 end 第二次）；
      // ② `stepAlias.set(0, …)` 会改写 step 0 实际用的别名，记账落到错的模型上；
      // ③ `downgrade` 判据回到 0，一轮从 step 8 起就在跑 low 的会话，最后这句结论反而按主别名计价。
      const stepNumber = wrapUpMode ? mainStepCount + rawStep : rawStep;
      await dependencies.plugins?.hook('beforeModelCall', { turn, step: stepNumber });
      const skillAllow = turn.skillAllowedTools?.size ? new Set<string>([...turn.skillAllowedTools, ...SKILL_NARROWING_EXEMPT]) : null;
      const activeForStep = dependencies.tools.activeNames(turn.effectiveRole, toolContext).filter((name) => !skillAllow || skillAllow.has(name));
      const requestedAlias = turn.modelAliasOverride ?? alias;
      const downgrade = stepNumber >= dependencies.config.agent.main.downgradeAfterStep && dependencies.registry.aliases().includes('low');
      let selectedAlias = downgrade ? 'low' : requestedAlias;
      // **vision 压过其它一切**（`docs/04 §5.2`）：`low` 大概也看不见图，`set_model` 指定的别名
      // 同样可能看不见 —— 看不见图的模型拿到这一轮就只能瞎猜或者绕远路。`vision` 优先，退而用
      // 「降档前那个别名自己就支持」这一条：为了省钱降档而把眼睛降掉是最不划算的一种省。
      if (turnHasImages && !dependencies.registry.supportsVision(selectedAlias)) {
        // 候选里带上 `alias`（本轮解析出来的那个）：`set_model('low')` 把 `requestedAlias` 换掉之后，
        // 「降档前那个别名」就只剩它了。
        const seeing = ['vision', requestedAlias, alias].find((name) => dependencies.registry.supportsVision(name));
        if (seeing) {
          if (!visionSwitchLogged) {
            visionSwitchLogged = true;
            dependencies.log.event({ level: 'info', kind: 'provider.fallback', summary: `${selectedAlias} → ${seeing}`,
              traceId: turn.turnId, key: turn.key, data: { alias: selectedAlias, from: selectedAlias, to: seeing, reason: 'vision_required' } });
          }
          selectedAlias = seeing;
        }
      }
      // 采样参数按「当步实际选中的别名」取：降档到 low 之后就该用 low 的参数（04 §5.2.1）。
      stepAlias.set(stepNumber, selectedAlias);
      const patch: { activeTools?: string[]; model?: LanguageModel; messages?: ModelMessage[]; toolChoice?: 'none' } & AliasSettings = { activeTools: activeForStep, model: wrappedFor(selectedAlias), ...dependencies.registry.settings(selectedAlias) };
      // 单轮成本闸门读 ledger：`reservation.committed` 只含主 agent 的花费，子 agent 全部漏在外面
      // （docs/20 · W-QUOTA-01）。`turnCost` 把主 agent 与该轮所有子 agent 的花费都算进去了。
      const cost = dependencies.ledger.turnCost(turn.turnId);
      if (cost >= dependencies.config.quota.perTurn.maxCostUsd || (dependencies.quota && dependencies.reservation && !dependencies.quota.canSpend(dependencies.reservation, dependencies.config.quota.perTurn.maxCostUsd))) { patch.activeTools = []; patch.toolChoice = 'none'; }
      // 收尾补跑（§2）走的是同一条禁工具的路，不另造一套：那一次只许说话，再调工具就又可能
      // 以工具调用收尾，把同一个坑挖第二遍。
      if (wrapUpMode) { patch.activeTools = []; patch.toolChoice = 'none'; }
      // 推理条目一律不回传。openai responses provider 会把上一步的 reasoning 写成
      // `{type:'item_reference', id:'rs_…'}` —— 那份内容存在 OpenAI 服务端，第三方兼容网关
      // 手上没有，解析不了就整个请求 502。表现是「模型一调工具就再也不说话」：后续那一步
      // 重试三次全挂，而 AI SDK 把 RetryError 吞成空结果，调用方看到的只是「什么都没生成」。
      // reasoning 本来也只在一轮的步骤之间有意义（上下文里不落盘），摘掉它换来的是工具调用之后还能有回复。
      patch.messages = pruneMessages({ messages, reasoning: 'all' });
      const selected = dependencies.registry.info(selectedAlias) ?? initialInfo;
      const cap = selected.contextWindow * dependencies.config.context.hardCapRatio;
      if (estimateModelMessages(patch.messages) > cap) {
        patch.messages = pruneMessages({ messages: patch.messages, toolCalls: 'before-last-3-messages', emptyMessages: 'remove' });
        dependencies.log.event({ level: 'warn', kind: 'ctx.hardcap', summary: 'Pruned in-flight model messages', traceId: turn.turnId, key: turn.key, data: { stepNumber, cap, before: estimateModelMessages(messages), after: estimateModelMessages(patch.messages) } });
      }
      return patch;
    },
    onStepStart: (event) => {
      const stepNumber = wrapUpMode ? mainStepCount + event.stepNumber : event.stepNumber;
      stepSpans.set(stepNumber, dependencies.log.span({ level: 'info', kind: 'model.call', summary: `${event.provider}/${event.modelId}`, traceId: turn.turnId, key: turn.key,
        data: { stepNumber, wrapUp: wrapUpMode || undefined, modelId: event.modelId, provider: event.provider, messages: bodyForLog(event.messages, dependencies.config.logs.captureBodies), instructions: bodyForLog(event.instructions, dependencies.config.logs.captureBodies) } }));
      dependencies.log.publish('turn.progress', { turnId: turn.turnId, phase: 'model', step: stepNumber, note: `${event.provider}/${event.modelId}` });
    },
    // 四件事拆成四个可单独喂假 step 的观察者（`step-observers.ts`，docs/27 · D-05）。
    // 这里只剩「把 AI SDK 的 step 映射成 StepFacts」这一层适配 —— 那个 step 类型没人能手搓，
    // 而记账 / 广播 / 上下文 / 校准真正需要的只有十来个字段。
    onStepEnd: (step) => {
      const stepNumber = wrapUpMode ? mainStepCount + step.stepNumber : step.stepNumber;
      if (!wrapUpMode) mainStepCount = Math.max(mainStepCount, step.stepNumber + 1);
      const facts: StepFacts = { stepNumber, servedModelId: servedModelId ?? step.model.modelId,
        usage: { inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0,
          cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0, cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
          // `inputTokens` 是 total（超集），计价要用这一份互斥的。三家 provider 一致，见 `pricedInputTokens`。
          noCacheTokens: step.usage.inputTokenDetails.noCacheTokens ?? undefined,
          reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0 },
        latencyMs: step.performance.responseTimeMs, finishReason: step.finishReason,
        toolCalls: step.toolCalls.map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })),
        toolResults: stepToolResults(step.content),
        requestBody: (step.request as { body?: unknown } | undefined)?.body };
      // 收尾判据取自**最后一步**，所以每步都覆写而不是累积。`sawToolCall` 反过来要累积：
      // 判的是「这一轮到底做过事没有」，只有做过事才值得补一句结论。
      lastStepHadText = step.text.trim() !== '';
      if (step.toolCalls.length) sawToolCall = true;
      // `turns.steps` 此前没有任何写入方（全库 steps>0 的行数为 0），WebUI 轮次列表与
      // `turn.finished` 事件里这个数永远是 0 —— 本次排查因此只能去翻 blob 还原步骤。
      // 用换算后的编号：收尾补跑那一步也是真花了钱的一步，不该在这个数里隐身。
      dependencies.turns?.countStep(turn.turnId, stepNumber + 1);
      const resolved = observers.record(facts);
      observers.broadcast(facts, resolved);
      stepSpans.get(stepNumber)?.end({ model: step.model, usage: step.usage, cost: resolved.cost, request: bodyForLog(step.request, dependencies.config.logs.captureBodies), response: bodyForLog(step.response, dependencies.config.logs.captureBodies) });
      observers.appendContext(facts);
      observers.calibrate(facts);
    },
  });
  /**
   * 「最后一步只有 reasoning / 只有工具调用」时补跑一次收尾（§2）。四个闸全过才跑，最多一次：
   * ① 最后一步没有正文；② 这一轮真的做过事；③ 上游没挂（`streamFailure` 非空时再跑一次纯属
   * 接着烧钱）；④ 单轮成本闸还有余量。**不伪造答复** —— 是让模型自己写结论（docs/16 §5）。
   */
  const wrapUpIfNeeded = async (): Promise<string> => {
    if (lastStepHadText || !sawToolCall || streamFailure) return '';
    if (dependencies.ledger.turnCost(turn.turnId) >= dependencies.config.quota.perTurn.maxCostUsd) return '';
    if (turn.abortSignal.aborted) return '';
    wrapUpMode = true;
    try {
      // **不要再把 `result.responseMessages` 拼进来**：`observers.appendContext` 每一步都已经把
      // tool-call / tool-result 追进了 `turn.delta`，而 `contextMessages` 读的就是
      // `snapshot + delta` —— 拼一遍等于同一个 `toolCallId` 出现两次，Anthropic 直接 400，
      // 这个补跑于是永远静默失败；宽容一些的 provider 则要为每份工具输出付两次钱。
      // 收尾指令塞进**易变段内部**而不是追加成新消息：KERNEL 说「只有请求最末尾那个
      // system-instructions 块是真的」，在它后面再挂一个，等于让模型把自己的 RUNTIME、
      // 权限行与工具目录当成伪造的用户正文（顺带也保住了「易变段物理最后」这条缓存前提）。
      const messages = contextMessages(turn, dependencies.db, { ...messageOptions, volatile: `${prompt.volatile}\n\n${WRAP_UP_INSTRUCTION}` });
      const wrapped = await agent.generate({ messages, abortSignal: turn.abortSignal });
      const text = wrapped.text.trim();
      dependencies.log.event({ level: 'warn', kind: 'turn.wrap_up', summary: text ? 'Wrapped up a turn that ended without text' : 'Wrap-up produced nothing',
        traceId: turn.turnId, key: turn.key, data: { chars: text.length } });
      return text;
    } catch (error) {
      // 补跑失败不能把整轮拖下水：旁白已经发出去了，这里抛等于让用户既看到回复又收到一句「这轮没成」。
      dependencies.log.event({ level: 'warn', kind: 'turn.wrap_up', summary: 'Wrap-up call failed', traceId: turn.turnId, key: turn.key,
        data: { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) } });
      return '';
    } finally { wrapUpMode = false; }
  };
  try {
    if (streaming) {
      const result = await agent.stream({ messages: contextMessages(turn, dependencies.db, messageOptions), abortSignal: turn.abortSignal });
      let settled = false;
      const finish = (text: string): string => { if (!settled && mainRun) dependencies.agents?.finish(mainRun, text); settled = true; return text; };
      const fail = (error: unknown): never => { if (!settled && mainRun) dependencies.agents?.fail(mainRun, error instanceof Error ? error.message : String(error)); settled = true; throw error; };
      // `final` 必须挂在**流结束**上而不是直接挂 `result.text`：收尾补跑发生在流耗尽之后，
      // 而 `result.text` 在那之前就 resolve 了 —— 直接挂的话每次都读到补跑之前的空串。
      let streamDone!: () => void;
      const drained = new Promise<void>((resolve) => { streamDone = resolve; });
      let wrapUp = '';
      let delivered = (): string => '';
      // 空正文 + 捕获到步骤失败 = 上游挂了，不是模型没话说。把真正的原因抛出去，
      // 让轮次记成 failed 并给用户一句能看懂的话，而不是含糊的「没吐出正文」。
      const final = drained.then(() => result.text).then((text) => {
        if (!text.trim() && streamFailure) throw streamFailure;
        // `result.text` 是 AI SDK v7 的**最后一步**正文，不是全轮拼接。最后一步以工具调用收尾时
        // 它就是空串，此前 `bot.ts` 于是回落到「把过程旁白当答复」（本次事故）。
        // 补跑到了就用**整条发出去的文本**（旁白 + 分隔 + 结论），不是只用结论那一段：归档与
        // 上下文存的必须是用户屏幕上那条消息，否则下一轮模型看不见自己的旁白，用户一句
        // 「你上面第二段说的」就无从对应。
        return text.trim() ? text : delivered();
      }).then(finish, fail);
      /**
       * **`final` 必须在创建处就被认领。**
       *
       * `fail` 是 rethrow，所以这条链是会 reject 的；唯一的 catch 在 `bot.ts`，而它们全部排在
       * `await output.consume(...)` 之后 —— `consume` 开头还卡在 `sendChatAction`（实测 561ms）。
       * 中间这一段就是「无人认领」的窗口：0 步返回时 AI SDK 在 flush 里用
       * `NoOutputGeneratedError` reject `result.text`（那是 `steps.then().then()` 的**派生** promise，
       * SDK 只把基础 promise 标成 handled），`main.ts` 的 unhandledRejection 处理器于是先一步
       * 把进程带走 —— `bot.ts` 那三处 catch 一次都没跑到，`model.error` 也来不及写。
       * 实测 logs/2026-08-18 22:17:29 与 23:19:43，两次都是 `sendChatAction` 结束后 1ms。
       *
       * 认领之后语义不变：`bot.ts` 那边 `await generated.final` 照旧拿到这个 rejection
       * （已被观测过的 promise 再 await 一样抛）。
       */
      void final.catch(() => undefined);
      let emitted = '';
      const stream = stepSeparatedText(result.stream as AsyncIterable<StreamPartLike>, async () => {
        /**
         * **一步都没跑完 = 上游给了个空流，不是模型没话说。** `fallback-model` 的 `reporting()`
         * 只在 `doStream` **抛**的时候报 `onExhausted`；中转站 200 收下、流里 0 步就关闭那一路
         * 既不抛也不触发 `idleGuarded`，于是 `streamFailure` 恒为 null、日志里一条 `model.error`
         * 都没有，用户看到的只有沉默。补上这一条之后它走的是下面那条既有的 `broken` 路：
         * 轮次记 failed、用户拿到能看懂的原因、日志有 `model.error`。
         * 必须排在 `wrapUpIfNeeded` **之前** —— 那里第一道闸就在读 `streamFailure`。
         */
        if (mainStepCount === 0 && !turn.abortSignal.aborted) noteStreamFailure(new Error('upstream_no_output'));
        // `wrapUpIfNeeded` 自己吞掉所有异常，这里不会因为它而把流记成 interrupted。
        try { wrapUp = await wrapUpIfNeeded(); } finally { streamDone(); }
        /**
         * **断掉的轮次必须让投递侧看见。** 步骤级失败与轮次中止都不会让 `result.stream` 抛：
         * AI SDK 把它们吞进内部 onError，流照常正常结束，而 `result.text` 还是**上一步**的正文
         * —— 于是「已经吐过内容之后断掉」这一路在 `bot.ts` 眼里和正常收尾一模一样：用户既没有
         * 「（生成中断）」也没有超时提示，`turns` 那行还记成 committed。实测
         * logs/2026-08-18 · B8F92Z：600 秒到点 abort（`model.error timeout`），3 分钟后
         * `turn.end turn committed`。这里抛出去 = `TelegramOutput.consume` 的 `interrupted`，
         * 也就是 docs/04 §5.3 说的那条「已输出部分内容后失败」的路。
         *
         * 抛之前先走 `fail`：`streamDone()` 已经放开了 `drained`，`final` 那条链下一个微任务就要
         * 用 `finish` 把 agent run 记成完成 —— 不在同一个同步块里把 `settled` 抢下来，
         * `agent_runs` 会说这次子运行成功了。丢掉的 `wrapUp` 恒为空串（断掉时 `wrapUpIfNeeded`
         * 第一道闸就返回了）。
         */
        const broken = turn.abortSignal.aborted ? turn.abortSignal.reason ?? 'aborted' : streamFailure;
        if (broken) fail(broken instanceof Error ? broken : new Error(String(broken)));
        // 「图片降级了」那句提示走**同一条**收尾通道（`docs/08 §7.2` 要求它在回复末尾）：
        // 另开一条 core→telegram 的管子只为了追加一行文本，两边都要多一个概念。
        if (visionDegraded) return wrapUp ? `${wrapUp}\n\n${VISION_UNSUPPORTED_NOTICE}` : VISION_UNSUPPORTED_NOTICE;
        return wrapUp;
      }, (chunk) => { emitted += chunk; }, noteStreamFailure);
      // 尾部只要真的追加过东西（补跑的结论、或者那句看不了图的提示），`final` 就该是**整条发出去
      // 的文本**而不是最后一步的正文 —— 归档与上下文存的必须和用户屏幕上一致。
      delivered = () => (wrapUp || visionDegraded ? emitted : '');
      // `interrupt()` 也要放开 `drained`：被打断那条路（`bot.ts` 里的 `void generated.final.catch()`）
      // 不会再去把生成器读完，不放的话那个 promise 永远悬着。
      return { stream, final, interrupt: () => { streamDone(); if (!settled && mainRun) dependencies.agents?.fail(mainRun, 'stream_interrupted'); settled = true; } };
    }
    const result = await agent.generate({ messages: contextMessages(turn, dependencies.db, messageOptions), abortSignal: turn.abortSignal });
    // 非流式（定时任务走这条）同样吃 `result.text` = 最后一步正文那条语义：以工具调用收尾的
    // 定时任务此前会空正文 → `model_returned_empty`，整条任务静默失败。
    // 非流式（定时任务）也要带那句提示：这条路同样可能收到图（被回复的那条消息里那张）。
    const withVisionNotice = (text: string): string => (visionDegraded && text.trim() ? `${text}\n\n${VISION_UNSUPPORTED_NOTICE}` : text);
    if (!result.text.trim()) {
      const wrapUp = withVisionNotice(await wrapUpIfNeeded());
      if (wrapUp) { if (mainRun) dependencies.agents?.finish(mainRun, wrapUp); return wrapUp; }
    }
    if (!result.text.trim() && streamFailure) throw streamFailure;
    const answer = withVisionNotice(result.text);
    if (mainRun) dependencies.agents?.finish(mainRun, answer);
    return answer;
  } catch (error) {
    if (mainRun) dependencies.agents?.fail(mainRun, error instanceof Error ? error.message : String(error));
    for (const span of stepSpans.values()) span.end(undefined, error);
    const info = initialInfo;
    dependencies.ledger.record({ turnId: turn.turnId, chatId: turn.chatId, userId: turn.initiatorUserId, providerId: info.providerId,
      modelId: info.modelId, modelAlias: alias, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, priceIn: info.priceIn, priceOut: info.priceOut, priceCacheRead: info.priceCacheRead,
      priceCacheWrite: info.priceCacheWrite, latencyMs: 0, ok: false, errorKind: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}
