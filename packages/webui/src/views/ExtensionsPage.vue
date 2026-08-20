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
 * **为什么四类不再共用一张卡片。** `docs/09 §3.8` 原来的口径是「四类扩展继续共用卡片网格，
 * 但操作按各自真实生命周期区分」，实现是一个 `extensionRows` 把四类拼成一个数组、塞进一个
 * `provider-grid`，八个动作按钮靠 `v-if="item.kind === ..."` 分流。代价是每一类只显示得出
 * 四类的**交集**：MCP 的连接状态、plugin 的 `provides`、skill 的 `requires-tools`、
 * 自定义工具的 runtime/scope 全都摆不下，而 API 早就在发这些字段。
 *
 * 现在四类各一套版式，视觉主轴换成**来源 + 有没有人看过**（左侧那条脊 + `pending-review` 的
 * 虚线边框）。M12 之后这一页上有一部分东西是模型自己写的，而运维在这一页的活儿正是
 * 「决定模型被允许具备什么能力，并且真的看过」。
 *
 * **所有写操作与 busy 态都在这一层。** 四个子组件是纯呈现的：props 进、emit 出，不碰 `api()`。
 * 上一次把控制台拆成子视图时，子 SFC 的 `setup` 返回了一个只有 `get` 陷阱的 Proxy，而 Vue 解析
 * 模板绑定走 `hasOwn(setupState, key)` —— 14 个页面全渲染成空白而三条绿灯都亮着
 * （docs/24 · R-UI-01）。这里一律用普通 `<script setup>`，不返回任何 Proxy，
 * 而 `tests/webui/console.render.test.ts` 每个分段都真的渲染一次。
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
 * **WebUI 不 import `@luoli/shared`。** 那个包的 `exports` 指向 `dist/index.js`，而它 import
 * `node:crypto` —— vite 会把它 externalize 成一个一调用就抛的桩，表现是这一页整片空白加一条
 * 「Module "node:crypto" has been externalized for browser compatibility」。而 vitest 把
 * `@luoli/shared` 别名到 `src/index.ts` 并跑在 node 里，所以**渲染用例是绿的**。
 * `ConsoleView.vue` 一直自己留一份同样的常量，同一个原因。
 */
const ROLES = ['owner', 'trusted', 'limited', 'blocked'];

/** 改这里时连同 `tests/webui/console.render.test.ts` 的 `EXTENSION_TABS` 一起改：
 *  少一个分支等于那一段从此没人渲染过（设置页那四个 tab 同一个道理）。 */
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

// ── 待你处理：这一页真正的收件箱 ────────────────────────────────────────────────
const pendingSkills = computed(() => props.skills.filter(skillPendingReview));
const pendingTools = computed(() => props.customTools.filter(customToolPendingReview));
const needsLogin = computed(() => props.mcp.filter((row) => row.enabled !== 0 && row.state === 'needs_auth'));
const broken = computed(() => [
  ...props.skills.filter((row) => row.load_error).map((row) => row.name),
  ...props.plugins.filter((row) => row.load_error).map((row) => row.name),
  ...props.mcp.filter((row) => row.enabled !== 0 && row.state === 'down').map((row) => row.name),
]);
const inbox = computed(() => [
  { key: 'skills' as TabKey, count: pendingSkills.value.length, label: '个装进来的 Skill 等人读过' },
  { key: 'tools' as TabKey, count: pendingTools.value.length, label: '段模型写的脚本等人复审' },
  { key: 'mcp' as TabKey, count: needsLogin.value.length, label: '台 MCP server 要登录' },
  { key: 'mcp' as TabKey, count: broken.value.length, label: '项加载或连接失败' },
].filter((entry) => entry.count > 0));

// ── 总开关。**要说出真正关着的那个键。** 此前这条提示恒定写「tools.selfExtend.skills.enabled
//    是关的」，而判据是「主闸或子闸任一为假」—— 主闸关着时提示指向的那个键其实是开的，
//    照它去翻只会发现「明明开着」。
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
const selfExtendVerb = computed(() => ({ skills: '写 / 装 skill', tools: '给自己写工具', plugins: '写 plugin', mcp: '登记 MCP server' })[tab.value]);
const authAvailable = computed(() => props.mcp.every((row) => row.credential !== undefined));

