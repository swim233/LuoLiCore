<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiTag from '../ui/UiTag.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiNumber from '../ui/UiNumber.vue';
import UiRollingNumber from '../ui/UiRollingNumber.vue';
import UiCheckbox from '../ui/UiCheckbox.vue';
import UiSwitch from '../ui/UiSwitch.vue';
import UiModal from '../ui/UiModal.vue';
import UiDrawer from '../ui/UiDrawer.vue';
import DataGrid from '../ui/DataGrid.vue';
import ChainPicker from '../ui/ChainPicker.vue';
import AttachmentStrip from '../ui/AttachmentStrip.vue';
import SchemaForm from '../ui/SchemaForm.vue';
import ExtensionsPage from './ExtensionsPage.vue';
import TasksPage from './TasksPage.vue';
import WorkerRunsPage from './WorkerRunsPage.vue';
import SdkPage from './SdkPage.vue';
// 扩展四类的行类型跟着页面一起搬走了：这一层只负责拉数据，形状由那一份定义。
import type { CustomToolRow, McpRow, PluginRow, SkillRow } from '../components/extensions/types';
import UiLineChart from '../ui/UiLineChart.vue';
import UiBarChart from '../ui/UiBarChart.vue';
import UiRing from '../ui/UiRing.vue';
import { pushToast, toastError } from '../ui/toast';
import { askConfirm } from '../ui/confirm';
import type { Attachment, GridColumn, TagSeverity } from '../ui/types';
import { api, ApiError, hydrateSession, requestLogin } from '../api/client';

interface TrendPoint { day: string; messages: number; turns: number; costUsd: number }
interface Dashboard { turns: { total: number; running: number; failed: number; cost: number }; messages: { total: number }; providers: { total: number; enabled: number }; trend?: TrendPoint[] }
interface Principal { id: string; kind: string; tgId: string; role: string; displayName: string | null; username: string | null; chatType: string | null }
interface Provider { id: string; name: string; kind: string; baseUrl?: string | null; apiKeyHint: string | null; enabled: number; healthState: string | null; healthError?: string | null }
interface ProviderTest { reachable: boolean; code: string; message: string; status: number | null; latencyMs: number; models: number }
interface CatalogMeta { match: 'provider' | 'official' | 'third-party' | 'none'; catalogProviderId: string | null; catalogProviderName: string | null; catalogModelId: string | null; normalized: boolean; priceRange: { min: number; max: number; providers: number } | null; capabilities: Record<string, boolean>; reasoningControl: string | null; reasoningEfforts: string[]; modalities: { input: string[]; output: string[] }; knowledge: string | null; releaseDate: string | null }
interface CatalogModel { modelId: string; displayName: string | null; contextWindow: number | null; maxOutput: number | null; limitSource: string | null; priceIn: number | null; priceOut: number | null; priceCacheRead: number | null; priceCacheWrite: number | null; meta: CatalogMeta | null }
interface CatalogStatus { enabled: boolean; available: boolean; stale: boolean; ageMs: number | null; ttlHours: number; models?: number; providers?: number; fetchedAt?: number; error?: string | null; outcome?: string }
/** `/api/logs` 直接输出 `log_events` 的列名，因此这里是 snake_case。此前只声明了前 6 个，
 *  于是 trace 视图读 `node.parentSpanId` / `node.durationMs` 恒为 undefined：
 *  树不缩进、每个节点都显示 0 ms，而 .vue 模板不进 `tsc --noEmit`，没有检查能拦住。 */
interface LogRow { id: number; ts: number; level: string; kind: string; summary: string; trace_id: string | null;
  span_id: string | null; parent_span_id: string | null; chat_id: string | null; user_id: string | null; key: string | null;
  duration_ms: number | null; data_bytes: number | null }

interface Chat { key: string; chatId: string; threadId: number | null; scope: string; tokens: number | null; messages: number | null }
interface Usage { id: number; ts: number; model_alias: string; input_tokens: number; output_tokens: number; cost_usd: number; ok: number }
interface Paged<T> { items: T[]; total: number; page: number; size: number }
interface Conversation { id: string; key: string; chatId: string; userId: string; role: string; state: string; triggerReason: string | null; startedAt: number | null; finishedAt: number | null;
  steps: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number; error: string | null; rebased: number; promptMessageId: number | null;
  prompt: string | null; promptKind: string | null; fromName: string | null; fromUsername: string | null; reply: string; attachments: Attachment[] }
interface MessageHit { id: number; chatId: string; direction: string; fromName: string | null; fromUsername: string | null; kind: string; text: string | null; tgDate: number; turnId: string | null; attachments: Attachment[] }
// 扁平字段是生效值，`defaults` 是代码里 `TOOL_POLICY` 那份，`relaxed` 列出比默认更宽松的字段。
// 两者都要显示：只给一个时运维看不出当前偏离默认的程度（docs/09 §3.7）。
// `sides` 由服务端按运行时判据 `toolCallableBy()` 现算（docs/09 §3.7）：主 agent 与 lw-worker
// 的可用集在这里分叉，前端不再判一遍。它与 `enabled` 正交 —— 停用是两侧都没有。
interface ToolPolicy { minRole: string; approval: string; scope: string; source: string; enabled: boolean; timeoutMs: number | null;
  selfManagedTimeout: boolean; deferred: boolean; sides?: Array<'main' | 'worker'>; defaults: { minRole: string; approval: string; timeoutMs: number | null }; relaxed: string[] }
const active = ref('dashboard');
const dashboard = ref<Dashboard>({ turns: { total: 0, running: 0, failed: 0, cost: 0 }, messages: { total: 0 }, providers: { total: 0, enabled: 0 } });
const dashboardIntroReady = ref(false);
const dashboardIntroAnimate = ref(true);
const principals = ref<Principal[]>([]);
const providers = ref<Provider[]>([]);
const logs = ref<LogRow[]>([]);
const query = ref('');
const chats = ref<Chat[]>([]);
const usage = ref<Usage[]>([]);
const skills = ref<SkillRow[]>([]);
const plugins = ref<PluginRow[]>([]);
const mcp = ref<McpRow[]>([]);
const customTools = ref<CustomToolRow[]>([]);
// 任务 / 审批 / 定时任务三份行数据整体移入 `TasksPage.vue` 的三张卡，worker 运行记录同理进了
// `WorkerRunsPage.vue`：它们各自持有服务端分页的游标，行留在这一层时页码没有存放位置。
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
/** `placeholderTexts` 在表单里是每行一条的文本域而不是数组：若要求每次输入后都是合法数组，
 *  删到只剩半行即无法继续编辑。进出各转换一次，落库的仍是数组。 */
interface OutputForm { mode: string; replyDelayMs: number; streamBufferMs: number; streamIntervalMs: number; streamMinDeltaChars: number; placeholderAfterMs: number; placeholderTexts: string; placeholderPick: string; placeholderIndex: number }
const outputForm = ref<OutputForm>({ mode: 'stream', replyDelayMs: 2000, streamBufferMs: 2000, streamIntervalMs: 2000, streamMinDeltaChars: 24, placeholderAfterMs: 4000, placeholderTexts: '…', placeholderPick: 'random', placeholderIndex: 0 });
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
const modelForm = ref({ id: '', providerId: '', modelId: '', displayName: '', contextWindow: 128000, maxOutput: 8192, priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0, enabled: true, sort: 0, vision: 'follow' as VisionMark });
const aliasDialog = ref(false);
// 别名的用途只写在 docs/04 里，运维在这个页面上看不到，因此六个内建别名常驻列表并附用途说明。
const ALIAS_GUIDE: Array<{ alias: string; purpose: string; tier: string }> = [
  { alias: 'main', purpose: '主 Agent 的默认模型，用于日常对话', tier: '中高档，对话质量优先' },
  { alias: 'high', purpose: '复杂推理与代码类 worker', tier: '最强模型' },
  { alias: 'low', purpose: '摘要、记忆压缩，以及超过 agent.main.downgradeAfterStep 后的自动降档', tier: '最便宜可用' },
  { alias: 'vision', purpose: '含图片的轮次；当前模型不支持看图时自动切换到该别名', tier: '支持 vision' },
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
  absent: { label: '未配置', severity: 'secondary', hint: '该别名尚未创建' },
  empty: { label: '链为空', severity: 'danger', hint: '未指向任何模型，视同未配置' },
  broken: { label: '不可用', severity: 'danger', hint: '链中模型已全部删除或停用' },
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
    // 存在这一行不等于可用：空链与整链失效在 registry 里同样表现为没有这个别名。
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
const aliasNameHint = computed(() => ALIAS_GUIDE.find((entry) => entry.alias === aliasName.value)?.purpose ?? '仅在被配置项（如 agent.worker.modelAlias）引用时生效');
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
  provider: { label: 'provider 自报价', severity: 'success', hint: '取自 models.dev 收录的该 provider 报价，即实际计费价' },
  official: { label: '厂商官方价', severity: 'info', hint: 'models.dev 未收录该 provider，价格取自厂商官方定价' },
  'third-party': { label: '无官方价', severity: 'warn', hint: '仅有第三方托管报价，价格不写入数据库，需手填' },
  none: { label: '目录未收录', severity: 'secondary', hint: 'models.dev 未收录该模型，窗口与价格均需手填' },
};
const catalogAge = computed(() => {
  const status = catalogStatus.value;
  if (!status?.available || status.ageMs === null || status.ageMs === undefined) return '';
  const hours = status.ageMs / 3_600_000;
  return hours < 1 ? '刚刚更新' : hours < 48 ? `${Math.round(hours)} 小时前更新` : `${Math.round(hours / 24)} 天前更新`;
});
/**
 * 模型是否读得到图片，是 `capabilities_json` 里唯一具有运行时行为的能力位：含图轮次
 * 据它自动切换 `vision` 别名。而它来自 models.dev 按模型名的匹配，中转站照搬官方模型名却不实际
 * 转发图片时，继承的 `vision:true` 会让那一轮不切换别名，图片留在一个读不到它的模型上。
 * 因此这里提供跟随目录 / 人工强制的三态；标记落在 `capabilities_json.manual.vision`。
 */
type VisionMark = 'follow' | 'on' | 'off';
const VISION_MARKS: Array<{ value: VisionMark; label: string }> = [
  { value: 'follow', label: '跟随目录判断（默认）' },
  { value: 'on', label: '强制：能看图' },
  { value: 'off', label: '强制：看不了图' },
];
/** 已入库那一行上人工标记的看图能力；没标过是 `follow`。徽标与表单共用这一份判据。 */
const manualVision = (model: Record<string, unknown>): VisionMark => {
  try {
    const manual = (JSON.parse(String(model.capabilities_json ?? '{}')) as { manual?: { vision?: unknown } }).manual;
    return manual?.vision === true ? 'on' : manual?.vision === false ? 'off' : 'follow';
  } catch { return 'follow'; }
};
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
/** 模型表那一列只有几个字符宽，1000000 这类原值会把列撑开：≥ 1M 记 M（保留小数），其余记 k（取整）。
    单位为空即无值，底衬不出，只留一个 `—`。 */
const windowMetric = (value: unknown): { num: string; unit: string } => {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return { num: '—', unit: '' };
  return tokens >= 1_000_000
    ? { num: String(Number((tokens / 1_000_000).toFixed(2))), unit: 'M' }
    : { num: String(Math.round(tokens / 1000)), unit: 'k' };
};
const priceMetric = (value: unknown): { num: string; unit: string } => (value === null || value === undefined || value === '' ? { num: '—', unit: '' } : { num: String(value), unit: '$' });
const metricText = (metric: { num: string; unit: string }): string => (metric.unit ? `${metric.num} ${metric.unit}` : metric.num);
/** 同列底衬等宽：取该列最长的一条。底衬走等宽字体，一个字符恰好一个 `ch`，无需实测。 */
const metricWidth = (metrics: Array<{ num: string; unit: string }>): string => `${metrics.reduce((widest, metric) => Math.max(widest, metricText(metric).length), 0)}ch`;
const modelMetricWidths = computed(() => ({
  window: metricWidth(models.value.map((model) => windowMetric(model.context_window))),
  priceIn: metricWidth(models.value.map((model) => priceMetric(model.price_in))),
  priceOut: metricWidth(models.value.map((model) => priceMetric(model.price_out))),
}));
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
let eventStream: EventSource | null = null;
const navigationSections = [
  { label: '工作区', eyebrow: 'OPERATIONS', items: [
    ['dashboard', 'pi pi-chart-bar', '总览'], ['chats', 'pi pi-comments', '会话'],
    ['messages', 'pi pi-search', '消息'], ['prompts', 'pi pi-align-left', '提示词'],
  ] },
  { label: '资源', eyebrow: 'RESOURCES', items: [
    ['providers', 'pi pi-sparkles', '模型'], ['principals', 'pi pi-users', '主体'],
    ['tools', 'pi pi-wrench', '工具'], ['extensions', 'pi pi-box', '扩展'],
    ['workers', 'pi pi-sitemap', 'Worker'], ['sdk', 'pi pi-key', 'SDK 接入'],
  ] },
  { label: '观测', eyebrow: 'OBSERVABILITY', items: [
    ['logs', 'pi pi-list', '日志'], ['usage', 'pi pi-wallet', '用量'], ['quota', 'pi pi-gauge', '配额'],
  ] },
  { label: '管理', eyebrow: 'GOVERNANCE', items: [
    ['tasks', 'pi pi-check-square', '任务与审批'], ['settings', 'pi pi-cog', '设置'],
  ] },
] as const;
const navigation = navigationSections.flatMap(({ items }) => items);
const currentNavigation = computed(() => navigation.find(([key]) => key === active.value));
const currentLabel = computed(() => currentNavigation.value?.[2] ?? '总览');
const currentEyebrow = computed(() => navigationSections.find(({ items }) => items.some(([key]) => key === active.value))?.eyebrow ?? 'OPERATIONS');
/**
 * 每一条 pending 都对应一个正阻塞在工具调用上的真实轮次，因此角标挂在导航上而不是只在任务页里。
 *
 * `/api/approvals` 分页之后，这个数不能再由当前页统计得出：翻到第 2 页角标就会变化，
 * 而 `AC-WEB-049` 要求不切到任务页也能看到还有几条在等待。信封里的 `pending` 是
 * 服务端全表 `COUNT(*)`，因此这里只取一行、只读该字段。
 */
const pendingApprovals = ref(0);
async function loadApprovalBadge(): Promise<void> {
  const result = await api<{ pending?: number }>('/api/approvals?page=1&size=1');
  pendingApprovals.value = Number(result?.pending ?? 0);
}
/** 任务页的「该重拉了」脉冲。三张卡各自 `watch` 它，父层不碰它们的行数据与页码。 */
const tick = ref(0);
/** Worker 运行记录页的同一种脉冲。与 `tick` 分开：两页的可见性判据不同，合用会让看不见的那页白刷。 */
const workerTick = ref(0);
const COLUMNS = {
  tools: [{ key: 'name', header: '工具' }, { key: 'source', header: '来源', width: '7rem' }, { key: 'sides', header: '可达侧', width: '8rem' }, { key: 'minRole', header: '最低角色', width: '8rem' }, { key: 'approval', header: '审批', width: '9rem' }, { key: 'scope', header: '作用域', width: '8rem' }, { key: 'enabled', header: '状态', width: '8rem' }],
  hits: [{ key: 'tgDate', header: '时间', width: '12rem' }, { key: 'chatId', header: '会话', width: '9rem' }, { key: 'from', header: '发言人', width: '10rem' }, { key: 'text', header: '内容' }, { key: 'detail', header: '操作', width: '8rem' }],
  usage: [{ key: 'ts', header: '时间', width: '13rem' }, { key: 'model_alias', header: '别名' }, { key: 'input_tokens', header: '输入' }, { key: 'output_tokens', header: '输出' }, { key: 'cost_usd', header: '成本' }],
  principals: [{ key: 'kind', header: '类型' }, { key: 'displayName', header: '显示名' }, { key: 'tgId', header: 'Telegram ID' }, { key: 'role', header: '角色', width: '9rem' }, { key: 'username', header: '用户名' }],
  models: [{ key: 'model_id', header: '模型 ID' }, { key: 'provider_id', header: 'Provider' }, { key: 'context_window', header: '上下文窗口', align: 'right' }, { key: 'capabilities', header: '能力' }, { key: 'price_in', header: '输入价格', align: 'right' }, { key: 'price_out', header: '输出价格', align: 'right' }, { key: 'enabled', header: '启用', width: '6rem' }, { key: 'actions', header: '操作', width: '4rem' }],
  logs: [{ key: 'ts', header: '时间', width: '13rem' }, { key: 'level', header: '级别', width: '7rem' }, { key: 'kind', header: '事件' }, { key: 'summary', header: '摘要' }, { key: 'data_bytes', header: '载荷', width: '6rem' }, { key: 'trace_id', header: 'Trace' }],
  // tasks / schedules / approvals 三套跟着那三张卡搬进 `components/tasks/types.ts`。
  containers: [{ key: 'chat', header: '会话' }, { key: 'name', header: '容器', width: '14rem' }, { key: 'used', header: '上次用 / 次数', width: '13rem' }, { key: 'expires', header: '还剩', width: '8rem' }, { key: 'actions', header: '操作', width: '17rem' }],
  activeTurns: [{ key: 'who', header: '发起人' }, { key: 'chat', header: '会话' }, { key: 'progress', header: '当前动作' }, { key: 'stats', header: '步数 / 成本', width: '11rem' }, { key: 'elapsed', header: '已用时长', width: '8rem' }, { key: 'actions', header: '操作', width: '6rem' }],
  catalog: [{ key: 'modelId', header: '模型 ID' }, { key: 'limits', header: '窗口 / 最大输出', width: '11rem' }, { key: 'price', header: '价格 / M token', width: '13rem' }, { key: 'capabilities', header: '能力' }, { key: 'status', header: '状态', width: '7rem' }],
  fallback: [{ key: 'kind', header: '关联事件' }, { key: 'summary', header: '最近状态' }, { key: 'level', header: '级别' }],
} satisfies Record<string, GridColumn[]>;

async function load(): Promise<void> {
  // 位置解构：左右两串必须逐项对齐，错一位即整片数据错位（且类型均为 `any` 级，没有检查能拦住）。
  [dashboard.value, principals.value, providers.value, logs.value, chats.value, usage.value, skills.value, plugins.value, mcp.value, customTools.value, tools.value, prompts.value, config.value, models.value, aliases.value, health.value] = await Promise.all([
    api<Dashboard>('/api/dashboard'), api<Principal[]>('/api/principals'), api<Provider[]>('/api/providers'), api<LogRow[]>('/api/logs'),
    api<Chat[]>('/api/chats'), api<Usage[]>('/api/usage'), api<SkillRow[]>('/api/skills'), api<PluginRow[]>('/api/plugins'), api<McpRow[]>('/api/mcp'),
    // 没装配自撰写工具的部署会回 not_implemented，那不该把另外 15 个端点一起带下去。
    api<CustomToolRow[]>('/api/custom-tools').catch(() => []), api<Record<string, ToolPolicy>>('/api/tools'),
    api<Array<Record<string, unknown>>>('/api/prompts'), api<Record<string, unknown>>('/api/config'), api<Array<Record<string, unknown>>>('/api/models'), api<Array<Record<string, unknown>>>('/api/aliases'),
    api<HealthDetail>('/api/health/detail'),
  ]);
  dashboardIntroReady.value = true;
  // 动画只属于刷新后的首屏。下一帧解除武装；切换页面再返回时直接显示当前数据。
  window.requestAnimationFrame(() => { dashboardIntroAnimate.value = false; });
  // 总览页那张「最近错误」卡片走单独一次请求：日志页要的是全量流，卡片要的是 warn 以上的十条，
  // 在前端过滤会因为日志页只取了最近 200 条而漏掉更早的错误。
  recentErrors.value = await api<LogRow[]>('/api/logs?minLevel=warn&size=10');
  recentErrorsLoaded.value = true;
  // 总览的额度环和配额页读的是同一个端点。失败不该把整个总览页带下去 —— 配额关掉时它本来就是空的。
  await Promise.all([loadQuota().catch(() => undefined), loadUsageReport()]);
  // 导航角标：任务页的三份数据由那三张卡自己拉，但这个数不切页也要看得见（AC-WEB-049）。
  await loadApprovalBadge().catch(() => undefined);
  // 容器面板：没装配持久容器运行时的部署回 not_implemented，面板说明白而不是显示零个容器。
  await loadContainers().catch(() => undefined);
  syncTrigger();
  syncOutput();
  syncBotName();
}
/** `general.name` 从这里生效：侧栏品牌名与浏览器标签页标题都随之变化。运维为 bot 设置了名称
 *  却在控制台上看到「LuoLiCore」，说明这个键仍未接线（docs/20 · W-CFG-02 指的正是它）。 */
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
  // 逐项取而不是整体展开：output 下还有五个不归这张表管的键（parseMode、maxMessageChars…），
  // 展开进来只会在保存时被悄悄丢掉。
  outputForm.value = { mode: String(output.mode ?? current.mode), replyDelayMs: Number(output.replyDelayMs ?? current.replyDelayMs),
    streamBufferMs: Number(output.streamBufferMs ?? current.streamBufferMs), streamIntervalMs: Number(output.streamIntervalMs ?? current.streamIntervalMs),
    streamMinDeltaChars: Number(output.streamMinDeltaChars ?? current.streamMinDeltaChars),
    placeholderAfterMs: Number(output.placeholderAfterMs ?? current.placeholderAfterMs),
    // 空数组要如实变成空文本域（那正是「不发占位消息」），所以判的是 isArray 而不是 `?? current`。
    placeholderTexts: Array.isArray(output.placeholderTexts) ? (output.placeholderTexts as unknown[]).map(String).join('\n') : current.placeholderTexts,
    placeholderPick: String(output.placeholderPick ?? current.placeholderPick), placeholderIndex: Number(output.placeholderIndex ?? current.placeholderIndex) };
}
function markOutputDirty(): void { outputDirty.value = true; }
type OutputNumber = 'replyDelayMs' | 'streamBufferMs' | 'streamIntervalMs' | 'streamMinDeltaChars' | 'placeholderAfterMs' | 'placeholderIndex';
function changeOutputNumber(field: OutputNumber, value: number | null): void { outputForm.value[field] = value ?? 0; markOutputDirty(); }
/** 保存时即过滤空行，落库的数组因此没有空洞：placeholderIndex 计的是去掉空行后的序号，
 *  两侧不一致时界面上显示的那一条与实际发出的会相差一位。 */
const placeholderList = computed(() => outputForm.value.placeholderTexts.split('\n').map((line) => line.trim()).filter(Boolean));
const placeholderPreview = computed(() => {
  const list = placeholderList.value;
  if (!list.length) return '列表为空：不发送占位消息，这是唯一停用方式（延迟不接受 0）。';
  if (outputForm.value.placeholderPick !== 'fixed') return `随机：每轮从 ${list.length} 条中选一条。`;
  // 越界回落到第一条，与 pickPlaceholder 一致：这里若写成 clamp 到末条，界面预览的与
  // 实际发出的会是两条不同的文案。
  const raw = outputForm.value.placeholderIndex;
  const index = raw >= 0 && raw < list.length ? raw : 0;
  return `固定：始终发送「${list[index]}」${index === raw ? '' : `（下标 ${raw} 越界，回落到第一条）`}`;
});
/** 模型元数据没有留空即不设置这一档（窗口、价格都是必填的 number）：清空按 0 处理，由服务端那道
 *  zod 判定该值是否合法；这优于把 null 放进 JSON body，后者只会返回一条与界面对不上的路径报错。 */
type ModelNumber = 'contextWindow' | 'maxOutput' | 'sort' | 'priceIn' | 'priceOut' | 'priceCacheRead' | 'priceCacheWrite';
function changeModelNumber(field: ModelNumber, value: number | null): void { modelForm.value[field] = value ?? 0; }
function changeCatalogDefault(field: 'contextWindow' | 'maxOutput', value: number | null): void { catalogDefaults.value[field] = value ?? 0; }
async function saveOutput(): Promise<void> {
  const form = outputForm.value;
  outputSaving.value = true;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'output.mode': form.mode, 'output.replyDelayMs': form.replyDelayMs,
      'output.streamBufferMs': form.streamBufferMs, 'output.streamIntervalMs': form.streamIntervalMs, 'output.streamMinDeltaChars': form.streamMinDeltaChars,
      'output.placeholderAfterMs': form.placeholderAfterMs, 'output.placeholderTexts': placeholderList.value,
      'output.placeholderPick': form.placeholderPick, 'output.placeholderIndex': form.placeholderIndex }) });
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
    // 服务端如实返回 `cleared`，此前该字段未被使用：视图陈旧时（另一个标签页、另一个运维，或期间
    // 从 Telegram 侧 `/model` 清除过）点下去，`app_kv` 里本就没有行，界面仍提示已清除，
    // 这与摘除比伪造安全相反（docs/29 · M-WEB-07）。
    const { cleared } = await api<{ cleared: boolean }>(`/api/chats/${encodeURIComponent(chat.key)}/model-alias`, { method: 'DELETE' });
    chatModelAlias.value = null;
    pushToast(cleared
      ? { severity: 'success', summary: '已清除会话模型别名', detail: '回到覆盖层 / 全局的 agent.main.modelAlias，下一轮生效' }
      : { severity: 'info', summary: '该会话没有会话级别名', detail: '当前使用覆盖层 / 全局的 agent.main.modelAlias' });
  } catch (error) { toastError('清除会话模型别名失败', error); }
}
async function inspectTrace(traceId: string | null): Promise<void> { if (!traceId) return; traceDetail.value = await api<LogRow[]>(`/api/logs/trace/${encodeURIComponent(traceId)}`); }

