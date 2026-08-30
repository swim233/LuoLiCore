<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import UiSelect from "../../ui/UiSelect.vue";
import UiModal from "../../ui/UiModal.vue";
import DataGrid from "../../ui/DataGrid.vue";
import { pushToast, toastError } from "../../ui/toast";
import { api } from "../../api/client";
import type { TagSeverity } from "../../ui/types";
import { durationText } from "../tasks/types";
import {
  WORKER_KINDS,
  WORKER_RUN_COLUMNS,
  WORKER_RUN_STATES,
  type WorkerRunDetail,
  type WorkerRunPage,
  type WorkerRunRow,
} from "./types";

/**
 * Worker 运行记录卡（`agent_runs` 里 `worker_kind IS NOT NULL` 的那些）。
 *
 * 分页游标、两个过滤器与 loader 放在一起，不上提到父层：这一页两张卡的端点、游标、busy 态
 * 没有交集，提上去只会重新制造一个争用点（同 `components/tasks/` 那三张卡）。
 *
 * 普通 `<script setup>`，不 `return` 任何东西：上一次把控制台拆成子视图时，子 SFC 的 `setup`
 * 返回了一个只有 `get` 陷阱的 Proxy，14 个页面全部渲染为空白而三条检查仍通过（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number }>();
const emit = defineEmits<{ "open-turn": [string]; "open-trace": [string] }>();

const PAGE_SIZE = 20;
const KIND_OPTIONS = [
  { value: "", label: "全部类型" },
  ...Object.entries(WORKER_KINDS).map(([value, meta]) => ({
    value,
    label: meta.label,
  })),
];
const STATE_OPTIONS = [
  { value: "", label: "全部状态" },
  ...Object.entries(WORKER_RUN_STATES).map(([value, meta]) => ({
    value,
    label: meta.label,
  })),
];

const rows = ref<WorkerRunRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
/** 「读不到」与「一个都没有」必须分得开：请求失败时不能只留一句「暂无」。 */
const loadError = ref("");
const kindFilter = ref("");
const stateFilter = ref("");
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/**
 * 归一化而不是直接赋值：形状不匹配的响应（旧版服务端、代理截断）不应让整页在 `DataGrid` 的
 * `rows` 上崩溃 —— 渲染防线正是为此建立的（docs/24 · R-UI-01）。
 *
 * `reload()` 不把 `page` 复位：SSE 会让列表原地重拉，一并复位意味着翻到第 3 页就被弹回第 1 页。
 */
async function reload(target = page.value): Promise<void> {
  loading.value = true;
  try {
    const query = new URLSearchParams({
      page: String(target),
      size: String(PAGE_SIZE),
    });
    if (kindFilter.value) query.set("workerKind", kindFilter.value);
    if (stateFilter.value) query.set("state", stateFilter.value);
    const result = await api<Partial<WorkerRunPage>>(
      `/api/worker-runs?${query.toString()}`,
    );
    rows.value = Array.isArray(result?.items) ? result.items : [];
    total.value = Number(result?.total ?? 0);
    page.value = Number(result?.page ?? target);
    loadError.value = "";
    const last = Math.max(1, Math.ceil(total.value / PAGE_SIZE));
    if (!rows.value.length && total.value > 0 && page.value > last) {
      await reload(last);
      return;
    }
  } catch (error) {
    rows.value = [];
    total.value = 0;
    loadError.value = error instanceof Error ? error.message : String(error);
    toastError("加载 worker 运行记录失败", error);
  } finally {
    loading.value = false;
  }
}
/** 换过滤器回到第 1 页：留在第 3 页上换筛选条件，绝大多数时候得到的是一页空列表。 */
function applyFilters(): void {
  void reload(1);
}

const detailDialog = ref(false);
const detailLoading = ref(false);
const detail = ref<WorkerRunDetail | null>(null);
async function openDetail(run: WorkerRunRow): Promise<void> {
  detailDialog.value = true;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await api<WorkerRunDetail>(
      `/api/worker-runs/${encodeURIComponent(String(run.id))}`,
    );
  } catch (error) {
    toastError("加载运行详情失败", error);
    detailDialog.value = false;
  } finally {
    detailLoading.value = false;
  }
}

const kindOf = (
  kind: string,
): { label: string; severity: TagSeverity; hint: string } =>
  WORKER_KINDS[kind] ?? { label: kind, severity: "secondary", hint: "" };
