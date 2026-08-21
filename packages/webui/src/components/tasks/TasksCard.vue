<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import UiTag from '../../ui/UiTag.vue';
import UiModal from '../../ui/UiModal.vue';
import DataGrid from '../../ui/DataGrid.vue';
import { pushToast, toastError } from '../../ui/toast';
import { askConfirm } from '../../ui/confirm';
import { api, ApiError } from '../../api/client';
import type { TagSeverity } from '../../ui/types';
import { TASK_COLUMNS, TASK_STATES, durationText, type Paged, type TaskRow } from './types';

/**
 * 任务卡（`tasks` 表 —— `spawn_agent` 派发的子 agent 任务）。
 *
 * **分页游标和 loader 待在一起。** 这一页三张卡的端点、游标、弹窗、busy 态零交集，把 `page`
 * 提到父层只会重新制造一个争用点（`ConsoleView` 里 `loadConversations` 同形）。父层只发
 * `tick` 这一个「该重拉了」的脉冲。
 *
 * 普通 `<script setup>`，**不 `return` 任何东西**：上一次把控制台拆成子视图时，子 SFC 的
 * `setup` 返回了一个只有 `get` 陷阱的 Proxy，而 Vue 解析模板绑定走 `hasOwn(setupState, key)`
 * —— 14 个页面全渲染成空白而三条绿灯都亮着（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number }>();
/** 两个跳转的出口：父层已经接到 `ConsoleView` 的 `openDetail` / `openTrace` 上。 */
const emit = defineEmits<{ 'open-turn': [string]; 'open-trace': [string] }>();

const PAGE_SIZE = 20;
const rows = ref<TaskRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/**
 * 归一化而不是直接塞：形状对不上的响应（老版本服务端、代理截断）不该让整页崩在 DataGrid 的
 * `rows` 上。渲染防线就是为这类事建的（docs/24 · R-UI-01）。
 *
 * `reload()` **不把 `page` 复位成 1** —— SSE 事件会让列表在原地重拉，跟着复位等于运维翻到
 * 第 3 页就被弹回第 1 页。只有一种例外：删掉末页最后一行之后服务端会回一页空，停在那儿看起来
 * 像「任务全没了」，所以往回退一页。`page > last` 保证最多多拉一次就收敛。
 */
async function reload(target = page.value): Promise<void> {
  loading.value = true;
  try {
    const result = await api<Partial<Paged<TaskRow>>>(`/api/tasks?page=${target}&size=${PAGE_SIZE}`);
    rows.value = Array.isArray(result?.items) ? result.items : [];
    total.value = Number(result?.total ?? 0);
    page.value = Number(result?.page ?? target);
    const last = Math.max(1, Math.ceil(total.value / PAGE_SIZE));
    if (!rows.value.length && total.value > 0 && page.value > last) { await reload(last); return; }
  } catch (error) { toastError('加载任务失败', error); }
  finally { loading.value = false; }
}

const cancelling = ref('');
/** 任务没有独立的取消句柄：`spawn_agent` 的子 agent 跑在父轮次的 abort 信号下，
 *  取消一条任务只能取消它所属的整轮 —— 说清楚再动手，别让人以为只停了这一个子 agent。 */
