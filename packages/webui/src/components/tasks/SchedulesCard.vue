<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import UiSelect from "../../ui/UiSelect.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import UiModal from "../../ui/UiModal.vue";
import DataGrid from "../../ui/DataGrid.vue";
import { pushToast, toastError } from "../../ui/toast";
import { askConfirm } from "../../ui/confirm";
import { api } from "../../api/client";
import {
  SCHEDULE_COLUMNS,
  SCHEDULE_RUN_STATES,
  SCHEDULE_STATES,
  WALL_CLOCK_RE,
  toWallClock,
  type ChatOption,
  type ScheduleJob,
  type ScheduleList,
} from "./types";

/**
 * 定时任务卡（docs/21 · G-API-16）。
 *
 * `GET /api/schedules` 不分页：行数有界，DataGrid 在客户端切片。触及 `listAll` 上限时
 * 信封里的 `truncated` 为真，该情况必须提示，不做静默截断。
 *
 * 普通 `<script setup>`，不 `return` 任何东西（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number; chats: ChatOption[] }>();

/**
 * 连续静默达到该次数后日志升级为 warn。与服务端 `runner.ts` 的 `SILENT_STREAK_WARN` 同为 10，
 * 这里写字面量而不是 import：webui 不依赖 core，修改那边的常量时需同步这一行。
 * 一条持续消耗配额却不产出投递的定时任务，在界面上的唯一痕迹就是它。
 */
const SILENT_STREAK_WARN = 10;
const MODE_OPTIONS = [
  { value: "notify", label: "notify · 只发预写文本" },
  { value: "agent", label: "agent · 一轮完整对话（产生费用）" },
];

/** 编辑态下这四格只读，每一格都需说明原因，见模板中各自的 `field-note`。 */
interface ScheduleForm {
  isNew: boolean;
  id: string;
  originalName: string;
  key: string;
  name: string;
  mode: "agent" | "notify";
  trigger: "cron" | "at";
  cron: string;
  at: string;
  text: string;
  silent: boolean;
  chatLabel: string;
  creatorLabel: string;
  timezone: string;
  state: string;
}
const BLANK: ScheduleForm = {
  isNew: true,
  id: "",
  originalName: "",
  key: "",
  name: "",
  mode: "notify",
  trigger: "cron",
  cron: "0 8 * * *",
  at: "",
  text: "",
  silent: false,
  chatLabel: "",
  creatorLabel: "",
  timezone: "",
  state: "active",
};

const schedules = ref<ScheduleList>({
  available: true,
  enabled: true,
  timezone: "",
  jobs: [],
});
const scheduleBusy = ref("");
const scheduleDialog = ref(false);
const scheduleSaving = ref(false);
const scheduleForm = ref<ScheduleForm>({ ...BLANK });
/** 编辑前该行的原始值。`PATCH` 只发送改动过的字段：全部发送会导致仅修改正文时也重新校验 cron，
 *  运维把 `minIntervalMinutes` 从 5 调到 60 之后该任务将无法再保存。 */
const scheduleOriginal = ref<ScheduleJob | null>(null);

/** 已停用的任务即使修改也不会再触发，因此表单整体只读，出口只保留 footer 的删除。 */
const editable = computed(
  () => scheduleForm.value.isNew || scheduleForm.value.state === "active",
);

// 归一化而不是直接赋值：形状不匹配的响应（旧版服务端、代理截断）不应使整页在
// DataGrid 的 rows 上崩溃。渲染防线正是为此建立的（docs/24 · R-UI-01）。
async function reload(): Promise<void> {
  const next = await api<Partial<ScheduleList>>("/api/schedules");
  schedules.value = {
    available: Boolean(next?.available) && Array.isArray(next?.jobs),
    enabled: Boolean(next?.enabled),
    timezone: next?.timezone ?? "",
    jobs: Array.isArray(next?.jobs) ? next.jobs : [],
    ...(next?.settings ? { settings: next.settings } : {}),
    ...(typeof next?.total === "number" ? { total: next.total } : {}),
    ...(next?.truncated ? { truncated: true } : {}),
  };
}
/** 未装配运行时的部署返回 `available:false`，界面据此给出说明而不是显示零条任务，因此这里吞掉失败。 */
const refresh = (): void => {
  void reload().catch(() => undefined);
};

