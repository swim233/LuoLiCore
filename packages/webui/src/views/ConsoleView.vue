<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiTag from '../ui/UiTag.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiNumber from '../ui/UiNumber.vue';
import UiCheckbox from '../ui/UiCheckbox.vue';
import UiSwitch from '../ui/UiSwitch.vue';
import UiModal from '../ui/UiModal.vue';
import UiDrawer from '../ui/UiDrawer.vue';
import DataGrid from '../ui/DataGrid.vue';
import ChainPicker from '../ui/ChainPicker.vue';
import AttachmentStrip from '../ui/AttachmentStrip.vue';
import SchemaForm from '../ui/SchemaForm.vue';
import UiLineChart from '../ui/UiLineChart.vue';
import UiBarChart from '../ui/UiBarChart.vue';
import UiRing from '../ui/UiRing.vue';
import { pushToast, toastError } from '../ui/toast';
import type { Attachment, GridColumn, TagSeverity } from '../ui/types';
import { api, apiStream, hydrateSession } from '../api/client';

interface TrendPoint { day: string; messages: number; turns: number; costUsd: number }
interface Dashboard { turns: { total: number; running: number; failed: number; cost: number }; messages: { total: number }; providers: { total: number; enabled: number }; trend?: TrendPoint[] }
interface Principal { id: string; kind: string; tgId: string; role: string; displayName: string | null; username: string | null; chatType: string | null }
interface Provider { id: string; name: string; kind: string; baseUrl?: string | null; apiKeyHint: string | null; enabled: number; healthState: string | null; healthError?: string | null }
interface ProviderTest { reachable: boolean; code: string; message: string; status: number | null; latencyMs: number; models: number }
interface CatalogMeta { match: 'provider' | 'official' | 'third-party' | 'none'; catalogProviderId: string | null; catalogProviderName: string | null; catalogModelId: string | null; normalized: boolean; priceRange: { min: number; max: number; providers: number } | null; capabilities: Record<string, boolean>; reasoningControl: string | null; reasoningEfforts: string[]; modalities: { input: string[]; output: string[] }; knowledge: string | null; releaseDate: string | null }
interface CatalogModel { modelId: string; displayName: string | null; contextWindow: number | null; maxOutput: number | null; limitSource: string | null; priceIn: number | null; priceOut: number | null; priceCacheRead: number | null; priceCacheWrite: number | null; meta: CatalogMeta | null }
interface CatalogStatus { enabled: boolean; available: boolean; stale: boolean; ageMs: number | null; ttlHours: number; models?: number; providers?: number; fetchedAt?: number; error?: string | null; outcome?: string }
interface LogRow { id: number; ts: number; level: string; kind: string; summary: string; trace_id: string | null }

interface Chat { key: string; chatId: string; threadId: number | null; scope: string; tokens: number | null; messages: number | null }
interface Usage { id: number; ts: number; model_alias: string; input_tokens: number; output_tokens: number; cost_usd: number; ok: number }
// mcp_servers 的错误列叫 last_error、状态列叫 state；skills/plugins 用的是 load_error。
// 只看 load_error 的话，连不上的 MCS server 会被显示成「可用」。
interface Extension { name: string; description?: string; min_role?: string; enabled?: number; load_error?: string | null;
  state?: string | null; last_error?: string | null; transport?: string; version?: string | null; command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>; minRole?: string; toolAllow?: string[]; toolDeny?: string[]; timeoutMs?: number; tools?: Array<Record<string, unknown>> }
interface Paged<T> { items: T[]; total: number; page: number; size: number }
interface Conversation { id: string; key: string; chatId: string; userId: string; role: string; state: string; triggerReason: string | null; startedAt: number | null; finishedAt: number | null;
  steps: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number; error: string | null; rebased: number; promptMessageId: number | null;
  prompt: string | null; promptKind: string | null; fromName: string | null; fromUsername: string | null; reply: string; attachments: Attachment[] }
interface MessageHit { id: number; chatId: string; direction: string; fromName: string | null; fromUsername: string | null; kind: string; text: string | null; tgDate: number; turnId: string | null; attachments: Attachment[] }
interface ToolPolicy { minRole: string; approval: string; scope: string; source: string; enabled: boolean }
interface AgentDefinition { name: string; description: string; modelAlias: string; maxSteps: number; minRole: string; tools: string[]; resultMaxChars: number; instructions: string; injectMemory: boolean }
const active = ref('dashboard');
const dashboard = ref<Dashboard>({ turns: { total: 0, running: 0, failed: 0, cost: 0 }, messages: { total: 0 }, providers: { total: 0, enabled: 0 } });
const principals = ref<Principal[]>([]);
const providers = ref<Provider[]>([]);
const logs = ref<LogRow[]>([]);
const query = ref('');
const chats = ref<Chat[]>([]);
const usage = ref<Usage[]>([]);
const skills = ref<Extension[]>([]);
const plugins = ref<Extension[]>([]);
const mcp = ref<Extension[]>([]);
const agents = ref<AgentDefinition[]>([]);
const approvals = ref<Array<Record<string, unknown>>>([]);
const tasks = ref<Array<Record<string, unknown>>>([]);
const prompts = ref<Array<Record<string, unknown>>>([]);
const config = ref<Record<string, unknown>>({});
const botName = ref('LuoLiCore');
const tools = ref<Record<string, ToolPolicy>>({});
interface TriggerForm { private: boolean; mention: boolean; reply: boolean; command: boolean; channels: boolean; wakewords: string[]; wakewordMinLength: number; requireTextAfterMention: boolean; ignoreEditedAsTrigger: boolean }
const triggerForm = ref<TriggerForm>({ private: true, mention: true, reply: true, command: true, channels: false, wakewords: [], wakewordMinLength: 2, requireTextAfterMention: false, ignoreEditedAsTrigger: true });
const wakewordStatus = ref<Array<{ pattern: string; kind: string; ok: boolean; reason: string | null }>>([]);
const newWakeword = ref('');
const triggerDirty = ref(false);
const triggerSaving = ref(false);
interface OutputForm { mode: string; replyDelayMs: number; streamBufferMs: number; streamIntervalMs: number; streamMinDeltaChars: number }
const outputForm = ref<OutputForm>({ mode: 'stream', replyDelayMs: 2000, streamBufferMs: 2000, streamIntervalMs: 2000, streamMinDeltaChars: 24 });
const outputDirty = ref(false);
const outputSaving = ref(false);
const selectedChat = ref<Chat | null>(null);
const contextDetail = ref<Record<string, unknown> | null>(null);
const contextHead = ref<Record<string, unknown> | null>(null);
const traceDetail = ref<LogRow[]>([]);
const commits = ref<Array<Record<string, unknown>>>([]);
const contextMessages = ref<Array<Record<string, unknown>>>([]);
const inspectedSnapshot = ref<Record<string, unknown> | null>(null);
const expandedMessages = ref(new Set<string>());
const selectedPrompt = ref<Record<string, unknown> | null>(null);
const promptContent = ref('');
const promptRevisions = ref<Array<Record<string, unknown>>>([]);
const models = ref<Array<Record<string, unknown>>>([]);
const aliases = ref<Array<Record<string, unknown>>>([]);
const providerDialog = ref(false);
const providerForm = ref({ id: '', name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true });
const modelDialog = ref(false);
const modelForm = ref({ id: '', providerId: '', modelId: '', displayName: '', contextWindow: 128000, maxOutput: 8192, priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0, enabled: true, sort: 0 });
const aliasDialog = ref(false);
// 别名的用途只写在 docs/04 里，运维在这个页面上是看不到的——六个内建别名常驻表格并带用途说明。
const ALIAS_GUIDE: Array<{ alias: string; purpose: string; tier: string }> = [
  { alias: 'main', purpose: '主 Agent 的默认模型，日常对话都走它', tier: '中高档，对话质量优先' },
  { alias: 'high', purpose: '复杂推理、代码类子 agent', tier: '最强模型' },
  { alias: 'low', purpose: '摘要、记忆压缩，以及超过 agent.main.downgradeAfterStep 后的自动降档', tier: '最便宜可用' },
  { alias: 'vision', purpose: '含图片的轮次；当前模型不支持看图时自动切到这里', tier: '支持 vision' },
  { alias: 'title', purpose: '生成任务标题与会话摘要', tier: '最便宜' },
  { alias: 'embed', purpose: '（预留）向量检索，目前没有代码路径使用', tier: 'embedding 模型' },
];
const REASONING_OPTIONS = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SETTING_LABELS: Record<string, string> = { temperature: '温度', topP: 'topP', topK: 'topK', maxOutputTokens: '最大输出', reasoning: '推理档位', presencePenalty: '存在惩罚', frequencyPenalty: '重复惩罚', stopSequences: '停止序列', seed: 'seed' };
interface ChainSegment { id: string; label: string; state: 'ok' | 'disabled' | 'missing' }
interface ModelOption { id: string; label: string; enabled: boolean }
interface AliasRow { alias: string; purpose: string; tier: string; state: 'ok' | 'empty' | 'broken' | 'absent'; validName: boolean; description: string; chain: ChainSegment[]; settings: Record<string, unknown> }
const ALIAS_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ALIAS_STATE_TAG: Record<AliasRow['state'], { label: string; severity: TagSeverity; hint: string }> = {
  ok: { label: '', severity: 'secondary', hint: '' },
  absent: { label: '未配置', severity: 'secondary', hint: '还没建这个别名' },
  empty: { label: '链为空', severity: 'danger', hint: '别名存在但没有指向任何模型，等于没配' },
  broken: { label: '不可用', severity: 'danger', hint: '链里的模型都已删除或已停用' },
};
function providerLabel(id: string): string { return providers.value.find((entry) => entry.id === id)?.name ?? id; }
const modelOptions = computed<ModelOption[]>(() => models.value.map((model) => ({ id: String(model.id), label: `${providerLabel(String(model.provider_id))} / ${String(model.model_id)}`, enabled: Boolean(model.enabled) })));
const aliasRows = computed<AliasRow[]>(() => {
  const configured = new Map(aliases.value.map((entry) => [String(entry.alias), entry]));
  const names = [...ALIAS_GUIDE.map((entry) => entry.alias), ...[...configured.keys()].filter((name) => !ALIAS_GUIDE.some((entry) => entry.alias === name))];
  return names.map((name) => {
    const row = configured.get(name);
    const guide = ALIAS_GUIDE.find((entry) => entry.alias === name);
    const chain = (row ? JSON.parse(String(row.model_ids_json)) as string[] : []).map((id) => {
      const model = models.value.find((entry) => String(entry.id) === id);
      return { id, label: model ? `${providerLabel(String(model.provider_id))} / ${String(model.model_id)}` : id, state: !model ? 'missing' : model.enabled ? 'ok' : 'disabled' } as ChainSegment;
    });
    // 「有这一行」不等于「能用」：空链和整链失效在 registry 里同样是没有这个别名。
    const state = !row ? 'absent' : !chain.length ? 'empty' : chain.some((segment) => segment.state === 'ok') ? 'ok' : 'broken';
    return { alias: name, purpose: guide?.purpose ?? '自定义别名', tier: guide?.tier ?? '', state, validName: ALIAS_NAME_PATTERN.test(name), description: String(row?.description ?? ''),
      chain, settings: row?.settings_json ? JSON.parse(String(row.settings_json)) as Record<string, unknown> : {} };
  });
});
const modelMissingMain = computed(() => aliasRows.value.find((row) => row.alias === 'main')?.state !== 'ok');
function settingsSummary(settings: Record<string, unknown>): string {
  const entries = Object.entries(settings);
  return entries.length ? entries.map(([key, value]) => `${SETTING_LABELS[key] ?? key} ${Array.isArray(value) ? value.join(' / ') : String(value)}`).join(' · ') : 'provider 默认';
}
interface AliasSettingsForm { temperature: number | null; maxOutputTokens: number | null; reasoning: string | null; topP: number | null; topK: number | null; presencePenalty: number | null; frequencyPenalty: number | null; seed: number | null; stopSequences: string }
const emptySettings = (): AliasSettingsForm => ({ temperature: null, maxOutputTokens: null, reasoning: null, topP: null, topK: null, presencePenalty: null, frequencyPenalty: null, seed: null, stopSequences: '' });
const aliasForm = ref({ alias: 'main', custom: '', description: '', isNew: true, droppedModels: 0 });
const aliasChain = ref<ModelOption[]>([]);
const aliasSettings = ref(emptySettings());
const aliasName = computed(() => aliasForm.value.alias === '__custom__' ? aliasForm.value.custom.trim() : aliasForm.value.alias);
const aliasNameHint = computed(() => ALIAS_GUIDE.find((entry) => entry.alias === aliasName.value)?.purpose ?? '自定义别名只有被配置项（如 agent.agents.*.modelAlias）引用时才会被用到。');
const testingProvider = ref('');
const catalogDialog = ref(false);
const catalogProviderId = ref('');
const catalogLoading = ref(false);
const catalogModels = ref<CatalogModel[]>([]);
const catalogSelection = ref<CatalogModel[]>([]);
const catalogQuery = ref('');
const catalogError = ref('');
const catalogDefaults = ref({ contextWindow: 128000, maxOutput: 8192 });
const catalogStatus = ref<CatalogStatus | null>(null);
const catalogRefreshing = ref(false);
const enriching = ref(false);
// 价格出处必须写在行上：同一个模型在不同网关的价差可以到几倍，看不到出处就没法判断该不该信这个数字。
const MATCH_LABELS: Record<string, { label: string; severity: string; hint: string }> = {
  provider: { label: 'provider 自报价', severity: 'success', hint: '这个 provider 在 models.dev 里有条目，价格取自它自己公布的报价 —— 也就是你实际被扣的钱' },
  official: { label: '厂商官方价', severity: 'info', hint: '这个 provider 在 models.dev 里没有条目（自建中转），价格取自模型厂商自家的官方定价' },
  'third-party': { label: '无官方价', severity: 'warn', hint: '厂商侧查不到这个模型（已下架或开源权重模型），只有第三方托管报价 —— 价格不落库，需要手填' },
  none: { label: '目录里没有', severity: 'secondary', hint: 'models.dev 上没有这个模型，窗口与价格都要手填' },
};
const catalogAge = computed(() => {
  const status = catalogStatus.value;
  if (!status?.available || status.ageMs === null || status.ageMs === undefined) return '';
  const hours = status.ageMs / 3_600_000;
  return hours < 1 ? '刚刚更新' : hours < 48 ? `${Math.round(hours)} 小时前更新` : `${Math.round(hours / 24)} 天前更新`;
});
const capabilityTags = (meta: CatalogMeta | null): string[] => {
  if (!meta || meta.match === 'none') return [];
  const tags: string[] = [];
  if (meta.capabilities.vision) tags.push('看图');
  if (meta.modalities.input.includes('pdf')) tags.push('读 PDF');
  if (meta.modalities.input.includes('audio')) tags.push('听音频');
  if (meta.capabilities.tools) tags.push('工具');
  if (meta.capabilities.structuredOutput) tags.push('结构化输出');
  if (meta.reasoningControl === 'effort' && meta.reasoningEfforts.length) tags.push(`思考 ${meta.reasoningEfforts.join('/')}`);
  else if (meta.reasoningControl === 'toggle') tags.push('思考 开关');
  else if (meta.reasoningControl === 'budget_tokens') tags.push('思考 预算');
  else if (meta.capabilities.reasoning) tags.push('思考');
  return tags;
};
const priceText = (row: CatalogModel): string => (row.priceIn === null && row.priceOut === null ? '—' : `$${row.priceIn ?? '?'} / $${row.priceOut ?? '?'}`);
// 各家报价一致时给出区间只是噪音，但「几家一致」本身是有用的判断依据，要留着。
const rangeText = (range: { min: number; max: number; providers: number }): string => (range.min === range.max
  ? `第三方输入价 $${range.min}（${range.providers} 家一致）`
  : `第三方输入价 $${range.min}–$${range.max}（${range.providers} 家）`);
/** 已入库的模型行：能力块存在 capabilities_json 里，形状与拉取时那份一致。 */
const storedMeta = (model: Record<string, unknown>): CatalogMeta | null => {
  try {
    const parsed = JSON.parse(String(model.capabilities_json ?? '{}')) as Record<string, unknown>;
    const catalog = parsed.catalog as Record<string, unknown> | undefined;
    if (!catalog) return null;
    return { match: String(catalog.match ?? 'none') as CatalogMeta['match'], catalogProviderId: (catalog.providerId as string) ?? null, catalogProviderName: null,
      catalogModelId: (catalog.modelId as string) ?? null, normalized: catalog.normalized === true, priceRange: (catalog.priceRange as CatalogMeta['priceRange']) ?? null,
      capabilities: parsed as Record<string, boolean>, reasoningControl: (parsed.reasoningControl as string) ?? null, reasoningEfforts: (parsed.reasoningEfforts as string[]) ?? [],
      modalities: (parsed.modalities as CatalogMeta['modalities']) ?? { input: [], output: [] }, knowledge: (parsed.knowledge as string) ?? null, releaseDate: (parsed.releaseDate as string) ?? null };
  } catch { return null; }
};
const storedPriceSource = (model: Record<string, unknown>): string | null => {
  try { return ((JSON.parse(String(model.capabilities_json ?? '{}')) as { catalog?: { priceSource?: string } }).catalog?.priceSource) ?? null; } catch { return null; }
};
const importedModelKeys = computed(() => new Set(models.value.map((model) => `${String(model.provider_id)}::${String(model.model_id)}`)));
const catalogExists = (entry: CatalogModel): boolean => importedModelKeys.value.has(`${catalogProviderId.value}::${entry.modelId}`);
const catalogRows = computed(() => { const needle = catalogQuery.value.trim().toLowerCase(); return needle ? catalogModels.value.filter((entry) => entry.modelId.toLowerCase().includes(needle) || (entry.displayName ?? '').toLowerCase().includes(needle)) : catalogModels.value; });
const mobileMenu = ref(false);
const connected = ref(false);
const navigation = [
  ['dashboard', 'pi pi-chart-bar', '总览'], ['chats', 'pi pi-comments', '会话'], ['messages', 'pi pi-search', '消息'],
  ['prompts', 'pi pi-align-left', '提示词'], ['providers', 'pi pi-sparkles', '模型'], ['principals', 'pi pi-users', '主体'],
  ['tools', 'pi pi-wrench', '工具'], ['extensions', 'pi pi-box', '扩展'], ['agents', 'pi pi-sitemap', 'Agent'],
  ['logs', 'pi pi-list', '日志'], ['usage', 'pi pi-wallet', '用量'], ['quota', 'pi pi-gauge', '配额'],
  ['tasks', 'pi pi-check-square', '任务与审批'], ['settings', 'pi pi-cog', '设置'],
] as const;
const currentLabel = computed(() => navigation.find(([key]) => key === active.value)?.[2] ?? '总览');
/** 每一条 pending 都对应一个正卡在工具调用上的真实轮次，所以角标挂在导航上而不是只在任务页里。 */
const pendingApprovals = computed(() => approvals.value.filter((row) => row.state === 'pending').length);
const COLUMNS = {
  tools: [{ key: 'name', header: '工具' }, { key: 'source', header: '来源', width: '7rem' }, { key: 'minRole', header: '最低角色', width: '7rem' }, { key: 'approval', header: '审批', width: '7rem' }, { key: 'scope', header: '作用域', width: '8rem' }, { key: 'enabled', header: '状态', width: '6rem' }],
  agents: [{ key: 'name', header: '名称' }, { key: 'description', header: '职责' }, { key: 'minRole', header: '最低角色', width: '7rem' }, { key: 'modelAlias', header: '模型别名', width: '8rem' }, { key: 'tools', header: '可用工具' }, { key: 'maxSteps', header: '步数上限', width: '6rem' }, { key: 'actions', header: '', width: '6rem' }],
  hits: [{ key: 'tgDate', header: '时间', width: '12rem' }, { key: 'chatId', header: '会话', width: '9rem' }, { key: 'from', header: '发言人', width: '10rem' }, { key: 'text', header: '内容' }, { key: 'detail', header: '操作', width: '8rem' }],
  usage: [{ key: 'ts', header: '时间', width: '13rem' }, { key: 'model_alias', header: '别名' }, { key: 'input_tokens', header: '输入' }, { key: 'output_tokens', header: '输出' }, { key: 'cost_usd', header: '成本' }],
  principals: [{ key: 'kind', header: '类型' }, { key: 'displayName', header: '显示名' }, { key: 'tgId', header: 'Telegram ID' }, { key: 'role', header: '角色', width: '8rem' }, { key: 'username', header: '用户名' }],
  models: [{ key: 'model_id', header: '模型 ID' }, { key: 'provider_id', header: 'Provider' }, { key: 'context_window', header: '窗口' }, { key: 'capabilities', header: '能力' }, { key: 'price_in', header: '输入价格' }, { key: 'price_out', header: '输出价格' }, { key: 'enabled', header: '启用', width: '6rem' }],
  aliases: [{ key: 'alias', header: '别名', width: '12%' }, { key: 'purpose', header: '用途', width: '27%' }, { key: 'chain', header: 'Fallback 链', width: '31%' }, { key: 'settings', header: '采样参数', width: '20%' }, { key: 'actions', header: '', width: '10%' }],
  logs: [{ key: 'ts', header: '时间', width: '13rem' }, { key: 'level', header: '级别', width: '7rem' }, { key: 'kind', header: '事件' }, { key: 'summary', header: '摘要' }, { key: 'trace_id', header: 'Trace' }],
  tasks: [{ key: 'title', header: '标题' }, { key: 'state', header: '状态', width: '7rem' }, { key: 'updated_at', header: '更新时间', width: '13rem' }, { key: 'actions', header: '', width: '7rem' }],
  activeTurns: [{ key: 'who', header: '发起人' }, { key: 'chat', header: '会话' }, { key: 'progress', header: '当前动作' }, { key: 'stats', header: '步数 / 花费', width: '11rem' }, { key: 'elapsed', header: '已用时长', width: '8rem' }, { key: 'actions', header: '', width: '6rem' }],
  approvals: [{ key: 'tool_name', header: '工具' }, { key: 'risk', header: '风险', width: '7rem' }, { key: 'state', header: '状态', width: '7rem' }, { key: 'requested_at', header: '请求时间', width: '12rem' }, { key: 'actions', header: '', width: '12rem' }],
  catalog: [{ key: 'modelId', header: '模型 ID' }, { key: 'limits', header: '窗口 / 最大输出', width: '11rem' }, { key: 'price', header: '价格 / M token', width: '13rem' }, { key: 'capabilities', header: '能力' }, { key: 'status', header: '状态', width: '7rem' }],
  fallback: [{ key: 'kind', header: '关联事件' }, { key: 'summary', header: '最近状态' }, { key: 'level', header: '级别' }],
} satisfies Record<string, GridColumn[]>;

async function load(): Promise<void> {
  [dashboard.value, principals.value, providers.value, logs.value, chats.value, usage.value, skills.value, plugins.value, mcp.value, agents.value, tools.value, approvals.value, tasks.value, prompts.value, config.value, models.value, aliases.value, health.value] = await Promise.all([
    api<Dashboard>('/api/dashboard'), api<Principal[]>('/api/principals'), api<Provider[]>('/api/providers'), api<LogRow[]>('/api/logs'),
    api<Chat[]>('/api/chats'), api<Usage[]>('/api/usage'), api<Extension[]>('/api/skills'), api<Extension[]>('/api/plugins'), api<Extension[]>('/api/mcp'), api<AgentDefinition[]>('/api/agents'), api<Record<string, ToolPolicy>>('/api/tools'),
    api<Array<Record<string, unknown>>>('/api/approvals'), api<Array<Record<string, unknown>>>('/api/tasks'), api<Array<Record<string, unknown>>>('/api/prompts'), api<Record<string, unknown>>('/api/config'), api<Array<Record<string, unknown>>>('/api/models'), api<Array<Record<string, unknown>>>('/api/aliases'),
    api<HealthDetail>('/api/health/detail'),
  ]);
  // 总览页那张「最近错误」卡片走单独一次请求：日志页要的是全量流，卡片要的是 warn 以上的十条，
  // 在前端过滤会因为日志页只取了最近 200 条而漏掉更早的错误。
  recentErrors.value = await api<LogRow[]>('/api/logs?minLevel=warn&size=10');
  // 总览的额度环和配额页读的是同一个端点。失败不该把整个总览页带下去 —— 配额关掉时它本来就是空的。
  await Promise.all([loadQuota().catch(() => undefined), loadUsageReport()]);
  syncTrigger();
  syncOutput();
  syncBotName();
}
/** `general.name` 从这里生效：侧栏品牌名与浏览器标签都跟着改。运维给 bot 起了名字却在控制台
 *  上看到「LuoLiCore」，那这个键就还是没接线（docs/20 · W-CFG-02 点名的正是它）。 */
function syncBotName(): void {
  const name = ((config.value.general as { name?: string } | undefined)?.name ?? '').trim();
  botName.value = name || 'LuoLiCore';
  document.title = `${botName.value} 控制台`;
}
/** `config.changed` 会把配置重新拉回来（另一个标签页或 Telegram 侧改了配置就会发），
 *  正在编辑的触发表单不能被它冲掉。 */
function syncTrigger(): void {
  if (triggerDirty.value) return;
  const trigger = (config.value.trigger ?? {}) as Partial<TriggerForm>;
  triggerForm.value = { ...triggerForm.value, ...trigger, wakewords: [...(trigger.wakewords ?? [])] };
  void refreshWakewordStatus();
}
/** 「能不能生效」的判定只有服务端那一份（checkWakeword）；前端自己再实现一遍必然漂移。 */
async function refreshWakewordStatus(): Promise<void> {
  const wakewords = [...triggerForm.value.wakewords];
  try { wakewordStatus.value = await api<typeof wakewordStatus.value>('/api/config/wakewords/check', { method: 'POST', body: JSON.stringify({ wakewords, minLength: triggerForm.value.wakewordMinLength }) }); }
  catch { wakewordStatus.value = wakewords.map((pattern) => ({ pattern, kind: pattern.startsWith('^') ? 'regex' : 'contains', ok: true, reason: null })); }
}
function markTriggerDirty(): void { triggerDirty.value = true; }
function changeWakewordMinLength(value: number | null): void { triggerForm.value.wakewordMinLength = value ?? 1; markTriggerDirty(); void refreshWakewordStatus(); }
function addWakeword(): void {
  const value = newWakeword.value.trim();
  if (!value || triggerForm.value.wakewords.includes(value)) { newWakeword.value = ''; return; }
  triggerForm.value.wakewords = [...triggerForm.value.wakewords, value];
  newWakeword.value = '';
  markTriggerDirty();
  void refreshWakewordStatus();
}
function removeWakeword(pattern: string): void {
  triggerForm.value.wakewords = triggerForm.value.wakewords.filter((entry) => entry !== pattern);
  markTriggerDirty();
  void refreshWakewordStatus();
}
async function saveTrigger(): Promise<void> {
  const form = triggerForm.value;
  triggerSaving.value = true;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'trigger.private': form.private, 'trigger.mention': form.mention, 'trigger.reply': form.reply, 'trigger.command': form.command,
      'trigger.channels': form.channels, 'trigger.wakewords': form.wakewords, 'trigger.wakewordMinLength': form.wakewordMinLength,
      'trigger.requireTextAfterMention': form.requireTextAfterMention, 'trigger.ignoreEditedAsTrigger': form.ignoreEditedAsTrigger }) });
    triggerDirty.value = false;
    pushToast({ severity: 'success', summary: '触发设置已保存', detail: '热更新已生效，无需重启' });
    await load();
  } catch (error) { toastError('保存触发设置失败', error); }
  finally { triggerSaving.value = false; }
}
/** 同 syncTrigger：`config.changed` 会重新拉配置，正在编辑的节奏表单不能被冲掉。 */
function syncOutput(): void {
  if (outputDirty.value) return;
  const output = (config.value.output ?? {}) as Record<string, unknown>;
  const current = outputForm.value;
  // 逐项取而不是整体展开：output 下还有七个不归这张表管的键（parseMode、maxMessageChars…），
  // 展开进来只会在保存时被悄悄丢掉。
  outputForm.value = { mode: String(output.mode ?? current.mode), replyDelayMs: Number(output.replyDelayMs ?? current.replyDelayMs),
    streamBufferMs: Number(output.streamBufferMs ?? current.streamBufferMs), streamIntervalMs: Number(output.streamIntervalMs ?? current.streamIntervalMs),
    streamMinDeltaChars: Number(output.streamMinDeltaChars ?? current.streamMinDeltaChars) };
}
function markOutputDirty(): void { outputDirty.value = true; }
function changeOutputNumber(field: keyof Omit<OutputForm, 'mode'>, value: number | null): void { outputForm.value[field] = value ?? 0; markOutputDirty(); }
/** 模型元数据没有「留空 = 不设置」这一档（窗口、价格都是必填的 number）：清空按 0 收，让服务端那道
 *  zod 去判这值合不合法 —— 比把 null 塞进 JSON body 强，那边只会回一条对不上界面的路径报错。 */