/**
 * 按 `parentSpanId` 链计算真实 depth（`docs/10 §1`：WebUI Trace 视图按 `parent_span_id` 重建树）。
 *
 * 此前 trace 视图不是树，而是 `marginLeft: node.parent_span_id ? '24px' : '0'`，只有一级。
 * 该写法在 `parent_span_id` 全库为 NULL 的时期看不出问题（13 个节点全是 `0px`），
 * 现在父边已真正连上，一级缩进会把 `agent.run` 下面那三层压成同一层（docs/28 · L-LOG-04）。
 *
 * 环与悬挂父都要处理：一次查询只取 500 行，子 span 的父完全可能不在这一页里；而一条损坏数据
 * （父指向自身，或两个 span 互指）不应让整个视图变成空白。两者一律按 depth 0 渲染。
 * `.vue` 模板不进 `tsc --noEmit`（本文件开头那段注释已说明该问题造成过故障），因此判据由
 * `tests/webui/console.render.test.ts` 约束。
 */
const TRACE_MAX_DEPTH = 12;
function traceDepths<T extends { span_id?: string | null; spanId?: string | null; parent_span_id?: string | null; parentSpanId?: string | null }>(nodes: readonly T[]): number[] {
  const spanOf = (node: T): string | null => node.span_id ?? node.spanId ?? null;
  const parentOf = (node: T): string | null => node.parent_span_id ?? node.parentSpanId ?? null;
  const bySpan = new Map<string, T>();
  for (const node of nodes) { const id = spanOf(node); if (id && !bySpan.has(id)) bySpan.set(id, node); }
  return nodes.map((node) => {
    let depth = 0;
    const seen = new Set<string>();
    const own = spanOf(node);
    if (own) seen.add(own);
    let parent = parentOf(node);
    while (parent && depth < TRACE_MAX_DEPTH) {
      if (seen.has(parent)) return 0;            // 环：这一段数据已损坏，不缩进
      const next = bySpan.get(parent);
      if (!next) break;                          // 悬挂父（不在这一页里）：按当前深度收尾
      seen.add(parent);
      depth += 1;
      parent = parentOf(next);
    }
    return depth;
  });
}
/** `traceDepths` 的结果按下标对齐 `traceDetail`，模板直接按 index 取。 */
const traceIndent = computed(() => traceDepths(traceDetail.value));
/**
 * 日志行的详情。此前点击一行只会重建 trace，`trace_id` 为空的那些（`system.start`、
 * `config.changed`、`maintenance.*`、`webui.action`）点击后没有任何反应；有 trace 的也只得到
 * 一串 kind/summary，`data_json` 从未展示。载荷单独取一次而不是从列表行取：列表已不携带它。
 */
interface LogDetail { id: number; ts: number; level: string; kind: string; summary: string; traceId: string | null; spanId: string | null;
  parentSpanId: string | null; chatId: string | null; userId: string | null; key: string | null; durationMs: number | null;
  text: string | null; bytes: number; truncated: boolean }
const logDialog = ref(false);
const logLoading = ref(false);
const logDetail = ref<LogDetail | null>(null);
async function openLogDetail(row: LogRow): Promise<void> {
  logDialog.value = true; logLoading.value = true; logDetail.value = null;
  try { logDetail.value = await api<LogDetail>(`/api/logs/${row.id}`); }
  catch (error) { toastError('加载日志详情失败', error); logDialog.value = false; }
  finally { logLoading.value = false; }
}
async function copyLogDetail(): Promise<void> {
  const entry = logDetail.value;
  if (!entry) return;
  try {
    let text = entry.text ?? '';
    if (entry.truncated) { const response = await fetch(`/api/logs/${entry.id}/data`); if (!response.ok) throw new Error(`取完整载荷失败：HTTP ${response.status}`); text = await response.text(); }
    await navigator.clipboard.writeText(text);
    pushToast({ severity: 'success', summary: '已复制完整 JSON', detail: `${entry.kind} · ${formatBytes(entry.bytes)}` });
  } catch (error) { toastError('复制失败', error); }
}
// 提示词文档以前是一张 id/scope/bytes/updated_at 的四列表格：光看 `character:global` 这种 id
// 认不出哪块是人格、哪块是助理守则，也看不出它进的是 prompt 的第几个 block。改成卡片，把用途写在脸上。
interface PromptMeta { label: string; icon: string; purpose: string; severity: TagSeverity }
const PROMPT_SCOPES: Record<string, PromptMeta> = {
  character: { label: '人格', icon: 'pi pi-user', purpose: 'block 1 · 人格设定；带会话后缀的是该会话专属覆盖', severity: 'info' },
  assist: { label: '助理守则', icon: 'pi pi-book', purpose: 'block 2 · 回答风格与业务约束，所有会话共用', severity: 'secondary' },
  pubmemory: { label: '公共记忆', icon: 'pi pi-globe', purpose: 'block 4 · 公共长期记忆，模型经 memory_write 写入', severity: 'success' },
  primemory: { label: '私有记忆', icon: 'pi pi-lock', purpose: 'block 5 · 用户私有；查看他人的会被记录', severity: 'warn' },
};
const promptMeta = (scope: unknown): PromptMeta => PROMPT_SCOPES[String(scope)] ?? { label: String(scope ?? '未知'), icon: 'pi pi-file', purpose: '未归类的文档', severity: 'secondary' };
const promptRank = (scope: unknown): number => { const index = Object.keys(PROMPT_SCOPES).indexOf(String(scope)); return index === -1 ? Object.keys(PROMPT_SCOPES).length : index; };
const promptCards = computed(() => [...prompts.value].sort((left, right) => promptRank(left.scope) - promptRank(right.scope) || String(left.id).localeCompare(String(right.id))));
// 下面这组上下文 / 提示词操作此前用顶栏静态横幅报成功、失败时不显示任何内容；现在统一走同一个通知通道（AC-WEB-023）。
// `inspectPrompt` 曾是遗漏的那个：没有 catch，`api()` 抛出的 promise 无人处理，点击卡片没有反应，
// 权限、路径、文件被删一律表现为点击无反应（docs/29 · M-WEB-08）。
async function inspectPrompt(row: Record<string, unknown>): Promise<void> {
  try {
    selectedPrompt.value = await api<Record<string, unknown>>(`/api/prompts/${encodeURIComponent(String(row.id))}`);
    promptContent.value = String(selectedPrompt.value.content ?? '');
    promptRevisions.value = await api<Array<Record<string, unknown>>>(`/api/prompts/${encodeURIComponent(String(row.id))}/revisions`);
  } catch (error) { toastError('打开提示词失败', error); }
}
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
/**
 * 等同 Telegram 的 /new：插入一条 reset commit 把窗口起点推到最新 ordinal 之后，不删除任何消息。
 *
 * 回执要说明清空的是窗口还是记忆：归档表不受窗口约束，`read_messages` 照旧读得到清空之前的内容
 * （实测清空后模型第一步就取回了 20 条历史）。判据取自服务端刚写下的那条 commit 的
 * `meta.advancedClaims`（`context.recallBarrier` 的落地痕迹），不在前端另行推断配置。
 */
function resetContext(): void {
  const chat = selectedChat.value;
  if (!chat) return;
  askConfirm(`清空「${chatIdentity(chat).name}」的上下文窗口？`, '此前对话不再进入上下文；消息与提交历史保留，可用「回滚到此」回退。', async () => {
    try {
      const commit = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chat.key)}/reset`, { method: 'POST' });
      let barred = false;
      try { barred = (JSON.parse(String(commit.meta ?? '{}')) as { advancedClaims?: unknown }).advancedClaims === true; } catch { /* 老 commit 没有 meta */ }
      pushToast({ severity: 'success', summary: '上下文窗口已清空',
        detail: `${chatIdentity(chat).name} · ${barred ? '归档检索同样以此刻为界' : '模型仍可用 read_messages 读取更早的消息（context.recallBarrier 可关闭）'}` });
      await inspectChat(chat);
      await load();
    } catch (error) { toastError('清空上下文窗口失败', error); }
  });
}
/** 等同 /undo：done 指针退回父 commit。被跳过的 commit 仍留在时间线上，可以再「回滚到此」走回去。 */
async function undoContext(): Promise<void> {
  const chat = selectedChat.value;
  if (!chat) return;
  try {
    const moved = await api<Record<string, unknown> | null>(`/api/chats/${encodeURIComponent(chat.key)}/undo`, { method: 'POST' });
    if (!moved) { pushToast({ severity: 'warn', summary: '没有可撤回的提交', detail: '当前 HEAD 已是第一个 commit' }); return; }
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
  if (!form.id) { pushToast({ severity: 'warn', summary: '请先保存 Provider', detail: '保存后即可用当前 key 测试', life: 6000 }); return; }
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
  if (!catalogProviderId.value) { catalogModels.value = []; catalogError.value = '尚无 Provider'; return; }
  catalogLoading.value = true;
  try {
    const result = await api<{ models: CatalogModel[]; catalog: CatalogStatus }>(`/api/providers/${encodeURIComponent(catalogProviderId.value)}/models`);
    catalogModels.value = result.models; catalogStatus.value = result.catalog;
    if (!catalogModels.value.length) catalogError.value = '上游未返回模型';
  } catch (error) { catalogModels.value = []; catalogError.value = error instanceof Error ? error.message : '拉取失败'; toastError('拉取模型列表失败', error); }
  finally { catalogLoading.value = false; }
}
/** 元数据目录本身的刷新：平时按 TTL 走条件请求，这个按钮是「我知道上游刚上新模型」时的手动通道。 */
async function refreshCatalog(): Promise<void> {
  catalogRefreshing.value = true;
  try {
    const status = await api<CatalogStatus>('/api/models/catalog/refresh', { method: 'POST', body: '{}' });
    catalogStatus.value = status;
    if (status.outcome === 'stale') pushToast({ severity: 'warn', summary: '刷新失败，沿用本地缓存', detail: status.error ?? '', life: 7000 });
    else pushToast({ severity: 'success', summary: status.outcome === 'not-modified' ? 'models.dev 无更新' : `目录已更新：${status.models ?? 0} 个模型`, detail: `${status.providers ?? 0} 家 provider` });
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
      detail: `新填价格 ${result.priced} 个${result.unmatched ? `，${result.unmatched} 个 models.dev 查不到，需手填` : ''}。`, life: 8000 });
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
      detail: `${result.skipped ? `${result.skipped} 个已存在，已跳过。` : ''}${result.priced} 个已带价格${blank ? `，${blank} 个价格留空，未补齐前成本按 0 记账` : ''}。`, life: 8000 });
    catalogSelection.value = [];
    await load();
  } catch (error) { toastError('导入模型失败', error); }
}
/**
 * 删除 provider。名下仍有模型时服务端返回 409 `provider_has_models`，这不是错误而是一个分支：
 * 删除这个 provider 与连同它名下 N 行已调好定价与能力位的模型一起删除，不是同一个决定，
 * 因此这里接住 409 并转成一次确认，而不是直接提示失败（此前是裸 `DELETE` 触发外键约束返回 500
 * 服务端出错、已记录，给不出原因，docs/29 · M-WEB-05）。
 */
async function deleteProvider(id: string, cascade: boolean): Promise<void> {
  const done = await api<{ models: number; aliases: Array<{ alias: string; emptied: boolean }> }>(
    `/api/providers/${encodeURIComponent(id)}${cascade ? '?cascade=1' : ''}`, { method: 'DELETE' });
  const emptied = done.aliases?.filter((entry) => entry.emptied).map((entry) => entry.alias) ?? [];
  pushToast({ severity: emptied.length ? 'warn' : 'success', summary: 'Provider 已删除',
    detail: [done.models ? `连同 ${done.models} 个模型` : '', emptied.length ? `别名 ${emptied.join('、')} 的链已空，整条别名已删除` : ''].filter(Boolean).join(' · ') || undefined,
    life: emptied.length ? 0 : 4000 });
  await load();
}
function removeProvider(id: string): void {
  void (async () => {
    try { await deleteProvider(id, false); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'provider_has_models') { toastError('删除失败', error); return; }
      askConfirm('该 Provider 名下仍有模型', `${error.message}\n\n将一并删除这些模型行，并清除别名链中指向它们的段；链被清空的别名整行删除。不可撤销。`,
        async () => { try { await deleteProvider(id, true); } catch (nested) { toastError('删除失败', nested); } });
    }
  })();
}
function removeModel(id: string, label: string): void {
  askConfirm(`删除模型 ${label}？`, '别名链中指向它的段一并清除，链被清空的别名整行删除。不可撤销。', async () => {
    try {
      const done = await api<{ aliases: Array<{ alias: string; emptied: boolean }> }>(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const emptied = done.aliases?.filter((entry) => entry.emptied).map((entry) => entry.alias) ?? [];
      pushToast({ severity: emptied.length ? 'warn' : 'success', summary: '模型已删除', detail: emptied.length ? `别名 ${emptied.join('、')} 的链已空，整条别名已删除` : label, life: emptied.length ? 0 : 4000 });
      await load();
    } catch (error) { toastError('删除模型失败', error); }
  });
}
function editModel(model?: Record<string, unknown>): void { modelForm.value = model ? { id: String(model.id), providerId: String(model.provider_id), modelId: String(model.model_id), displayName: String(model.display_name ?? ''), contextWindow: Number(model.context_window), maxOutput: Number(model.max_output), priceIn: Number(model.price_in ?? 0), priceOut: Number(model.price_out ?? 0), priceCacheRead: Number(model.price_cache_read ?? 0), priceCacheWrite: Number(model.price_cache_write ?? 0), enabled: Boolean(model.enabled), sort: Number(model.sort ?? 0), vision: manualVision(model) } : { id: '', providerId: providers.value[0]?.id ?? '', modelId: '', displayName: '', contextWindow: 128000, maxOutput: 8192, priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0, enabled: true, sort: 0, vision: 'follow' }; modelDialog.value = true; }
async function saveModel(): Promise<void> {
  const { vision, ...form } = modelForm.value;
  const mark = vision === 'follow' ? null : vision === 'on';
  // 改已有行时 `follow` 要发 `null`（表示取消标记）而不是省略这个键，否则标错后无法在界面上撤回：
  // 省略与跟随目录在服务端是两种语义。新建时相反：未标记时不在能力块里留空键。
  const body = form.id ? { ...form, capabilities: { vision: mark } } : mark === null ? form : { ...form, capabilities: { vision: mark } };
  try { await api(form.id ? `/api/models/${encodeURIComponent(form.id)}` : '/api/models', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); modelDialog.value = false; pushToast({ severity: 'success', summary: '模型配置已保存', detail: form.modelId }); await load(); } catch (error) { toastError('保存模型失败', error); }
}
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
function removeAlias(alias: string): void {
  askConfirm(`删除别名 ${alias}？`, '引用该别名的位置回退到 main。', async () => {
    try { await api(`/api/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `别名 ${alias} 已删除` }); await load(); }
    catch (error) { toastError('删除别名失败', error); }
  });
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
// ── 一条归档消息的原始载荷（docs/29 · M-WEB-06）─────────────────────────────────
// `messages.raw_json` 从 `0001_init.sql` 起就在写，而在此之前全仓没有一处读它（`get_message`
// 也没有：`MESSAGE_COLUMNS` 里就没有这一列），排查 Telegram 实际发来了什么在界面上
// 没有任何入口。渲染的是入库时脱敏过的那份，不是原始 update 的逐字副本。
interface MessageRaw { id: number; chatId: string; tgMessageId: number; kind: string; tgDate: number; text: string | null; rawJson: string | null }
const rawDialog = ref(false);
const rawLoading = ref(false);
const rawDetail = ref<MessageRaw | null>(null);
/** 损坏的 JSON 原样显示而不是显示为没有载荷：手工改过库的行同样要可见（摘除比伪造安全）。 */
const rawPretty = computed(() => {
  const stored = rawDetail.value?.rawJson;
  if (!stored) return '';
  try { return JSON.stringify(JSON.parse(stored), null, 2); } catch { return stored; }
});
async function inspectRaw(id: number): Promise<void> {
  rawDialog.value = true; rawLoading.value = true; rawDetail.value = null;
  try { rawDetail.value = await api<MessageRaw>(`/api/messages/${id}`); }
  catch (error) { toastError('读取原始载荷失败', error); rawDialog.value = false; }
  finally { rawLoading.value = false; }
}
async function copyRaw(): Promise<void> {
  try { await navigator.clipboard.writeText(rawPretty.value); pushToast({ severity: 'success', summary: '原始载荷已复制', detail: `message #${rawDetail.value?.id}` }); }
  catch (error) { toastError('复制失败', error); }
}
function softDeleteMessage(id: number, label: string): void {
  askConfirm(`软删除${label}？`, '归档正文从检索与对话列表隐藏；上下文提交、turn 与附件保留。', async () => {
    try {
      const result = await api<{ changes: number }>(`/api/messages/${id}`, { method: 'DELETE' });
      if (searchHits.value) searchHits.value = searchHits.value.filter((entry) => entry.id !== id);
      await loadConversations();
      pushToast(result.changes
        ? { severity: 'success', summary: '归档消息已软删除', detail: `message #${id}` }
        : { severity: 'warn', summary: '该消息已被删除', detail: `message #${id}` });
    } catch (error) { toastError('软删除失败', error); }
  });
}

// ── 对话详情：这一轮实际发给上游的 JSON ──────────────────────────────────────
// 只有日志里那一份是真的：turns 表存统计、messages 表存最终文本，两者都看不出请求体长什么样。
interface DetailEvent { id: number; ts: number; level: string; kind: string; summary: string; spanId: string | null; parentSpanId: string | null; durationMs: number | null;
  text: string | null; bytes: number; truncated: boolean }
/** 这一轮写进上下文的消息，`parts` 是原始 parts_json（未经过 elidePart）。 */
interface DetailContextMessage { ordinal: number; id: string; role: string; origin: string; pruneLevel: number; pruneApplied: boolean;
  textPreview: string | null; tokens: number; createdAt: number; text: string | null; bytes: number; truncated: boolean }
interface TurnDetail { turn: Record<string, unknown>; captureBodies: boolean; events: DetailEvent[]; contextMessages: DetailContextMessage[] }
// `parts` 单列一组而不是混进 events：它的来源是 context_messages 而不是 log_events —— 日志按
// retentionDays 清掉之后、或 captureBodies 关掉时，这一组是工具输入唯一还看得见的地方。
const DETAIL_GROUPS = [['model', '模型调用'], ['tool', '工具与沙箱'], ['parts', '工具输入输出'], ['other', '轮次与上下文'], ['all', '全部']] as const;
type DetailGroup = typeof DETAIL_GROUPS[number][0];
const detailDialog = ref(false);
const detailLoading = ref(false);
const detailTurnId = ref('');
const detail = ref<TurnDetail | null>(null);
const detailGroup = ref<DetailGroup>('model');
const expandedEvents = ref(new Set<number>());
const expandedParts = ref(new Set<number>());
function eventGroup(kind: string): Exclude<DetailGroup, 'all' | 'parts'> {
  if (kind.startsWith('model.') || kind.startsWith('provider.')) return 'model';
  if (kind.startsWith('tool.') || kind.startsWith('sandbox.') || kind.startsWith('approval.') || kind.startsWith('agent.')) return 'tool';
  return 'other';
}
const detailEvents = computed(() => detailGroup.value === 'parts' ? []
  : (detail.value?.events ?? []).filter((entry) => detailGroup.value === 'all' || eventGroup(entry.kind) === detailGroup.value));
/**
 * 对话详情里的缩进：depth 按整轮的父链计算（`detail.events` 那份完整列表），而不是按当前分组
 * 计算：分组过滤掉中间层之后，`agent.run` 之下的 `model.call` 会因找不到父而回落到 depth 0，
 * 那正是形似树、实为平表的另一种形态（docs/28 · L-LOG-04）。
 */
const detailDepths = computed(() => {
  const depths = traceDepths(detail.value?.events ?? []);
  return new Map((detail.value?.events ?? []).map((entry, index) => [entry.id, depths[index] ?? 0]));
});
const detailParts = computed(() => (detail.value?.contextMessages ?? []).filter((entry) => entry.origin === 'tool_call' || entry.origin === 'tool_result'));
const detailCount = (group: DetailGroup): number => group === 'parts' ? detailParts.value.length
  : (detail.value?.events ?? []).filter((entry) => group === 'all' || eventGroup(entry.kind) === group).length;
/** 1024 进制。此前只到 MB，而系统信息里的 DB 与 workspace 占用都可能达到 GB：停在 MB 会出现
 *  12800.0 MB 这种难以判断量级的数字。undefined 显示为 —（端点未返回，而不是 0 字节）。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
async function openDetail(turnId: string): Promise<void> {
  detailTurnId.value = turnId; detailDialog.value = true; detailLoading.value = true; detail.value = null;
  expandedEvents.value = new Set(); expandedParts.value = new Set(); detailGroup.value = 'model';
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
function togglePart(ordinal: number): void { const next = new Set(expandedParts.value); if (next.has(ordinal)) next.delete(ordinal); else next.add(ordinal); expandedParts.value = next; }
/** 复制的必须是完整那份：界面上显示的可能被 DETAIL_MAX_CHARS 截断，粘贴出去即不是合法 JSON。 */
async function copyEvent(event: DetailEvent): Promise<void> {
  try {
    let text = event.text ?? '';
    if (event.truncated) { const response = await fetch(`/api/logs/${event.id}/data`); if (!response.ok) throw new Error(`取完整载荷失败：HTTP ${response.status}`); text = await response.text(); }
    await navigator.clipboard.writeText(text);
    pushToast({ severity: 'success', summary: '已复制完整 JSON', detail: `${event.kind} · ${formatBytes(event.bytes)}` });
  } catch (error) { toastError('复制失败', error); }
}

// ── 主体：用户 / 群与频道分开看，角色改动走二级菜单 ────────────────────────
/**
 * `principals.kind` 只有 `user` / `chat` 两个取值，而 `chat` 表示一个 Telegram 会话，不等于群。
 * 私聊如今只占 `user:` 一行，但旧库里仍可能留着 `chat:<用户 id>` 的残留行 —— 此前这一页把 kind
 * 直接当标签使用，于是私聊在这里一律显示为群聊，实测库里 5 行 chat 主体中有 4 行是 private。
 * 判据与会话页的 `chatIdentity()` 一致：先取 `chat_type`，缺失时回落到 Telegram 的 id 正负号。
 */
const isPrivatePrincipal = (entry: Principal): boolean => (entry.chatType ? entry.chatType === 'private' : !entry.tgId.startsWith('-'));
const principalKindLabel = (entry: Principal): string => (entry.kind === 'chat'
  ? CHAT_TYPE_LABELS[String(entry.chatType)] ?? (isPrivatePrincipal(entry) ? '私聊' : '群 / 频道')
  : '用户');
const PRINCIPAL_KINDS = [['all', '全部'], ['user', '用户'], ['group', '群与频道']] as const;
type PrincipalKind = (typeof PRINCIPAL_KINDS)[number][0];
const matchesPrincipalKind = (entry: Principal, kind: PrincipalKind): boolean => kind === 'all' ? true
  : kind === 'user' ? entry.kind === 'user' : entry.kind === 'chat';
const ROLES = ['owner', 'trusted', 'limited', 'blocked'];
const ROLE_HINTS: Record<string, string> = { owner: '不受审批与沙箱限制，可读写所有配置', trusted: '可使用写文件、执行代码等高风险工具（按审批策略）', limited: '只读类工具，日常对话', blocked: '消息不触发轮次；archiveBlocked 关闭时不写入归档' };
const principalKind = ref<PrincipalKind>('all');
const visiblePrincipals = computed(() => principalKind.value === 'all' ? principals.value : principals.value.filter((entry) => matchesPrincipalKind(entry, principalKind.value)));
// 引导 owner（access.bootstrapOwnerId）是 bot 的实际主人：这一行改成 blocked 就没人能在 Telegram 里管它了。
const ownerPrincipalId = computed(() => { const tgId = String((config.value.access as Record<string, unknown> | undefined)?.bootstrapOwnerId ?? ''); return tgId ? `user:${tgId}` : ''; });
const ownerPrincipal = computed(() => principals.value.find((entry) => entry.id === ownerPrincipalId.value) ?? null);
const ownerLabel = computed(() => ownerPrincipal.value?.displayName || (ownerPrincipal.value ? `#${ownerPrincipal.value.tgId}` : 'Owner'));
const ownerHandle = computed(() => ownerPrincipal.value?.username ? `@${ownerPrincipal.value.username}` : ownerPrincipal.value ? `ID ${ownerPrincipal.value.tgId}` : '未登记');
const ownerInitials = computed(() => [...ownerLabel.value.replace(/\s+/gu, '')].slice(0, 2).join('').toUpperCase() || 'OW');
const principalCount = (kind: PrincipalKind): number => kind === 'all' ? principals.value.length : principals.value.filter((entry) => matchesPrincipalKind(entry, kind)).length;
const principalDialog = ref(false);
const principalSaving = ref(false);
// `chatType` 也要进来：弹窗里那行「类型」现在按它显示，缺了它每个会话都会掉进 id 正负号那条回落。
const principalForm = ref<Principal & { originalRole: string }>({ id: '', kind: 'user', tgId: '', role: 'limited', displayName: null, username: null, chatType: null, originalRole: 'limited' });
// 群 / 频道封顶 trusted：选 owner 零效果，服务端也会 400。旧库里的残留 owner 行仍要显示得出来，故保留原值那一档。
const principalRoleOptions = computed(() => ROLES.filter((role) => role !== 'owner' || principalForm.value.kind !== 'chat' || principalForm.value.originalRole === 'owner'));
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
// 混选时以更严的一侧为准：一批里只要有 chat，整批就不给 owner（服务端对 chat 行同样返回 400）。
const roleBulkOptions = computed(() => (principalSelection.value.some((entry) => entry.kind === 'chat') ? ROLES.filter((role) => role !== 'owner') : ROLES));
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
      detail: result.missing.length ? `${result.missing.length} 个 id 在数据库中不存在，已跳过` : '下一轮生效，已写审计日志', life: 7000 });
    await load();
  } catch (error) { toastError('批量改角色失败', error); }
  finally { roleSaving.value = false; }
}
const bulkDialog = ref(false);
const bulkSaving = ref(false);
const bulkForm = ref({ ids: '', kind: 'user', role: 'limited' });
const bulkIds = computed(() => [...new Set(bulkForm.value.ids.split(/[\s,;，、]+/).map((entry) => entry.trim()).filter(Boolean))]);
// kind=chat 的正数 id 服务端返回 400（私聊不再占 `chat:` 行）：在这里就拦下，否则整批导入只报一句 400。
const bulkBadIds = computed(() => bulkIds.value.filter((id) => !/^-?\d{1,20}$/.test(id) || (bulkForm.value.kind === 'chat' && !id.startsWith('-'))));
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

