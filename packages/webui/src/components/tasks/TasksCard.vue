<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import UiModal from "../../ui/UiModal.vue";
import DataGrid from "../../ui/DataGrid.vue";
import { pushToast, toastError } from "../../ui/toast";
import { askConfirm } from "../../ui/confirm";
import { api, ApiError } from "../../api/client";
import type { TagSeverity } from "../../ui/types";
import {
  TASK_COLUMNS,
  TASK_STATES,
  durationText,
  type Paged,
  type TaskRow,
} from "./types";

/**
 * 任务卡（`tasks` 表，即 `spawn_worker` 派发的 worker 任务）。
 *
 * 分页游标与 loader 放在一起。这一页三张卡的端点、游标、弹窗、busy 态没有交集，把 `page`
 * 提升到父层只会重新制造一个争用点（`ConsoleView` 中 `loadConversations` 同形）。父层只发送
 * `tick` 这一个重新拉取的脉冲。
 *
 * 普通 `<script setup>`，不 `return` 任何东西：上一次把控制台拆成子视图时，子 SFC 的
 * `setup` 返回了一个只有 `get` 陷阱的 Proxy，而 Vue 解析模板绑定走 `hasOwn(setupState, key)`，
 * 导致 14 个页面全部渲染为空白而三条健康检查仍通过（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number }>();
/** 两个跳转出口：父层已接到 `ConsoleView` 的 `openDetail` / `openTrace` 上。 */
const emit = defineEmits<{ "open-turn": [string]; "open-trace": [string] }>();

const PAGE_SIZE = 20;
const rows = ref<TaskRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/**
 * 归一化而不是直接赋值：形状不匹配的响应（旧版服务端、代理截断）不应使整页在 DataGrid 的
 * `rows` 上崩溃。渲染防线正是为此建立的（docs/24 · R-UI-01）。
 *
 * `reload()` 不把 `page` 复位为 1：SSE 事件会让列表原地重新拉取，一并复位意味着运维翻到
 * 第 3 页就会被弹回第 1 页。唯一的例外是删除末页最后一行后服务端会返回空页，停留在该页看起来
 * 像任务全部消失，因此回退一页。`page > last` 保证最多多拉取一次即收敛。
 */
async function reload(target = page.value): Promise<void> {
  loading.value = true;
  try {
    const result = await api<Partial<Paged<TaskRow>>>(
      `/api/tasks?page=${target}&size=${PAGE_SIZE}`,
    );
    rows.value = Array.isArray(result?.items) ? result.items : [];
    total.value = Number(result?.total ?? 0);
    page.value = Number(result?.page ?? target);
    const last = Math.max(1, Math.ceil(total.value / PAGE_SIZE));
    if (!rows.value.length && total.value > 0 && page.value > last) {
      await reload(last);
      return;
    }
  } catch (error) {
    toastError("加载任务失败", error);
  } finally {
    loading.value = false;
  }
}

const cancelling = ref("");
/** 任务没有独立的取消句柄：`spawn_worker` 派出去的 worker 运行在父轮次的 abort 信号下，
 *  取消一条任务只能取消其所属的整轮。需先说明清楚，避免误认为只停止了这一个 worker。 */
function cancelTaskTurn(task: TaskRow): void {
  const turnId = String(task.turn_id ?? "");
  if (!turnId) {
    pushToast({
      severity: "warn",
      summary: "这条任务没有关联轮次",
      detail: "没有可取消的对象",
    });
    return;
  }
  askConfirm(
    `取消任务「${String(task.title ?? turnId)}」？`,
    `实际取消的是所属整轮 ${turnId.slice(0, 12)}；同一轮里的其他 worker 也会一并终止。`,
    async () => {
      cancelling.value = turnId;
      try {
        const result = await api<{ cancelled: boolean }>(
          `/api/turns/${encodeURIComponent(turnId)}/cancel`,
          { method: "POST", body: "{}" },
        );
        pushToast(
          result.cancelled
            ? {
                severity: "success",
                summary: "已发出取消信号",
                detail: `轮次 ${turnId.slice(0, 12)}`,
              }
            : {
                severity: "warn",
                summary: "这一轮已结束",
                detail: "任务状态将在下次刷新时同步",
              },
        );
        await reload();
        // 弹窗打开期间该份详情已过期：footer 上「取消整轮」是否显示，读取的正是它的 `state`。
        if (detail.value?.id === task.id) await loadDetail(task.id);
      } catch (error) {
        toastError("取消失败", error);
      } finally {
        cancelling.value = "";
      }
    },
  );
}

/**
 * 只读详情。`progress_json` 与 `result_summary` 两列运行时持续写入，但界面上此前从未展示
 * （docs/21 §8）；列表不发送它们（单帧进度可达数 KB），因此单独获取一次。
 */