type ModelNumber = 'contextWindow' | 'maxOutput' | 'sort' | 'priceIn' | 'priceOut' | 'priceCacheRead' | 'priceCacheWrite';
function changeModelNumber(field: ModelNumber, value: number | null): void { modelForm.value[field] = value ?? 0; }
function changeCatalogDefault(field: 'contextWindow' | 'maxOutput', value: number | null): void { catalogDefaults.value[field] = value ?? 0; }
async function saveOutput(): Promise<void> {
  const form = outputForm.value;
  outputSaving.value = true;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'output.mode': form.mode, 'output.replyDelayMs': form.replyDelayMs,
      'output.streamBufferMs': form.streamBufferMs, 'output.streamIntervalMs': form.streamIntervalMs, 'output.streamMinDeltaChars': form.streamMinDeltaChars }) });
    outputDirty.value = false;
    pushToast({ severity: 'success', summary: '输出节奏已保存', detail: '下一轮回复生效；在途那一轮沿用开轮时的值' });
    await load();
  } catch (error) { toastError('保存输出节奏失败', error); }
  finally { outputSaving.value = false; }
}
// ── 会话：contexts 表只有 chat_id，「这是哪个群 / 谁的私聊」在 principals 里 ──────────
const CHAT_TYPE_LABELS: Record<string, string> = { private: '私聊', group: '普通群', supergroup: '超级群', channel: '频道' };
interface ChatIdentity { name: string; handle: string; isPrivate: boolean; icon: string }
/** 群聊取 chat:<id> 那行的 title；私聊优先取 user:<id> 的全名 —— chat:<id> 对私聊只存了 first_name。 */
function chatIdentity(chat: Chat): ChatIdentity {
  const asChat = principals.value.find((entry) => entry.kind === 'chat' && entry.tgId === chat.chatId);
  const asUser = principals.value.find((entry) => entry.kind === 'user' && entry.tgId === chat.chatId);
  // 没登记过的会话（库里只有 contexts 行）也要能认：Telegram 的群/频道 id 一律是负数。
  const isPrivate = asChat?.chatType ? asChat.chatType === 'private' : !chat.chatId.startsWith('-');
  const source = (isPrivate ? asUser ?? asChat : asChat) ?? null;
  return { name: source?.displayName || (isPrivate ? `未登记用户 ${chat.chatId}` : `未登记群聊 ${chat.chatId}`),
    // 没有用户名的群不重复一遍下面那行 contextKey，改写 Telegram 那边的会话类型
    handle: source?.username ? `@${source.username}` : CHAT_TYPE_LABELS[String(asChat?.chatType)] ?? '未登记主体',
    isPrivate, icon: isPrivate ? 'pi pi-user' : 'pi pi-users' };
}
const chatCards = computed(() => chats.value.map((chat) => ({ chat, ...chatIdentity(chat) })));
interface PromptPreview {
  key: string;
  role: string;
  instructions: string;
  blocks: Array<{ name: string; tokens: number; content: string; truncated: boolean; cached: boolean }>;
  totalTokens: number;
  context: { messages: number; tokens: number };
}
const BLOCK_LABELS: Record<string, string> = { kernel: 'KERNEL', character: 'CHARACTER', assist: 'ASSIST', catalog: 'TOOL CATALOG', pubmemory: 'PUBMEMORY', primemory: 'PRIMEMORY', runtime: 'RUNTIME' };
const promptPreviewDialog = ref(false);
const promptPreviewLoading = ref(false);
const promptPreview = ref<PromptPreview | null>(null);
const promptPreviewForm = ref<{ key: string | null; role: string | null }>({ key: null, role: 'owner' });
const promptPreviewChats = computed(() => chatCards.value.map((entry) => ({ value: entry.chat.key, label: `${entry.name} · ${entry.chat.key}` })));
function openPromptPreview(): void {
  promptPreviewForm.value = { key: selectedChat.value?.key ?? chats.value[0]?.key ?? null, role: promptPreviewForm.value.role ?? 'owner' };
  promptPreview.value = null;
  promptPreviewDialog.value = true;
}
async function runPromptPreview(): Promise<void> {
  const { key, role } = promptPreviewForm.value;
  if (!key || !role) { pushToast({ severity: 'warn', summary: '请选择会话与角色' }); return; }
  promptPreviewLoading.value = true;
  try { promptPreview.value = await api<PromptPreview>('/api/prompts/preview', { method: 'POST', body: JSON.stringify({ key, role }) }); }
  catch (error) { toastError('组装提示词失败', error); }
  finally { promptPreviewLoading.value = false; }
}
const selectedChatIdentity = computed(() => selectedChat.value ? chatIdentity(selectedChat.value) : null);
const inWindowCount = computed(() => contextMessages.value.filter((entry) => entry.inWindow).length);
// 上下文窗口按时间倒序：最新的一条在最上面，跟消息页与 commit 时间线一致。ordinal 在提交时
// 单调分配，倒排 ordinal 就是倒排时间。
const orderedContextMessages = computed(() => [...contextMessages.value].reverse());
const canUndoContext = computed(() => Boolean(contextHead.value?.parentId));
const ROLE_LABELS: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' };
const ORIGIN_LABELS: Record<string, string> = { background: '背景发言', trigger: '触发消息', assistant: '模型回复', tool_call: '工具调用', tool_result: '工具结果', note: '系统注记' };
function messageTime(message: Record<string, unknown>): string {
  const ts = Number(message.sourceTs ?? message.createdAt ?? 0);
  return ts ? new Date(ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
/** Telegram `/model` 写进 app_kv 的会话别名：它压过下面覆盖面板里的 `agent.main.modelAlias`。 */
const chatModelAlias = ref<string | null>(null);
async function inspectChat(chat: Chat): Promise<void> {
  selectedChat.value = chat;
  // 覆盖面板要按 schema 生成控件，换会话时先把 schema 备好（只拉一次）。
  void loadConfigSchema();
  const detail = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chat.key)}`);
  contextDetail.value = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chat.key)}/context`);
  contextHead.value = (detail.commit as Record<string, unknown> | null) ?? null;
  commits.value = (detail.commits as Array<Record<string, unknown>> | undefined) ?? [];
  contextMessages.value = (detail.messages as Array<Record<string, unknown>> | undefined) ?? [];
  chatModelAlias.value = typeof detail.modelAlias === 'string' ? detail.modelAlias : null;
  inspectedSnapshot.value = null;
}
async function clearChatModelAlias(): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  try {
    await api(`/api/chats/${encodeURIComponent(chat.key)}/model-alias`, { method: 'DELETE' });
    chatModelAlias.value = null;
    pushToast({ severity: 'success', summary: '已清除会话模型别名', detail: '这个会话回到覆盖层 / 全局的 agent.main.modelAlias，下一轮生效' });
  } catch (error) { toastError('清除会话模型别名失败', error); }
}
async function inspectTrace(traceId: string | null): Promise<void> { if (!traceId) return; traceDetail.value = await api<LogRow[]>(`/api/logs/trace/${encodeURIComponent(traceId)}`); }
// 提示词文档以前是一张 id/scope/bytes/updated_at 的四列表格：光看 `character:global` 这种 id
// 认不出哪块是人格、哪块是助理守则，也看不出它进的是 prompt 的第几个 block。改成卡片，把用途写在脸上。
interface PromptMeta { label: string; icon: string; purpose: string; severity: TagSeverity }
const PROMPT_SCOPES: Record<string, PromptMeta> = {
  character: { label: '人格', icon: 'pi pi-user', purpose: 'block 1 · 人格设定，决定说话的样子；带会话后缀的是该会话专属覆盖', severity: 'info' },
  assist: { label: '助理守则', icon: 'pi pi-book', purpose: 'block 2 · 回答风格与业务约束，所有会话共用', severity: 'secondary' },
  pubmemory: { label: '公共记忆', icon: 'pi pi-globe', purpose: 'block 4 · 所有人可见的长期记忆，模型可用 memory_write 写', severity: 'success' },
  primemory: { label: '私有记忆', icon: 'pi pi-lock', purpose: 'block 5 · 某个用户私有；查看他人的这份会被记录', severity: 'warn' },
};
const promptMeta = (scope: unknown): PromptMeta => PROMPT_SCOPES[String(scope)] ?? { label: String(scope ?? '未知'), icon: 'pi pi-file', purpose: '未归类的文档', severity: 'secondary' };
const promptRank = (scope: unknown): number => { const index = Object.keys(PROMPT_SCOPES).indexOf(String(scope)); return index === -1 ? Object.keys(PROMPT_SCOPES).length : index; };
const promptCards = computed(() => [...prompts.value].sort((left, right) => promptRank(left.scope) - promptRank(right.scope) || String(left.id).localeCompare(String(right.id))));
async function inspectPrompt(row: Record<string, unknown>): Promise<void> { selectedPrompt.value = await api<Record<string, unknown>>(`/api/prompts/${encodeURIComponent(String(row.id))}`); promptContent.value = String(selectedPrompt.value.content ?? ''); promptRevisions.value = await api<Array<Record<string, unknown>>>(`/api/prompts/${encodeURIComponent(String(row.id))}/revisions`); }
// 下面这组上下文/提示词操作以前用顶栏静态横幅报成功、失败则什么都不显示；现在统一走同一个通知通道（AC-WEB-023）。
async function savePrompt(): Promise<void> {
  if (!selectedPrompt.value) return;
  const id = String(selectedPrompt.value.id);
  try { await api(`/api/prompts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: promptContent.value }) }); pushToast({ severity: 'success', summary: '提示词已保存', detail: `${id} 已生成新版本` }); await load(); await inspectPrompt(selectedPrompt.value); }
  catch (error) { toastError('保存提示词失败', error); }
}
async function rollbackPrompt(revisionId: unknown): Promise<void> {
  if (!selectedPrompt.value) return;
  try { await api(`/api/prompts/${encodeURIComponent(String(selectedPrompt.value.id))}/rollback`, { method: 'POST', body: JSON.stringify({ revisionId }) }); pushToast({ severity: 'success', summary: '提示词已回滚', detail: `回到 ${String(revisionId).slice(0, 12)}` }); await inspectPrompt(selectedPrompt.value); }
  catch (error) { toastError('回滚提示词失败', error); }
}
async function checkoutCommit(id: unknown): Promise<void> {
  if (!selectedChat.value) return;
  try { await api(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/commits/${encodeURIComponent(String(id))}/checkout`, { method: 'POST' }); pushToast({ severity: 'success', summary: '上下文已切换', detail: `commit ${String(id).slice(0, 12)}` }); await inspectChat(selectedChat.value); }
  catch (error) { toastError('切换 commit 失败', error); }
}
async function inspectCommit(id: unknown): Promise<void> { if (!selectedChat.value) return; inspectedSnapshot.value = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/context?commit=${encodeURIComponent(String(id))}`); }
/** 等同 Telegram 的 /new：插一条 reset commit 把窗口起点推到最新 ordinal 之后，消息一条不删。 */
async function resetContext(): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  if (!confirm(`清空「${chatIdentity(chat).name}」的上下文窗口？下一轮起模型看不到之前的对话；消息与提交历史都还在，可以用「回滚到此」走回来。`)) return;
  try { await api(`/api/chats/${encodeURIComponent(chat.key)}/reset`, { method: 'POST' }); pushToast({ severity: 'success', summary: '上下文窗口已清空', detail: `${chatIdentity(chat).name} · 下一轮从零开始` }); await inspectChat(chat); await load(); }
  catch (error) { toastError('清空上下文窗口失败', error); }
}
/** 等同 /undo：done 指针退回父 commit。被跳过的 commit 仍留在时间线上，可以再「回滚到此」走回去。 */
async function undoContext(): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  try {
    const moved = await api<Record<string, unknown> | null>(`/api/chats/${encodeURIComponent(chat.key)}/undo`, { method: 'POST' });
    if (!moved) { pushToast({ severity: 'warn', summary: '没有可撤回的提交', detail: '当前 HEAD 已经是这个会话的第一个 commit' }); return; }
    pushToast({ severity: 'success', summary: '已撤回上一次提交', detail: `HEAD → ${String(moved.id).slice(0, 12)}` });
    await inspectChat(chat);
    await load();
  } catch (error) { toastError('撤回提交失败', error); }
}
function toggleMessage(id: unknown): void { const next = new Set(expandedMessages.value); const key = String(id); if (next.has(key)) next.delete(key); else next.add(key); expandedMessages.value = next; }
function editProvider(provider?: Provider): void { providerForm.value = provider ? { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: String((provider as Provider & { baseUrl?: string }).baseUrl ?? ''), apiKey: '', enabled: Boolean(provider.enabled) } : { id: '', name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true }; providerDialog.value = true; }
async function saveProvider(): Promise<void> {
  const form = providerForm.value;
  const body = { name: form.name, kind: form.kind, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey || undefined, enabled: form.enabled };
  try { await api(form.id ? `/api/providers/${encodeURIComponent(form.id)}` : '/api/providers', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); providerDialog.value = false; pushToast({ severity: 'success', summary: 'Provider 已保存', detail: form.name }); await load(); }
  catch (error) { toastError('保存 Provider 失败', error); }
}
function toastProbe(name: string, result: ProviderTest): void {
  if (result.reachable) pushToast({ severity: 'success', summary: `${name} 连接正常`, detail: `${result.latencyMs} ms · 上游返回 ${result.models} 个模型` });
  else pushToast({ severity: 'error', summary: `${name} 连接失败（${result.code}）`, detail: result.message, life: 9000 });
}
/** 卡片上的测试打的是库里那份配置，因此会写回 health_state；对话框里的测试带覆盖参数，不写。 */
async function testProvider(provider: Provider): Promise<void> {
  testingProvider.value = provider.id;
  try { toastProbe(provider.name, await api<ProviderTest>(`/api/providers/${encodeURIComponent(provider.id)}/test`, { method: 'POST', body: '{}' })); }
  catch (error) { toastError('测试请求失败', error); }
  finally { testingProvider.value = ''; providers.value = await api<Provider[]>('/api/providers'); }
}
async function testProviderDraft(): Promise<void> {
  const form = providerForm.value;
  if (!form.id) { pushToast({ severity: 'warn', summary: '请先保存 Provider', detail: '新建的 Provider 还没有 id，保存后即可用当前 key 测试', life: 6000 }); return; }
  testingProvider.value = form.id;
  try { toastProbe(form.name, await api<ProviderTest>(`/api/providers/${encodeURIComponent(form.id)}/test`, { method: 'POST', body: JSON.stringify({ kind: form.kind, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined }) })); }
  catch (error) { toastError('测试请求失败', error); }
  finally { testingProvider.value = ''; }
}
async function openCatalog(providerId?: string): Promise<void> {
  catalogProviderId.value = providerId || catalogProviderId.value || providers.value[0]?.id || '';
  catalogSelection.value = []; catalogQuery.value = ''; catalogDialog.value = true;
  await loadCatalog();
}
async function loadCatalog(): Promise<void> {
  catalogSelection.value = []; catalogError.value = '';
  if (!catalogProviderId.value) { catalogModels.value = []; catalogError.value = '还没有配置任何 Provider'; return; }
  catalogLoading.value = true;
  try {
    const result = await api<{ models: CatalogModel[]; catalog: CatalogStatus }>(`/api/providers/${encodeURIComponent(catalogProviderId.value)}/models`);
    catalogModels.value = result.models; catalogStatus.value = result.catalog;
    if (!catalogModels.value.length) catalogError.value = '上游返回了空的模型列表';
  } catch (error) { catalogModels.value = []; catalogError.value = error instanceof Error ? error.message : '拉取失败'; toastError('拉取模型列表失败', error); }
  finally { catalogLoading.value = false; }
}
/** 元数据目录本身的刷新：平时按 TTL 走条件请求，这个按钮是「我知道上游刚上新模型」时的手动通道。 */
async function refreshCatalog(): Promise<void> {
  catalogRefreshing.value = true;
  try {
    const status = await api<CatalogStatus>('/api/models/catalog/refresh', { method: 'POST', body: '{}' });
    catalogStatus.value = status;
    if (status.outcome === 'stale') pushToast({ severity: 'warn', summary: '刷新失败，继续用本地缓存', detail: status.error ?? '', life: 7000 });
    else pushToast({ severity: 'success', summary: status.outcome === 'not-modified' ? 'models.dev 上没有更新' : `目录已更新：${status.models ?? 0} 个模型`, detail: `${status.providers ?? 0} 家 provider` });
    if (catalogDialog.value) await loadCatalog();
  } catch (error) { toastError('刷新模型目录失败', error); }
  finally { catalogRefreshing.value = false; }
}
/** 已经在库里的模型行补元数据：能力照写，价格只填空着的，窗口不动（可能被按预算调小过）。 */
async function enrichModels(): Promise<void> {
  enriching.value = true;
  try {
    const result = await api<{ scanned: number; updated: number; priced: number; unmatched: number }>('/api/models/enrich', { method: 'POST', body: '{}' });
    pushToast({ severity: result.updated ? 'success' : 'warn', summary: `补齐了 ${result.updated} / ${result.scanned} 个模型`,
      detail: `新填价格 ${result.priced} 个${result.unmatched ? `，${result.unmatched} 个在 models.dev 上查不到，需要手填` : ''}。已有价格不会被覆盖。`, life: 8000 });
    await load();
  } catch (error) { toastError('补齐模型元数据失败', error); }
  finally { enriching.value = false; }
}
async function importCatalog(): Promise<void> {
  const chosen = catalogSelection.value.filter((entry) => !catalogExists(entry));
  if (!chosen.length) return;
  try {
    const result = await api<{ inserted: number; skipped: number; priced: number }>('/api/models/import', { method: 'POST', body: JSON.stringify({ providerId: catalogProviderId.value, models: chosen, contextWindow: catalogDefaults.value.contextWindow, maxOutput: catalogDefaults.value.maxOutput }) });
    const blank = result.inserted - result.priced;
    pushToast({ severity: result.inserted ? 'success' : 'warn', summary: `已导入 ${result.inserted} 个模型`,
      detail: `${result.skipped ? `${result.skipped} 个已存在，已跳过。` : ''}${result.priced} 个带上了价格${blank ? `，${blank} 个没有可信的官方价、价格留空 —— 不补齐的话这些模型的花费按 0 记账` : ''}。`, life: 8000 });
    catalogSelection.value = [];
    await load();
  } catch (error) { toastError('导入模型失败', error); }
}
async function removeProvider(id: string): Promise<void> { try { await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: 'Provider 已删除' }); } catch (error) { toastError('删除失败', error); } await load(); }
function editModel(model?: Record<string, unknown>): void { modelForm.value = model ? { id: String(model.id), providerId: String(model.provider_id), modelId: String(model.model_id), displayName: String(model.display_name ?? ''), contextWindow: Number(model.context_window), maxOutput: Number(model.max_output), priceIn: Number(model.price_in ?? 0), priceOut: Number(model.price_out ?? 0), priceCacheRead: Number(model.price_cache_read ?? 0), priceCacheWrite: Number(model.price_cache_write ?? 0), enabled: Boolean(model.enabled), sort: Number(model.sort ?? 0) } : { id: '', providerId: providers.value[0]?.id ?? '', modelId: '', displayName: '', contextWindow: 128000, maxOutput: 8192, priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0, enabled: true, sort: 0 }; modelDialog.value = true; }
async function saveModel(): Promise<void> { const form = modelForm.value; try { await api(form.id ? `/api/models/${encodeURIComponent(form.id)}` : '/api/models', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }); modelDialog.value = false; pushToast({ severity: 'success', summary: '模型配置已保存', detail: form.modelId }); await load(); } catch (error) { toastError('保存模型失败', error); } }
function editAlias(row?: AliasRow): void {
  const known = ALIAS_GUIDE.some((entry) => entry.alias === row?.alias);
  const chosen = (row?.chain ?? []).flatMap((segment) => modelOptions.value.filter((option) => option.id === segment.id));
  aliasForm.value = { alias: row ? (known ? row.alias : '__custom__') : '__custom__', custom: row && !known ? row.alias : '', description: row?.description ?? '',
    isNew: !row || row.state === 'absent', droppedModels: (row?.chain.length ?? 0) - chosen.length };
  aliasChain.value = chosen;
  const stored = row?.settings ?? {};
  const asNumber = (key: string): number | null => typeof stored[key] === 'number' ? stored[key] : null;
  aliasSettings.value = { temperature: asNumber('temperature'), maxOutputTokens: asNumber('maxOutputTokens'), topP: asNumber('topP'), topK: asNumber('topK'),
    presencePenalty: asNumber('presencePenalty'), frequencyPenalty: asNumber('frequencyPenalty'), seed: asNumber('seed'),
    reasoning: typeof stored.reasoning === 'string' ? stored.reasoning : null,
    stopSequences: Array.isArray(stored.stopSequences) ? (stored.stopSequences as string[]).join('\n') : '' };
  aliasDialog.value = true;
}
async function saveAlias(): Promise<void> {
  const name = aliasName.value;
  if (!name) { pushToast({ severity: 'warn', summary: '请填别名' }); return; }
  const form = aliasSettings.value;
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form) as Array<[string, number | string | null]>) if (typeof value === 'number' || (typeof value === 'string' && value !== '' && key !== 'stopSequences')) settings[key] = value;
  const stops = form.stopSequences.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stops.length) settings.stopSequences = stops;
  try {
    await api(`/api/aliases/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ modelIds: aliasChain.value.map((option) => option.id), settings, description: aliasForm.value.description }) });
    aliasDialog.value = false;
    pushToast({ severity: 'success', summary: '模型别名已保存', detail: name });
    await load();
  } catch (error) { toastError('保存别名失败', error); }
}
async function removeAlias(alias: string): Promise<void> {
  if (!confirm(`删除别名 ${alias}？引用它的地方会退回 main。`)) return;
  try { await api(`/api/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `别名 ${alias} 已删除` }); await load(); }
  catch (error) { toastError('删除别名失败', error); }
}
function messageMeta(message: Record<string, unknown>): Record<string, unknown> { return message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : {}; }

// ── 消息：最近的模型对话按 turn 分页，搜索归档另走 FTS ─────────────────────────────
const CONVERSATION_PAGE_SIZE = 20;
const conversations = ref<Conversation[]>([]);
const conversationPage = ref(1);
const conversationTotal = ref(0);
const conversationLoading = ref(false);
const expandedTurns = ref(new Set<string>());
const searchHits = ref<MessageHit[] | null>(null);
const searchTerm = ref('');
const searching = ref(false);
const conversationPages = computed(() => Math.max(1, Math.ceil(conversationTotal.value / CONVERSATION_PAGE_SIZE)));
// 这份数据不进 load()，也不挂在任何 SSE 事件上：跟着刷新会把运维翻到的页码打回第一页。
async function loadConversations(target = conversationPage.value): Promise<void> {
  conversationLoading.value = true;
  try {
    const result = await api<Paged<Conversation>>(`/api/turns?page=${target}&size=${CONVERSATION_PAGE_SIZE}`);
    conversations.value = result.items; conversationTotal.value = result.total; conversationPage.value = result.page;
  } catch (error) { toastError('加载对话失败', error); }
  finally { conversationLoading.value = false; }
}
function turnState(state: string): { label: string; severity: TagSeverity } {
  return ({ committed: { label: '已完成', severity: 'success' }, running: { label: '进行中', severity: 'info' }, queued: { label: '排队中', severity: 'secondary' },
    failed: { label: '失败', severity: 'danger' }, cancelled: { label: '已取消', severity: 'warn' } } as Record<string, { label: string; severity: TagSeverity }>)[state] ?? { label: state, severity: 'secondary' };
}
function toggleTurn(id: string): void { const next = new Set(expandedTurns.value); if (next.has(id)) next.delete(id); else next.add(id); expandedTurns.value = next; }
async function searchArchive(): Promise<void> {
  const needle = query.value.trim();
  if (!needle) { clearSearch(); return; }
  searching.value = true;
  try { searchHits.value = (await api<Paged<MessageHit>>(`/api/messages?q=${encodeURIComponent(needle)}&size=50`)).items; searchTerm.value = needle; }
  catch (error) { toastError('检索归档失败', error); }
  finally { searching.value = false; }
}
function clearSearch(): void { searchHits.value = null; searchTerm.value = ''; }
async function softDeleteMessage(id: number, label: string): Promise<void> {
  if (!confirm(`软删除${label}？归档正文会从检索与对话列表隐藏；上下文提交、turn 与附件不会被删除。`)) return;
  try {
    const result = await api<{ changes: number }>(`/api/messages/${id}`, { method: 'DELETE' });
    if (searchHits.value) searchHits.value = searchHits.value.filter((entry) => entry.id !== id);
    await loadConversations();
    pushToast(result.changes
      ? { severity: 'success', summary: '归档消息已软删除', detail: `message #${id}` }
      : { severity: 'warn', summary: '消息已经被删除', detail: `message #${id}` });
  } catch (error) { toastError('软删除失败', error); }
}

// ── 对话详情：这一轮实际发给上游的 JSON ──────────────────────────────────────
// 只有日志里那一份是真的：turns 表存统计、messages 表存最终文本，两者都看不出请求体长什么样。
interface DetailEvent { id: number; ts: number; level: string; kind: string; summary: string; spanId: string | null; parentSpanId: string | null; durationMs: number | null;
  text: string | null; bytes: number; truncated: boolean; fileRef: string | null }
interface TurnDetail { turn: Record<string, unknown>; captureBodies: boolean; events: DetailEvent[] }
const DETAIL_GROUPS = [['model', '模型调用'], ['tool', '工具与沙箱'], ['other', '轮次与上下文'], ['all', '全部']] as const;
type DetailGroup = typeof DETAIL_GROUPS[number][0];
const detailDialog = ref(false);
const detailLoading = ref(false);
const detailTurnId = ref('');
const detail = ref<TurnDetail | null>(null);
const detailGroup = ref<DetailGroup>('model');
const expandedEvents = ref(new Set<number>());
function eventGroup(kind: string): Exclude<DetailGroup, 'all'> {
  if (kind.startsWith('model.') || kind.startsWith('provider.')) return 'model';
  if (kind.startsWith('tool.') || kind.startsWith('sandbox.') || kind.startsWith('approval.') || kind.startsWith('agent.')) return 'tool';
  return 'other';
}
const detailEvents = computed(() => (detail.value?.events ?? []).filter((entry) => detailGroup.value === 'all' || eventGroup(entry.kind) === detailGroup.value));
const detailCount = (group: DetailGroup): number => (detail.value?.events ?? []).filter((entry) => group === 'all' || eventGroup(entry.kind) === group).length;
/** 1024 进制。原来只到 MB，而系统信息里的 DB 与 workspace 占用都能到 GB —— 停在 MB 会出现
 *  「12800.0 MB」这种读不出量级的数字。undefined 显示成 —（端点没给，不是 0 字节）。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
async function openDetail(turnId: string): Promise<void> {
  detailTurnId.value = turnId; detailDialog.value = true; detailLoading.value = true; detail.value = null; expandedEvents.value = new Set(); detailGroup.value = 'model';
  try {
    const result = await api<TurnDetail>(`/api/turns/${encodeURIComponent(turnId)}/detail`);
    detail.value = result;
    // 点开就想看「这一轮实际发了什么」：默认落在模型调用上并展开第一条，工具与系统事件按需点开。
    if (!result.events.some((entry) => eventGroup(entry.kind) === 'model')) detailGroup.value = 'all';
    const first = result.events.find((entry) => eventGroup(entry.kind) === 'model') ?? result.events[0];
    if (first) expandedEvents.value = new Set([first.id]);
  } catch (error) { toastError('加载对话详情失败', error); detailDialog.value = false; }
  finally { detailLoading.value = false; }
}
function toggleEvent(id: number): void { const next = new Set(expandedEvents.value); if (next.has(id)) next.delete(id); else next.add(id); expandedEvents.value = next; }
/** 复制的必须是完整那份：界面上显示的可能被 DETAIL_MAX_CHARS 截过，粘出去就不是合法 JSON 了。 */
async function copyEvent(event: DetailEvent): Promise<void> {
  try {
    let text = event.text ?? '';
    if (event.truncated) { const response = await fetch(`/api/logs/${event.id}/data`); if (!response.ok) throw new Error(`取完整载荷失败：HTTP ${response.status}`); text = await response.text(); }
    await navigator.clipboard.writeText(text);
    pushToast({ severity: 'success', summary: '已复制完整 JSON', detail: `${event.kind} · ${formatBytes(event.bytes)}` });
  } catch (error) { toastError('复制失败', error); }
}

