<script setup lang="ts">
import { computed, ref } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiTag from '../ui/UiTag.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiNumber from '../ui/UiNumber.vue';
import UiSwitch from '../ui/UiSwitch.vue';
import UiModal from '../ui/UiModal.vue';
import UiDrawer from '../ui/UiDrawer.vue';
import { pushToast, toastError } from '../ui/toast';
import { api } from '../api/client';
import SkillList from '../components/extensions/SkillList.vue';
import McpTable from '../components/extensions/McpTable.vue';
import PluginCards from '../components/extensions/PluginCards.vue';
import CustomToolQueue from '../components/extensions/CustomToolQueue.vue';
import { customToolPendingReview, skillPendingReview, type CustomToolRow, type McpRow, type PluginRow, type SkillRow } from '../components/extensions/types';

/**
 * 扩展页。
 *
 * 四类扩展不再共用一张卡片。`docs/09 §3.8` 原来的口径是四类扩展共用卡片网格、操作按各自真实
 * 生命周期区分，实现是一个 `extensionRows` 把四类拼成一个数组塞进 `provider-grid`，八个动作
 * 按钮靠 `v-if="item.kind === ..."` 分流。代价是每一类只能显示四类的交集：MCP 的连接状态、
 * plugin 的 `provides`、skill 的 `requires-tools`、自定义工具的 runtime/scope 全都放不下，
 * 而 API 早已在发这些字段。
 *
 * 现在四类各一套版式，视觉主轴改为来源与是否已复审（左侧脊线与 `pending-review` 的虚线边框）。
 * M12 之后这一页上有一部分内容由模型自行编写，而运维在这一页的职责正是决定模型被允许具备
 * 什么能力，并确认已经复审过。
 *
 * 所有写操作与 busy 态都在这一层。四个子组件是纯呈现的：props 进、emit 出，不调用 `api()`。
 * 上一次把控制台拆成子视图时，子 SFC 的 `setup` 返回了一个只有 `get` 陷阱的 Proxy，而 Vue 解析
 * 模板绑定走 `hasOwn(setupState, key)`，导致 14 个页面全部渲染为空白而三条健康检查仍通过
 * （docs/24 · R-UI-01）。这里一律用普通 `<script setup>`，不返回任何 Proxy，
 * 而 `tests/webui/console.render.test.ts` 对每个分段都真实渲染一次。
 */
const props = defineProps<{
  skills: SkillRow[];
  plugins: PluginRow[];
  mcp: McpRow[];
  customTools: CustomToolRow[];
  config: Record<string, unknown>;
}>();
const emit = defineEmits<{ refresh: [] }>();

/**
 * WebUI 不 import `@luoli/shared`。那个包的 `exports` 指向 `dist/index.js`，而它 import
 * `node:crypto`，vite 会将其 externalize 成调用即抛的桩，表现是这一页整片空白加一条
 * 「Module "node:crypto" has been externalized for browser compatibility」。而 vitest 把
 * `@luoli/shared` 别名到 `src/index.ts` 并运行在 node 中，因此渲染用例仍然通过。
 * `ConsoleView.vue` 自行保留一份相同的常量，原因相同。
 */
const ROLES = ['owner', 'trusted', 'limited', 'blocked'];

/** 修改这里时连同 `tests/webui/console.render.test.ts` 的 `EXTENSION_TABS` 一起改：
 *  遗漏一个分支意味着那一段从此不再被渲染验证（设置页那四个 tab 同理）。 */
const EXTENSION_TABS = [
  ['skills', 'Skill', 'pi pi-book'],
  ['mcp', 'MCP', 'pi pi-server'],
  ['plugins', 'Plugin', 'pi pi-box'],
  ['tools', '自定义工具', 'pi pi-wrench'],
] as const;
type TabKey = typeof EXTENSION_TABS[number][0];
const tab = ref<TabKey>('skills');
const busy = ref('');

const countFor = (key: TabKey): number => ({ skills: props.skills.length, mcp: props.mcp.length, plugins: props.plugins.length, tools: props.customTools.length })[key];

// ── 待处理项：这一页的收件箱 ──────────────────────────────────────────────────
const pendingSkills = computed(() => props.skills.filter(skillPendingReview));
const pendingTools = computed(() => props.customTools.filter(customToolPendingReview));
const needsLogin = computed(() => props.mcp.filter((row) => row.enabled !== 0 && row.state === 'needs_auth'));
const broken = computed(() => [
  ...props.skills.filter((row) => row.load_error).map((row) => row.name),
  ...props.plugins.filter((row) => row.load_error).map((row) => row.name),
  ...props.mcp.filter((row) => row.enabled !== 0 && row.state === 'down').map((row) => row.name),
]);
const inbox = computed(() => [
  { key: 'skills' as TabKey, count: pendingSkills.value.length, label: '个已安装的 Skill 待人工复核' },
  { key: 'tools' as TabKey, count: pendingTools.value.length, label: '段模型编写的脚本待人工复核' },
  { key: 'mcp' as TabKey, count: needsLogin.value.length, label: '台 MCP server 要登录' },
  { key: 'mcp' as TabKey, count: broken.value.length, label: '项加载或连接失败' },
].filter((entry) => entry.count > 0));