function cancelTaskTurn(task: TaskRow): void {
  const turnId = String(task.turn_id ?? '');
  if (!turnId) { pushToast({ severity: 'warn', summary: '这条任务没有关联轮次', detail: '没有可取消的对象' }); return; }
  askConfirm(`取消任务「${String(task.title ?? turnId)}」？`,
    `它没有独立的取消句柄，实际取消的是所属的整轮 ${turnId.slice(0, 12)} —— 同一轮里的其他子 agent 也会一起停。`, async () => {
      cancelling.value = turnId;
      try {
        const result = await api<{ cancelled: boolean }>(`/api/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', body: '{}' });
        pushToast(result.cancelled ? { severity: 'success', summary: '已发出取消信号', detail: `轮次 ${turnId.slice(0, 12)}` }
          : { severity: 'warn', summary: '这一轮已经结束了', detail: '任务状态会在下次刷新时归位' });
        await reload();
        // 弹窗开着时那份详情已经过期了：footer 上「取消整轮」该不该在，读的就是它的 `state`。
        if (detail.value?.id === task.id) await loadDetail(task.id);
      } catch (error) { toastError('取消失败', error); }
      finally { cancelling.value = ''; }
    });
}

/**
 * 只读详情。`progress_json` 与 `result_summary` 两列运行时一直在写，界面上从来没出现过
 * （docs/21 §8）；列表不发它们（一帧进度可以有几 KB），所以单取一次。
 */
interface TaskDetail extends TaskRow {
  placeholder_tg_message_id: number | null;
  /** 已经解析过的那一份 —— 服务端不再把原始 JSON 串一起发。解不出来时是 `null`。 */
  progress: unknown;
  turn: { state: string; steps: number; toolCalls: number; costUsd: number; error: string | null } | null;
  agentRun: { agentName: string; modelAlias: string; state: string; resultSummary: string | null } | null;
}
const detailDialog = ref(false);
const detailLoading = ref(false);
const detail = ref<TaskDetail | null>(null);

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true;
  try { detail.value = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`); }
  catch (error) { toastError('加载任务详情失败', error); detailDialog.value = false; }
  finally { detailLoading.value = false; }
}
async function openDetail(task: TaskRow): Promise<void> {
  detailDialog.value = true; detail.value = null;
  await loadDetail(String(task.id));
}

/** 进度那一格既可能是一段字符串，也可能是 `AgentManager` 写下的一个对象。 */
const progressText = computed(() => {
  const value = detail.value?.progress;
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
});
const taskState = (state: string): { label: string; severity: TagSeverity } => TASK_STATES[state] ?? { label: state, severity: 'secondary' };

/**
 * 删的是**记录**，不是取消通道：把行删掉不会让那个 agent 停下来，只会让它变成一条谁都看不见的
 * 在途任务 —— 所以服务端对 `running` 一律 409，界面这边也不给按。
 */
function removeTask(task: TaskDetail): void {
  askConfirm(`永久删除任务「${task.title}」？`,
    '只删这一条任务记录；这一轮、agent run、会话上下文、以及已经发出去的消息一概不动，也撤不回来。', async () => {
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
        pushToast({ severity: 'success', summary: `任务「${task.title}」已永久删除`, detail: '只删掉了这一条记录' });
        detailDialog.value = false;
        await reload();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'task_running') {
          pushToast({ severity: 'warn', summary: '这条任务还在跑', detail: '删掉记录不会让它停下来 —— 先取消它所属的整轮，等状态归位再删。' });
          return;
        }
        toastError('删除失败', error);
      }
    });
}

onMounted(() => { void reload(); });
watch(() => props.tick, () => { void reload(); });
</script>