// ── 工具：代码里的 TOOL_POLICY 是默认值，这里写的是覆盖层（docs/09 §3.7）────────
// `agent` 这个取值仍在（`policy.source`），指的是派发与上报那一族工具，不再指某份子 agent 定义。
const TOOL_SOURCE_LABEL: Record<string, string> = { builtin: '内建', agent: 'Agent 编排', plugin: 'Plugin', mcp: 'MCP', custom: '自定义' };
/**
 * 可达侧：主 agent 与 lw-worker 的可用集在代码里就是分叉的（`toolCallableBy()`）。
 *
 * 三态各有含义，缺一个就读不出区别：只在主 agent 目录里（派发类）、只在 worker 那侧
 * （worker 回父的内部通道）、两侧都有（绝大多数）。这一列只读 —— 判据在代码里，
 * 做成开关就是又一个改了没效果的控件。
 */
const SIDE_LABEL: Record<string, { label: string; severity: TagSeverity; hint: string }> = {
  main: { label: '仅主 agent', severity: 'warn', hint: '只出现在主 agent 的工具目录里，worker 调它会被 execute() 拦下' },
  worker: { label: '仅 worker', severity: 'info', hint: '只出现在 worker 那侧，主 agent 的目录里没有它' },
  both: { label: '两侧', severity: 'secondary', hint: '主 agent 与 lw-worker 都够得着' },
  none: { label: '两侧都无', severity: 'danger', hint: '两侧都调不到，这一行只是注册表里的一条死数据' },
};
const sideKey = (sides?: string[]): string => {
  const main = sides?.includes('main') ?? false;
  const worker = sides?.includes('worker') ?? false;
  return main && worker ? 'both' : main ? 'main' : worker ? 'worker' : 'none';
};
const SIDE_FILTERS = [
  { value: '', label: '全部' }, { value: 'both', label: '两侧' },
  { value: 'main', label: '仅主 agent' }, { value: 'worker', label: '仅 worker' },
];
const TOOL_TABS = [
  ['catalog', '策略目录', 'pi pi-list'],
  ['approval', '审批试跑', 'pi pi-shield'],
  ['runtime', '执行环境', 'pi pi-box'],
] as const;
const toolTab = ref<(typeof TOOL_TABS)[number][0]>('catalog');
const sideFilter = ref('');
const toolQuery = ref('');
const toolVisibilityFilter = ref('');
const TOOL_VISIBILITY_FILTERS = [
  { value: '', label: '全部可见性' }, { value: 'resident', label: '常驻' }, { value: 'deferred', label: '折叠' },
];
const APPROVAL_LABEL: Record<string, string> = { never: '不需要', always: '每次审批', conditional: '按规则判定' };
const SCOPE_LABEL: Record<string, string> = { workspace: '工作区文件', chat: '当前会话', private: '用户私有', global: '全局', sandbox: '沙箱执行', telegram: 'Telegram' };
const ROLE_OPTIONS = ['blocked', 'limited', 'trusted', 'owner'].map((value) => ({ value, label: value }));
const APPROVAL_OPTIONS = ['never', 'conditional', 'always'].map((value) => ({ value, label: `${value}（${APPROVAL_LABEL[value]}）` }));
const toolRows = computed(() => Object.entries(tools.value).map(([name, policy]) => ({ name, ...policy })));
const visibleToolRows = computed(() => {
  const needle = toolQuery.value.trim().toLowerCase();
  return toolRows.value.filter((row) => {
    if (sideFilter.value && sideKey(row.sides) !== sideFilter.value) return false;
    if (toolVisibilityFilter.value === 'resident' && row.deferred) return false;
    if (toolVisibilityFilter.value === 'deferred' && !row.deferred) return false;
    return !needle || [row.name, row.source, row.scope, row.minRole, row.approval]
      .some((value) => String(value).toLowerCase().includes(needle));
  });
});
const enabledToolCount = computed(() => toolRows.value.filter((row) => row.enabled).length);
const approvalToolCount = computed(() => toolRows.value.filter((row) => row.approval !== 'never').length);
const deferredToolCount = computed(() => toolRows.value.filter((row) => row.deferred).length);
const overriddenToolCount = computed(() => toolRows.value.filter((row) => row.minRole !== row.defaults?.minRole
  || row.approval !== row.defaults?.approval || (row.timeoutMs ?? null) !== (row.defaults?.timeoutMs ?? null)).length);
const toolPage = ref(1);
const TOOL_PAGE_SIZE = 12;
const toolPages = computed(() => Math.max(1, Math.ceil(visibleToolRows.value.length / TOOL_PAGE_SIZE)));
const pagedToolRows = computed(() => {
  const page = Math.min(toolPage.value, toolPages.value);
  return visibleToolRows.value.slice((page - 1) * TOOL_PAGE_SIZE, page * TOOL_PAGE_SIZE);
});
watch([sideFilter, toolVisibilityFilter, toolQuery], () => { toolPage.value = 1; });
const toolDialog = ref(false);
const toolSaving = ref(false);
interface ToolForm { name: string; minRole: string; approval: string; scope: string; source: string; enabled: boolean; timeoutMs: number | null;
  selfManagedTimeout: boolean; defaults: { minRole: string; approval: string; timeoutMs: number | null }; original: ToolPolicy }
const toolForm = ref<ToolForm>({ name: '', minRole: 'limited', approval: 'never', scope: '', source: '', enabled: true, timeoutMs: null,
  selfManagedTimeout: false, defaults: { minRole: 'limited', approval: 'never', timeoutMs: null }, original: {} as ToolPolicy });
/** 比代码默认更宽松这一判据在前端只作提示，真正的拦截在服务端（409）；两处都判是因为界面要在保存前就给出警示。 */
const ROLE_RANK = ['blocked', 'limited', 'trusted', 'owner'];
const APPROVAL_RANK = ['never', 'conditional', 'always'];
const toolFormRelaxed = computed(() => {
  const form = toolForm.value;
  const out: string[] = [];
  if (ROLE_RANK.indexOf(form.minRole) < ROLE_RANK.indexOf(form.defaults.minRole)) out.push('最低角色');
  if (APPROVAL_RANK.indexOf(form.approval) < APPROVAL_RANK.indexOf(form.defaults.approval)) out.push('审批策略');
  return out;
});
const toolFormDirty = computed(() => {
  const { original: was, ...now } = toolForm.value;
  return now.enabled !== was.enabled || now.minRole !== was.minRole || now.approval !== was.approval || (now.timeoutMs ?? null) !== (was.timeoutMs ?? null);
});
function editTool(row: { name: string } & ToolPolicy): void {
  toolForm.value = { name: row.name, minRole: row.minRole, approval: row.approval, scope: row.scope, source: row.source,
    enabled: row.enabled, timeoutMs: row.timeoutMs ?? null, selfManagedTimeout: row.selfManagedTimeout === true,
    defaults: { minRole: row.defaults?.minRole ?? row.minRole, approval: row.defaults?.approval ?? row.approval, timeoutMs: row.defaults?.timeoutMs ?? null },
    original: { ...row } };
  toolDialog.value = true;
}
function resetToolField(field: 'minRole' | 'approval' | 'timeoutMs'): void {
  const form = toolForm.value;
  if (field === 'timeoutMs') form.timeoutMs = form.defaults.timeoutMs; else form[field] = form.defaults[field];
}
/** 覆盖值等于默认值时发 `null`（= 恢复默认，把字段从那条 JSON 里删掉），而不是把默认值抄一份存进去。 */
function toolPatchBody(form: ToolForm, confirmRelax: boolean): string {
  return JSON.stringify({ enabled: form.enabled,
    minRole: form.minRole === form.defaults.minRole ? null : form.minRole,
    approval: form.approval === form.defaults.approval ? null : form.approval,
    timeoutMs: form.selfManagedTimeout || form.timeoutMs === null || form.timeoutMs === form.defaults.timeoutMs ? null : form.timeoutMs,
    ...(confirmRelax ? { confirmRelax: true } : {}) });
}
const toolRelaxDialog = ref(false);
const toolRelaxDetails = ref<Array<{ path: string; from: string; to: string }>>([]);
async function saveTool(confirmRelax = false): Promise<void> {
  const form = toolForm.value;
  if (!toolFormDirty.value) { toolDialog.value = false; return; }
  toolSaving.value = true;
  try {
    const saved = await api<{ relaxed: string[]; effective: { minRole: string; approval: string } }>(`/api/tools/${encodeURIComponent(form.name)}`,
      { method: 'PATCH', body: toolPatchBody(form, confirmRelax) });
    toolRelaxDialog.value = false;
    toolDialog.value = false;
    const relaxed = toolFormRelaxed.value;
    // 先按响应里的生效值就地更新那一行，再 load()。`config.changed` 之后的重载是异步的
    // （`main.ts` 里 `void loadConfig(...).then(...)`），紧随其后的 `GET /api/tools` 可能仍读到旧快照，
    // 表现为保存成功但表格未变化，即 docs/21 · G-CFG-02 描述的现象。
    const row = tools.value[form.name];
    if (row) tools.value[form.name] = { ...row, ...saved.effective, enabled: form.enabled, timeoutMs: form.timeoutMs, relaxed: saved.relaxed };
    pushToast({ severity: relaxed.length ? 'warn' : 'success', summary: `${form.name} 的策略已更新`,
      detail: relaxed.length ? `${relaxed.join(' 与 ')}比代码默认更松，已记入日志与配置变更历史` : '下一次工具调用即生效（tools.overrides 热更新）' });
    await load();
  } catch (error) {
    // 服务端在放宽时先返回 409 且不写入任何内容，确认后带 confirmRelax 重发才落库。
    if (error instanceof ApiError && error.code === 'relax_requires_confirmation') {
      toolRelaxDetails.value = (error.details as Array<{ path: string; from: string; to: string }> | undefined) ?? [];
      toolRelaxDialog.value = true;
    } else toastError('保存工具设置失败', error);
  }
  finally { toolSaving.value = false; }
}

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
 * 总览页那两个环只绘制 global 档的当前 day / month。chat / user 是按主体拆分的多行数据，
 * 放在总览上读不出有效信息，那属于配额页表格的职责。
 * `limit === null` 时不绘制环，只显示「不限」（见 UiRing）。
 */
// ── 用量聚合：时间范围 + 维度（docs/09 §3.11）────────────────────────────────────
interface UsageReportRow { bucket: string | null; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; calls: number; successes: number; label?: string | null }
// `UiSelect` 只接受字符串（内部用 `String(...)` 归一化，emit 也是 string）。
// 这里的天数因此存为字符串，使用时再 Number()：传入数字会触发 prop 类型校验警告，
// 且 `picked` 的 `===` 比较也不成立（"7" !== 7），下拉框显示为空。
const USAGE_RANGES = [{ label: '近 7 天', value: '7' }, { label: '近 30 天', value: '30' }, { label: '近 90 天', value: '90' }];
const USAGE_DIMENSIONS = [{ label: '按天', value: 'day' }, { label: '按会话', value: 'chat' }, { label: '按用户', value: 'user' },
  { label: '按模型', value: 'model' }, { label: '按别名', value: 'alias' }, { label: '按 agent', value: 'agent' }, { label: '按 provider', value: 'provider' }];
const usageRange = ref('7');
const usageGroupBy = ref('day');
const usageReport = ref<UsageReportRow[]>([]);
const usageDimensionLabel = computed(() => USAGE_DIMENSIONS.find((entry) => entry.value === usageGroupBy.value)?.label ?? '按天');
const usageTotals = computed(() => {
  const rows = usageReport.value;
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const successes = rows.reduce((sum, row) => sum + row.successes, 0);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const cacheRead = rows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0);
  return { cost: rows.reduce((sum, row) => sum + row.costUsd, 0), calls, successRate: calls ? `${Math.round((successes / calls) * 100)}%` : '—',
    inputTokens, cacheRead, hitRate: inputTokens ? `${Math.round((cacheRead / inputTokens) * 100)}%` : '—' };
});
/** 命中率按桶计算，而不是用总数相除：一个大桶会掩盖其他桶的表现，而这一页正是用于
 *  区分哪一家上游、哪个模型的缓存确实生效。同理，无输入的桶记 0 而不是跳过。 */
const usageCacheRows = computed(() => usageReport.value.map((row) => ({
  label: row.label ?? String(row.bucket ?? '—'),
  value: row.inputTokens ? Math.round((row.cacheReadTokens ?? 0) / row.inputTokens * 100) : 0,
  hint: `${(row.cacheReadTokens ?? 0).toLocaleString()} / ${row.inputTokens.toLocaleString()}`,
})));
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
/** 分母是 cost + reserved：在途那一轮已占用额度，只绘制已结算部分会让额度充足却被拒绝看起来像缺陷。 */
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
    pushToast({ severity: 'success', summary: '配额已保存', detail: '下一条消息即按新限额判定' });
    await loadQuota();
    await load();
  } catch (error) { toastError('保存配额失败', error); }
  finally { quotaSaving.value = false; }
}
function resetQuota(row?: QuotaCounter): void {
  const target = row ? `${counterTitle(row)} · ${row.bucket}` : '全部计数器';
  askConfirm(`重置${target}？`, '仅将该窗口计数清零，费用不退回；此前被拒的用户可立即发起对话。', async () => {
    quotaResetting.value = row ? counterKey(row) : 'all';
    try {
      const result = await api<{ changes: number }>('/api/quota/reset', { method: 'POST', body: row ? JSON.stringify({ scope: row.scope, subject: row.subject, window: row.window, bucket: row.bucket }) : '{}' });
      pushToast({ severity: 'success', summary: `已重置 ${result.changes} 行计数`, detail: `${target} · 已写审计日志` });
      await loadQuota();
    } catch (error) { toastError('重置计数器失败', error); }
    finally { quotaResetting.value = ''; }
  });
}

// ── 沙箱：mode 决定 exec 类工具跑在哪儿，配错了要么全落空要么直接跑在宿主上 ──────────────
interface SandboxForm { mode: string; network: string; image: string; dockerBin: string; workspaceDir: string; hostWorkspaceDir: string;
  memoryMb: number | null; cpus: number | null; pidsLimit: number | null; tmpfsMb: number | null; readOnlyRoot: boolean; bypassRoles: string[];
  persistent: { enabled: boolean; idleTtlMs: number | null; maxLifetimeMs: number | null; maxContainers: number | null; network: string; reapCron: string } }
interface SandboxPayload { config: Record<string, unknown>; allowHostFsForOwner?: boolean; plan?: { allowed: boolean; mode: string; reason?: string } }
const sandbox = ref<SandboxPayload | null>(null);
const sandboxForm = ref<SandboxForm>({ mode: 'docker', network: 'none', image: '', dockerBin: 'docker', workspaceDir: '', hostWorkspaceDir: '',
  memoryMb: 512, cpus: 1, pidsLimit: 128, tmpfsMb: 64, readOnlyRoot: true, bypassRoles: ['owner'],
  persistent: { enabled: false, idleTtlMs: 86400000, maxLifetimeMs: 0, maxContainers: 16, network: 'bridge', reapCron: '*/5 * * * *' } });
// 界面按小时接收、配置按毫秒存储：24 比 86400000 更易核对，而 schema 一侧保持 Ms 后缀的一致性。
const HOUR_MS = 3_600_000;
const hoursOf = (ms: number | null): number => Math.round((ms ?? 0) / HOUR_MS * 10) / 10;
/** `tools.fs.allowHostFsForOwner` 不在 `sandbox.*` 下，所以它有自己的表单位与自己的写回路径。 */
const hostFsForOwner = ref(false);
const hostFsSaved = ref(false);
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
 * `docker pull <sandbox.image>`。镜像名取自已保存的那份配置，而不是表单里的值，与
 * 探测可用性口径一致，因此按钮旁边的说明要写明这一点。
 * 只执行 pull 不执行 build（build 属于部署动作，不是控制台按钮）。
 */
function pullSandboxImage(): void {
  askConfirm('拉取沙箱镜像？', '镜像名取自已保存的 sandbox.image；可能耗时数分钟。', async () => {
    pullingImage.value = true;
    try {
      const result = await api<{ image: string }>('/api/sandbox/image', { method: 'POST', body: '{}' });
      pushToast({ severity: 'success', summary: '镜像已拉取', detail: result.image, life: 8000 });
      await probeSandbox();
    } catch (error) { toastError('拉取镜像失败', error); }
    finally { pullingImage.value = false; }
  });
}
// 这份列表是 `sandbox.mode` 枚举的第二份副本（不从 config.schema.json 派生，也没有测试约束），
// 改 schema 时要同步修改：不一致的表现是下拉里能选出一个后端会返回 400 的值。
const SANDBOX_MODES = [{ value: 'docker', label: 'docker · 每次调用启动一个一次性容器' }, { value: 'none', label: 'none · 停用执行类工具（bypassRoles 仍在宿主直接执行）' }];
function markSandboxDirty(): void { sandboxDirty.value = true; }
function syncSandbox(payload: SandboxPayload): void {
  if (sandboxDirty.value) return;
  const config = payload.config as Partial<SandboxForm>;
  // `persistent` 要单独合一层：浅铺会把整个嵌套对象换成后端那份，旧部署里它可能缺字段。
  sandboxForm.value = { ...sandboxForm.value, ...config, bypassRoles: [...(config.bypassRoles ?? [])],
    persistent: { ...sandboxForm.value.persistent, ...(config.persistent ?? {}) } };
  hostFsSaved.value = Boolean(payload.allowHostFsForOwner);
  hostFsForOwner.value = hostFsSaved.value;
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
/**
 * 这一格上有三个开关可以完全解除沙箱边界，而此前只有 `mode = none` 设了确认，且用的是裸
 * `window.confirm`（`M-WEB-01` 提到的那批）。另外两个 —— 把 owner 之外的角色加入 `bypassRoles`、
 * 打开 `allowHostFsForOwner` —— 切换后点保存，两次点击即生效（docs/29 · M-WEB-10）。
 * 三者危险程度相同，因此共用同一道确认，并逐条写明代价：只询问是否确定等于没有说明。
 */
function sandboxDangers(): string[] {
  const form = sandboxForm.value;
  const dangers: string[] = [];
  if (form.mode === 'none')
    dangers.push('· mode = none：exec 类工具以 bot 进程权限在宿主直接执行模型给出的命令，沙箱隔离失效。');
  const extra = form.bypassRoles.filter((role) => role !== 'owner');
  if (extra.length)
    dangers.push(`· ${extra.join(' / ')} 已加入 bypassRoles：这些角色可让模型在宿主执行任意命令。`);
  // 只在从关闭切到开启时询问：关掉它属于收紧，不应同样拦一道。
  if (hostFsForOwner.value && !hostFsSaved.value)
    dangers.push('· allowHostFsForOwner：owner 的文件工具不再限于工作区，模型可访问整个宿主文件系统（含 .env 与本库）。');
  return dangers;
}
async function saveSandbox(): Promise<void> {
  const dangers = sandboxDangers();
  if (!dangers.length) { await commitSandbox(); return; }
  askConfirm('此操作将移除沙箱边界', `${dangers.join('\n')}\n\n保存后立即生效。`, commitSandbox);
}
async function commitSandbox(): Promise<void> {
  const form = sandboxForm.value;
  sandboxSaving.value = true;
  try {
    await api('/api/sandbox', { method: 'PUT', body: JSON.stringify({ mode: form.mode, network: form.network, image: form.image, dockerBin: form.dockerBin,
      workspaceDir: form.workspaceDir, hostWorkspaceDir: form.hostWorkspaceDir, memoryMb: form.memoryMb, cpus: form.cpus, pidsLimit: form.pidsLimit,
      tmpfsMb: form.tmpfsMb, readOnlyRoot: form.readOnlyRoot, bypassRoles: form.bypassRoles, persistent: form.persistent }) });
    // 它不在 sandbox.* 下，`PUT /api/sandbox` 会给每个键加 `sandbox.` 前缀 —— 只能走配置那条路。
    if (hostFsForOwner.value !== hostFsSaved.value)
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ 'tools.fs.allowHostFsForOwner': hostFsForOwner.value }) });
    sandboxDirty.value = false;
    pushToast({ severity: 'success', summary: '沙箱配置已保存', detail: '下一次工具调用即按新配置执行' });
    await loadSandbox();
    await loadContainers();
    await load();
  } catch (error) { toastError('保存沙箱配置失败', error); }
  finally { sandboxSaving.value = false; }
}
// ── 持久容器（docs/09 §3.7 / docs/05 §5.5）：一个会话一个常驻容器，到期回收 ────────────
interface ContainerRow { chatId: string; chatLabel: string | null; name: string; image: string; createdAt: number; lastUsedAt: number;
  expiresAt: number; hardExpiresAt: number | null; pinned: boolean; execCount: number; hasSetsid: boolean; lastError: string | null }
interface ContainerPayload { enabled: boolean; used: number; max: number; containers: ContainerRow[] }
/** `available: false` 表示该部署未装配持久容器运行时，与一个容器都没有是两种状态，
 *  面板上必须分别表述（同定时任务那一节，docs/16 §5：摘除比伪造安全）。 */
const containers = ref<ContainerPayload & { available: boolean }>({ available: true, enabled: false, used: 0, max: 0, containers: [] });
const containerBusy = ref('');
async function loadContainers(): Promise<void> {
  try {
    // 归一化而不是直接塞（同 schedules 那条）：形状对不上的响应不该让整页崩在 DataGrid 的 rows 上。
    const next = await api<Partial<ContainerPayload>>('/api/containers');
    containers.value = { available: true, enabled: Boolean(next?.enabled), used: next?.used ?? 0, max: next?.max ?? 0,
      containers: Array.isArray(next?.containers) ? next.containers : [] };
  }
  catch (error) {
    if (error instanceof ApiError && error.code === 'not_implemented') { containers.value = { available: false, enabled: false, used: 0, max: 0, containers: [] }; return; }
    toastError('加载容器列表失败', error);
  }
}
/** 重置的代价要写进确认框：容器里正在运行的进程会一并终止（照立即触发那条的写法）。 */
function resetContainer(row: ContainerRow, wipe: boolean): void {
  const who = row.chatLabel ?? row.chatId;
  const cost = wipe
    ? `\n\n⚠ 同时将「${who}」工作区内的文件移入 .luoli-trash（文件保留，模型不再可见）。`
    : '\n\n工作区内的文件不受影响。';
  askConfirm(`重置「${who}」的容器？`, `容器内安装的内容与正在运行的后台进程将一并丢失。${cost}`, async () => {
    containerBusy.value = row.chatId;
    try {
      await api(`/api/containers/${encodeURIComponent(row.chatId)}${wipe ? '?wipe=1' : ''}`, { method: 'DELETE' });
      pushToast({ severity: 'success', summary: `已重置「${who}」的容器`, detail: wipe ? '工作区文件已移入 .luoli-trash' : '工作区文件未改动' });
      await loadContainers();
    } catch (error) { toastError('重置容器失败', error); }
    finally { containerBusy.value = ''; }
  });
}
async function keepContainer(row: ContainerRow, patch: { hours?: number; pin?: boolean }): Promise<void> {
  containerBusy.value = row.chatId;
  try {
    await api(`/api/containers/${encodeURIComponent(row.chatId)}/keep`, { method: 'POST', body: JSON.stringify(patch) });
    await loadContainers();
  } catch (error) { toastError('改到期时间失败', error); }
  finally { containerBusy.value = ''; }
}
function containerExpiry(row: ContainerRow): string {
  if (row.pinned && row.hardExpiresAt === null) return '已钉住';
  const deadline = row.pinned ? row.hardExpiresAt! : Math.min(row.expiresAt, row.hardExpiresAt ?? row.expiresAt);
  const ms = deadline - Date.now();
  if (ms <= 0) return '已到期';
  const hours = Math.floor(ms / HOUR_MS);
  return hours >= 1 ? `${hours} 小时` : `${Math.max(1, Math.round(ms / 60000))} 分钟`;
}

/** 探测使用的是库里已保存的那份配置：表单已改但未保存时，探测结果仍是旧 mode。 */
async function probeSandbox(): Promise<void> {
  sandboxProbing.value = true;
  try {
    const result = await api<{ available: boolean; mode?: string; error?: string }>('/api/sandbox/probe', { method: 'POST', body: '{}' });
    sandboxProbe.value = result;
    pushToast({ severity: result.available ? 'success' : 'error', summary: result.available ? `沙箱可用（${result.mode ?? sandboxForm.value.mode}）` : '沙箱不可用', detail: result.error ?? '', life: result.available ? 4000 : 9000 });
  } catch (error) { toastError('沙箱探测失败', error); }
  finally { sandboxProbing.value = false; }
}