// ── 主体：群聊与用户分开看，角色改动走二级菜单 ────────────────────────────────
const PRINCIPAL_KINDS = [['all', '全部'], ['user', '用户'], ['chat', '群聊']] as const;
const ROLES = ['owner', 'trusted', 'limited', 'blocked'];
const ROLE_HINTS: Record<string, string> = { owner: '不受审批与沙箱限制，可读写所有配置', trusted: '可用写文件、执行代码等高风险工具（按审批策略）', limited: '只读类工具，日常对话', blocked: '消息不触发轮次；archiveBlocked 关闭时连归档都不做' };
const principalKind = ref<'all' | 'user' | 'chat'>('all');
const visiblePrincipals = computed(() => principalKind.value === 'all' ? principals.value : principals.value.filter((entry) => entry.kind === principalKind.value));
// 引导 owner（access.bootstrapOwnerId）是 bot 的实际主人：这一行改成 blocked 就没人能在 Telegram 里管它了。
const ownerPrincipalId = computed(() => { const tgId = String((config.value.access as Record<string, unknown> | undefined)?.bootstrapOwnerId ?? ''); return tgId ? `user:${tgId}` : ''; });
const ownerPrincipal = computed(() => principals.value.find((entry) => entry.id === ownerPrincipalId.value) ?? null);
const ownerLabel = computed(() => ownerPrincipal.value?.displayName || (ownerPrincipal.value ? `#${ownerPrincipal.value.tgId}` : 'Owner'));
const ownerHandle = computed(() => ownerPrincipal.value?.username ? `@${ownerPrincipal.value.username}` : ownerPrincipal.value ? `ID ${ownerPrincipal.value.tgId}` : '未登记');
const ownerInitials = computed(() => [...ownerLabel.value.replace(/\s+/gu, '')].slice(0, 2).join('').toUpperCase() || 'OW');
const principalCount = (kind: string): number => kind === 'all' ? principals.value.length : principals.value.filter((entry) => entry.kind === kind).length;
const principalDialog = ref(false);
const principalSaving = ref(false);
const principalForm = ref<Principal & { originalRole: string }>({ id: '', kind: 'user', tgId: '', role: 'limited', displayName: null, username: null, originalRole: 'limited' });
function editPrincipal(row: Principal): void { principalForm.value = { ...row, originalRole: row.role }; principalDialog.value = true; }
async function savePrincipal(): Promise<void> {
  const form = principalForm.value;
  if (form.role === form.originalRole) { principalDialog.value = false; return; }
  principalSaving.value = true;
  try {
    await api(`/api/principals/${encodeURIComponent(form.id)}`, { method: 'PATCH', body: JSON.stringify({ role: form.role }) });
    principalDialog.value = false;
    pushToast({ severity: 'success', summary: '角色已更新', detail: `${form.displayName ?? form.id} → ${form.role}` });
    await load();
  } catch (error) { toastError('更新角色失败', error); }
  finally { principalSaving.value = false; }
}
// 勾选批量改角色：一次点开一个对话框改一个人，处理一批新进群的人要点几十次。
const principalSelection = ref<Principal[]>([]);
const roleDialog = ref(false);
const roleSaving = ref(false);
const roleBulkForm = ref({ role: 'limited' });
const selectionHitsOwnerSeat = computed(() => principalSelection.value.some((entry) => entry.id === ownerPrincipalId.value));
watch(principalKind, () => { principalSelection.value = []; });
function openRoleBulk(): void { roleBulkForm.value = { role: 'limited' }; roleDialog.value = true; }
async function saveRoleBulk(): Promise<void> {
  const ids = principalSelection.value.map((entry) => entry.id);
  roleSaving.value = true;
  try {
    const result = await api<{ count: number; changed: number; missing: string[] }>('/api/principals/roles', { method: 'POST', body: JSON.stringify({ ids, role: roleBulkForm.value.role }) });
    roleDialog.value = false;
    principalSelection.value = [];
    pushToast({ severity: result.missing.length ? 'warn' : 'success', summary: `${result.changed} 个主体已改为 ${roleBulkForm.value.role}`,
      detail: result.missing.length ? `${result.missing.length} 个 id 在库里找不到，已跳过` : '下一轮生效，已写审计日志', life: 7000 });
    await load();
  } catch (error) { toastError('批量改角色失败', error); }
  finally { roleSaving.value = false; }
}
const bulkDialog = ref(false);
const bulkSaving = ref(false);
const bulkForm = ref({ ids: '', kind: 'user', role: 'limited' });
const bulkIds = computed(() => [...new Set(bulkForm.value.ids.split(/[\s,;，、]+/).map((entry) => entry.trim()).filter(Boolean))]);
const bulkBadIds = computed(() => bulkIds.value.filter((id) => !/^-?\d{1,20}$/.test(id)));
function openBulk(): void { bulkForm.value = { ids: '', kind: 'user', role: 'limited' }; bulkDialog.value = true; }
async function saveBulk(): Promise<void> {
  bulkSaving.value = true;
  try {
    const result = await api<{ count: number; created: number; updated: number }>('/api/principals/bulk', { method: 'POST', body: JSON.stringify({ ids: bulkIds.value, kind: bulkForm.value.kind, role: bulkForm.value.role }) });
    bulkDialog.value = false;
    pushToast({ severity: 'success', summary: `已导入 ${result.count} 个主体`, detail: `新建 ${result.created} 个，改角色 ${result.updated} 个 → ${bulkForm.value.role}`, life: 7000 });
    await load();
  } catch (error) { toastError('批量导入失败', error); }
  finally { bulkSaving.value = false; }
}

// ── 工具：策略是代码里的常量，这里能改的只有启停 ──────────────────────────────
const TOOL_SOURCE_LABEL: Record<string, string> = { builtin: '内建', agent: '子 Agent', plugin: 'Plugin', mcp: 'MCP' };
const APPROVAL_LABEL: Record<string, string> = { never: '不需要', always: '每次都要', conditional: '按规则判定' };
const SCOPE_LABEL: Record<string, string> = { workspace: '工作区文件', chat: '当前会话', private: '用户私有', global: '全局', sandbox: '沙箱执行', telegram: 'Telegram' };
const toolRows = computed(() => Object.entries(tools.value).map(([name, policy]) => ({ name, ...policy })));
const toolDialog = ref(false);
const toolSaving = ref(false);
const toolForm = ref<{ name: string; minRole: string; approval: string; scope: string; source: string; enabled: boolean; original: boolean }>({ name: '', minRole: '', approval: '', scope: '', source: '', enabled: true, original: true });
function editTool(row: { name: string } & ToolPolicy): void { toolForm.value = { ...row, original: row.enabled }; toolDialog.value = true; }
async function saveTool(): Promise<void> {
  const form = toolForm.value;
  if (form.enabled === form.original) { toolDialog.value = false; return; }
  toolSaving.value = true;
  try {
    await api(`/api/tools/${encodeURIComponent(form.name)}`, { method: 'PATCH', body: JSON.stringify({ enabled: form.enabled }) });
    toolDialog.value = false;
    pushToast({ severity: 'success', summary: `${form.name} 已${form.enabled ? '启用' : '停用'}`, detail: form.enabled ? '下一轮起重新进入模型的工具目录' : '既从工具目录移除，execute() 也会二次拦截' });
    await load();
  } catch (error) { toastError('保存工具开关失败', error); }
  finally { toolSaving.value = false; }
}

// ── 子 Agent：整张 agent.agents 数组作为一条配置覆盖写回 ───────────────────────
const emptyAgent = (): AgentDefinition => ({ name: '', description: '', modelAlias: 'high', maxSteps: 8, minRole: 'limited', tools: [], resultMaxChars: 4000, instructions: '', injectMemory: false });
const agentDialog = ref(false);
const agentSaving = ref(false);
const agentForm = ref<AgentDefinition & { originalName: string; isNew: boolean }>({ ...emptyAgent(), originalName: '', isNew: true });
const agentNameTaken = computed(() => agentForm.value.isNew && agents.value.some((entry) => entry.name === agentForm.value.name.trim()));
function editAgent(row?: AgentDefinition): void {
  agentForm.value = { ...emptyAgent(), ...row, tools: [...row?.tools ?? []], originalName: row?.name ?? '', isNew: !row };
  agentDialog.value = true;
}
function toggleAgentTool(name: string): void {
  const current = agentForm.value.tools;
  agentForm.value.tools = current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name];
}
/** 写的是整张数组：单条 PATCH 端点不存在，而 agent.agents 本身就是一个 schema 叶子。 */
async function writeAgents(next: AgentDefinition[], summary: string, detail: string): Promise<void> {
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'agent.agents': next }) });
  pushToast({ severity: 'success', summary, detail });
  await load();
}
async function saveAgent(): Promise<void> {
  const form = agentForm.value;
  const name = form.name.trim();
  if (!name) { pushToast({ severity: 'warn', summary: '请填 Agent 名称' }); return; }
  if (agentNameTaken.value) { pushToast({ severity: 'warn', summary: `已存在名为 ${name} 的 Agent` }); return; }
  if (!form.instructions.trim()) { pushToast({ severity: 'warn', summary: '请填 instructions', detail: '子 agent 的系统提示词为空时模型没有任何职责说明' }); return; }
  const entry: AgentDefinition = { name, description: form.description, modelAlias: form.modelAlias, maxSteps: form.maxSteps, minRole: form.minRole,
    tools: form.tools, resultMaxChars: form.resultMaxChars, instructions: form.instructions, injectMemory: form.injectMemory };
  const next = agents.value.map((existing) => existing.name === form.originalName ? entry : existing);
  if (form.isNew) next.push(entry);
  agentSaving.value = true;
  try { await writeAgents(next, form.isNew ? 'Agent 已创建' : 'Agent 已保存', `${name} · 热更新已生效`); agentDialog.value = false; }
  catch (error) { toastError('保存 Agent 失败', error); }
  finally { agentSaving.value = false; }
}
async function removeAgent(name: string): Promise<void> {
  if (!confirm(`删除子 Agent ${name}？正在引用它的 spawn_agent 调用会直接报「未知子 agent」。`)) return;
  try { await writeAgents(agents.value.filter((entry) => entry.name !== name), `Agent ${name} 已删除`, '写入 agent.agents 覆盖层'); agentDialog.value = false; }
  catch (error) { toastError('删除 Agent 失败', error); }
}
type AgentDryRunEvent =
  | { type: 'step'; step: number; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }
  | { type: 'usage'; step: number; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'final'; summary: string; fullRef: string; truncated: boolean }
  | { type: 'error'; message: string };
const agentDryRunDialog = ref(false);
const agentDryRunName = ref('');
const agentDryRunTask = ref('');
const agentDryRunEvents = ref<AgentDryRunEvent[]>([]);
const agentDryRunRunning = ref(false);
const agentDryRunAbort = ref<AbortController | null>(null);
const agentDryRunCost = computed(() => agentDryRunEvents.value.reduce((sum, event) => sum + (event.type === 'usage' ? event.costUsd : 0), 0));
function openAgentDryRun(agent: AgentDefinition): void {
  agentDryRunName.value = agent.name;
  agentDryRunTask.value = '';
  agentDryRunEvents.value = [];
  agentDryRunDialog.value = true;
}
async function runAgentDryRun(): Promise<void> {
  const task = agentDryRunTask.value.trim();
  if (!task) { pushToast({ severity: 'warn', summary: '请填写试跑任务' }); return; }
  agentDryRunAbort.value?.abort();
  const controller = new AbortController();
  agentDryRunAbort.value = controller;
  agentDryRunEvents.value = [];
  agentDryRunRunning.value = true;
  try {
    await apiStream<AgentDryRunEvent>(`/api/agents/${encodeURIComponent(agentDryRunName.value)}/dryrun`,
      { method: 'POST', body: JSON.stringify({ task }), signal: controller.signal },
      (event) => { agentDryRunEvents.value = [...agentDryRunEvents.value, event]; });
    const error = agentDryRunEvents.value.find((event) => event.type === 'error');
    if (error?.type === 'error') pushToast({ severity: 'error', summary: 'Agent 试跑失败', detail: error.message, life: 9000 });
  } catch (error) {
    if (!controller.signal.aborted) toastError('Agent 试跑失败', error);
  } finally {
    if (agentDryRunAbort.value === controller) agentDryRunAbort.value = null;
    agentDryRunRunning.value = false;
  }
}
function cancelAgentDryRun(): void { agentDryRunAbort.value?.abort(); }

// ── 配额：限额在配置里、计数器在 quota_counters 里，GET /api/quota 已经把两边对齐好 ────────
interface QuotaPair { daily: number | null; monthly: number | null }
interface QuotaCounter { scope: 'global' | 'chat' | 'user'; subject: string; window: 'day' | 'month'; bucket: string; costUsd: number; reservedUsd: number;
  turns: number; updatedAt: number; current: boolean; limit: number | null; limitApprox: boolean; role: string | null; label: string | null; username: string | null }
interface QuotaPayload {
  quota: { enabled: boolean; requirePricing: boolean; minReserveUsd: number; global: QuotaPair; perChat: QuotaPair;
    perUser: QuotaPair & { byRole: Record<string, { daily?: number | null; monthly?: number | null }> };
    perTurn: { maxCostUsd: number; maxSteps: number }; rateLimit: { turnsPerUserPerHour: number; turnsPerChatPerHour: number; concurrentPerUser: number };
    onExceeded: { reply: boolean; message: string } };
  timezone: string; buckets: { day: string; month: string }; counters: QuotaCounter[];
  unpriced: Array<{ providerId: string; modelId: string }>; unpricedTotal: number; unimplemented: string[];
}
interface QuotaForm { enabled: boolean; requirePricing: boolean; minReserveUsd: number | null; globalDaily: number | null; globalMonthly: number | null;
  chatDaily: number | null; chatMonthly: number | null; userDaily: number | null; userMonthly: number | null; byRole: Record<string, QuotaPair>;
  maxCostUsd: number | null; maxSteps: number | null; turnsPerUserPerHour: number | null; turnsPerChatPerHour: number | null;
  concurrentPerUser: number | null; reply: boolean; message: string }
const emptyQuotaForm = (): QuotaForm => ({ enabled: true, requirePricing: true, minReserveUsd: 0.02, globalDaily: null, globalMonthly: null,
  chatDaily: null, chatMonthly: null, userDaily: null, userMonthly: null, byRole: Object.fromEntries(ROLES.map((role) => [role, { daily: null, monthly: null }])),
  maxCostUsd: 0.5, maxSteps: 12, turnsPerUserPerHour: 30, turnsPerChatPerHour: 100, concurrentPerUser: 2, reply: true, message: '' });
/** 这几项在 schema 上是必填正数，没有「不限」这个取值：留空发过去只会拿回一条 zod 报错，在本地就指出是哪一格。 */
const QUOTA_REQUIRED: Array<[keyof QuotaForm, string]> = [['minReserveUsd', '最小预留'], ['maxCostUsd', '单轮成本上限'], ['maxSteps', '单轮步数上限'],
  ['turnsPerUserPerHour', '每人每小时轮次'], ['turnsPerChatPerHour', '每会话每小时轮次'], ['concurrentPerUser', '单用户并发']];
// 未接线的键不给控件，但要说清楚「现在真正管这件事的是谁」——否则运维会去 config.yaml 里改一个没人读的值。
// 第五轮之后 quota 段一个未接线的键都没有了，这张表随之为空；留着结构是因为清单由服务端算，
// 将来再有新键时这里就该重新有内容（别把「现在是空的」写死成「不会再有」）。
const QUOTA_UNIMPLEMENTED_HINTS: Record<string, string> = {};
const QUOTA_SCOPE_LABELS: Record<string, string> = { global: '全局', chat: '会话', user: '用户' };
const quota = ref<QuotaPayload | null>(null);
/**
 * 总览页那两个环：**只画 global 档的当前 day / month**。chat / user 是按主体分的很多行，
 * 挤在总览上读不出任何东西 —— 那是配额页的表要干的事。
 * `limit === null` 时环不画，只写「不限」（见 UiRing）。
 */
// ── 用量聚合：时间范围 + 维度（docs/09 §3.11）────────────────────────────────────
interface UsageReportRow { bucket: string | null; costUsd: number; inputTokens: number; outputTokens: number; calls: number; successes: number; label?: string | null }
// `UiSelect` 是**只认字符串**的选择器（内部 `String(...)` 归一化、emit 也是 string）。
// 这里的天数因此存成字符串，用的时候再 Number()：给它传数字会让 prop 类型校验报警，
// 而且 `picked` 的 `===` 比对也对不上（"7" !== 7），下拉框显示成空。
const USAGE_RANGES = [{ label: '近 7 天', value: '7' }, { label: '近 30 天', value: '30' }, { label: '近 90 天', value: '90' }];
const USAGE_DIMENSIONS = [{ label: '按天', value: 'day' }, { label: '按会话', value: 'chat' }, { label: '按用户', value: 'user' },
  { label: '按模型', value: 'model' }, { label: '按别名', value: 'alias' }, { label: '按 agent', value: 'agent' }];
const usageRange = ref('7');
const usageGroupBy = ref('day');
const usageReport = ref<UsageReportRow[]>([]);
const usageDimensionLabel = computed(() => USAGE_DIMENSIONS.find((entry) => entry.value === usageGroupBy.value)?.label ?? '按天');
const usageTotals = computed(() => {
  const rows = usageReport.value;
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const successes = rows.reduce((sum, row) => sum + row.successes, 0);
  return { cost: rows.reduce((sum, row) => sum + row.costUsd, 0), calls, successRate: calls ? `${Math.round((successes / calls) * 100)}%` : '—' };
});
async function loadUsageReport(): Promise<void> {
  const to = Date.now();
  const from = to - Number(usageRange.value) * 86_400_000;
  try { usageReport.value = (await api<{ rows: UsageReportRow[] }>(`/api/usage/report?groupBy=${usageGroupBy.value}&from=${from}&to=${to}`)).rows; }
  catch (error) { usageReport.value = []; toastError('用量聚合读取失败', error); }
}

const quotaRings = computed(() => {
  const payload = quota.value;
  if (!payload?.quota.enabled) return [];
  return payload.counters
    .filter((row) => row.scope === 'global' && row.current)
    .map((row) => ({ label: row.window === 'day' ? '今日' : '本月', spent: row.costUsd + row.reservedUsd, limit: row.limit, warnAtRatio: 0.8 }));
});
const quotaForm = ref<QuotaForm>(emptyQuotaForm());
const quotaDirty = ref(false);
const quotaSaving = ref(false);
const quotaLoading = ref(false);
const quotaResetting = ref('');
const quotaShowHistory = ref(false);
const counterKey = (row: QuotaCounter): string => `${row.scope}:${row.subject}:${row.window}:${row.bucket}`;
const visibleCounters = computed(() => (quota.value?.counters ?? []).filter((row) => quotaShowHistory.value || row.current));
const staleCounters = computed(() => (quota.value?.counters ?? []).filter((row) => !row.current).length);
function counterTitle(row: QuotaCounter): string {
  if (row.scope === 'global') return '全局';
  return row.label || `未登记${row.scope === 'chat' ? '会话' : '用户'} ${row.subject}`;
}
const spent = (row: QuotaCounter): number => row.costUsd + row.reservedUsd;
/** 分母是 cost + reserved：在途那一轮已经把额度占住了，只画已结算的会让「明明还有钱却被拒」看起来像 bug。 */
const counterRatio = (row: QuotaCounter): number => (row.limit ? Math.min(1, spent(row) / row.limit) : 0);
const money = (value: number): string => `$${value.toFixed(4)}`;
function markQuotaDirty(): void { quotaDirty.value = true; }
function syncQuota(payload: QuotaPayload): void {
  const config = payload.quota;
  quotaForm.value = { enabled: config.enabled, requirePricing: config.requirePricing, minReserveUsd: config.minReserveUsd,
    globalDaily: config.global.daily, globalMonthly: config.global.monthly, chatDaily: config.perChat.daily, chatMonthly: config.perChat.monthly,
    userDaily: config.perUser.daily, userMonthly: config.perUser.monthly,
    byRole: Object.fromEntries(ROLES.map((role) => [role, { daily: config.perUser.byRole[role]?.daily ?? null, monthly: config.perUser.byRole[role]?.monthly ?? null }])),
    maxCostUsd: config.perTurn.maxCostUsd, maxSteps: config.perTurn.maxSteps, turnsPerUserPerHour: config.rateLimit.turnsPerUserPerHour,
    turnsPerChatPerHour: config.rateLimit.turnsPerChatPerHour, concurrentPerUser: config.rateLimit.concurrentPerUser,
    reply: config.onExceeded.reply, message: config.onExceeded.message };
}
/** 不进 load()：计数器要拉 quota_counters 全表 + principals，挂在每条日志事件上是白烧的查询。 */
async function loadQuota(): Promise<void> {
  quotaLoading.value = true;
  try { const payload = await api<QuotaPayload>('/api/quota'); quota.value = payload; if (!quotaDirty.value) syncQuota(payload); }
  catch (error) { toastError('加载配额失败', error); }
  finally { quotaLoading.value = false; }
}
async function saveQuota(): Promise<void> {
  const form = quotaForm.value;
  const missing = QUOTA_REQUIRED.filter(([key]) => form[key] === null).map(([, label]) => label);
  if (missing.length) { pushToast({ severity: 'warn', summary: '这些项不能留空', detail: `${missing.join('、')} 没有「不限」这个取值`, life: 7000 }); return; }
  // 只写真正填了值的角色：`roleLimits?.daily ?? perUser.daily` 对 null 同样回落，
  // 写一条 {daily:null} 与不写这一项在运行时完全等价，留着只会让覆盖表看起来配了其实没配。
  const byRole: Record<string, Record<string, number>> = {};
  for (const [role, pair] of Object.entries(form.byRole)) {
    const entry: Record<string, number> = {};
    if (pair.daily !== null) entry.daily = pair.daily;
    if (pair.monthly !== null) entry.monthly = pair.monthly;
    if (Object.keys(entry).length) byRole[role] = entry;
  }
  quotaSaving.value = true;
  try {
    await api('/api/quota', { method: 'PUT', body: JSON.stringify({ enabled: form.enabled, requirePricing: form.requirePricing, minReserveUsd: form.minReserveUsd,
      'global.daily': form.globalDaily, 'global.monthly': form.globalMonthly, 'perChat.daily': form.chatDaily, 'perChat.monthly': form.chatMonthly,
      'perUser.daily': form.userDaily, 'perUser.monthly': form.userMonthly, 'perUser.byRole': byRole,
      'perTurn.maxCostUsd': form.maxCostUsd, 'perTurn.maxSteps': form.maxSteps,
      'rateLimit.turnsPerUserPerHour': form.turnsPerUserPerHour, 'rateLimit.turnsPerChatPerHour': form.turnsPerChatPerHour,
      'rateLimit.concurrentPerUser': form.concurrentPerUser, 'onExceeded.reply': form.reply, 'onExceeded.message': form.message }) });
    quotaDirty.value = false;
    pushToast({ severity: 'success', summary: '配额已保存', detail: '热更新已生效，下一条消息即按新限额判定' });
    await loadQuota();
    await load();
  } catch (error) { toastError('保存配额失败', error); }
  finally { quotaSaving.value = false; }
}
async function resetQuota(row?: QuotaCounter): Promise<void> {
  const target = row ? `${counterTitle(row)} · ${row.bucket}` : '全部计数器';
  if (!confirm(`重置${target}？已经花掉的钱不会退回，只是这个窗口的计数从零开始 —— 之前被挡住的人立刻又能发起对话。`)) return;
  quotaResetting.value = row ? counterKey(row) : 'all';
  try {
    const result = await api<{ changes: number }>('/api/quota/reset', { method: 'POST', body: row ? JSON.stringify({ scope: row.scope, subject: row.subject, window: row.window, bucket: row.bucket }) : '{}' });
    pushToast({ severity: 'success', summary: `已重置 ${result.changes} 行计数`, detail: `${target} · 已写审计日志` });
    await loadQuota();
  } catch (error) { toastError('重置计数器失败', error); }
  finally { quotaResetting.value = ''; }
}

// ── 沙箱：mode 决定 exec 类工具跑在哪儿，配错了要么全落空要么直接跑在宿主上 ──────────────
interface SandboxForm { mode: string; network: string; image: string; dockerBin: string; workspaceDir: string; hostWorkspaceDir: string;
  memoryMb: number | null; cpus: number | null; pidsLimit: number | null; tmpfsMb: number | null; readOnlyRoot: boolean; bypassRoles: string[] }
interface SandboxPayload { config: Record<string, unknown>; plan?: { allowed: boolean; mode: string; reason?: string } }
const sandbox = ref<SandboxPayload | null>(null);
const sandboxForm = ref<SandboxForm>({ mode: 'docker', network: 'none', image: '', dockerBin: 'docker', workspaceDir: '', hostWorkspaceDir: '',
  memoryMb: 512, cpus: 1, pidsLimit: 128, tmpfsMb: 64, readOnlyRoot: true, bypassRoles: ['owner'] });
const sandboxDirty = ref(false);
const sandboxSaving = ref(false);
const sandboxProbing = ref(false);
const sandboxProbe = ref<{ available: boolean; mode?: string; error?: string } | null>(null);
const pullingImage = ref(false);
// ── 审批规则试跑（docs/09 §3.7）──────────────────────────────────────────────────
interface RuleTestResult { needed: boolean; risk: string; runtimeDependent: boolean; rules: Array<{ index: number; matched: boolean; reason: string }> }
const ruleTestTool = ref('bash');
const ruleTestInput = ref('{"command":"rm -rf /tmp/x"}');
const ruleTesting = ref(false);
const ruleTestResult = ref<RuleTestResult | null>(null);
async function testApprovalRule(): Promise<void> {
  let input: unknown;
  try { input = JSON.parse(ruleTestInput.value || '{}'); }
  catch (error) { toastError('样例输入不是合法 JSON', error); return; }
  ruleTesting.value = true;
  try { ruleTestResult.value = await api<RuleTestResult>('/api/approvals/test', { method: 'POST', body: JSON.stringify({ tool: ruleTestTool.value, input }) }); }
  catch (error) { ruleTestResult.value = null; toastError('试跑失败', error); }
  finally { ruleTesting.value = false; }
}
/**
 * `docker pull <sandbox.image>`。**镜像名取自已保存的那份配置**，不是表单里的值 —— 与
 * 「探测可用性」同一个口径，所以按钮旁边的说明要写清楚这一点。
 * 只 pull 不 build（build 是部署动作，不是控制台按钮）。
 */
async function pullSandboxImage(): Promise<void> {
  if (!confirm('拉取沙箱镜像？镜像名取自**已保存**的 sandbox.image；几百 MB 的镜像可能要几分钟，这期间这个请求一直挂着。')) return;
  pullingImage.value = true;
  try {
    const result = await api<{ image: string }>('/api/sandbox/image', { method: 'POST', body: '{}' });
    pushToast({ severity: 'success', summary: '镜像已拉取', detail: result.image, life: 8000 });
    await probeSandbox();
  } catch (error) { toastError('拉取镜像失败', error); }
  finally { pullingImage.value = false; }
}
const SANDBOX_MODES = [{ value: 'docker', label: 'docker · 每次调用起一个一次性容器' }, { value: 'jail', label: 'jail · 仅限制工作目录，同进程执行' }, { value: 'none', label: 'none · 不隔离，直接在宿主上跑' }];
function markSandboxDirty(): void { sandboxDirty.value = true; }
function syncSandbox(payload: SandboxPayload): void {
  if (sandboxDirty.value) return;
  const config = payload.config as Partial<SandboxForm>;
  sandboxForm.value = { ...sandboxForm.value, ...config, bypassRoles: [...(config.bypassRoles ?? [])] };
}
async function loadSandbox(): Promise<void> {
  try { const payload = await api<SandboxPayload>('/api/sandbox'); sandbox.value = payload; syncSandbox(payload); }
  catch (error) { toastError('加载沙箱配置失败', error); }
}
function toggleBypassRole(role: string): void {
  const current = sandboxForm.value.bypassRoles;
  sandboxForm.value.bypassRoles = current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role];
  markSandboxDirty();
}
async function saveSandbox(): Promise<void> {
  const form = sandboxForm.value;
  if (form.mode === 'none' && !confirm('mode = none 之后，exec 类工具直接在宿主进程的权限下执行任意命令，沙箱那一层完全消失。确定？')) return;
  sandboxSaving.value = true;
  try {
    await api('/api/sandbox', { method: 'PUT', body: JSON.stringify({ mode: form.mode, network: form.network, image: form.image, dockerBin: form.dockerBin,
      workspaceDir: form.workspaceDir, hostWorkspaceDir: form.hostWorkspaceDir, memoryMb: form.memoryMb, cpus: form.cpus, pidsLimit: form.pidsLimit,
      tmpfsMb: form.tmpfsMb, readOnlyRoot: form.readOnlyRoot, bypassRoles: form.bypassRoles }) });
    sandboxDirty.value = false;
    pushToast({ severity: 'success', summary: '沙箱配置已保存', detail: '热更新已生效，下一次工具调用即按新配置执行' });
    await loadSandbox();
  } catch (error) { toastError('保存沙箱配置失败', error); }
  finally { sandboxSaving.value = false; }
}
/** 探测打的是**库里已保存的那份**配置：表单里改了还没存，探出来的仍是旧 mode。 */
async function probeSandbox(): Promise<void> {
  sandboxProbing.value = true;
  try {
    const result = await api<{ available: boolean; mode?: string; error?: string }>('/api/sandbox/probe', { method: 'POST', body: '{}' });
    sandboxProbe.value = result;
    pushToast({ severity: result.available ? 'success' : 'error', summary: result.available ? `沙箱可用（${result.mode ?? sandboxForm.value.mode}）` : '沙箱不可用', detail: result.error ?? '', life: result.available ? 4000 : 9000 });
  } catch (error) { toastError('沙箱探测失败', error); }
  finally { sandboxProbing.value = false; }
}

// ── 扩展：Skill / Plugin / MCP 三张表的启停与重载 ────────────────────────────────
type ExtensionKind = 'skill' | 'plugin' | 'mcp';
const EXTENSION_META: Record<ExtensionKind, { label: string; icon: string }> = {
  skill: { label: 'Skill', icon: 'pi pi-book' }, plugin: { label: 'Plugin', icon: 'pi pi-box' }, mcp: { label: 'MCP', icon: 'pi pi-server' },
};
const MCP_STATE_LABELS: Record<string, { label: string; severity: TagSeverity }> = {
  up: { label: '已连接', severity: 'success' }, pending: { label: '等待连接', severity: 'warn' },
  down: { label: '连不上', severity: 'danger' }, disabled: { label: '停用', severity: 'secondary' },
};
type ExtensionRow = Extension & { kind: ExtensionKind };
const extensionError = (row: ExtensionRow): string | null => row.load_error ?? row.last_error ?? null;
function extensionStatus(row: ExtensionRow): { label: string; severity: TagSeverity } {
  if (row.enabled === 0) return { label: '停用', severity: 'secondary' };
  if (row.kind === 'mcp') return MCP_STATE_LABELS[String(row.state)] ?? { label: row.state ? String(row.state) : '未连接', severity: 'warn' };
  return extensionError(row) ? { label: '错误', severity: 'danger' } : { label: '可用', severity: 'success' };
}
const extensionSubtitle = (row: ExtensionRow): string => (row.kind === 'mcp' ? `${row.transport ?? '未知 transport'} · 最低角色 ${row.min_role ?? '未标注'}`
  : row.description || `${row.version ? `v${row.version} · ` : ''}最低角色 ${row.min_role ?? '未标注'}`);