function openScheduleDialog(): void {
  scheduleOriginal.value = null;
  scheduleForm.value = {
    ...BLANK,
    key: props.chats[0]?.key ?? "",
    timezone: schedules.value.timezone,
  };
  scheduleDialog.value = true;
}
/**
 * 编辑。`at` 必须经 `toWallClock` 转换：`scheduledJobView` 发送的是 `toISOString()` 的 UTC 瞬时，
 * 而该输入框接收的是行上时区的墙钟。直接回填 ISO 时，`Asia/Shanghai` 上一个早八点的任务
 * 会显示为 `…T00:00:00.000Z`，用户顺手改成 `08:00` 再保存，任务被静默推后 8 小时，两次操作均不报错。
 */
function editSchedule(job: ScheduleJob): void {
  scheduleOriginal.value = job;
  scheduleForm.value = {
    isNew: false,
    id: job.id,
    originalName: job.name,
    key: job.key,
    name: job.name,
    mode: job.mode,
    trigger: job.cron ? "cron" : "at",
    cron: job.cron ?? "",
    at: toWallClock(job.at, job.timezone),
    text: job.payload,
    silent: job.silent === true,
    chatLabel: job.chatLabel ?? job.chatId,
    creatorLabel: job.creatorLabel ?? job.createdBy,
    timezone: job.timezone,
    state: job.state,
  };
  scheduleDialog.value = true;
}
// notify 不调用模型，没有调用方能触发 `stay_silent`，切换时一并归零该开关，避免存入一个运行时不读的真值。
watch(
  () => scheduleForm.value.mode,
  (mode) => {
    if (mode === "notify") scheduleForm.value.silent = false;
  },
);

/** 只把改动过的字段放入 `PATCH`。触发方式切换（cron ↔ at）时该项必须发送，另一列由服务端置 NULL。 */
function patchFor(form: ScheduleForm): Record<string, unknown> {
  const before = scheduleOriginal.value;
  const patch: Record<string, unknown> = {};
  if (!before) return patch;
  if (form.name !== before.name) patch.name = form.name;
  if (form.text !== before.payload) patch.text = form.text;
  if (form.silent !== (before.silent === true)) patch.silent = form.silent;
  const wasCron = Boolean(before.cron);
  if (form.trigger === "cron") {
    if (!wasCron || form.cron !== before.cron) patch.cron = form.cron;
  } else if (wasCron || form.at !== toWallClock(before.at, before.timezone))
    patch.at = form.at;
  return patch;
}
/**
 * 只做格式校验：非空与墙钟形状。`interval_too_short` / `at_in_the_past` / `too_many_jobs` /
 * `duplicate_name` / `invalid_cron` 一律由服务端返回。建与改的校验只有一份，一旦在此复制第二份，
 * WebUI 就能创建出工具无法创建的任务。cron 在这里不解析。
 */
