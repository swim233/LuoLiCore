<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import InputText from 'primevue/inputtext';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Drawer from 'primevue/drawer';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api, hydrateSession } from '../api/client';

interface Dashboard { turns: { total: number; running: number; failed: number; cost: number }; messages: { total: number }; providers: { total: number; enabled: number } }
interface Principal { id: string; kind: string; tgId: string; role: string; displayName: string | null; username: string | null }
interface Provider { id: string; name: string; kind: string; baseUrl?: string | null; apiKeyHint: string | null; enabled: number; healthState: string | null; healthError?: string | null }
interface ProviderTest { reachable: boolean; code: string; message: string; status: number | null; latencyMs: number; models: number }
interface CatalogModel { modelId: string; displayName: string | null; contextWindow: number | null; maxOutput: number | null }
interface LogRow { id: number; ts: number; level: string; kind: string; summary: string; trace_id: string | null }

interface Chat { key: string; chatId: string; scope: string; tokens: number | null; messages: number | null }
interface Usage { id: number; ts: number; model_alias: string; input_tokens: number; output_tokens: number; cost_usd: number; ok: number }
interface Extension { name: string; description?: string; min_role?: string; enabled?: number; load_error?: string | null }
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
const agents = ref<Extension[]>([]);
const approvals = ref<Array<Record<string, unknown>>>([]);
const tasks = ref<Array<Record<string, unknown>>>([]);
const prompts = ref<Array<Record<string, unknown>>>([]);
const config = ref<Record<string, unknown>>({});
const tools = ref<Record<string, { minRole: string; approval: string; scope: string }>>({});
const selectedChat = ref<Chat | null>(null);
const contextDetail = ref<Record<string, unknown> | null>(null);
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
const aliasForm = ref({ alias: 'main', modelIdsText: '', settingsText: '{}', description: '' });
const modelMissingMain = computed(() => !aliases.value.some((entry) => entry.alias === 'main'));
const toast = useToast();
const testingProvider = ref('');
const catalogDialog = ref(false);
const catalogProviderId = ref('');
const catalogLoading = ref(false);
const catalogModels = ref<CatalogModel[]>([]);
const catalogSelection = ref<CatalogModel[]>([]);
const catalogQuery = ref('');
const catalogError = ref('');
const catalogDefaults = ref({ contextWindow: 128000, maxOutput: 8192 });
const importedModelKeys = computed(() => new Set(models.value.map((model) => `${String(model.provider_id)}::${String(model.model_id)}`)));
const catalogExists = (entry: CatalogModel): boolean => importedModelKeys.value.has(`${catalogProviderId.value}::${entry.modelId}`);
const catalogRows = computed(() => { const needle = catalogQuery.value.trim().toLowerCase(); return needle ? catalogModels.value.filter((entry) => entry.modelId.toLowerCase().includes(needle) || (entry.displayName ?? '').toLowerCase().includes(needle)) : catalogModels.value; });
const notice = ref('');
const mobileMenu = ref(false);
const connected = ref(false);
const navigation = [
  ['dashboard', 'pi pi-chart-bar', '总览'], ['chats', 'pi pi-comments', '会话'], ['messages', 'pi pi-search', '消息'],
  ['prompts', 'pi pi-align-left', '提示词'], ['providers', 'pi pi-sparkles', '模型'], ['principals', 'pi pi-users', '主体'],
  ['tools', 'pi pi-wrench', '工具'], ['extensions', 'pi pi-box', '扩展'], ['agents', 'pi pi-sitemap', 'Agent'],
  ['logs', 'pi pi-list', '日志'], ['usage', 'pi pi-wallet', '用量'], ['tasks', 'pi pi-check-square', '任务与审批'], ['settings', 'pi pi-cog', '设置'],
] as const;
const currentLabel = computed(() => navigation.find(([key]) => key === active.value)?.[2] ?? '总览');

