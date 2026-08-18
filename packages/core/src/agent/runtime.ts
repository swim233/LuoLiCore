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
import { escapeSystemInstructions, estimateStructureTokens, formatSpeakerIdentity, systemInstructions, type RuntimeTurnContext } from '@luoli/shared';
import type { PromptAssembler, PromptDocuments } from '../index.js';
import { runtimeBlock, type PromptBuildResult } from '../prompt/assembler.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/registry.js';
import { SKILL_NARROWING_EXEMPT } from '../tools/policy.js';
import type { ProviderStore } from '../provider/store.js';
import { type FallbackOptions, fallbackLanguageModel } from './fallback-model.js';
import { createStepObservers, type StepFacts } from './step-observers.js';
import { type AliasSettings, parseAliasSettings } from '../provider/alias-settings.js';
import type { UsageLedger } from '../ledger/usage.js';
import type { QuotaGuard, QuotaReservation } from '../ledger/quota.js';
import type { LogSink } from '../log/sink.js';
import type { ContextEngine } from '../context/engine.js';
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
    const providerRows = this.db.prepare(`SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers
      WHERE enabled=1 AND (COALESCE(health_state,'up') <> 'down' OR COALESCE(health_checked_at,0) < ?)`)
      .all(Date.now() - cooldownMinutes * 60_000) as ProviderRow[];
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
  markProviderDown(modelId: string, error: string): void {
    const row = this.infoByModelId(modelId);
    if (row) this.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?").run(Date.now(), error.slice(0, 500), row.providerId);
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
 * 按别名构造带 fallback / 重试包装的模型。包装必须做在「按别名解析」这一层：`prepareStep` 每一步
 * 都会重设 model，只包构造时那一个等于整条链从第 0 步起就没被用过（docs/20 · W-AGENT-01）。
 * 别名没有链（registry 只认识它的回退目标）时退回裸模型，行为与 `resolve()` 一致。
 */
export function aliasModel(registry: ModelRegistry, alias: string, options: FallbackOptions): LanguageModel {
  const candidates = registry.chain(alias);
  return candidates.length
    ? fallbackLanguageModel(candidates.map((candidate) => ({ model: candidate.model, id: candidate.info.modelId })), options)
    : registry.resolve(alias);
}

const SENDABLE_ROLES = new Set(['user', 'assistant', 'tool']);
const NOTE_PREFIX = '（系统提示）';
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
}