async function enableConfigKey(key: string, summary: string): Promise<void> {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ [key]: true }) });
    pushToast({ severity: 'success', summary, detail: '热更新，无需重启' });
    emit('refresh');
  } catch (error) { toastError(`打开 ${key} 失败`, error); }
}

// ── 启停：四类各自的资源路径，但确认语句按风险各写一份 ──────────────────────────
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
  // Plugin 是全信任执行任意代码的，开启这一步必须是有意识的动作（docs/07 §3）。停用不用问。
  if (row.enabled !== 0) { void patchEnabled('plugin', row.name, false); return; }
  askConfirm(`启用 Plugin ${row.name}？`, 'plugin 在 bot 进程里全信任运行，没有沙箱 —— 启用等于把这段代码当成本项目自己的代码。先点〔看源码〕读过它。',
    () => patchEnabled('plugin', row.name, true));
}
function toggleCustomTool(row: CustomToolRow): void {
  if (row.enabled !== 0) { void patchEnabled('tool', row.name, false); return; }
  askConfirm(`启用 custom_${row.name}？`, '这段脚本是模型写的。启用后它会以调用者的角色在沙箱里执行，而那时正文已经不在对话里了。先点〔读脚本〕看过它。',
    () => patchEnabled('tool', row.name, true));
}

// ── Skill ────────────────────────────────────────────────────────────────────
interface SkillDetail { name: string; description: string; body: string; allowedTools?: string[]; requiresTools?: string[]; minRole: string; model?: string; enabled: boolean; files: string[] }
const skillDialog = ref(false);
const skillSaving = ref(false);
const skillForm = ref({ name: '', description: '', body: '', allowedTools: '', requiresTools: '', minRole: 'trusted', model: '', enabled: true, files: [] as string[], isNew: true, source: 'local' });
/** 随包发的四份说明书服务端只放行启停（改正文 / 删除回 403 `skill_reserved`）。这里跟着灰掉 ——
 *  「界面上给了但后端拒绝」比一开始就不给更难排查。 */
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
  askConfirm(`永久删除 Skill ${name}？`, '会删除它的整个目录（SKILL.md 与附属文件），无法从 WebUI 恢复。', async () => {
    try { await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `Skill ${name} 已永久删除` }); skillDialog.value = false; emit('refresh'); }
    catch (error) { toastError('删除 Skill 失败', error); }
  });
}

/**
 * 装一个 skill 包（docs/07 §2.5）。走 multipart 而不是 JSON：包里有二进制，base64 进 JSON
 * 会把体积撑大三分之一，而这条路的上限本来就是按字节配的。
 *
 * 包根有歧义时服务端回 `skill_ambiguous_root` 并带上候选（同一个 zip 里常有 windows / linux
 * 两套），这里就地问一句装哪个再重试 —— 只说「有歧义」等于让人自己去猜 subdir 填什么。
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
    pushToast({ severity: 'success', summary: `Skill ${installed.name} 已装入`, detail: `${installed.files.length} 个文件，处于停用状态 —— 点〔读一遍〕看过内容再启用` });
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
      ? { severity: 'warn', summary: `MCP ${form.name} 已保存，但没有连接`, detail: '总开关 mcp.enabled 是关的，reconcile 会直接跳过所有 server。到这一页顶部打开它。', life: 12_000 }
      : { severity: 'success', summary: `MCP ${form.name} 已保存`, detail: '配置已热更新并重新发现工具' });
    emit('refresh');
  } catch (error) { toastError('保存 MCP 失败', error); }
  finally { mcpSaving.value = false; }
}
function removeMcp(name: string): void {
  askConfirm(`删除 MCP server ${name}？`, '连接会关闭，发现到的工具立即从模型工具目录移除；它的凭据也会一起删掉。', async () => {
    try { await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `MCP ${name} 已删除` }); mcpDialog.value = false; emit('refresh'); }
    catch (error) { toastError('删除 MCP 失败', error); }
  });
}
/**
 * 重连。`POST /api/mcp/:name/reconnect` 的返回值**直接用**：此前它被整块丢掉、然后重新
 * `load()` 一遍，于是点一下只看得到一句「已重连」，而这一跳最想知道的恰好是它这次连上没有。
 */