async function load(): Promise<void> {
  [dashboard.value, principals.value, providers.value, logs.value, chats.value, usage.value, skills.value, plugins.value, mcp.value, agents.value, tools.value, approvals.value, tasks.value, prompts.value, config.value, models.value, aliases.value] = await Promise.all([
    api<Dashboard>('/api/dashboard'), api<Principal[]>('/api/principals'), api<Provider[]>('/api/providers'), api<LogRow[]>('/api/logs'),
    api<Chat[]>('/api/chats'), api<Usage[]>('/api/usage'), api<Extension[]>('/api/skills'), api<Extension[]>('/api/plugins'), api<Extension[]>('/api/mcp'), api<Extension[]>('/api/agents'), api<Record<string, { minRole: string; approval: string; scope: string }>>('/api/tools'),
    api<Array<Record<string, unknown>>>('/api/approvals'), api<Array<Record<string, unknown>>>('/api/tasks'), api<Array<Record<string, unknown>>>('/api/prompts'), api<Record<string, unknown>>('/api/config'), api<Array<Record<string, unknown>>>('/api/models'), api<Array<Record<string, unknown>>>('/api/aliases'),
  ]);
}
async function inspectChat(chat: Chat): Promise<void> { selectedChat.value = chat; const detail = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chat.key)}`); contextDetail.value = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chat.key)}/context`); commits.value = (detail.commits as Array<Record<string, unknown>> | undefined) ?? []; contextMessages.value = (detail.messages as Array<Record<string, unknown>> | undefined) ?? []; inspectedSnapshot.value = null; }
async function inspectTrace(traceId: string | null): Promise<void> { if (!traceId) return; traceDetail.value = await api<LogRow[]>(`/api/logs/trace/${encodeURIComponent(traceId)}`); }
async function inspectPrompt(row: Record<string, unknown>): Promise<void> { selectedPrompt.value = await api<Record<string, unknown>>(`/api/prompts/${encodeURIComponent(String(row.id))}`); promptContent.value = String(selectedPrompt.value.content ?? ''); promptRevisions.value = await api<Array<Record<string, unknown>>>(`/api/prompts/${encodeURIComponent(String(row.id))}/revisions`); }
async function savePrompt(): Promise<void> { if (!selectedPrompt.value) return; await api(`/api/prompts/${encodeURIComponent(String(selectedPrompt.value.id))}`, { method: 'PUT', body: JSON.stringify({ content: promptContent.value }) }); notice.value = '提示词已保存并生成版本'; await load(); await inspectPrompt(selectedPrompt.value); }
async function rollbackPrompt(revisionId: unknown): Promise<void> { if (!selectedPrompt.value) return; await api(`/api/prompts/${encodeURIComponent(String(selectedPrompt.value.id))}/rollback`, { method: 'POST', body: JSON.stringify({ revisionId }) }); notice.value = '提示词已回滚'; await inspectPrompt(selectedPrompt.value); }
async function checkoutCommit(id: unknown): Promise<void> { if (!selectedChat.value) return; await api(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/commits/${encodeURIComponent(String(id))}/checkout`, { method: 'POST' }); notice.value = '上下文已切换到所选 commit'; await inspectChat(selectedChat.value); }
async function inspectCommit(id: unknown): Promise<void> { if (!selectedChat.value) return; inspectedSnapshot.value = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/context?commit=${encodeURIComponent(String(id))}`); }
async function resetContext(): Promise<void> { if (!selectedChat.value) return; await api(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/reset`, { method: 'POST' }); notice.value = '上下文已重置'; await inspectChat(selectedChat.value); }
async function undoContext(): Promise<void> { if (!selectedChat.value) return; await api(`/api/chats/${encodeURIComponent(selectedChat.value.key)}/undo`, { method: 'POST' }); notice.value = '已撤销最近 commit'; await inspectChat(selectedChat.value); }
function toggleMessage(id: unknown): void { const next = new Set(expandedMessages.value); const key = String(id); if (next.has(key)) next.delete(key); else next.add(key); expandedMessages.value = next; }
function editProvider(provider?: Provider): void { providerForm.value = provider ? { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: String((provider as Provider & { baseUrl?: string }).baseUrl ?? ''), apiKey: '', enabled: Boolean(provider.enabled) } : { id: '', name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true }; providerDialog.value = true; }
async function saveProvider(): Promise<void> { const form = providerForm.value; const body = { name: form.name, kind: form.kind, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey || undefined, enabled: form.enabled }; await api(form.id ? `/api/providers/${encodeURIComponent(form.id)}` : '/api/providers', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); providerDialog.value = false; toast.add({ severity: 'success', summary: 'Provider 已保存', detail: form.name, life: 3000 }); await load(); }
function toastError(summary: string, error: unknown): void { toast.add({ severity: 'error', summary, detail: error instanceof Error ? error.message : String(error), life: 9000 }); }
function toastProbe(name: string, result: ProviderTest): void {
  if (result.reachable) toast.add({ severity: 'success', summary: `${name} 连接正常`, detail: `${result.latencyMs} ms · 上游返回 ${result.models} 个模型`, life: 4000 });
  else toast.add({ severity: 'error', summary: `${name} 连接失败（${result.code}）`, detail: result.message, life: 9000 });
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
  if (!form.id) { toast.add({ severity: 'warn', summary: '请先保存 Provider', detail: '新建的 Provider 还没有 id，保存后即可用当前 key 测试', life: 6000 }); return; }
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
    catalogModels.value = (await api<{ models: CatalogModel[] }>(`/api/providers/${encodeURIComponent(catalogProviderId.value)}/models`)).models;
    if (!catalogModels.value.length) catalogError.value = '上游返回了空的模型列表';
  } catch (error) { catalogModels.value = []; catalogError.value = error instanceof Error ? error.message : '拉取失败'; toastError('拉取模型列表失败', error); }
  finally { catalogLoading.value = false; }
}
async function importCatalog(): Promise<void> {
  const chosen = catalogSelection.value.filter((entry) => !catalogExists(entry));
  if (!chosen.length) return;
  try {
    const result = await api<{ inserted: number; skipped: number }>('/api/models/import', { method: 'POST', body: JSON.stringify({ providerId: catalogProviderId.value, models: chosen, contextWindow: catalogDefaults.value.contextWindow, maxOutput: catalogDefaults.value.maxOutput }) });
    toast.add({ severity: result.inserted ? 'success' : 'warn', summary: `已导入 ${result.inserted} 个模型`,
      detail: `${result.skipped ? `${result.skipped} 个已存在，已跳过。` : ''}价格字段留空，需要在模型表里手工补齐，否则配额按 0 计。`, life: 7000 });
    catalogSelection.value = [];
    await load();
  } catch (error) { toastError('导入模型失败', error); }
}
async function removeProvider(id: string): Promise<void> { try { await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast.add({ severity: 'success', summary: 'Provider 已删除', life: 3000 }); } catch (error) { toastError('删除失败', error); } await load(); }
function editModel(model?: Record<string, unknown>): void { modelForm.value = model ? { id: String(model.id), providerId: String(model.provider_id), modelId: String(model.model_id), displayName: String(model.display_name ?? ''), contextWindow: Number(model.context_window), maxOutput: Number(model.max_output), priceIn: Number(model.price_in ?? 0), priceOut: Number(model.price_out ?? 0), priceCacheRead: Number(model.price_cache_read ?? 0), priceCacheWrite: Number(model.price_cache_write ?? 0), enabled: Boolean(model.enabled), sort: Number(model.sort ?? 0) } : { id: '', providerId: providers.value[0]?.id ?? '', modelId: '', displayName: '', contextWindow: 128000, maxOutput: 8192, priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0, enabled: true, sort: 0 }; modelDialog.value = true; }
async function saveModel(): Promise<void> { const form = modelForm.value; try { await api(form.id ? `/api/models/${encodeURIComponent(form.id)}` : '/api/models', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }); modelDialog.value = false; toast.add({ severity: 'success', summary: '模型配置已保存', detail: form.modelId, life: 3000 }); await load(); } catch (error) { toastError('保存模型失败', error); } }
function editAlias(alias?: Record<string, unknown>): void { aliasForm.value = alias ? { alias: String(alias.alias), modelIdsText: (JSON.parse(String(alias.model_ids_json)) as string[]).join('\n'), settingsText: String(alias.settings_json ?? '{}'), description: String(alias.description ?? '') } : { alias: 'main', modelIdsText: '', settingsText: '{}', description: '' }; aliasDialog.value = true; }
async function saveAlias(): Promise<void> { const form = aliasForm.value; try { await api(`/api/aliases/${encodeURIComponent(form.alias)}`, { method: 'PUT', body: JSON.stringify({ modelIds: form.modelIdsText.split(/\s+/).filter(Boolean), settings: JSON.parse(form.settingsText || '{}'), description: form.description }) }); aliasDialog.value = false; toast.add({ severity: 'success', summary: '模型别名已保存', detail: form.alias, life: 3000 }); await load(); } catch (error) { toastError('保存别名失败', error); } }
function messageMeta(message: Record<string, unknown>): Record<string, unknown> { return message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : {}; }
onMounted(async () => {
  await hydrateSession();
  await load();
  const events = new EventSource('/api/events');
  events.onopen = () => { connected.value = true; };
  events.onerror = () => { connected.value = false; };
  events.addEventListener('log', () => void load());
});

const roleSeverity = (role: string): 'success' | 'info' | 'warn' | 'danger' => ({ owner: 'success', trusted: 'info', limited: 'warn', blocked: 'danger' }[role] as 'success' | 'info' | 'warn' | 'danger');
</script>

<template>
  <main class="console-shell">
    <Toast position="top-right" />
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">L</div><div><b>LuoLiCore</b><span>CONTROL PLANE</span></div></div>
      <nav aria-label="主导航">
        <button v-for="item in navigation" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]">
          <i :class="item[1]" aria-hidden="true" /><span>{{ item[2] }}</span>
        </button>
      </nav>
      <div class="system-pill"><span :class="['status-dot', { live: connected }]" /><div><b>{{ connected ? '系统在线' : '正在连接' }}</b><small>127.0.0.1:8787</small></div></div>
    </aside>

    <section class="main-panel">
      <header class="topbar">
        <Button class="mobile-only" text icon="pi pi-bars" aria-label="打开导航" @click="mobileMenu = true" />
        <div v-if="notice" class="notice" role="status">{{ notice }}</div>
        <div><p class="eyebrow">OPERATIONS</p><h1>{{ currentLabel }}</h1></div>
        <div class="top-actions"><label class="search"><i class="pi pi-search" /><InputText v-model="query" placeholder="搜索 trace、会话或主体" /></label><Button outlined icon="pi pi-bell" aria-label="通知" /><div class="avatar">OW</div></div>
      </header>

      <div class="content">
        <template v-if="active === 'dashboard'">
          <section class="hero-row">
            <div><p class="eyebrow">LIVE OVERVIEW</p><h2>早上好，系统状态<span>稳定。</span></h2><p>所有关键路径集中在一个 trace 中。异常先看证据，再处理。</p></div>
            <Button label="打开实时日志" icon="pi pi-wave-pulse" @click="active = 'logs'" />
          </section>
          <section class="metric-grid">
            <article><div class="metric-icon violet"><i class="pi pi-bolt" /></div><span>在途 turn</span><b>{{ dashboard.turns.running }}</b><small>总计 {{ dashboard.turns.total }} 次</small></article>
            <article><div class="metric-icon cyan"><i class="pi pi-comments" /></div><span>归档消息</span><b>{{ dashboard.messages.total }}</b><small>FTS 索引已启用</small></article>
            <article><div class="metric-icon rose"><i class="pi pi-wallet" /></div><span>累计花费</span><b>${{ Number(dashboard.turns.cost || 0).toFixed(4) }}</b><small>失败 {{ dashboard.turns.failed }} 次</small></article>
            <article><div class="metric-icon amber"><i class="pi pi-sparkles" /></div><span>可用 Provider</span><b>{{ dashboard.providers.enabled }}</b><small>共配置 {{ dashboard.providers.total }} 个</small></article>
          </section>
          <section class="dashboard-grid">
            <article class="surface span-2"><header><div><p class="eyebrow">TRACE ACTIVITY</p><h3>最近运行事件</h3></div><Button text label="查看全部" icon="pi pi-arrow-right" icon-pos="right" @click="active = 'logs'" /></header>
              <div class="log-list"><div v-for="row in logs.slice(0, 6)" :key="row.id"><span :class="['level', row.level]">{{ row.level }}</span><code>{{ row.kind }}</code><p>{{ row.summary }}</p><time>{{ new Date(row.ts).toLocaleTimeString() }}</time></div><div v-if="!logs.length" class="empty">暂无事件。完成首次启动后会在此显示 trace。</div></div>
            </article>
            <article class="surface health"><header><div><p class="eyebrow">HEALTH</p><h3>依赖健康</h3></div></header><div class="health-row"><span>SQLite / WAL</span><Tag value="在线" severity="success" /></div><div class="health-row"><span>Telegram</span><Tag :value="connected ? '在线' : '等待'" :severity="connected ? 'success' : 'warn'" /></div><div class="health-row"><span>模型注册表</span><Tag :value="`${dashboard.providers.enabled} 可用`" :severity="dashboard.providers.enabled ? 'success' : 'warn'" /></div><div class="health-row"><span>沙箱</span><Tag value="Docker" severity="info" /></div></article>
          </section>
        </template>

        <section v-else-if="active === 'chats'" class="surface page-surface"><header><div><p class="eyebrow">CONTEXTS</p><h2>会话上下文</h2><p>不可变 commit、窗口 token、rebase 标记与消息水位。</p></div><div class="section-actions"><Button :disabled="!selectedChat" outlined label="撤销" icon="pi pi-undo" @click="undoContext" /><Button :disabled="!selectedChat" severity="danger" outlined label="重置" icon="pi pi-refresh" @click="resetContext" /></div></header><DataTable :value="chats" paginator :rows="20" striped-rows selection-mode="single" @row-click="inspectChat($event.data)"><Column field="key" header="Context Key" /><Column field="scope" header="范围" /><Column field="messages" header="消息" /><Column field="tokens" header="Token" /></DataTable><div v-if="selectedChat" class="context-workbench"><article class="context-viewer"><header><div><p class="eyebrow">MESSAGE WINDOW</p><h3>{{ selectedChat.key }}</h3></div><Tag :value="`${contextMessages.filter((entry) => entry.inWindow).length} in window`" severity="info" /></header><ol><li v-for="message in contextMessages" :key="String(message.id)" :class="['context-message', { outside: !message.inWindow, degraded: Number(message.pruneApplied) > 0, rebased: messageMeta(message).rebased === true }]"><button type="button" @click="toggleMessage(message.id)"><span class="ordinal">#{{ message.ordinal }}</span><Tag :value="String(message.role)" /><Tag :value="String(message.origin)" severity="secondary" /><Tag v-if="messageMeta(message).rebased === true" value="REBASED" severity="danger" /><Tag v-if="!message.inWindow" value="PRUNED FROM WINDOW" severity="warn" /><span>{{ message.textPreview || '[structured content]' }}</span><small>{{ message.tokens }} tok · L{{ message.pruneLevel }}</small></button><pre v-if="expandedMessages.has(String(message.id))" v-text="JSON.stringify(message, null, 2)" /><small v-if="messageMeta(message).unseenOrdinals">未见 ordinal {{ messageMeta(message).unseenOrdinals }}</small></li></ol></article><article class="commit-timeline"><header><div><p class="eyebrow">COMMIT GRAPH</p><h3>Prune / Rebase 时间线</h3></div></header><ol><li v-for="commit in commits" :key="String(commit.id)" :class="['commit-node', String(commit.kind)]"><span class="commit-rail" /><div><b>{{ commit.kind }}</b><code>{{ String(commit.id).slice(0, 12) }}</code><small>窗口 {{ commit.windowStart }} → {{ commit.headOrdinal }} · {{ commit.tokensTotal }} tokens</small><small v-if="commit.rebased">Rebased over {{ commit.rebaseOver }}</small><small v-if="commit.meta">{{ commit.meta }}</small></div><div class="commit-actions"><Button size="small" text label="快照" @click="inspectCommit(commit.id)" /><Button size="small" outlined label="回滚到此" @click="checkoutCommit(commit.id)" /></div></li></ol><pre v-if="inspectedSnapshot" class="snapshot-preview" v-text="JSON.stringify(inspectedSnapshot, null, 2)" /></article></div></section>
        <section v-else-if="active === 'messages'" class="surface page-surface"><header><div><p class="eyebrow">ARCHIVE</p><h2>消息检索</h2><p>中文三字以上走 FTS5 trigram，短词回退 LIKE。</p></div></header><div class="search-results"><InputText v-model="query" fluid placeholder="输入关键词搜索中文或英文消息" /><Button label="搜索归档" icon="pi pi-search" /><p class="empty">结果经 owner 跨会话检索 API 返回；消息正文始终以纯文本渲染。</p></div></section>
        <section v-else-if="active === 'tools'" class="surface page-surface"><header><div><p class="eyebrow">TOOL POLICY</p><h2>工具与权限</h2><p>单一策略源决定角色、审批和作用域。</p></div></header><DataTable :value="Object.entries(tools).map(([name, policy]) => ({ name, ...policy }))" paginator :rows="20" striped-rows><Column field="name" header="工具" /><Column field="minRole" header="最低角色" /><Column field="approval" header="审批" /><Column field="scope" header="作用域" /></DataTable></section>
        <section v-else-if="active === 'extensions'" class="surface page-surface"><header><div><p class="eyebrow">EXTENSIONS</p><h2>Skills / Plugins / MCP</h2><p>Skill 渐进式披露；Plugin 全信任运行；MCP 工具动态发现。</p></div></header><div class="provider-grid"><article v-for="item in [...skills, ...plugins, ...mcp]" :key="item.name"><Tag :value="item.load_error ? '错误' : item.enabled === 0 ? '停用' : '可用'" :severity="item.load_error ? 'danger' : item.enabled === 0 ? 'secondary' : 'success'" /><h3>{{ item.name }}</h3><p>{{ item.description ?? item.min_role ?? 'extension' }}</p><code v-if="item.load_error">{{ item.load_error }}</code></article><article v-if="!skills.length && !plugins.length && !mcp.length" class="empty-card"><i class="pi pi-box" /><h3>暂无扩展</h3><p>把 Skill、Plugin 或 MCP server 加入配置后重载。</p></article></div></section>
        <section v-else-if="active === 'agents'" class="surface page-surface"><header><div><p class="eyebrow">AGENT TOPOLOGY</p><h2>子 Agent</h2><p>独立上下文、权限不高于父 Agent，结果全文独立落盘。</p></div></header><DataTable :value="agents" striped-rows><Column field="name" header="名称" /><Column field="description" header="职责" /><Column field="minRole" header="最低角色" /><Column field="modelAlias" header="模型别名" /></DataTable></section>
        <section v-else-if="active === 'usage'" class="surface page-surface"><header><div><p class="eyebrow">USAGE LEDGER</p><h2>用量与成本</h2><p>输入、输出、缓存读写分别计价。</p></div></header><DataTable :value="usage" paginator :rows="20" striped-rows><Column field="ts" header="时间"><template #body="{ data }">{{ new Date(data.ts).toLocaleString() }}</template></Column><Column field="model_alias" header="别名" /><Column field="input_tokens" header="输入" /><Column field="output_tokens" header="输出" /><Column field="cost_usd" header="成本"><template #body="{ data }">${{ Number(data.cost_usd).toFixed(4) }}</template></Column></DataTable></section>

        <section v-else-if="active === 'principals'" class="surface page-surface"><header><div><p class="eyebrow">ACCESS CONTROL</p><h2>主体与权限</h2><p>effectiveRole 始终取用户与会话角色的较低者。</p></div><Button label="批量导入" icon="pi pi-upload" /></header><DataTable :value="principals" paginator :rows="12" striped-rows><Column field="kind" header="类型" /><Column field="displayName" header="显示名" /><Column field="tgId" header="Telegram ID" /><Column header="角色"><template #body="{ data }"><Tag :value="data.role" :severity="roleSeverity(data.role)" /></template></Column><Column field="username" header="用户名" /></DataTable></section>
        <section v-else-if="active === 'providers'" class="surface page-surface"><header><div><p class="eyebrow">MODEL REGISTRY</p><h2>Provider、模型与别名</h2><p>写入后服务端重建运行时 registry；API Key 只显示 hint。</p></div><Button label="添加 Provider" icon="pi pi-plus" @click="editProvider()" /></header><div v-if="modelMissingMain" class="danger-banner"><i class="pi pi-exclamation-triangle" />缺少必需的 <code>main</code> 别名，Agent 无法启动模型调用。</div><div class="provider-grid"><article v-for="provider in providers" :key="provider.id"><div class="provider-head"><div class="provider-tags"><Tag :value="provider.enabled ? '启用' : '停用'" :severity="provider.enabled ? 'success' : 'secondary'" /><Tag v-if="provider.healthState" :value="provider.healthState === 'up' ? '连通' : '不可用'" :severity="provider.healthState === 'up' ? 'success' : 'danger'" /></div><div class="card-actions"><Button text size="small" icon="pi pi-bolt" aria-label="测试连接" :loading="testingProvider === provider.id" @click="testProvider(provider)" /><Button text size="small" icon="pi pi-cloud-download" aria-label="从该 Provider 拉取模型" @click="openCatalog(provider.id)" /><Button text size="small" icon="pi pi-pencil" aria-label="编辑 Provider" @click="editProvider(provider)" /><Button text size="small" severity="danger" icon="pi pi-trash" aria-label="删除 Provider" @click="removeProvider(provider.id)" /></div></div><h3>{{ provider.name }}</h3><p>{{ provider.kind }}</p><code>{{ provider.apiKeyHint ?? '未设置密钥' }}</code><small v-if="provider.healthError" class="provider-error">{{ provider.healthError }}</small></article></div><div class="registry-heading"><h3>模型</h3><div class="section-actions"><Button size="small" outlined icon="pi pi-cloud-download" label="从 Provider 拉取" :disabled="!providers.length" @click="openCatalog()" /><Button size="small" outlined label="添加模型" @click="editModel()" /></div></div><DataTable :value="models" striped-rows @row-click="editModel($event.data)"><Column field="model_id" header="模型 ID" /><Column field="provider_id" header="Provider" /><Column field="context_window" header="窗口" /><Column field="price_in" header="输入价格" /><Column field="price_out" header="输出价格" /><Column field="enabled" header="启用" /></DataTable><div class="registry-heading"><h3>别名路由</h3><Button size="small" outlined label="添加别名" @click="editAlias()" /></div><DataTable :value="aliases" striped-rows @row-click="editAlias($event.data)"><Column field="alias" header="别名" /><Column field="model_ids_json" header="模型链" /><Column field="description" header="说明" /></DataTable></section>
        <section v-else-if="active === 'logs'" class="surface page-surface"><header><div><p class="eyebrow">OBSERVABILITY</p><h2>日志与 Trace</h2><p>点击任一 trace 节点，重建完整调用树并查看 payload。</p></div><Tag :value="connected ? '实时' : '重连中'" :severity="connected ? 'success' : 'warn'" /></header><DataTable :value="logs" paginator :rows="20" striped-rows @row-click="inspectTrace($event.data.trace_id)"><Column field="ts" header="时间"><template #body="{ data }">{{ new Date(data.ts).toLocaleString() }}</template></Column><Column field="level" header="级别"><template #body="{ data }"><span :class="['level', data.level]">{{ data.level }}</span></template></Column><Column field="kind" header="事件" /><Column field="summary" header="摘要" /><Column field="trace_id" header="Trace" /></DataTable><article v-if="traceDetail.length" class="inspector"><header><b>Trace {{ traceDetail[0]?.trace_id }}</b><Tag :value="`${traceDetail.length} spans`" /></header><ol><li v-for="node in traceDetail" :key="node.id" :style="{ marginLeft: node.parentSpanId ? '24px' : '0' }"><code>{{ node.kind }}</code><span>{{ node.summary }}</span><small>{{ node.durationMs ?? 0 }} ms</small></li></ol></article></section>
        <section v-else-if="active === 'prompts'" class="surface page-surface"><header><div><p class="eyebrow">PROMPT WORKSPACE</p><h2>提示词编辑与版本</h2><p>每次保存落盘 unified diff；可回滚任意当前可应用的 revision。</p></div></header><div class="prompt-workbench"><DataTable :value="prompts" striped-rows selection-mode="single" @row-click="inspectPrompt($event.data)"><Column field="id" header="文档" /><Column field="scope" header="范围" /><Column field="bytes" header="字节" /><Column field="updated_at" header="更新时间" /></DataTable><article v-if="selectedPrompt" class="editor-panel"><header><b>{{ selectedPrompt.id }}</b><Button label="保存版本" icon="pi pi-save" @click="savePrompt" /></header><textarea v-model="promptContent" spellcheck="false" aria-label="提示词内容" /><h3>版本记录</h3><ol class="revision-list"><li v-for="revision in promptRevisions" :key="String(revision.id)"><div><code>{{ String(revision.id).slice(0, 12) }}</code><small>{{ revision.actor }} · {{ new Date(Number(revision.ts)).toLocaleString() }}</small></div><Button size="small" text label="回滚" @click="rollbackPrompt(revision.id)" /></li></ol></article></div></section>
        <section v-else-if="active === 'tasks'" class="surface page-surface"><header><div><p class="eyebrow">WORK QUEUE</p><h2>任务与审批</h2><p>在途任务、历史状态与高风险工具批准队列。</p></div></header><div class="dashboard-grid"><article class="surface"><h3>任务</h3><DataTable :value="tasks" striped-rows><Column field="title" header="标题" /><Column field="state" header="状态" /><Column field="updated_at" header="更新时间" /></DataTable></article><article class="surface"><h3>审批</h3><DataTable :value="approvals" striped-rows><Column field="tool_name" header="工具" /><Column field="risk" header="风险" /><Column field="state" header="状态" /></DataTable></article></div></section>
        <section v-else-if="active === 'settings'" class="surface page-surface"><header><div><p class="eyebrow">CONFIGURATION</p><h2>配置与维护</h2><p>完整合并配置已通过 zod 校验；密钥字段不会回显。</p></div></header><pre class="config-preview" v-text="JSON.stringify(config, null, 2)" /></section>
        <section v-else class="surface page-surface"><header><div><p class="eyebrow">{{ currentLabel.toUpperCase() }}</p><h2>{{ currentLabel }}</h2><p>该页读取统一安全 API；写操作必须携带 Session 与 CSRF token，并记录 webui.action 审计。</p></div></header><DataTable :value="logs.slice(0, 12)" striped-rows><Column field="kind" header="关联事件" /><Column field="summary" header="最近状态" /><Column field="level" header="级别" /></DataTable></section>
      </div>
    </section>

    <Dialog v-model:visible="providerDialog" modal header="Provider 配置" :style="{ width: 'min(560px, 94vw)' }"><div class="form-grid"><label>名称<InputText v-model="providerForm.name" /></label><label>类型<Select v-model="providerForm.kind" :options="['openai','anthropic','google','openai-compatible']" /></label><label class="wide">Base URL<InputText v-model="providerForm.baseUrl" placeholder="使用 provider 默认地址" /></label><label class="wide">API Key<InputText v-model="providerForm.apiKey" type="password" placeholder="保持不变" autocomplete="new-password" /></label><label class="switch-line"><input v-model="providerForm.enabled" type="checkbox" />启用</label></div><template #footer><Button text label="取消" @click="providerDialog = false" /><Button outlined icon="pi pi-bolt" label="测试连接" :loading="Boolean(providerForm.id) && testingProvider === providerForm.id" @click="testProviderDraft" /><Button label="保存 Provider" @click="saveProvider" /></template></Dialog>
    <Dialog v-model:visible="catalogDialog" modal header="从 Provider 拉取模型" :style="{ width: 'min(900px, 96vw)' }">
      <div class="catalog-toolbar">
        <label>Provider<Select v-model="catalogProviderId" :options="providers" option-label="name" option-value="id" @change="loadCatalog" /></label>
        <label>搜索<InputText v-model="catalogQuery" placeholder="按模型 ID 或显示名过滤" /></label>
        <label>默认 Context Window<InputText v-model.number="catalogDefaults.contextWindow" type="number" /></label>
        <label>默认最大输出<InputText v-model.number="catalogDefaults.maxOutput" type="number" /></label>
        <Button outlined icon="pi pi-refresh" label="重新拉取" :loading="catalogLoading" @click="loadCatalog" />
      </div>
      <div v-if="catalogError" class="danger-banner"><i class="pi pi-exclamation-triangle" />{{ catalogError }}</div>
      <DataTable v-model:selection="catalogSelection" :value="catalogRows" :loading="catalogLoading" data-key="modelId" :is-data-selectable="({ data }) => !catalogExists(data)" scrollable scroll-height="46vh" striped-rows>
        <Column selection-mode="multiple" header-style="width:3rem" />
        <Column field="modelId" header="模型 ID" />
        <Column header="显示名"><template #body="{ data }">{{ data.displayName ?? '—' }}</template></Column>
        <Column header="窗口 / 最大输出"><template #body="{ data }">{{ data.contextWindow ?? catalogDefaults.contextWindow }} / {{ data.maxOutput ?? catalogDefaults.maxOutput }}<small v-if="!data.contextWindow"> （上游未提供，用默认值）</small></template></Column>
        <Column header="状态"><template #body="{ data }"><Tag v-if="catalogExists(data)" value="已在库" severity="secondary" /><Tag v-else value="可导入" severity="info" /></template></Column>
      </DataTable>
      <p class="catalog-hint">价格不会从上游拉取（<code>docs/04 §5.5</code>：定价由 owner 维护），导入后需要在模型表里补齐，否则该模型的花费按 0 记账。</p>
      <template #footer><span class="catalog-count">已选 {{ catalogSelection.length }} · 列出 {{ catalogRows.length }} / 共 {{ catalogModels.length }}</span><Button text label="关闭" @click="catalogDialog = false" /><Button label="导入所选" icon="pi pi-download" :disabled="!catalogSelection.length" @click="importCatalog" /></template>
    </Dialog>
    <Dialog v-model:visible="modelDialog" modal header="模型配置" :style="{ width: 'min(680px, 94vw)' }"><div class="form-grid"><label>Provider<Select v-model="modelForm.providerId" :options="providers" option-label="name" option-value="id" /></label><label>模型 ID<InputText v-model="modelForm.modelId" :disabled="Boolean(modelForm.id)" /></label><label>显示名<InputText v-model="modelForm.displayName" /></label><label>Context Window<InputText v-model.number="modelForm.contextWindow" type="number" /></label><label>最大输出<InputText v-model.number="modelForm.maxOutput" type="number" /></label><label>排序<InputText v-model.number="modelForm.sort" type="number" /></label><label>输入价格 / M token<InputText v-model.number="modelForm.priceIn" type="number" /></label><label>输出价格 / M token<InputText v-model.number="modelForm.priceOut" type="number" /></label><label>缓存读取价格<InputText v-model.number="modelForm.priceCacheRead" type="number" /></label><label>缓存写入价格<InputText v-model.number="modelForm.priceCacheWrite" type="number" /></label><label class="switch-line"><input v-model="modelForm.enabled" type="checkbox" />启用</label></div><template #footer><Button text label="取消" @click="modelDialog = false" /><Button label="保存模型" @click="saveModel" /></template></Dialog>
    <Dialog v-model:visible="aliasDialog" modal header="模型别名" :style="{ width: 'min(600px, 94vw)' }"><div class="form-grid"><label>别名<InputText v-model="aliasForm.alias" /></label><label class="wide">Fallback 模型链（每行一个模型记录 ID）<textarea v-model="aliasForm.modelIdsText" rows="6" /></label><label class="wide">Settings JSON<textarea v-model="aliasForm.settingsText" rows="5" /></label><label class="wide">说明<InputText v-model="aliasForm.description" /></label></div><template #footer><Button text label="取消" @click="aliasDialog = false" /><Button label="保存别名" @click="saveAlias" /></template></Dialog>
    <Drawer v-model:visible="mobileMenu" position="left" header="LuoLiCore"><nav class="mobile-nav"><button v-for="item in navigation" :key="item[0]" type="button" @click="active = item[0]; mobileMenu = false"><i :class="item[1]" />{{ item[2] }}</button></nav></Drawer>
  </main>
</template>