// ── 扩展：四类的行数据留在这一层（`load()` 拉取、SSE 刷新），版式与写操作整体移入 ExtensionsPage.vue。
//    此前它们被 `extensionRows` 拼成一个数组放进同一个卡片网格，八个动作按钮按 `item.kind` 分流，
//    代价是每一类只能显示四类的交集（docs/09 §3.8 那一节因此被重写）。
// `approvalRulesEmpty` 与 `conditionalToolNames` 留在这里：它们服务于「任务与审批」页。
/**
 * 审批已启用且规则表为空时，审批实际不生效。`ApprovalRules.evaluate()` 在规则表为空时恒返回
 * `needed:false`，于是 `conditional` 档的工具（bash / python / write_file / edit_file /
 * move_file / memory_write）全部不经审批，而这一页此前只显示一个处于开启状态的开关，
 * 工具页那张表仍标注为条件审批（docs/27 · S-02，启动时也有一条 warn）。
 */
const approvalRulesEmpty = computed(() => {
  const approval = (config.value.approval ?? {}) as { enabled?: boolean; rules?: unknown[] };
  return approval.enabled !== false && !(approval.rules ?? []).length;
});
const conditionalToolNames = computed(() => toolRows.value.filter((row) => row.approval === 'conditional').map((row) => row.name).join(' / '));

/**
 * 设置页的四个二级 tab（docs/09 §3.13）。此前是单条长滚动：八个区块并排，分组全折叠时首屏 4430 px，
 * 全部配置展开一次是 28075 px，而这八块属于访问频率相差两三个数量级的四类内容
 * （日常调节项 / 全量表单 / 运维动作 / 应急入口），在页面上权重却完全相同。
 * 修改这里时要同步改 `tests/webui/console.render.test.ts` 的 `SETTINGS_TABS`：那条用例逐个切换并
 * 断言有内容，缺一个分支即该 tab 不再被渲染验证。
 */
const SETTINGS_TABS = [
  ['common', '常用', '触发与唤醒词、输出节奏'],
  ['all', '全部配置', 'schema 自动生成的全量表单'],
  ['maintenance', '维护', '登录口令、备份与清理、重启、导出 / 导入'],
  ['advanced', '高级', '原始 YAML 覆盖层与合并结果'],
] as const;
const settingsTab = ref<(typeof SETTINGS_TABS)[number][0]>('common');
/** 合并结果默认收起：它与全部配置是同一份数据的两种视图，常驻展开会占掉一屏并使人误认为那是配置来源。 */
const mergedConfigOpen = ref(false);

