<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import UiSelect from "../../ui/UiSelect.vue";
import UiCheckbox from "../../ui/UiCheckbox.vue";
import { pushToast, toastError } from "../../ui/toast";
import { api, apiStream } from "../../api/client";
import type { WorkerDryRunEvent } from "./types";

/**
 * lw-worker 试跑面板（`POST /api/workers/dryrun`）。
 *
 * 从「子 Agent」页整段搬过来，去掉了 `:name` —— 定义体系已删，worker 只有一种。价值不在
 * 「试跑某份定义」，而在这是唯一能不开一条真轮次、用真模型真工具跑一遍、并逐步看到
 * step / usage / 工具输入输出的入口，而 worker 是重构后唯一执行工具的一档。
 *
 * 别名与工具名自己拉，不从父层接 props：这一页两张卡各管各的端点（同 `components/tasks/`）。
 */
interface ToolRow {
  enabled: boolean;
  sides?: Array<"main" | "worker">;
}

const task = ref("");
const modelAlias = ref("");
const picked = ref<string[]>([]);
const events = ref<WorkerDryRunEvent[]>([]);
const running = ref(false);
const abort = ref<AbortController | null>(null);
const aliases = ref<string[]>([]);
const tools = ref<Array<{ name: string; enabled: boolean }>>([]);

const cost = computed(() =>
  events.value.reduce(
    (sum, event) => sum + (event.type === "usage" ? event.costUsd : 0),
    0,
  ),
);
const steps = computed(
  () => events.value.filter((event) => event.type === "step").length,
);

/**
 * 工具清单只列 worker 侧够得着的那些：`sides` 由服务端按运行时判据 `toolCallableBy()` 现算，
 * 前端不再判一遍谁能用什么。缺 `sides` 的响应（旧版服务端）一律照单全收，宁可多列也不少列 ——
 * 少列的表现是「界面上根本勾不到某个工具」，比多列一条难查得多。
 */
async function loadOptions(): Promise<void> {
  try {
    const [aliasRows, toolMap] = await Promise.all([
      api<Array<{ alias: string }>>("/api/aliases"),
      api<Record<string, ToolRow>>("/api/tools"),
    ]);
    aliases.value = (Array.isArray(aliasRows) ? aliasRows : []).map((row) =>
      String(row.alias),
    );
    tools.value = Object.entries(toolMap ?? {})
      .filter(([, row]) => !row.sides || row.sides.includes("worker"))
      .map(([name, row]) => ({ name, enabled: row.enabled !== false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    toastError("加载试跑选项失败", error);
  }
}
function toggleTool(name: string): void {
  picked.value = picked.value.includes(name)
    ? picked.value.filter((entry) => entry !== name)
    : [...picked.value, name];
}

async function run(): Promise<void> {
  const text = task.value.trim();
  if (!text) {
    pushToast({ severity: "warn", summary: "请填写试跑任务" });
    return;
  }
  abort.value?.abort();
  const controller = new AbortController();
  abort.value = controller;
  events.value = [];
  running.value = true;
  try {
    await apiStream<WorkerDryRunEvent>(
      "/api/workers/dryrun",
      {
        method: "POST",
        body: JSON.stringify({
          task: text,
          ...(picked.value.length ? { tools: picked.value } : {}),
          ...(modelAlias.value ? { modelAlias: modelAlias.value } : {}),
        }),
        signal: controller.signal,
      },
      (event) => {
        events.value = [...events.value, event];
      },
    );
    const failure = events.value.find((event) => event.type === "error");
    if (failure?.type === "error")
      pushToast({
        severity: "error",
        summary: "试跑失败",
        detail: failure.message,
        life: 9000,
      });
  } catch (error) {
    if (!controller.signal.aborted) toastError("试跑失败", error);
  } finally {
    if (abort.value === controller) abort.value = null;
    running.value = false;
  }
}
function cancel(): void {
  abort.value?.abort();
}

onMounted(() => {
  void loadOptions();
});
</script>

<template>
  <article class="surface">
    <h3>试跑</h3>
    <p class="section-note">
      派一个 lw-worker 跑一次给定任务，逐步显示每一步的正文、工具输入输出与用量。
    </p>
    <div class="form-grid">
      <label class="wide"
        >任务<textarea
          v-model="task"
          rows="5"
          :disabled="running"
          placeholder="这次试跑要完成的具体任务"
      /></label>
      <label
        >模型别名<UiSelect
          v-model="modelAlias"
          :options="[{ value: '', label: '按配置取默认' }, ...aliases.map((alias) => ({ value: alias, label: alias }))]"
          option-label="label"
          option-value="value"
          aria-label="模型别名"
      /></label>
      <div class="wide">
        <p class="field-title">
          限定工具<small
            >一个都不勾 = 该角色下的全集。此处只列 worker 侧够得着的工具。</small
          >
        </p>
        <div class="tool-picker">
          <UiCheckbox
            v-for="row in tools"
            :key="row.name"
            :class="{ off: !row.enabled }"
            :model-value="picked.includes(row.name)"
            @change="toggleTool(row.name)"
          >
            <code>{{ row.name }}</code
            ><small v-if="!row.enabled">已停用</small>
          </UiCheckbox>
        </div>
      </div>
    </div>
    <p class="callout warn">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />试跑调用真实模型与真实工具，产生实际费用与副作用；结果只写
      <code>agent_runs</code> 与用量流水，不进入会话上下文。
    </p>
    <div class="section-actions">
      <UiButton
        v-if="running"
        severity="danger"
        variant="outlined"
        label="取消试跑"
        @click="cancel"
      />
      <UiButton
        label="开始试跑"
        icon="pi pi-play"
        :loading="running"
        :disabled="!task.trim()"
        @click="run"
      />
    </div>
    <div v-if="events.length" class="dryrun-summary">
      <b>${{ cost.toFixed(4) }}</b><span>{{ steps }} 步</span>
    </div>
    <ol class="dryrun-events">
      <li v-for="(event, index) in events" :key="index" :class="event.type">
        <template v-if="event.type === 'step'"
          ><header>
            <UiTag :value="`步骤 ${event.step}`" severity="info" /><code>{{
              event.finishReason
            }}</code></header
          ><pre v-if="event.text" v-text="event.text" /><pre
            v-if="event.toolCalls.length"
            v-text="
              JSON.stringify(
                { toolCalls: event.toolCalls, toolResults: event.toolResults },
                null,
                2,
              )
            "
        /></template>
        <template v-else-if="event.type === 'usage'"
          ><header>
            <UiTag :value="`用量 ${event.step}`" severity="secondary" /><span
              >{{ event.inputTokens }}/{{ event.outputTokens }} tok · ${{
                event.costUsd.toFixed(4)
              }}</span
            >
          </header></template
        >
        <template v-else-if="event.type === 'final'"
          ><header>
            <UiTag value="完成" severity="success" /><code>{{
              event.fullRef
            }}</code></header
          ><pre v-text="event.summary"
        /></template>
        <template v-else
          ><header>
            <UiTag value="失败" severity="danger" /><span>{{
              event.message
            }}</span>
          </header></template
        >
      </li>
      <li v-if="running" class="empty">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" /> Worker 运行中…
      </li>
    </ol>
  </article>
</template>