const stateOf = (state: string): { label: string; severity: TagSeverity } =>
  WORKER_RUN_STATES[state] ?? { label: state, severity: "secondary" };
const money = (value: number | null | undefined): string =>
  `$${Number(value ?? 0).toFixed(4)}`;
const elapsed = (run: { startedAt: number; finishedAt: number | null }): string =>
  run.finishedAt
    ? durationText(Number(run.finishedAt) - Number(run.startedAt))
    : "未结束";
/** 原样 JSON，缩进后渲染；解析不了就照原串显示（那一列由外部 agent 写入，不保证形状）。 */
const externalUsageText = computed(() => {
  const raw = detail.value?.externalUsageJson;
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
async function copyExternalUsage(): Promise<void> {
  try {
    await navigator.clipboard.writeText(externalUsageText.value);
    pushToast({ severity: "success", summary: "已复制 JSON" });
  } catch (error) {
    toastError("复制失败", error);
  }
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
    <h3>运行记录</h3>
    <p class="section-note">
      三档 worker 的运行记录，取自
      <code>agent_runs</code>。点击一行查看任务正文、结果与外部用量。<b>这里没有取消</b>：worker
      跑在父轮的 abort 信号下，没有独立句柄，要停只能在总览页取消它所属的整轮。
    </p>
    <div class="section-actions">
      <UiSelect
        v-model="kindFilter"
        :options="KIND_OPTIONS"
        option-label="label"
        option-value="value"
        aria-label="worker 类型"
        @change="applyFilters"
      />
      <UiSelect
        v-model="stateFilter"
        :options="STATE_OPTIONS"
        option-label="label"
        option-value="value"
        aria-label="运行状态"
        @change="applyFilters"
      />
    </div>
    <p v-if="loadError" class="callout error">
      <i class="pi pi-times-circle" aria-hidden="true" />读不到 worker
      运行记录：{{ loadError }}
    </p>
    <DataGrid
      :rows="rows"
      :columns="WORKER_RUN_COLUMNS"
      data-key="id"
      clickable
      :loading="loading"
      empty="暂无"
      @row-click="openDetail"
    >
      <template #workerKind="{ data }"
        ><UiTag
          :value="kindOf(data.workerKind).label"
          :severity="kindOf(data.workerKind).severity"
          :title="kindOf(data.workerKind).hint"
      /></template>
      <template #state="{ data }"
        ><UiTag
          :value="stateOf(data.state).label"
          :severity="stateOf(data.state).severity"
      /></template>
      <template #taskLine="{ data }"
        ><span>{{ data.taskLine || "—" }}</span
        ><small class="alias-empty">{{ data.modelAlias }}</small></template
      >
      <!-- 行内按钮上的 `@click.stop` 是必需的：`DataGrid` 的 row-click 挂在 `<tr>` 上，
           不 stop 就是「点跳转的同时弹出详情框」。 -->
      <template #turnId="{ data }"
        ><UiButton
          size="small"
          variant="text"
          :label="String(data.turnId).slice(0, 10)"
          :title="data.turnId"
          @click.stop="emit('open-turn', String(data.turnId))"
      /></template>
      <template #steps="{ data }"
        >{{ data.steps }} · {{ data.toolCalls }}</template
      >
      <template #cost="{ data }">{{ money(data.costUsd) }}</template>
      <!-- ACP 那档单独一格，且**绝不与 costUsd 相加**：那个数是外部 agent 自报的，口径由它定、
           我们无法核对，结构上被挡在每一个聚合之外（迁移 0014）。合并显示就是邀请人把两者相加。 -->
      <template #externalCost="{ data }"
        ><span v-if="data.externalCostUsd !== null">{{
          money(data.externalCostUsd)
        }}</span
        ><small v-else class="alias-empty">—</small></template
      >
      <template #elapsed="{ data }">{{ elapsed(data) }}</template>
      <template #startedAt="{ data }">{{
        new Date(Number(data.startedAt)).toLocaleString()
      }}</template>
    </DataGrid>
    <p class="field-note">
      「外部自报」是外部 agent 自己报的花费，未经核对，不进任何聚合，也不与「花费」相加。
      <code>—</code> 表示它一次都没报过，与报了 0 是两回事。
    </p>
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
      :title="detail ? `运行详情 ${detail.id}` : '运行详情'"
      width="min(1120px, 96vw)"
    >
      <p v-if="detailLoading" class="empty">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" /> 正在读取运行详情…
      </p>
      <template v-else-if="detail">
        <div class="detail-summary">
          <span
            ><small>类型</small
            ><UiTag
              :value="kindOf(detail.workerKind).label"
              :severity="kindOf(detail.workerKind).severity"
          /></span>
          <span
            ><small>状态</small
            ><UiTag
              :value="stateOf(detail.state).label"
              :severity="stateOf(detail.state).severity"
          /></span>
          <span
            ><small>名称</small><code>{{ detail.agentName }}</code></span
          >
          <span
            ><small>模型别名</small><code>{{ detail.modelAlias }}</code></span
          >
          <span v-if="detail.modelId"
            ><small>模型</small><code>{{ detail.modelId }}</code></span
          >
          <span
            ><small>有效角色</small><b>{{ detail.effectiveRole }}</b></span
          >
          <span
            ><small>会话</small
            ><b>{{ detail.chatLabel ?? detail.turn?.chatId ?? "—" }}</b></span
          >
          <span
            ><small>步数 / 工具</small
            ><b>{{ detail.steps }} · {{ detail.toolCalls }}</b></span
          >
          <span
            ><small>token</small
            ><b
              >{{ detail.inputTokens.toLocaleString() }} /
              {{ detail.outputTokens.toLocaleString() }}</b
            ></span
          >
          <span
            ><small>花费</small><b>{{ money(detail.costUsd) }}</b></span
          >
          <!-- 单独一格，且与上面那格互不相加。旁边这句必须在：读的人要能看出这个数字的出处
               不是本系统，也不参与任何聚合（docs/21 · G-API-25 的后半条）。 -->
          <span
            ><small>外部自报</small
            ><b>{{
              detail.externalCostUsd === null
                ? "—"
                : money(detail.externalCostUsd)
            }}</b>
            <small class="alias-empty"
              >外部 agent 自报，未经核对，不进任何聚合，不与「花费」相加</small
            ></span
          >
          <span
            ><small>开始</small
            ><b>{{
              new Date(Number(detail.startedAt)).toLocaleString()
            }}</b></span
          >
          <span
            ><small>耗时</small><b>{{ elapsed(detail) }}</b></span
          >
          <span
            ><small>turn</small><code>{{ detail.turnId }}</code></span
          >
          <span v-if="detail.parentRunId"
            ><small>父 run</small><code>{{ detail.parentRunId }}</code></span
          >
          <span v-if="detail.resultFullRef"
            ><small>结果全文</small
            ><code>{{ detail.resultFullRef }}</code></span
          >
        </div>
        <p v-if="detail.error" class="callout error">
          <i class="pi pi-times-circle" aria-hidden="true" />{{ detail.error }}
        </p>
        <div class="detail-payload">
          <div class="detail-actions"><b>任务正文</b></div>
          <pre v-if="detail.taskInput" v-text="detail.taskInput" />
          <p v-else class="empty">暂无</p>
        </div>
        <div class="detail-payload">
          <div class="detail-actions">
            <b>结果摘要</b
            ><small class="alias-empty"
              >失败时这一列为空，原因在上方的错误条里。</small
            >
          </div>
          <pre v-if="detail.resultSummary" v-text="detail.resultSummary" />
          <p v-else class="empty">暂无</p>
        </div>
        <div class="detail-payload">
          <div class="detail-actions">
            <b>外部用量</b
            ><small class="alias-empty"
              >外部 agent 自描述的原始载荷，本系统不解释其口径。</small
            ><UiButton
              size="small"
              variant="text"
              icon="pi pi-copy"
              label="复制 JSON"
              :disabled="!externalUsageText"
              @click="copyExternalUsage"
            />
          </div>
          <pre v-if="externalUsageText" v-text="externalUsageText" />
          <p v-else class="empty">暂无</p>
        </div>
      </template>
      <template #footer>
        <UiButton
          v-if="detail?.turnId"
          variant="text"
          icon="pi pi-comments"
          label="查看该轮详情"
          @click="
            detailDialog = false;
            emit('open-turn', detail!.turnId);
          "
        />
        <UiButton
          v-if="detail?.turnId"
          variant="outlined"
          icon="pi pi-sitemap"
          label="在日志页查看该 trace"
          @click="
            detailDialog = false;
            emit('open-trace', detail!.turnId);
          "
        />
        <UiButton variant="text" label="关闭" @click="detailDialog = false" />
      </template>
    </UiModal>
  </article>
</template>