// ── 维护：备份 / VACUUM / 清日志 / 清孤儿 / 重建 FTS ───────────────────────────────────
const MAINTENANCE_ACTIONS = [
  { action: 'backup', label: '立即备份 DB', icon: 'pi pi-database', hint: '快照写入 db.path 同级目录，保留 db.backupKeep 份' },
  { action: 'vacuum', label: 'VACUUM', icon: 'pi pi-compress', hint: '回收空间；数据库较大时会阻塞写入' },
  { action: 'cleanup-logs', label: '清理过期日志', icon: 'pi pi-eraser', hint: '按 logs.retentionDays 删除 log_events 与 worker 全文结果，并把腾出的空间还给磁盘' },
  { action: 'gc-files', label: '清理孤儿文件', icon: 'pi pi-trash', hint: '仅删除没有任何 DB 行指向的文件；在用的媒体不受影响' },
  { action: 'rebuild-fts', label: '重建 FTS 索引', icon: 'pi pi-sync', hint: '消息检索结果异常时重建' },
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
    const result = await api<{ keys: string[]; skipped: string[]; pruned: string[]; preserved: string[]; subsumed: string[] }>('/api/config/yaml', { method: 'PUT', body: JSON.stringify({ yaml: yamlText.value }) });
    await REFRESH_LOADERS.config();
    // 计数单位是配置项而不是配置段：落库粒度是叶子（docs/28 · L-WEB-02）。删除的键要单独列出，
    // 因为这条路径现在确实会删行，运维需要看到自己删了什么；保留的密钥行同样要说明，否则所提交
    // 的那份缺少 passwordHash 这件事在界面上仍不可见（docs/28 · L-WEB-04）。
    pushToast({ severity: 'success', summary: `已保存 ${result.keys.length} 个配置项`,
      detail: [result.skipped.length ? `${result.skipped.length} 项被环境变量锁定，已跳过：${result.skipped.join('、')}` : '',
        result.pruned.length ? `${result.pruned.length} 个键已从覆盖层删除：${result.pruned.join('、')}` : '',
        result.preserved.length ? `${result.preserved.length} 个密钥类键保持原值：${result.preserved.join('、')}` : '',
        result.subsumed.length ? `${result.subsumed.length} 条更细的覆盖被整块写入作废：${result.subsumed.join('、')}` : ''].filter(Boolean).join('\n') || '全部生效', life: 12_000 });
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
 * `[重启进程]`。二次确认里必须写明没有 supervisor 时进程不会自行恢复：这是一个可能让整个
 * 部署下线的按钮，措辞含糊比不提供按钮更糟。
 */
function restartProcess(): void {
  askConfirm('重启进程？', '在途轮次会被排空或中断。\n\n没有 supervisor（systemd / docker）时不会自动拉起，需手工启动。', async () => {
    restarting.value = true;
    try {
      await api('/api/restart', { method: 'POST', body: '{}' });
      pushToast({ severity: 'warn', summary: '已请求重启', detail: '控制台会断开，拉起后刷新页面。', life: 12_000 });
    } catch (error) { toastError('重启失败', error); }
    finally { restarting.value = false; }
  });
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
  catch (error) { toastError('该文件不是合法 JSON', error); return; }
  const keys = Object.keys(parsed.overrides ?? {});
  if (!keys.length) { pushToast({ severity: 'warn', summary: '文件中没有 overrides', detail: '导出文件的结构是 { overrides: { 点分键: 值 } }' }); return; }
  askConfirm(`导入 ${keys.length} 条配置覆盖？`, '按键覆盖现有值，不删除文件中未包含的键。校验不通过则整批不写入。', async () => {
    try {
      const result = await api<{ keys: string[]; skipped: string[]; subsumed: string[] }>('/api/config/import', { method: 'POST', body: JSON.stringify(parsed) });
      await REFRESH_LOADERS.config();
      pushToast({ severity: 'success', summary: `已导入 ${result.keys.length} 项`,
        detail: [result.skipped.length ? `${result.skipped.length} 项被环境变量锁定，已跳过：${result.skipped.join('、')}` : '',
          result.subsumed.length ? `${result.subsumed.length} 条更细的覆盖被整块写入作废：${result.subsumed.join('、')}` : ''].filter(Boolean).join('\n') || '全部生效', life: 12_000 });
    } catch (error) { toastError('导入失败', error); }
  });
}
function runMaintenance(action: string, label: string): void {
  // gc-files 会删除文件，不能与常规整理混在同一句确认文案里：运维需要知道它删除什么、保留什么。
  const warning = action === 'gc-files'
    ? '仅删除没有任何数据库行指向的孤儿文件；在用的媒体与 worker 结果不受影响。'
    : '数据库较大时会阻塞写入。';
  askConfirm(`执行「${label}」？`, warning, async () => {
    maintenanceBusy.value = action;
    try {
      const result = await api<unknown>(`/api/maintenance/${action}`, { method: 'POST', body: '{}' });
      // `refused` 是 fail-closed 的拒绝，不是完成。`gc-files` 的唯一触发条件是库与目录来自两套
      // 部署，正是运维应立即停止操作的情形（docs/25 §10 记录的误删 76 个附件与 90 份子 agent 全文
      // 即由它拦下）。渲染成绿色的完成、加一行 JSON 并在 8 秒后自动消失，等于把它隐藏
      // （docs/28 · L-WEB-03）。`life: 0` 走 pushToast 的不自动消失分支，需人工关闭。
      const refused = (result as { refused?: unknown } | null)?.refused;
      const reasons = Array.isArray(refused) ? refused.map(String) : refused ? [String(refused)] : [];
      if (reasons.length) { pushToast({ severity: 'warn', summary: `${label} 已拒绝`, detail: [...reasons, JSON.stringify(result)].join('\n'), life: 0 }); return; }
      pushToast({ severity: 'success', summary: `${label} 完成`, detail: typeof result === 'string' ? result : JSON.stringify(result), life: 8000 });
    } catch (error) { toastError(`${label} 失败`, error); }
    finally { maintenanceBusy.value = ''; }
  });
}

// ── 依赖健康：总览页那张卡以前是四行写死的字，与运行时无关 ──────────────────────────
interface HealthDetail { ok: boolean; version: string; uptimeMs: number; db: { ok: boolean; bytes?: number; walBytes?: number; logsBytes?: number; workspaceBytes?: number };
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
const recentErrorsLoaded = ref(false);
const errorEnterStyle = (index: number): Record<string, string> => ({ '--error-order': String(Math.min(index, 9)) });
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
const nowTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
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
function cancelTurn(turn: ActiveTurn): void {
  askConfirm(`取消 ${turnWho(turn)} 的当前轮次？`, '模型调用将被中断，该轮记为 cancelled；已发送的消息不会撤回。', async () => {
    cancellingTurn.value = turn.id;
    try {
      const result = await api<{ cancelled: boolean }>(`/api/turns/${encodeURIComponent(turn.id)}/cancel`, { method: 'POST', body: '{}' });
      pushToast(result.cancelled ? { severity: 'success', summary: '已发出取消信号', detail: `${turn.id.slice(0, 12)} · 该轮会记成 cancelled` }
        : { severity: 'warn', summary: '这一轮已经结束了', detail: '取消信号没有作用对象，界面稍后自动刷新' });
      await loadActiveTurns();
    } catch (error) { toastError('取消失败', error); }
    finally { cancellingTurn.value = ''; }
  });
}

// 任务的取消、审批的裁决、定时任务的建 / 停 / 触发整段搬进 `components/tasks/` 那三张卡：
// 三者的端点、分页游标、弹窗与 busy 态零交集，留在这一层只会互相挡道。

// ── SSE：首屏之后界面的数据新鲜度全靠这里（docs/21 · G-SSE-01）───────────────────
// 事件到达后不再无条件重跑 `load()`（那是一次 18 个端点请求）：按事件类型只刷新相关的那几组，
// 且只刷新当前页面可见的部分。服务端已按 kind 合并过一轮，这一层处理的是多个 kind 同时到达。
type RefreshGroup = 'dashboard' | 'logs' | 'chats' | 'usage' | 'quota' | 'tasks' | 'approvals' | 'extensions' | 'config' | 'activeTurns' | 'schedules' | 'containers';
const REFRESH_DEBOUNCE_MS = 400;
const lastEventAt = ref(0);
const REFRESH_LOADERS: Record<RefreshGroup, () => Promise<void>> = {
  dashboard: async () => {
    [dashboard.value, health.value, recentErrors.value] = await Promise.all([api<Dashboard>('/api/dashboard'), api<HealthDetail>('/api/health/detail'), api<LogRow[]>('/api/logs?minLevel=warn&size=10')]);
    recentErrorsLoaded.value = true;
    await loadQuota().catch(() => undefined);
  },
  logs: async () => { logs.value = await api<LogRow[]>('/api/logs'); },
  chats: async () => { chats.value = await api<Chat[]>('/api/chats'); },
  usage: async () => { [usage.value] = await Promise.all([api<Usage[]>('/api/usage'), loadUsageReport()]); },
  quota: loadQuota,
  // 任务页那三组只发一个脉冲：行数据、页码与 busy 态都由三张卡自行持有，父层再拉取一次
  // 只会把运维翻到的页码重置为第一页。组名、下面的 EVENT_REFRESH 映射、400ms 合并与
  // REFRESH_VISIBILITY 的可见性过滤均不改动，变的只是刷新这个动作本身。
  tasks: async () => { tick.value += 1; },
  // 审批多一步：导航角标是全表 pending，不切到任务页也得跟着变（AC-WEB-049），
  // 而它只有这一层拉得到。卡片没挂载时 tick 空转，代价是零。
  approvals: async () => { tick.value += 1; await loadApprovalBadge(); },
  schedules: async () => { tick.value += 1; },
  // Worker 运行记录页同形：只发脉冲，行数据与页码在那张卡自己手上。
  workerRuns: async () => { workerTick.value += 1; },
  // 自定义工具单独 catch：没装配这块的部署会回 `not_implemented`，那不该把另外三类一起带下去。
  extensions: async () => { [skills.value, plugins.value, mcp.value, customTools.value] = await Promise.all([api<SkillRow[]>('/api/skills'), api<PluginRow[]>('/api/plugins'), api<McpRow[]>('/api/mcp'), api<CustomTool[]>('/api/custom-tools').catch(() => [])]); },
  config: async () => { [config.value, tools.value] = await Promise.all([api<Record<string, unknown>>('/api/config'), api<Record<string, ToolPolicy>>('/api/tools')]); syncTrigger(); syncOutput(); },
  activeTurns: loadActiveTurns,
  containers: loadContainers,
};
// 哪些页面可见这一组。不可见时不刷新，切到该页时 watch(active) 会补一次。
const REFRESH_VISIBILITY: Record<RefreshGroup, readonly string[]> = {
  dashboard: ['dashboard'], logs: ['dashboard', 'logs'], chats: ['chats'], usage: ['usage'], quota: ['quota'],
  tasks: ['tasks'], extensions: ['extensions', 'dashboard'], activeTurns: ['dashboard'], schedules: ['tasks'],
  workerRuns: ['workers'],
  // 容器面板在工具页的沙箱块下方 —— 只有那一页看得见。
  containers: ['tools'],
  // 待审批不做页面过滤：一条 pending 会阻塞某个真实轮次最长 approval.ttlMs，
  // 只在任务页刷新意味着运维不切到那一页就无从得知有请求在等待。该事件本身很稀疏（命中规则才发）。
  approvals: ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools', 'extensions', 'workers', 'sdk', 'logs', 'usage', 'quota', 'tasks', 'settings'],
  // 配置变了影响设置页与工具页，也影响会话页的覆盖显示；这个事件本身很稀疏，不做页面过滤。
  config: ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools', 'extensions', 'workers', 'sdk', 'logs', 'usage', 'quota', 'tasks', 'settings'],
};
const EVENT_REFRESH: Record<string, readonly RefreshGroup[]> = {
  log: ['logs', 'dashboard'],
  'turn.started': ['activeTurns', 'dashboard'],
  'turn.progress': ['activeTurns'],
  'turn.finished': ['activeTurns', 'dashboard', 'chats', 'schedules'],
  usage: ['usage', 'dashboard'],
  quota: ['quota'],
  // 三档 worker 的 state 变化都经 `task.updated` 发出来（docs/09 §5）：不新增事件类型，
  // 而 worker 运行页那两类外部 run 不实时动的话，一条跑了二十分钟的 harness 在界面上看着像卡住。
  'task.updated': ['tasks', 'workerRuns'],
  'approval.pending': ['approvals'], 'approval.decided': ['approvals'],
  'config.changed': ['config', 'containers'],
  // 扩展页此前只靠 `health` 顺带刷新，而那个事件只在 provider 测试与 MCP 重连后才发 ——
  // 从 Telegram 装进来的 skill 要等下一次健康检查才出现（docs/21 §9 · G-EXT-05）。
  'extensions.changed': ['extensions'],
  health: ['dashboard', 'extensions'],
};
const sinceLastEvent = computed(() => {
  const seconds = Math.max(0, Math.round((nowTick.value - lastEventAt.value) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
});
const refreshTimers = new Map<RefreshGroup, ReturnType<typeof setTimeout>>();
/** 补拉用的全集。取 `Object.keys` 而不是另写一份：另写的那份迟早会漏掉新增的组，而遗漏的表现是
 *  该区块的数字在断线后不再正确，且没有任何报错。 */
const ALL_REFRESH_GROUPS = Object.keys(REFRESH_LOADERS) as RefreshGroup[];
/** 因当前页不可见而被跳过的组。上面那句切到该页时 watch(active) 会补一次，此前只对
 *  `loadActiveTurns` 等五个具体 loader 成立，对这十二组均不成立：切过去看到的是离开那一刻的
 *  快照。这里记录下来，等切到可见它的页面再补，这也是重连补拉能覆盖其他页面的唯一途径。 */
const staleGroups = new Set<RefreshGroup>();
function scheduleRefresh(groups: readonly RefreshGroup[]): void {
  for (const group of groups) {
    if (!REFRESH_VISIBILITY[group].includes(active.value)) { staleGroups.add(group); continue; }
    staleGroups.delete(group);
    if (refreshTimers.has(group)) continue;
    refreshTimers.set(group, setTimeout(() => { refreshTimers.delete(group); void REFRESH_LOADERS[group]().catch(() => undefined); }, REFRESH_DEBOUNCE_MS));
  }
}
/** 切页时把这一页看得见、而错过了刷新的那几组补上。 */
function drainStaleRefresh(): void {
  const pending = [...staleGroups].filter((group) => REFRESH_VISIBILITY[group].includes(active.value));
  if (pending.length) scheduleRefresh(pending);
}

// ── 全量配置表单：由 config.schema.json 自动生成（docs/09 §3.13、docs/21 §1.1）──────────
// 153 个已接线叶子里此前只有 15 个能在界面上改。手写 100 多个控件必然与 schema 漂移，
// 所以这里只取 `GET /api/config/schema` 的三件套喂给 SchemaForm，控件形态全从 schema 推。
interface ConfigSchemaPayload { schema: Record<string, unknown>; hotReloadable: string[]; unimplemented: string[]; envPinned: Array<{ key: string; env: string }>; enumNotes: Record<string, Record<string, string>> }
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
  'context.scope': '⚠️ 改为 thread 后，后续消息落到新 key thread:<chat>:<topic>，本条覆盖随即失效',
  'agent.main.modelAlias': '仅更换该会话的主模型；与 Telegram 侧 /model 并存时以 /model 为准，上方提示可直接清除',
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
/** 表单里显示的是这个会话实际生效的值（全局与覆盖合并后），与 `perChatConfig` 运行时的合并一致。 */
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
/**
 * `perChat.<key>.character`：会话级人格文件名。它在白名单里，运行时也确实读取
 * （`assembleMainPrompt` → `PromptDocuments.paths`），但不是 schema 叶子键
 * （`perChat` 是 `z.record(z.unknown())`），因此 schema 驱动的 `SchemaForm` 渲染不出它。
 * 这里提供一个单独的输入框，避免运维只能使用 curl（docs/27 · C-08）。
 * 服务端只接受纯文件名加 `.md`，不合格时静默回退到全局 `CHARACTER.md`，此处沿用同一条说明。
 */
const chatCharacter = ref('');
const chatCharacterSaving = ref(false);
watch(chatOverrides, (overrides) => { chatCharacter.value = typeof overrides.character === 'string' ? overrides.character : ''; }, { immediate: true });
async function saveChatCharacter(): Promise<void> {
  const value = chatCharacter.value.trim();
  chatCharacterSaving.value = true;
  try { if (value) await saveChatOverrides({ character: value }); else await dropChatOverride('character'); }
  finally { chatCharacterSaving.value = false; }
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
    pushToast({ severity: 'success', summary: `已取消覆盖 ${path}`, detail: '该项回到全局值，下一轮生效' });
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
    // 保存成功但运行时未变是最具误导性的一类反馈（docs/20 · W-CFG-02）：需重启的键要明确列出。
    pushToast({ severity: cold.length ? 'warn' : 'success', summary: `已保存 ${keys.length} 项配置`,
      detail: cold.length ? `其中 ${cold.length} 项需重启进程才生效：${cold.slice(0, 4).join('、')}${cold.length > 4 ? ' 等' : ''}` : '全部是热更新项，已即时生效', life: cold.length ? 9000 : 5000 });
    // 整块写入会作废同一子树下更细的那些覆盖行（例如工具页逐个点出来的 tools.overrides.<name>）。
    // 不说出来的话，运维只会看到「保存成功」，而某个工具的开关被这次保存顺手改掉了。
    const subsumed = result?.subsumed ?? [];
    if (subsumed.length) {
      pushToast({ severity: 'warn', summary: `已作废 ${subsumed.length} 条更细的覆盖`,
        detail: `${subsumed.slice(0, 4).join('、')}${subsumed.length > 4 ? ' 等' : ''}；已被本次整块写入取代，请确认工具页的开关状态`, life: 12000 });
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
  if (!form.current) return '需先验证当前口令';
  if (form.next.length < 12) return '新口令至少 12 个字符';
  if (form.next !== form.confirm) return '两次输入的新口令不一致';
  if (form.next === form.current) return '新口令与当前口令相同';
  return '';
});
async function savePassword(): Promise<void> {
  if (passwordProblem.value) return;
  passwordSaving.value = true;
  try {
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current: passwordForm.value.current, next: passwordForm.value.next }) });
    passwordForm.value = { current: '', next: '', confirm: '' };
    pushToast({ severity: 'success', summary: '登录口令已更新', detail: '其余会话已全部吊销（当前会话保留），即时生效', life: 9000 });
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
 * 值可能很长（`approval.rules` 是整张数组），列表里只给一行；密钥类的键在写入时就已经存成 «redacted»。
 * 两侧的 null 意思不同：旧值为空 = 此前没有覆盖，新值为空 = 这条覆盖行被删掉了
 * （写更粗的祖先键时，被它取代的后代行会一并作废）。
 */
const revisionValue = (raw: string | null, side: 'old' | 'new'): string => (raw === null
  ? (side === 'old' ? '（此前没有覆盖）' : '（这条覆盖已被删除）')
  : raw.length > 160 ? `${raw.slice(0, 160)}…` : raw);


async function logout(): Promise<void> {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* 会话可能已经过期，照样跳登录页 */ }
  requestLogin();
}

watch(active, (value) => {
  if (value === 'messages') void loadConversations();
  if (value === 'quota') void loadQuota();
  if (value === 'tools') void loadSandbox();
  if (value === 'settings') void loadConfigSchema();
  // 切回来时补一次：不可见的分组在事件到达时被跳过了，直接显示会是离开那一刻的快照。
  if (value === 'dashboard') void loadActiveTurns();
  drainStaleRefresh();
});
/**
 * MCP OAuth 回调的落点。那一跳落在浏览器地址栏而不是 fetch，因此服务端只能把结果编进 URL；
 * 不在这里读取时，用户被重定向回来只会看到一个多了查询串的控制台首页，没有任何授权结果提示。
 * 读取后立即清除参数（`replaceState`），否则刷新一次会重复提示同一条。
 */
function reportMcpAuthResult(): void {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('mcpAuth');
  if (!status) return;
  const detail = params.get('detail') ?? '';
  const messages: Record<string, { severity: 'success' | 'warn' | 'error'; summary: string; detail: string }> = {
    ok: { severity: 'success', summary: `${detail || 'MCP server'} 授权完成`, detail: '凭据已加密存储，server 已重连；发起授权的标签页可关闭。' },
    denied: { severity: 'warn', summary: '授权被拒绝或取消', detail: detail ? `授权服务返回 ${detail}` : '授权服务未返回授权码。' },
    bad_state: { severity: 'error', summary: '回调无效', detail: 'state 无效、已使用或已过期（10 分钟）。请返回扩展页重新点击〔登录〕。' },
    incomplete: { severity: 'warn', summary: '换取 token 未完成', detail: '查看日志中的 mcp.auth 事件。' },
    failed: { severity: 'error', summary: '换取 token 失败', detail: detail || '查看日志中的 mcp.auth 事件。' },
    not_found: { severity: 'error', summary: '这台 server 已不在配置中', detail: '授权期间已被删除或改名。' },
    unavailable: { severity: 'error', summary: '这个部署未接入 MCP 凭据库', detail: '通常是缺少 LUOLI_MASTER_KEY。' },
  };
  const message = messages[status] ?? { severity: 'warn' as const, summary: `MCP 授权返回 ${status}`, detail };
  pushToast({ ...message, life: message.severity === 'success' ? 8000 : 0 });
  params.delete('mcpAuth');
  params.delete('detail');
  window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  if (status === 'ok') active.value = 'extensions';
}

onMounted(async () => {
  if (!await hydrateSession()) return;
  await load();
  reportMcpAuthResult();
  void loadActiveTurns();
  eventStream = new EventSource('/api/events');
  // 断线期间的事件不会重放，因此重连之后必须自行补拉一次（docs/29 · `M-WEB-02`）。实测断开 20 秒
  // 后重连，总览的归档消息停在旧值十几秒，直到下一条无关事件到达才更新：
  // 状态指示已恢复为系统在线而数字仍是旧的，比保持断开更糟，断开时界面至少表明了数据不新鲜。
  // 首次连接不补拉：`load()` 刚执行完那 18 个端点。
  let everDropped = false;
  eventStream.onopen = () => {
    connected.value = true;
    if (!everDropped) return;
    everDropped = false;
    scheduleRefresh(ALL_REFRESH_GROUPS);
  };
  eventStream.onerror = () => { connected.value = false; everDropped = true; };
  for (const [type, groups] of Object.entries(EVENT_REFRESH)) {
    eventStream.addEventListener(type, (message) => {
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

onBeforeUnmount(() => {
  clearInterval(nowTimer);
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  eventStream?.close();
  eventStream = null;
});

const roleSeverity = (role: string): TagSeverity => ({ owner: 'success', trusted: 'info', limited: 'warn', blocked: 'danger' }[role] as TagSeverity);
</script>

<template>
  <main class="console-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">{{ botName.slice(0, 1).toUpperCase() }}</div><div><b>{{ botName }}</b><span>CONTROL PLANE</span></div></div>
      <nav aria-label="主导航">
        <div v-for="section in navigationSections" :key="section.label" class="nav-section">
          <p class="nav-label">{{ section.label }}</p>
          <button v-for="item in section.items" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]">
            <i :class="item[1]" aria-hidden="true" /><span>{{ item[2] }}</span>
            <span v-if="item[0] === 'tasks' && pendingApprovals" class="nav-badge" :title="`${pendingApprovals} 个调用等待审批`">{{ pendingApprovals }}</span>
          </button>
        </div>
      </nav>
    </aside>

    <section class="main-panel">
      <header class="topbar">
        <UiButton class="mobile-only" variant="text" icon="pi pi-bars" aria-label="打开导航" @click="mobileMenu = true" />
        <div><p class="eyebrow">{{ currentEyebrow }}</p><h1>{{ currentLabel }}</h1></div>
        <div class="top-actions"><label class="search"><i class="pi pi-search" aria-hidden="true" /><input v-model="query" type="search" aria-label="全局搜索" placeholder="搜索 trace、会话或主体"></label><UiButton variant="outlined" icon="pi pi-bell" aria-label="通知" />
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
            <div><p class="eyebrow">LIVE OVERVIEW</p><h2>系统状态<span>稳定</span></h2><p>实时指标与依赖状态</p></div>
            <UiButton label="打开实时日志" icon="pi pi-wave-pulse" @click="active = 'logs'" />
          </section>
          <section class="metric-grid">
            <article><div class="metric-icon violet"><i class="pi pi-bolt" /></div><span>在途 turn</span><b><UiRollingNumber :value="dashboard.turns.running" :ready="dashboardIntroReady" :animate="dashboardIntroAnimate" /></b><small>总计 {{ dashboard.turns.total }} 次</small></article>
            <article><div class="metric-icon cyan"><i class="pi pi-comments" /></div><span>归档消息</span><b><UiRollingNumber :value="dashboard.messages.total" :ready="dashboardIntroReady" :animate="dashboardIntroAnimate" /></b><small>FTS 索引已启用</small></article>
            <article><div class="metric-icon rose"><i class="pi pi-wallet" /></div><span>累计花费</span><b><UiRollingNumber :value="Number(dashboard.turns.cost || 0)" :ready="dashboardIntroReady" :animate="dashboardIntroAnimate" prefix="$" :fraction-digits="4" /></b><small>失败 {{ dashboard.turns.failed }} 次</small></article>
            <article><div class="metric-icon amber"><i class="pi pi-sparkles" /></div><span>可用 Provider</span><b><UiRollingNumber :value="dashboard.providers.enabled" :ready="dashboardIntroReady" :animate="dashboardIntroAnimate" /></b><small>共配置 {{ dashboard.providers.total }} 个</small></article>
          </section>
          <!-- 在途 turn 表（docs/09 §3.1）：数据来自进程内的 TurnRegistry，首屏拉一次，
               之后 turn.started / turn.progress / turn.finished 三种事件增量更新。 -->
          <section class="surface in-flight">
            <header><div><p class="eyebrow">IN FLIGHT</p><h3>在途 turn</h3><p class="section-note">进行中的轮次列表</p></div>
              <UiTag :value="activeTurns.length ? `${activeTurns.length} 轮进行中` : '空闲'" :severity="activeTurns.length ? 'info' : 'secondary'" /></header>
            <DataGrid :rows="activeTurns" :columns="COLUMNS.activeTurns" data-key="id" empty="暂无">
              <template #who="{ data }"><b>{{ turnWho(data) }}</b><UiTag :value="data.role" :severity="roleSeverity(data.role)" /></template>
              <template #chat="{ data }"><code>{{ data.key }}</code></template>
              <template #progress="{ data }">
                <span v-if="turnProgress[data.id]">第 {{ turnProgress[data.id].step }} 步 · {{ turnProgress[data.id].phase === 'tools' ? '工具' : '模型' }} <small>{{ turnProgress[data.id].note }}</small></span>
                <small v-else class="alias-empty">尚无步骤事件</small>
              </template>
              <template #stats="{ data }">{{ data.steps }} 步 · ${{ Number(data.costUsd || 0).toFixed(4) }}</template>
              <template #elapsed="{ data }">{{ elapsed(data.startedAt) }}</template>
              <template #actions="{ data }"><UiButton size="small" variant="outlined" severity="danger" label="取消" :loading="cancellingTurn === data.id" @click="cancelTurn(data)" /></template>
            </DataGrid>
          </section>
          <section class="dashboard-grid">
            <!-- 最近**错误**（level≥warn，10 条），点一行直接跳到那条 trace。此前这里是不分级别
                 的最近 6 条，实际上永远被 info 刷满 —— 一张「最近错误」卡片看不到错误（docs/09 §3.1）。 -->
            <article class="surface"><header><div><p class="eyebrow">RECENT ERRORS</p><h3>最近错误</h3><p class="section-note">点击任一行打开对应 trace</p></div><UiButton variant="text" label="查看全部" icon="pi pi-arrow-right" icon-pos="right" @click="active = 'logs'" /></header>
              <div class="log-list" :aria-busy="!recentErrorsLoaded">
                <button v-for="(row, index) in recentErrors" :key="row.id" type="button" class="log-row dashboard-error-reveal" :style="errorEnterStyle(index)" :aria-label="`打开 ${row.kind} 的 trace`" @click="openTrace(row.trace_id)">
                  <span :class="['level', row.level]">{{ row.level }}</span>
                  <span class="log-row-copy"><code :title="row.kind">{{ row.kind }}</code><span :title="row.summary">{{ row.summary }}</span></span>
                  <time :datetime="new Date(row.ts).toISOString()">{{ new Date(row.ts).toLocaleTimeString() }}</time>
                  <i class="pi pi-chevron-right log-row-arrow" aria-hidden="true" />
                </button>
                <div v-if="recentErrorsLoaded && !recentErrors.length" key="empty" class="empty">暂无</div>
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
              <div class="health-row"><span>DB / WAL</span><UiTag :value="`${formatBytes(health?.db.bytes)} / ${formatBytes(health?.db.walBytes)}`" severity="secondary" title="WAL 偏大时执行 VACUUM，或等下次维护 checkpoint" /></div>
              <div class="health-row"><span>日志库</span><UiTag :value="formatBytes(health?.db.logsBytes)" severity="secondary" title="日志独立成一个文件，按 logs.retentionDays 清理；它不计入上面的 DB 大小" /></div>
              <div class="health-row"><span>workspace 占用</span><UiTag :value="formatBytes(health?.db.workspaceBytes)" severity="secondary" title="模型在会话工作目录生成的文件，用「清理孤儿文件」清理" /></div>
            </article>
          </section>
          <section class="dashboard-grid">
            <article class="surface"><header><div><p class="eyebrow">TREND</p><h3>活跃</h3><p class="section-note">近七天的消息与轮次</p></div></header>
              <UiLineChart v-if="dashboard.trend?.length" :labels="dashboard.trend.map((point) => point.day.slice(5))"
                :series="[{ name: '消息', values: dashboard.trend.map((point) => point.messages) }, { name: '轮次', values: dashboard.trend.map((point) => point.turns) }]" />
              <div v-else class="empty">暂无数据</div>
            </article>
            <article class="surface"><header><div><p class="eyebrow">QUOTA</p><h3>额度</h3><p class="section-note">当前 bucket · 详见配额页</p></div></header>
              <div class="ring-row">
                <UiRing v-for="ring in quotaRings" :key="ring.label" :spent="ring.spent" :limit="ring.limit" :label="ring.label" :warn-at-ratio="ring.warnAtRatio" />
                <div v-if="!quotaRings.length" class="empty">配额已关闭或无计数</div>
              </div>
            </article>
          </section>
        </div>

        <section v-else-if="active === 'chats'" key="chats" class="surface page-surface">
          <header><div><p class="eyebrow">CONTEXTS</p><h2>会话上下文</h2><p>会话列表与上下文窗口</p></div><UiTag :value="`${chats.length} 个会话`" severity="secondary" /></header>
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
            <p v-if="!chats.length" class="empty-card">暂无会话</p>
          </div>
          <!-- 会话级覆盖：`PATCH /api/chats/:key` 此前只能用 curl 打（docs/21 · G-API-09） -->
          <article v-if="selectedChat" class="surface chat-overrides">
            <header>
              <div><p class="eyebrow">PER-CHAT OVERRIDE</p><h3>只对「{{ selectedChatIdentity?.name }}」生效的设置</h3>
                <p class="section-note">覆盖优先于全局值，<b>下一轮生效</b>。可改范围：触发 / 输出 / 上下文窗口 / 主 Agent / 公共记忆写入角色，越界返回 400。</p></div>
              <UiTag :value="chatOverrideRows.length ? `${chatOverrideRows.length} 项覆盖中` : '全部继承全局'" :severity="chatOverrideRows.length ? 'info' : 'secondary'" />
            </header>
            <div v-if="chatOverrideRows.length" class="override-list">
              <span v-for="row in chatOverrideRows" :key="row.path" class="override-chip">
                <code>{{ row.path }}</code><b>{{ typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value) }}</b>
                <button type="button" aria-label="取消该项覆盖" title="取消覆盖，恢复全局值" @click="dropChatOverride(row.path)"><i class="pi pi-times" /></button>
              </span>
            </div>
            <!-- /model 写的是 app_kv 而不是配置覆盖层，却压过下面的 agent.main.modelAlias：
                 不摆出来的话，「改了模型别名不生效」在界面上完全无迹可寻。 -->
            <p v-if="chatModelAlias" class="callout warn">
              <i class="pi pi-exclamation-triangle" aria-hidden="true" />
              该会话已被 Telegram 的 <code>/model</code> 固定为别名 <b>{{ chatModelAlias }}</b>（存储在 <code>app_kv</code>），<b>优先于</b>下面的 <code>agent.main.modelAlias</code> 与全局值。
              <UiButton size="small" variant="text" severity="danger" label="清除会话别名" @click="clearChatModelAlias" />
            </p>
            <!-- character 不是 schema 叶子键（perChat 是 z.record），SchemaForm 渲染不出它 -->
            <div class="chat-character">
              <label>会话人格文件
                <input v-model="chatCharacter" placeholder="CHARACTER.md（留空 = 使用来源人格）" spellcheck="false">
              </label>
              <UiButton size="small" variant="outlined" label="保存" :loading="chatCharacterSaving" @click="saveChatCharacter" />
              <p class="field-note"><code>memory/</code> 下的替代人设文件名，仅接受纯文件名（<code>.md</code> 结尾、不含目录与 <code>..</code>）。其他取值<b>静默退回来源 <code>CHARACTER.md</code></b>。</p>
            </div>
            <UiButton variant="text" :icon="chatOverrideOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" :label="chatOverrideOpen ? '收起' : '编辑覆盖项'" @click="chatOverrideOpen = !chatOverrideOpen" />
            <!-- 控件里显示的是这个会话实际生效的值（全局 + 覆盖）；改动才会写进覆盖层 -->
            <SchemaForm v-if="chatOverrideOpen && configSchema" ref="chatOverrideForm" :schema="configSchema.schema" :value="chatEffectiveConfig"
              :hot-reloadable="PER_CHAT_ALLOWLIST" :unimplemented="configSchema.unimplemented" :env-pinned="configSchema.envPinned" :enum-notes="configSchema.enumNotes" :include="PER_CHAT_ALLOWLIST" :notes="PER_CHAT_NOTES"
              :saving="chatOverrideSaving" save-label="写入覆盖" @save="saveChatOverrides" />
            <p v-else-if="chatOverrideOpen" class="empty-card"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在加载配置 schema…</p>
          </article>
          <div v-if="selectedChat" class="context-workbench">
            <article class="context-viewer">
              <header>
                <div><p class="eyebrow">MESSAGE WINDOW</p><h3>{{ selectedChatIdentity?.name }}</h3><p class="section-note">按时间倒序。灰显条目已移出窗口，下一轮不发给模型。</p></div>
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
                    <span :class="['context-msg-text', { structured: !message.textPreview }]">{{ message.textPreview || '[非文本内容，展开查看 parts]' }}</span>
                  </button>
                  <pre v-if="expandedMessages.has(String(message.id))" v-text="JSON.stringify(message, null, 2)" />
                  <small v-if="messageMeta(message).unseenOrdinals">未见 ordinal {{ messageMeta(message).unseenOrdinals }}</small>
                </li>
                <li v-if="!contextMessages.length" class="empty">暂无消息</li>
              </ol>
            </article>
            <article class="commit-timeline">
              <header><div><p class="eyebrow">COMMIT GRAPH</p><h3>提交与 HEAD</h3></div><UiTag v-if="contextHead" :value="`HEAD ${String(contextHead.id).slice(0, 8)}`" severity="secondary" /></header>
              <div class="head-actions">
                <p class="field-title">修改该会话的 HEAD</p>
                <p>只移动 <code>done</code> 指针，不删除消息：撤回上一次提交 = <code>/undo</code>，清空上下文窗口 = <code>/new</code>。回退用下方「回滚到此」。</p>
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
                <li v-if="!commits.length" class="empty">暂无 commit</li>
              </ol>
              <pre v-if="inspectedSnapshot" class="snapshot-preview" v-text="JSON.stringify(inspectedSnapshot, null, 2)" />
            </article>
          </div>
        </section>
        <section v-else-if="active === 'messages'" key="messages" class="surface page-surface">
          <header><div><p class="eyebrow">ARCHIVE</p><h2>消息与对话</h2><p>最近的模型对话，每页 {{ CONVERSATION_PAGE_SIZE }} 次</p></div></header>
          <div class="search-row">
            <label class="search grow"><i class="pi pi-search" /><input v-model="query" placeholder="搜索归档消息" @keyup.enter="searchArchive"></label>
            <UiButton label="搜索归档" icon="pi pi-search" :loading="searching" @click="searchArchive" />
            <UiButton v-if="searchHits" variant="outlined" label="返回最近对话" icon="pi pi-arrow-left" @click="clearSearch" />
          </div>
          <template v-if="searchHits">
            <div class="registry-heading"><div><h3>归档检索结果</h3><p class="section-note">「{{ searchTerm }}」命中 {{ searchHits.length }} 条（跨会话，最多 50 条）。</p></div></div>
            <DataGrid :rows="searchHits" :columns="COLUMNS.hits" data-key="id" paginate empty="无命中">
              <template #tgDate="{ data }">{{ new Date(data.tgDate).toLocaleString() }}</template>
              <template #from="{ data }"><UiTag :value="data.direction === 'out' ? 'bot' : 'user'" :severity="data.direction === 'out' ? 'info' : 'secondary'" /> {{ data.fromName ?? data.fromUsername ?? '—' }}</template>
              <template #text="{ data }"><span class="hit-text">{{ data.text ?? `[${data.kind}]` }}</span><AttachmentStrip :items="data.attachments ?? []" /></template>
              <template #detail="{ data }"><div class="section-actions"><UiButton v-if="data.turnId" size="small" variant="text" icon="pi pi-code" aria-label="查看该消息所在轮次的调用详情" @click="openDetail(data.turnId)" /><UiButton size="small" variant="text" icon="pi pi-database" aria-label="查看该消息的原始载荷" @click="inspectRaw(data.id)" /><UiButton size="small" variant="text" severity="danger" icon="pi pi-trash" aria-label="软删除该归档消息" @click="softDeleteMessage(data.id, '该归档消息')" /></div></template>
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
                    <p class="conversation-reply"><i class="pi pi-sparkles" aria-hidden="true" /><span>{{ turn.reply || (turn.error ? `（失败：${turn.error}）` : '（无回复）') }}</span></p>
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
              <li v-else-if="!conversations.length" class="empty">暂无对话</li>
            </ol>
            <footer v-if="conversationTotal" class="grid-pager">
              <span>共 {{ conversationTotal }} 次对话 · 第 {{ conversationPage }} / {{ conversationPages }} 页</span>
              <button type="button" aria-label="上一页" :disabled="conversationPage <= 1 || conversationLoading" @click="loadConversations(conversationPage - 1)"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
              <button type="button" aria-label="下一页" :disabled="conversationPage >= conversationPages || conversationLoading" @click="loadConversations(conversationPage + 1)"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
            </footer>
          </template>
        </section>
        <section v-else-if="active === 'tools'" key="tools" class="surface page-surface tool-page">
          <header><div><p class="eyebrow">TOOL CONTROL</p><h2>工具与权限</h2><p>工具可见性、调用权限、审批策略与执行环境</p></div><UiTag :value="`${enabledToolCount} / ${toolRows.length} 启用`" :severity="enabledToolCount === toolRows.length ? 'secondary' : 'warn'" /></header>
          <nav class="subtabs tool-tabs" aria-label="工具管理分区">
            <button v-for="[key, label, icon] in TOOL_TABS" :key="key" type="button" :class="{ active: toolTab === key }" @click="toolTab = key">
              <i :class="icon" aria-hidden="true" />{{ label }}
            </button>
          </nav>

          <div v-show="toolTab === 'catalog'" data-tool-tab="catalog" class="tool-tab-panel">
            <dl class="tool-summary-strip" aria-label="工具策略摘要">
              <div><dt>启用</dt><dd>{{ enabledToolCount }}<small>/ {{ toolRows.length }}</small></dd></div>
              <div><dt>策略覆盖</dt><dd>{{ overriddenToolCount }}</dd></div>
              <div><dt>需审批</dt><dd>{{ approvalToolCount }}</dd></div>
              <div><dt>折叠目录</dt><dd>{{ deferredToolCount }}</dd></div>
            </dl>
            <section class="tool-module tool-catalog-module">
              <header><div><h3>策略目录</h3><p class="section-note">选择工具以修改启停、最低角色、审批策略与超时。</p></div><UiTag :value="`${visibleToolRows.length} 项`" severity="secondary" /></header>
              <div class="tool-filterbar">
                <label class="tool-filter-search"><i class="pi pi-search" aria-hidden="true" /><input v-model="toolQuery" type="search" aria-label="搜索工具" placeholder="搜索名称、来源或作用域"></label>
                <UiSelect v-model="sideFilter" :options="SIDE_FILTERS" option-label="label" option-value="value" aria-label="可达侧" />
                <UiSelect v-model="toolVisibilityFilter" :options="TOOL_VISIBILITY_FILTERS" option-label="label" option-value="value" aria-label="模型可见性" />
              </div>
              <p class="tool-filter-note"><i class="pi pi-info-circle" aria-hidden="true" />可达侧与模型可见性均为只读状态。<code>tools.overrides.&lt;name&gt;.enabled=false</code> 才会在两侧停用工具。</p>
              <div class="tool-policy-list" role="list">
                <div class="tool-policy-head" aria-hidden="true"><span>工具</span><span>可达与可见性</span><span>权限策略</span><span>状态</span></div>
                <button v-for="row in pagedToolRows" :key="row.name" type="button" role="listitem" :class="['tool-policy-row', { disabled: !row.enabled, relaxed: row.relaxed?.length }]" @click="editTool(row)">
                  <span class="tool-identity">
                    <span class="tool-name"><i aria-hidden="true" /><code :title="row.name">{{ row.name }}</code></span>
                    <small>{{ TOOL_SOURCE_LABEL[row.source] ?? row.source }} · {{ SCOPE_LABEL[row.scope] ?? row.scope }}</small>
                  </span>
                  <span class="tool-visibility">
                    <span class="tool-route" aria-hidden="true"><b :class="{ active: row.sides?.includes('main') }">MAIN</b><i /><b :class="{ active: row.sides?.includes('worker') }">WORKER</b></span>
                    <small><b>{{ SIDE_LABEL[sideKey(row.sides)]!.label }}</b><span>·</span><b :class="row.deferred ? 'deferred' : 'resident'">{{ row.deferred ? '折叠' : '常驻' }}</b></small>
                  </span>
                  <span class="tool-permission">
                    <span><small>最低角色</small><UiTag :value="row.minRole" :severity="roleSeverity(row.minRole)" /><i v-if="row.defaults && row.minRole !== row.defaults.minRole" class="pi pi-pencil overridden" :title="`代码默认 ${row.defaults.minRole}`" /></span>
                    <span><small>审批</small><b>{{ APPROVAL_LABEL[row.approval] ?? row.approval }}</b><i v-if="row.defaults && row.approval !== row.defaults.approval" class="pi pi-pencil overridden" :title="`代码默认 ${row.defaults.approval}`" /></span>
                  </span>
                  <span class="tool-row-state"><span><UiTag :value="row.enabled ? '启用' : '已停用'" :severity="row.enabled ? 'success' : 'danger'" /><UiTag v-if="row.relaxed?.length" value="已放宽" severity="danger" :title="`${row.relaxed.join('、')} 比代码默认更宽松`" /></span><i class="pi pi-chevron-right" aria-hidden="true" /></span>
                </button>
                <div v-if="!pagedToolRows.length" class="empty tool-empty">没有符合筛选条件的工具</div>
              </div>
              <footer v-if="toolPages > 1" class="grid-pager tool-pager">
                <span>第 {{ toolPage }} / {{ toolPages }} 页</span>
                <button type="button" aria-label="上一页" :disabled="toolPage <= 1" @click="toolPage -= 1"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
                <button type="button" aria-label="下一页" :disabled="toolPage >= toolPages" @click="toolPage += 1"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
              </footer>
            </section>
          </div>

          <div v-show="toolTab === 'approval'" data-tool-tab="approval" class="tool-tab-panel">
            <section class="tool-module tool-approval-module">
              <header><div><h3>审批规则试跑</h3><p class="section-note">使用运行时 <code>ApprovalRules</code> 检查样例输入。</p></div><UiButton size="small" icon="pi pi-play" label="运行检查" :loading="ruleTesting" :disabled="!ruleTestTool" @click="testApprovalRule" /></header>
              <div class="approval-workbench">
                <div class="approval-input-panel">
                  <label>工具名<UiSelect v-model="ruleTestTool" :options="Object.keys(tools).map((name) => ({ value: name, label: name }))" filter aria-label="工具名" /></label>
                  <label>样例输入（JSON）<textarea v-model="ruleTestInput" rows="8" spellcheck="false" placeholder='{"command":"rm -rf /"}' /><small><code>pattern</code> 匹配 JSON 序列化结果，包含键名。</small></label>
                </div>
                <div class="approval-output-panel" aria-live="polite">
                  <template v-if="ruleTestResult">
                    <p :class="['callout', ruleTestResult.needed ? 'warn' : '']"><i :class="ruleTestResult.needed ? 'pi pi-shield' : 'pi pi-check-circle'" />{{ ruleTestResult.needed ? `需要审批 · 风险 ${ruleTestResult.risk}` : '不需要审批' }}<span v-if="ruleTestResult.runtimeDependent">存在 <code>when: target_exists</code> 规则，试跑无法判定。</span></p>
                    <ol class="rule-report"><li v-for="entry in ruleTestResult.rules" :key="entry.index" :class="{ matched: entry.matched }"><UiTag :value="entry.matched ? '命中' : '未命中'" :severity="entry.matched ? 'warn' : 'secondary'" /><code>#{{ entry.index }}</code><span>{{ entry.reason }}</span></li></ol>
                    <p v-if="!ruleTestResult.rules.length" class="empty">暂无审批规则</p>
                  </template>
                  <div v-else class="approval-placeholder"><i class="pi pi-shield" aria-hidden="true" /><b>等待检查</b><span>选择工具并输入样例参数</span></div>
                </div>
              </div>
              <p class="tool-module-foot">规则编辑入口：设置 → 全部配置 → <code>approval.rules</code></p>
            </section>
          </div>

          <div v-show="toolTab === 'runtime'" data-tool-tab="runtime" class="tool-tab-panel">
          <section class="tool-module">
          <header>
            <div><h3>沙箱</h3><p class="section-note">决定 <code>exec</code> 类工具的执行位置，保存后热更新。<code>bypassRoles</code> 中的角色<b>完全绕过</b>沙箱，直接在宿主执行。</p></div>
            <div class="section-actions">
              <UiButton size="small" variant="outlined" icon="pi pi-bolt" label="探测可用性" :loading="sandboxProbing" @click="probeSandbox" />
              <UiButton size="small" variant="outlined" icon="pi pi-cloud-download" label="拉取镜像" :loading="pullingImage" :disabled="sandboxForm.mode !== 'docker'" @click="pullSandboxImage" />
              <UiButton size="small" icon="pi pi-save" label="保存沙箱" :loading="sandboxSaving" :disabled="!sandboxDirty" @click="saveSandbox" />
            </div>
          </header>
          <div v-if="sandboxForm.mode === 'none'" class="danger-banner"><i class="pi pi-exclamation-triangle" /><code>mode = none</code>：exec 类工具不隔离，以 bot 进程权限在宿主执行模型给出的命令。</div>
          <div v-if="sandbox?.plan && !sandbox.plan.allowed" class="danger-banner"><i class="pi pi-exclamation-triangle" />沙箱对 owner 也不可用：{{ sandbox.plan.reason ?? '未知原因' }}。需要沙箱的工具将失败。</div>
          <p v-if="sandboxProbe" :class="['callout', sandboxProbe.available ? '' : 'warn']"><i :class="sandboxProbe.available ? 'pi pi-check-circle' : 'pi pi-times-circle'" />探测结果（基于<b>已保存</b>的配置）：{{ sandboxProbe.available ? `可用 · ${sandboxProbe.mode ?? sandboxForm.mode}` : sandboxProbe.error ?? '不可用' }}</p>
          <div class="form-grid">
            <label>模式<UiSelect v-model="sandboxForm.mode" :options="SANDBOX_MODES" @change="markSandboxDirty" /><small class="field-note">none 下非 bypassRoles 的角色无法获得执行类工具。</small></label>
            <label>容器网络<UiSelect v-model="sandboxForm.network" :options="[{ value: 'none', label: 'none · 断网' }, { value: 'bridge', label: 'bridge · 可出网' }]" :disabled="sandboxForm.mode !== 'docker'" @change="markSandboxDirty" /><small class="field-note">bridge 下模型生成的代码可访问公网与内网。</small></label>
            <label>镜像<input v-model="sandboxForm.image" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"></label>
            <label>docker 可执行文件<input v-model="sandboxForm.dockerBin" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"></label>
            <label>工作目录<input v-model="sandboxForm.workspaceDir" @input="markSandboxDirty"><small class="field-note">本进程内的路径，文件工具使用同一路径。</small></label>
            <label>宿主工作目录<input v-model="sandboxForm.hostWorkspaceDir" placeholder="非容器部署留空" :disabled="sandboxForm.mode !== 'docker'" @input="markSandboxDirty"><small class="field-note">bot 运行在容器内时必填：<code>-v</code> 使用<b>宿主</b>路径，留空会挂载到不存在的目录。</small></label>
            <label>内存上限（MB）<UiNumber :model-value="sandboxForm.memoryMb" :min="16" :step="64" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.memoryMb = $event; markSandboxDirty()" /></label>
            <label>CPU 核数<UiNumber :model-value="sandboxForm.cpus" :min="0.1" :step="0.5" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.cpus = $event; markSandboxDirty()" /></label>
            <label>进程数上限<UiNumber :model-value="sandboxForm.pidsLimit" :min="1" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.pidsLimit = $event; markSandboxDirty()" /></label>
            <label>tmpfs（MB）<UiNumber :model-value="sandboxForm.tmpfsMb" :min="1" :step="16" :disabled="sandboxForm.mode !== 'docker'" @update:model-value="sandboxForm.tmpfsMb = $event; markSandboxDirty()" /></label>
            <UiSwitch v-model="sandboxForm.readOnlyRoot" class="wide" label="根文件系统只读（仅工作目录与 tmpfs 可写）" :disabled="sandboxForm.mode !== 'docker'" @change="markSandboxDirty" />
            <div class="wide">
              <p class="field-title">绕过沙箱的角色<small>勾选的角色，exec 类工具直接在宿主执行。</small></p>
              <div class="trigger-switches">
                <UiCheckbox v-for="role in ROLES" :key="role" :model-value="sandboxForm.bypassRoles.includes(role)" :label="role" @change="toggleBypassRole(role)" />
              </div>
              <p v-if="sandboxForm.bypassRoles.some((role) => role !== 'owner')" class="field-note wake-issue"><i class="pi pi-exclamation-triangle" />owner 之外的角色也在绕过名单中：可让模型在宿主执行任意命令。保存时二次确认。</p>
            </div>
            <!-- `tools.fs.allowHostFsForOwner` 与上面那些不在同一棵配置子树下，但它是同一件事的另一半：
                 沙箱管「命令跑在哪儿」，它管「文件工具看得见哪儿」。此前沙箱页上没有它的任何入口，
                 只能从「设置 → 全部配置」里被渲染成一个普通开关（docs/29 · M-WEB-10）。 -->
            <div class="wide">
              <UiSwitch v-model="hostFsForOwner" label="owner 的文件工具可读写宿主全盘（allowHostFsForOwner）" @change="markSandboxDirty" />
              <p class="field-note" :class="hostFsForOwner ? 'wake-issue' : ''">
                <i v-if="hostFsForOwner" class="pi pi-exclamation-triangle" />
                <b>开启后模型可访问宿主全部文件系统</b>，含 <code>.env</code> 与本仓库。保存时二次确认。
              </p>
            </div>
          </div>
          </section>
          <section class="tool-module">
          <header>
            <div><h3>持久容器</h3><p class="section-note">启用后<b>每个群 / 私聊各有一个常驻容器</b>，执行走 <code>docker exec</code>，后台进程可保留到下一轮。仅在 <code>mode = docker</code> 下生效。</p></div>
          </header>
          <div v-if="sandboxForm.persistent.enabled" class="danger-banner"><i class="pi pi-exclamation-triangle" />持久容器<b>默认可出网</b>：<code>bridge</code> 下容器可直接访问公网与宿主。</div>
          <div class="form-grid">
            <UiSwitch v-model="sandboxForm.persistent.enabled" class="wide" label="启用会话级持久容器" :disabled="sandboxForm.mode !== 'docker'" @change="markSandboxDirty" />
            <label>闲置回收时长（小时）<UiNumber :model-value="hoursOf(sandboxForm.persistent.idleTtlMs)" :min="0.1" :step="1" :disabled="!sandboxForm.persistent.enabled" @update:model-value="sandboxForm.persistent.idleTtlMs = Math.round(($event ?? 0) * 3600000); markSandboxDirty()" /><small class="field-note">每次执行后重新计时，持续使用的容器不回收。</small></label>
            <label>最长存活（小时）<UiNumber :model-value="hoursOf(sandboxForm.persistent.maxLifetimeMs)" :min="0" :step="24" :disabled="!sandboxForm.persistent.enabled" @update:model-value="sandboxForm.persistent.maxLifetimeMs = Math.round(($event ?? 0) * 3600000); markSandboxDirty()" /><small class="field-note"><b>0 = 不设上限。</b>从创建算起，不因活跃延长；「钉住」无效。</small></label>
            <label>容器数上限<UiNumber :model-value="sandboxForm.persistent.maxContainers" :min="1" :disabled="!sandboxForm.persistent.enabled" @update:model-value="sandboxForm.persistent.maxContainers = $event; markSandboxDirty()" /><small class="field-note">达到上限时，新会话的执行类工具<b>直接报错</b>。</small></label>
            <label>持久容器网络<UiSelect v-model="sandboxForm.persistent.network" :options="[{ value: 'none', label: 'none · 断网' }, { value: 'bridge', label: 'bridge · 可出网' }]" :disabled="!sandboxForm.persistent.enabled" @change="markSandboxDirty" /><small class="field-note">与上方「容器网络」是<b>两个键</b>，分别作用于一次性与持久容器。</small></label>
            <label>回收频率（cron）<input v-model="sandboxForm.persistent.reapCron" :disabled="!sandboxForm.persistent.enabled" @input="markSandboxDirty"><small class="field-note">五段式。到期回收与「数据库 ↔ docker」对账由它触发。</small></label>
          </div>
          <p class="callout"><i class="pi pi-info-circle" />关闭该开关<b>不会立即销毁已有容器</b>：由下一次回收对账清理，在此之前 <code>docker ps</code> 仍可见。</p>
          <div class="registry-heading">
            <div><h4>当前容器</h4><p class="section-note">「重置」= 销毁并重建，容器内进程终止；工作区文件默认保留。</p></div>
            <UiTag :value="containers.available ? `${containers.used} / ${containers.max}` : '未装配'" :severity="containers.available && containers.used >= containers.max ? 'danger' : 'secondary'" />
          </div>
          <p v-if="!containers.available" class="callout warn"><i class="pi pi-exclamation-triangle" />该部署未装配持久容器运行时，无可显示的容器（<b>不等于容器数为 0</b>）。</p>
          <p v-else-if="!containers.enabled" class="callout"><i class="pi pi-info-circle" />持久容器未启用，下方为尚未回收的存量容器。</p>
          <DataGrid :rows="containers.containers" :columns="COLUMNS.containers" data-key="chatId" empty="暂无容器">
            <template #chat="{ data }"><div class="alias-name"><b>{{ data.chatLabel ?? `未登记会话 ${data.chatId}` }}</b></div><small class="hit-text">{{ data.chatId }}<template v-if="data.lastError"> · <span class="wake-issue">{{ data.lastError }}</span></template></small></template>
            <template #name="{ data }"><code>{{ data.name }}</code><small class="alias-empty">{{ data.image }}<template v-if="!data.hasSetsid"> · 无 setsid（取消时无法终止子进程）</template></small></template>
            <template #used="{ data }"><span>{{ new Date(data.lastUsedAt).toLocaleString() }}</span><small class="alias-empty">共 {{ data.execCount }} 次执行</small></template>
            <template #expires="{ data }"><UiTag :value="containerExpiry(data)" :severity="data.pinned ? 'info' : 'secondary'" /></template>
            <template #actions="{ data }"><div class="section-actions">
              <UiButton size="small" variant="outlined" :icon="data.pinned ? 'pi pi-lock-open' : 'pi pi-lock'" :label="data.pinned ? '取消钉住' : '钉住'" :loading="containerBusy === data.chatId" @click="keepContainer(data, { pin: !data.pinned })" />
              <UiButton size="small" variant="outlined" icon="pi pi-clock" label="+24h" :loading="containerBusy === data.chatId" @click="keepContainer(data, { hours: 24 })" />
              <UiButton size="small" variant="outlined" severity="danger" label="重置" :loading="containerBusy === data.chatId" @click="resetContainer(data, false)" />
              <UiButton size="small" variant="outlined" severity="danger" icon="pi pi-trash" title="重置并将工作区文件移入 .luoli-trash" :loading="containerBusy === data.chatId" @click="resetContainer(data, true)" />
            </div></template>
          </DataGrid>
          </section>
          </div>
        </section>
        <!-- 扩展页整段搬进 `ExtensionsPage.vue`（四类各一套版式 + MCP 登录，docs/09 §3.8）。
             `key` 是必须的：相邻页面都是 `<section>`，没有 key 时 Vue 认成同一个节点，
             只换内容不走过渡。 -->
        <ExtensionsPage
          v-else-if="active === 'extensions'" key="extensions"
          :skills="skills" :plugins="plugins" :mcp="mcp" :custom-tools="customTools" :config="config"
          @refresh="load"
        />
        <!-- Worker 运行记录页整段在 `WorkerRunsPage.vue`（两张卡竖排：运行记录 → 试跑，docs/09 §3.9）。
             `key` 同上是必须的。 -->
        <WorkerRunsPage
          v-else-if="active === 'workers'" key="workers"
          :tick="workerTick"
          @open-turn="openDetail" @open-trace="openTrace"
        />
        <!-- SDK 接入页整段在 `SdkPage.vue`（来源列表 + 新建，密钥管理在详情弹窗里，
             docs/12-sdk.md T3.11）。`key` 同上是必须的。 -->
        <SdkPage v-else-if="active === 'sdk'" key="sdk" />
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
            <!-- 缓存命中：`cache_read_tokens` 一直在记账里，但此前没有任何一处把它除以输入。
                 中转站的前缀缓存可能是概率性的（同一份请求发两次，一次命中一次不命中），
                 这时「哪家上游值得开缓存」只有按 provider 分维度看这个数才答得出（docs/04 §5.1.1）。 -->
            <article class="surface inner"><header><div><h3>缓存命中</h3><p class="section-note">cache_read / 输入 token</p></div><UiTag :value="`合计 ${usageTotals.hitRate}`" :severity="usageTotals.cacheRead ? 'success' : 'secondary'" /></header>
              <UiBarChart :rows="usageCacheRows" :format="(value) => `${value}%`" />
            </article>
          </div>
          <h3 class="usage-detail-title">明细</h3>
          <DataGrid :rows="usage" :columns="COLUMNS.usage" data-key="id" paginate empty="暂无用量">
            <template #ts="{ data }">{{ new Date(data.ts).toLocaleString() }}</template>
            <template #cost_usd="{ data }">${{ Number(data.cost_usd).toFixed(4) }}</template>
          </DataGrid>
        </section>

        <section v-else-if="active === 'quota'" key="quota" class="surface page-surface">
          <header><div><p class="eyebrow">SPEND LIMITS</p><h2>配额</h2><p>限额是配置项（热更新）；计数器是 <code>quota_counters</code> 中的实时值。开启轮次按估算预留，结束后按实际结算。</p></div><UiTag :value="quotaForm.enabled ? '配额生效中' : '配额已关闭'" :severity="quotaForm.enabled ? 'success' : 'danger'" /></header>
          <div v-if="!quotaForm.enabled" class="danger-banner"><i class="pi pi-exclamation-triangle" /><code>quota.enabled</code> 已关闭：所有金额限额不再判定。频率限制不受该开关影响，仍然生效。</div>
          <div v-if="quota && quota.unpricedTotal" class="danger-banner"><i class="pi pi-exclamation-triangle" />有 <b>{{ quota.unpricedTotal }}</b> 个启用中的模型缺少定价，这些轮次<b>花费按 0 记账</b>，限额无法拦截：<code>{{ quota.unpriced.map((entry) => entry.modelId).join('、') }}</code><UiButton size="small" variant="text" label="补齐定价" @click="active = 'providers'" /></div>

          <div class="registry-heading">
            <div><h3>限额</h3><p class="section-note">金额留空 = 不限。三层同时判定，任一层超限即拒绝：全局 → 会话 → 用户。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存配额" :loading="quotaSaving" :disabled="!quotaDirty" @click="saveQuota" />
          </div>
          <div class="form-grid">
            <div class="trigger-switches">
              <UiSwitch v-model="quotaForm.enabled" label="启用金额配额" @change="markQuotaDirty" />
              <UiSwitch v-model="quotaForm.requirePricing" label="模型缺少定价时拒绝开启轮次" @change="markQuotaDirty" />
            </div>
            <label>最小预留（美元）<UiNumber :model-value="quotaForm.minReserveUsd" :min="0" :step="0.01" @update:model-value="quotaForm.minReserveUsd = $event; markQuotaDirty()" /><small class="field-note">估算低于该值时按该值预留。</small></label>
            <p class="field-note wide"><code>requirePricing</code> 对 owner 不生效，该轮记 0 美元。</p>
            <p class="field-title wide">按范围的金额上限<small>bucket 按 <code>{{ quota?.timezone ?? 'general.timezone' }}</code> 切换的当地自然日 / 月。</small></p>
            <label>全局 · 每日<UiNumber :model-value="quotaForm.globalDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.globalDaily = $event; markQuotaDirty()" /></label>
            <label>全局 · 每月<UiNumber :model-value="quotaForm.globalMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.globalMonthly = $event; markQuotaDirty()" /></label>
            <label>单会话 · 每日<UiNumber :model-value="quotaForm.chatDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.chatDaily = $event; markQuotaDirty()" /></label>
            <label>单会话 · 每月<UiNumber :model-value="quotaForm.chatMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.chatMonthly = $event; markQuotaDirty()" /></label>
            <label>单用户 · 每日<UiNumber :model-value="quotaForm.userDaily" :min="0" :step="0.5" placeholder="不限" @update:model-value="quotaForm.userDaily = $event; markQuotaDirty()" /></label>
            <label>单用户 · 每月<UiNumber :model-value="quotaForm.userMonthly" :min="0" :step="5" placeholder="不限" @update:model-value="quotaForm.userMonthly = $event; markQuotaDirty()" /></label>
            <p class="field-note wide">推荐 <code>单用户 ≤ 单会话 ≤ 全局</code>。</p>
            <p class="field-title wide">按角色覆盖单用户额度<small>留空 = 沿用上方单用户的值。</small></p>
            <div class="wide quota-roles">
              <div v-for="role in ROLES" :key="role" class="quota-role">
                <UiTag :value="role" :severity="roleSeverity(role)" />
                <label>每日<UiNumber :model-value="quotaForm.byRole[role].daily" :min="0" :step="0.5" placeholder="继承" @update:model-value="quotaForm.byRole[role].daily = $event; markQuotaDirty()" /></label>
                <label>每月<UiNumber :model-value="quotaForm.byRole[role].monthly" :min="0" :step="5" placeholder="继承" @update:model-value="quotaForm.byRole[role].monthly = $event; markQuotaDirty()" /></label>
              </div>
            </div>
            <p class="field-note wide"><i class="pi pi-info-circle" />覆盖只能填<b>具体金额</b>：<code>null</code> 回落到单用户额度，解除限制需同时清空单用户输入框。判定使用<b>有效角色</b>。</p>
            <p class="field-title wide">单轮上限<small>单轮内的硬限制，与上方日 / 月额度独立。</small></p>
            <label>单轮成本上限（美元）<UiNumber :model-value="quotaForm.maxCostUsd" :min="0.001" :step="0.1" @update:model-value="quotaForm.maxCostUsd = $event; markQuotaDirty()" /><small class="field-note">触发后清空工具目录并强制收尾；worker 花费一并计入。</small></label>
            <label>单轮步数上限<UiNumber :model-value="quotaForm.maxSteps" :min="1" :max="200" @update:model-value="quotaForm.maxSteps = $event; markQuotaDirty()" /><small class="field-note">与 <code>agent.main.maxSteps</code> 取较小者生效。</small></label>
            <p class="field-title wide">频率限制<small>按最近 1 小时的 turns 表统计，<b>不受上方「启用金额配额」开关影响</b>。</small></p>
            <label>每人每小时轮次<UiNumber :model-value="quotaForm.turnsPerUserPerHour" :min="1" @update:model-value="quotaForm.turnsPerUserPerHour = $event; markQuotaDirty()" /></label>
            <label>每会话每小时轮次<UiNumber :model-value="quotaForm.turnsPerChatPerHour" :min="1" @update:model-value="quotaForm.turnsPerChatPerHour = $event; markQuotaDirty()" /></label>
            <label>单用户并发轮次<UiNumber :model-value="quotaForm.concurrentPerUser" :min="1" @update:model-value="quotaForm.concurrentPerUser = $event; markQuotaDirty()" /></label>
            <p class="field-title wide">超限时</p>
            <UiSwitch v-model="quotaForm.reply" class="wide" @change="markQuotaDirty">在群内回复一条说明<small class="field-note">关闭后被拒用户无提示，仅记一条 <code>quota.exceeded</code>。</small></UiSwitch>
            <label class="wide">提示文案<textarea v-model="quotaForm.message" rows="2" spellcheck="false" @input="markQuotaDirty" /><small class="field-note"><i class="pi pi-exclamation-triangle" /><code>{spent}</code> / <code>{limit}</code> 将被替换为 <code>—</code>，<code>{resetAt}</code> 替换为「下个额度窗口」。</small></label>
            <div v-if="quota?.unimplemented.length" class="wide quota-unimplemented">
              <p class="field-title"><i class="pi pi-ban" />schema 中存在但<b>运行时没有代码读取</b>的配额项</p>
              <ul><li v-for="key in quota.unimplemented" :key="key"><code>{{ key }}</code><span>{{ QUOTA_UNIMPLEMENTED_HINTS[key] ?? '未接线' }}</span></li></ul>
            </div>
          </div>

          <div class="registry-heading">
            <div><h3>当前计数器</h3><p class="section-note">当前 bucket：日 <code>{{ quota?.buckets.day ?? '—' }}</code> · 月 <code>{{ quota?.buckets.month ?? '—' }}</code>。<b>已用</b> = 已结算花费 + 在途预留。</p></div>
            <div class="section-actions">
              <UiCheckbox v-if="staleCounters" v-model="quotaShowHistory" :label="`含历史 bucket（${staleCounters} 行）`" />
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
                <UiTag v-if="!row.current" value="历史窗口" severity="secondary" title="不属于当前 bucket，不参与判定" />
                <code>{{ row.window === 'day' ? '日' : '月' }} {{ row.bucket }}</code>
                <UiButton variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="重置该行计数" :loading="quotaResetting === counterKey(row)" @click="resetQuota(row)" />
              </div>
              <div class="quota-meter"><span :style="{ width: `${counterRatio(row) * 100}%` }" /></div>
              <div class="quota-counter-foot">
                <span>已用 <b>{{ money(spent(row)) }}</b> / {{ row.limit === null ? '不限' : `${row.limitApprox ? '≈' : ''}${money(row.limit)}` }}</span>
                <small v-if="row.reservedUsd > 0">其中在途预留 {{ money(row.reservedUsd) }}</small>
                <small>{{ row.turns }} 轮 · {{ new Date(row.updatedAt).toLocaleString() }}</small>
              </div>
              <small v-if="row.limitApprox" class="field-note">该档位取自用户自身角色；实际判定使用有效角色。</small>
            </article>
            <article v-if="!visibleCounters.length" class="empty-card"><i class="pi pi-gauge" /><h3>{{ quota?.counters.length ? '当前窗口无花费' : '暂无计数' }}</h3><p>{{ quota?.counters.length ? `${staleCounters} 行属于历史 bucket，勾选上方可查看。` : '按 全局 / 会话 / 用户 × 日 / 月 六个维度记账。' }}</p></article>
          </div>
        </section>
        <section v-else-if="active === 'principals'" key="principals" class="surface page-surface"><header><div><p class="eyebrow">ACCESS CONTROL</p><h2>主体与权限</h2><p>有效角色取用户与群角色的较高者，群内封顶 trusted；任一方为 blocked 则不响应。点击一行修改角色。</p></div><UiButton label="批量导入" icon="pi pi-upload" @click="openBulk" /></header>
          <nav class="subtabs" aria-label="主体类型">
            <button v-for="[key, label] in PRINCIPAL_KINDS" :key="key" type="button" :class="{ active: principalKind === key }" @click="principalKind = key">{{ label }}<span>{{ principalCount(key) }}</span></button>
          </nav>
          <div v-if="principalSelection.length" class="bulk-bar">
            <i class="pi pi-check-square" aria-hidden="true" /><span>已勾选 <b>{{ principalSelection.length }}</b> 个主体</span>
            <UiButton size="small" variant="text" label="清空勾选" @click="principalSelection = []" />
            <UiButton size="small" icon="pi pi-user-edit" label="批量改角色" @click="openRoleBulk" />
          </div>
          <DataGrid v-model:selection="principalSelection" :rows="visiblePrincipals" :columns="COLUMNS.principals" data-key="id" paginate :page-size="12" clickable :empty="principalKind === 'group' ? '暂无群 / 频道' : principalKind === 'user' ? '暂无用户' : '暂无主体'" @row-click="editPrincipal">
            <!-- kind 只有 user / chat 两个取值，而 chat 涵盖私聊 —— 标签按 chat_type 出（docs/21 · G-UI-01） -->
            <template #kind="{ data }"><UiTag :value="principalKindLabel(data)" :severity="data.kind === 'user' ? 'secondary' : isPrivatePrincipal(data) ? 'warn' : 'info'" /></template>
            <template #displayName="{ data }"><span class="alias-name">{{ data.displayName ?? '—' }}<UiTag v-if="data.id === ownerPrincipalId" value="引导 OWNER" severity="success" title="access.bootstrapOwnerId 指向的主体；修改其角色后，Telegram 侧将无人可管理 bot" /></span></template>
            <template #username="{ data }">{{ data.username ? `@${data.username}` : '—' }}</template>
            <template #role="{ data }"><UiTag :value="data.role" :severity="roleSeverity(data.role)" /></template>
          </DataGrid>
        </section>
        <section v-else-if="active === 'providers'" key="providers" class="surface page-surface">
          <header><div><p class="eyebrow">MODEL REGISTRY</p><h2>Provider、模型与别名</h2><p>管理 Provider 与模型，修改实时生效</p></div><UiButton label="添加 Provider" icon="pi pi-plus" @click="editProvider()" /></header>
          <div v-if="modelMissingMain" class="danger-banner"><i class="pi pi-exclamation-triangle" />没有可用的 <code>main</code> 别名，所有轮次都会失败。见下方「别名路由」。</div>
          <div class="provider-grid"><article v-for="provider in providers" :key="provider.id"><div class="provider-head"><div class="provider-tags"><UiTag :value="provider.enabled ? '启用' : '停用'" :severity="provider.enabled ? 'success' : 'secondary'" /><UiTag v-if="provider.healthState" :value="provider.healthState === 'up' ? '连通' : '不可用'" :severity="provider.healthState === 'up' ? 'success' : 'danger'" /></div><div class="card-actions"><UiButton variant="text" size="small" icon="pi pi-bolt" aria-label="测试连接" :loading="testingProvider === provider.id" @click="testProvider(provider)" /><UiButton variant="text" size="small" icon="pi pi-cloud-download" aria-label="从该 Provider 拉取模型" @click="openCatalog(provider.id)" /><UiButton variant="text" size="small" icon="pi pi-pencil" aria-label="编辑 Provider" @click="editProvider(provider)" /><UiButton variant="text" size="small" severity="danger" icon="pi pi-trash" aria-label="删除 Provider" @click="removeProvider(provider.id)" /></div></div><h3>{{ provider.name }}</h3><p>{{ provider.kind }}</p><code>{{ provider.apiKeyHint ?? '未设置密钥' }}</code><small v-if="provider.healthError" class="provider-error">{{ provider.healthError }}</small></article></div>
          <div class="registry-heading"><div><h3>模型</h3><p class="section-note">元数据来自 models.dev 本地缓存，导入时带入；<code>补齐元数据</code>仅填空缺价格。点击任一行可手动标记<b>看图能力</b>，优先于目录且不被<code>补齐元数据</code>撤销。</p></div><div class="section-actions"><UiButton size="small" variant="outlined" icon="pi pi-cloud-download" label="从 Provider 拉取" :disabled="!providers.length" @click="openCatalog()" /><UiButton size="small" variant="outlined" icon="pi pi-sparkles" label="补齐元数据" :disabled="!models.length" :loading="enriching" @click="enrichModels" /><UiButton size="small" variant="outlined" label="添加模型" @click="editModel()" /></div></div>
          <DataGrid :rows="models" :columns="COLUMNS.models" data-key="id" clickable empty="暂无模型" @row-click="editModel">
            <template #provider_id="{ data }">{{ providerLabel(String(data.provider_id)) }}</template>
            <template #context_window="{ data }"><span v-if="windowMetric(data.context_window).unit" class="metric-chip" :style="{ minWidth: modelMetricWidths.window }">{{ metricText(windowMetric(data.context_window)) }}</span><span v-else>—</span></template>
            <template #capabilities="{ data }"><span v-if="capabilityTags(storedMeta(data)).length || manualVision(data) !== 'follow'" class="cap-tags"><UiTag v-for="tag in capabilityTags(storedMeta(data))" :key="tag" :value="tag" severity="secondary" /><UiTag v-if="manualVision(data) !== 'follow'" :value="manualVision(data) === 'on' ? '手标 · 能看图' : '手标 · 看不了图'" :severity="manualVision(data) === 'on' ? 'info' : 'warn'" title="手动标记优先于 models.dev，「补齐元数据」不会撤销" /></span><small v-else class="catalog-sub">未知</small></template>
            <template #price_in="{ data }"><span v-if="priceMetric(data.price_in).unit" class="metric-chip" :style="{ minWidth: modelMetricWidths.priceIn }">{{ metricText(priceMetric(data.price_in)) }}</span><span v-else>—</span><small v-if="storedPriceSource(data)" class="catalog-sub">{{ storedPriceSource(data) === 'manual' ? '手工填写' : MATCH_LABELS[String(storedPriceSource(data))]?.label ?? '' }}</small><small v-else-if="data.price_in === null" class="catalog-sub match-third-party">缺定价 · 花费按 0 记账</small></template>
            <template #price_out="{ data }"><span v-if="priceMetric(data.price_out).unit" class="metric-chip" :style="{ minWidth: modelMetricWidths.priceOut }">{{ metricText(priceMetric(data.price_out)) }}</span><span v-else>—</span></template>
            <template #enabled="{ data }"><UiTag :value="data.enabled ? '启用' : '停用'" :severity="data.enabled ? 'success' : 'secondary'" /></template>
            <!-- 行本身是「点开编辑」，所以这颗按钮必须 @click.stop —— 不然点删除会同时弹出编辑框 -->
            <template #actions="{ data }"><UiButton size="small" variant="text" severity="danger" icon="pi pi-trash" :aria-label="`删除模型 ${data.model_id}`" @click.stop="removeModel(String(data.id), String(data.model_id))" /></template>
          </DataGrid>
          <div class="registry-heading"><div><h3>别名路由</h3><p class="section-note">别名指向一条有序的 fallback 链，前一个模型不可用时顺延。下方六个是内建别名，<code>main</code> 必须配置。</p></div><UiButton size="small" variant="outlined" label="添加自定义别名" @click="editAlias()" /></div>
          <ul class="alias-route-list" aria-label="模型别名路由列表">
            <li v-for="data in aliasRows" :key="data.alias" :data-alias="data.alias" :class="['alias-route-item', `state-${data.state}`]">
              <div class="alias-route-head">
                <div class="alias-route-copy">
                  <div class="alias-route-title">
                    <code>{{ data.alias }}</code>
                    <span :class="['alias-health', data.state]" :title="data.state === 'ok' ? '链中至少有一个可用模型' : ALIAS_STATE_TAG[data.state].hint"><i aria-hidden="true" />{{ data.state === 'ok' ? '可用' : ALIAS_STATE_TAG[data.state].label }}</span>
                    <UiTag v-if="!data.validName" value="名称不合法" severity="warn" title="别名须以小写字母开头且只含 [a-z0-9_-]；该行只能删除后重建" />
                  </div>
                  <p>{{ data.purpose }}</p>
                  <div v-if="data.tier || data.description" class="alias-route-notes"><span v-if="data.tier">建议档位：{{ data.tier }}</span><span v-if="data.description">备注：{{ data.description }}</span></div>
                </div>
                <div class="alias-route-actions">
                  <UiButton variant="outlined" size="small" :icon="data.state === 'absent' ? 'pi pi-plus' : 'pi pi-pencil'" :label="data.state === 'absent' ? '配置' : '编辑'" :aria-label="`${data.state === 'absent' ? '配置' : '编辑'}别名 ${data.alias}`" @click="editAlias(data)" />
                  <UiButton v-if="data.state !== 'absent'" variant="text" size="small" severity="danger" icon="pi pi-trash" :aria-label="`删除别名 ${data.alias}`" @click="removeAlias(data.alias)" />
                </div>
              </div>
              <div class="alias-route-body">
                <section class="alias-route-chain" :aria-label="`${data.alias} fallback 顺序`">
                  <p class="alias-route-label">Fallback 顺序</p>
                  <ol v-if="data.chain.length" class="alias-chain-list">
                    <li v-for="(segment, index) in data.chain" :key="segment.id" :class="['alias-chain-item', segment.state]" :title="segment.state === 'missing' ? '模型记录已删除' : segment.state === 'disabled' ? '模型已停用，会被跳过' : ''">
                      <span class="alias-chain-step">{{ index + 1 }}</span>
                      <div><code class="alias-chain-model">{{ segment.label }}</code><small v-if="segment.state !== 'ok'">{{ segment.state === 'missing' ? '模型记录已删除' : '模型已停用，路由时跳过' }}</small></div>
                    </li>
                  </ol>
                  <div v-else class="alias-route-empty"><i class="pi pi-arrow-right" aria-hidden="true" /><span>{{ data.alias === 'main' ? '未设置模型。所有轮次都会失败。' : '未单独设置。按 main → high → low 回退。' }}</span></div>
                </section>
                <dl class="alias-route-settings">
                  <dt>采样参数</dt>
                  <dd>{{ settingsSummary(data.settings) }}</dd>
                </dl>
              </div>
            </li>
          </ul>
        </section>
        <section v-else-if="active === 'logs'" key="logs" class="surface page-surface"><header><div><p class="eyebrow">OBSERVABILITY</p><h2>日志与 Trace</h2><p>点击任一行查看完整载荷，详情中可展开整条 trace。</p></div><UiTag :value="connected ? '实时' : '重连中'" :severity="connected ? 'success' : 'warn'" /></header>
          <DataGrid :rows="logs" :columns="COLUMNS.logs" data-key="id" paginate clickable empty="暂无日志" @row-click="openLogDetail($event)">
            <template #ts="{ data }">{{ new Date(data.ts).toLocaleString() }}</template>
            <template #level="{ data }"><span :class="['level', data.level]">{{ data.level }}</span></template>
            <template #data_bytes="{ data }"><small>{{ data.data_bytes ? formatBytes(data.data_bytes) : '—' }}</small></template>
          </DataGrid>
          <article v-if="traceDetail.length" class="inspector"><header><b>Trace {{ traceDetail[0]?.trace_id }}</b><UiTag :value="`${traceDetail.length} spans`" /></header><ol><li v-for="(node, index) in traceDetail" :key="node.id" :style="{ marginLeft: `${(traceIndent[index] ?? 0) * 24}px` }"><code>{{ node.kind }}</code><span>{{ node.summary }}</span><small>{{ node.duration_ms ?? 0 }} ms</small></li></ol></article>
        </section>
        <section v-else-if="active === 'prompts'" key="prompts" class="surface page-surface"><header><div><p class="eyebrow">PROMPT WORKSPACE</p><h2>提示词编辑与版本</h2><p class="u-size-sm" style="--u-base: 14px">提示词与长期记忆管理</p></div><UiButton label="预览组装" icon="pi pi-eye" @click="openPromptPreview" /></header>
          <div class="prompt-workbench">
            <div class="prompt-cards">
              <button v-for="doc in promptCards" :key="String(doc.id)" type="button" :class="['prompt-card', { active: String(selectedPrompt?.id ?? '') === String(doc.id) }]" @click="inspectPrompt(doc)">
                <span class="prompt-icon"><i :class="promptMeta(doc.scope).icon" aria-hidden="true" /></span>
                <b>{{ promptMeta(doc.scope).label }}</b>
                <UiTag :value="doc.subject ? String(doc.subject) : '全局'" :severity="promptMeta(doc.scope).severity" />
                <p>{{ promptMeta(doc.scope).purpose }}</p>
                <code>{{ doc.id }}</code>
                <small>{{ Number(doc.bytes ?? 0).toLocaleString() }} 字节 · {{ Number(doc.tokens ?? 0).toLocaleString() }} tok · {{ doc.updated_at ? new Date(Number(doc.updated_at)).toLocaleString() : '未写入' }}</small>
              </button>
              <p v-if="!promptCards.length" class="empty">暂无提示词文档。首次启动时从 <code>memory/</code> 扫描 CHARACTER / ASSIST / PUBMEMORY。</p>
            </div>
            <article v-if="selectedPrompt" class="editor-panel">
              <header><div><b>{{ selectedPrompt.id }}</b><small>{{ promptMeta(selectedPrompt.scope).label }} · {{ selectedPrompt.path }}</small></div><UiButton label="保存版本" icon="pi pi-save" @click="savePrompt" /></header>
              <p v-if="selectedPrompt.scope === 'primemory'" class="callout warn"><i class="pi pi-lock" aria-hidden="true" />私有记忆：查看与修改均写入 <code>memory_revisions</code> 审计。</p>
              <textarea v-model="promptContent" spellcheck="false" aria-label="提示词内容" />
              <h3>版本记录</h3>
              <ol class="revision-list"><li v-for="revision in promptRevisions" :key="String(revision.id)"><div><code>{{ String(revision.id).slice(0, 12) }}</code><small>{{ revision.actor }} · {{ new Date(Number(revision.ts)).toLocaleString() }}</small></div><UiButton size="small" variant="text" label="回滚" @click="rollbackPrompt(revision.id)" /></li><li v-if="!promptRevisions.length" class="empty">暂无版本</li></ol>
            </article>
            <article v-else class="editor-panel empty-card"><i class="pi pi-align-left" aria-hidden="true" /><h3>选择一份文档开始编辑</h3><p>版本记录支持回滚</p></article>
          </div>
        </section>
        <!-- 任务页整段搬进 `TasksPage.vue`（三张卡竖排：任务 → 定时任务 → 审批，docs/09 §3.10.1）。
             `key` 是必须的：相邻页面都是 `<section>`，没有 key 时 Vue 认成同一个节点，
             只换内容不走过渡。 -->
        <TasksPage
          v-else-if="active === 'tasks'" key="tasks"
          :tick="tick" :chats="chats" :approval-rules-empty="approvalRulesEmpty" :conditional-tool-names="conditionalToolNames"
          @approvals-changed="loadApprovalBadge" @open-turn="openDetail" @open-trace="openTrace"
        />
        <section v-else-if="active === 'settings'" key="settings" class="surface page-surface">
          <header><div><p class="eyebrow">CONFIGURATION</p><h2>配置与维护</h2><p>完整合并配置已通过 zod 校验；密钥字段不会回显。</p></div></header>
          <nav class="subtabs" aria-label="设置分区">
            <button v-for="[key, label, hint] in SETTINGS_TABS" :key="key" type="button" :class="{ active: settingsTab === key }" :title="hint" @click="settingsTab = key">{{ label }}</button>
          </nav>
          <!-- 前三个 tab 是 v-show 而不是 v-if：触发 / 输出 / 全量表单各自握着未保存的草稿，v-if 会在切 tab 时
               连同草稿一起销毁 —— 表现是「改了一半去看别的 tab，回来什么都没了、也没有任何提示」。
               「高级」反过来必须 v-if：它要把整份合并配置 stringify 一遍（docs/09 §3.13）。 -->
          <div v-show="settingsTab === 'common'" data-settings-tab="common">
          <div class="registry-heading">
            <div><h3>触发与唤醒词</h3><p class="section-note">五个来源取并集，命中任一条即开启轮次；群内无命中的消息仅作背景发言存档。保存后热更新。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存触发设置" :loading="triggerSaving" :disabled="!triggerDirty" @click="saveTrigger" />
          </div>
          <div class="settings-list" role="list" aria-label="触发与唤醒词配置列表">
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>触发来源</b><small>命中任一来源即开启轮次</small></div>
              <div class="settings-control trigger-switches">
                <UiCheckbox v-model="triggerForm.private" label="私聊消息" @change="markTriggerDirty" />
                <UiCheckbox v-model="triggerForm.mention" label="@ 提及" @change="markTriggerDirty" />
                <UiCheckbox v-model="triggerForm.reply" label="回复 bot" @change="markTriggerDirty" />
                <UiCheckbox v-model="triggerForm.command" label="bot 命令" @change="markTriggerDirty" />
                <UiCheckbox v-model="triggerForm.channels" label="频道消息" @change="markTriggerDirty" />
              </div>
              <small class="settings-meta">五个来源取并集，不是互斥选项。群内未命中的消息仅作背景发言存档。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>唤醒词</b><small>私聊不判定唤醒词</small></div>
              <div class="settings-control">
                <div class="wake-list">
                  <span v-for="entry in wakewordStatus" :key="entry.pattern" :class="['wake-chip', { bad: !entry.ok }]" :title="entry.reason ?? ''">
                    <code>{{ entry.pattern }}</code>
                    <UiTag :value="entry.kind === 'regex' ? '正则' : '包含'" :severity="entry.kind === 'regex' ? 'info' : 'secondary'" />
                    <UiTag v-if="!entry.ok" value="不生效" severity="danger" />
                    <button type="button" aria-label="删除唤醒词" @click="removeWakeword(entry.pattern)"><i class="pi pi-times" /></button>
                  </span>
                  <span v-if="!triggerForm.wakewords.length" class="alias-empty">未配置唤醒词：群内仅能 @ 提及、回复或命令触发。</span>
                </div>
                <div class="wake-add"><input v-model="newWakeword" aria-label="新唤醒词" placeholder="例如 洛璃 或 ^璃酱[，,、 ]" @keyup.enter="addWakeword"><UiButton size="small" variant="outlined" icon="pi pi-plus" label="添加" @click="addWakeword" /></div>
              </div>
              <div class="settings-meta">
                <small>不以 <code>^</code> 开头为忽略大小写的包含匹配；以 <code>^</code> 开头为大小写敏感的正则，仅扫描前 4096 字符。</small>
                <small v-for="entry in wakewordStatus.filter((item) => !item.ok)" :key="`bad-${entry.pattern}`" class="wake-issue"><i class="pi pi-exclamation-triangle" />「{{ entry.pattern }}」{{ entry.reason }}。匹配时跳过，保存也会被拒绝。</small>
              </div>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>唤醒词最短长度</b><small>按 <code>^</code> 之后的字符数计</small></div>
              <label class="settings-control"><span class="sr-only">唤醒词最短长度</span><UiNumber :model-value="triggerForm.wakewordMinLength" :min="1" :max="32" @update:model-value="changeWakewordMinLength" /></label>
              <small class="settings-meta">短于该长度的唤醒词整条忽略。可设置范围：1–32。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>触发行为</b><small>附加的消息判定规则</small></div>
              <div class="settings-control switch-column">
                <UiSwitch v-model="triggerForm.requireTextAfterMention" label="仅 @ 而无正文时不触发" @change="markTriggerDirty" />
                <UiSwitch v-model="triggerForm.ignoreEditedAsTrigger" disabled>编辑旧消息不重新触发<UiTag value="未接线" severity="secondary" title="编辑消息按背景消息归档，运行时无代码读取该开关" /></UiSwitch>
              </div>
              <small class="settings-meta">会话级 <code>perChat.&lt;contextKey&gt;.trigger</code> 覆盖全局值；入口在会话页。</small>
            </div>
          </div>
          <div class="registry-heading">
            <div><h3>输出节奏</h3><p class="section-note">流式模式先缓冲再发首条，之后按固定间隔编辑同一条消息。<b>等待文案</b>也在此配置，保存后下一轮生效。</p></div>
            <UiButton size="small" icon="pi pi-save" label="保存输出节奏" :loading="outputSaving" :disabled="!outputDirty" @click="saveOutput" />
          </div>
          <div class="settings-list" role="list" aria-label="输出节奏配置列表">
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>输出模式</b><small>消息的生成与发送方式</small></div>
              <label class="settings-control"><span class="sr-only">输出模式</span><UiSelect v-model="outputForm.mode" :options="[{ value: 'stream', label: 'stream · 边生成边编辑' }, { value: 'once', label: 'once · 生成完一次性发出' }]" @change="markOutputDirty" /></label>
              <small class="settings-meta"><code>once</code> 模式不使用首帧缓冲、编辑间隔和最小增量。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>防秒回等待</b><small>从用户消息到达开始计算</small></div>
              <label class="settings-control"><span class="sr-only">防秒回等待毫秒数</span><UiNumber :model-value="outputForm.replyDelayMs" :min="0" :max="30000" :step="500" @update:model-value="changeOutputNumber('replyDelayMs', $event)" /></label>
              <small class="settings-meta">模型耗时已超过设定值时不再延迟；0 表示立即回复。单位：毫秒。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>首帧缓冲</b><small>从上游首个 chunk 到达开始计算</small></div>
              <label class="settings-control"><span class="sr-only">首帧缓冲毫秒数</span><UiNumber :model-value="outputForm.streamBufferMs" :min="0" :max="30000" :step="500" @update:model-value="changeOutputNumber('streamBufferMs', $event)" /></label>
              <small class="settings-meta">窗口内生成结束时立即发出；仅 <code>stream</code> 模式生效。单位：毫秒。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>流式编辑阈值</b><small>两项同时满足才更新消息</small></div>
              <div class="settings-control control-pair">
                <label><span>编辑间隔（毫秒）</span><UiNumber :model-value="outputForm.streamIntervalMs" :min="200" :max="30000" :step="500" @update:model-value="changeOutputNumber('streamIntervalMs', $event)" /></label>
                <label><span>最小增量（字）</span><UiNumber :model-value="outputForm.streamMinDeltaChars" :min="1" :max="2000" @update:model-value="changeOutputNumber('streamMinDeltaChars', $event)" /></label>
              </div>
              <small class="settings-meta">首条发送计为一次刷新；收尾编辑不受间隔和增量约束。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>等待文案</b><small>一行一条，空行保存时过滤</small></div>
              <label class="settings-control"><span class="sr-only">等待文案</span><textarea v-model="outputForm.placeholderTexts" rows="4" spellcheck="false" placeholder="一行一条，例如：&#10;让我想想…&#10;稍等，正在查" @input="markOutputDirty" /></label>
              <small class="settings-meta">仅 <code>stream</code> 模式发送，后续答复编辑同一条消息。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>文案挑选</b><small>决定每轮使用哪一条文案</small></div>
              <div class="settings-control control-pair">
                <label><span>挑选方式</span><UiSelect v-model="outputForm.placeholderPick" :options="[{ value: 'random', label: '随机 · 每轮从备选中选取' }, { value: 'fixed', label: '固定 · 始终使用指定下标' }]" @change="markOutputDirty" /></label>
                <label><span>固定下标</span><UiNumber :model-value="outputForm.placeholderIndex" :min="0" :disabled="outputForm.placeholderPick !== 'fixed'" @update:model-value="changeOutputNumber('placeholderIndex', $event)" /></label>
              </div>
              <small class="settings-meta">下标从 0 起，按过滤空行后的顺序计数；越界时使用第一条。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>等待文案延迟</b><small>从开始生成起计算</small></div>
              <label class="settings-control"><span class="sr-only">等待文案延迟毫秒数</span><UiNumber :model-value="outputForm.placeholderAfterMs" :min="1" :step="500" @update:model-value="changeOutputNumber('placeholderAfterMs', $event)" /></label>
              <div :class="['settings-meta', { warn: !placeholderList.length }]"><small>{{ placeholderPreview }}</small><small>会话级 <code>perChat.&lt;contextKey&gt;.output</code> 覆盖全局值。</small></div>
            </div>
          </div>
          </div>
          <div v-show="settingsTab === 'maintenance'" data-settings-tab="maintenance">
          <div class="registry-heading">
            <div><h3>修改登录口令</h3><p class="section-note">修改后<b>立即生效，其余会话全部吊销</b>。遗忘时用 <code>pnpm webui:passwd</code> 离线生成哈希写入 <code>config.yaml</code>。</p></div>
          </div>
          <p v-if="passwordPinnedEnv" class="callout warn">
            <i class="pi pi-lock" aria-hidden="true" />
            口令由环境变量 <code>{{ passwordPinnedEnv }}</code> 固定：此处修改重启后被覆盖。永久更换需改该环境变量，清除后交回 <code>config_kv</code> 管理。
          </p>
          <div v-else class="settings-list compact" role="list" aria-label="修改登录口令列表">
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>当前口令</b><small>用于身份确认</small></div>
              <label class="settings-control"><span class="sr-only">当前口令</span><input v-model="passwordForm.current" type="password" autocomplete="current-password" placeholder="输入当前口令"></label>
              <small class="settings-meta">必须与当前登录口令一致。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>新口令</b><small>替换当前登录口令</small></div>
              <label class="settings-control"><span class="sr-only">新口令</span><input v-model="passwordForm.next" type="password" autocomplete="new-password" placeholder="至少 12 个字符"></label>
              <small class="settings-meta">至少 12 个字符。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>确认新口令</b><small>再次输入以避免误改</small></div>
              <label class="settings-control"><span class="sr-only">确认新口令</span><input v-model="passwordForm.confirm" type="password" autocomplete="new-password" placeholder="需与新口令一致"></label>
              <small class="settings-meta">必须与新口令完全一致。</small>
            </div>
            <div class="settings-item" role="listitem">
              <div class="settings-name"><b>提交修改</b><small>保存后立即生效</small></div>
              <div class="settings-control"><UiButton icon="pi pi-key" label="更新口令" :loading="passwordSaving" :disabled="Boolean(passwordProblem)" @click="savePassword" /></div>
              <small class="settings-meta">{{ passwordProblem || '其余全部登录态将被吊销。' }}</small>
            </div>
          </div>
          <div class="registry-heading"><div><h3>维护操作</h3><p class="section-note">同步执行：大库上阻塞写入，bot 侧消息将排队。</p></div></div>
          <div class="settings-list compact" role="list" aria-label="维护操作列表">
            <div v-for="item in MAINTENANCE_ACTIONS" :key="item.action" class="settings-item maintenance-item" role="listitem">
              <div class="settings-name"><b><i :class="item.icon" aria-hidden="true" /> {{ item.label }}</b><small>同步维护任务</small></div>
              <small class="settings-meta">{{ item.hint }}</small>
              <div class="settings-control settings-execute"><UiButton size="small" variant="outlined" label="执行" :loading="maintenanceBusy === item.action" :disabled="Boolean(maintenanceBusy)" @click="runMaintenance(item.action, item.label)" /></div>
            </div>
            <div class="settings-item maintenance-item danger" role="listitem">
              <div class="settings-name"><b><i class="pi pi-refresh" aria-hidden="true" /> 重启进程</b><small>优雅关闭当前进程</small></div>
              <small class="settings-meta">等同 SIGTERM。没有 systemd、Docker 等 supervisor 时，进程不会自动重启。</small>
              <div class="settings-control settings-execute"><UiButton size="small" variant="outlined" severity="danger" label="重启" :loading="restarting" :disabled="Boolean(maintenanceBusy)" @click="restartProcess" /></div>
            </div>
          </div>
          <div class="registry-heading"><div><h3>导出 / 导入配置</h3><p class="section-note">导出 <code>config_kv</code> 中的<b>覆盖层</b>。密钥类键不导出，也不导出为 <code>«redacted»</code>。导入按键覆盖，<b>不删除</b>现有覆盖行。</p></div>
            <div class="section-actions"><UiButton size="small" variant="outlined" icon="pi pi-download" label="导出" :loading="exportBusy" @click="exportConfig" /><UiButton size="small" variant="outlined" icon="pi pi-upload" label="导入" @click="importFile?.click()" /></div>
          </div>
          <input ref="importFile" type="file" accept="application/json,.json" hidden @change="importConfig">
          </div>
          <div v-show="settingsTab === 'all'" data-settings-tab="all">
          <div class="registry-heading">
            <div><h3>全部配置</h3><p class="section-note">由 <code>config/config.schema.json</code> 自动生成。热更新项保存即生效，需重启项在保存后的提示中列出。密钥字段<b>只写</b>（留空 = 不修改）；标「环境变量锁定」的键由环境变量最终决定。</p></div>
            <UiButton size="small" variant="text" icon="pi pi-history" label="变更历史" @click="openConfigRevisions" />
          </div>
          <SchemaForm v-if="configSchema" ref="schemaForm" :schema="configSchema.schema" :value="config" :hot-reloadable="configSchema.hotReloadable" :unimplemented="configSchema.unimplemented" :env-pinned="configSchema.envPinned" :enum-notes="configSchema.enumNotes" :saving="schemaSaving" @save="saveSchemaConfig" />
          <p v-else class="empty-card"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在加载配置 schema…</p>
          </div>
          <div v-if="settingsTab === 'advanced'" data-settings-tab="advanced">
          <div class="registry-heading">
            <div><h3>原始 YAML</h3><p class="section-note">直接编辑<b>覆盖层</b>（<code>config_kv</code>），语法错误会给出行号。写库<b>按叶子</b>（点分键）覆盖：段内删键即从覆盖层移除，删整个顶层段不做改动。</p></div>
            <div class="section-actions"><UiButton size="small" variant="text" :icon="yamlMode ? 'pi pi-times' : 'pi pi-code'" :label="yamlMode ? '收起' : '编辑 YAML'" @click="toggleYamlMode" /><UiButton v-if="yamlMode" size="small" icon="pi pi-save" label="保存 YAML" :loading="yamlSaving" @click="saveYaml" /></div>
          </div>
          <template v-if="yamlMode">
            <p v-if="yamlSkipped.length" class="callout warn"><i class="pi pi-key" />{{ yamlSkipped.length }} 个密钥类键未显示（不回显，也不会被本次保存清除）：<code>{{ yamlSkipped.join('、') }}</code></p>
            <p v-if="yamlError" class="callout warn"><i class="pi pi-exclamation-triangle" />{{ yamlError }}</p>
            <textarea v-model="yamlText" class="yaml-editor" rows="24" spellcheck="false" aria-label="原始 YAML 覆盖层" />
          </template>
          <div class="registry-heading">
            <div><h3>合并后的完整配置</h3><p class="section-note"><code>config.yaml</code> → DB 覆盖层 → 环境变量三层合并的结果，只读；「全部配置」表单修改的即为该 JSON 中的值。</p></div>
            <UiButton size="small" variant="text" :icon="mergedConfigOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" :label="mergedConfigOpen ? '收起' : '展开'" @click="mergedConfigOpen = !mergedConfigOpen" />
          </div>
          <pre v-if="mergedConfigOpen" class="config-preview" v-text="JSON.stringify(config, null, 2)" />
          </div>
        </section>
        <section v-else key="fallback" class="surface page-surface"><header><div><p class="eyebrow">{{ currentLabel.toUpperCase() }}</p><h2>{{ currentLabel }}</h2><p>写操作须携带 Session 与 CSRF token，并记录 webui.action 审计。</p></div></header><DataGrid :rows="logs.slice(0, 12)" :columns="COLUMNS.fallback" data-key="id" empty="暂无事件" /></section>
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
        <template v-if="catalogStatus && !catalogStatus.enabled"><i class="pi pi-info-circle" />模型元数据目录已关闭（<code>provider.catalog.enabled</code>），仅用上游 <code>/models</code> 字段。</template>
        <template v-else-if="catalogStatus?.available"><i class="pi pi-database" />models.dev 本地缓存：{{ catalogStatus.models }} 个模型 / {{ catalogStatus.providers }} 家 provider · {{ catalogAge }}<span v-if="catalogStatus.stale"> · 已过期，下次拉取时刷新</span></template>
        <template v-else><i class="pi pi-exclamation-triangle" />尚无本地元数据缓存{{ catalogStatus?.error ? `（${catalogStatus.error}）` : '' }}，窗口与价格需手填。</template>
        <UiButton variant="text" size="small" icon="pi pi-sync" label="刷新目录" :loading="catalogRefreshing" @click="refreshCatalog" />
      </div>
      <DataGrid v-model:selection="catalogSelection" :rows="catalogRows" :columns="COLUMNS.catalog" data-key="modelId" :loading="catalogLoading" :selectable="(row) => !catalogExists(row)" scroll-height="46vh" empty="暂无可导入模型">
        <template #modelId="{ data }"><code>{{ data.modelId }}</code><small v-if="data.displayName" class="catalog-sub">{{ data.displayName }}</small></template>
        <template #limits="{ data }">{{ data.contextWindow ?? catalogDefaults.contextWindow }} / {{ data.maxOutput ?? catalogDefaults.maxOutput }}<small v-if="!data.contextWindow" class="catalog-sub">无数据，用默认值</small><small v-else-if="data.limitSource === 'models.dev'" class="catalog-sub">来自 models.dev</small></template>
        <template #price="{ data }">
          <span>{{ priceText(data) }}</span>
          <small v-if="data.meta" :class="['catalog-sub', `match-${data.meta.match}`]" :title="MATCH_LABELS[data.meta.match].hint">{{ MATCH_LABELS[data.meta.match].label }}<template v-if="data.meta.catalogProviderId && data.meta.match !== 'third-party'"> · {{ data.meta.catalogProviderId }}</template></small>
          <small v-if="data.meta?.priceRange" class="catalog-sub">{{ rangeText(data.meta.priceRange) }}，需手填</small>
        </template>
        <template #capabilities="{ data }"><span v-if="capabilityTags(data.meta).length" class="cap-tags"><UiTag v-for="tag in capabilityTags(data.meta)" :key="tag" :value="tag" severity="secondary" /></span><small v-else class="catalog-sub">目录里没有这个模型</small></template>
        <template #status="{ data }"><UiTag v-if="catalogExists(data)" value="已在库" severity="secondary" /><UiTag v-else value="可导入" severity="info" /></template>
      </DataGrid>
      <p class="catalog-hint">窗口、能力与思考档位来自 models.dev。价格优先取 <b>provider 自报价</b>，其次<b>厂商官方价</b>；仅有第三方报价的留空，未补齐按 0 记账。</p>
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
        <label class="wide">看图能力<UiSelect v-model="modelForm.vision" :options="VISION_MARKS" option-label="label" option-value="value" /><small class="field-note"><b>能力块中唯一影响运行时行为的一项</b>：标成「看不了图」后，含图轮次切到 <code>vision</code> 别名。判定：三色块图问颜色，答错即不支持。取消标记后维持现值，下次<code>补齐元数据</code>按目录重填。</small></label>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="modelDialog = false" /><UiButton label="保存模型" @click="saveModel" /></template>
    </UiModal>
    <UiModal v-model:visible="aliasDialog" :title="`别名 ${aliasName || '（未命名）'}`" width="min(860px, 94vw)">
      <div class="form-grid">
        <label>别名<UiSelect v-model="aliasForm.alias" :options="[...ALIAS_GUIDE.map((entry) => entry.alias), '__custom__']" :option-label="(value) => value === '__custom__' ? '自定义…' : value" /></label>
        <label v-if="aliasForm.alias === '__custom__'">自定义别名<input v-model="aliasForm.custom" placeholder="小写字母开头，[a-z0-9_-]，≤32 字符"></label>
        <p class="wide field-note">{{ aliasNameHint }}</p>
        <p v-if="aliasForm.droppedModels" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />原链中 {{ aliasForm.droppedModels }} 个模型记录已不存在，保存后移除。</p>
        <div class="wide"><p class="field-title">Fallback 模型链</p><p class="field-note">把左侧模型加入右侧链，拖拽或上下箭头调序。靠前者优先，不可用（429/5xx 重试耗尽）时顺延，已停用的跳过。</p><ChainPicker v-model="aliasChain" :options="modelOptions" /></div>
        <p class="wide field-title">采样参数<small>留空 = 不下发该字段，使用 provider 默认值；仅在该别名被选中的步骤生效</small></p>
        <label>温度 temperature<UiNumber v-model="aliasSettings.temperature" :min="0" :max="2" :step="0.1" placeholder="0 – 2" /></label>
        <label>最大输出 maxOutputTokens<UiNumber v-model="aliasSettings.maxOutputTokens" :min="1" :step="256" placeholder="不超过模型自身上限" /></label>
        <label>推理档位 reasoning<UiSelect v-model="aliasSettings.reasoning" :options="REASONING_OPTIONS" show-clear placeholder="不下发" /></label>
        <details class="ui-fieldset wide">
          <summary><i class="pi pi-chevron-right" aria-hidden="true" />高级</summary>
          <div class="form-grid"><label>topP<UiNumber v-model="aliasSettings.topP" :min="0" :max="1" :step="0.05" placeholder="0 – 1，与温度二选一" /></label><label>topK<UiNumber v-model="aliasSettings.topK" :min="1" placeholder="≥ 1 的整数" /></label><label>存在惩罚 presencePenalty<UiNumber v-model="aliasSettings.presencePenalty" :min="-1" :max="1" :step="0.1" placeholder="-1 – 1" /></label><label>重复惩罚 frequencyPenalty<UiNumber v-model="aliasSettings.frequencyPenalty" :min="-1" :max="1" :step="0.1" placeholder="-1 – 1" /></label><label>seed<UiNumber v-model="aliasSettings.seed" :step="1" placeholder="整数，部分 provider 支持" /></label><label>停止序列 stopSequences<textarea v-model="aliasSettings.stopSequences" rows="3" placeholder="每行一条，最多 8 条" /></label></div>
        </details>
        <label class="wide">说明（仅运维可见）<input v-model="aliasForm.description"></label>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="aliasDialog = false" /><UiButton :label="aliasForm.isNew ? '创建别名' : '保存别名'" @click="saveAlias" /></template>
    </UiModal>
    <UiModal v-model:visible="principalDialog" :title="`${principalKindLabel(principalForm)} ${principalForm.displayName || principalForm.tgId}`">
      <div class="form-grid">
        <label>类型<input :value="principalKindLabel(principalForm)" disabled></label>
        <label>Telegram ID<input :value="principalForm.tgId" disabled></label>
        <label>显示名<input :value="principalForm.displayName ?? '—'" disabled></label>
        <label>用户名<input :value="principalForm.username ? `@${principalForm.username}` : '—'" disabled></label>
        <label class="wide">角色<UiSelect v-model="principalForm.role" :options="principalRoleOptions" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[principalForm.role] }}</p>
        <p v-if="principalForm.kind === 'chat'" class="wide field-note">群角色是下限：成员有效角色不低于此，最高到 trusted。</p>
        <p v-if="principalForm.role === 'owner' && principalForm.originalRole !== 'owner'" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />owner 跳过审批与沙箱（<code>sandbox.bypassRoles</code>），可以在会话里直接执行宿主命令。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="principalDialog = false" /><UiButton label="保存角色" :loading="principalSaving" :disabled="principalForm.role === principalForm.originalRole" @click="savePrincipal" /></template>
    </UiModal>
    <UiModal v-model:visible="roleDialog" title="批量修改角色">
      <div class="form-grid">
        <p class="wide field-note">对勾选的 <b>{{ principalSelection.length }}</b> 个主体统一设置角色。仅改已有主体，新增请用「批量导入」。</p>
        <label>目标角色<UiSelect v-model="roleBulkForm.role" :options="roleBulkOptions" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[roleBulkForm.role] }}</p>
        <div class="wide selection-preview">
          <span v-for="entry in principalSelection.slice(0, 24)" :key="entry.id" class="wake-chip"><UiTag :value="entry.kind === 'user' ? '人' : isPrivatePrincipal(entry) ? '私聊' : '群'" :severity="entry.kind === 'user' ? 'secondary' : isPrivatePrincipal(entry) ? 'warn' : 'info'" /><code>{{ entry.displayName || entry.username || entry.tgId }}</code><UiTag :value="entry.role" :severity="roleSeverity(entry.role)" /></span>
          <small v-if="principalSelection.length > 24" class="alias-empty">…等 {{ principalSelection.length }} 个</small>
        </div>
        <p v-if="roleBulkForm.role === 'owner'" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />owner 跳过审批与沙箱（<code>sandbox.bypassRoles</code>），可以在会话里直接执行宿主命令。</p>
        <p v-if="selectionHitsOwnerSeat && roleBulkForm.role !== 'owner'" class="wide callout error"><i class="pi pi-times-circle" aria-hidden="true" />本批包含 <code>access.bootstrapOwnerId</code> 指向的引导 owner。降级后 Telegram 侧无人可管理 bot，只能改配置并重启恢复。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="roleDialog = false" /><UiButton label="批量设置角色" icon="pi pi-user-edit" :loading="roleSaving" :disabled="!principalSelection.length" @click="saveRoleBulk" /></template>
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
        <p v-if="!detail.captureBodies" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" /><code>logs.captureBodies</code> 已关闭：span 不含请求体与响应体，仅保留用量与耗时。</p>
        <nav class="subtabs" aria-label="事件分组">
          <button v-for="[key, label] in DETAIL_GROUPS" :key="key" type="button" :class="{ active: detailGroup === key }" @click="detailGroup = key">{{ label }}<span>{{ detailCount(key) }}</span></button>
        </nav>
        <ol v-if="detailGroup === 'parts'" class="detail-events">
          <li v-for="part in detailParts" :key="part.ordinal">
            <button type="button" @click="togglePart(part.ordinal)">
              <i :class="expandedParts.has(part.ordinal) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true" />
              <span :class="['level', part.origin === 'tool_call' ? 'info' : 'debug']">{{ ORIGIN_LABELS[part.origin] ?? part.origin }}</span>
              <code>#{{ part.ordinal }}</code>
              <span class="detail-summary-text">{{ part.textPreview ?? part.id }}</span>
              <small>{{ formatBytes(part.bytes) }} · {{ part.tokens }} tok</small>
              <time>{{ new Date(part.createdAt).toLocaleTimeString() }}</time>
            </button>
            <div v-if="expandedParts.has(part.ordinal)" class="detail-payload">
              <!-- 降级过的行必须说清：库里参数还在，但模型这一轮看到的是 {elided:true}。 -->
              <p v-if="part.pruneApplied" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />本条已裁剪降级（level {{ part.pruneLevel }}）：模型看到的是占位符，下方是库中原始 parts。</p>
              <pre v-if="part.text" v-text="part.text" />
              <p v-else class="empty">无 parts</p>
            </div>
          </li>
          <li v-if="!detailParts.length" class="empty">本轮无工具调用</li>
        </ol>
        <ol v-else class="detail-events">
          <li v-for="event in detailEvents" :key="event.id" :style="{ marginLeft: `${(detailDepths.get(event.id) ?? 0) * 18}px` }">
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
                <small v-if="event.truncated" class="detail-truncated">仅渲染前 120k 字符；完整载荷 {{ formatBytes(event.bytes) }}，用上方复制或下载获取。</small>
              </div>
              <pre v-if="event.text" v-text="event.text" />
              <p v-else class="empty">无载荷</p>
            </div>
          </li>
          <li v-if="!detailEvents.length" class="empty">本组没有事件。日志按 <code>logs.retentionDays</code> 清理，旧 span 可能已删除。</li>
        </ol>
      </template>
      <template #footer><span class="catalog-count">trace <code>{{ detailTurnId }}</code></span><UiButton variant="outlined" icon="pi pi-sitemap" label="在日志页查看该 trace" @click="detailDialog = false; active = 'logs'; inspectTrace(detailTurnId)" /><UiButton variant="text" label="关闭" @click="detailDialog = false" /></template>
    </UiModal>
    <UiModal v-model:visible="logDialog" :title="logDetail ? `日志详情 ${logDetail.kind}` : '日志详情'" width="min(1120px, 96vw)">
      <p v-if="logLoading" class="empty"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 读取这条事件…</p>
      <template v-else-if="logDetail">
        <div class="detail-summary">
          <span><small>级别</small><span :class="['level', logDetail.level]">{{ logDetail.level }}</span></span>
          <span><small>时间</small><b>{{ new Date(logDetail.ts).toLocaleString() }}</b></span>
          <span><small>事件</small><code>{{ logDetail.kind }}</code></span>
          <span><small>耗时</small><b>{{ logDetail.durationMs === null ? '—' : `${logDetail.durationMs} ms` }}</b></span>
          <span><small>载荷</small><b>{{ logDetail.bytes ? formatBytes(logDetail.bytes) : '无' }}</b></span>
          <span v-if="logDetail.key"><small>会话</small><code>{{ logDetail.key }}</code></span>
          <span v-if="logDetail.chatId"><small>chat</small><code>{{ logDetail.chatId }}</code></span>
          <span v-if="logDetail.userId"><small>user</small><code>{{ logDetail.userId }}</code></span>
          <span v-if="logDetail.spanId"><small>span</small><code>{{ logDetail.spanId }}</code></span>
          <span v-if="logDetail.parentSpanId"><small>parent span</small><code>{{ logDetail.parentSpanId }}</code></span>
        </div>
        <p class="detail-summary-text">{{ logDetail.summary }}</p>
        <div class="detail-payload">
          <div class="detail-actions">
            <UiButton size="small" variant="text" icon="pi pi-copy" label="复制 JSON" :disabled="!logDetail.bytes" @click="copyLogDetail()" />
            <a v-if="logDetail.bytes" class="ui-btn text small" :href="`/api/logs/${logDetail.id}/data`" :download="`${logDetail.kind}-${logDetail.id}.json`"><i class="pi pi-download" aria-hidden="true" />下载完整 JSON</a>
            <small v-if="logDetail.truncated" class="detail-truncated">仅渲染前 120k 字符；完整载荷 {{ formatBytes(logDetail.bytes) }}，用上方复制或下载获取。</small>
          </div>
          <pre v-if="logDetail.text" v-text="logDetail.text" />
          <p v-else class="empty">无载荷</p>
        </div>
      </template>
      <template #footer>
        <span v-if="logDetail?.traceId" class="catalog-count">trace <code>{{ logDetail.traceId }}</code></span>
        <span v-else class="catalog-count">无 trace</span>
        <UiButton v-if="logDetail?.traceId" variant="outlined" icon="pi pi-sitemap" label="展开整条 trace" @click="inspectTrace(logDetail!.traceId); logDialog = false" />
        <!-- `cmd_*` / `job_*` 的 trace 不是轮次（docs/10 §1），点过去只会 404。 -->
        <UiButton v-if="logDetail?.traceId && !/^(cmd|job)_/.test(logDetail.traceId)" variant="text" icon="pi pi-comments" label="查看该轮详情" @click="logDialog = false; openDetail(logDetail!.traceId!)" />
        <UiButton variant="text" label="关闭" @click="logDialog = false" />
      </template>
    </UiModal>
    <UiModal v-model:visible="rawDialog" :title="rawDetail ? `原始载荷 · 归档 #${rawDetail.id}` : '原始载荷'" width="min(1120px, 96vw)">
      <p v-if="rawLoading" class="empty"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 读取这条消息…</p>
      <template v-else-if="rawDetail">
        <div class="detail-summary">
          <span><small>会话</small><code>{{ rawDetail.chatId }}</code></span>
          <span><small>Telegram 编号</small><code>{{ rawDetail.tgMessageId }}</code></span>
          <span><small>类型</small><code>{{ rawDetail.kind }}</code></span>
          <span><small>时间</small><b>{{ new Date(rawDetail.tgDate).toLocaleString() }}</b></span>
        </div>
        <p class="detail-summary-text">{{ rawDetail.text || `[${rawDetail.kind}]` }}</p>
        <div class="detail-payload">
          <div class="detail-actions">
            <UiButton size="small" variant="text" icon="pi pi-copy" label="复制 JSON" :disabled="!rawPretty" @click="copyRaw()" />
            <small class="detail-truncated">入库时脱敏后的副本：形似 API key / Bearer token / bot token 的字符串，以及键名含 secret、token、password 的字段，均替换为 «redacted»。</small>
          </div>
          <pre v-if="rawPretty" v-text="rawPretty" />
          <p v-else class="empty">未存储原始载荷</p>
        </div>
      </template>
      <template #footer><UiButton variant="text" label="关闭" @click="rawDialog = false" /></template>
    </UiModal>
    <UiModal v-model:visible="bulkDialog" title="批量导入主体">
      <div class="form-grid">
        <p class="wide field-note">批量登记 Telegram <b>数字 ID</b> 为主体并统一设角色，未与 bot 交互过的用户也可提前授权或封禁。已存在的主体仅改角色。</p>
        <label>类型<UiSelect v-model="bulkForm.kind" :options="[{ value: 'user', label: '用户' }, { value: 'chat', label: '会话（群 / 频道）' }]" /></label>
        <label>角色<UiSelect v-model="bulkForm.role" :options="ROLES" /></label>
        <p class="wide field-note">{{ ROLE_HINTS[bulkForm.role] }}</p>
        <label class="wide">ID 列表<textarea v-model="bulkForm.ids" rows="7" placeholder="每行一个，或以空格 / 逗号分隔：&#10;123456789&#10;-1001234567890" /></label>
        <p v-if="bulkBadIds.length" class="wide callout error"><i class="pi pi-times-circle" aria-hidden="true" />以下 ID 不合法：{{ bulkBadIds.slice(0, 5).join('、') }}{{ bulkBadIds.length > 5 ? ` 等 ${bulkBadIds.length} 个` : '' }}。群/频道 ID 以 <code>-100</code> 开头，不支持 @用户名。</p>
        <p v-else-if="bulkIds.length" class="wide field-note">已解析 {{ bulkIds.length }} 个 ID。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="bulkDialog = false" /><UiButton label="导入并设角色" icon="pi pi-upload" :loading="bulkSaving" :disabled="!bulkIds.length || bulkBadIds.length > 0" @click="saveBulk" /></template>
    </UiModal>
    <UiModal v-model:visible="toolDialog" :title="`工具 ${toolForm.name}`">
      <div class="form-grid">
        <label>来源<input :value="TOOL_SOURCE_LABEL[toolForm.source] ?? toolForm.source" disabled></label>
        <label>作用域<input :value="SCOPE_LABEL[toolForm.scope] ?? toolForm.scope" disabled></label>
        <p class="wide field-note">来源与作用域为只读标签</p>
        <label>最低角色
          <UiSelect v-model="toolForm.minRole" :options="ROLE_OPTIONS" aria-label="最低角色" />
          <small class="field-note">代码默认 <code>{{ toolForm.defaults.minRole }}</code><UiButton v-if="toolForm.minRole !== toolForm.defaults.minRole" size="small" variant="text" label="恢复默认" @click="resetToolField('minRole')" /></small>
        </label>
        <label>审批策略
          <UiSelect v-model="toolForm.approval" :options="APPROVAL_OPTIONS" aria-label="审批策略" />
          <small class="field-note">代码默认 <code>{{ toolForm.defaults.approval }}</code><UiButton v-if="toolForm.approval !== toolForm.defaults.approval" size="small" variant="text" label="恢复默认" @click="resetToolField('approval')" /></small>
        </label>
        <label>单次超时（毫秒）
          <UiNumber v-if="!toolForm.selfManagedTimeout" v-model="toolForm.timeoutMs" :min="1" :step="1000" placeholder="留空 = 使用默认值" aria-label="单次超时" />
          <input v-else value="工具自行管理" disabled>
          <small class="field-note">
            <template v-if="toolForm.selfManagedTimeout">该工具自行管理超时（<code>timeoutMs: null</code>），不可覆盖。</template>
            <template v-else>代码默认 <code>{{ toolForm.defaults.timeoutMs ?? '继承 tools.defaultTimeoutMs' }}</code><UiButton v-if="toolForm.timeoutMs !== toolForm.defaults.timeoutMs" size="small" variant="text" label="恢复默认" @click="resetToolField('timeoutMs')" /></template>
          </small>
        </label>
        <p class="wide field-note">覆盖仅作用于<b>角色判定</b>与<b>审批判定</b>这两处，<b>不绕过 <code>available()</code></b>。覆盖设定的是基准档位，<code>approvalFor</code> 的提档不受影响。</p>
        <p v-if="toolFormRelaxed.length" class="wide callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" /><b>{{ toolFormRelaxed.join(' 与 ') }}比代码默认更松。</b>保存时需二次确认，并在日志与配置变更历史各留一条记录。</p>
        <UiSwitch v-model="toolForm.enabled" class="wide" label="对所有会话启用" />
        <p class="wide field-note">停用为强制约束：该工具不进入模型的工具目录，<code>execute()</code> 二次拦截并返回 <code>tool_disabled_by_operator</code>。</p>
      </div>
      <template #footer><UiButton variant="text" label="取消" @click="toolDialog = false" /><UiButton label="保存" :severity="toolFormRelaxed.length ? 'danger' : 'primary'" :loading="toolSaving" :disabled="!toolFormDirty" @click="saveTool(false)" /></template>
    </UiModal>
    <UiModal v-model:visible="toolRelaxDialog" title="确认放宽工具权限">
      <p class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" /><b><code>{{ toolForm.name }}</code> 的下列策略比代码默认更松。</b></p>
      <ul class="relax-list"><li v-for="item in toolRelaxDetails" :key="item.path"><code>{{ item.path }}</code>：<b>{{ item.from }}</b> → <b>{{ item.to }}</b></li></ul>
      <p class="field-note">放宽后该工具对更低角色可见 / 更少触发人工审批，仍需通过 <code>available()</code> 判定。</p>
      <template #footer><UiButton variant="text" label="取消" @click="toolRelaxDialog = false" /><UiButton label="确认放宽" severity="danger" :loading="toolSaving" @click="saveTool(true)" /></template>
    </UiModal>
    <UiModal v-model:visible="promptPreviewDialog" title="预览提示词组装" width="min(1080px, 96vw)">
      <div class="form-grid">
        <label class="wide">会话<UiSelect v-model="promptPreviewForm.key" :options="promptPreviewChats" placeholder="选择会话" /></label>
        <label>有效角色<UiSelect v-model="promptPreviewForm.role" :options="ROLES" /></label>
        <p class="field-note">工具、Skill 与私有记忆按该角色与会话实时筛选。</p>
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
      <p v-else class="empty">选择会话与角色后运行组装。预览与真实轮次共用 <code>assembleMainPrompt()</code>。</p>
      <template #footer><UiButton variant="text" label="关闭" @click="promptPreviewDialog = false" /><UiButton label="运行组装" icon="pi pi-play" :loading="promptPreviewLoading" @click="runPromptPreview" /></template>
    </UiModal>
    <UiModal v-model:visible="revisionsDialog" title="配置变更历史" width="min(960px, 96vw)">
      <p class="callout"><i class="pi pi-info-circle" />经 WebUI 写入的配置覆盖记入 <code>config_revisions</code>，保留最近 500 条。密钥类字段存为 <code>«redacted»</code>。</p>
      <ol class="revision-list wide-list">
        <li v-for="row in configRevisions" :key="row.id">
          <div><code>{{ row.key }}</code><small>{{ row.actor }} · {{ new Date(row.ts).toLocaleString() }}</small>
            <small class="revision-diff"><b>旧</b> {{ revisionValue(row.old_json, 'old') }}</small>
            <small class="revision-diff"><b>新</b> {{ revisionValue(row.new_json, 'new') }}</small>
          </div>
        </li>
        <li v-if="!configRevisions.length && !revisionsLoading" class="empty">暂无变更记录</li>
      </ol>
    </UiModal>
    <UiDrawer v-model:visible="mobileMenu" :title="botName">
      <nav class="mobile-nav" aria-label="移动端主导航">
        <div v-for="section in navigationSections" :key="section.label" class="nav-section">
          <p class="nav-label">{{ section.label }}</p>
          <button v-for="item in section.items" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]; mobileMenu = false">
            <i :class="item[1]" aria-hidden="true" /><span>{{ item[2] }}</span>
            <span v-if="item[0] === 'tasks' && pendingApprovals" class="nav-badge">{{ pendingApprovals }}</span>
          </button>
        </div>
      </nav>
    </UiDrawer>
  </main>
</template>