interface TaskDetail extends TaskRow {
  placeholder_tg_message_id: number | null;
  /** 已解析的那一份，服务端不再一并发送原始 JSON 串。解析失败时为 `null`。 */
  progress: unknown;
  turn: {
    state: string;
    steps: number;
    toolCalls: number;
    costUsd: number;
    error: string | null;
  } | null;
  agentRun: {
    /** `agent_runs.worker_kind`：`lw` / `harness` / `acp`（迁移 0018）。主 run 不建 `tasks` 行，故必有值。 */
    workerKind: string | null;
    agentName: string;
    modelAlias: string;
    state: string;
    resultSummary: string | null;
  } | null;
}
const detailDialog = ref(false);
const detailLoading = ref(false);
const detail = ref<TaskDetail | null>(null);

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true;
  try {
    detail.value = await api<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    toastError("加载任务详情失败", error);
    detailDialog.value = false;
  } finally {
    detailLoading.value = false;
  }
}
async function openDetail(task: TaskRow): Promise<void> {
  detailDialog.value = true;
  detail.value = null;
  await loadDetail(String(task.id));
}

/** 进度字段既可能是一段字符串，也可能是 `AgentManager` 写入的一个对象。 */
const progressText = computed(() => {
  const value = detail.value?.progress;
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
});
const taskState = (state: string): { label: string; severity: TagSeverity } =>
  TASK_STATES[state] ?? { label: state, severity: "secondary" };

/**
 * 删除的是记录而不是取消通道：删除行不会使该 agent 停止，只会让它变成一条不可见的
 * 在途任务，因此服务端对 `running` 一律返回 409，界面上同样禁用该按钮。
 */
function removeTask(task: TaskDetail): void {
  askConfirm(
    `永久删除任务「${task.title}」？`,
    "只删除这一条任务记录；轮次、worker 运行记录、上下文与已发消息不受影响，无法撤销。",
    async () => {
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
          method: "DELETE",
        });
        pushToast({
          severity: "success",
          summary: `任务「${task.title}」已永久删除`,
          detail: "仅删除了这一条记录",
        });
        detailDialog.value = false;
        await reload();
      } catch (error) {
        if (error instanceof ApiError && error.code === "task_running") {
          pushToast({
            severity: "warn",
            summary: "这条任务仍在运行",
            detail: "删除记录不会终止运行，请先取消所属整轮。",
          });
          return;
        }
        toastError("删除失败", error);
      }
    },
  );
}

onMounted(() => {
  void reload();
});
watch(
  () => props.tick,
  () => {
    void reload();
  },
);
</script>

