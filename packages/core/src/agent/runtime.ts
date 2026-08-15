import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, pruneMessages, stepCountIs, tool } from 'ai';
import type { Instructions, LanguageModel, ModelMessage, Provider, ToolSet } from 'ai';
type V4LanguageModel = Exclude<LanguageModel, string> & { specificationVersion: 'v4' };
import type { Config } from '../config/schema.js';
import type { Sqlite } from '@luoli/db';
import { modelAliasKey, readAppKv } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';
import type { PromptAssembler, PromptDocuments } from '../index.js';
import { runtimeBlock } from '../prompt/assembler.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/registry.js';
import type { ProviderStore } from '../provider/store.js';
import { fallbackLanguageModel } from './fallback-model.js';
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

  constructor(private readonly db: Sqlite, private readonly providers: ProviderStore) {}

  rebuild(): void {
    this.#models.clear();
    this.#info.clear();
    this.#chains.clear();
    this.#settings.clear();
    const providerRows = this.db.prepare("SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers WHERE enabled=1 AND COALESCE(health_state,'up') <> 'down'").all() as ProviderRow[];
    const providerInstances = new Map<string, Provider>();
    for (const provider of providerRows) {
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
  infoByModelId(modelId: string): ModelRow | null {
    for (const info of this.#info.values()) if (info.modelId === modelId) return info;
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
export function contextMessages(turn: RuntimeTurnContext): ModelMessage[] {
  return [...turn.snapshot.messages, ...turn.delta].map((message) => ({
    role: message.role,
    content: message.parts,
  } as ModelMessage));
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

function cachedInstructions(text: string, providerKind: string): Instructions {
  if (providerKind !== 'anthropic') return text;
  return { role: 'system', content: text, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } };
}

function estimateModelMessages(messages: ModelMessage[]): number {
  return Math.ceil([...JSON.stringify(messages)].length * 0.6) + 4;
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
  await dependencies.plugins?.hook('beforeTurn', { turn });
  const activeNames = dependencies.tools.activeNames(turn.effectiveRole, toolContext);
  const documents = dependencies.documents.readForPrompt({ userId: turn.initiatorUserId, isPrivate: turn.isPrivate });
  const skillCatalog = dependencies.skills?.catalog(turn.effectiveRole).map((skill) => `- skill:${skill.name}: ${skill.description}`).join('\n') ?? '';
  const catalog = [...dependencies.tools.catalog(turn.effectiveRole, toolContext).map((entry) => `- ${entry.name}: ${entry.description}`), skillCatalog].filter(Boolean).join('\n');
  const runtime = runtimeBlock({ now: new Date(), timezone: dependencies.config.general.timezone,
    chatDescription: `${turn.chatId} / ${turn.key}`, triggerDescription: `user ${turn.initiatorUserId}`, role: turn.effectiveRole,
    tools: activeNames, agents: dependencies.config.agent.agents.filter((agent) => ['blocked', 'limited', 'trusted', 'owner'].indexOf(turn.effectiveRole) >= ['blocked', 'limited', 'trusted', 'owner'].indexOf(agent.minRole)).map((agent) => `${agent.name}(${agent.description})`),
    contextMessages: turn.snapshot.messages.length, contextTokens: turn.snapshot.tokens, maxMessages: dependencies.config.context.limit.maxMessages,
    maxTokens: dependencies.config.context.limit.tokens, workspace: dependencies.workspace, sandbox: dependencies.config.sandbox.mode });
  const promptInput = { character: documents.character, assist: documents.assist, catalog, publicMemory: documents.publicMemory, runtime, maxTokens: dependencies.config.prompt.maxTokens };
  if (documents.privateMemory !== undefined) Object.assign(promptInput, { privateMemory: documents.privateMemory });
  const instructionText = dependencies.prompts.build(promptInput).instructions;
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
  const model = fallbackLanguageModel(chain.map((candidate) => ({ model: candidate.model, id: candidate.info.modelId })), {
    maxRetries: dependencies.config.provider.maxRetries, retryBaseMs: dependencies.config.provider.retryBaseMs,
    retryMaxMs: dependencies.config.provider.retryMaxMs, abortSignal: turn.abortSignal,
    onFallback: (from, to) => dependencies.log.event({ level: 'warn', kind: 'provider.fallback', summary: `${from.id} → ${to.id}`, traceId: turn.turnId, data: { from: from.id, to: to.id } }),
    onUnavailable: (candidate, error) => {
      dependencies.registry.markProviderDown(candidate.id, error instanceof Error ? error.message : 'authentication_failed');
      dependencies.log.event({ level: 'error', kind: 'provider.health', summary: `${candidate.id} credentials rejected`, traceId: turn.turnId, data: { modelId: candidate.id } });
    },
  });
  const initialInfo = chain[0]!.info;
  const instructions = cachedInstructions(instructionText, dependencies.db.prepare('SELECT kind FROM providers WHERE id=?').pluck().get(initialInfo.providerId) as string ?? '');
  const stepSpans = new Map<number, { id: string; end: (data?: unknown, error?: unknown) => void }>();
  const agent = new ToolLoopAgent({ model, instructions, tools: toolSet, activeTools: activeNames,
    stopWhen: stepCountIs(Math.min(dependencies.config.agent.main.maxSteps, dependencies.config.quota.perTurn.maxSteps)),
    include: { requestMessages: true, requestBody: true, responseBody: true },
    prepareStep: async ({ stepNumber, messages }) => {
      await dependencies.plugins?.hook('beforeModelCall', { turn, step: stepNumber });
      const skillAllow = turn.skillAllowedTools?.size ? new Set([...turn.skillAllowedTools, 'load_skill']) : null;
      const activeForStep = dependencies.tools.activeNames(turn.effectiveRole, toolContext).filter((name) => !skillAllow || skillAllow.has(name));
      const requestedAlias = turn.modelAliasOverride ?? alias;
      const downgrade = stepNumber >= dependencies.config.agent.main.downgradeAfterStep && dependencies.registry.aliases().includes('low');
      const selectedAlias = downgrade ? 'low' : requestedAlias;
      // 采样参数按「当步实际选中的别名」取：降档到 low 之后就该用 low 的参数（04 §5.2.1）。
      const patch: { activeTools?: string[]; model?: LanguageModel; messages?: ModelMessage[]; toolChoice?: 'none' } & AliasSettings = { activeTools: activeForStep, model: dependencies.registry.resolve(selectedAlias), ...dependencies.registry.settings(selectedAlias) };
      const cost = dependencies.reservation?.committed ?? ((dependencies.db.prepare('SELECT cost_usd FROM turns WHERE id=?').pluck().get(turn.turnId) as number | undefined) ?? 0);
      if (cost >= dependencies.config.quota.perTurn.maxCostUsd || (dependencies.quota && dependencies.reservation && !dependencies.quota.canSpend(dependencies.reservation, dependencies.config.quota.perTurn.maxCostUsd))) { patch.activeTools = []; patch.toolChoice = 'none'; }
      const selected = dependencies.registry.info(selectedAlias) ?? initialInfo;
      const cap = selected.contextWindow * dependencies.config.context.hardCapRatio;
      if (estimateModelMessages(messages) > cap) {
        patch.messages = pruneMessages({ messages, reasoning: 'all', toolCalls: 'before-last-3-messages', emptyMessages: 'remove' });
        dependencies.log.event({ level: 'warn', kind: 'ctx.hardcap', summary: 'Pruned in-flight model messages', traceId: turn.turnId, key: turn.key, data: { stepNumber, cap, before: estimateModelMessages(messages), after: estimateModelMessages(patch.messages) } });
      }
      return patch;
    },
    onStepStart: (event) => {
      stepSpans.set(event.stepNumber, dependencies.log.span({ level: 'info', kind: 'model.call', summary: `${event.provider}/${event.modelId}`, traceId: turn.turnId, key: turn.key,
        data: { stepNumber: event.stepNumber, modelId: event.modelId, provider: event.provider, messages: bodyForLog(event.messages, dependencies.config.logs.captureBodies), instructions: bodyForLog(event.instructions, dependencies.config.logs.captureBodies) } }));
    },
    onStepEnd: (step) => {
      const info = dependencies.registry.infoByModelId(step.model.modelId) ?? initialInfo;
      const cost = dependencies.ledger.record({ turnId: turn.turnId, chatId: turn.chatId, userId: turn.initiatorUserId,
        providerId: info.providerId, modelId: info.modelId, modelAlias: step.model.modelId === initialInfo.modelId ? alias : 'low',
        inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0,
        cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens ?? 0, cacheWriteTokens: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        reasoningTokens: step.usage.outputTokenDetails.reasoningTokens ?? 0, priceIn: info.priceIn, priceOut: info.priceOut,
        priceCacheRead: info.priceCacheRead, priceCacheWrite: info.priceCacheWrite, latencyMs: step.performance.responseTimeMs,
        finishReason: step.finishReason, ok: true });
      if (dependencies.quota && dependencies.reservation) dependencies.quota.commit(dependencies.reservation, cost);
      stepSpans.get(step.stepNumber)?.end({ model: step.model, usage: step.usage, cost, request: bodyForLog(step.request, dependencies.config.logs.captureBodies), response: bodyForLog(step.response, dependencies.config.logs.captureBodies) });
      for (const call of step.toolCalls) dependencies.context.appendDelta(turn, { id: `call:${call.toolCallId}`, role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }], textPreview: `${call.toolName}(${JSON.stringify(call.input).slice(0, 180)})`, pruneLevel: 2 });
      for (const result of step.toolResults) dependencies.context.appendDelta(turn, { id: `result:${result.toolCallId}`, role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName, output: result.output }], textPreview: `${result.toolName}: ${JSON.stringify(result.output).slice(0, 180)}`, pruneLevel: 1 });
      const estimatedInput = Math.max(1, turn.snapshot.tokens + turn.delta.reduce((sum, message) => sum + (message.tokens ?? 0), 0));
      const ratio = dependencies.context.calibrate(turn.key, step.usage.inputTokens ?? 0, estimatedInput, dependencies.config.context.tokenRatioAlpha);
      if (Math.abs((step.usage.inputTokens ?? 0) / estimatedInput - 1) > 0.2) dependencies.log.event({ level: 'warn', kind: 'ctx.token_calibration', summary: `token ratio ${ratio.toFixed(3)}`, traceId: turn.turnId, key: turn.key, data: { estimatedInput, realInput: step.usage.inputTokens ?? 0, ratio } });
    },
  });
  try {
    if (streaming) {
      const result = await agent.stream({ messages: contextMessages(turn), abortSignal: turn.abortSignal });
      let settled = false;
      const finish = (text: string): string => { if (!settled && mainRun) dependencies.agents?.finish(mainRun, text); settled = true; return text; };
      const fail = (error: unknown): never => { if (!settled && mainRun) dependencies.agents?.fail(mainRun, error instanceof Error ? error.message : String(error)); settled = true; throw error; };
      const final = Promise.resolve(result.text).then(finish, fail);
      return { stream: result.textStream, final, interrupt: () => { if (!settled && mainRun) dependencies.agents?.fail(mainRun, 'stream_interrupted'); settled = true; } };
    }
    const result = await agent.generate({ messages: contextMessages(turn), abortSignal: turn.abortSignal });
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