const extensionBusy = ref('');
const extensionRows = computed(() => [
  ...skills.value.map((item) => ({ ...item, kind: 'skill' as ExtensionKind })),
  ...plugins.value.map((item) => ({ ...item, kind: 'plugin' as ExtensionKind })),
  ...mcp.value.map((item) => ({ ...item, kind: 'mcp' as ExtensionKind })),
]);
async function toggleExtension(row: ExtensionRow): Promise<void> {
  const next = row.enabled === 0;
  // Plugin 是全信任执行任意代码的，开启这一步必须是有意识的动作（docs/07 §3）。
  if (row.kind === 'plugin' && next && !confirm(`启用 Plugin ${row.name}？Plugin 以全信任方式在 bot 进程里运行任意代码，没有沙箱。`)) return;
  extensionBusy.value = `${row.kind}:${row.name}`;
  const resource = row.kind === 'skill' ? 'skills' : row.kind === 'mcp' ? 'mcp' : 'plugins';
  try {
    await api(`/api/${resource}/${encodeURIComponent(row.name)}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    pushToast({ severity: 'success', summary: `${row.name} 已${next ? '启用' : '停用'}`, detail: EXTENSION_META[row.kind].label });
    await load();
  } catch (error) { toastError('切换扩展状态失败', error); }
  finally { extensionBusy.value = ''; }
}
async function reloadExtension(row: ExtensionRow): Promise<void> {
  extensionBusy.value = `${row.kind}:${row.name}`;
  try {
    await api(row.kind === 'mcp' ? `/api/mcp/${encodeURIComponent(row.name)}/reconnect` : `/api/plugins/${encodeURIComponent(row.name)}/reload`, { method: 'POST', body: '{}' });
    pushToast({ severity: 'success', summary: `${row.name} 已${row.kind === 'mcp' ? '重连' : '重载'}`, detail: '结果看下方状态与错误信息' });
    await load();
  } catch (error) { toastError('重载失败', error); }
  finally { extensionBusy.value = ''; }
}

interface SkillDetail { name: string; description: string; body: string; allowedTools?: string[]; minRole: string; model?: string; enabled: boolean; files: string[] }
const skillDialog = ref(false);
const skillSaving = ref(false);
const skillForm = ref({ name: '', description: '', body: '', allowedTools: '', minRole: 'trusted', model: '', enabled: true, files: [] as string[], isNew: true });
function skillDefaultMinRole(): string {
  const skillConfig = config.value.skills;
  if (!skillConfig || typeof skillConfig !== 'object' || !('defaultMinRole' in skillConfig)) return 'trusted';
  const role = skillConfig.defaultMinRole;
  return typeof role === 'string' && ROLES.includes(role) ? role : 'trusted';
}

async function editSkill(row?: ExtensionRow): Promise<void> {
  if (!row) {
    skillForm.value = { name: '', description: '', body: '', allowedTools: '', minRole: skillDefaultMinRole(), model: '', enabled: true, files: [], isNew: true };
    skillDialog.value = true;
    return;
  }
  try {
    const skill = await api<SkillDetail>(`/api/skills/${encodeURIComponent(row.name)}`);
    skillForm.value = { name: skill.name, description: skill.description, body: skill.body, allowedTools: (skill.allowedTools ?? []).join('\n'),
      minRole: skill.minRole, model: skill.model ?? '', enabled: skill.enabled, files: skill.files, isNew: false };
    skillDialog.value = true;
  } catch (error) { toastError('读取 Skill 失败', error); }
}
async function saveSkill(): Promise<void> {
  const form = skillForm.value;
  const name = form.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { pushToast({ severity: 'warn', summary: 'Skill 名称无效', detail: '只能用小写字母、数字和中划线' }); return; }
  if (!form.description.trim() || !form.body.trim()) { pushToast({ severity: 'warn', summary: '描述与正文必填' }); return; }
  skillSaving.value = true;
  try {
    await api(form.isNew ? '/api/skills' : `/api/skills/${encodeURIComponent(name)}`, { method: form.isNew ? 'POST' : 'PUT',
      body: JSON.stringify({ name, description: form.description, body: form.body, allowedTools: form.allowedTools.split('\n').map((entry) => entry.trim()).filter(Boolean),
        minRole: form.minRole, model: form.model || null, enabled: form.enabled }) });
    skillDialog.value = false;
    pushToast({ severity: 'success', summary: `Skill ${name} 已${form.isNew ? '创建' : '保存'}`, detail: 'SKILL.md 已写入并重新扫描' });
    await load();
  } catch (error) { toastError('保存 Skill 失败', error); }
  finally { skillSaving.value = false; }
}
async function removeSkill(name: string): Promise<void> {
  if (!confirm(`永久删除 Skill ${name}？会删除它的整个目录（SKILL.md 与附属文件），无法从 WebUI 恢复。`)) return;
  try { await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `Skill ${name} 已永久删除` }); skillDialog.value = false; await load(); }
  catch (error) { toastError('删除 Skill 失败', error); }
}

// mcp.enabled 是总开关，出厂就是 false，而 McpManager.reconcile 一上来就对它 early-return。
// 不把它摆出来的话，新建 server 会拿到一个 ok:true 加一条永远停在「等待连接」的行 ——
// 「保存成功但运行时没变」正是这份文档反复点名的那类反馈（docs/20 · W-CFG-02）。
const mcpMasterOff = computed(() => (config.value.mcp as { enabled?: boolean } | undefined)?.enabled === false);
async function enableMcpMaster(): Promise<void> {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'mcp.enabled': true }) });
    pushToast({ severity: 'success', summary: 'MCP 总开关已打开', detail: '热更新，已配置的 server 会在下一次 reconcile 时连接' });
    await load();
  } catch (error) { toastError('打开 MCP 总开关失败', error); }
}
const mcpDialog = ref(false);
const mcpSaving = ref(false);
const mcpForm = ref({ originalName: '', name: '', transport: 'stdio', command: '', args: '', env: '{}', url: '', headers: '{}',
  minRole: 'trusted', enabled: true, toolAllow: '', toolDeny: '', timeoutMs: 30000, isNew: true });
function editMcp(row?: ExtensionRow): void {
  mcpForm.value = row ? { originalName: row.name, name: row.name, transport: row.transport ?? 'stdio', command: row.command ?? '', args: (row.args ?? []).join('\n'),
    env: JSON.stringify(row.env ?? {}, null, 2), url: row.url ?? '', headers: JSON.stringify(row.headers ?? {}, null, 2), minRole: row.minRole ?? row.min_role ?? 'trusted',
    enabled: row.enabled !== 0, toolAllow: (row.toolAllow ?? []).join('\n'), toolDeny: (row.toolDeny ?? []).join('\n'), timeoutMs: row.timeoutMs ?? 30000, isNew: false }
    : { originalName: '', name: '', transport: 'stdio', command: '', args: '', env: '{}', url: '', headers: '{}', minRole: 'trusted', enabled: true, toolAllow: '', toolDeny: '', timeoutMs: 30000, isNew: true };
  mcpDialog.value = true;
}
function parseStringMap(text: string, label: string): Record<string, string> {
  const parsed = JSON.parse(text || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error(`${label} 必须是字符串键值 JSON 对象`);
  return parsed as Record<string, string>;
}
async function saveMcp(): Promise<void> {
  const form = mcpForm.value;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(form.name)) { pushToast({ severity: 'warn', summary: 'MCP 名称无效', detail: '只能用小写字母、数字、下划线和中划线' }); return; }
  mcpSaving.value = true;
  try {
    const common = { name: form.name, transport: form.transport, enabled: form.enabled, minRole: form.minRole, timeoutMs: form.timeoutMs,
      toolAllow: form.toolAllow.split('\n').map((entry) => entry.trim()).filter(Boolean), toolDeny: form.toolDeny.split('\n').map((entry) => entry.trim()).filter(Boolean) };
    const body = form.transport === 'stdio'
      ? { ...common, command: form.command, args: form.args.split('\n').map((entry) => entry.trim()).filter(Boolean), env: parseStringMap(form.env, '环境变量') }
      : { ...common, url: form.url, headers: parseStringMap(form.headers, 'HTTP Headers') };
    await api(form.isNew ? '/api/mcp' : `/api/mcp/${encodeURIComponent(form.originalName)}`, { method: form.isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    mcpDialog.value = false;
    pushToast(mcpMasterOff.value
      ? { severity: 'warn', summary: `MCP ${form.name} 已保存，但没有连接`, detail: '总开关 mcp.enabled 是关的，reconcile 会直接跳过所有 server。到扩展页顶部打开它。', life: 12_000 }
      : { severity: 'success', summary: `MCP ${form.name} 已保存`, detail: '配置已热更新并重新发现工具' });
    await load();
  } catch (error) { toastError('保存 MCP 失败', error); }
  finally { mcpSaving.value = false; }
}
async function removeMcp(name: string): Promise<void> {
  if (!confirm(`删除 MCP server ${name}？连接会关闭，发现到的工具会立即从模型工具目录移除。`)) return;
  try { await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `MCP ${name} 已删除` }); mcpDialog.value = false; await load(); }
  catch (error) { toastError('删除 MCP 失败', error); }
}

// ── 维护：备份 / VACUUM / 清日志 / 清孤儿 / 重建 FTS ───────────────────────────────────
const MAINTENANCE_ACTIONS = [
  { action: 'backup', label: '立即备份 DB', icon: 'pi pi-database', hint: '走 VACUUM INTO 写一份完整快照到 db.path 旁边，保留 db.backupKeep 份' },
  { action: 'vacuum', label: 'VACUUM', icon: 'pi pi-compress', hint: '整理页面碎片、回收空间。库大时会阻塞写入' },
  { action: 'cleanup-logs', label: '清理过期日志', icon: 'pi pi-eraser', hint: '按 logs.retentionDays 删掉过期的 log_events、blobs/ 与子 agent 全文结果' },
  { action: 'gc-files', label: '清理孤儿文件', icon: 'pi pi-trash', hint: '只删没有任何 DB 行指向的文件（下载中途崩溃、local_path 被换掉留下的）。不是过期策略：在用的媒体一个都不动' },
  { action: 'rebuild-fts', label: '重建 FTS 索引', icon: 'pi pi-sync', hint: '消息检索结果不对（漏命中/命中已删消息）时重建' },
] as const;
const maintenanceBusy = ref('');
const restarting = ref(false);
const exportBusy = ref(false);
// ── 原始 YAML 模式（docs/09 §3.13）───────────────────────────────────────────────
const yamlMode = ref(false);
const yamlText = ref('');
const yamlSkipped = ref<string[]>([]);
const yamlError = ref('');
const yamlSaving = ref(false);
async function toggleYamlMode(): Promise<void> {
  if (yamlMode.value) { yamlMode.value = false; return; }
  try {
    const payload = await api<{ yaml: string; skipped: string[] }>('/api/config/yaml');
    yamlText.value = payload.yaml;
    yamlSkipped.value = payload.skipped;
    yamlError.value = '';
    yamlMode.value = true;
  } catch (error) { toastError('读取 YAML 覆盖层失败', error); }
}
async function saveYaml(): Promise<void> {
  yamlSaving.value = true;
  yamlError.value = '';
  try {
    const result = await api<{ keys: string[]; skipped: string[]; subsumed: string[] }>('/api/config/yaml', { method: 'PUT', body: JSON.stringify({ yaml: yamlText.value }) });
    await REFRESH_LOADERS.config();
    pushToast({ severity: 'success', summary: `已保存 ${result.keys.length} 个配置段`,
      detail: [result.skipped.length ? `${result.skipped.length} 项被环境变量锁定，已跳过` : '', result.subsumed.length ? `${result.subsumed.length} 条更细的覆盖被整段写入作废：${result.subsumed.join('、')}` : ''].filter(Boolean).join('\n') || '全部生效', life: 12_000 });
  } catch (error) {
    // 语法错误带行号、校验错误带路径：把它们留在编辑器旁边，而不是让 Toast 一闪而过。
    const detail = error as { body?: { error?: { message?: string; line?: number; column?: number; details?: Array<{ path: string; message: string }> } } };
    const info = detail.body?.error;
    yamlError.value = info?.line
      ? `第 ${info.line} 行第 ${info.column} 列：${info.message}`
      : info?.details?.length ? info.details.map((entry) => `${entry.path}: ${entry.message}`).join('；') : info?.message ?? '保存失败';
    toastError('YAML 未保存', error);
  } finally { yamlSaving.value = false; }
}
const importFile = ref<HTMLInputElement | null>(null);
/**
 * `[重启进程]`。二次确认里必须写明「没有 supervisor 就不会自己回来」—— 这是一个可能让整个
 * 部署下线的按钮，措辞含糊比不给按钮更糟。
 */
async function restartProcess(): Promise<void> {
  if (!confirm('重启进程？在途轮次会被排空或中断。\n\n如果这个部署没有 systemd / docker 这类 supervisor，进程不会自动拉起——你需要手工把它启回来。')) return;
  restarting.value = true;
  try {
    await api('/api/restart', { method: 'POST', body: '{}' });
    pushToast({ severity: 'warn', summary: '已请求重启', detail: '控制台会断开；由 supervisor 拉起后刷新页面即可。', life: 12_000 });
  } catch (error) { toastError('重启失败', error); }
  finally { restarting.value = false; }
}
/** 导出下载成 JSON 文件。内容由服务端脱敏，前端只负责存盘。 */
async function exportConfig(): Promise<void> {
  exportBusy.value = true;
  try {
    const payload = await api<{ exportedAt: number; overrides: Record<string, unknown>; skipped: string[] }>('/api/config/export');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `luoli-config-${new Date(payload.exportedAt).toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    // 被跳过的密钥键要点名：导入端拿到这份文件时不会有它们，得知道哪几项要手工重配。
    pushToast({ severity: 'success', summary: `已导出 ${Object.keys(payload.overrides).length} 条覆盖`,
      detail: payload.skipped.length ? `${payload.skipped.length} 个密钥类键未导出：${payload.skipped.join('、')}` : '没有密钥类键被跳过', life: 12_000 });
  } catch (error) { toastError('导出失败', error); }
  finally { exportBusy.value = false; }
}
async function importConfig(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let parsed: { overrides?: Record<string, unknown> };
  try { parsed = JSON.parse(await file.text()) as { overrides?: Record<string, unknown> }; }
  catch (error) { toastError('这个文件不是合法 JSON', error); return; }
  const keys = Object.keys(parsed.overrides ?? {});
  if (!keys.length) { pushToast({ severity: 'warn', summary: '文件里没有 overrides', detail: '导出文件的结构是 { overrides: { 点分键: 值 } }' }); return; }
  if (!confirm(`导入 ${keys.length} 条配置覆盖？\n\n按键覆盖现有值，不会删除文件里没有的那些。校验不过则整批不写。`)) return;
  try {
    const result = await api<{ keys: string[]; skipped: string[]; subsumed: string[] }>('/api/config/import', { method: 'POST', body: JSON.stringify(parsed) });
    await REFRESH_LOADERS.config();
    pushToast({ severity: 'success', summary: `已导入 ${result.keys.length} 项`,
      detail: [result.skipped.length ? `${result.skipped.length} 项被环境变量锁定，已跳过：${result.skipped.join('、')}` : '',
        result.subsumed.length ? `${result.subsumed.length} 条更细的覆盖被整块写入作废：${result.subsumed.join('、')}` : ''].filter(Boolean).join('\n') || '全部生效', life: 12_000 });
  } catch (error) { toastError('导入失败', error); }
}
async function runMaintenance(action: string, label: string): Promise<void> {
  // gc-files 是**删文件**，别和「整理一下」混在同一句确认语里：运维需要知道它删什么、不删什么。
  const warning = action === 'gc-files'
    ? '只删没有任何数据库行指向的孤儿文件；在用的媒体与子 agent 结果一个都不动。这不是保留策略，不会让在用的附件变少。'
    : '大库上可能耗时较久，期间写入会被阻塞。';
  if (!confirm(`执行「${label}」？${warning}`)) return;
  maintenanceBusy.value = action;
  try {
    const result = await api<unknown>(`/api/maintenance/${action}`, { method: 'POST', body: '{}' });
    pushToast({ severity: 'success', summary: `${label} 完成`, detail: typeof result === 'string' ? result : JSON.stringify(result), life: 8000 });
  } catch (error) { toastError(`${label} 失败`, error); }
  finally { maintenanceBusy.value = ''; }
}

// ── 依赖健康：总览页那张卡以前是四行写死的字，与运行时无关 ──────────────────────────
interface HealthDetail { ok: boolean; version: string; uptimeMs: number; db: { ok: boolean; bytes?: number; walBytes?: number; workspaceBytes?: number };
  mcp: Array<{ name: string; state: string; error: string | null }>; sandbox: { allowed: boolean; mode?: string; reason?: string }; inFlightTurns: number }
const health = ref<HealthDetail | null>(null);
const uptimeText = computed(() => {
  const ms = health.value?.uptimeMs ?? 0;
  const hours = ms / 3_600_000;
  return hours < 1 ? `${Math.round(ms / 60_000)} 分钟` : hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
});
const mcpDown = computed(() => (health.value?.mcp ?? []).filter((entry) => entry.state !== 'up').length);
/** 总览页那张卡片只看 warn 以上，最多 10 条：服务端已经按 `minLevel` 过滤过一遍，这里只截条数。 */
const recentErrors = ref<LogRow[]>([]);
/** 点一行跳到日志页并展开那条 trace。没有 traceId 的事件（启动、配置变更）只切页。 */
function openTrace(traceId: string | null): void {
  active.value = 'logs';
  if (traceId) inspectTrace(traceId);
}

// ── 在途 turn：权威来源是进程内的 TurnRegistry，不是 turns 表（崩溃残留的 running 行要等
//    下次启动才归零）。首屏拉一次，之后靠 turn.started / turn.progress / turn.finished 增量更新 ──
interface ActiveTurn { id: string; key: string; chatId: string; userId: string; role: string; startedAt: number; steps: number; toolCalls: number; costUsd: number; inputTokens: number; outputTokens: number }
const activeTurns = ref<ActiveTurn[]>([]);
const turnProgress = ref<Record<string, { phase: string; step: number; note: string }>>({});
const cancellingTurn = ref('');
const nowTick = ref(Date.now());
setInterval(() => { nowTick.value = Date.now(); }, 1000);
const elapsed = (since: number): string => {
  const seconds = Math.max(0, Math.round((nowTick.value - since) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
function turnWho(turn: ActiveTurn): string {
  const principal = principals.value.find((entry) => entry.kind === 'user' && entry.tgId === turn.userId);
  return principal?.displayName || (principal?.username ? `@${principal.username}` : `用户 ${turn.userId}`);
}
async function loadActiveTurns(): Promise<void> {
  try { activeTurns.value = await api<ActiveTurn[]>('/api/turns/active'); }
  catch { activeTurns.value = []; }
}
/** 取消是 abort 信号不是删除：该轮会落成 cancelled，已发出的消息与上下文都还在。 */
async function cancelTurn(turn: ActiveTurn): Promise<void> {
  if (!confirm(`取消 ${turnWho(turn)} 的这一轮？模型调用会被中断，该轮记成 cancelled；已经发出去的消息不会撤回。`)) return;
  cancellingTurn.value = turn.id;
  try {
    const result = await api<{ cancelled: boolean }>(`/api/turns/${encodeURIComponent(turn.id)}/cancel`, { method: 'POST', body: '{}' });
    pushToast(result.cancelled ? { severity: 'success', summary: '已发出取消信号', detail: `${turn.id.slice(0, 12)} · 该轮会记成 cancelled` }
      : { severity: 'warn', summary: '这一轮已经结束了', detail: '取消信号没有作用对象，界面稍后会自己刷新' });
    await loadActiveTurns();
  } catch (error) { toastError('取消失败', error); }
  finally { cancellingTurn.value = ''; }
}

/** 任务没有独立的取消句柄：`spawn_agent` 的子 agent 跑在父轮次的 abort 信号下，
 *  取消一条任务只能取消它所属的整轮 —— 说清楚再动手，别让人以为只停了这一个子 agent。 */
async function cancelTaskTurn(task: Record<string, unknown>): Promise<void> {
  const turnId = String(task.turn_id ?? '');
  if (!turnId) { pushToast({ severity: 'warn', summary: '这条任务没有关联轮次', detail: '没有可取消的对象' }); return; }
  if (!confirm(`取消任务「${String(task.title ?? turnId)}」？它没有独立的取消句柄，实际取消的是所属的整轮 ${turnId.slice(0, 12)} —— 同一轮里的其他子 agent 也会一起停。`)) return;
  cancellingTurn.value = turnId;
  try {
    const result = await api<{ cancelled: boolean }>(`/api/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', body: '{}' });
    pushToast(result.cancelled ? { severity: 'success', summary: '已发出取消信号', detail: `轮次 ${turnId.slice(0, 12)}` }
      : { severity: 'warn', summary: '这一轮已经结束了', detail: '任务状态会在下次刷新时归位' });
    await REFRESH_LOADERS.tasks();
  } catch (error) { toastError('取消失败', error); }
  finally { cancellingTurn.value = ''; }
}

const decidingApproval = ref('');
async function decideApproval(approval: Record<string, unknown>, approved: boolean): Promise<void> {
  const id = String(approval.id);
  decidingApproval.value = id;
  try {
    const result = await api<{ changed: boolean }>(`/api/approvals/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify({ approved }) });
    pushToast(result.changed
      ? { severity: approved ? 'success' : 'warn', summary: approved ? '已批准，工具继续执行' : '已拒绝，工具不会执行', detail: String(approval.tool_name ?? id) }
      : { severity: 'warn', summary: '审批已经失效', detail: '可能已被处理、过期或所属轮次已取消' });
    await REFRESH_LOADERS.tasks();
  } catch (error) { toastError('提交审批决定失败', error); }
  finally { decidingApproval.value = ''; }
}

// ── SSE：首屏之后界面的数据新鲜度全靠这里（docs/21 · G-SSE-01）───────────────────
// 事件到达**不再无脑重跑 `load()`**（那是一次 18 个端点）：按事件类型只刷相关的那几组，
// 且只刷当前页面看得见的。服务端已按 kind 合并过一轮，这一层挡的是「多个 kind 同时来」。
type RefreshGroup = 'dashboard' | 'logs' | 'chats' | 'usage' | 'quota' | 'tasks' | 'approvals' | 'extensions' | 'config' | 'activeTurns';
const REFRESH_DEBOUNCE_MS = 400;
const lastEventAt = ref(0);
const REFRESH_LOADERS: Record<RefreshGroup, () => Promise<void>> = {
  dashboard: async () => {
    [dashboard.value, health.value, recentErrors.value] = await Promise.all([api<Dashboard>('/api/dashboard'), api<HealthDetail>('/api/health/detail'), api<LogRow[]>('/api/logs?minLevel=warn&size=10')]);
    await loadQuota().catch(() => undefined);
  },
  logs: async () => { logs.value = await api<LogRow[]>('/api/logs'); },
  chats: async () => { chats.value = await api<Chat[]>('/api/chats'); },
  usage: async () => { [usage.value] = await Promise.all([api<Usage[]>('/api/usage'), loadUsageReport()]); },
  quota: loadQuota,
  tasks: async () => { tasks.value = await api<Array<Record<string, unknown>>>('/api/tasks'); },
  approvals: async () => { approvals.value = await api<Array<Record<string, unknown>>>('/api/approvals'); },
  extensions: async () => { [skills.value, plugins.value, mcp.value] = await Promise.all([api<Extension[]>('/api/skills'), api<Extension[]>('/api/plugins'), api<Extension[]>('/api/mcp')]); },
  config: async () => { [config.value, tools.value, agents.value] = await Promise.all([api<Record<string, unknown>>('/api/config'), api<Record<string, ToolPolicy>>('/api/tools'), api<AgentDefinition[]>('/api/agents')]); syncTrigger(); syncOutput(); },
  activeTurns: loadActiveTurns,
};
// 哪些页面看得见这一组。看不见就不刷 —— 切过去时 watch(active) 会补一次。
const REFRESH_VISIBILITY: Record<RefreshGroup, readonly string[]> = {
  dashboard: ['dashboard'], logs: ['dashboard', 'logs'], chats: ['chats'], usage: ['usage'], quota: ['quota'],
  tasks: ['tasks'], extensions: ['extensions', 'dashboard'], activeTurns: ['dashboard'],
  // 待审批不做页面过滤：一条 pending 会把某个真实轮次卡住最多 approval.ttlMs，
  // 只在任务页刷新等于「运维不切到那一页就永远不知道有人在等」。事件本身很稀疏（命中规则才发）。
  approvals: ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools', 'extensions', 'agents', 'logs', 'usage', 'quota', 'tasks', 'settings'],
  // 配置变了影响设置页、工具页、Agent 页，也影响会话页的覆盖显示；这个事件本身很稀疏，不做页面过滤。
  config: ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools', 'extensions', 'agents', 'logs', 'usage', 'quota', 'tasks', 'settings'],
};
const EVENT_REFRESH: Record<string, readonly RefreshGroup[]> = {
  log: ['logs', 'dashboard'],
  'turn.started': ['activeTurns', 'dashboard'],
  'turn.progress': ['activeTurns'],
  'turn.finished': ['activeTurns', 'dashboard', 'chats'],
  usage: ['usage', 'dashboard'],
  quota: ['quota'],
  'task.updated': ['tasks'],
  'approval.pending': ['approvals'], 'approval.decided': ['approvals'],
  'config.changed': ['config'],
  health: ['dashboard', 'extensions'],
};
const sinceLastEvent = computed(() => {
  const seconds = Math.max(0, Math.round((nowTick.value - lastEventAt.value) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
});
const refreshTimers = new Map<RefreshGroup, ReturnType<typeof setTimeout>>();
function scheduleRefresh(groups: readonly RefreshGroup[]): void {
  for (const group of groups) {
    if (refreshTimers.has(group) || !REFRESH_VISIBILITY[group].includes(active.value)) continue;
    refreshTimers.set(group, setTimeout(() => { refreshTimers.delete(group); void REFRESH_LOADERS[group]().catch(() => undefined); }, REFRESH_DEBOUNCE_MS));
  }
}

// ── 全量配置表单：由 config.schema.json 自动生成（docs/09 §3.13、docs/21 §1.1）──────────
// 153 个已接线叶子里此前只有 15 个能在界面上改。手写 100 多个控件必然与 schema 漂移，
// 所以这里只取 `GET /api/config/schema` 的三件套喂给 SchemaForm，控件形态全从 schema 推。
interface ConfigSchemaPayload { schema: Record<string, unknown>; hotReloadable: string[]; unimplemented: string[]; envPinned: Array<{ key: string; env: string }> }
const configSchema = ref<ConfigSchemaPayload | null>(null);
const schemaSaving = ref(false);
const schemaForm = ref<{ commit(paths: string[]): void } | null>(null);
async function loadConfigSchema(): Promise<void> {
  if (configSchema.value) return;
  try { configSchema.value = await api<ConfigSchemaPayload>('/api/config/schema'); }
  catch (error) { toastError('加载配置 schema 失败', error); }
}
// ── 会话级覆盖：`perChat.<contextKey>` 此前只能用 curl 打（docs/21 · G-API-09）────────────
// 白名单是安全边界（docs/11 §2.1）：服务端 superRefine 会拒掉不在里面的路径，这里只是把同一份
// 名单摆到界面上，少一项等于运维够不着，多一项等于让人白填一遍再吃 400。
const PER_CHAT_ALLOWLIST = ['trigger', 'output', 'context.scope', 'context.limit', 'context.active', 'context.background', 'agent.main', 'memory.pubWriteMinRole'] as const;
const PER_CHAT_NOTES: Record<string, string> = {
  'context.scope': '⚠️ 改成 thread 之后，这个会话的后续消息会落到 thread:<chat>:<topic> 这个新 key 上 —— 而覆盖是按 key 存的，等于这条覆盖把自己作废了',
  'agent.main.modelAlias': '只换这个会话的主模型；Telegram 侧的 /model 写的是另一份（app_kv 的会话别名），两者都在时以 /model 为准 —— 上面那条黄色提示就是它，可以直接清掉',
};
const chatOverrides = computed<Record<string, unknown>>(() => {
  const key = selectedChat.value?.key;
  const all = (config.value.perChat ?? {}) as Record<string, unknown>;
  const entry = key ? all[key] : null;
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
});
/** 覆盖对象拍平成点分行，界面上要一眼看出「这个会话到底改了哪几项」。 */
function flattenOverrides(node: unknown, prefix = ''): Array<{ path: string; value: unknown }> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return prefix ? [{ path: prefix, value: node }] : [];
  return Object.entries(node).flatMap(([key, child]) => flattenOverrides(child, prefix ? `${prefix}.${key}` : key));
}
const chatOverrideRows = computed(() => flattenOverrides(chatOverrides.value));
/** 表单里显示的是这个会话**实际生效**的值（全局 + 覆盖），跟 `perChatConfig` 在运行时做的合并一致。 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(patch);
  const out = { ...base as Record<string, unknown> };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value);
  return out;
}
const chatEffectiveConfig = computed(() => deepMerge(config.value, chatOverrides.value) as Record<string, unknown>);
const chatOverrideSaving = ref(false);
const chatOverrideForm = ref<{ commit(paths: string[]): void } | null>(null);
const chatOverrideOpen = ref(false);
/** `config` 是深响应式的 ref，读出来的嵌套对象是 Proxy —— `structuredClone` 对 Proxy 直接抛
 *  DataCloneError（表现是点了没反应、连报错都没有）。配置本来就是 JSON 安全的，走一遍序列化即可。 */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
/** PATCH 是整体替换而不是合并：只发这次改的那几项会把已有的覆盖一起抹掉。 */
function writeChatOverrides(next: Record<string, unknown>): Promise<unknown> {
  const chat = selectedChat.value;
  if (!chat) return Promise.resolve(null);
  return api(`/api/chats/${encodeURIComponent(chat.key)}`, { method: 'PATCH', body: JSON.stringify(next) });
}
async function saveChatOverrides(changes: Record<string, unknown>): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  chatOverrideSaving.value = true;
  try {
    const next = plain(chatOverrides.value);
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split('.');
      let cursor = next;
      for (const part of parts.slice(0, -1)) cursor = (cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : (cursor[part] = {})) as Record<string, unknown>;
      cursor[parts.at(-1)!] = value;
    }
    await writeChatOverrides(next);
    chatOverrideForm.value?.commit(Object.keys(changes));
    pushToast({ severity: 'success', summary: `已为「${chatIdentity(chat).name}」保存 ${Object.keys(changes).length} 项覆盖`, detail: '下一轮开始生效；全局值不受影响' });
    await REFRESH_LOADERS.config();
  } catch (error) { toastError('保存会话级覆盖失败', error); }
  finally { chatOverrideSaving.value = false; }
}
async function dropChatOverride(path: string): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  try {
    const next = plain(chatOverrides.value);
    const parts = path.split('.');
    let cursor: Record<string, unknown> | null = next;
    const trail: Array<[Record<string, unknown>, string]> = [];
    for (const part of parts.slice(0, -1)) { if (!cursor || typeof cursor[part] !== 'object') { cursor = null; break; } trail.push([cursor, part]); cursor = cursor[part] as Record<string, unknown>; }
    if (!cursor) return;
    delete cursor[parts.at(-1)!];
    // 空掉的中间层要一起收掉，否则覆盖对象里会留下一串 `{}`，看起来还配着什么。
    for (const [parent, part] of trail.reverse()) if (!Object.keys(parent[part] as Record<string, unknown>).length) delete parent[part];
    await writeChatOverrides(next);
    pushToast({ severity: 'success', summary: `已取消覆盖 ${path}`, detail: '这一项回到全局值，下一轮生效' });
    await REFRESH_LOADERS.config();
  } catch (error) { toastError('取消覆盖失败', error); }
}

async function saveSchemaConfig(changes: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(changes);
  const cold = keys.filter((key) => !(configSchema.value?.hotReloadable ?? []).some((prefix) => key === prefix || key.startsWith(`${prefix}.`)));
  schemaSaving.value = true;
  try {
    const result = await api<{ keys: string[]; subsumed: string[] }>('/api/config', { method: 'PUT', body: JSON.stringify(changes) });
    // 落库是同步的，但 bot 进程要等 `config.changed` 才 loadConfig()：下面那次 GET 可能还是旧值，
    // 不把表单基线推上去的话，保存完按钮还挂着「保存 N 项改动」。
    schemaForm.value?.commit(keys);
    // 「保存成功但运行时没变」是最误导的一类反馈（docs/20 · W-CFG-02）：需重启的键要说出来。
    pushToast({ severity: cold.length ? 'warn' : 'success', summary: `已保存 ${keys.length} 项配置`,
      detail: cold.length ? `其中 ${cold.length} 项要重启进程才生效：${cold.slice(0, 4).join('、')}${cold.length > 4 ? ' 等' : ''}` : '全部是热更新项，已即时生效', life: cold.length ? 9000 : 5000 });
    // 整块写入会作废同一子树下更细的那些覆盖行（例如工具页逐个点出来的 tools.overrides.<name>）。
    // 不说出来的话，运维只会看到「保存成功」，而某个工具的开关被这次保存顺手改掉了。
    const subsumed = result?.subsumed ?? [];
    if (subsumed.length) {
      pushToast({ severity: 'warn', summary: `顺带作废了 ${subsumed.length} 条更细的覆盖`,
        detail: `${subsumed.slice(0, 4).join('、')}${subsumed.length > 4 ? ' 等' : ''} —— 它们已被这次的整块写入取代，请确认工具页上的开关状态`, life: 12000 });
    }
    await REFRESH_LOADERS.config();
  } catch (error) { toastError('保存配置失败', error); }
  finally { schemaSaving.value = false; }
}

// ── 修改登录口令（docs/21 · G-API-13）───────────────────────────────────────────────
// 端点一直有，界面上没有入口：泄露口令后的应急处置只能打 API 或线下 `pnpm webui:passwd` + 重启，
// 而那正是 docs/22 · V-AUTH-02 要消灭的形态。WEBUI_PASSWORD 在环境里时服务端会 409 ——
// 那种情况下改这里重启就回退了，所以直接把表单换成一句说明。
const passwordForm = ref({ current: '', next: '', confirm: '' });
const passwordSaving = ref(false);
const passwordPinnedEnv = computed(() => configSchema.value?.envPinned.find((entry) => entry.key === 'webui.passwordHash')?.env ?? null);
const passwordProblem = computed(() => {
  const form = passwordForm.value;
  if (!form.current) return '要先验证当前口令';
  if (form.next.length < 12) return '新口令至少 12 个字符';
  if (form.next !== form.confirm) return '两次输入的新口令不一致';
  if (form.next === form.current) return '新口令和当前口令一样';
  return '';
});
async function savePassword(): Promise<void> {
  if (passwordProblem.value) return;
  passwordSaving.value = true;
  try {
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current: passwordForm.value.current, next: passwordForm.value.next }) });
    passwordForm.value = { current: '', next: '', confirm: '' };
    pushToast({ severity: 'success', summary: '登录口令已更新', detail: '其余会话已全部吊销（当前这个还在）；新口令即时生效，不用重启', life: 9000 });
  } catch (error) { toastError('修改口令失败', error); }
  finally { passwordSaving.value = false; }
}