function formatComplaint(
  body: Record<string, unknown>,
): { summary: string; detail: string } | null {
  if ("name" in body && !String(body.name).trim())
    return {
      summary: "任务名不能为空",
      detail: "同一会话内唯一，取消时按名字指定",
    };
  if ("text" in body && !String(body.text).trim())
    return { summary: "正文不能为空", detail: "任务触发时使用这段正文" };
  if ("cron" in body && !String(body.cron).trim())
    return {
      summary: "cron 表达式不能为空",
      detail: "合法性由服务端校验",
    };
  if ("at" in body && !WALL_CLOCK_RE.test(String(body.at)))
    return {
      summary: "时间格式无效",
      detail: "格式为 2026-08-19T08:00",
    };
  return null;
}
async function submitSchedule(): Promise<void> {
  const form = scheduleForm.value;
  if (form.isNew && !form.key) {
    pushToast({
      severity: "warn",
      summary: "请先选择会话",
      detail: "任务只能绑定已有上下文的会话",
    });
    return;
  }
  // `key` / `chatId` / `mode` / `createdBy` 只在新建时出现在 body 中，`PATCH` 一个都不接收。
  const body: Record<string, unknown> = form.isNew
    ? {
        key: form.key,
        name: form.name,
        mode: form.mode,
        text: form.text,
        silent: form.silent,
        ...(form.trigger === "cron" ? { cron: form.cron } : { at: form.at }),
      }
    : patchFor(form);
  const complaint = formatComplaint(body);
  if (complaint) {
    pushToast({ severity: "warn", ...complaint });
    return;
  }
  scheduleSaving.value = true;
  try {
    const path = form.isNew
      ? "/api/schedules"
      : `/api/schedules/${encodeURIComponent(form.id)}`;
    const saved = await api<ScheduleJob>(path, {
      method: form.isNew ? "POST" : "PATCH",
      body: JSON.stringify(body),
    });
    pushToast({
      severity: "success",
      summary: form.isNew
        ? `已创建「${saved.name}」`
        : `已保存「${saved.name}」`,
      detail: saved.nextRun
        ? `下一次：${new Date(saved.nextRun).toLocaleString()}`
        : form.isNew
          ? "已建立"
          : "不再触发",
    });
    scheduleDialog.value = false;
    await reload();
  } catch (error) {
    toastError(form.isNew ? "创建定时任务失败" : "保存定时任务失败", error);
  } finally {
    scheduleSaving.value = false;
  }
}
function cancelSchedule(job: ScheduleJob): void {
  askConfirm(
    `停掉「${job.name}」？`,
    "不再触发；任务行按 schedule.retentionDays 保留，可重建同名任务。",
    async () => {
      scheduleBusy.value = job.id;
      try {
        const result = await api<{ cancelled: boolean }>(
          `/api/schedules/${encodeURIComponent(job.id)}`,
          { method: "DELETE" },
        );
        pushToast(
          result.cancelled
            ? {
                severity: "success",
                summary: `已停用「${job.name}」`,
                detail: "已从调度器移除",
              }
            : {
                severity: "warn",
                summary: "这条任务已处于停用状态",
                detail: "状态将在下次刷新时同步",
              },
        );
        await reload();
      } catch (error) {
        toastError("停用失败", error);
      } finally {
        scheduleBusy.value = "";
      }
    },
  );
}
/**
 * 硬删。入口只在弹窗 footer 最左侧：与行内的「停掉」并排放两个红色按钮极易误点，而两者语义相差很大，
 * 停用后行仍保留、历史仍可查看，删除则连同整行与运行历史一并移除。
 */
function purgeSchedule(): void {
  const { id, originalName } = scheduleForm.value;
  // 保持该弹窗打开状态下确认：确认框与它都 Teleport 到 body 且同属 `.ui-overlay`，`ConfirmHost` 在
  // `App.vue` 中先挂载因此锚点在前，层级由 `styles.css` 中的 `:has(.confirm-detail)` 解决，
  // 而不是先关闭该弹窗绕开。关闭之后用户就无法看到自己要删除的是哪一条。
  askConfirm(
    `永久删除「${originalName}」？`,
    "任务与运行历史一并删除，schedule_list 不再列出。「停掉」仅停触发、记录仍在。",
    async () => {
      try {
        await api<{ removed: boolean }>(
          `/api/schedules/${encodeURIComponent(id)}/purge`,
          { method: "POST", body: "{}" },
        );
        pushToast({
          severity: "success",
          summary: `已永久删除「${originalName}」`,
        });
        // 删除成功后才关闭：失败时保留该弹窗，用户可以重试或改为执行停用（与 TasksCard 的删除一致）。
        scheduleDialog.value = false;
        await reload();
      } catch (error) {
        toastError("删除定时任务失败", error);
      }
    },
  );
}
/** 立即触发。代价必须写在确认框中：agent 模式下点击一次即为一次真实模型调用，且会实际发出消息。 */
function triggerSchedule(job: ScheduleJob): void {
  const cost =
    job.mode === "agent"
      ? "立即执行一轮真实模型调用（产生费用）"
      : "立即发送一条消息";
  askConfirm(
    `立即触发「${job.name}」？`,
    `${cost}，目标会话「${job.chatLabel ?? job.chatId}」。不影响下一次触发。`,
    async () => {
      scheduleBusy.value = job.id;
      try {
        await api<{ started: boolean }>(
          `/api/schedules/${encodeURIComponent(job.id)}/trigger`,
          { method: "POST", body: "{}" },
        );
        // 不等待执行完成：agent 模式一次触发为一整轮，结果反映在该行的「上一次」列。
        pushToast({
          severity: "success",
          summary: `已触发「${job.name}」`,
          detail: "不等待完成；结果见本行「上一次」或日志页。",
        });
        await reload();
      } catch (error) {
        toastError("触发失败", error);
      } finally {
        scheduleBusy.value = "";
      }
    },
  );
}