// ── 总开关。提示必须指出真正关闭的那个键。此前这条提示恒定写 tools.selfExtend.skills.enabled
//    是关的，而判据是主闸或子闸任一为假：主闸关闭时提示指向的键其实是开启的，
//    按提示排查只会发现该键处于开启状态。
const configPath = (path: string): unknown => path.split('.').reduce<unknown>(
  (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), props.config);
const skillsMasterOff = computed(() => configPath('skills.enabled') === false);
const mcpMasterOff = computed(() => configPath('mcp.enabled') === false);
const selfExtendOffKey = computed<string | null>(() => {
  if (configPath('tools.selfExtend.enabled') === false) return 'tools.selfExtend.enabled';
  const perChannel: Record<TabKey, string> = { skills: 'tools.selfExtend.skills.enabled', tools: 'tools.selfExtend.customTools.enabled',
    plugins: 'tools.selfExtend.plugins.enabled', mcp: 'tools.selfExtend.mcp.enabled' };
  return configPath(perChannel[tab.value]) === false ? perChannel[tab.value] : null;
});
const selfExtendVerb = computed(() => ({ skills: '编写 / 安装 skill', tools: '创建自定义工具', plugins: '编写 plugin', mcp: '登记 MCP server' })[tab.value]);
const authAvailable = computed(() => props.mcp.every((row) => row.credential !== undefined));

async function enableConfigKey(key: string, summary: string): Promise<void> {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ [key]: true }) });
    pushToast({ severity: 'success', summary, detail: '热更新，无需重启' });
    emit('refresh');
  } catch (error) { toastError(`打开 ${key} 失败`, error); }
}