// ── 配置变更历史：config_revisions 记了每一次写入的前后值，但界面上一直没有入口 ──────────
interface ConfigRevision { id: string; ts: number; actor: string; key: string; old_json: string | null; new_json: string | null }
const revisionsDialog = ref(false);
const configRevisions = ref<ConfigRevision[]>([]);
const revisionsLoading = ref(false);
async function openConfigRevisions(): Promise<void> {
  revisionsDialog.value = true; revisionsLoading.value = true;
  try { configRevisions.value = await api<ConfigRevision[]>('/api/config/revisions'); }
  catch (error) { toastError('加载配置变更历史失败', error); }
  finally { revisionsLoading.value = false; }
}
/**
 * 值可能很长（agent.agents 是整张数组），列表里只给一行；密钥类的键在写入时就已经存成 «redacted»。
 * 两侧的 null 意思不同：旧值为空 = 此前没有覆盖，新值为空 = 这条覆盖行被删掉了
 * （写更粗的祖先键时，被它取代的后代行会一并作废）。
 */
const revisionValue = (raw: string | null, side: 'old' | 'new'): string => (raw === null
  ? (side === 'old' ? '（此前没有覆盖）' : '（这条覆盖已被删除）')
  : raw.length > 160 ? `${raw.slice(0, 160)}…` : raw);

/** 侧栏那行监听地址：来自合并后的配置，不是写死的默认值。 */
const listenAddress = computed(() => {
  const webui = (config.value.webui ?? {}) as { host?: string; port?: number };
  return webui.host && webui.port ? `${webui.host}:${webui.port}` : location.host;
});

async function logout(): Promise<void> {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* 会话可能已经过期，照样跳登录页 */ }
  location.assign('/login');
}

watch(active, (value) => {
  if (value === 'messages') void loadConversations();
  if (value === 'quota') void loadQuota();
  if (value === 'tools') void loadSandbox();
  if (value === 'settings') void loadConfigSchema();
  // 切回来时补一次：不可见的分组在事件到达时被跳过了，直接显示会是离开那一刻的快照。
  if (value === 'dashboard') void loadActiveTurns();
});
onMounted(async () => {
  await hydrateSession();
  await load();
  void loadActiveTurns();
  const events = new EventSource('/api/events');
  events.onopen = () => { connected.value = true; };
  events.onerror = () => { connected.value = false; };
  for (const [type, groups] of Object.entries(EVENT_REFRESH)) {
    events.addEventListener(type, (message) => {
      lastEventAt.value = Date.now();
      // 步骤进度只有事件里那一份（turns 表要等这一步结束才写），直接用载荷更新，不回查。
      if (type === 'turn.progress') {
        try {
          const data = JSON.parse((message as MessageEvent<string>).data) as { turnId?: string; phase?: string; step?: number; note?: string };
          if (data.turnId) turnProgress.value = { ...turnProgress.value, [data.turnId]: { phase: String(data.phase ?? ''), step: Number(data.step ?? 0), note: String(data.note ?? '') } };
        } catch { /* 载荷坏了不该让刷新一起失效 */ }
      }
      scheduleRefresh(groups);
    });
  }
});

const roleSeverity = (role: string): TagSeverity => ({ owner: 'success', trusted: 'info', limited: 'warn', blocked: 'danger' }[role] as TagSeverity);
</script>