async function reconnectMcp(row: McpRow): Promise<void> {
  busy.value = `mcp:${row.name}`;
  try {
    const result = await api<{ state: string | null; error: string | null }>(`/api/mcp/${encodeURIComponent(row.name)}/reconnect`, { method: 'POST', body: '{}' });
    pushToast(result.state === 'up'
      ? { severity: 'success', summary: `${row.name} 已连接` }
      : { severity: 'warn', summary: `${row.name} 仍未连上`, detail: result.error ?? `状态：${result.state ?? '未知'}`, life: 12_000 });
    emit('refresh');
  } catch (error) { toastError('重连失败', error); }
  finally { busy.value = ''; }
}

/** 工具清单抽屉。条数在表里，描述在这儿 —— 那份描述由对面那台 server 写，是提示注入面之一。 */
const toolsDrawer = ref<{ open: boolean; server: string; tools: Array<{ name: string; description: string }> }>({ open: false, server: '', tools: [] });
function showTools(row: McpRow): void {
  toolsDrawer.value = { open: true, server: row.name,
    tools: (row.tools ?? []).map((entry) => ({ name: String(entry.name ?? '?'), description: typeof entry.description === 'string' ? entry.description : '' })) };
}

/** 登录。**不在这里跳转** —— 授权地址由服务端算出来（它才知道 `webui.publicUrl`），
 *  这里只负责在新标签里打开它，并且把那个链接留在界面上（刷新之后还得能点）。 */