<template>
  <article class="surface"><h3>任务</h3><p class="section-note">任务由 <code>spawn_agent</code> 派发，跟着它所属的那一轮活着。子 agent 没有独立的取消句柄，<b>「取消」取消的是整轮</b> —— 同一轮里的其他子 agent 也会一起停。点任意一行看这条任务的进度与结果。</p>
    <DataGrid :rows="rows" :columns="TASK_COLUMNS" data-key="id" clickable :loading="loading" empty="没有在途或历史任务" @row-click="openDetail">
      <template #state="{ data }"><UiTag :value="taskState(data.state).label" :severity="taskState(data.state).severity" /></template>
      <template #chat="{ data }"><span>{{ data.chatLabel ?? data.chat_id }}</span><small class="alias-empty">{{ data.userLabel ?? data.user_id }}</small></template>
      <template #updated_at="{ data }">{{ new Date(Number(data.updated_at)).toLocaleString() }}</template>
      <!-- 容器上的 `@click.stop` 是必需的：`DataGrid` 的 row-click 挂在 `<tr>` 上（`DataGrid.vue:43`），
           不 stop 就是「点取消的同时弹出详情框」。先例是 Agent 表那个〔试跑〕（`ConsoleView.vue:2286`），
           它也是 clickable + 行内按钮，也带着 stop。 -->
      <template #actions="{ data }"><div class="section-actions" @click.stop><UiButton v-if="data.state === 'running'" size="small" variant="outlined" severity="danger" label="取消" :loading="cancelling === data.turn_id" @click="cancelTaskTurn(data)" /></div></template>
    </DataGrid>
    <footer v-if="total" class="grid-pager">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页</span>
      <button type="button" aria-label="上一页" :disabled="page <= 1 || loading" @click="reload(page - 1)"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
      <button type="button" aria-label="下一页" :disabled="page >= pages || loading" @click="reload(page + 1)"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
    </footer>

    <UiModal v-model:visible="detailDialog" :title="detail ? `任务详情 ${detail.title}` : '任务详情'" width="min(1120px, 96vw)">
      <p v-if="detailLoading" class="empty"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 读取这条任务…</p>
      <template v-else-if="detail">
        <div class="detail-summary">
          <span><small>状态</small><UiTag :value="taskState(detail.state).label" :severity="taskState(detail.state).severity" /></span>
          <span><small>标题</small><b>{{ detail.title }}</b></span>
          <span><small>会话</small><b>{{ detail.chatLabel ?? detail.chat_id }}</b></span>
          <span><small>发起人</small><b>{{ detail.userLabel ?? detail.user_id }}</b></span>
          <span><small>创建</small><b>{{ new Date(Number(detail.created_at)).toLocaleString() }}</b></span>
          <span><small>更新</small><b>{{ new Date(Number(detail.updated_at)).toLocaleString() }}</b></span>
          <span><small>结束</small><b>{{ detail.finished_at ? new Date(Number(detail.finished_at)).toLocaleString() : '—' }}</b></span>
          <span><small>耗时</small><b>{{ detail.finished_at ? durationText(Number(detail.finished_at) - Number(detail.created_at)) : '还在跑' }}</b></span>
          <span v-if="detail.turn"><small>步数 / 工具</small><b>{{ detail.turn.steps }} · {{ detail.turn.toolCalls }}</b></span>
          <span v-if="detail.turn"><small>花费</small><b>${{ Number(detail.turn.costUsd || 0).toFixed(4) }}</b></span>
          <span v-if="detail.agentRun"><small>agent</small><code>{{ detail.agentRun.agentName }}</code></span>
          <span v-if="detail.agentRun"><small>别名</small><code>{{ detail.agentRun.modelAlias }}</code></span>
          <span><small>turn</small><code>{{ detail.turn_id }}</code></span>
          <span v-if="detail.agent_run_id"><small>agent run</small><code>{{ detail.agent_run_id }}</code></span>
          <span v-if="detail.placeholder_tg_message_id"><small>占位消息</small><code>{{ detail.placeholder_tg_message_id }}</code></span>
        </div>
        <p v-if="detail.turn?.error" class="callout error"><i class="pi pi-times-circle" aria-hidden="true" />{{ detail.turn.error }}</p>
        <div class="detail-payload">
          <!-- **不回退到 `agentRun.resultSummary`。** 成功那一路两列是同一个串：`runSubAgent` 返回的
               正是 `AgentManager.finish()` 的 `summary`（`agent/subagent.ts:178-180`），`spawn_agent`
               紧接着把它写进 `tasks.result_summary`（`tools/builtins.ts:406`）。两者真正分岔的只有失败
               那一路 —— 那时 `agent_runs.result_summary` 是 NULL、原因在 `agent_runs.error` 上，而
               `tasks.result_summary` 记着那句错误（`builtins.ts:392/410`、`db/database.ts:65` 的
               `process_restarted` 同理）。所以回退永远轮不到，加了只是暗示一种不存在的分岔。 -->
          <div class="detail-actions"><b>结果摘要</b><small class="alias-empty">子 agent 交回来的那一段，也是父 agent 读到的那一段。</small></div>
          <pre v-if="detail.result_summary" v-text="detail.result_summary" />
          <p v-else class="empty">这条任务还没有写下结果摘要。</p>
        </div>
        <div class="detail-payload">
          <div class="detail-actions"><b>最后一条进度</b><small class="alias-empty">每报一次进度都覆盖同一格，所以这里只剩最后那一帧，看不到中间过程；任务跑完之后这一格不再更新。</small></div>
          <pre v-if="progressText" v-text="progressText" />
          <p v-else class="empty">这条任务没有留下进度。</p>
        </div>
      </template>
      <template #footer>
        <UiButton variant="outlined" severity="danger" icon="pi pi-trash" label="永久删除" :disabled="!detail || detail.state === 'running'" @click="removeTask(detail!)" />
        <UiButton v-if="detail?.state === 'running'" severity="danger" label="取消整轮" :loading="cancelling === detail?.turn_id" @click="cancelTaskTurn(detail!)" />
        <UiButton v-if="detail?.turn_id" variant="text" icon="pi pi-comments" label="看这一轮详情" @click="detailDialog = false; emit('open-turn', detail!.turn_id)" />
        <UiButton v-if="detail?.turn_id" variant="outlined" icon="pi pi-sitemap" label="在日志页看这条 trace" @click="detailDialog = false; emit('open-trace', detail!.turn_id)" />
        <UiButton variant="text" label="关闭" @click="detailDialog = false" />
      </template>
    </UiModal>
  </article>
</template>