<template>
  <main class="console-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">{{ botName.slice(0, 1).toUpperCase() }}</div><div><b>{{ botName }}</b><span>CONTROL PLANE</span></div></div>
      <nav aria-label="主导航">
        <button v-for="item in navigation" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]">
          <i :class="item[1]" aria-hidden="true" /><span>{{ item[2] }}</span>
          <span v-if="item[0] === 'tasks' && pendingApprovals" class="nav-badge" :title="`${pendingApprovals} 个调用正等待裁决`">{{ pendingApprovals }}</span>
        </button>
      </nav>
      <!-- 监听地址读配置：写死成 127.0.0.1:8787 的话，改过 host/port 的部署会看到一个假地址 -->
      <div class="system-pill"><span :class="['status-dot', { live: connected }]" /><div><b>{{ connected ? '系统在线' : '正在连接' }}</b><small>{{ listenAddress }}</small></div></div>
    </aside>

    <section class="main-panel">
      <header class="topbar">
        <UiButton class="mobile-only" variant="text" icon="pi pi-bars" aria-label="打开导航" @click="mobileMenu = true" />
        <div><p class="eyebrow">OPERATIONS</p><h1>{{ currentLabel }}</h1></div>
        <div class="top-actions"><label class="search"><i class="pi pi-search" /><input v-model="query" placeholder="搜索 trace、会话或主体"></label><UiButton variant="outlined" icon="pi pi-bell" aria-label="通知" />
          <button type="button" class="owner-chip" :title="`bot owner · ${ownerLabel} ${ownerHandle}`" @click="active = 'principals'">
            <span class="avatar">{{ ownerInitials }}</span><span class="who"><b>{{ ownerLabel }}</b><small>{{ ownerHandle }}</small></span>
          </button>
          <UiButton variant="text" icon="pi pi-sign-out" aria-label="退出登录" title="退出登录" @click="logout" />
        </div>
      </header>

      <div class="content">
        <!-- 每个分支必须带 key：两个相邻页面都是 <section>，没有 key 时 Vue 认成同一个节点，只换内容不走过渡 -->
        <Transition name="page" mode="out-in">
        <div v-if="active === 'dashboard'" key="dashboard">
          <section class="hero-row">
            <div><p class="eyebrow">LIVE OVERVIEW</p><h2>早上好，系统状态<span>稳定。</span></h2><p>所有关键路径集中在一个 trace 中。异常先看证据，再处理。</p></div>
            <UiButton label="打开实时日志" icon="pi pi-wave-pulse" @click="active = 'logs'" />
          </section>
          <section class="metric-grid">
            <article><div class="metric-icon violet"><i class="pi pi-bolt" /></div><span>在途 turn</span><b>{{ dashboard.turns.running }}</b><small>总计 {{ dashboard.turns.total }} 次</small></article>
            <article><div class="metric-icon cyan"><i class="pi pi-comments" /></div><span>归档消息</span><b>{{ dashboard.messages.total }}</b><small>FTS 索引已启用</small></article>
            <article><div class="metric-icon rose"><i class="pi pi-wallet" /></div><span>累计花费</span><b>${{ Number(dashboard.turns.cost || 0).toFixed(4) }}</b><small>失败 {{ dashboard.turns.failed }} 次</small></article>
            <article><div class="metric-icon amber"><i class="pi pi-sparkles" /></div><span>可用 Provider</span><b>{{ dashboard.providers.enabled }}</b><small>共配置 {{ dashboard.providers.total }} 个</small></article>
          </section>
          <!-- 在途 turn 表（docs/09 §3.1）：数据来自进程内的 TurnRegistry，首屏拉一次，
               之后 turn.started / turn.progress / turn.finished 三种事件增量更新。 -->
          <section class="surface in-flight">
            <header><div><p class="eyebrow">IN FLIGHT</p><h3>在途 turn</h3><p class="section-note">这里有几行，就有几轮真的在跑（进程内的 TurnRegistry，不是 turns 表里可能残留的 running 行）。取消会中断模型调用、把该轮记成 cancelled，已经发出去的消息不撤回。</p></div>
              <UiTag :value="activeTurns.length ? `${activeTurns.length} 轮进行中` : '空闲'" :severity="activeTurns.length ? 'info' : 'secondary'" /></header>
            <DataGrid :rows="activeTurns" :columns="COLUMNS.activeTurns" data-key="id" empty="当前没有正在跑的轮次。">
              <template #who="{ data }"><b>{{ turnWho(data) }}</b><UiTag :value="data.role" :severity="roleSeverity(data.role)" /></template>
              <template #chat="{ data }"><code>{{ data.key }}</code></template>
              <template #progress="{ data }">
                <span v-if="turnProgress[data.id]">第 {{ turnProgress[data.id].step }} 步 · {{ turnProgress[data.id].phase === 'tools' ? '工具' : '模型' }} <small>{{ turnProgress[data.id].note }}</small></span>
                <small v-else class="alias-empty">刚开始，还没有步骤事件</small>
              </template>
              <template #stats="{ data }">{{ data.steps }} 步 · ${{ Number(data.costUsd || 0).toFixed(4) }}</template>
              <template #elapsed="{ data }">{{ elapsed(data.startedAt) }}</template>
              <template #actions="{ data }"><UiButton size="small" variant="outlined" severity="danger" label="取消" :loading="cancellingTurn === data.id" @click="cancelTurn(data)" /></template>
            </DataGrid>
          </section>
          <section class="dashboard-grid">
            <!-- 最近**错误**（level≥warn，10 条），点一行直接跳到那条 trace。此前这里是不分级别
                 的最近 6 条，实际上永远被 info 刷满 —— 一张「最近错误」卡片看不到错误（docs/09 §3.1）。 -->
            <article class="surface span-2"><header><div><p class="eyebrow">RECENT ERRORS</p><h3>最近错误</h3><p class="section-note">level ≥ warn · 点一行跳到该 trace</p></div><UiButton variant="text" label="查看全部" icon="pi pi-arrow-right" icon-pos="right" @click="active = 'logs'" /></header>
              <div class="log-list">
                <button v-for="row in recentErrors" :key="row.id" type="button" class="log-row" @click="openTrace(row.trace_id)">
                  <span :class="['level', row.level]">{{ row.level }}</span><code>{{ row.kind }}</code><p>{{ row.summary }}</p><time>{{ new Date(row.ts).toLocaleTimeString() }}</time>
                </button>
                <div v-if="!recentErrors.length" class="empty">最近没有 warn 以上的事件。</div>
              </div>
            </article>
            <!-- 这四行以前是写死的字（沙箱恒显示「Docker」，与 sandbox.mode 无关）。数据一律来自 /api/health/detail。 -->
            <article class="surface health"><header><div><p class="eyebrow">HEALTH</p><h3>依赖健康</h3><p class="section-note">v{{ health?.version ?? 'dev' }} · 已运行 {{ uptimeText }}</p></div></header>
              <div class="health-row"><span>SQLite / WAL</span><UiTag :value="health?.db.ok === false ? '读写失败' : '在线'" :severity="health?.db.ok === false ? 'danger' : 'success'" /></div>
              <!-- 「连上了」和「有数据在流动」是两回事：G-SSE-01 之前那根管子里一个字节都没有，
                   徽标却一直显示「在线」。收到过事件才敢说实时。 -->
              <div class="health-row"><span>SSE 推送</span><UiTag :value="!connected ? '重连中' : lastEventAt ? `实时 · ${sinceLastEvent}` : '已连接，暂无事件'" :severity="!connected ? 'warn' : lastEventAt ? 'success' : 'secondary'" /></div>
              <div class="health-row"><span>模型注册表</span><UiTag :value="`${dashboard.providers.enabled} / ${dashboard.providers.total} 可用`" :severity="dashboard.providers.enabled ? 'success' : 'warn'" /></div>
              <div class="health-row"><span>在途 turn</span><UiTag :value="String(health?.inFlightTurns ?? 0)" severity="secondary" /></div>
              <div class="health-row"><span>MCP</span><UiTag v-if="!health?.mcp.length" value="未配置" severity="secondary" /><UiTag v-else :value="mcpDown ? `${mcpDown} 个异常` : `${health.mcp.length} 个就绪`" :severity="mcpDown ? 'danger' : 'success'" /></div>
              <div class="health-row"><span>沙箱</span><UiTag :value="health?.sandbox ? `${health.sandbox.mode ?? '未知'}${health.sandbox.allowed ? '' : ' · 不可用'}` : '未装配'" :severity="!health?.sandbox ? 'secondary' : health.sandbox.allowed ? 'info' : 'danger'" :title="health?.sandbox?.reason ?? ''" /></div>
              <!-- 占用只统计不清理：这三行是「该不该去点维护操作」的判据（docs/09 §3.1）。 -->
              <div class="health-row"><span>DB / WAL</span><UiTag :value="`${formatBytes(health?.db.bytes)} / ${formatBytes(health?.db.walBytes)}`" severity="secondary" title="WAL 明显偏大时点一次 VACUUM 或等下次维护任务的 checkpoint" /></div>
              <div class="health-row"><span>workspace 占用</span><UiTag :value="formatBytes(health?.db.workspaceBytes)" severity="secondary" title="模型在会话工作目录里造的文件；清理走「清理孤儿文件」或手工删" /></div>
            </article>
          </section>
          <section class="dashboard-grid">
            <article class="surface span-2"><header><div><p class="eyebrow">TREND</p><h3>近 7 天</h3><p class="section-note">按 general.timezone 的本地日分桶；没有数据的那天是 0，不是断点</p></div></header>
              <UiLineChart v-if="dashboard.trend?.length" :labels="dashboard.trend.map((point) => point.day.slice(5))"
                :series="[{ name: '消息', values: dashboard.trend.map((point) => point.messages) }, { name: '轮次', values: dashboard.trend.map((point) => point.turns) }]" />
              <div v-else class="empty">还没有数据。</div>
            </article>
            <article class="surface"><header><div><p class="eyebrow">QUOTA</p><h3>额度</h3><p class="section-note">当前 bucket · 详见配额页</p></div></header>
              <div class="ring-row">
                <UiRing v-for="ring in quotaRings" :key="ring.label" :spent="ring.spent" :limit="ring.limit" :label="ring.label" :warn-at-ratio="ring.warnAtRatio" />
                <div v-if="!quotaRings.length" class="empty">配额已关闭或还没有计数。</div>
              </div>
            </article>
          </section>
        </div>

        <section v-else-if="active === 'chats'" key="chats" class="surface page-surface">
          <header><div><p class="eyebrow">CONTEXTS</p><h2>会话上下文</h2><p>每个会话一张卡片，点开看它的消息窗口与提交历史。</p></div><UiTag :value="`${chats.length} 个会话`" severity="secondary" /></header>
          <div class="chat-cards">
            <button v-for="(entry, index) in chatCards" :key="entry.chat.key" type="button" :style="{ animationDelay: `${Math.min(index, 11) * 40}ms` }"
              :class="['chat-card', entry.isPrivate ? 'private' : 'group', { active: selectedChat?.key === entry.chat.key }]" @click="inspectChat(entry.chat)">
              <span class="chat-avatar"><i :class="entry.icon" aria-hidden="true" /></span>
              <b class="chat-name" :title="entry.name">{{ entry.name }}</b>
              <UiTag :value="entry.isPrivate ? '私聊' : '群聊'" :severity="entry.isPrivate ? 'secondary' : 'info'" />
              <small class="chat-handle">{{ entry.handle }}</small>
              <code>{{ entry.chat.key }}</code>
              <small class="chat-stats">
                <span><b>{{ entry.chat.messages ?? 0 }}</b>条消息</span>
                <span><b>{{ Number(entry.chat.tokens ?? 0).toLocaleString() }}</b>token</span>
                <UiTag v-if="entry.chat.scope === 'thread'" :value="`话题 ${entry.chat.threadId}`" severity="secondary" />
              </small>
            </button>
            <p v-if="!chats.length" class="empty-card">还没有任何会话。bot 收到第一条消息后会在这里出现。</p>
          </div>
          <!-- 会话级覆盖：`PATCH /api/chats/:key` 此前只能用 curl 打（docs/21 · G-API-09） -->
          <article v-if="selectedChat" class="surface chat-overrides">
            <header>
              <div><p class="eyebrow">PER-CHAT OVERRIDE</p><h3>只对「{{ selectedChatIdentity?.name }}」生效的设置</h3>
                <p class="section-note">覆盖优先于设置页的全局值，<b>下一轮开始生效</b>。可改的范围是 <code>docs/11 §2.1</code> 的白名单（触发 / 输出 / 上下文窗口 / 主 Agent / 公共记忆写入角色）—— 白名单是安全边界，越界的路径服务端会直接 400。</p></div>
              <UiTag :value="chatOverrideRows.length ? `${chatOverrideRows.length} 项覆盖中` : '全部继承全局'" :severity="chatOverrideRows.length ? 'info' : 'secondary'" />
            </header>
            <div v-if="chatOverrideRows.length" class="override-list">
              <span v-for="row in chatOverrideRows" :key="row.path" class="override-chip">
                <code>{{ row.path }}</code><b>{{ typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value) }}</b>
                <button type="button" aria-label="取消这一项覆盖" title="取消覆盖，回到全局值" @click="dropChatOverride(row.path)"><i class="pi pi-times" /></button>
              </span>
            </div>
            <!-- /model 写的是 app_kv 而不是配置覆盖层，却压过下面的 agent.main.modelAlias：
                 不摆出来的话，「改了模型别名不生效」在界面上完全无迹可寻。 -->
            <p v-if="chatModelAlias" class="callout warn">
              <i class="pi pi-exclamation-triangle" aria-hidden="true" />
              这个会话被 Telegram 的 <code>/model</code> 钉在别名 <b>{{ chatModelAlias }}</b> 上（存在 <code>app_kv</code>，不是配置覆盖层）。它<b>压过</b>下面的 <code>agent.main.modelAlias</code> 与全局值。
              <UiButton size="small" variant="text" severity="danger" label="清除会话别名" @click="clearChatModelAlias" />
            </p>
            <UiButton variant="text" :icon="chatOverrideOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" :label="chatOverrideOpen ? '收起' : '编辑覆盖项'" @click="chatOverrideOpen = !chatOverrideOpen" />
            <!-- 控件里显示的是这个会话实际生效的值（全局 + 覆盖）；改动才会写进覆盖层 -->
            <SchemaForm v-if="chatOverrideOpen && configSchema" ref="chatOverrideForm" :schema="configSchema.schema" :value="chatEffectiveConfig"
              :hot-reloadable="PER_CHAT_ALLOWLIST" :unimplemented="configSchema.unimplemented" :env-pinned="configSchema.envPinned" :include="PER_CHAT_ALLOWLIST" :notes="PER_CHAT_NOTES"
              :saving="chatOverrideSaving" save-label="写入覆盖" @save="saveChatOverrides" />
            <p v-else-if="chatOverrideOpen" class="empty-card"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在加载配置 schema…</p>
          </article>
          <div v-if="selectedChat" class="context-workbench">
            <article class="context-viewer">
              <header>
                <div><p class="eyebrow">MESSAGE WINDOW</p><h3>{{ selectedChatIdentity?.name }}</h3><p class="section-note">按时间倒序，最新的一条在最上面。灰显的条目已被移出窗口：它们还在库里，但下一轮不会发给模型。</p></div>
                <UiTag :value="`窗口内 ${inWindowCount} / ${contextMessages.length}`" severity="info" />
              </header>
              <ol>
                <li v-for="message in orderedContextMessages" :key="String(message.id)" :class="['context-message', { outside: !message.inWindow, degraded: Number(message.pruneApplied) > 0, rebased: messageMeta(message).rebased === true }]">
                  <button type="button" @click="toggleMessage(message.id)">
                    <div class="context-msg-head">
                      <i :class="['caret', 'pi', expandedMessages.has(String(message.id)) ? 'pi-chevron-down' : 'pi-chevron-right']" aria-hidden="true" />
                      <span class="ordinal">#{{ message.ordinal }}</span>
                      <UiTag :value="ROLE_LABELS[String(message.role)] ?? String(message.role)" />
                      <UiTag :value="ORIGIN_LABELS[String(message.origin)] ?? String(message.origin)" severity="secondary" />
                      <UiTag v-if="messageMeta(message).rebased === true" value="REBASED" severity="danger" />
                      <UiTag v-if="!message.inWindow" value="已移出窗口" severity="warn" />
                      <span v-if="message.speaker" class="who">{{ message.speaker }}</span>
                      <small class="context-msg-meta">{{ messageTime(message) }} · {{ message.tokens }} tok · L{{ message.pruneLevel }}</small>
                    </div>
                    <span :class="['context-msg-text', { structured: !message.textPreview }]">{{ message.textPreview || '[图片 / 文件等非文本内容，展开看完整 parts]' }}</span>
                  </button>
                  <pre v-if="expandedMessages.has(String(message.id))" v-text="JSON.stringify(message, null, 2)" />
                  <small v-if="messageMeta(message).unseenOrdinals">未见 ordinal {{ messageMeta(message).unseenOrdinals }}</small>
                </li>
                <li v-if="!contextMessages.length" class="empty">这个会话还没有落过消息。</li>
              </ol>
            </article>
            <article class="commit-timeline">
              <header><div><p class="eyebrow">COMMIT GRAPH</p><h3>提交与 HEAD</h3></div><UiTag v-if="contextHead" :value="`HEAD ${String(contextHead.id).slice(0, 8)}`" severity="secondary" /></header>
              <div class="head-actions">
                <p class="field-title">改这个会话的 HEAD</p>
                <p>两个动作都不删消息，只挪 <code>done</code> 指针：撤回上一次提交等同 Telegram 的 <code>/undo</code>，清空上下文窗口等同 <code>/new</code>。走错了用下面时间线上的「回滚到此」再走回来。</p>
                <div class="row">
                  <UiButton variant="outlined" icon="pi pi-undo" label="撤回上一次提交" :disabled="!canUndoContext" @click="undoContext" />
                  <UiButton variant="outlined" severity="danger" icon="pi pi-refresh" label="清空上下文窗口" @click="resetContext" />
                </div>
              </div>
              <ol>
                <li v-for="commit in commits" :key="String(commit.id)" :class="['commit-node', String(commit.kind)]">
                  <span class="commit-rail" />
                  <div><b>{{ commit.kind }}<UiTag v-if="contextHead && commit.id === contextHead.id" value="当前 HEAD" severity="success" /></b><code>{{ String(commit.id).slice(0, 12) }}</code><small>窗口 {{ commit.windowStart }} → {{ commit.headOrdinal }} · {{ commit.tokensTotal }} tokens</small><small v-if="commit.rebased">Rebased over {{ commit.rebaseOver }}</small><small v-if="commit.meta">{{ commit.meta }}</small></div>
                  <div class="commit-actions"><UiButton size="small" variant="text" label="快照" @click="inspectCommit(commit.id)" /><UiButton size="small" variant="outlined" label="回滚到此" :disabled="Boolean(contextHead && commit.id === contextHead.id)" @click="checkoutCommit(commit.id)" /></div>
                </li>
                <li v-if="!commits.length" class="empty">还没有提交过任何 commit。</li>
              </ol>
              <pre v-if="inspectedSnapshot" class="snapshot-preview" v-text="JSON.stringify(inspectedSnapshot, null, 2)" />
            </article>
          </div>
        </section>
        <section v-else-if="active === 'messages'" key="messages" class="surface page-surface">
          <header><div><p class="eyebrow">ARCHIVE</p><h2>消息与对话</h2><p>默认按 turn 列出最近的模型对话，每页 {{ CONVERSATION_PAGE_SIZE }} 次；搜索走全库归档（中文三字以上 FTS5 trigram，短词回退 LIKE）。</p></div></header>
          <div class="search-row">
            <label class="search grow"><i class="pi pi-search" /><input v-model="query" placeholder="输入关键词搜索中文或英文消息" @keyup.enter="searchArchive"></label>
            <UiButton label="搜索归档" icon="pi pi-search" :loading="searching" @click="searchArchive" />
            <UiButton v-if="searchHits" variant="outlined" label="返回最近对话" icon="pi pi-arrow-left" @click="clearSearch" />
          </div>
          <template v-if="searchHits">
            <div class="registry-heading"><div><h3>归档检索结果</h3><p class="section-note">「{{ searchTerm }}」命中 {{ searchHits.length }} 条（跨会话，最多 50 条）。正文一律纯文本渲染。</p></div></div>
            <DataGrid :rows="searchHits" :columns="COLUMNS.hits" data-key="id" paginate empty="没有命中任何消息">
              <template #tgDate="{ data }">{{ new Date(data.tgDate).toLocaleString() }}</template>
              <template #from="{ data }"><UiTag :value="data.direction === 'out' ? 'bot' : 'user'" :severity="data.direction === 'out' ? 'info' : 'secondary'" /> {{ data.fromName ?? data.fromUsername ?? '—' }}</template>
              <template #text="{ data }"><span class="hit-text">{{ data.text ?? `[${data.kind}]` }}</span><AttachmentStrip :items="data.attachments ?? []" /></template>
              <template #detail="{ data }"><div class="section-actions"><UiButton v-if="data.turnId" size="small" variant="text" icon="pi pi-code" aria-label="查看这条消息所在轮次的实际调用" @click="openDetail(data.turnId)" /><UiButton size="small" variant="text" severity="danger" icon="pi pi-trash" aria-label="软删除这条归档消息" @click="softDeleteMessage(data.id, '这条归档消息')" /></div></template>
            </DataGrid>
          </template>
          <template v-else>
            <ol class="conversation-list">
              <li v-for="turn in conversations" :key="turn.id" :class="['conversation', turn.state]">
                <div class="conversation-body">
                  <button type="button" @click="toggleTurn(turn.id)">
                    <div class="conversation-head">
                      <UiTag :value="turnState(turn.state).label" :severity="turnState(turn.state).severity" />
                      <code>{{ turn.chatId }}</code>
                      <span class="conversation-who">{{ turn.fromName ?? turn.fromUsername ?? turn.userId }}</span>
                      <UiTag v-if="turn.triggerReason" :value="String(turn.triggerReason)" severity="secondary" />
                      <UiTag v-if="turn.rebased" value="REBASED" severity="danger" />
                      <time>{{ turn.startedAt ? new Date(turn.startedAt).toLocaleString() : '—' }}</time>
                    </div>
                    <p class="conversation-prompt"><i class="pi pi-user" aria-hidden="true" /><span>{{ turn.prompt || `[${turn.promptKind ?? '无正文'}]` }}</span></p>
                    <!-- 触发消息带的图片 / 文件：不显示的话「[photo]」这类卡片看不出用户到底发了什么 -->
                    <AttachmentStrip :items="turn.attachments ?? []" />
                    <p class="conversation-reply"><i class="pi pi-sparkles" aria-hidden="true" /><span>{{ turn.reply || (turn.error ? `（失败：${turn.error}）` : '（没有回复落盘）') }}</span></p>
                    <small class="conversation-meta">{{ turn.steps }} 步 · {{ turn.toolCalls }} 次工具 · {{ turn.inputTokens }}/{{ turn.outputTokens }} tok · ${{ Number(turn.costUsd || 0).toFixed(4) }}</small>
                  </button>
                  <div class="conversation-side"><UiButton size="small" variant="outlined" icon="pi pi-code" label="查看详情" @click="openDetail(turn.id)" /><UiButton v-if="turn.promptMessageId" size="small" variant="text" severity="danger" icon="pi pi-trash" aria-label="软删除本轮提问" @click="softDeleteMessage(turn.promptMessageId, '本轮提问')" /></div>
                </div>
                <div v-if="expandedTurns.has(turn.id)" class="conversation-full">
                  <p class="field-title">提问<small>{{ turn.key }}</small></p><pre v-text="turn.prompt ?? ''" />
                  <p class="field-title">回复</p><pre v-text="turn.reply || turn.error || ''" />
                  <UiButton size="small" variant="outlined" icon="pi pi-sitemap" label="查看该轮 trace" @click.stop="active = 'logs'; inspectTrace(turn.id)" />
                </div>
              </li>
              <li v-if="conversationLoading" class="empty"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 加载中…</li>
              <li v-else-if="!conversations.length" class="empty">还没有任何模型对话。bot 收到第一条触发消息后会出现在这里。</li>
            </ol>
            <footer v-if="conversationTotal" class="grid-pager">
              <span>共 {{ conversationTotal }} 次对话 · 第 {{ conversationPage }} / {{ conversationPages }} 页</span>
              <button type="button" aria-label="上一页" :disabled="conversationPage <= 1 || conversationLoading" @click="loadConversations(conversationPage - 1)"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
              <button type="button" aria-label="下一页" :disabled="conversationPage >= conversationPages || conversationLoading" @click="loadConversations(conversationPage + 1)"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
            </footer>
          </template>
        </section>
        <section v-else-if="active === 'tools'" key="tools" class="surface page-surface"><header><div><p class="eyebrow">TOOL POLICY</p><h2>工具与权限</h2><p>单一策略源决定角色、审批和作用域。点任一行查看详情并启停。</p></div><UiTag :value="`${toolRows.filter((row) => row.enabled).length} / ${toolRows.length} 启用`" :severity="toolRows.every((row) => row.enabled) ? 'secondary' : 'warn'" /></header>
          <DataGrid :rows="toolRows" :columns="COLUMNS.tools" data-key="name" paginate :page-size="15" clickable @row-click="editTool">
            <template #name="{ data }"><code>{{ data.name }}</code></template>
            <template #source="{ data }">{{ TOOL_SOURCE_LABEL[data.source] ?? data.source }}</template>
            <template #minRole="{ data }"><UiTag :value="data.minRole" :severity="roleSeverity(data.minRole)" /></template>
            <template #approval="{ data }">{{ APPROVAL_LABEL[data.approval] ?? data.approval }}</template>
            <template #scope="{ data }">{{ SCOPE_LABEL[data.scope] ?? data.scope }}</template>
            <template #enabled="{ data }"><UiTag :value="data.enabled ? '启用' : '已停用'" :severity="data.enabled ? 'success' : 'danger'" /></template>
          </DataGrid>
          <div class="registry-heading">
            <div><h3>审批规则试跑</h3><p class="section-note">拿一条样例输入过一遍<b>运行时那份</b> <code>ApprovalRules</code>：哪几条命中、为什么没命中、最终风险档位。规则本身在「全部配置」的 <code>approval.rules</code> 里编辑 —— 在这里再实现一遍匹配必然与运行时漂移，而「以为配了审批其实永不命中」正是这条配置最容易出的错。</p></div>
            <UiButton size="small" variant="outlined" icon="pi pi-play" label="试跑" :loading="ruleTesting" :disabled="!ruleTestTool" @click="testApprovalRule" />
          </div>
          <div class="form-grid">
            <label>工具名<UiSelect v-model="ruleTestTool" :options="Object.keys(tools).map((name) => ({ value: name, label: name }))" filter aria-label="工具名" /></label>
            <label>样例输入（JSON）<textarea v-model="ruleTestInput" rows="3" spellcheck="false" placeholder='{"command":"rm -rf /"}' /><small class="field-note">规则里的 <code>pattern</code> 匹配的是这份输入的 JSON 序列化结果，所以键名也在匹配范围内。</small></label>
          </div>
          <div v-if="ruleTestResult" class="rule-test-result">
            <p :class="['callout', ruleTestResult.needed ? 'warn' : '']">
              <i :class="ruleTestResult.needed ? 'pi pi-shield' : 'pi pi-check-circle'" />
              {{ ruleTestResult.needed ? `需要审批 · 风险 ${ruleTestResult.risk}` : '不需要审批（没有规则命中）' }}
              <span v-if="ruleTestResult.runtimeDependent">。其中有规则用了 <code>when: target_exists</code>，最终是否需要审批取决于运行时「目标是否存在」——试跑给不出这个答案。</span>
            </p>
            <ol class="rule-report"><li v-for="entry in ruleTestResult.rules" :key="entry.index" :class="{ matched: entry.matched }"><UiTag :value="entry.matched ? '命中' : '未命中'" :severity="entry.matched ? 'warn' : 'secondary'" /><code>#{{ entry.index }}</code><span>{{ entry.reason }}</span></li></ol>
            <p v-if="!ruleTestResult.rules.length" class="empty">还没有配置任何审批规则。</p>
          </div>
          <div class="registry-heading">
            <div><h3>沙箱</h3><p class="section-note">决定 <code>exec</code> 类工具跑在哪儿。<code>bypassRoles</code> 里的角色<b>完全绕过</b>沙箱，直接在宿主上执行 —— 这是整套权限模型里最锋利的一格。保存后热更新，下一次工具调用即生效。</p></div>
            <div class="section-actions">
              <UiButton size="small" variant="outlined" icon="pi pi-bolt" label="探测可用性" :loading="sandboxProbing" @click="probeSandbox" />
              <UiButton size="small" variant="outlined" icon="pi pi-cloud-download" label="拉取镜像" :loading="pullingImage" :disabled="sandboxForm.mode !== 'docker'" @click="pullSandboxImage" />
              <UiButton size="small" icon="pi pi-save" label="保存沙箱" :loading="sandboxSaving" :disabled="!sandboxDirty" @click="saveSandbox" />
            </div>
          </div>
          <div v-if="sandboxForm.mode === 'none'" class="danger-banner"><i class="pi pi-exclamation-triangle" /><code>mode = none</code>：exec 类工具不做任何隔离，以 bot 进程的权限直接在宿主上执行模型给出的命令。</div>
          <div v-if="sandbox?.plan && !sandbox.plan.allowed" class="danger-banner"><i class="pi pi-exclamation-triangle" />当前配置下沙箱对 owner 都不可用：{{ sandbox.plan.reason ?? '未知原因' }} —— 需要沙箱的工具会直接失败。</div>
          <p v-if="sandboxProbe" :class="['callout', sandboxProbe.available ? '' : 'warn']"><i :class="sandboxProbe.available ? 'pi pi-check-circle' : 'pi pi-times-circle'" />探测结果（打的是<b>已保存</b>的那份配置）：{{ sandboxProbe.available ? `可用 · ${sandboxProbe.mode ?? sandboxForm.mode}` : sandboxProbe.error ?? '不可用' }}</p>
          <div class="form-grid">
            <label>模式<UiSelect v-model="sandboxForm.mode" :options="SANDBOX_MODES" @change="markSandboxDirty" /><small class="field-note">docker 之外的两档不读下面的镜像与资源限制。</small></label>
            <label>容器网络<UiSelect v-model="sandboxForm.network" :options="[{ value: 'none', label: 'none · 断网' }, { value: 'bridge', label: 'bridge · 可出网' }]" :disabled="sandboxForm.mode !== 'docker'" @change="markSandboxDirty" /><small class="field-note">改成 bridge 等于允许模型生成的代码访问网络与内网。</small></label>
            <label>镜像<input v-model="sandboxForm.image" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"></label>
            <label>docker 可执行文件<input v-model="sandboxForm.dockerBin" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"></label>
            <label>工作目录<input v-model="sandboxForm.workspaceDir" @input="markSandboxDirty"><small class="field-note">本进程看到的路径，文件工具也用它。</small></label>
            <label>宿主工作目录<input v-model="sandboxForm.hostWorkspaceDir" placeholder="非容器部署留空" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"><small class="field-note">bot 自己跑在容器里时必填：<code>-v</code> 用的是<b>宿主</b>路径，留空会挂到一个不存在的目录上，沙箱与文件工具从此看到两个世界。</small></label>
            <label>内存上限（MB）<UiNumber :model-value="sandboxForm.memoryMb" :min="16" :step="64" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.memoryMb = $event; markSandboxDirty()" /></label>
            <label>CPU 核数<UiNumber :model-value="sandboxForm.cpus" :min="0.1" :step="0.5" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.cpus = $event; markSandboxDirty()" /></label>
            <label>进程数上限<UiNumber :model-value="sandboxForm.pidsLimit" :min="1" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.pidsLimit = $event; markSandboxDirty()" /></label>
            <label>tmpfs（MB）<UiNumber :model-value="sandboxForm.tmpfsMb" :min="1" :step="16" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.tmpfsMb = $event; markSandboxDirty()" /></label>
            <UiSwitch v-model="sandboxForm.readOnlyRoot" class="wide" label="根文件系统只读（只有工作目录与 tmpfs 可写）" :disabled="sandboxForm.mode !== 'docker'" @change="markSandboxDirty" />
            <div class="wide">
              <p class="field-title">绕过沙箱的角色<small>勾中的角色，exec 类工具直接在宿主上跑。</small></p>
              <div class="trigger-switches">
                <UiCheckbox v-for="role in ROLES" :key="role" :model-value="sandboxForm.bypassRoles.includes(role)" :label="role" @change="toggleBypassRole(role)" />
              </div>
              <p v-if="sandboxForm.bypassRoles.some((role) => role !== 'owner')" class="field-note wake-issue"><i class="pi pi-exclamation-triangle" />owner 之外的角色也在绕过名单里：这些人能让模型在宿主上执行任意命令。</p>
            </div>
          </div>
        </section>
        <section v-else-if="active === 'extensions'" key="extensions" class="surface page-surface">
          <header><div><p class="eyebrow">EXTENSIONS</p><h2>Skills / Plugins / MCP</h2><p>Skill 渐进式披露；Plugin 在 bot 进程里<b>全信任</b>运行，没有沙箱；MCP 工具动态发现。保存后即时重扫或重连。</p></div><div class="section-actions"><UiButton variant="outlined" label="新建 Skill" icon="pi pi-plus" @click="editSkill()" /><UiButton label="新建 MCP" icon="pi pi-plus" @click="editMcp()" /><UiTag :value="`${extensionRows.filter((row) => row.enabled !== 0).length} / ${extensionRows.length} 启用`" :severity="extensionRows.some((row) => extensionError(row)) ? 'danger' : 'secondary'" /></div></header>
          <p v-if="mcpMasterOff" class="callout warn"><i class="pi pi-power-off" />MCP 总开关 <code>mcp.enabled</code> 是关的（出厂默认）：下面的 MCP server 存得下也能编辑，但一个都不会连接，工具目录里也不会出现它们的工具。<UiButton size="small" variant="outlined" label="打开总开关" @click="enableMcpMaster" /></p>
          <div class="provider-grid">
            <article v-for="item in extensionRows" :key="`${item.kind}:${item.name}`">
              <div class="provider-head">
                <div class="provider-tags">
                  <UiTag :value="EXTENSION_META[item.kind].label" severity="secondary" />
                  <UiTag :value="extensionStatus(item).label" :severity="extensionStatus(item).severity" />
                </div>
                <div class="card-actions">
                  <UiButton variant="text" size="small" :icon="item.enabled === 0 ? 'pi pi-play' : 'pi pi-pause'" :aria-label="item.enabled === 0 ? '启用' : '停用'" :loading="extensionBusy === `${item.kind}:${item.name}`" @click="toggleExtension(item)" />
                  <UiButton v-if="item.kind !== 'skill'" variant="text" size="small" icon="pi pi-refresh" :aria-label="item.kind === 'mcp' ? '重连' : '重载'" :loading="extensionBusy === `${item.kind}:${item.name}`" @click="reloadExtension(item)" />
                  <UiButton v-if="item.kind === 'skill'" variant="text" size="small" icon="pi pi-pencil" aria-label="编辑 Skill" @click="editSkill(item)" />
                  <UiButton v-if="item.kind === 'mcp'" variant="text" size="small" icon="pi pi-pencil" aria-label="编辑 MCP" @click="editMcp(item)" />
                  <UiButton v-if="item.kind === 'skill'" variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="删除 Skill" @click="removeSkill(item.name)" />
                  <UiButton v-if="item.kind === 'mcp'" variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="删除 MCP" @click="removeMcp(item.name)" />
                </div>
              </div>
              <h3><i :class="EXTENSION_META[item.kind].icon" aria-hidden="true" /> {{ item.name }}</h3>
              <p>{{ extensionSubtitle(item) }}</p>
              <code v-if="extensionError(item)">{{ extensionError(item) }}</code>
              <div v-if="item.kind === 'mcp' && item.tools?.length" class="cap-tags"><UiTag v-for="entry in item.tools" :key="String(entry.name)" :value="String(entry.name)" severity="info" /></div>
            </article>
            <article v-if="!extensionRows.length" class="empty-card"><i class="pi pi-box" /><h3>暂无扩展</h3><p>把 Skill、Plugin 或 MCP server 加入配置后重载。</p></article>
          </div>
          <p class="field-note"><i class="pi pi-info-circle" />Skill 的正文与 frontmatter 直接写回 <code>SKILL.md</code>；删除会连附属文件一起永久移除。MCP 的 transport、启停与工具过滤保存到 <code>mcp.servers</code>，随后热重连并刷新工具注册表。</p>
        </section>
        <section v-else-if="active === 'agents'" key="agents" class="surface page-surface"><header><div><p class="eyebrow">AGENT TOPOLOGY</p><h2>子 Agent</h2><p>独立上下文、权限不高于父 Agent，结果全文独立落盘。点任一行编辑，保存即热更新。</p></div><UiButton label="新建 Agent" icon="pi pi-plus" @click="editAgent()" /></header>
          <DataGrid :rows="agents" :columns="COLUMNS.agents" data-key="name" clickable empty="没有配置子 Agent。模型只有在这里配了 agent 才能用 spawn_agent 派发。" @row-click="editAgent">
            <template #name="{ data }"><code>{{ data.name }}</code></template>
            <template #minRole="{ data }"><UiTag :value="data.minRole" :severity="roleSeverity(data.minRole)" /></template>
            <template #modelAlias="{ data }"><code>{{ data.modelAlias }}</code></template>
            <template #tools="{ data }"><span v-if="data.tools.length" class="agent-tools">{{ data.tools.join(' · ') }}</span><small v-else class="alias-empty">未限定，继承父 agent 的可用工具</small></template>
            <template #actions="{ data }"><UiButton size="small" variant="outlined" icon="pi pi-play" label="试跑" @click.stop="openAgentDryRun(data)" /></template>
          </DataGrid>
        </section>
        <section v-else-if="active === 'usage'" key="usage" class="surface page-surface"><header><div><p class="eyebrow">USAGE LEDGER</p><h2>用量与成本</h2><p>输入、输出、缓存读写分别计价。</p></div>
            <div class="section-actions">
              <UiSelect v-model="usageRange" :options="USAGE_RANGES" option-label="label" option-value="value" aria-label="时间范围" @change="loadUsageReport" />
              <UiSelect v-model="usageGroupBy" :options="USAGE_DIMENSIONS" option-label="label" option-value="value" aria-label="维度" @change="loadUsageReport" />
            </div></header>
          <!-- 聚合走 `GET /api/usage/report`，六个维度都是服务端 SQL 算的。此前这一页只有下面那张
               不分维度的明细表 —— 「这个月钱花在哪个群」得靠人肉翻 1000 行（docs/09 §3.11）。 -->
          <div class="usage-charts">
            <article class="surface inner"><header><div><h3>花费</h3><p class="section-note">{{ usageDimensionLabel }} · 单位 USD</p></div><UiTag :value="`合计 $${usageTotals.cost.toFixed(2)}`" severity="secondary" /></header>
              <UiLineChart v-if="usageGroupBy === 'day' && usageReport.length" :labels="usageReport.map((row) => String(row.bucket).slice(5))"
                :series="[{ name: '花费 (USD)', values: usageReport.map((row) => row.costUsd) }]" :format="(value) => `$${value.toFixed(2)}`" />
              <UiBarChart v-else :rows="usageReport.map((row) => ({ label: row.label ?? String(row.bucket ?? '—'), value: row.costUsd }))" :format="(value) => `$${value.toFixed(4)}`" />
            </article>
            <article class="surface inner"><header><div><h3>token</h3><p class="section-note">输入 / 输出</p></div><UiTag :value="`${usageTotals.calls} 次调用 · 成功率 ${usageTotals.successRate}`" severity="secondary" /></header>
              <UiLineChart v-if="usageGroupBy === 'day' && usageReport.length" :labels="usageReport.map((row) => String(row.bucket).slice(5))"
                :series="[{ name: '输入', values: usageReport.map((row) => row.inputTokens) }, { name: '输出', values: usageReport.map((row) => row.outputTokens) }]" />
              <UiBarChart v-else :rows="usageReport.map((row) => ({ label: row.label ?? String(row.bucket ?? '—'), value: row.inputTokens + row.outputTokens }))" />
            </article>
          </div>
          <h3 class="usage-detail-title">明细</h3>
          <DataGrid :rows="usage" :columns="COLUMNS.usage" data-key="id" paginate empty="还没有产生用量">
            <template #ts="{ data }">{{ new Date(data.ts).toLocaleString() }}</template>
            <template #cost_usd="{ data }">${{ Number(data.cost_usd).toFixed(4) }}</template>
          </DataGrid>
        </section>

        <section v-else-if="active === 'quota'" key="quota" class="surface page-surface">
          <header><div><p class="eyebrow">SPEND LIMITS</p><h2>配额</h2><p>限额是配置项（热更新，下一条消息即生效）；计数器是 <code>quota_counters</code> 里的实时值。开轮次时先按估算预留，结束后按实际花费结算。</p></div><UiTag :value="quotaForm.enabled ? '配额生效中' : '配额已关闭'" :severity="quotaForm.enabled ? 'success' : 'danger'" /></header>
          <div v-if="!quotaForm.enabled" class="danger-banner"><i class="pi pi-exclamation-triangle" /><code>quota.enabled</code> 已关闭：所有金额限额都不再判定，任何人都能一直发起对话把钱花完。频率限制（下面那组）不受这个开关影响，仍然生效。</div>
          <div v-if="quota && quota.unpricedTotal" class="danger-banner"><i class="pi pi-exclamation-triangle" />有 <b>{{ quota.unpricedTotal }}</b> 个启用中的模型没有定价，走它们的轮次<b>花费按 0 记账</b>，限额配得再准也拦不住 —— <code>{{ quota.unpriced.map((entry) => entry.modelId).join('、') }}</code><UiButton size="small" variant="text" label="去补定价" @click="active = 'providers'" /></div>

          <div class="registry-heading">
            <div><h3>限额</h3><p class="section-note">金额留空 = 不限。三层同时判定，任一层超了就拒：全局 → 会话 → 用户。预留在轮次结束后按实际花费结算，进程被 kill 时残留的预留量由启动清理归零。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存配额" :loading="quotaSaving" :disabled="!quotaDirty" @click="saveQuota" />
          </div>
          <div class="form-grid">
            <div class="trigger-switches">
              <UiSwitch v-model="quotaForm.enabled" label="启用金额配额" @change="markQuotaDirty" />
              <UiSwitch v-model="quotaForm.requirePricing" label="模型缺定价时拒绝开轮次" @change="markQuotaDirty" />
            </div>
            <label>最小预留（美元）<UiNumber :model-value="quotaForm.minReserveUsd" :min="0" :step="0.01" @update:model-value="quotaForm.minReserveUsd = $event; markQuotaDirty()" /><small class="field-note">开轮次时至少占住这么多额度。估算值比它低时按它算，免得一堆小轮次并发挤穿限额。</small></label>
            <p class="field-note wide"><code>requirePricing</code> 对 owner 不生效：owner 的轮次即便模型没定价也照常开，只是那一轮记 0 美元。</p>
            <p class="field-title wide">按范围的金额上限<small>bucket 按 <code>{{ quota?.timezone ?? 'general.timezone' }}</code> 切换：日 = 当地自然日，月 = 当地自然月。</small></p>
            <label>全局 · 每日<UiNumber :model-value="quotaForm.globalDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.globalDaily = $event; markQuotaDirty()" /></label>
            <label>全局 · 每月<UiNumber :model-value="quotaForm.globalMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.globalMonthly = $event; markQuotaDirty()" /></label>
            <label>单会话 · 每日<UiNumber :model-value="quotaForm.chatDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.chatDaily = $event; markQuotaDirty()" /></label>
            <label>单会话 · 每月<UiNumber :model-value="quotaForm.chatMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.chatMonthly = $event; markQuotaDirty()" /></label>
            <label>单用户 · 每日<UiNumber :model-value="quotaForm.userDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.userDaily = $event; markQuotaDirty()" /></label>
            <label>单用户 · 每月<UiNumber :model-value="quotaForm.userMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.userMonthly = $event; markQuotaDirty()" /></label>
            <p class="field-note wide">推荐 <code>单用户 ≤ 单会话 ≤ 全局</code>（[11 §约束]）。反过来配不会被拒，只是内层那道闸永远先撞上。</p>
            <p class="field-title wide">按角色覆盖单用户额度<small>留空 = 用上面那组单用户的值。</small></p>
            <div class="wide quota-roles">
              <div v-for="role in ROLES" :key="role" class="quota-role">
                <UiTag :value="role" :severity="roleSeverity(role)" />
                <label>每日<UiNumber :model-value="quotaForm.byRole[role].daily" :min="0" :step="0.5" placeholder="继承" @update:model-value="quotaForm.byRole[role].daily = $event; markQuotaDirty()" /></label>
                <label>每月<UiNumber :model-value="quotaForm.byRole[role].monthly" :min="0" :step="5" placeholder="继承" @update:model-value="quotaForm.byRole[role].monthly = $event; markQuotaDirty()" /></label>
              </div>
            </div>
            <p class="field-note wide"><i class="pi pi-info-circle" />覆盖只能填<b>具体金额</b>，填不出「这个角色不限」：运行时取的是 <code>byRole[role].daily ?? perUser.daily</code>，<code>null</code> 同样回落到上面那格。要让某个角色不限，得把单用户那格也清空。判定用的是<b>有效角色</b>（min(用户角色, 会话角色)），所以同一个人在不同群里可能落到不同档。</p>
            <p class="field-title wide">单轮上限<small>一轮之内的硬闸，与上面按天/按月的额度是两回事。</small></p>
            <label>单轮成本上限（美元）<UiNumber :model-value="quotaForm.maxCostUsd" :min="0.001" :step="0.1" @update:model-value="quotaForm.maxCostUsd = $event; markQuotaDirty()" /><small class="field-note">撞上之后不是直接掐断，而是把工具目录清空、强制模型收尾输出 —— 半截答复比没有答复好。子 agent 的花费一并计入。</small></label>
            <label>单轮步数上限<UiNumber :model-value="quotaForm.maxSteps" :min="1" :max="200" @update:model-value="quotaForm.maxSteps = $event; markQuotaDirty()" /><small class="field-note">与 <code>agent.main.maxSteps</code> 取较小者生效。</small></label>
            <p class="field-title wide">频率限制<small>按最近 1 小时的 turns 表统计，<b>不受上面的「启用金额配额」开关影响</b>。</small></p>
            <label>每人每小时轮次<UiNumber :model-value="quotaForm.turnsPerUserPerHour" :min="1" @update:model-value="quotaForm.turnsPerUserPerHour = $event; markQuotaDirty()" /></label>
            <label>每会话每小时轮次<UiNumber :model-value="quotaForm.turnsPerChatPerHour" :min="1" @update:model-value="quotaForm.turnsPerChatPerHour = $event; markQuotaDirty()" /></label>
            <label>单用户并发轮次<UiNumber :model-value="quotaForm.concurrentPerUser" :min="1" @update:model-value="quotaForm.concurrentPerUser = $event; markQuotaDirty()" /></label>
            <p class="field-title wide">超限时</p>
            <UiSwitch v-model="quotaForm.reply" class="wide" @change="markQuotaDirty">在群里回一条说明<small class="field-note">关掉的话被拒的人什么都收不到，只有日志里有一条 <code>quota.exceeded</code>。</small></UiSwitch>
            <label class="wide">提示文案<textarea v-model="quotaForm.message" rows="2" spellcheck="false" @input="markQuotaDirty" /><small class="field-note"><i class="pi pi-exclamation-triangle" /><code>{spent}</code> / <code>{limit}</code> 会被替换成 <code>—</code>，<code>{resetAt}</code> 被替换成「下个额度窗口」—— 占位符目前拿不到真实数字，别把话写成「已用 {spent}」那样依赖它们。</small></label>
            <div v-if="quota?.unimplemented.length" class="wide quota-unimplemented">
              <p class="field-title"><i class="pi pi-ban" />下面这些配额项在 schema 里有，但<b>运行时没有任何代码读它们</b>，所以这里不给控件</p>
              <ul><li v-for="key in quota.unimplemented" :key="key"><code>{{ key }}</code><span>{{ QUOTA_UNIMPLEMENTED_HINTS[key] ?? '未接线' }}</span></li></ul>
            </div>
          </div>

          <div class="registry-heading">
            <div><h3>当前计数器</h3><p class="section-note">当前 bucket：日 <code>{{ quota?.buckets.day ?? '—' }}</code> · 月 <code>{{ quota?.buckets.month ?? '—' }}</code>。<b>已用</b>是已结算花费 + 在途预留，判定用的就是这个和。</p></div>
            <div class="section-actions">
              <UiCheckbox v-if="staleCounters" v-model="quotaShowHistory" :label="`连历史 bucket 一起看（${staleCounters} 行）`" />
              <UiButton size="small" variant="outlined" icon="pi pi-refresh" aria-label="刷新计数器" :loading="quotaLoading" @click="loadQuota" />
              <UiButton size="small" variant="outlined" severity="danger" icon="pi pi-trash" label="全部清零" :loading="quotaResetting === 'all'" :disabled="!quota?.counters.length" @click="resetQuota()" />
            </div>
          </div>
          <div class="quota-counters">
            <article v-for="row in visibleCounters" :key="counterKey(row)" :class="['quota-counter', { over: row.limit !== null && counterRatio(row) >= 1, stale: !row.current }]">
              <div class="quota-counter-head">
                <UiTag :value="QUOTA_SCOPE_LABELS[row.scope]" :severity="row.scope === 'global' ? 'info' : row.scope === 'chat' ? 'secondary' : 'primary'" />
                <b>{{ counterTitle(row) }}</b>
                <UiTag v-if="row.role" :value="row.role" :severity="roleSeverity(row.role)" />
                <UiTag v-if="!row.current" value="历史窗口" severity="secondary" title="这一行不属于当前 bucket，不参与判定，留着只是账" />
                <code>{{ row.window === 'day' ? '日' : '月' }} {{ row.bucket }}</code>
                <UiButton variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="重置这一行" :loading="quotaResetting === counterKey(row)" @click="resetQuota(row)" />
              </div>
              <div class="quota-meter"><span :style="{ width: `${counterRatio(row) * 100}%` }" /></div>
              <div class="quota-counter-foot">
                <span>已用 <b>{{ money(spent(row)) }}</b> / {{ row.limit === null ? '不限' : `${row.limitApprox ? '≈' : ''}${money(row.limit)}` }}</span>
                <small v-if="row.reservedUsd > 0">其中在途预留 {{ money(row.reservedUsd) }}</small>
                <small>{{ row.turns }} 轮 · {{ new Date(row.updatedAt).toLocaleString() }}</small>
              </div>
              <small v-if="row.limitApprox" class="field-note">这一档取自该用户自己的角色；实际判定用有效角色（min(用户, 会话)），在低权限会话里上限可能更低。</small>
            </article>
            <article v-if="!visibleCounters.length" class="empty-card"><i class="pi pi-gauge" /><h3>{{ quota?.counters.length ? '当前窗口还没有产生花费' : '还没有任何计数' }}</h3><p>{{ quota?.counters.length ? `有 ${staleCounters} 行属于历史 bucket，勾上上面那个开关可以看到。` : '有轮次跑起来之后，这里按 全局 / 会话 / 用户 × 日 / 月 六个维度记账。' }}</p></article>
          </div>
        </section>
        <section v-else-if="active === 'principals'" key="principals" class="surface page-surface"><header><div><p class="eyebrow">ACCESS CONTROL</p><h2>主体与权限</h2><p>effectiveRole 始终取用户与会话角色的较低者。点任一行改角色。</p></div><UiButton label="批量导入" icon="pi pi-upload" @click="openBulk" /></header>
          <nav class="subtabs" aria-label="主体类型">
            <button v-for="[key, label] in PRINCIPAL_KINDS" :key="key" type="button" :class="{ active: principalKind === key }" @click="principalKind = key">{{ label }}<span>{{ principalCount(key) }}</span></button>
          </nav>
          <div v-if="principalSelection.length" class="bulk-bar">
            <i class="pi pi-check-square" aria-hidden="true" /><span>已勾选 <b>{{ principalSelection.length }}</b> 个主体</span>
            <UiButton size="small" variant="text" label="清空勾选" @click="principalSelection = []" />
            <UiButton size="small" icon="pi pi-user-edit" label="批量改角色" @click="openRoleBulk" />
          </div>
          <DataGrid v-model:selection="principalSelection" :rows="visiblePrincipals" :columns="COLUMNS.principals" data-key="id" paginate :page-size="12" clickable :empty="principalKind === 'chat' ? '还没有见过任何群聊' : principalKind === 'user' ? '还没有见过任何用户' : '还没有任何主体'" @row-click="editPrincipal">
            <template #kind="{ data }"><UiTag :value="data.kind === 'chat' ? '群聊' : '用户'" :severity="data.kind === 'chat' ? 'info' : 'secondary'" /></template>
            <template #displayName="{ data }"><span class="alias-name">{{ data.displayName ?? '—' }}<UiTag v-if="data.id === ownerPrincipalId" value="引导 OWNER" severity="success" title="access.bootstrapOwnerId 指向的这一行；改掉它的角色，Telegram 那边就没人能管 bot 了" /></span></template>
            <template #username="{ data }">{{ data.username ? `@${data.username}` : '—' }}</template>
            <template #role="{ data }"><UiTag :value="data.role" :severity="roleSeverity(data.role)" /></template>
          </DataGrid>
        </section>
        <section v-else-if="active === 'providers'" key="providers" class="surface page-surface">
          <header><div><p class="eyebrow">MODEL REGISTRY</p><h2>Provider、模型与别名</h2><p>写入后服务端重建运行时 registry；API Key 只显示 hint。</p></div><UiButton label="添加 Provider" icon="pi pi-plus" @click="editProvider()" /></header>
          <div v-if="modelMissingMain" class="danger-banner"><i class="pi pi-exclamation-triangle" />没有可用的 <code>main</code> 别名（未配置、链为空或链里的模型都不可用），所有轮次都会失败。见下方「别名路由」。</div>
          <div class="provider-grid"><article v-for="provider in providers" :key="provider.id"><div class="provider-head"><div class="provider-tags"><UiTag :value="provider.enabled ? '启用' : '停用'" :severity="provider.enabled ? 'success' : 'secondary'" /><UiTag v-if="provider.healthState" :value="provider.healthState === 'up' ? '连通' : '不可用'" :severity="provider.healthState === 'up' ? 'success' : 'danger'" /></div><div class="card-actions"><UiButton variant="text" size="small" icon="pi pi-bolt" aria-label="测试连接" :loading="testingProvider === provider.id" @click="testProvider(provider)" /><UiButton variant="text" size="small" icon="pi pi-cloud-download" aria-label="从该 Provider 拉取模型" @click="openCatalog(provider.id)" /><UiButton variant="text" size="small" icon="pi pi-pencil" aria-label="编辑 Provider" @click="editProvider(provider)" /><UiButton variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="删除 Provider" @click="removeProvider(provider.id)" /></div></div><h3>{{ provider.name }}</h3><p>{{ provider.kind }}</p><code>{{ provider.apiKeyHint ?? '未设置密钥' }}</code><small v-if="provider.healthError" class="provider-error">{{ provider.healthError }}</small></article></div>
          <div class="registry-heading"><div><h3>模型</h3><p class="section-note">窗口、最大输出、能力与定价来自 models.dev 的本地缓存目录，导入时自动带入；<code>补齐元数据</code>只填空着的价格，已填的不会被覆盖。</p></div><div class="section-actions"><UiButton size="small" variant="outlined" icon="pi pi-cloud-download" label="从 Provider 拉取" :disabled="!providers.length" @click="openCatalog()" /><UiButton size="small" variant="outlined" icon="pi pi-sparkles" label="补齐元数据" :disabled="!models.length" :loading="enriching" @click="enrichModels" /><UiButton size="small" variant="outlined" label="添加模型" @click="editModel()" /></div></div>
          <DataGrid :rows="models" :columns="COLUMNS.models" data-key="id" clickable empty="还没有导入任何模型" @row-click="editModel">
            <template #provider_id="{ data }">{{ providerLabel(String(data.provider_id)) }}</template>
            <template #capabilities="{ data }"><span v-if="capabilityTags(storedMeta(data)).length" class="cap-tags"><UiTag v-for="tag in capabilityTags(storedMeta(data))" :key="tag" :value="tag" severity="secondary" /></span><small v-else class="catalog-sub">未知</small></template>
            <template #price_in="{ data }"><span>{{ data.price_in ?? '—' }}</span><small v-if="storedPriceSource(data)" class="catalog-sub">{{ storedPriceSource(data) === 'manual' ? '手工填写' : MATCH_LABELS[String(storedPriceSource(data))]?.label ?? '' }}</small><small v-else-if="data.price_in === null" class="catalog-sub match-third-party">缺定价 · 花费按 0 记账</small></template>
            <template #enabled="{ data }"><UiTag :value="data.enabled ? '启用' : '停用'" :severity="data.enabled ? 'success' : 'secondary'" /></template>
          </DataGrid>
          <div class="registry-heading"><div><h3>别名路由</h3><p class="section-note">代码里只出现别名，不出现具体模型 id。每个别名指向一条有序的 fallback 链：前一个模型不可用就顺延到下一个。下面六个是内建别名，<code>main</code> 必须配。</p></div><UiButton size="small" variant="outlined" label="添加自定义别名" @click="editAlias()" /></div>
          <DataGrid :rows="aliasRows" :columns="COLUMNS.aliases" data-key="alias">
            <template #alias="{ data }"><div class="alias-name"><code>{{ data.alias }}</code><UiTag v-if="data.state !== 'ok'" :value="ALIAS_STATE_TAG[data.state].label" :severity="ALIAS_STATE_TAG[data.state].severity" :title="ALIAS_STATE_TAG[data.state].hint" /><UiTag v-if="!data.validName" value="名称不合法" severity="warn" title="别名只能是小写字母开头的 [a-z0-9_-]；这一行只能删掉重建" /></div></template>
            <template #purpose="{ data }"><p class="alias-purpose">{{ data.purpose }}</p><small v-if="data.tier">建议档位：{{ data.tier }}</small><small v-if="data.description">{{ data.description }}</small></template>
            <template #chain="{ data }"><div v-if="data.chain.length" class="alias-chain"><span v-for="(segment, index) in data.chain" :key="segment.id" :class="['alias-seg', segment.state]" :title="segment.state === 'missing' ? '模型记录已删除' : segment.state === 'disabled' ? '模型已停用，会被跳过' : ''">{{ index + 1 }}. {{ segment.label }}</span></div><small v-else class="alias-empty">{{ data.alias === 'main' ? '没有可用模型时所有轮次都会失败' : '缺失时按 main → high → low 回退' }}</small></template>
            <template #settings="{ data }"><small class="alias-settings">{{ settingsSummary(data.settings) }}</small></template>
            <template #actions="{ data }"><div class="card-actions"><UiButton variant="text" size="small" :icon="data.state === 'absent' ? 'pi pi-plus' : 'pi pi-pencil'" :aria-label="data.state === 'absent' ? '配置别名' : '编辑别名'" @click="editAlias(data)" /><UiButton v-if="data.state !== 'absent'" variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="删除别名" @click="removeAlias(data.alias)" /></div></template>
          </DataGrid>
        </section>
        <section v-else-if="active === 'logs'" key="logs" class="surface page-surface"><header><div><p class="eyebrow">OBSERVABILITY</p><h2>日志与 Trace</h2><p>点击任一 trace 节点，重建完整调用树并查看 payload。</p></div><UiTag :value="connected ? '实时' : '重连中'" :severity="connected ? 'success' : 'warn'" /></header>
          <DataGrid :rows="logs" :columns="COLUMNS.logs" data-key="id" paginate clickable empty="暂无日志" @row-click="inspectTrace($event.trace_id)">
            <template #ts="{ data }">{{ new Date(data.ts).toLocaleString() }}</template>
            <template #level="{ data }"><span :class="['level', data.level]">{{ data.level }}</span></template>
          </DataGrid>
          <article v-if="traceDetail.length" class="inspector"><header><b>Trace {{ traceDetail[0]?.trace_id }}</b><UiTag :value="`${traceDetail.length} spans`" /></header><ol><li v-for="node in traceDetail" :key="node.id" :style="{ marginLeft: node.parentSpanId ? '24px' : '0' }"><code>{{ node.kind }}</code><span>{{ node.summary }}</span><small>{{ node.durationMs ?? 0 }} ms</small></li></ol></article>
        </section>
        <section v-else-if="active === 'prompts'" key="prompts" class="surface page-surface"><header><div><p class="eyebrow">PROMPT WORKSPACE</p><h2>提示词编辑与版本</h2><p>每次保存落盘 unified diff；预览与真实轮次共用同一条 PromptAssembler 路径。</p></div><UiButton label="预览组装" icon="pi pi-eye" @click="openPromptPreview" /></header>
          <div class="prompt-workbench">
            <div class="prompt-cards">
              <button v-for="doc in promptCards" :key="String(doc.id)" type="button" :class="['prompt-card', { active: String(selectedPrompt?.id ?? '') === String(doc.id) }]" @click="inspectPrompt(doc)">
                <span class="prompt-icon"><i :class="promptMeta(doc.scope).icon" aria-hidden="true" /></span>
                <b>{{ promptMeta(doc.scope).label }}</b>
                <UiTag :value="doc.subject ? String(doc.subject) : '全局'" :severity="promptMeta(doc.scope).severity" />
                <p>{{ promptMeta(doc.scope).purpose }}</p>
                <code>{{ doc.id }}</code>
                <small>{{ Number(doc.bytes ?? 0).toLocaleString() }} 字节 · {{ Number(doc.tokens ?? 0).toLocaleString() }} tok · {{ doc.updated_at ? new Date(Number(doc.updated_at)).toLocaleString() : '未落盘' }}</small>
              </button>
              <p v-if="!promptCards.length" class="empty">没有可编辑的提示词文档。首次启动会从 <code>memory/</code> 目录扫出 CHARACTER / ASSIST / PUBMEMORY。</p>
            </div>
            <article v-if="selectedPrompt" class="editor-panel">
              <header><div><b>{{ selectedPrompt.id }}</b><small>{{ promptMeta(selectedPrompt.scope).label }} · {{ selectedPrompt.path }}</small></div><UiButton label="保存版本" icon="pi pi-save" @click="savePrompt" /></header>
              <p v-if="selectedPrompt.scope === 'primemory'" class="callout warn"><i class="pi pi-lock" aria-hidden="true" />这是某个用户的私有记忆，查看与修改都会写进 <code>memory_revisions</code> 审计（docs/06 §5.3）。</p>
              <textarea v-model="promptContent" spellcheck="false" aria-label="提示词内容" />
              <h3>版本记录</h3>
              <ol class="revision-list"><li v-for="revision in promptRevisions" :key="String(revision.id)"><div><code>{{ String(revision.id).slice(0, 12) }}</code><small>{{ revision.actor }} · {{ new Date(Number(revision.ts)).toLocaleString() }}</small></div><UiButton size="small" variant="text" label="回滚" @click="rollbackPrompt(revision.id)" /></li><li v-if="!promptRevisions.length" class="empty">还没有保存过任何版本。</li></ol>
            </article>
            <article v-else class="editor-panel empty-card"><i class="pi pi-align-left" aria-hidden="true" /><h3>选一份文档开始编辑</h3><p>每次保存都会落一条 unified diff 版本，可随时回滚。</p></article>
          </div>
        </section>
        <section v-else-if="active === 'tasks'" key="tasks" class="surface page-surface"><header><div><p class="eyebrow">WORK QUEUE</p><h2>任务与审批</h2><p>在途任务、历史状态与高风险工具批准队列。</p></div></header><div class="dashboard-grid">
          <article class="surface"><h3>任务</h3><p class="section-note">任务由 <code>spawn_agent</code> 派发，跟着它所属的那一轮活着。子 agent 没有独立的取消句柄，<b>「取消」取消的是整轮</b> —— 同一轮里的其他子 agent 也会一起停。</p>
            <DataGrid :rows="tasks" :columns="COLUMNS.tasks" data-key="id" empty="没有在途或历史任务">
              <template #updated_at="{ data }">{{ new Date(Number(data.updated_at)).toLocaleString() }}</template>
              <template #actions="{ data }"><UiButton v-if="data.state === 'running'" size="small" variant="outlined" severity="danger" label="取消" :loading="cancellingTurn === data.turn_id" @click="cancelTaskTurn(data)" /></template>
            </DataGrid></article>
          <article class="surface"><h3>审批</h3><p class="section-note">命中审批规则的工具会暂停到 <code>approval.ttlMs</code>；批准后原调用继续，拒绝、过期或取消后不会执行。</p>
            <DataGrid :rows="approvals" :columns="COLUMNS.approvals" data-key="id" empty="没有审批记录">
              <template #tool_name="{ data }"><code>{{ data.tool_name }}</code><small class="hit-text">{{ data.input_json }}</small></template>
              <template #risk="{ data }"><UiTag :value="String(data.risk)" :severity="data.risk === 'high' ? 'danger' : data.risk === 'medium' ? 'warn' : 'secondary'" /></template>
              <template #state="{ data }"><UiTag :value="String(data.state)" :severity="data.state === 'pending' ? 'warn' : data.state === 'approved' ? 'success' : data.state === 'denied' ? 'danger' : 'secondary'" /></template>
              <template #requested_at="{ data }">{{ new Date(Number(data.requested_at)).toLocaleString() }}</template>
              <template #actions="{ data }"><div v-if="data.state === 'pending'" class="section-actions"><UiButton size="small" severity="danger" variant="outlined" label="拒绝" :loading="decidingApproval === data.id" @click="decideApproval(data, false)" /><UiButton size="small" label="批准执行" :loading="decidingApproval === data.id" @click="decideApproval(data, true)" /></div><small v-else class="alias-empty">{{ data.decided_by ?? 'system' }}</small></template>
            </DataGrid>
          </article>
        </div></section>
        <section v-else-if="active === 'settings'" key="settings" class="surface page-surface">
          <header><div><p class="eyebrow">CONFIGURATION</p><h2>配置与维护</h2><p>完整合并配置已通过 zod 校验；密钥字段不会回显。</p></div></header>
          <div class="registry-heading">
            <div><h3>修改登录口令</h3><p class="section-note">WebUI 只有一个身份（owner）。改完<b>立即生效、其余会话全部吊销</b>，不用重启进程。忘了当前口令只能线下 <code>pnpm webui:passwd</code> 生成哈希写进 <code>config.yaml</code>。</p></div>
          </div>
          <p v-if="passwordPinnedEnv" class="callout warn">
            <i class="pi pi-lock" aria-hidden="true" />
            口令由环境变量 <code>{{ passwordPinnedEnv }}</code> 固定：在这里改能改到当前进程，但重启后会被环境变量盖回去。要真正换口令，请改这个环境变量（或清掉它，让口令回到 <code>config_kv</code> 管）。
          </p>
          <div v-else class="form-grid">
            <label>当前口令<input v-model="passwordForm.current" type="password" autocomplete="current-password" placeholder="用于确认是你本人"></label>
            <label>新口令<input v-model="passwordForm.next" type="password" autocomplete="new-password" placeholder="至少 12 个字符"></label>
            <label>再输一次<input v-model="passwordForm.confirm" type="password" autocomplete="new-password" placeholder="两次要一致"></label>
            <div class="wide password-actions">
              <UiButton icon="pi pi-key" label="更新口令" :loading="passwordSaving" :disabled="Boolean(passwordProblem)" @click="savePassword" />
              <small class="field-note">{{ passwordProblem || '会吊销除当前会话之外的所有登录态。' }}</small>
            </div>
          </div>
          <div class="registry-heading">
            <div><h3>触发与唤醒词</h3><p class="section-note">决定哪条消息会开轮次。五个来源取并集，命中任一条就触发；群里没有任何一条命中时，消息只作为背景发言存档。保存后热更新，下一条消息即生效。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存触发设置" :loading="triggerSaving" :disabled="!triggerDirty" @click="saveTrigger" />
          </div>
          <div class="form-grid">
            <!-- 五个来源取并集，是「哪些消息算触发」这一个集合的成员，不是五个独立开关 —— 用勾选框。 -->
            <div class="trigger-switches">
              <UiCheckbox v-model="triggerForm.private" label="私聊消息" @change="markTriggerDirty" />
              <UiCheckbox v-model="triggerForm.mention" label="@ 提及" @change="markTriggerDirty" />
              <UiCheckbox v-model="triggerForm.reply" label="回复 bot" @change="markTriggerDirty" />
              <UiCheckbox v-model="triggerForm.command" label="bot 命令" @change="markTriggerDirty" />
              <UiCheckbox v-model="triggerForm.channels" label="频道消息" @change="markTriggerDirty" />
            </div>
            <div class="wide">
              <p class="field-title">唤醒词<small>不以 ^ 开头 = 包含匹配，忽略大小写（nori 同时匹配 Nori）；以 ^ 开头 = 正则（u 标志，只扫描消息前 4096 字符），按你写的大小写求值，要忽略就写 ^(?i)nori。私聊不看唤醒词。</small></p>
              <div class="wake-list">
                <span v-for="entry in wakewordStatus" :key="entry.pattern" :class="['wake-chip', { bad: !entry.ok }]" :title="entry.reason ?? ''">
                  <code>{{ entry.pattern }}</code>
                  <UiTag :value="entry.kind === 'regex' ? '正则' : '包含'" :severity="entry.kind === 'regex' ? 'info' : 'secondary'" />
                  <UiTag v-if="!entry.ok" value="不生效" severity="danger" />
                  <button type="button" aria-label="删除唤醒词" @click="removeWakeword(entry.pattern)"><i class="pi pi-times" /></button>
                </span>
                <span v-if="!triggerForm.wakewords.length" class="alias-empty">没有唤醒词：群里只能靠 @ 提及、回复或命令触发。</span>
              </div>
              <p v-for="entry in wakewordStatus.filter((item) => !item.ok)" :key="`bad-${entry.pattern}`" class="field-note wake-issue"><i class="pi pi-exclamation-triangle" />「{{ entry.pattern }}」{{ entry.reason }} —— 匹配时会被跳过，保存也会被拒绝。</p>
              <div class="wake-add"><input v-model="newWakeword" placeholder="例如 洛璃 或 ^璃酱[，,、 ]" @keyup.enter="addWakeword"><UiButton size="small" variant="outlined" icon="pi pi-plus" label="添加" @click="addWakeword" /></div>
            </div>
            <label>唤醒词最短长度<UiNumber :model-value="triggerForm.wakewordMinLength" :min="1" :max="32" @update:model-value="changeWakewordMinLength" /><small class="field-note">短于这个长度的唤醒词整条忽略（按 ^ 之后的字符数算），避免单字误触发。</small></label>
            <div class="switch-column">
              <UiSwitch v-model="triggerForm.requireTextAfterMention" label="只 @ 不说话时不触发" @change="markTriggerDirty" />
              <!-- 这一格在 KNOWN_UNIMPLEMENTED_CONFIG_KEYS 里：编辑消息一律按背景消息归档，
                   开关存得下但运行时没人读（docs/20 · W-TG-05）。不能让它看起来像个能用的开关。 -->
              <UiSwitch v-model="triggerForm.ignoreEditedAsTrigger" disabled>编辑旧消息不重新触发<UiTag value="未接线" severity="secondary" title="编辑消息当前一律按背景消息归档，这个开关运行时没有任何代码读它" /></UiSwitch>
            </div>
            <p class="field-note wide">会话级覆盖（<code>perChat.&lt;contextKey&gt;.trigger</code>）优先于这里的全局值，入口在<b>会话页</b>选中某个会话之后的「只对这个会话生效的设置」。</p>
          </div>
          <div class="registry-heading">
            <div><h3>输出节奏</h3><p class="section-note">决定一条回复怎么送出去。流式模式下先攒一段再发第一条，之后按固定节拍编辑同一条消息 —— 攒的时长设成 0 就会退回「先发一个字、剩下靠编辑补」的观感。保存后下一轮生效。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存输出节奏" :loading="outputSaving" :disabled="!outputDirty" @click="saveOutput" />
          </div>
          <div class="form-grid">
            <label>模式<UiSelect v-model="outputForm.mode" :options="[{ value: 'stream', label: 'stream · 边生成边编辑' }, { value: 'once', label: 'once · 生成完一次性发出' }]" @change="markOutputDirty" /><small class="field-note">once 模式下面三项编辑相关的设置不起作用。</small></label>
            <label>防秒回等待（毫秒）<UiNumber :model-value="outputForm.replyDelayMs" :min="0" :max="30000" :step="500" @update:model-value="changeOutputNumber('replyDelayMs', $event)" /><small class="field-note">从<b>用户那条消息到达</b>算起。模型本来就想了这么久时不再额外压时间。0 = 立刻回。</small></label>
            <label>首帧缓冲（毫秒）<UiNumber :model-value="outputForm.streamBufferMs" :min="0" :max="30000" :step="500" @update:model-value="changeOutputNumber('streamBufferMs', $event)" /><small class="field-note">从<b>上游第一个 chunk 到达</b>算起，攒够这么久再发第一条。窗口内的文本只攒不发不会丢；流在窗口内就结束则立刻发出。</small></label>
            <label>编辑间隔（毫秒）<UiNumber :model-value="outputForm.streamIntervalMs" :min="200" :max="30000" :step="500" @update:model-value="changeOutputNumber('streamIntervalMs', $event)" /><small class="field-note">两次 editMessageText 之间的最小间隔。首条发出也算一次刷新，下一次编辑同样要等满。</small></label>
            <label>最小增量（字）<UiNumber :model-value="outputForm.streamMinDeltaChars" :min="1" :max="2000" @update:model-value="changeOutputNumber('streamMinDeltaChars', $event)" /><small class="field-note">和上一项是<b>同时满足</b>才编辑：到点了但只多出两三个字就先不动，免得撞 Telegram 的编辑频率限制。收尾那次编辑不受这两项约束。</small></label>
            <p class="field-note wide">会话级覆盖（<code>perChat.&lt;contextKey&gt;.output</code>）优先于这里的全局值。</p>
          </div>
          <div class="registry-heading"><div><h3>维护操作</h3><p class="section-note">都是同步执行的：大库上会阻塞写入，跑的时候 bot 那边的消息会排队。</p></div></div>
          <div class="maintenance-grid">
            <article v-for="item in MAINTENANCE_ACTIONS" :key="item.action">
              <div><b><i :class="item.icon" aria-hidden="true" /> {{ item.label }}</b><small>{{ item.hint }}</small></div>
              <UiButton size="small" variant="outlined" label="执行" :loading="maintenanceBusy === item.action" :disabled="Boolean(maintenanceBusy)" @click="runMaintenance(item.action, item.label)" />
            </article>
            <article class="danger">
              <div><b><i class="pi pi-refresh" aria-hidden="true" /> 重启进程</b><small>走和 SIGTERM 一样的优雅关闭（排空在途轮次、刷日志、WAL checkpoint）。<b>没有 systemd / docker 这类 supervisor 时进程不会自己回来</b></small></div>
              <UiButton size="small" variant="outlined" severity="danger" label="重启" :loading="restarting" :disabled="Boolean(maintenanceBusy)" @click="restartProcess" />
            </article>
          </div>
          <div class="registry-heading"><div><h3>导出 / 导入配置</h3><p class="section-note">导的是 <code>config_kv</code> 里的<b>覆盖层</b>，不是合并后的全量 —— 全量里绝大多数是代码默认值，导进另一个部署等于把那一刻的默认值钉死。密钥类键直接不导出（不是导成 <code>«redacted»</code>：那样导入端会把真密钥覆盖成一个字面量）。导入按键覆盖，<b>不删除</b>现有覆盖行。</p></div>
            <div class="section-actions"><UiButton size="small" variant="outlined" icon="pi pi-download" label="导出" :loading="exportBusy" @click="exportConfig" /><UiButton size="small" variant="outlined" icon="pi pi-upload" label="导入" @click="importFile?.click()" /></div>
          </div>
          <input ref="importFile" type="file" accept="application/json,.json" hidden @change="importConfig">
          <div class="registry-heading">
            <div><h3>全部配置</h3><p class="section-note">由 <code>config/config.schema.json</code> 自动生成 —— 控件形态、默认值、取值范围与每一项的作用说明全部取自 schema，不在前端维护第二份清单。搜索框同时匹配键名与说明。热更新项保存即生效，需重启项会在保存后的提示里点名。密钥字段是<b>只写</b>的（不回显，留空表示不改）；标「环境变量锁定」的键由环境变量最终决定，写进来也会被盖回去，所以不给改。</p></div>
            <UiButton size="small" variant="text" icon="pi pi-history" label="变更历史" @click="openConfigRevisions" />
          </div>
          <SchemaForm v-if="configSchema" ref="schemaForm" :schema="configSchema.schema" :value="config" :hot-reloadable="configSchema.hotReloadable" :unimplemented="configSchema.unimplemented" :env-pinned="configSchema.envPinned" :saving="schemaSaving" @save="saveSchemaConfig" />
          <p v-else class="empty-card"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在加载配置 schema…</p>
          <div class="registry-heading">
            <div><h3>原始 YAML</h3><p class="section-note">直接编辑<b>覆盖层</b>（<code>config_kv</code>），不是合并后的全量 —— 全量里绝大多数是代码默认值。解析与校验都在服务端（和启动时那份 <code>loadConfig</code> 用同一个解析器，不会「界面上过了、启动时炸了」），语法错误会给出行号。落库按顶层段覆盖。</p></div>
            <div class="section-actions"><UiButton size="small" variant="text" :icon="yamlMode ? 'pi pi-times' : 'pi pi-code'" :label="yamlMode ? '收起' : '编辑 YAML'" @click="toggleYamlMode" /><UiButton v-if="yamlMode" size="small" icon="pi pi-save" label="保存 YAML" :loading="yamlSaving" @click="saveYaml" /></div>
          </div>
          <template v-if="yamlMode">
            <p v-if="yamlSkipped.length" class="callout warn"><i class="pi pi-key" />{{ yamlSkipped.length }} 个密钥类键没有出现在下面（不回显也不会被这次保存清掉）：<code>{{ yamlSkipped.join('、') }}</code></p>
            <p v-if="yamlError" class="callout warn"><i class="pi pi-exclamation-triangle" />{{ yamlError }}</p>
            <textarea v-model="yamlText" class="yaml-editor" rows="24" spellcheck="false" aria-label="原始 YAML 覆盖层" />
          </template>
          <div class="registry-heading"><div><h3>合并后的完整配置</h3><p class="section-note">config.yaml → DB 覆盖层 → 环境变量三层合并的结果，只读；上面那张表单改的就是这份 JSON 里的值。</p></div></div>
          <pre class="config-preview" v-text="JSON.stringify(config, null, 2)" />
        </section>
        <section v-else key="fallback" class="surface page-surface"><header><div><p class="eyebrow">{{ currentLabel.toUpperCase() }}</p><h2>{{ currentLabel }}</h2><p>该页读取统一安全 API；写操作必须携带 Session 与 CSRF token，并记录 webui.action 审计。</p></div></header><DataGrid :rows="logs.slice(0, 12)" :columns="COLUMNS.fallback" data-key="id" empty="暂无事件" /></section>
        </Transition>
      </div>
    </section>

    <UiModal v-model:visible="providerDialog" title="Provider 配置">
      <div class="form-grid"><label>名称<input v-model="providerForm.name"></label><label>类型<UiSelect v-model="providerForm.kind" :options="['openai', 'anthropic', 'google', 'openai-compatible']" /></label><label class="wide">Base URL<input v-model="providerForm.baseUrl" placeholder="使用 provider 默认地址"></label><label class="wide">API Key<input v-model="providerForm.apiKey" type="password" placeholder="保持不变" autocomplete="new-password"></label><UiSwitch v-model="providerForm.enabled" class="wide" label="启用" /></div>
      <template #footer><UiButton variant="text" label="取消" @click="providerDialog = false" /><UiButton variant="outlined" icon="pi pi-bolt" label="测试连接" :loading="Boolean(providerForm.id) && testingProvider === providerForm.id" @click="testProviderDraft" /><UiButton label="保存 Provider" @click="saveProvider" /></template>
    </UiModal>
    <UiModal v-model:visible="catalogDialog" title="从 Provider 拉取模型" width="min(900px, 96vw)">
      <div class="catalog-toolbar">
        <label>Provider<UiSelect v-model="catalogProviderId" :options="providers" option-label="name" option-value="id" @change="loadCatalog" /></label>
        <label>搜索<input v-model="catalogQuery" placeholder="按模型 ID 或显示名过滤"></label>
        <label>默认 Context Window<UiNumber :model-value="catalogDefaults.contextWindow" :min="1" :step="1000" @update:model-value="changeCatalogDefault('contextWindow', $event)" /></label>
        <label>默认最大输出<UiNumber :model-value="catalogDefaults.maxOutput" :min="1" :step="256" @update:model-value="changeCatalogDefault('maxOutput', $event)" /></label>
        <UiButton variant="outlined" icon="pi pi-refresh" label="重新拉取" :loading="catalogLoading" @click="loadCatalog" />
      </div>
      <div v-if="catalogError" class="danger-banner"><i class="pi pi-exclamation-triangle" />{{ catalogError }}</div>
      <div class="catalog-status">
        <template v-if="catalogStatus && !catalogStatus.enabled"><i class="pi pi-info-circle" />模型元数据目录已关闭（<code>provider.catalog.enabled</code>），只能拿到上游 <code>/models</code> 给的那点信息。</template>
        <template v-else-if="catalogStatus?.available"><i class="pi pi-database" />元数据来自 models.dev 本地缓存：{{ catalogStatus.models }} 个模型 / {{ catalogStatus.providers }} 家 provider · {{ catalogAge }}<span v-if="catalogStatus.stale"> · 已过期，下次拉取时会自动续期</span></template>
        <template v-else><i class="pi pi-exclamation-triangle" />还没有本地元数据缓存{{ catalogStatus?.error ? `（${catalogStatus.error}）` : '' }}，窗口与价格都需要手填。</template>
        <UiButton variant="text" size="small" icon="pi pi-sync" label="刷新目录" :loading="catalogRefreshing" @click="refreshCatalog" />
      </div>
      <DataGrid v-model:selection="catalogSelection" :rows="catalogRows" :columns="COLUMNS.catalog" data-key="modelId" :loading="catalogLoading" :selectable="(row) => !catalogExists(row)" scroll-height="46vh" empty="上游没有返回可导入的模型">
        <template #modelId="{ data }"><code>{{ data.modelId }}</code><small v-if="data.displayName" class="catalog-sub">{{ data.displayName }}</small></template>
        <template #limits="{ data }">{{ data.contextWindow ?? catalogDefaults.contextWindow }} / {{ data.maxOutput ?? catalogDefaults.maxOutput }}<small v-if="!data.contextWindow" class="catalog-sub">上游与目录都没给，用默认值</small><small v-else-if="data.limitSource === 'models.dev'" class="catalog-sub">来自 models.dev</small></template>
        <template #price="{ data }">
          <span>{{ priceText(data) }}</span>
          <small v-if="data.meta" :class="['catalog-sub', `match-${data.meta.match}`]" :title="MATCH_LABELS[data.meta.match].hint">{{ MATCH_LABELS[data.meta.match].label }}<template v-if="data.meta.catalogProviderId && data.meta.match !== 'third-party'"> · {{ data.meta.catalogProviderId }}</template></small>
          <small v-if="data.meta?.priceRange" class="catalog-sub">{{ rangeText(data.meta.priceRange) }}，需手填</small>
        </template>
        <template #capabilities="{ data }"><span v-if="capabilityTags(data.meta).length" class="cap-tags"><UiTag v-for="tag in capabilityTags(data.meta)" :key="tag" :value="tag" severity="secondary" /></span><small v-else class="catalog-sub">目录里没有这个模型</small></template>
        <template #status="{ data }"><UiTag v-if="catalogExists(data)" value="已在库" severity="secondary" /><UiTag v-else value="可导入" severity="info" /></template>
      </DataGrid>
      <p class="catalog-hint">窗口、能力与思考档位来自 models.dev；价格只在能确定出处时才带入 —— <b>provider 自报价</b>（这家网关自己公布的价）优先，其次是<b>厂商官方价</b>；只有第三方托管报价的模型价格一律留空（<code>docs/04 §5.4.1</code>），不补齐的话这些模型的花费按 0 记账。</p>
      <template #footer><span class="catalog-count">已选 {{ catalogSelection.length }} · 列出 {{ catalogRows.length }} / 共 {{ catalogModels.length }}</span><UiButton variant="text" label="关闭" @click="catalogDialog = false" /><UiButton label="导入所选" icon="pi pi-download" :disabled="!catalogSelection.length" @click="importCatalog" /></template>
    </UiModal>
    <UiModal v-model:visible="modelDialog" title="模型配置" width="min(680px, 94vw)">
      <div class="form-grid">
        <label>Provider<UiSelect v-model="modelForm.providerId" :options="providers" option-label="name" option-value="id" /></label>
        <label>模型 ID<input v-model="modelForm.modelId" :disabled="Boolean(modelForm.id)"></label>
        <label>显示名<input v-model="modelForm.displayName"></label>
        <label>排序<UiNumber :model-value="modelForm.sort" :min="0" @update:model-value="changeModelNumber('sort', $event)" /></label>
        <label>Context Window<UiNumber :model-value="modelForm.contextWindow" :min="1" :step="1000" @update:model-value="changeModelNumber('contextWindow', $event)" /></label>
        <label>最大输出<UiNumber :model-value="modelForm.maxOutput" :min="1" :step="256" @update:model-value="changeModelNumber('maxOutput', $event)" /></label>
        <label>输入价格 / M token<UiNumber :model-value="modelForm.priceIn" :min="0" :step="0.1" @update:model-value="changeModelNumber('priceIn', $event)" /></label>
        <label>输出价格 / M token<UiNumber :model-value="modelForm.priceOut" :min="0" :step="0.1" @update:model-value="changeModelNumber('priceOut', $event)" /></label>
        <label>缓存读取价格<UiNumber :model-value="modelForm.priceCacheRead" :min="0" :step="0.01" @update:model-value="changeModelNumber('priceCacheRead', $event)" /></label>
        <label>缓存写入价格<UiNumber :model-value="modelForm.priceCacheWrite" :min="0" :step="0.01" @update:model-value="changeModelNumber('priceCacheWrite', $event)" /></label>
        <UiSwitch v-model="modelForm.enabled" class="wide" label="启用" />
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="modelDialog = false" /><UiButton label="保存模型" @click="saveModel" /></template>
    </UiModal>
    <UiModal v-model:visible="aliasDialog" :title="`别名 ${aliasName || '（未命名）'}`" width="min(860px, 94vw)">
      <div class="form-grid">
        <label>别名<UiSelect v-model="aliasForm.alias" :options="[...ALIAS_GUIDE.map((entry) => entry.alias), '__custom__']" :option-label="(value) => value === '__custom__' ? '自定义…' : value" /></label>
        <label v-if="aliasForm.alias === '__custom__'">自定义别名<input v-model="aliasForm.custom" placeholder="小写字母开头，[a-z0-9_-]，≤32 位"></label>
        <p class="wide field-note">{{ aliasNameHint }}</p>
        <p v-if="aliasForm.droppedModels" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />原链里有 {{ aliasForm.droppedModels }} 个模型记录已不存在，保存后会从链里去掉。</p>
        <div class="wide"><p class="field-title">Fallback 模型链</p><p class="field-note">把左边的模型加入右侧链，拖拽或用上下箭头排顺序。排在前面的先用，不可用（429/5xx 重试耗尽）才顺延到下一个；停用的模型会被跳过。</p><ChainPicker v-model="aliasChain" :options="modelOptions" /></div>
        <p class="wide field-title">采样参数<small>留空 = 不下发该字段，用 provider 默认值；只在这个别名被选中的那一步生效</small></p>
        <label>温度 temperature<UiNumber v-model="aliasSettings.temperature" :min="0" :max="2" :step="0.1" placeholder="0 – 2" /></label>
        <label>最大输出 maxOutputTokens<UiNumber v-model="aliasSettings.maxOutputTokens" :min="1" :step="256" placeholder="不超过模型自身上限" /></label>
        <label>推理档位 reasoning<UiSelect v-model="aliasSettings.reasoning" :options="REASONING_OPTIONS" show-clear placeholder="不下发" /></label>
        <details class="ui-fieldset wide">
          <summary><i class="pi pi-chevron-right" aria-hidden="true" />高级</summary>
          <div class="form-grid"><label>topP<UiNumber v-model="aliasSettings.topP" :min="0" :max="1" :step="0.05" placeholder="0 – 1，与温度二选一" /></label><label>topK<UiNumber v-model="aliasSettings.topK" :min="1" placeholder="≥ 1 的整数" /></label><label>存在惩罚 presencePenalty<UiNumber v-model="aliasSettings.presencePenalty" :min="-1" :max="1" :step="0.1" placeholder="-1 – 1" /></label><label>重复惩罚 frequencyPenalty<UiNumber v-model="aliasSettings.frequencyPenalty" :min="-1" :max="1" :step="0.1" placeholder="-1 – 1" /></label><label>seed<UiNumber v-model="aliasSettings.seed" :step="1" placeholder="整数，部分 provider 支持" /></label><label>停止序列 stopSequences<textarea v-model="aliasSettings.stopSequences" rows="3" placeholder="每行一条，最多 8 条" /></label></div>
        </details>
        <label class="wide">说明（只给运维看）<input v-model="aliasForm.description"></label>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="aliasDialog = false" /><UiButton :label="aliasForm.isNew ? '创建别名' : '保存别名'" @click="saveAlias" /></template>
    </UiModal>
    <UiModal v-model:visible="principalDialog" :title="`${principalForm.kind === 'chat' ? '群聊' : '用户'} ${principalForm.displayName || principalForm.tgId}`">
      <div class="form-grid">
        <label>类型<input :value="principalForm.kind === 'chat' ? '群聊' : '用户'" disabled></label>
        <label>Telegram ID<input :value="principalForm.tgId" disabled></label>
        <label>显示名<input :value="principalForm.displayName ?? '—'" disabled></label>
        <label>用户名<input :value="principalForm.username ? `@${principalForm.username}` : '—'" disabled></label>
        <label class="wide">角色<UiSelect v-model="principalForm.role" :options="ROLES" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[principalForm.role] }}</p>
        <p v-if="principalForm.kind === 'chat'" class="wide field-note">会话角色只是上限：群里某个人的有效角色 = min(他自己的角色, 这个群的角色)。私聊会话不看这一行。</p>
        <p v-if="principalForm.role === 'owner' && principalForm.originalRole !== 'owner'" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />owner 跳过审批与沙箱（<code>sandbox.bypassRoles</code>），可以在会话里直接执行宿主命令。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="principalDialog = false" /><UiButton label="保存角色" :loading="principalSaving" :disabled="principalForm.role === principalForm.originalRole" @click="savePrincipal" /></template>
    </UiModal>
    <UiModal v-model:visible="roleDialog" title="批量修改角色">
      <div class="form-grid">
        <p class="wide field-note">对勾选的 <b>{{ principalSelection.length }}</b> 个主体统一设角色。只改已存在的行，不会新建 —— 还没跟 bot 说过话的人走「批量导入」。</p>
        <label>目标角色<UiSelect v-model="roleBulkForm.role" :options="ROLES" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[roleBulkForm.role] }}</p>
        <div class="wide selection-preview">
          <span v-for="entry in principalSelection.slice(0, 24)" :key="entry.id" class="wake-chip"><UiTag :value="entry.kind === 'chat' ? '群' : '人'" :severity="entry.kind === 'chat' ? 'info' : 'secondary'" /><code>{{ entry.displayName || entry.username || entry.tgId }}</code><UiTag :value="entry.role" :severity="roleSeverity(entry.role)" /></span>
          <small v-if="principalSelection.length > 24" class="alias-empty">…等 {{ principalSelection.length }} 个</small>
        </div>
        <p v-if="roleBulkForm.role === 'owner'" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />owner 跳过审批与沙箱（<code>sandbox.bypassRoles</code>），可以在会话里直接执行宿主命令。一次给这么多人不是常规操作。</p>
        <p v-if="selectionHitsOwnerSeat && roleBulkForm.role !== 'owner'" class="wide callout error"><i class="pi pi-times-circle" aria-hidden="true" />这批里包含 <code>access.bootstrapOwnerId</code> 指向的引导 owner。降级之后 Telegram 那边就没人能管 bot 了，只能改配置再重启。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="roleDialog = false" /><UiButton label="改这些人的角色" icon="pi pi-user-edit" :loading="roleSaving" :disabled="!principalSelection.length" @click="saveRoleBulk" /></template>
    </UiModal>
    <UiModal v-model:visible="detailDialog" :title="`对话详情 ${detailTurnId.slice(0, 12)}`" width="min(1120px, 96vw)">
      <p v-if="detailLoading" class="empty"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 读取该轮日志…</p>
      <template v-else-if="detail">
        <div class="detail-summary">
          <span><small>状态</small><UiTag :value="turnState(String(detail.turn.state)).label" :severity="turnState(String(detail.turn.state)).severity" /></span>
          <span><small>会话</small><code>{{ detail.turn.key }}</code></span>
          <span><small>发起人</small><b>{{ detail.turn.fromName ?? detail.turn.fromUsername ?? detail.turn.userId }}</b></span>
          <span><small>步数 / 工具</small><b>{{ detail.turn.steps }} · {{ detail.turn.toolCalls }}</b></span>
          <span><small>token</small><b>{{ detail.turn.inputTokens }}/{{ detail.turn.outputTokens }}</b></span>
          <span><small>花费</small><b>${{ Number(detail.turn.costUsd || 0).toFixed(4) }}</b></span>
          <span><small>耗时</small><b>{{ detail.turn.finishedAt && detail.turn.startedAt ? `${Number(detail.turn.finishedAt) - Number(detail.turn.startedAt)} ms` : '—' }}</b></span>
        </div>
        <p v-if="detail.turn.error" class="callout error"><i class="pi pi-times-circle" aria-hidden="true" />{{ detail.turn.error }}</p>
        <p v-if="!detail.captureBodies" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" /><code>logs.captureBodies</code> 是关的：这一轮的 span 里不会有请求体与响应体，只剩用量与耗时。</p>
        <nav class="subtabs" aria-label="事件分组">
          <button v-for="[key, label] in DETAIL_GROUPS" :key="key" type="button" :class="{ active: detailGroup === key }" @click="detailGroup = key">{{ label }}<span>{{ detailCount(key) }}</span></button>
        </nav>
        <ol class="detail-events">
          <li v-for="event in detailEvents" :key="event.id">
            <button type="button" @click="toggleEvent(event.id)">
              <i :class="expandedEvents.has(event.id) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true" />
              <span :class="['level', event.level]">{{ event.level }}</span>
              <code>{{ event.kind }}</code>
              <span class="detail-summary-text">{{ event.summary }}</span>
              <small>{{ event.bytes ? formatBytes(event.bytes) : '无载荷' }}{{ event.durationMs === null ? '' : ` · ${event.durationMs} ms` }}</small>
              <time>{{ new Date(event.ts).toLocaleTimeString() }}</time>
            </button>
            <div v-if="expandedEvents.has(event.id)" class="detail-payload">
              <div class="detail-actions">
                <UiButton size="small" variant="text" icon="pi pi-copy" label="复制 JSON" :disabled="!event.bytes" @click="copyEvent(event)" />
                <a v-if="event.bytes" class="ui-btn text small" :href="`/api/logs/${event.id}/data`" :download="`${event.kind}-${event.id}.json`"><i class="pi pi-download" aria-hidden="true" />下载完整 JSON</a>
                <small v-if="event.truncated" class="detail-truncated">下面只渲染前 120k 字符；完整载荷 {{ formatBytes(event.bytes) }}，用上面的复制或下载取。</small>
              </div>
              <pre v-if="event.text" v-text="event.text" />
              <p v-else-if="event.fileRef" class="empty">载荷文件 <code>{{ event.fileRef }}</code> 已被日志保留策略清理。</p>
              <p v-else class="empty">这条事件没有载荷。</p>
            </div>
          </li>
          <li v-if="!detailEvents.length" class="empty">这一组没有事件。日志按 <code>logs.retentionDays</code> 清理，旧轮次的 span 可能已经不在了。</li>
        </ol>
      </template>
      <template #footer><span class="catalog-count">trace <code>{{ detailTurnId }}</code></span><UiButton variant="outlined" icon="pi pi-sitemap" label="在日志页看这条 trace" @click="detailDialog = false; active = 'logs'; inspectTrace(detailTurnId)" /><UiButton variant="text" label="关闭" @click="detailDialog = false" /></template>
    </UiModal>
    <UiModal v-model:visible="bulkDialog" title="批量导入主体">
      <div class="form-grid">
        <p class="wide field-note">把一批 Telegram <b>数字 ID</b> 一次性登记成主体并统一设角色：还没跟 bot 说过话的人也能提前放行或拉黑。已存在的主体只改角色，不动显示名。</p>
        <label>类型<UiSelect v-model="bulkForm.kind" :options="[{ value: 'user', label: '用户' }, { value: 'chat', label: '群聊' }]" /></label>
        <label>角色<UiSelect v-model="bulkForm.role" :options="ROLES" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[bulkForm.role] }}</p>
        <label class="wide">ID 列表<textarea v-model="bulkForm.ids" rows="7" placeholder="每行一个，或用空格/逗号分隔：&#10;123456789&#10;-1001234567890" /></label>
        <p v-if="bulkBadIds.length" class="wide callout error"><i class="pi pi-times-circle" aria-hidden="true" />不是合法的 Telegram 数字 ID：{{ bulkBadIds.slice(0, 5).join('、') }}{{ bulkBadIds.length > 5 ? ` 等 ${bulkBadIds.length} 个` : '' }}。群/频道 ID 以 <code>-100</code> 开头，@用户名不行。</p>
        <p v-else-if="bulkIds.length" class="wide field-note">已解析 {{ bulkIds.length }} 个 ID。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="bulkDialog = false" /><UiButton label="导入并设角色" icon="pi pi-upload" :loading="bulkSaving" :disabled="!bulkIds.length || bulkBadIds.length > 0" @click="saveBulk" /></template>
    </UiModal>
    <UiModal v-model:visible="toolDialog" :title="`工具 ${toolForm.name}`">
      <div class="form-grid">
        <label>来源<input :value="TOOL_SOURCE_LABEL[toolForm.source] ?? toolForm.source" disabled></label>
        <label>最低角色<input :value="toolForm.minRole" disabled></label>
        <label>审批策略<input :value="APPROVAL_LABEL[toolForm.approval] ?? toolForm.approval" disabled></label>
        <label>作用域<input :value="SCOPE_LABEL[toolForm.scope] ?? toolForm.scope" disabled></label>
        <p class="wide field-note">上面四项是代码里的单一策略源（<code>TOOL_POLICY</code>），注册期就 fail-closed，不在这里改 —— 能从界面调低某个工具的最低角色，等于把权限矩阵变成两份会漂移的真相。</p>
        <UiSwitch v-model="toolForm.enabled" class="wide" label="对所有会话启用" />
        <p class="wide field-note">停用是硬边界：工具既不进模型的工具目录，<code>execute()</code> 也会二次拦截并返回 <code>tool_disabled_by_operator</code>（模型可能沿用上一步的工具名）。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="toolDialog = false" /><UiButton :label="toolForm.enabled ? '启用' : '停用'" :severity="toolForm.enabled ? 'primary' : 'danger'" :loading="toolSaving" :disabled="toolForm.enabled === toolForm.original" @click="saveTool" /></template>
    </UiModal>
    <UiModal v-model:visible="agentDialog" :title="agentForm.isNew ? '新建子 Agent' : `子 Agent ${agentForm.originalName}`" width="min(860px, 94vw)">
      <div class="form-grid">
        <label>名称<input v-model="agentForm.name" :disabled="!agentForm.isNew" placeholder="模型用这个名字调 spawn_agent"></label>
        <label>模型别名<UiSelect v-model="agentForm.modelAlias" :options="aliasRows.map((row) => row.alias)" /></label>
        <p v-if="agentNameTaken" class="wide callout error"><i class="pi pi-times-circle" aria-hidden="true" />已存在同名 Agent。</p>
        <label class="wide">职责描述<input v-model="agentForm.description" placeholder="写给模型看：什么时候该派这个 agent"></label>
        <label>最低角色<UiSelect v-model="agentForm.minRole" :options="ROLES" /></label>
        <label>步数上限<UiNumber v-model="agentForm.maxSteps" :min="1" :max="64" /></label>
        <label>结果最大字符<UiNumber v-model="agentForm.resultMaxChars" :min="200" :step="500" /></label>
        <UiSwitch v-model="agentForm.injectMemory" class="wide" label="注入记忆文档（PUBMEMORY / PRIMEMORY）" />
        <p class="wide field-note">子 agent 的有效角色 = min(父 agent 角色, 这里的最低角色)，永远不会比派发它的人权限更高。</p>
        <div class="wide">
          <p class="field-title">可用工具<small>全不勾 = 不额外限制，沿用父 agent 在当前角色下的工具目录</small></p>
          <div class="tool-picker">
            <UiCheckbox v-for="row in toolRows" :key="row.name" :class="{ off: !row.enabled }" :model-value="agentForm.tools.includes(row.name)" @change="toggleAgentTool(row.name)">
              <code>{{ row.name }}</code><small v-if="!row.enabled">已停用</small>
            </UiCheckbox>
          </div>
        </div>
        <label class="wide">instructions<textarea v-model="agentForm.instructions" rows="9" placeholder="这个子 agent 的系统提示词" /></label>
      </div>
      <template #footer>
        <UiButton v-if="!agentForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="删除" @click="removeAgent(agentForm.originalName)" />
        <UiButton variant="text" label="取消" @click="agentDialog = false" /><UiButton :label="agentForm.isNew ? '创建 Agent' : '保存 Agent'" :loading="agentSaving" @click="saveAgent" />
      </template>
    </UiModal>
    <UiModal v-model:visible="promptPreviewDialog" title="预览完整提示词组装" width="min(1080px, 96vw)">
      <div class="form-grid">
        <label class="wide">会话<UiSelect v-model="promptPreviewForm.key" :options="promptPreviewChats" placeholder="选择会话" /></label>
        <label>有效角色<UiSelect v-model="promptPreviewForm.role" :options="ROLES" /></label>
        <p class="field-note">工具、Skill、子 Agent 与私有记忆会按这份角色和会话实时筛选。</p>
      </div>
      <template v-if="promptPreview">
        <div class="preview-summary"><b>{{ promptPreview.totalTokens.toLocaleString() }} tokens</b><span>上下文 {{ promptPreview.context.messages }} 条 / {{ promptPreview.context.tokens.toLocaleString() }} tokens</span></div>
        <div class="prompt-token-bar" :aria-label="`提示词总计 ${promptPreview.totalTokens} tokens`">
          <span v-for="block in promptPreview.blocks" :key="block.name" :class="{ truncated: block.truncated }" :style="{ flexGrow: Math.max(1, block.tokens) }" :title="`${BLOCK_LABELS[block.name] ?? block.name}: ${block.tokens} tokens`" />
        </div>
        <ol class="prompt-preview-blocks">
          <li v-for="block in promptPreview.blocks" :key="block.name">
            <details>
              <summary><code>{{ BLOCK_LABELS[block.name] ?? block.name }}</code><UiTag :value="`${block.tokens} tokens`" :severity="block.truncated ? 'warn' : 'secondary'" /><UiTag :value="block.cached ? '缓存段' : '每轮重算'" :severity="block.cached ? 'success' : 'secondary'" /><UiTag v-if="block.truncated" value="已截断" severity="danger" /></summary>
              <pre v-text="block.content" />
            </details>
          </li>
        </ol>
      </template>
      <p v-else class="empty">选择会话和角色后运行组装。这里与真实轮次共用 <code>assembleMainPrompt()</code>，不是上下文占位数据。</p>
      <template #footer><UiButton variant="text" label="关闭" @click="promptPreviewDialog = false" /><UiButton label="运行组装" icon="pi pi-play" :loading="promptPreviewLoading" @click="runPromptPreview" /></template>
    </UiModal>
    <UiModal v-model:visible="skillDialog" :title="skillForm.isNew ? '新建 Skill' : `编辑 Skill ${skillForm.name}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <label>名称<input v-model="skillForm.name" :disabled="!skillForm.isNew" placeholder="lowercase-kebab-case"></label>
        <label>最低角色<UiSelect v-model="skillForm.minRole" :options="ROLES" /></label>
        <label class="wide">描述<input v-model="skillForm.description" maxlength="500" placeholder="模型在目录里看到的职责摘要"></label>
        <label>建议模型别名<input v-model="skillForm.model" placeholder="可留空"></label>
        <UiSwitch v-model="skillForm.enabled" class="wide" label="启用" />
        <label class="wide">允许工具（每行一个）<textarea v-model="skillForm.allowedTools" rows="4" placeholder="留空 = 沿用当前角色全部可用工具" /></label>
        <label class="wide">SKILL.md 正文<textarea v-model="skillForm.body" rows="14" placeholder="加载 Skill 后注入给模型的完整说明" /></label>
        <div v-if="!skillForm.isNew" class="wide"><p class="field-title">附属文件</p><div class="cap-tags"><UiTag v-for="file in skillForm.files" :key="file" :value="file" severity="secondary" /><small v-if="!skillForm.files.length" class="alias-empty">无</small></div></div>
      </div>
      <template #footer><UiButton v-if="!skillForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="永久删除" @click="removeSkill(skillForm.name)" /><UiButton variant="text" label="取消" @click="skillDialog = false" /><UiButton :label="skillForm.isNew ? '创建 Skill' : '保存 Skill'" :loading="skillSaving" @click="saveSkill" /></template>
    </UiModal>
    <UiModal v-model:visible="mcpDialog" :title="mcpForm.isNew ? '新建 MCP server' : `编辑 MCP ${mcpForm.originalName}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <label>名称<input v-model="mcpForm.name" :disabled="!mcpForm.isNew" placeholder="server-name"></label>
        <label>Transport<UiSelect v-model="mcpForm.transport" :options="[{ value: 'stdio', label: 'stdio · 本地进程' }, { value: 'http', label: 'Streamable HTTP' }]" /></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">命令<input v-model="mcpForm.command" placeholder="npx / absolute/path/server"></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">参数（每行一个）<textarea v-model="mcpForm.args" rows="4" /></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">环境变量 JSON<textarea v-model="mcpForm.env" rows="5" placeholder="{ &quot;TOKEN&quot;: &quot;...&quot; }" /></label>
        <label v-if="mcpForm.transport === 'http'" class="wide">URL<input v-model="mcpForm.url" type="url" placeholder="https://mcp.example.com/mcp"></label>
        <label v-if="mcpForm.transport === 'http'" class="wide">HTTP Headers JSON<textarea v-model="mcpForm.headers" rows="5" placeholder="{ &quot;Authorization&quot;: &quot;Bearer ...&quot; }" /></label>
        <label>最低角色<UiSelect v-model="mcpForm.minRole" :options="ROLES" /></label>
        <label>工具调用超时（ms）<UiNumber v-model="mcpForm.timeoutMs" :min="100" :step="1000" /></label>
        <label class="wide">工具允许 glob（每行一个）<textarea v-model="mcpForm.toolAllow" rows="3" placeholder="留空 = 全部允许" /></label>
        <label class="wide">工具拒绝 glob（每行一个）<textarea v-model="mcpForm.toolDeny" rows="3" /></label>
        <UiSwitch v-model="mcpForm.enabled" class="wide" label="启用并连接" />
      </div>
      <p v-if="mcpMasterOff" class="callout warn"><i class="pi pi-power-off" />总开关 <code>mcp.enabled</code> 当前是关的：这份配置存得下，但 <code>reconcile</code> 会跳过所有 server，不会真的连接。<UiButton size="small" variant="outlined" label="打开总开关" @click="enableMcpMaster" /></p>
      <p class="callout warn"><i class="pi pi-exclamation-triangle" />stdio 命令与 HTTP server 都是外部信任边界；只连接你审核过的 server，并用工具 allow/deny 缩小暴露面。</p>
      <template #footer><UiButton v-if="!mcpForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="删除" @click="removeMcp(mcpForm.originalName)" /><UiButton variant="text" label="取消" @click="mcpDialog = false" /><UiButton label="保存并重连" :loading="mcpSaving" @click="saveMcp" /></template>
    </UiModal>
    <UiModal v-model:visible="agentDryRunDialog" :title="`试跑 Agent ${agentDryRunName}`" width="min(980px, 96vw)">
      <div class="form-grid"><label class="wide">任务<textarea v-model="agentDryRunTask" rows="5" :disabled="agentDryRunRunning" placeholder="这次试跑要完成的具体任务；不会写入任何会话上下文" /></label></div>
      <p class="callout warn"><i class="pi pi-exclamation-triangle" />试跑会调用真实模型与该 Agent 可用的真实工具，产生实际费用和工具副作用；结果只写 agent_runs / usage ledger，不进入会话上下文。</p>
      <div v-if="agentDryRunEvents.length" class="dryrun-summary"><b>${{ agentDryRunCost.toFixed(4) }}</b><span>{{ agentDryRunEvents.filter((event) => event.type === 'step').length }} 步</span></div>
      <ol class="dryrun-events">
        <li v-for="(event, index) in agentDryRunEvents" :key="index" :class="event.type">
          <template v-if="event.type === 'step'"><header><UiTag :value="`步骤 ${event.step}`" severity="info" /><code>{{ event.finishReason }}</code></header><pre v-if="event.text" v-text="event.text" /><pre v-if="event.toolCalls.length" v-text="JSON.stringify({ toolCalls: event.toolCalls, toolResults: event.toolResults }, null, 2)" /></template>
          <template v-else-if="event.type === 'usage'"><header><UiTag :value="`用量 ${event.step}`" severity="secondary" /><span>{{ event.inputTokens }}/{{ event.outputTokens }} tok · ${{ event.costUsd.toFixed(4) }}</span></header></template>
          <template v-else-if="event.type === 'final'"><header><UiTag value="完成" severity="success" /><code>{{ event.fullRef }}</code></header><pre v-text="event.summary" /></template>
          <template v-else><header><UiTag value="失败" severity="danger" /><span>{{ event.message }}</span></header></template>
        </li>
        <li v-if="agentDryRunRunning" class="empty"><i class="pi pi-spin pi-spinner" /> Agent 正在运行，步骤会持续追加…</li>
      </ol>
      <template #footer><UiButton v-if="agentDryRunRunning" severity="danger" variant="outlined" label="取消试跑" @click="cancelAgentDryRun" /><UiButton variant="text" label="关闭" :disabled="agentDryRunRunning" @click="agentDryRunDialog = false" /><UiButton label="开始试跑" icon="pi pi-play" :loading="agentDryRunRunning" :disabled="!agentDryRunTask.trim()" @click="runAgentDryRun" /></template>
    </UiModal>
    <UiModal v-model:visible="revisionsDialog" title="配置变更历史" width="min(960px, 96vw)">
      <p class="callout"><i class="pi pi-info-circle" />每一次经 WebUI 写入的配置覆盖都记在 <code>config_revisions</code> 里（最近 500 条）。密钥类字段在写入时就已存成 <code>«redacted»</code>。</p>
      <ol class="revision-list wide-list">
        <li v-for="row in configRevisions" :key="row.id">
          <div><code>{{ row.key }}</code><small>{{ row.actor }} · {{ new Date(row.ts).toLocaleString() }}</small>
            <small class="revision-diff"><b>旧</b> {{ revisionValue(row.old_json, 'old') }}</small>
            <small class="revision-diff"><b>新</b> {{ revisionValue(row.new_json, 'new') }}</small>
          </div>
        </li>
        <li v-if="!configRevisions.length && !revisionsLoading" class="empty">还没有经 WebUI 写过任何配置覆盖。</li>
      </ol>
    </UiModal>
    <UiDrawer v-model:visible="mobileMenu" :title="botName"><nav class="mobile-nav"><button v-for="item in navigation" :key="item[0]" type="button" @click="active = item[0]; mobileMenu = false"><i :class="item[1]" />{{ item[2] }}<span v-if="item[0] === 'tasks' && pendingApprovals" class="nav-badge">{{ pendingApprovals }}</span></button></nav></UiDrawer>
  </main>
</template>