<template>
  <article class="surface">
    <h3>任务</h3>
    <p class="section-note">
      任务由
      <code>spawn_worker</code>
      派发，生命周期绑定所属轮次。<b>「取消」取消的是整轮</b>：同一轮的其他 worker
      一并终止。点击一行查看详情。
    </p>
    <DataGrid
      class="work-table work-table-tasks"
      :rows="rows"
      :columns="TASK_COLUMNS"
      data-key="id"
      clickable
      :loading="loading"
      empty="暂无"
      @row-click="openDetail"
    >
      <template #state="{ data }"
        ><UiTag
          :value="taskState(data.state).label"
          :severity="taskState(data.state).severity"
      /></template>
      <template #chat="{ data }">
        <span class="work-cell-stack">
          <span>{{ data.chatLabel ?? data.chat_id }}</span>
          <small class="alias-empty">{{ data.userLabel ?? data.user_id }}</small>
        </span>
      </template>
      <template #updated_at="{ data }">
        <time>{{ new Date(Number(data.updated_at)).toLocaleString() }}</time>
      </template>
      <!-- 容器上的 `@click.stop` 是必需的：`DataGrid` 的 row-click 挂在 `<tr>` 上（`DataGrid.vue:43`），
           不 stop 就是「点取消的同时弹出详情框」。先例是 Agent 表那个〔试跑〕（`ConsoleView.vue:2286`），
           它也是 clickable + 行内按钮，也带着 stop。 -->
      <template #actions="{ data }"
        ><div class="section-actions" @click.stop>
          <UiButton
            v-if="data.state === 'running'"
            size="small"
            variant="outlined"
            severity="danger"
            label="取消"
            :loading="cancelling === data.turn_id"
            @click="cancelTaskTurn(data)"
          /></div
      ></template>
    </DataGrid>
    <footer v-if="total" class="grid-pager">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页</span>
      <button
        type="button"
        aria-label="上一页"
        :disabled="page <= 1 || loading"
        @click="reload(page - 1)"
      >
        <i class="pi pi-chevron-left" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="下一页"
        :disabled="page >= pages || loading"
        @click="reload(page + 1)"
      >
        <i class="pi pi-chevron-right" aria-hidden="true" />
      </button>
    </footer>

    <UiModal
      v-model:visible="detailDialog"
      :title="detail ? `任务详情 ${detail.title}` : '任务详情'"
      width="min(1120px, 96vw)"
    >
      <p v-if="detailLoading" class="empty">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在读取任务详情…
      </p>
      <template v-else-if="detail">
        <div class="detail-summary">
          <span
            ><small>状态</small
            ><UiTag
              :value="taskState(detail.state).label"
              :severity="taskState(detail.state).severity"
          /></span>
          <span
            ><small>标题</small><b>{{ detail.title }}</b></span
          >
          <span
            ><small>会话</small
            ><b>{{ detail.chatLabel ?? detail.chat_id }}</b></span
          >
          <span
            ><small>发起人</small
            ><b>{{ detail.userLabel ?? detail.user_id }}</b></span
          >
          <span
            ><small>创建</small
            ><b>{{
              new Date(Number(detail.created_at)).toLocaleString()
            }}</b></span
          >
          <span
            ><small>更新</small
            ><b>{{
              new Date(Number(detail.updated_at)).toLocaleString()
            }}</b></span
          >
          <span
            ><small>结束</small
            ><b>{{
              detail.finished_at
                ? new Date(Number(detail.finished_at)).toLocaleString()
                : "—"
            }}</b></span
          >
          <span
            ><small>耗时</small
            ><b>{{
              detail.finished_at
                ? durationText(
                    Number(detail.finished_at) - Number(detail.created_at),
                  )
                : "未结束"
            }}</b></span
          >
          <span v-if="detail.turn"
            ><small>步数 / 工具</small
            ><b>{{ detail.turn.steps }} · {{ detail.turn.toolCalls }}</b></span
          >
          <span v-if="detail.turn"
            ><small>花费</small
            ><b>${{ Number(detail.turn.costUsd || 0).toFixed(4) }}</b></span
          >
          <span v-if="detail.agentRun"
            ><small>worker</small
            ><code>{{ detail.agentRun.workerKind ?? '—' }} · {{ detail.agentRun.agentName }}</code></span
          >
          <span v-if="detail.agentRun"
            ><small>别名</small
            ><code>{{ detail.agentRun.modelAlias }}</code></span
          >
          <span
            ><small>turn</small><code>{{ detail.turn_id }}</code></span
          >
          <span v-if="detail.agent_run_id"
            ><small>agent run</small
            ><code>{{ detail.agent_run_id }}</code></span
          >
          <span v-if="detail.placeholder_tg_message_id"
            ><small>占位消息</small
            ><code>{{ detail.placeholder_tg_message_id }}</code></span
          >
        </div>
        <p v-if="detail.turn?.error" class="callout error">
          <i class="pi pi-times-circle" aria-hidden="true" />{{
            detail.turn.error
          }}
        </p>
        <div class="detail-payload">
          <!-- **不回退到 `agentRun.resultSummary`。** 成功那一路两列是同一个串：`runSubAgent` 返回的
               正是 `AgentManager.finish()` 的 `summary`（`agent/subagent.ts`），`spawn_worker`
               紧接着把它写进 `tasks.result_summary`（`tools/builtins.ts:406`）。两者真正分岔的只有失败
               那一路 —— 那时 `agent_runs.result_summary` 是 NULL、原因在 `agent_runs.error` 上，而
               `tasks.result_summary` 记着那句错误（`builtins.ts:392/410`、`db/database.ts:65` 的
               `process_restarted` 同理）。所以回退永远轮不到，加了只是暗示一种不存在的分岔。 -->
          <div class="detail-actions">
            <b>结果摘要</b
            ><small class="alias-empty">worker 的返回内容。</small>
          </div>
          <pre v-if="detail.result_summary" v-text="detail.result_summary" />
          <p v-else class="empty">暂无</p>
        </div>
        <div class="detail-payload">
          <div class="detail-actions">
            <b>最后一条进度</b
            ><small class="alias-empty"
              >仅保留最后一帧，任务结束后不再更新。</small
            >
          </div>
          <pre v-if="progressText" v-text="progressText" />
          <p v-else class="empty">暂无</p>
        </div>
      </template>
      <template #footer>
        <UiButton
          variant="outlined"
          severity="danger"
          icon="pi pi-trash"
          label="永久删除"
          :disabled="!detail || detail.state === 'running'"
          @click="removeTask(detail!)"
        />
        <UiButton
          v-if="detail?.state === 'running'"
          severity="danger"
          label="取消整轮"
          :loading="cancelling === detail?.turn_id"
          @click="cancelTaskTurn(detail!)"
        />
        <UiButton
          v-if="detail?.turn_id"
          variant="text"
          icon="pi pi-comments"
          label="查看该轮详情"
          @click="
            detailDialog = false;
            emit('open-turn', detail!.turn_id);
          "
        />
        <UiButton
          v-if="detail?.turn_id"
          variant="outlined"
          icon="pi pi-sitemap"
          label="在日志页查看该 trace"
          @click="
            detailDialog = false;
            emit('open-trace', detail!.turn_id);
          "
        />
        <UiButton variant="text" label="关闭" @click="detailDialog = false" />
      </template>
    </UiModal>
  </article>
</template>