export function contextMessages(turn: RuntimeTurnContext, attachments?: Sqlite, options?: ContextMessageOptions): ModelMessage[] {
  const messages = [...turn.snapshot.messages, ...turn.delta].map((message) => {
    const content = (message.parts as Array<Record<string, unknown>>).map((part) => {
      if (part?.type === 'tool-result') return { ...part, output: normalizeToolOutput(part.output) };
      if (part?.type === 'image') return imageToFilePart(part);
      if (part?.type === 'file' && typeof part.ref === 'string' && part.ref.startsWith('attachment://')) return hydrateAttachment(part, attachments);
      // 易变段现在和用户正文同处 user role，正文里能写出 `<system-instructions` 就等于能伪造它。
      // 只改 text 字符串，判别字段一个不碰（docs/02 红线 14）。
      if (typeof part?.text === 'string') return { ...part, text: escapeSystemInstructions(part.text) };
      return part;
    });
    if (SENDABLE_ROLES.has(message.role)) return { role: message.role, content } as ModelMessage;
    const text = content.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
    return { role: 'user', content: [{ type: 'text', text: `${NOTE_PREFIX}${text}` }] } as ModelMessage;
  });
  // 断点打在「已提交历史的最后一条」而不是整个数组的最后一条：本轮 delta 与工具循环的产出都排在
  // 它之后，所以这段前缀下一轮原样还在，能整段命中。跟着最后一条走的话每步都换位置，等于没打。
  const stored = turn.snapshot.messages.length;
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
  const skillCatalog = dependencies.skills?.catalog(turn.effectiveRole).map((skill) => `- skill:${skill.name}: ${skill.description}`).join('\n') ?? '';
  // `prompt.includeToolCatalog=false` 时只发工具名（RUNTIME 里那一行），不发描述。省的是每轮
  // 几百到几千 token，代价是模型少了参数用法的提示 —— 所以默认开着。
  const catalog = dependencies.config.prompt.includeToolCatalog
    ? [...dependencies.tools.catalog(turn.effectiveRole, toolContext).map((entry) => `- ${entry.name}: ${entry.description}`), skillCatalog].filter(Boolean).join('\n')
    : '';
  const runtimeShow = dependencies.config.prompt.runtimeBlock;
  const spent = dependencies.quota && dependencies.reservation ? dependencies.quota.status(dependencies.reservation) : null;
  const runtime = runtimeBlock({ now: new Date(), timezone: dependencies.config.general.timezone,
    chatDescription: `${turn.chatId} / ${turn.key}`, triggerDescription: initiatorDescription(turn), role: turn.effectiveRole,
    tools: activeTools, agents: dependencies.config.agent.agents.filter((agent) => ['blocked', 'limited', 'trusted', 'owner'].indexOf(turn.effectiveRole) >= ['blocked', 'limited', 'trusted', 'owner'].indexOf(agent.minRole)).map((agent) => `${agent.name}(${agent.description})`),
    contextMessages: turn.snapshot.messages.length, contextTokens: turn.snapshot.tokens, maxMessages: dependencies.config.context.limit.maxMessages,
    maxTokens: dependencies.config.context.limit.tokens, workspace: dependencies.workspace, sandbox: dependencies.config.sandbox.mode,
    // 只在真有本轮预留时才给得出额度；WebUI 的提示词预览没有预留，那一行本来就不该出现。
    ...(spent ? { quota: `本轮已用 $${spent.committed.toFixed(4)} / 上限 $${dependencies.config.quota.perTurn.maxCostUsd.toFixed(2)}` } : {}),
    show: { quota: runtimeShow.showQuota, contextWatermark: runtimeShow.showContextWatermark, workspace: runtimeShow.showWorkspace } });
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

export async function streamMainAgent(turn: RuntimeTurnContext, dependencies: MainAgentDependencies): Promise<MainAgentStreamResult> {
  return runMainAgentInternal(turn, dependencies, true) as Promise<MainAgentStreamResult>;
}
export async function runMainAgent(turn: RuntimeTurnContext, dependencies: MainAgentDependencies): Promise<string> {
  return runMainAgentInternal(turn, dependencies, false) as Promise<string>;
}

async function runMainAgentInternal(turn: RuntimeTurnContext, dependencies: MainAgentDependencies, streaming: boolean): Promise<string | MainAgentStreamResult> {
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
  // 步骤级失败（上游 5xx、重试耗尽）不会从 textStream 抛出来：AI SDK 把它吞进内部的 onError，
  // 让 result.text 安静地解析成空串。不抓住这一份，一次彻底的上游故障和「模型没话说」
  // 在调用方眼里长得一模一样 —— 上一次就是这样变成「不回复」的。
  let streamFailure: unknown = null;
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
      onServed: (served) => { servedModelId = served.id; },
      onFallback: (from, to) => dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${from.id} → ${to.id}`, traceId: turn.turnId, data: { alias: aliasName, from: from.id, to: to.id } }),
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
  const messageOptions: ContextMessageOptions = { volatile: prompt.volatile, cacheBreakpoint: providerKind === 'anthropic' };
  const stepSpans = new Map<number, { id: string; end: (data?: unknown, error?: unknown) => void }>();
  const stepAlias = new Map<number, string>();
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
    prepareStep: async ({ stepNumber, messages }) => {
      await dependencies.plugins?.hook('beforeModelCall', { turn, step: stepNumber });
      const skillAllow = turn.skillAllowedTools?.size ? new Set<string>([...turn.skillAllowedTools, ...SKILL_NARROWING_EXEMPT]) : null;
      const activeForStep = dependencies.tools.activeNames(turn.effectiveRole, toolContext).filter((name) => !skillAllow || skillAllow.has(name));
      const requestedAlias = turn.modelAliasOverride ?? alias;
      const downgrade = stepNumber >= dependencies.config.agent.main.downgradeAfterStep && dependencies.registry.aliases().includes('low');
      const selectedAlias = downgrade ? 'low' : requestedAlias;
      // 采样参数按「当步实际选中的别名」取：降档到 low 之后就该用 low 的参数（04 §5.2.1）。
      stepAlias.set(stepNumber, selectedAlias);
      const patch: { activeTools?: string[]; model?: LanguageModel; messages?: ModelMessage[]; toolChoice?: 'none' } & AliasSettings = { activeTools: activeForStep, model: wrappedFor(selectedAlias), ...dependencies.registry.settings(selectedAlias) };
      // 单轮成本闸门读 ledger：`reservation.committed` 只含主 agent 的花费，子 agent 全部漏在外面
      // （docs/20 · W-QUOTA-01）。`turnCost` 把主 agent 与该轮所有子 agent 的花费都算进去了。
      const cost = dependencies.ledger.turnCost(turn.turnId);
      if (cost >= dependencies.config.quota.perTurn.maxCostUsd || (dependencies.quota && dependencies.reservation && !dependencies.quota.canSpend(dependencies.reservation, dependencies.config.quota.perTurn.maxCostUsd))) { patch.activeTools = []; patch.toolChoice = 'none'; }
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
      stepSpans.set(event.stepNumber, dependencies.log.span({ level: 'info', kind: 'model.call', summary: `${event.provider}/${event.modelId}`, traceId: turn.turnId, key: turn.key,
        data: { stepNumber: event.stepNumber, modelId: event.modelId, provider: event.provider, messages: bodyForLog(event.messages, dependencies.config.logs.captureBodies), instructions: bodyForLog(event.instructions, dependencies.config.logs.captureBodies) } }));
      dependencies.log.publish('turn.progress', { turnId: turn.turnId, phase: 'model', step: event.stepNumber, note: `${event.provider}/${event.modelId}` });
    },
    // 四件事拆成四个可单独喂假 step 的观察者（`step-observers.ts`，docs/27 · D-05）。
    // 这里只剩「把 AI SDK 的 step 映射成 StepFacts」这一层适配 —— 那个 step 类型没人能手搓，
    // 而记账 / 广播 / 上下文 / 校准真正需要的只有十来个字段。
    onStepEnd: (step) => {
      const facts: StepFacts = { stepNumber: step.stepNumber, servedModelId: servedModelId ?? step.model.modelId,
        usage: { inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0,
          cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0, cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
          reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0 },
        latencyMs: step.performance.responseTimeMs, finishReason: step.finishReason,
        toolCalls: step.toolCalls.map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })),
        toolResults: step.toolResults.map((result) => ({ toolCallId: result.toolCallId, toolName: result.toolName,
          part: toolResultPart(result.toolCallId, result.toolName, result.output), preview: `${result.toolName}: ${JSON.stringify(result.output).slice(0, 180)}` })),
        requestBody: (step.request as { body?: unknown } | undefined)?.body };
      const resolved = observers.record(facts);
      observers.broadcast(facts, resolved);
      stepSpans.get(step.stepNumber)?.end({ model: step.model, usage: step.usage, cost: resolved.cost, request: bodyForLog(step.request, dependencies.config.logs.captureBodies), response: bodyForLog(step.response, dependencies.config.logs.captureBodies) });
      observers.appendContext(facts);
      observers.calibrate(facts);
    },
  });
  try {
    if (streaming) {
      const result = await agent.stream({ messages: contextMessages(turn, dependencies.db, messageOptions), abortSignal: turn.abortSignal });
      let settled = false;
      const finish = (text: string): string => { if (!settled && mainRun) dependencies.agents?.finish(mainRun, text); settled = true; return text; };
      const fail = (error: unknown): never => { if (!settled && mainRun) dependencies.agents?.fail(mainRun, error instanceof Error ? error.message : String(error)); settled = true; throw error; };
      // 空正文 + 捕获到步骤失败 = 上游挂了，不是模型没话说。把真正的原因抛出去，
      // 让轮次记成 failed 并给用户一句能看懂的话，而不是含糊的「没吐出正文」。
      const final = Promise.resolve(result.text).then((text) => { if (!text.trim() && streamFailure) throw streamFailure; return text; }).then(finish, fail);
      return { stream: result.textStream, final, interrupt: () => { if (!settled && mainRun) dependencies.agents?.fail(mainRun, 'stream_interrupted'); settled = true; } };
    }
    const result = await agent.generate({ messages: contextMessages(turn, dependencies.db, messageOptions), abortSignal: turn.abortSignal });
    if (!result.text.trim() && streamFailure) throw streamFailure;
    if (mainRun) dependencies.agents?.finish(mainRun, result.text);
    return result.text;
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