// ── 启停：四类各有资源路径，确认语句按风险分别编写 ────────────────────────────
async function patchEnabled(kind: 'skill' | 'plugin' | 'mcp' | 'tool', name: string, next: boolean): Promise<void> {
  const resource = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcp' : kind === 'tool' ? 'custom-tools' : 'plugins';
  busy.value = `${kind}:${name}`;
  try {
    await api(`/api/${resource}/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    pushToast({ severity: 'success', summary: `${name} 已${next ? '启用' : '停用'}` });
    emit('refresh');
  } catch (error) { toastError('切换状态失败', error); }
  finally { busy.value = ''; }
}
const toggleSkill = (row: SkillRow): Promise<void> => patchEnabled('skill', row.name, row.enabled === 0);
const toggleMcp = (row: McpRow): Promise<void> => patchEnabled('mcp', row.name, row.enabled === 0);
function togglePlugin(row: PluginRow): void {
  // Plugin 以全信任方式执行任意代码，开启必须是显式确认的动作（docs/07 §3）。停用无需确认。
  if (row.enabled !== 0) { void patchEnabled('plugin', row.name, false); return; }
  askConfirm(`启用 Plugin ${row.name}？`, 'Plugin 在 bot 进程内全信任运行，无沙箱，与本项目代码同一信任级别。请先点〔看源码〕复核。',
    () => patchEnabled('plugin', row.name, true));
}
function toggleCustomTool(row: CustomToolRow): void {
  if (row.enabled !== 0) { void patchEnabled('tool', row.name, false); return; }
  askConfirm(`启用 custom_${row.name}？`, '该脚本由模型编写，启用后以调用者的角色在沙箱内执行。请先点〔读脚本〕复核。',
    () => patchEnabled('tool', row.name, true));
}

// ── Skill ────────────────────────────────────────────────────────────────────
interface SkillDetail { name: string; description: string; body: string; allowedTools?: string[]; requiresTools?: string[]; minRole: string; model?: string; enabled: boolean; files: string[] }
const skillDialog = ref(false);
const skillSaving = ref(false);
const skillForm = ref({ name: '', description: '', body: '', allowedTools: '', requiresTools: '', minRole: 'trusted', model: '', enabled: true, files: [] as string[], isNew: true, source: 'local' });
/** 随包发布的四份说明文档，服务端只放行启停（改正文与删除返回 403 `skill_reserved`）。这里同步禁用：
 *  界面提供入口而后端拒绝，比一开始就不提供更难排查。 */
const skillReserved = computed(() => skillForm.value.source === 'bundled');
function skillDefaultMinRole(): string {
  const role = configPath('skills.defaultMinRole');
  return typeof role === 'string' && (ROLES as readonly string[]).includes(role) ? role : 'trusted';
}
async function editSkill(row?: SkillRow): Promise<void> {
  if (!row) {
    skillForm.value = { name: '', description: '', body: '', allowedTools: '', requiresTools: '', minRole: skillDefaultMinRole(), model: '', enabled: true, files: [], isNew: true, source: 'local' };
    skillDialog.value = true;
    return;
  }
  try {
    const skill = await api<SkillDetail>(`/api/skills/${encodeURIComponent(row.name)}`);
    skillForm.value = { name: skill.name, description: skill.description, body: skill.body,
      allowedTools: (skill.allowedTools ?? []).join('\n'), requiresTools: (skill.requiresTools ?? []).join('\n'),
      minRole: skill.minRole, model: skill.model ?? '', enabled: skill.enabled, files: skill.files, isNew: false, source: row.source ?? 'local' };
    skillDialog.value = true;
  } catch (error) { toastError('读取 Skill 失败', error); }
}
async function saveSkill(): Promise<void> {
  const form = skillForm.value;
  const name = form.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { pushToast({ severity: 'warn', summary: 'Skill 名称无效', detail: '只能用小写字母、数字和中划线' }); return; }
  if (!form.description.trim() || !form.body.trim()) { pushToast({ severity: 'warn', summary: '描述与正文必填' }); return; }
  const lines = (text: string): string[] => text.split('\n').map((entry) => entry.trim()).filter(Boolean);
  skillSaving.value = true;
  try {
    await api(form.isNew ? '/api/skills' : `/api/skills/${encodeURIComponent(name)}`, { method: form.isNew ? 'POST' : 'PUT',
      body: JSON.stringify({ name, description: form.description, body: form.body, allowedTools: lines(form.allowedTools),
        requiresTools: lines(form.requiresTools), minRole: form.minRole, model: form.model || null, enabled: form.enabled }) });
    skillDialog.value = false;
    pushToast({ severity: 'success', summary: `Skill ${name} 已${form.isNew ? '创建' : '保存'}`, detail: 'SKILL.md 已写入并重新扫描' });
    emit('refresh');
  } catch (error) { toastError('保存 Skill 失败', error); }
  finally { skillSaving.value = false; }
}
async function removeSkill(name: string): Promise<void> {
  askConfirm(`永久删除 Skill ${name}？`, '将删除整个目录，无法从 WebUI 恢复。', async () => {
    try { await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `Skill ${name} 已永久删除` }); skillDialog.value = false; emit('refresh'); }
    catch (error) { toastError('删除 Skill 失败', error); }
  });
}

/**
 * 安装一个 skill 包（docs/07 §2.5）。走 multipart 而不是 JSON：包内含二进制，base64 进 JSON
 * 会使体积增加三分之一，而这条路径的上限本就按字节配置。
 *
 * 包根有歧义时服务端返回 `skill_ambiguous_root` 并附带候选（同一个 zip 内常有 windows 与 linux
 * 两套），这里就地询问安装哪一个再重试：只提示存在歧义等于让用户自行猜测 subdir 的取值。
 */
const skillPackageInput = ref<HTMLInputElement | null>(null);
const skillPackageBusy = ref(false);
const packagePick = ref<{ open: boolean; candidates: string[]; chosen: string; file: File | null }>({ open: false, candidates: [], chosen: '', file: null });
function pickSkillPackage(): void {
  if (skillPackageInput.value) { skillPackageInput.value.value = ''; skillPackageInput.value.click(); }
}
async function uploadSkillPackage(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await installPackage(file);
}
async function installPackage(file: File, subdir?: string): Promise<void> {
  skillPackageBusy.value = true;
  try {
    const form = new FormData();
    form.append('file', file);
    if (subdir) form.append('subdir', subdir);
    const installed = await api<{ name: string; files: string[] }>('/api/skills/package', { method: 'POST', body: form });
    packagePick.value = { open: false, candidates: [], chosen: '', file: null };
    pushToast({ severity: 'success', summary: `Skill ${installed.name} 已装入`, detail: `${installed.files.length} 个文件，已停用。点〔查看正文〕复核后启用` });
    emit('refresh');
  } catch (error) {
    const candidates = (error as { details?: { candidates?: string[] } })?.details?.candidates;
    if (candidates?.length && !subdir) packagePick.value = { open: true, candidates, chosen: candidates[0]!, file };
    else toastError('装 Skill 包失败', error);
  } finally { skillPackageBusy.value = false; }
}

// ── MCP ──────────────────────────────────────────────────────────────────────
const mcpDialog = ref(false);
const mcpSaving = ref(false);
const mcpForm = ref({ originalName: '', name: '', transport: 'stdio', command: '', args: '', env: '{}', url: '', headers: '{}',
  authMode: 'none', authScope: '', authClientId: '', minRole: 'trusted', enabled: true, toolAllow: '', toolDeny: '', timeoutMs: 30000, isNew: true });
function editMcp(row?: McpRow): void {
  mcpForm.value = row
    ? { originalName: row.name, name: row.name, transport: row.transport ?? 'stdio', command: row.command ?? '', args: (row.args ?? []).join('\n'),
      env: JSON.stringify(row.env ?? {}, null, 2), url: row.url ?? '', headers: JSON.stringify(row.headers ?? {}, null, 2),
      authMode: row.auth?.mode ?? 'none', authScope: row.auth?.scope ?? '', authClientId: '',
      minRole: row.minRole ?? row.min_role ?? 'trusted', enabled: row.enabled !== 0,
      toolAllow: (row.toolAllow ?? []).join('\n'), toolDeny: (row.toolDeny ?? []).join('\n'), timeoutMs: row.timeoutMs ?? 30000, isNew: false }
    : { originalName: '', name: '', transport: 'stdio', command: '', args: '', env: '{}', url: '', headers: '{}',
      authMode: 'none', authScope: '', authClientId: '', minRole: 'trusted', enabled: true, toolAllow: '', toolDeny: '', timeoutMs: 30000, isNew: true };
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
  const lines = (text: string): string[] => text.split('\n').map((entry) => entry.trim()).filter(Boolean);
  mcpSaving.value = true;
  try {
    const common = { name: form.name, transport: form.transport, enabled: form.enabled, minRole: form.minRole, timeoutMs: form.timeoutMs,
      toolAllow: lines(form.toolAllow), toolDeny: lines(form.toolDeny) };
    const auth = form.authMode === 'oauth'
      ? { mode: 'oauth', ...(form.authScope.trim() ? { scope: form.authScope.trim() } : {}), ...(form.authClientId.trim() ? { clientId: form.authClientId.trim() } : {}) }
      : { mode: form.authMode };
    const body = form.transport === 'stdio'
      ? { ...common, command: form.command, args: lines(form.args), env: parseStringMap(form.env, '环境变量') }
      : { ...common, url: form.url, headers: parseStringMap(form.headers, 'HTTP Headers'), auth };
    await api(form.isNew ? '/api/mcp' : `/api/mcp/${encodeURIComponent(form.originalName)}`, { method: form.isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    mcpDialog.value = false;
    pushToast(mcpMasterOff.value
      ? { severity: 'warn', summary: `MCP ${form.name} 已保存，未连接`, detail: '总开关 mcp.enabled 已关闭，可在本页顶部打开。', life: 12_000 }
      : { severity: 'success', summary: `MCP ${form.name} 已保存`, detail: '配置已热更新并重新发现工具' });
    emit('refresh');
  } catch (error) { toastError('保存 MCP 失败', error); }
  finally { mcpSaving.value = false; }
}
function removeMcp(name: string): void {
  askConfirm(`删除 MCP server ${name}？`, '连接关闭，其工具从模型目录移除，凭据一并删除。', async () => {
    try { await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `MCP ${name} 已删除` }); mcpDialog.value = false; emit('refresh'); }
    catch (error) { toastError('删除 MCP 失败', error); }
  });
}
/**
 * 重连。直接使用 `POST /api/mcp/:name/reconnect` 的返回值：此前它被整块丢弃、再重新
 * `load()` 一遍，点击后只能看到一句已重连，而这一步最需要确认的正是本次是否连接成功。
 */
async function reconnectMcp(row: McpRow): Promise<void> {
  busy.value = `mcp:${row.name}`;
  try {
    const result = await api<{ state: string | null; error: string | null }>(`/api/mcp/${encodeURIComponent(row.name)}/reconnect`, { method: 'POST', body: '{}' });
    pushToast(result.state === 'up'
      ? { severity: 'success', summary: `${row.name} 已连接` }
      : { severity: 'warn', summary: `${row.name} 仍未连接`, detail: result.error ?? `状态：${result.state ?? '未知'}`, life: 12_000 });
    emit('refresh');
  } catch (error) { toastError('重连失败', error); }
  finally { busy.value = ''; }
}

/** 工具清单抽屉。条数在表里，描述在这里。该描述由对端 server 提供，属于提示注入面之一。 */
const toolsDrawer = ref<{ open: boolean; server: string; tools: Array<{ name: string; description: string }> }>({ open: false, server: '', tools: [] });
function showTools(row: McpRow): void {
  toolsDrawer.value = { open: true, server: row.name,
    tools: (row.tools ?? []).map((entry) => ({ name: String(entry.name ?? '?'), description: typeof entry.description === 'string' ? entry.description : '' })) };
}

/** 登录。不在这里跳转：授权地址由服务端计算（只有它知道 `webui.publicUrl`），
 *  这里只负责在新标签页打开，并把该链接保留在界面上（刷新后仍可点击）。 */
async function loginMcp(row: McpRow): Promise<void> {
  busy.value = `mcp:${row.name}`;
  try {
    const started = await api<{ status: string; authorizationUrl: string | null }>(`/api/mcp/${encodeURIComponent(row.name)}/auth/start`, { method: 'POST', body: '{}' });
    if (started.status === 'AUTHORIZED') { pushToast({ severity: 'success', summary: `${row.name} 已有可用凭据` }); emit('refresh'); return; }
    if (!started.authorizationUrl) { pushToast({ severity: 'warn', summary: '未获取到授权地址', detail: '查看日志中的 mcp.auth 事件' }); return; }
    window.open(started.authorizationUrl, '_blank', 'noopener');
    pushToast({ severity: 'info', summary: `${row.name}：在新标签页完成授权`, detail: '授权后自动跳回并重连，有效期 10 分钟。', life: 15_000 });
    emit('refresh');
  } catch (error) { toastError('开始登录失败', error); }
  finally { busy.value = ''; }
}
const credentialDialog = ref<{ open: boolean; server: string; token: string; saving: boolean }>({ open: false, server: '', token: '', saving: false });
function editCredential(row: McpRow): void {
  credentialDialog.value = { open: true, server: row.name, token: '', saving: false };
}
async function saveCredential(): Promise<void> {
  const form = credentialDialog.value;
  if (!form.token.trim()) { pushToast({ severity: 'warn', summary: 'token 必填' }); return; }
  form.saving = true;
  try {
    const result = await api<{ state: string | null; error: string | null }>(`/api/mcp/${encodeURIComponent(form.server)}/auth`, { method: 'PUT', body: JSON.stringify({ token: form.token.trim() }) });
    credentialDialog.value = { open: false, server: '', token: '', saving: false };
    pushToast(result.state === 'up'
      ? { severity: 'success', summary: `${form.server} 已用新 token 连接成功` }
      : { severity: 'warn', summary: `token 已保存，未连接`, detail: result.error ?? `状态：${result.state ?? '未知'}`, life: 12_000 });
    emit('refresh');
  } catch (error) { toastError('保存 token 失败', error); }
  finally { form.saving = false; }
}
function signOutMcp(row: McpRow): void {
  askConfirm(`注销 ${row.name}？`, '凭据将被清除，该 server 回到「要登录」，需重新授权。', async () => {
    busy.value = `mcp:${row.name}`;
    try { await api(`/api/mcp/${encodeURIComponent(row.name)}/auth`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `${row.name} 已注销` }); emit('refresh'); }
    catch (error) { toastError('注销失败', error); }
    finally { busy.value = ''; }
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────
/**
 * 重载的响应包含 `hotReloadReliable` 与 `warning`：运行在 tsx（`pnpm dev`）下时热重载会静默
 * 执行旧代码，reconcile 每次都真实执行、`onLoad` 每次打印的都是第一版。此前这整块响应被丢弃、
 * 恒定提示已重载，而这个开关唯一的使用场景就是本机开发 plugin，恰好是它失效的场景。
 */
const hotReloadWarning = ref('');
async function reloadPlugin(row: PluginRow): Promise<void> {
  busy.value = `plugin:${row.name}`;
  try {
    const result = await api<{ hotReloadReliable?: boolean; warning?: string }>(`/api/plugins/${encodeURIComponent(row.name)}/reload`, { method: 'POST', body: '{}' });
    if (result.hotReloadReliable === false) {
      hotReloadWarning.value = result.warning ?? '当前运行时下 plugin 热重载不可靠：重载成功，但仍执行旧代码。';
      pushToast({ severity: 'warn', summary: `${row.name} 已重载，可能仍是旧代码`, detail: hotReloadWarning.value, life: 0 });
    } else {
      hotReloadWarning.value = '';
      pushToast({ severity: 'success', summary: `${row.name} 已重载` });
    }
    emit('refresh');
  } catch (error) { toastError('重载失败', error); }
  finally { busy.value = ''; }
}
function removePlugin(name: string): void {
  askConfirm(`删除 Plugin ${name}？`, `将移除整个 plugins/${name}/ 目录。`, async () => {
    try { await api(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `${name} 已删除` }); emit('refresh'); }
    catch (error) { toastError('删除 Plugin 失败', error); }
  });
}

// ── 复审面（plugin 源码与自定义工具正文），只读 ───────────────────────────────
const reviewDialog = ref(false);
const reviewBusy = ref(false);
const reviewTarget = ref<{ kind: 'tool' | 'plugin'; name: string; enabled: boolean; meta: string; params: string; body: string }>(
  { kind: 'tool', name: '', enabled: false, meta: '', params: '', body: '' });
function reviewCustomTool(row: CustomToolRow): void {
  let params = row.paramsJson;
  try { params = JSON.stringify(JSON.parse(row.paramsJson), null, 2); } catch { /* 库中记录不是合法 JSON 时原样显示 */ }
  reviewTarget.value = { kind: 'tool', name: row.name, enabled: row.enabled === 1, params, body: row.body,
    meta: `${row.runtime} · 最低角色 ${row.minRole} · 作用域 ${row.scope === 'chat' ? `仅会话 ${row.ownerChatId}` : '全局'} · 由 ${row.createdBy} 创建` };
  reviewDialog.value = true;
}
async function reviewPlugin(row: PluginRow): Promise<void> {
  try {
    const detail = await api<{ name: string; source: string }>(`/api/plugins/${encodeURIComponent(row.name)}/source`);
    reviewTarget.value = { kind: 'plugin', name: row.name, enabled: row.enabled !== 0, params: '', body: detail.source,
      meta: `plugin.js · 最低角色 ${row.min_role ?? '未标注'} · 启用后在 bot 进程内全信任运行` };
    reviewDialog.value = true;
  } catch (error) { toastError('读取 plugin 源码失败', error); }
}
function removeCustomTool(name: string): void {
  askConfirm(`删除 custom_${name}？`, '模型可重新创建，当前这份正文不留档。', async () => {
    try { await api(`/api/custom-tools/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `custom_${name} 已删除` }); emit('refresh'); }
    catch (error) { toastError('删除自定义工具失败', error); }
  });
}
async function approveReview(): Promise<void> {
  const target = reviewTarget.value;
  reviewBusy.value = true;
  try {
    await patchEnabled(target.kind, target.name, !target.enabled);
    reviewDialog.value = false;
  } finally { reviewBusy.value = false; }
}