async function loginMcp(row: McpRow): Promise<void> {
  busy.value = `mcp:${row.name}`;
  try {
    const started = await api<{ status: string; authorizationUrl: string | null }>(`/api/mcp/${encodeURIComponent(row.name)}/auth/start`, { method: 'POST', body: '{}' });
    if (started.status === 'AUTHORIZED') { pushToast({ severity: 'success', summary: `${row.name} 已有可用凭据` }); emit('refresh'); return; }
    if (!started.authorizationUrl) { pushToast({ severity: 'warn', summary: '没拿到授权地址', detail: '看日志里的 mcp.auth 事件' }); return; }
    window.open(started.authorizationUrl, '_blank', 'noopener');
    pushToast({ severity: 'info', summary: `${row.name}：去新标签里完成授权`, detail: '授权完会自动跳回控制台并重连。10 分钟内有效。', life: 15_000 });
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
      ? { severity: 'success', summary: `${form.server} 已用新 token 连上` }
      : { severity: 'warn', summary: `token 存下了，但没连上`, detail: result.error ?? `状态：${result.state ?? '未知'}`, life: 12_000 });
    emit('refresh');
  } catch (error) { toastError('保存 token 失败', error); }
  finally { form.saving = false; }
}
function signOutMcp(row: McpRow): void {
  askConfirm(`注销 ${row.name}？`, '保存的凭据会被清掉，这台 server 会回到「要登录」。下次要用它得再授权一次。', async () => {
    busy.value = `mcp:${row.name}`;
    try { await api(`/api/mcp/${encodeURIComponent(row.name)}/auth`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `${row.name} 已注销` }); emit('refresh'); }
    catch (error) { toastError('注销失败', error); }
    finally { busy.value = ''; }
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────
/**
 * 重载的响应里带 `hotReloadReliable` 与 `warning`：跑在 tsx（`pnpm dev`）下时热重载**静默跑
 * 旧代码** —— reconcile 每次都真跑、`onLoad` 每次打印的都是第一版。此前这整块响应被丢掉、
 * 恒弹一句「已重载」，而这个开关唯一该用的场景就是本机写 plugin，恰好是它失效的场景。
 */
const hotReloadWarning = ref('');
async function reloadPlugin(row: PluginRow): Promise<void> {
  busy.value = `plugin:${row.name}`;
  try {
    const result = await api<{ hotReloadReliable?: boolean; warning?: string }>(`/api/plugins/${encodeURIComponent(row.name)}/reload`, { method: 'POST', body: '{}' });
    if (result.hotReloadReliable === false) {
      hotReloadWarning.value = result.warning ?? '这个运行时下 plugin 热重载不可靠：重载会成功但仍跑旧代码。';
      pushToast({ severity: 'warn', summary: `${row.name} 重载了，但很可能仍跑旧代码`, detail: hotReloadWarning.value, life: 0 });
    } else {
      hotReloadWarning.value = '';
      pushToast({ severity: 'success', summary: `${row.name} 已重载` });
    }
    emit('refresh');
  } catch (error) { toastError('重载失败', error); }
  finally { busy.value = ''; }
}
function removePlugin(name: string): void {
  askConfirm(`删除 Plugin ${name}？`, `会连 plugins/${name}/ 整个目录一起移除。`, async () => {
    try { await api(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' }); pushToast({ severity: 'success', summary: `${name} 已删除` }); emit('refresh'); }
    catch (error) { toastError('删除 Plugin 失败', error); }
  });
}

// ── 复审面（plugin 源码 / 自定义工具正文）。**只读** ─────────────────────────────
const reviewDialog = ref(false);
const reviewBusy = ref(false);
const reviewTarget = ref<{ kind: 'tool' | 'plugin'; name: string; enabled: boolean; meta: string; params: string; body: string }>(
  { kind: 'tool', name: '', enabled: false, meta: '', params: '', body: '' });
function reviewCustomTool(row: CustomToolRow): void {
  let params = row.paramsJson;
  try { params = JSON.stringify(JSON.parse(row.paramsJson), null, 2); } catch { /* 库里那份不是合法 JSON 就原样显示 */ }
  reviewTarget.value = { kind: 'tool', name: row.name, enabled: row.enabled === 1, params, body: row.body,
    meta: `${row.runtime} · 最低角色 ${row.minRole} · 作用域 ${row.scope === 'chat' ? `仅会话 ${row.ownerChatId}` : '全局'} · 由 ${row.createdBy} 写下` };
  reviewDialog.value = true;
}
async function reviewPlugin(row: PluginRow): Promise<void> {
  try {
    const detail = await api<{ name: string; source: string }>(`/api/plugins/${encodeURIComponent(row.name)}/source`);
    reviewTarget.value = { kind: 'plugin', name: row.name, enabled: row.enabled !== 0, params: '', body: detail.source,
      meta: `plugin.js · 最低角色 ${row.min_role ?? '未标注'} · 启用后在 bot 进程里全信任运行` };
    reviewDialog.value = true;
  } catch (error) { toastError('读取 plugin 源码失败', error); }
}
function removeCustomTool(name: string): void {
  askConfirm(`删除 custom_${name}？`, '模型可以再写一份，但这一份的正文不会留档。', async () => {
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

// ── 页内确认框：这一页此前六处 window.confirm / prompt 的替代 ────────────────────
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
        <h2>模型能做什么，由这一页决定</h2>
        <p>四类东西各自往模型的能力面上加一块：Skill 加一份说明书、MCP 加一台外部 server 的工具、Plugin 加一段在本进程里全信任跑的代码、自定义工具加一段模型自己写的脚本。<b>其中两类是模型自己写下的</b> —— 所以每一行都标着它从哪儿来、有没有人看过。</p>
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
      <span class="ext-inbox-title"><i class="pi pi-inbox" aria-hidden="true" />待你处理</span>
      <button v-for="entry in inbox" :key="entry.label" type="button" class="ext-inbox-item" @click="tab = entry.key">
        <b>{{ entry.count }}</b>{{ entry.label }}
      </button>
    </div>
    <p v-else class="ext-inbox quiet"><span class="ext-inbox-title"><i class="pi pi-inbox" aria-hidden="true" />待你处理</span><span class="ext-muted">没有等着人看的东西。</span></p>

    <nav class="subtabs" aria-label="扩展分类">
      <button v-for="[key, label, icon] in EXTENSION_TABS" :key="key" type="button" :class="{ active: tab === key }" @click="tab = key">
        <i :class="icon" aria-hidden="true" />{{ label }}<span>{{ countFor(key) }}</span>
      </button>
    </nav>

    <!-- 总开关与通道闸。**指名道姓说出真正关着的那个键**。 -->
    <p v-if="tab === 'skills' && skillsMasterOff" class="callout warn">
      <i class="pi pi-power-off" aria-hidden="true" />总开关 <code>skills.enabled</code> 是关的：下面的 Skill 一个都不会进模型的目录。
      <UiButton size="small" variant="outlined" label="打开总开关" @click="enableConfigKey('skills.enabled', 'Skill 总开关已打开')" />
    </p>
    <p v-if="tab === 'mcp' && mcpMasterOff" class="callout warn">
      <i class="pi pi-power-off" aria-hidden="true" />总开关 <code>mcp.enabled</code> 是关的（出厂默认）：下面的 server 存得下也能编辑，但一个都不会连接。
      <UiButton size="small" variant="outlined" label="打开总开关" @click="enableConfigKey('mcp.enabled', 'MCP 总开关已打开')" />
    </p>
    <p v-if="selfExtendOffKey" class="callout">
      <i class="pi pi-info-circle" aria-hidden="true" /><code>{{ selfExtendOffKey }}</code> 是关的（出厂默认）：这一页照常能建、能装、能启停，但<b>模型自己</b>不能{{ selfExtendVerb }} —— 它拿不到那几个工具，也不会知道为什么。
      <UiButton size="small" variant="outlined" label="打开这条通道" @click="enableConfigKey(selfExtendOffKey, `${selfExtendOffKey} 已打开`)" />
    </p>

    <div data-ext-tab="skills" v-show="tab === 'skills'">
      <p class="eyebrow">SKILLS · {{ skills.length }}</p>
      <p class="section-note">一份 <code>SKILL.md</code> 就是一份说明书。平时只占模型目录里一行标题（名字 + 描述），被 <code>load_skill</code> 拉起来时才把正文注进去 —— 所以描述那一行决定了模型知不知道什么时候该读它。<b>说是之前要看的是正文</b>；装包进来的还要看它带了哪些文件。</p>
      <SkillList :rows="skills" :busy="busy" :master-off="skillsMasterOff" @toggle="toggleSkill" @edit="editSkill" @remove="removeSkill" />
    </div>

    <div data-ext-tab="mcp" v-show="tab === 'mcp'">
      <p class="eyebrow">MCP · {{ mcp.length }} · {{ mcp.reduce((sum, row) => sum + (row.tools?.length ?? 0), 0) }} TOOLS</p>
      <p class="section-note">一台 MCP server 是别人进程上的一条活连接，它把自己的工具动态挂进模型目录。<b>说是之前要看的是它活没活、谁的、挂了哪些工具、以及登录了没有</b> —— 远端 server 常常要登录，那一行会显示「要登录」而不是笼统的连不上。工具的描述由对面那台 server 写，它同样是提示注入面（点工具条数看清单）。</p>
      <McpTable
        :rows="mcp" :busy="busy" :master-off="mcpMasterOff" :auth-available="authAvailable"
        @toggle="toggleMcp" @edit="editMcp" @remove="removeMcp" @reconnect="reconnectMcp"
        @tools="showTools" @login="loginMcp" @credential="editCredential" @sign-out="signOutMcp"
      />
    </div>

    <div data-ext-tab="plugins" v-show="tab === 'plugins'">
      <p class="eyebrow">PLUGINS · {{ plugins.length }}</p>
      <p class="section-note">plugin 是 <code>plugins/&lt;名字&gt;/plugin.js</code>，在 bot 进程里<b>全信任</b>运行 —— 没有沙箱，跟本项目自己的代码同一个信任级别。<b>说是之前要看的是源码</b>，所以这一段的主动作是〔看源码〕。</p>
      <PluginCards :rows="plugins" :busy="busy" :hot-reload-warning="hotReloadWarning" @toggle="togglePlugin" @source="reviewPlugin" @reload="reloadPlugin" @remove="removePlugin" />
    </div>

    <div data-ext-tab="tools" v-show="tab === 'tools'">
      <p class="eyebrow">CUSTOM TOOLS · {{ customTools.length }}</p>
      <p class="section-note">模型用 <code>define_tool</code> 给自己写下的沙箱脚本，落库即停用。<b>说是之前要看的是脚本正文与参数</b>，而且这里的正文是只读的：顺手改一行会让 <code>definition_hash</code> 与模型以为的那份定义脱节，要改就让模型改，或者直接删。</p>
      <CustomToolQueue
        :rows="customTools" :busy="busy"
        :authoring-off="configPath('tools.selfExtend.customTools.enabled') === false"
        @toggle="toggleCustomTool" @review="reviewCustomTool" @remove="removeCustomTool"
      />
    </div>

    <!-- ── 对话框 ────────────────────────────────────────────────────────────── -->
    <UiModal v-model:visible="confirmBox.open" :title="confirmBox.title" width="min(560px, 94vw)">
      <p class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />{{ confirmBox.detail }}</p>
      <template #footer>
        <UiButton variant="text" label="取消" @click="confirmBox.open = false" />
        <UiButton severity="danger" label="确认" :loading="confirmBusy" @click="runConfirmed" />
      </template>
    </UiModal>

    <UiModal v-model:visible="packagePick.open" title="这个包里有多份 SKILL.md" width="min(620px, 94vw)">
      <p class="section-note">同一个 zip 里常常带着多套（windows / linux、或者一个示例目录）。选要装的那一个 —— 装的是它所在的整棵目录。</p>
      <div class="form-grid"><label class="wide">装哪一个<UiSelect v-model="packagePick.chosen" :options="packagePick.candidates" /></label></div>
      <template #footer>
        <UiButton variant="text" label="取消" @click="packagePick.open = false" />
        <UiButton label="装这一个" :loading="skillPackageBusy" @click="packagePick.file && installPackage(packagePick.file, packagePick.chosen)" />
      </template>
    </UiModal>

    <UiModal v-model:visible="reviewDialog" :title="reviewTarget.kind === 'tool' ? `读一遍 custom_${reviewTarget.name}` : `读一遍 Plugin ${reviewTarget.name}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <p class="callout warn wide"><i class="pi pi-exclamation-triangle" aria-hidden="true" />{{ reviewTarget.kind === 'tool' ? '这段脚本是模型写的。启用后它会以调用者的角色在沙箱里执行，且此后每一次调用时正文都不在对话里。' : 'Plugin 在 bot 进程里全信任运行，没有沙箱 —— 启用等于把这段代码当成本项目自己的代码。' }}</p>
        <p class="field-note wide">{{ reviewTarget.meta }}</p>
        <label v-if="reviewTarget.params" class="wide">参数 schema<textarea :value="reviewTarget.params" rows="8" readonly /></label>
        <label class="wide">{{ reviewTarget.kind === 'tool' ? '脚本正文' : 'plugin.js' }}<textarea :value="reviewTarget.body" rows="18" readonly /></label>
      </div>
      <template #footer>
        <UiButton variant="text" label="关闭" @click="reviewDialog = false" />
        <UiButton :label="reviewTarget.enabled ? '停用' : '看过了，启用'" :severity="reviewTarget.enabled ? 'danger' : 'primary'" :loading="reviewBusy" @click="approveReview" />
      </template>
    </UiModal>

    <UiModal v-model:visible="skillDialog" :title="skillForm.isNew ? '新建 Skill' : `Skill ${skillForm.name}`" width="min(900px, 96vw)">
      <div class="form-grid">
        <label>名称<input v-model="skillForm.name" :disabled="!skillForm.isNew" placeholder="lowercase-kebab-case"></label>
        <label>最低角色<UiSelect v-model="skillForm.minRole" :options="ROLES" /></label>
        <label class="wide">描述<input v-model="skillForm.description" maxlength="500" placeholder="模型在目录里看到的职责摘要"></label>
        <label>建议模型别名<input v-model="skillForm.model" placeholder="可留空"></label>
        <UiSwitch v-model="skillForm.enabled" class="wide" label="启用" />
        <label class="wide">允许工具（每行一个）<textarea v-model="skillForm.allowedTools" rows="3" placeholder="留空 = 沿用当前角色全部可用工具" /></label>
        <label class="wide">需要工具（每行一个）<textarea v-model="skillForm.requiresTools" rows="3" placeholder="这几个工具不在本轮工具集里时，这份 skill 不进模型目录 —— 一份「教你用一个你没有的工具」的说明书比没有更糟" /></label>
        <label class="wide">SKILL.md 正文<textarea v-model="skillForm.body" rows="14" placeholder="加载 Skill 后注入给模型的完整说明" /></label>
        <div v-if="!skillForm.isNew" class="wide">
          <p class="field-title">附属文件<small v-if="skillForm.source === 'package'">这份是装包装进来的：启用之前该看的就是这份清单 —— 里面的脚本与二进制会被正文指挥着跑起来。</small></p>
          <div class="cap-tags"><UiTag v-for="file in skillForm.files" :key="file" :value="file" severity="secondary" /><small v-if="!skillForm.files.length" class="alias-empty">无</small></div>
        </div>
        <p v-if="skillReserved" class="callout wide"><i class="pi pi-lock" aria-hidden="true" />这是随包发的说明书（模型写工具 / 装 MCP 之前要读的那份文档）：只能启停，不能改正文或删除。</p>
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
          <label v-if="mcpForm.authMode === 'oauth'" class="wide">client_id（对方不支持动态注册时手填）<input v-model="mcpForm.authClientId" placeholder="留空 = 走 RFC 7591 动态注册"></label>
          <p v-if="mcpForm.authMode !== 'none'" class="callout wide"><i class="pi pi-shield" aria-hidden="true" />凭据<b>不存在这份配置里</b> —— 它加密存在单独一张表，所以既不会进配置变更历史，也不会出现在配置导出里。保存完之后在列表那一行{{ mcpForm.authMode === 'bearer' ? '点〔填 token〕' : '点〔登录〕' }}。</p>
          <label class="wide">HTTP Headers JSON（非密用途）<textarea v-model="mcpForm.headers" rows="3" placeholder="{ &quot;X-Tenant&quot;: &quot;...&quot; }" /></label>
        </template>
        <label>最低角色<UiSelect v-model="mcpForm.minRole" :options="ROLES" /></label>
        <label>工具调用超时（ms）<UiNumber v-model="mcpForm.timeoutMs" :min="100" :step="1000" /></label>
        <label class="wide">工具允许 glob（每行一个）<textarea v-model="mcpForm.toolAllow" rows="2" placeholder="留空 = 全部允许" /></label>
        <label class="wide">工具拒绝 glob（每行一个）<textarea v-model="mcpForm.toolDeny" rows="2" /></label>
        <UiSwitch v-model="mcpForm.enabled" class="wide" label="启用并连接" />
      </div>
      <p v-if="mcpMasterOff" class="callout warn"><i class="pi pi-power-off" aria-hidden="true" />总开关 <code>mcp.enabled</code> 当前是关的：这份配置存得下，但 <code>reconcile</code> 会跳过所有 server，不会真的连接。</p>
      <p class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />stdio 命令与 HTTP server 都是外部信任边界；只连接你审核过的 server，并用工具 allow/deny 缩小暴露面。</p>
      <template #footer>
        <UiButton v-if="!mcpForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="删除" @click="removeMcp(mcpForm.originalName)" />
        <UiButton variant="text" label="取消" @click="mcpDialog = false" />
        <UiButton label="保存并重连" :loading="mcpSaving" @click="saveMcp" />
      </template>
    </UiModal>

    <UiModal v-model:visible="credentialDialog.open" :title="`${credentialDialog.server} 的 token`" width="min(620px, 94vw)">
      <p class="callout"><i class="pi pi-shield" aria-hidden="true" />写入即加密（<code>LUOLI_MASTER_KEY</code>），此后<b>任何读路径都不回显它</b> —— 列表上只看得到末 4 位。存好之后会立刻用新 token 重连一次。</p>
      <div class="form-grid"><label class="wide">Bearer token<input v-model="credentialDialog.token" type="password" autocomplete="off" placeholder="粘贴对方给的 token"></label></div>
      <template #footer>
        <UiButton variant="text" label="取消" @click="credentialDialog.open = false" />
        <UiButton label="保存并重连" :loading="credentialDialog.saving" @click="saveCredential" />
      </template>
    </UiModal>

    <UiDrawer v-model:visible="toolsDrawer.open" :title="`${toolsDrawer.server} 提供的工具（${toolsDrawer.tools.length}）`">
      <p class="section-note">这些描述由对面那台 server 写，模型会当成工具说明读进去 —— 它们是提示注入面之一，不是系统规则。工具名在模型那边带 <code>mcp__{{ toolsDrawer.server }}__</code> 前缀，而 allow/deny 的 glob 匹配的是下面这个原始名。</p>
      <div class="ext-tool-list">
        <article v-for="entry in toolsDrawer.tools" :key="entry.name">
          <code>{{ entry.name }}</code>
          <p>{{ entry.description || '这台 server 没有给这个工具写描述。' }}</p>
        </article>
        <p v-if="!toolsDrawer.tools.length" class="ext-muted">这台 server 一个工具都没有发现。</p>
      </div>
    </UiDrawer>
  </section>
</template>