onMounted(refresh);
watch(() => props.tick, refresh);
</script>

<template>
  <article class="surface">
    <div class="registry-heading">
      <div>
        <h3>定时任务</h3>
        <p class="section-note">
          周期 / 一次性任务，由
          <code>schedule_create</code>
          或在此处创建。触发时<b>开启一条完整轮次</b>并提交；<code>notify</code>
          模式只发预写文本。错过的触发<b>不补跑</b>，仅记一条
          <code>schedule.missed</code>。
        </p>
      </div>
      <UiButton
        icon="pi pi-plus"
        label="新建定时任务"
        :disabled="!schedules.available || !schedules.enabled || !chats.length"
        :title="chats.length ? '' : '还没有任何会话上下文'"
        @click="openScheduleDialog()"
      />
    </div>
    <p v-if="!schedules.available" class="callout warn">
      <i
        class="pi pi-exclamation-triangle"
        aria-hidden="true"
      />未装配定时任务运行时，列表不可读取（<b>而非任务数为零</b>）。
    </p>
    <p v-else-if="!schedules.enabled" class="callout warn">
      <i class="pi pi-pause" aria-hidden="true" /><code>schedule.enabled</code>
      已关闭：任务保留但不触发，每次跳过记一条
      <code>schedule.skipped</code>。
    </p>
    <p v-else-if="!chats.length" class="callout warn">
      <i
        class="pi pi-info-circle"
        aria-hidden="true"
      />还没有任何会话上下文。任务须绑定 bot 至少响应过一次的会话。
    </p>
    <DataGrid
      class="work-table work-table-schedules"
      :rows="schedules.jobs"
      :columns="SCHEDULE_COLUMNS"
      data-key="id"
      paginate
      empty="暂无"
    >
      <template #name="{ data }">
        <div class="work-cell-stack">
          <div class="alias-name">
          <b>{{ data.name }}</b>
          </div>
          <small class="hit-text">{{ data.payload }}</small>
        </div>
      </template>
      <template #chatLabel="{ data }">
        <span class="work-cell-stack">
          <span>{{ data.chatLabel ?? data.chatId }}</span>
          <small class="alias-empty">创建者 {{ data.creatorLabel ?? data.createdBy }}</small>
        </span>
      </template>
      <template #mode="{ data }">
        <span class="work-cell-tags">
          <UiTag
            :value="data.mode"
            :severity="data.mode === 'agent' ? 'warn' : 'secondary'"
            :title="
              data.mode === 'agent'
                ? '每次触发一轮真实模型调用'
                : '只发预写文本，不调模型'
            "
          />
          <UiTag
            v-if="data.silent"
            value="静默"
            severity="secondary"
            title="无内容可发时不投递，正文仍进上下文"
          />
        </span>
      </template>
      <template #trigger="{ data }">
        <span class="work-cell-stack">
          <code v-if="data.cron">{{ data.cron }}</code>
          <span v-else>{{ new Date(data.at).toLocaleString() }}</span>
          <small class="alias-empty">{{ data.timezone }}{{ data.cron ? "" : " · 一次性" }}</small>
        </span>
      </template>
      <template #nextRun="{ data }">
        <span class="work-cell-stack">
          <span v-if="data.nextRun">{{ new Date(data.nextRun).toLocaleString() }}</span>
          <small v-else class="alias-empty">不再触发</small>
        </span>
      </template>
      <template #last="{ data }">
        <span class="work-cell-stack">
          <template v-if="data.lastRunAt">
            <UiTag
              :value="
                (
                  SCHEDULE_RUN_STATES[data.lastState ?? ''] ?? {
                    label: data.lastState ?? '—',
                  }
                ).label
              "
              :severity="
                (
                  SCHEDULE_RUN_STATES[data.lastState ?? ''] ?? {
                    severity: 'secondary',
                  }
                ).severity
              "
            />
            <small class="alias-empty"
              >{{ new Date(data.lastRunAt).toLocaleString() }} · 共
              {{ data.runCount }} 次</small
            >
            <small v-if="data.lastError" class="detail-truncated">{{
              data.lastError
            }}</small>
          </template>
          <small v-else class="alias-empty">尚未执行过</small>
          <!-- 连续静默：这条任务可能已经变成一台只烧钱不说话的定时器，界面上要一直说着。 -->
          <small
            v-if="(data.silentStreak ?? 0) >= SILENT_STREAK_WARN"
            class="detail-truncated"
            >已连续 {{ data.silentStreak }} 次未发出消息</small
          >
        </span>
      </template>
      <template #state="{ data }"
        ><UiTag
          :value="(SCHEDULE_STATES[data.state] ?? { label: data.state }).label"
          :severity="
            (SCHEDULE_STATES[data.state] ?? { severity: 'secondary' }).severity
          "
      /></template>
      <!-- 这张表不设 `clickable`：一行里三个按钮，行点击必然误触。容器 `@click.stop` 是第二道。 -->
      <template #actions="{ data }">
        <div class="section-actions" @click.stop>
          <template v-if="data.state === 'active'">
            <UiButton
              size="small"
              variant="outlined"
              icon="pi pi-play"
              label="立即触发"
              :loading="scheduleBusy === data.id"
              @click="triggerSchedule(data)"
            />
            <UiButton
              size="small"
              variant="outlined"
              severity="danger"
              label="停掉"
              :loading="scheduleBusy === data.id"
              @click="cancelSchedule(data)"
            />
          </template>
          <UiButton
            size="small"
            variant="outlined"
            label="编辑"
            @click="editSchedule(data)"
          />
        </div>
      </template>
    </DataGrid>
    <!-- 表尾，且**不进上面那条 v-else-if 链**（docs/09 §3.10.1）：撞上限这件事与「没装配 / 总开关关着 /
         一个会话都没有」互相独立，串成一条链等于让前面任何一句把它吃掉，那就又变回静默截断了。 -->
    <p v-if="schedules.truncated" class="callout warn">
      <i
        class="pi pi-exclamation-triangle"
        aria-hidden="true"
      />超出上限，仅列出前 {{ schedules.jobs.length }} 条，另有
      {{ Math.max(0, (schedules.total ?? 0) - schedules.jobs.length) }}
      条未显示。
    </p>

    <UiModal
      v-model:visible="scheduleDialog"
      :title="
        scheduleForm.isNew
          ? '新建定时任务'
          : `定时任务 ${scheduleForm.originalName}`
      "
      width="min(680px, 94vw)"
    >
      <div class="form-grid">
        <p v-if="!editable" class="callout warn wide">
          <i
            class="pi pi-ban"
            aria-hidden="true"
          />已停用，修改不会使其重新触发。仅可查看或永久删除。
        </p>
        <p v-if="scheduleForm.isNew" class="wide field-note">
          任务归属
          <b>owner</b>（<code>access.bootstrapOwnerId</code>）。触发时按有效角色重算。
        </p>
        <label
          >会话
          <UiSelect
            v-if="scheduleForm.isNew"
            v-model="scheduleForm.key"
            data-field="chat"
            :options="
              chats.map((chat) => ({ value: chat.key, label: chat.key }))
            "
          />
          <template v-else>
            <input data-field="chat" :value="scheduleForm.chatLabel" disabled />
            <small class="field-note"
              >隔离锚点，创建后不可更改；换会话请另建任务。</small
            >
          </template>
        </label>
        <label
          >任务名<input
            v-model="scheduleForm.name"
            data-field="name"
            :disabled="!editable"
            maxlength="64"
            placeholder="同一会话内唯一，取消时按名字指定"
        /></label>
        <label
          >模式
          <UiSelect
            v-model="scheduleForm.mode"
            data-field="mode"
            :disabled="!scheduleForm.isNew"
            :options="MODE_OPTIONS"
          />
          <small v-if="!scheduleForm.isNew" class="field-note"
            >决定正文语义与费用，创建后不可更改。</small
          >
        </label>
        <label
          >触发方式<UiSelect
            v-model="scheduleForm.trigger"
            data-field="trigger"
            :disabled="!editable"
            :options="[
              { value: 'cron', label: '周期（cron）' },
              { value: 'at', label: '一次性（绝对时间）' },
            ]"
        /></label>
        <label v-if="scheduleForm.trigger === 'cron'"
          >cron 表达式<input
            v-model="scheduleForm.cron"
            data-field="cron"
            :disabled="!editable"
            placeholder="0 8 * * * = 每天 8 点"
        /></label>
        <label v-else>
          时间<input
            v-model="scheduleForm.at"
            data-field="at"
            :disabled="!editable"
            placeholder="2026-08-19T08:00"
          />
          <small
            v-if="!scheduleForm.isNew && !scheduleForm.at"
            class="field-note"
            >时区无法识别，原时间未回填，请重新填写。</small
          >
        </label>
        <label v-if="!scheduleForm.isNew">
          时区<input
            data-field="timezone"
            :value="scheduleForm.timezone"
            disabled
          />
          <small class="field-note">任务含义锚定于此，不可更改。</small>
        </label>
        <label v-if="!scheduleForm.isNew">
          创建者<input
            data-field="creator"
            :value="scheduleForm.creatorLabel"
            disabled
          />
          <small class="field-note"
            >每次触发按有效角色重算；可写即提权入口。</small
          >
        </label>
        <div v-if="!scheduleForm.isNew">
          <p class="field-title">状态</p>
          <UiTag
            :value="
              (
                SCHEDULE_STATES[scheduleForm.state] ?? {
                  label: scheduleForm.state,
                }
              ).label
            "
            :severity="
              (SCHEDULE_STATES[scheduleForm.state] ?? { severity: 'secondary' })
                .severity
            "
          />
          <p class="field-note">停用 / 完成都是终态，只读。</p>
        </div>
        <p class="wide field-note">
          <template v-if="scheduleForm.isNew"
            >时间按 <code>general.timezone</code>（<b>{{
              schedules.timezone || "未知"
            }}</b
            >）解释，非浏览器时区。</template
          >
          <template v-else
            >时间按<b>该任务自身的时区</b>（<b>{{
              scheduleForm.timezone || "未知"
            }}</b
            >）解释，非浏览器时区、非 <code>general.timezone</code>。</template
          >
          <template v-if="schedules.settings"
            >间隔不小于
            {{ schedules.settings.minIntervalMinutes }} 分钟，单会话最多
            {{ schedules.settings.maxPerChat }} 个活跃任务。</template
          >
          一次性任务的时间须在将来，错过不补跑。
        </p>
        <div class="wide">
          <UiSwitch
            v-model="scheduleForm.silent"
            data-field="silent"
            :disabled="!editable || scheduleForm.mode === 'notify'"
            label="静默"
          />
          <p class="field-note">
            <template v-if="scheduleForm.mode === 'notify'"
              ><code>notify</code> 不调模型，该开关无效。</template
            >
            <template v-else
              >启用后模型可声明不投递：<b>消息不发，正文仍进上下文</b>。连续静默超阈值时列表会提示。</template
            >
          </p>
        </div>
        <label class="wide"
          >{{
            scheduleForm.mode === "agent"
              ? "任务描述（提供给模型）"
              : "要发出的正文"
          }}<textarea
            v-model="scheduleForm.text"
            data-field="text"
            rows="4"
            :disabled="!editable"
            :maxlength="schedules.settings?.maxPayloadChars ?? 2000"
            :placeholder="
              scheduleForm.mode === 'agent'
                ? '汇总昨天群里聊了什么，300 字以内'
                : '该喝水了'
            "
          />
        </label>
      </div>
      <template #footer>
        <UiButton
          v-if="!scheduleForm.isNew"
          variant="outlined"
          severity="danger"
          icon="pi pi-trash"
          label="永久删除"
          @click="purgeSchedule()"
        />
        <UiButton variant="text" label="取消" @click="scheduleDialog = false" />
        <UiButton
          :loading="scheduleSaving"
          :disabled="!editable"
          icon="pi pi-check"
          :label="scheduleForm.isNew ? '创建' : '保存'"
          @click="submitSchedule()"
        />
      </template>
    </UiModal>
  </article>
</template>