// ── 页内确认框：替代这一页此前的六处 window.confirm / prompt ─────────────────
const confirmBox = ref<{ open: boolean; title: string; detail: string; run: (() => Promise<void>) | null }>({ open: false, title: '', detail: '', run: null });
function askConfirm(title: string, detail: string, run: () => Promise<void>): void {
  confirmBox.value = { open: true, title, detail, run };
}
const confirmBusy = ref(false);
async function runConfirmed(): Promise<void> {
  const action = confirmBox.value.run;
  if (!action) return;
  confirmBusy.value = true;
  try { await action(); confirmBox.value = { open: false, title: '', detail: '', run: null }; }
  finally { confirmBusy.value = false; }
}

defineExpose({ EXTENSION_TABS, tab, inbox, selfExtendOffKey });
</script>

<template>
  <section class="surface page-surface">
    <header>
      <div>
        <p class="eyebrow">EXTENSIONS</p>
        <h2>扩展与模型能力</h2>
        <p>四类扩展决定模型可用的工具。<b>Skill 与自定义工具可由模型创建</b>，逐行标注来源与复核状态。</p>
      </div>
      <div class="section-actions">
        <UiButton variant="outlined" label="新建 Skill" icon="pi pi-plus" @click="editSkill()" />
        <UiButton variant="outlined" label="装 Skill 包" icon="pi pi-upload" :loading="skillPackageBusy" @click="pickSkillPackage" />
        <UiButton label="新建 MCP" icon="pi pi-plus" @click="editMcp()" />
      </div>
    </header>
    <input ref="skillPackageInput" type="file" accept=".zip,application/zip" hidden @change="uploadSkillPackage">

    <!-- 待你处理。归零时不放庆祝文案，只说一句实话。 -->
    <div v-if="inbox.length" class="ext-inbox">
      <span class="ext-inbox-title"><i class="pi pi-inbox" aria-hidden="true" />等待处理</span>
      <button v-for="entry in inbox" :key="entry.label" type="button" class="ext-inbox-item" @click="tab = entry.key">
        <b>{{ entry.count }}</b>{{ entry.label }}
      </button>
    </div>
    <p v-else class="ext-inbox quiet"><span class="ext-inbox-title"><i class="pi pi-inbox" aria-hidden="true" />等待处理</span><span class="ext-muted">暂无</span></p>

    <nav class="subtabs" aria-label="扩展分类">
      <button v-for="[key, label, icon] in EXTENSION_TABS" :key="key" type="button" :class="{ active: tab === key }" @click="tab = key">
        <i :class="icon" aria-hidden="true" />{{ label }}<span>{{ countFor(key) }}</span>
      </button>
    </nav>

    <!-- 总开关与通道闸。**指名道姓说出真正关着的那个键**。 -->
    <p v-if="tab === 'skills' && skillsMasterOff" class="callout warn">
      <i class="pi pi-power-off" aria-hidden="true" />总开关 <code>skills.enabled</code> 已关闭：下列 Skill 都不会进入模型目录。
      <UiButton size="small" variant="outlined" label="打开总开关" @click="enableConfigKey('skills.enabled', 'Skill 总开关已打开')" />
    </p>
    <p v-if="tab === 'mcp' && mcpMasterOff" class="callout warn">
      <i class="pi pi-power-off" aria-hidden="true" />总开关 <code>mcp.enabled</code> 已关闭（出厂默认）：下列 server 可保存，但不会连接。
      <UiButton size="small" variant="outlined" label="打开总开关" @click="enableConfigKey('mcp.enabled', 'MCP 总开关已打开')" />
    </p>
    <p v-if="selfExtendOffKey" class="callout">
      <i class="pi pi-info-circle" aria-hidden="true" /><code>{{ selfExtendOffKey }}</code> 已关闭（出厂默认）：本页仍可创建与启停，<b>模型自身</b>不能{{ selfExtendVerb }}。
      <UiButton size="small" variant="outlined" label="打开这条通道" @click="enableConfigKey(selfExtendOffKey, `${selfExtendOffKey} 已打开`)" />
    </p>

    <div data-ext-tab="skills" v-show="tab === 'skills'">
      <p class="eyebrow">SKILLS · {{ skills.length }}</p>
      <p class="section-note">每份 Skill 即一个 <code>SKILL.md</code>，描述决定模型何时读取。<b>启用前需复核正文与包内文件</b>。</p>
      <SkillList :rows="skills" :busy="busy" :master-off="skillsMasterOff" @toggle="toggleSkill" @edit="editSkill" @remove="removeSkill" />
    </div>

    <div data-ext-tab="mcp" v-show="tab === 'mcp'">
      <p class="eyebrow">MCP · {{ mcp.length }} · {{ mcp.reduce((sum, row) => sum + (row.tools?.length ?? 0), 0) }} TOOLS</p>
      <p class="section-note">MCP server 的工具动态注册进模型目录。<b>启用前需复核来源与登录状态</b>，点击工具条数查看清单。</p>
      <McpTable
        :rows="mcp" :busy="busy" :master-off="mcpMasterOff" :auth-available="authAvailable"
        @toggle="toggleMcp" @edit="editMcp" @remove="removeMcp" @reconnect="reconnectMcp"
        @tools="showTools" @login="loginMcp" @credential="editCredential" @sign-out="signOutMcp"
      />
    </div>

    <div data-ext-tab="plugins" v-show="tab === 'plugins'">
      <p class="eyebrow">PLUGINS · {{ plugins.length }}</p>
      <p class="section-note">Plugin 即 <code>plugins/&lt;名字&gt;/plugin.js</code>，在 bot 进程内<b>全信任</b>运行，无沙箱，与本项目代码同一信任级别。<b>启用前需复核源码</b>。</p>
      <PluginCards :rows="plugins" :busy="busy" :hot-reload-warning="hotReloadWarning" @toggle="togglePlugin" @source="reviewPlugin" @reload="reloadPlugin" @remove="removePlugin" />
    </div>

    <div data-ext-tab="tools" v-show="tab === 'tools'">
      <p class="eyebrow">CUSTOM TOOLS · {{ customTools.length }}</p>
      <p class="section-note">模型通过 <code>define_tool</code> 创建的沙箱脚本，写入即停用，正文只读。<b>启用前需复核正文与参数</b>。</p>
      <CustomToolQueue
        :rows="customTools" :busy="busy"
        :authoring-off="configPath('tools.selfExtend.customTools.enabled') === false"
        @toggle="toggleCustomTool" @review="reviewCustomTool" @remove="removeCustomTool"
      />
    </div>

    <!-- ── 对话框 ────────────────────────────────────────────────────────────── -->
    <UiModal v-model:visible="confirmBox.open" :title="confirmBox.title" width="min(560px, 94vw)">
      <!-- `confirm-detail` 是层级钩子不是样式钩子：所有 `.ui-overlay` 同 z-index，同层只能靠 DOM 顺序
           分胜负，而这张确认框在模板里排在 Skill / MCP 弹窗**之前** —— 在 Skill 弹窗里点〔永久删除〕，
           确认框被盖在下面，表现是点了没反应。`styles.css` 的 `:has(.confirm-detail)` 认出它再抬一层。 -->
      <p class="callout warn confirm-detail"><i class="pi pi-exclamation-triangle" aria-hidden="true" />{{ confirmBox.detail }}</p>
      <template #footer>
        <UiButton variant="text" label="取消" @click="confirmBox.open = false" />
        <UiButton severity="danger" label="确认" :loading="confirmBusy" @click="runConfirmed" />
      </template>
    </UiModal>

    <UiModal v-model:visible="packagePick.open" title="包内存在多份 SKILL.md" width="min(620px, 94vw)">
      <p class="section-note">选择一份，安装范围为它所在的整个目录。</p>
      <div class="form-grid"><label class="wide">安装目标<UiSelect v-model="packagePick.chosen" :options="packagePick.candidates" /></label></div>
      <template #footer>
        <UiButton variant="text" label="取消" @click="packagePick.open = false" />
        <UiButton label="安装这一个" :loading="skillPackageBusy" @click="packagePick.file && installPackage(packagePick.file, packagePick.chosen)" />
      </template>
    </UiModal>

    <UiModal v-model:visible="reviewDialog" :title="reviewTarget.kind === 'tool' ? `查看正文 · custom_${reviewTarget.name}` : `查看正文 · Plugin ${reviewTarget.name}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <p class="callout warn wide"><i class="pi pi-exclamation-triangle" aria-hidden="true" />{{ reviewTarget.kind === 'tool' ? '该脚本由模型编写，启用后以调用者的角色在沙箱内执行。' : 'Plugin 在 bot 进程内全信任运行，无沙箱，与本项目代码同一信任级别。' }}</p>
        <p class="field-note wide">{{ reviewTarget.meta }}</p>
        <label v-if="reviewTarget.params" class="wide">参数 schema<textarea :value="reviewTarget.params" rows="8" readonly /></label>
        <label class="wide">{{ reviewTarget.kind === 'tool' ? '脚本正文' : 'plugin.js' }}<textarea :value="reviewTarget.body" rows="18" readonly /></label>
      </div>
      <template #footer>
        <UiButton variant="text" label="关闭" @click="reviewDialog = false" />
        <UiButton :label="reviewTarget.enabled ? '停用' : '已复核，启用'" :severity="reviewTarget.enabled ? 'danger' : 'primary'" :loading="reviewBusy" @click="approveReview" />
      </template>
    </UiModal>

    <UiModal v-model:visible="skillDialog" :title="skillForm.isNew ? '新建 Skill' : `Skill ${skillForm.name}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <label>名称<input v-model="skillForm.name" :disabled="!skillForm.isNew" placeholder="lowercase-kebab-case"></label>
        <label>最低角色<UiSelect v-model="skillForm.minRole" :options="ROLES" /></label>
        <label class="wide">描述<input v-model="skillForm.description" maxlength="500" placeholder="模型在目录中看到的职责摘要"></label>
        <label>建议模型别名<input v-model="skillForm.model" placeholder="可留空"></label>
        <UiSwitch v-model="skillForm.enabled" class="wide" label="启用" />
        <label class="wide">允许工具（每行一个）<textarea v-model="skillForm.allowedTools" rows="3" placeholder="留空 = 沿用当前角色全部可用工具" /></label>
        <label class="wide">需要工具（每行一个）<textarea v-model="skillForm.requiresTools" rows="3" placeholder="这些工具不在本轮工具集内时，该 skill 不进入模型目录" /></label>
        <label class="wide">SKILL.md 正文<textarea v-model="skillForm.body" rows="14" placeholder="加载 Skill 后注入给模型的完整说明" /></label>
        <div v-if="!skillForm.isNew" class="wide">
          <p class="field-title">附属文件<small v-if="skillForm.source === 'package'">来自安装包：脚本与二进制会被执行，启用前需复核。</small></p>
          <div class="cap-tags"><UiTag v-for="file in skillForm.files" :key="file" :value="file" severity="secondary" /><small v-if="!skillForm.files.length" class="alias-empty">无</small></div>
        </div>
        <p v-if="skillReserved" class="callout wide"><i class="pi pi-lock" aria-hidden="true" />随包发的说明文档：仅可启停，不可修改正文或删除。</p>
      </div>
      <template #footer>
        <UiButton v-if="!skillForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="永久删除" :disabled="skillReserved" @click="removeSkill(skillForm.name)" />
        <UiButton variant="text" label="取消" @click="skillDialog = false" />
        <UiButton :label="skillForm.isNew ? '创建 Skill' : '保存 Skill'" :loading="skillSaving" :disabled="skillReserved" @click="saveSkill" />
      </template>
    </UiModal>

    <UiModal v-model:visible="mcpDialog" :title="mcpForm.isNew ? '新建 MCP server' : `MCP ${mcpForm.originalName}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <label>名称<input v-model="mcpForm.name" :disabled="!mcpForm.isNew" placeholder="server-name"></label>
        <label>Transport<UiSelect v-model="mcpForm.transport" :options="[{ value: 'stdio', label: 'stdio · 本地进程' }, { value: 'http', label: 'Streamable HTTP' }]" /></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">命令<input v-model="mcpForm.command" placeholder="npx / absolute/path/server"></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">参数（每行一个）<textarea v-model="mcpForm.args" rows="3" /></label>
        <label v-if="mcpForm.transport === 'stdio'" class="wide">环境变量 JSON<textarea v-model="mcpForm.env" rows="4" placeholder="{ &quot;TOKEN&quot;: &quot;...&quot; }" /></label>
        <label v-if="mcpForm.transport === 'http'" class="wide">URL<input v-model="mcpForm.url" type="url" placeholder="https://mcp.example.com/mcp"></label>
        <template v-if="mcpForm.transport === 'http'">
          <label>登录方式<UiSelect v-model="mcpForm.authMode" :options="[{ value: 'none', label: '不需要登录' }, { value: 'bearer', label: 'Bearer token' }, { value: 'oauth', label: 'OAuth 浏览器授权' }]" /></label>
          <label v-if="mcpForm.authMode === 'oauth'">scope（可留空）<input v-model="mcpForm.authScope" placeholder="read write"></label>
          <label v-if="mcpForm.authMode === 'oauth'" class="wide">client_id（对端不支持动态注册时手填）<input v-model="mcpForm.authClientId" placeholder="留空 = 使用 RFC 7591 动态注册"></label>
          <p v-if="mcpForm.authMode !== 'none'" class="callout wide"><i class="pi pi-shield" aria-hidden="true" />凭据<b>不写入该配置</b>，加密存储于单独一张表。保存后在列表对应行{{ mcpForm.authMode === 'bearer' ? '点击〔填 token〕' : '点击〔登录〕' }}。</p>
          <label class="wide">HTTP Headers JSON（非密用途）<textarea v-model="mcpForm.headers" rows="3" placeholder="{ &quot;X-Tenant&quot;: &quot;...&quot; }" /></label>
        </template>
        <label>最低角色<UiSelect v-model="mcpForm.minRole" :options="ROLES" /></label>
        <label>工具调用超时（ms）<UiNumber v-model="mcpForm.timeoutMs" :min="100" :step="1000" /></label>
        <label class="wide">工具允许 glob（每行一个）<textarea v-model="mcpForm.toolAllow" rows="2" placeholder="留空 = 全部允许" /></label>
        <label class="wide">工具拒绝 glob（每行一个）<textarea v-model="mcpForm.toolDeny" rows="2" /></label>
        <UiSwitch v-model="mcpForm.enabled" class="wide" label="启用并连接" />
      </div>
      <p v-if="mcpMasterOff" class="callout warn"><i class="pi pi-power-off" aria-hidden="true" />总开关 <code>mcp.enabled</code> 已关闭：可以保存，但 <code>reconcile</code> 会跳过，不会连接。</p>
      <p class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />外部信任边界：仅连接已审核的 server，用 allow/deny 缩小暴露面。</p>
      <template #footer>
        <UiButton v-if="!mcpForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="删除" @click="removeMcp(mcpForm.originalName)" />
        <UiButton variant="text" label="取消" @click="mcpDialog = false" />
        <UiButton label="保存并重连" :loading="mcpSaving" @click="saveMcp" />
      </template>
    </UiModal>

    <UiModal v-model:visible="credentialDialog.open" :title="`${credentialDialog.server} 的 token`" width="min(620px, 94vw)">
      <p class="callout"><i class="pi pi-shield" aria-hidden="true" />写入即加密（<code>LUOLI_MASTER_KEY</code>），此后<b>任何读路径均不回显</b>，列表仅显示末 4 位。保存后立即重连。</p>
      <div class="form-grid"><label class="wide">Bearer token<input v-model="credentialDialog.token" type="password" autocomplete="off" placeholder="粘贴对端提供的 token"></label></div>
      <template #footer>
        <UiButton variant="text" label="取消" @click="credentialDialog.open = false" />
        <UiButton label="保存并重连" :loading="credentialDialog.saving" @click="saveCredential" />
      </template>
    </UiModal>

    <UiDrawer v-model:visible="toolsDrawer.open" :title="`${toolsDrawer.server} 提供的工具（${toolsDrawer.tools.length}）`">
      <p class="section-note">这些描述由对端 server 提供，属于提示注入面。工具名在模型侧带 <code>mcp__{{ toolsDrawer.server }}__</code> 前缀，allow/deny 的 glob 匹配下方原始名。</p>
      <div class="ext-tool-list">
        <article v-for="entry in toolsDrawer.tools" :key="entry.name">
          <code>{{ entry.name }}</code>
          <p>{{ entry.description || '无描述' }}</p>
        </article>
        <p v-if="!toolsDrawer.tools.length" class="ext-muted">未发现工具</p>
      </div>
    </UiDrawer>
  </section>
</template>
