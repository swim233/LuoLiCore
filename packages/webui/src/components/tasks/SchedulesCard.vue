<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import UiTag from '../../ui/UiTag.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiSwitch from '../../ui/UiSwitch.vue';
import UiModal from '../../ui/UiModal.vue';
import DataGrid from '../../ui/DataGrid.vue';
import { pushToast, toastError } from '../../ui/toast';
import { askConfirm } from '../../ui/confirm';
import { api } from '../../api/client';
import { SCHEDULE_COLUMNS, SCHEDULE_RUN_STATES, SCHEDULE_STATES, WALL_CLOCK_RE, toWallClock, type ChatOption, type ScheduleJob, type ScheduleList } from './types';

/**
 * 定时任务卡（docs/21 · G-API-16）。
 *
 * `GET /api/schedules` **不分页**：行数有界，DataGrid 自己客户端切片。撞 `listAll` 上限时
 * 信封里的 `truncated` 会为真 —— 那种情况要说出来，不静默截断。
 *
 * 普通 `<script setup>`，不 `return` 任何东西（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number; chats: ChatOption[] }>();

/**
 * 连续静默到这个次数之后日志升 warn。**与服务端 `runner.ts` 的 `SILENT_STREAK_WARN` 是同一个 10**，
 * 这里写字面量而不是 import —— webui 不依赖 core，改那边的常量时要顺手改这一行。
 * 一条「只烧钱不说话的定时器」在界面上的唯一痕迹就是它。
 */
const SILENT_STREAK_WARN = 10;
const MODE_OPTIONS = [{ value: 'notify', label: 'notify · 只发预写文本，不调模型' }, { value: 'agent', label: 'agent · 起一轮完整对话（花钱）' }];

/** 编辑态下这四格是只读的，每一格都要说出为什么 —— 见模板里各自的 `field-note`。 */
interface ScheduleForm {
  isNew: boolean; id: string; originalName: string; key: string; name: string;
  mode: 'agent' | 'notify'; trigger: 'cron' | 'at'; cron: string; at: string; text: string; silent: boolean;
  chatLabel: string; creatorLabel: string; timezone: string; state: string;
}
const BLANK: ScheduleForm = { isNew: true, id: '', originalName: '', key: '', name: '', mode: 'notify', trigger: 'cron',
  cron: '0 8 * * *', at: '', text: '', silent: false, chatLabel: '', creatorLabel: '', timezone: '', state: 'active' };

const schedules = ref<ScheduleList>({ available: true, enabled: true, timezone: '', jobs: [] });
const scheduleBusy = ref('');
const scheduleDialog = ref(false);
const scheduleSaving = ref(false);
const scheduleForm = ref<ScheduleForm>({ ...BLANK });
/** 编辑时那一行的原样。`PATCH` 只发**改动过的**字段：都发一遍的话，「我只改了一句正文」会连带
 *  把 cron 重新校验一次，运维把 `minIntervalMinutes` 从 5 调到 60 之后就再也存不下去了。 */
const scheduleOriginal = ref<ScheduleJob | null>(null);

/** 已经停掉的任务改了也不会再响 —— 表单整体只读，出口只剩 footer 那个删除。 */
const editable = computed(() => scheduleForm.value.isNew || scheduleForm.value.state === 'active');

// 归一化而不是直接塞：形状对不上的响应（老版本服务端、代理截断）不该让整页崩在
// DataGrid 的 rows 上。渲染防线就是为这类事建的（docs/24 · R-UI-01）。
async function reload(): Promise<void> {
  const next = await api<Partial<ScheduleList>>('/api/schedules');
  schedules.value = { available: Boolean(next?.available) && Array.isArray(next?.jobs), enabled: Boolean(next?.enabled),
    timezone: next?.timezone ?? '', jobs: Array.isArray(next?.jobs) ? next.jobs : [], ...(next?.settings ? { settings: next.settings } : {}),
    ...(typeof next?.total === 'number' ? { total: next.total } : {}), ...(next?.truncated ? { truncated: true } : {}) };
}
/** 没装配运行时的部署会回 `available:false`，界面据此说明白，而不是显示零条任务 —— 所以这里吞掉失败。 */
const refresh = (): void => { void reload().catch(() => undefined); };

function openScheduleDialog(): void {
  scheduleOriginal.value = null;
  scheduleForm.value = { ...BLANK, key: props.chats[0]?.key ?? '', timezone: schedules.value.timezone };
  scheduleDialog.value = true;
}
/**
 * 编辑。**`at` 必须走 `toWallClock`**：`scheduledJobView` 发的是 `toISOString()` 的 UTC 瞬时，
 * 而这格输入框收的是行上时区的墙钟。直接回填 ISO 的话，`Asia/Shanghai` 上一个「早八点」的任务
 * 会显示成 `…T00:00:00.000Z`，人顺手改成 `08:00` 再存 —— 任务被静默挪后 8 小时，两次操作各自都不报错。
 */
function editSchedule(job: ScheduleJob): void {
  scheduleOriginal.value = job;
  scheduleForm.value = { isNew: false, id: job.id, originalName: job.name, key: job.key, name: job.name, mode: job.mode,
    trigger: job.cron ? 'cron' : 'at', cron: job.cron ?? '', at: toWallClock(job.at, job.timezone), text: job.payload,
    silent: job.silent === true, chatLabel: job.chatLabel ?? job.chatId, creatorLabel: job.creatorLabel ?? job.createdBy,
    timezone: job.timezone, state: job.state };
  scheduleDialog.value = true;
}
// notify 不调模型，没有谁能调 `stay_silent` —— 切过去时把开关一起归零，免得存下一个运行时不读的真值。
watch(() => scheduleForm.value.mode, (mode) => { if (mode === 'notify') scheduleForm.value.silent = false; });

/** 只把改动过的字段装进 `PATCH`。触发方式换了向（cron ↔ at）时那一项一定要发，另一列由服务端置 NULL。 */
function patchFor(form: ScheduleForm): Record<string, unknown> {
  const before = scheduleOriginal.value;
  const patch: Record<string, unknown> = {};
  if (!before) return patch;
  if (form.name !== before.name) patch.name = form.name;
  if (form.text !== before.payload) patch.text = form.text;
  if (form.silent !== (before.silent === true)) patch.silent = form.silent;
  const wasCron = Boolean(before.cron);
  if (form.trigger === 'cron') { if (!wasCron || form.cron !== before.cron) patch.cron = form.cron; }
  else if (wasCron || form.at !== toWallClock(before.at, before.timezone)) patch.at = form.at;
  return patch;
}
/**
 * **只做格式校验**：非空与墙钟形状。`interval_too_short` / `at_in_the_past` / `too_many_jobs` /
 * `duplicate_name` / `invalid_cron` 一律让服务端回 —— 建与改的校验只有一份，抄第二份的那一天
 * WebUI 就能建出工具建不出来的任务。cron 在这里**不解析**。
 */
function formatComplaint(body: Record<string, unknown>): { summary: string; detail: string } | null {
  if ('name' in body && !String(body.name).trim()) return { summary: '任务名不能为空', detail: '同一会话内唯一，取消时用它' };
  if ('text' in body && !String(body.text).trim()) return { summary: '正文不能为空', detail: '这条任务到点之后要拿它做事' };
  if ('cron' in body && !String(body.cron).trim()) return { summary: 'cron 表达式不能为空', detail: '写得对不对由服务端判' };
  if ('at' in body && !WALL_CLOCK_RE.test(String(body.at))) return { summary: '时间格式不对', detail: '要填 2026-08-19T08:00 这个形状' };
  return null;
}
async function submitSchedule(): Promise<void> {
  const form = scheduleForm.value;
  if (form.isNew && !form.key) { pushToast({ severity: 'warn', summary: '先选一个会话', detail: '只能给已经有上下文的会话排任务' }); return; }
  // `key` / `chatId` / `mode` / `createdBy` 只在新建时出现在 body 里：`PATCH` 一个都不收。
  const body: Record<string, unknown> = form.isNew
    ? { key: form.key, name: form.name, mode: form.mode, text: form.text, silent: form.silent,
      ...(form.trigger === 'cron' ? { cron: form.cron } : { at: form.at }) }
    : patchFor(form);
  const complaint = formatComplaint(body);
  if (complaint) { pushToast({ severity: 'warn', ...complaint }); return; }
  scheduleSaving.value = true;
  try {
    const path = form.isNew ? '/api/schedules' : `/api/schedules/${encodeURIComponent(form.id)}`;
    const saved = await api<ScheduleJob>(path, { method: form.isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    pushToast({ severity: 'success', summary: form.isNew ? `已排上「${saved.name}」` : `已保存「${saved.name}」`,
      detail: saved.nextRun ? `下一次：${new Date(saved.nextRun).toLocaleString()}` : form.isNew ? '已建立' : '不再触发' });
    scheduleDialog.value = false;
    await reload();
  } catch (error) { toastError(form.isNew ? '建定时任务失败' : '保存定时任务失败', error); }
  finally { scheduleSaving.value = false; }
}
function cancelSchedule(job: ScheduleJob): void {
  askConfirm(`停掉「${job.name}」？`, '停掉后不再触发；任务行按 schedule.retentionDays 保留，之后同名任务可以重建。', async () => {
    scheduleBusy.value = job.id;
    try {
      const result = await api<{ cancelled: boolean }>(`/api/schedules/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      pushToast(result.cancelled ? { severity: 'success', summary: `已停用「${job.name}」`, detail: '调度器里也摘掉了' }
        : { severity: 'warn', summary: '这条本来就已经停了', detail: '状态会在下次刷新时归位' });
      await reload();
    } catch (error) { toastError('停用失败', error); }
    finally { scheduleBusy.value = ''; }
  });
}
/**
 * 硬删。入口只在弹窗 footer 最左 —— 与行内那个「停掉」并排放两个红按钮必然误点，而这两件事
 * 差得很远：停掉的行还在、还看得见历史，删掉的整行连同运行历史一起没了。
 */
function purgeSchedule(): void {
  const { id, originalName } = scheduleForm.value;
  // 这张弹窗**开着**问：确认框与它都 Teleport 到 body 且同属 `.ui-overlay`，`ConfirmHost` 在
  // `App.vue` 里先挂载所以锚点在前 —— 层级由 `styles.css` 里那条 `:has(.confirm-detail)` 解决，
  // 不靠「先把这张收掉」绕开。收掉之后人就看不见自己要删的是哪一条了。
  askConfirm(`永久删除「${originalName}」？`, '这一行连同它的运行历史一起没了，模型的 schedule_list 也看不到；跟「停掉」不是一回事 —— 停掉只是不再触发，行还留着。',
    async () => {
      try {
        await api<{ removed: boolean }>(`/api/schedules/${encodeURIComponent(id)}/purge`, { method: 'POST', body: '{}' });
        pushToast({ severity: 'success', summary: `已永久删除「${originalName}」` });
        // 删成功才收：失败时这张留着，人还能再试一次或者改主意去「停掉」（同 TasksCard 的删除）。
        scheduleDialog.value = false;
        await reload();
      } catch (error) { toastError('删除定时任务失败', error); }
    });
}
/** 立即触发。代价必须写在确认框里：agent 模式点一下就是一次真实模型调用，而且真的会发消息出去。 */
function triggerSchedule(job: ScheduleJob): void {
  const cost = job.mode === 'agent' ? '这会真的跑一轮模型调用（花钱）' : '这会真的发一条消息';
  askConfirm(`立即触发「${job.name}」？`, `${cost}，落点是「${job.chatLabel ?? job.chatId}」。不影响下一次的正常触发。`, async () => {
    scheduleBusy.value = job.id;
    try {
      await api<{ started: boolean }>(`/api/schedules/${encodeURIComponent(job.id)}/trigger`, { method: 'POST', body: '{}' });
      // 不等它跑完：agent 模式一次触发是一整轮。结果落在这一行的「上一次」上。
      pushToast({ severity: 'success', summary: `已触发「${job.name}」`, detail: '不等它跑完；结果看这一行的「上一次」，或去日志页看这一轮' });
      await reload();
    } catch (error) { toastError('触发失败', error); }
    finally { scheduleBusy.value = ''; }
  });
}

onMounted(refresh);
watch(() => props.tick, refresh);
</script>

<template>
  <article class="surface">
    <div class="registry-heading">
      <div><h3>定时任务</h3><p class="section-note">模型用 <code>schedule_create</code> 排的、或在这里建的周期 / 一次性任务。到点<b>起一条完整轮次</b>并提交，所以产出照常进那个会话的上下文；<code>notify</code> 模式只发预写文本、不调模型。停机期间错过的<b>不补跑</b>，只在日志里留一条 <code>schedule.missed</code>。</p></div>
      <UiButton icon="pi pi-plus" label="新建定时任务" :disabled="!schedules.available || !schedules.enabled || !chats.length" :title="chats.length ? '' : '还没有任何会话上下文'" @click="openScheduleDialog()" />
    </div>
    <p v-if="!schedules.available" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />这个部署没有装配定时任务运行时，这里读不到任何任务（<b>不是「一条都没有」</b>）。</p>
    <p v-else-if="!schedules.enabled" class="callout warn"><i class="pi pi-pause" aria-hidden="true" /><code>schedule.enabled</code> 是关的：下面的任务都留在库里但不会触发，每次跳过记一条 <code>schedule.skipped</code>。</p>
    <p v-else-if="!chats.length" class="callout warn"><i class="pi pi-info-circle" aria-hidden="true" />还没有任何会话上下文，建不了任务 —— 任务要挂在一个真实会话上（先让 bot 在某个会话里说过一次话）。</p>
    <DataGrid :rows="schedules.jobs" :columns="SCHEDULE_COLUMNS" data-key="id" paginate empty="还没有定时任务">
      <template #name="{ data }"><div class="alias-name"><b>{{ data.name }}</b></div><small class="hit-text">{{ data.payload }}</small></template>
      <template #chatLabel="{ data }"><span>{{ data.chatLabel ?? data.chatId }}</span><small class="alias-empty">建于 {{ data.creatorLabel ?? data.createdBy }}</small></template>
      <template #mode="{ data }"><UiTag :value="data.mode" :severity="data.mode === 'agent' ? 'warn' : 'secondary'" :title="data.mode === 'agent' ? '每次触发都是一轮真实模型调用' : '只发预写文本，不调模型'" /><UiTag v-if="data.silent" value="静默" severity="secondary" title="模型这一轮没什么可说时可以不投递，正文照常进上下文" /></template>
      <template #trigger="{ data }"><code v-if="data.cron">{{ data.cron }}</code><span v-else>{{ new Date(data.at).toLocaleString() }}</span><small class="alias-empty">{{ data.timezone }}{{ data.cron ? '' : ' · 一次性' }}</small></template>
      <template #nextRun="{ data }"><span v-if="data.nextRun">{{ new Date(data.nextRun).toLocaleString() }}</span><small v-else class="alias-empty">不再触发</small></template>
      <template #last="{ data }">
        <template v-if="data.lastRunAt">
          <UiTag :value="(SCHEDULE_RUN_STATES[data.lastState ?? ''] ?? { label: data.lastState ?? '—' }).label" :severity="(SCHEDULE_RUN_STATES[data.lastState ?? ''] ?? { severity: 'secondary' }).severity" />
          <small class="alias-empty">{{ new Date(data.lastRunAt).toLocaleString() }} · 共 {{ data.runCount }} 次</small>
          <small v-if="data.lastError" class="detail-truncated">{{ data.lastError }}</small>
        </template>
        <small v-else class="alias-empty">还没跑过</small>
        <!-- 连续静默：这条任务可能已经变成一台只烧钱不说话的定时器，界面上要一直说着。 -->
        <small v-if="(data.silentStreak ?? 0) >= SILENT_STREAK_WARN" class="detail-truncated">连着 {{ data.silentStreak }} 次都没发出东西 —— 去看看它是不是已经没事可做了。</small>
      </template>
      <template #state="{ data }"><UiTag :value="(SCHEDULE_STATES[data.state] ?? { label: data.state }).label" :severity="(SCHEDULE_STATES[data.state] ?? { severity: 'secondary' }).severity" /></template>
      <!-- 这张表不设 `clickable`：一行里三个按钮，行点击必然误触。容器 `@click.stop` 是第二道。 -->
      <template #actions="{ data }">
        <div class="section-actions" @click.stop>
          <template v-if="data.state === 'active'">
            <UiButton size="small" variant="outlined" icon="pi pi-play" label="立即触发" :loading="scheduleBusy === data.id" @click="triggerSchedule(data)" />
            <UiButton size="small" variant="outlined" severity="danger" label="停掉" :loading="scheduleBusy === data.id" @click="cancelSchedule(data)" />
          </template>
          <UiButton size="small" variant="outlined" label="编辑" @click="editSchedule(data)" />
        </div>
      </template>
    </DataGrid>
    <!-- 表尾，且**不进上面那条 v-else-if 链**（docs/09 §3.10.1）：撞上限这件事与「没装配 / 总开关关着 /
         一个会话都没有」互相独立，串成一条链等于让前面任何一句把它吃掉，那就又变回静默截断了。 -->
    <p v-if="schedules.truncated" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" />任务太多，这里只列出了前 {{ schedules.jobs.length }} 条，还有 {{ Math.max(0, (schedules.total ?? 0) - schedules.jobs.length) }} 条没显示。</p>

    <UiModal v-model:visible="scheduleDialog" :title="scheduleForm.isNew ? '新建定时任务' : `定时任务 ${scheduleForm.originalName}`" width="min(680px, 94vw)">
      <div class="form-grid">
        <p v-if="!editable" class="callout warn wide"><i class="pi pi-ban" aria-hidden="true" />这条任务已经不在排了，改什么都不会再响 —— 这里只能看，或者永久删掉。</p>
        <p v-if="scheduleForm.isNew" class="wide field-note">任务归属 <b>owner</b>（<code>access.bootstrapOwnerId</code>）—— WebUI 只有这一个身份。触发时仍按 <code>min(用户角色, 会话角色)</code> 重算，所以在不受信的群里不会因为「是 owner 建的」而提权。</p>
        <label>会话
          <UiSelect v-if="scheduleForm.isNew" v-model="scheduleForm.key" data-field="chat" :options="chats.map((chat) => ({ value: chat.key, label: chat.key }))" />
          <template v-else>
            <input data-field="chat" :value="scheduleForm.chatLabel" disabled>
            <small class="field-note">会话是隔离锚点，建好之后换不了 —— 服务端也不收客户端给的会话 id，它从上下文里反查。要换会话就在那边新建一条。</small>
          </template>
        </label>
        <label>任务名<input v-model="scheduleForm.name" data-field="name" :disabled="!editable" maxlength="64" placeholder="同一会话内唯一，取消时用它"></label>
        <label>模式
          <UiSelect v-model="scheduleForm.mode" data-field="mode" :disabled="!scheduleForm.isNew" :options="MODE_OPTIONS" />
          <small v-if="!scheduleForm.isNew" class="field-note">下面那格正文的语义随模式翻转（任务描述 ↔ 待发原文），花不花钱也跟着变，所以建好之后换不了。</small>
        </label>
        <label>触发方式<UiSelect v-model="scheduleForm.trigger" data-field="trigger" :disabled="!editable" :options="[{ value: 'cron', label: '周期（cron）' }, { value: 'at', label: '一次性（绝对时间）' }]" /></label>
        <label v-if="scheduleForm.trigger === 'cron'">cron 表达式<input v-model="scheduleForm.cron" data-field="cron" :disabled="!editable" placeholder="0 8 * * * = 每天早八点"></label>
        <label v-else>
          时间<input v-model="scheduleForm.at" data-field="at" :disabled="!editable" placeholder="2026-08-19T08:00">
          <small v-if="!scheduleForm.isNew && !scheduleForm.at" class="field-note">这一行的时区认不出来，原来那个时间没法换算成墙钟填进去 —— 要改的话请重填一遍。</small>
        </label>
        <label v-if="!scheduleForm.isNew">
          时区<input data-field="timezone" :value="scheduleForm.timezone" disabled>
          <small class="field-note">任务的含义锚在建它时的那个时区上，改了等于换一条任务。</small>
        </label>
        <label v-if="!scheduleForm.isNew">
          创建者<input data-field="creator" :value="scheduleForm.creatorLabel" disabled>
          <small class="field-note">每次触发都按 <code>min(用户角色, 会话角色)</code> 重算一遍 —— 这一格要是能改，它就成了一个提权把手。</small>
        </label>
        <div v-if="!scheduleForm.isNew">
          <p class="field-title">状态</p>
          <UiTag :value="(SCHEDULE_STATES[scheduleForm.state] ?? { label: scheduleForm.state }).label" :severity="(SCHEDULE_STATES[scheduleForm.state] ?? { severity: 'secondary' }).severity" />
          <p class="field-note">停用 / 完成都是终局：这一格只看，不改。</p>
        </div>
        <p class="wide field-note">
          <template v-if="scheduleForm.isNew">时间按 <code>general.timezone</code>（<b>{{ schedules.timezone || '未知' }}</b>）解释，不是浏览器时区。</template>
          <template v-else>时间按<b>这一行自己的时区</b>（<b>{{ scheduleForm.timezone || '未知' }}</b>）解释，不是浏览器时区，也不是 <code>general.timezone</code>。</template>
          <template v-if="schedules.settings">两次触发间隔不能小于 {{ schedules.settings.minIntervalMinutes }} 分钟，单会话最多 {{ schedules.settings.maxPerChat }} 个活跃任务。</template>
          一次性任务的时间必须在将来 —— 错过的触发点不会补跑。
        </p>
        <div class="wide">
          <UiSwitch v-model="scheduleForm.silent" data-field="silent" :disabled="!editable || scheduleForm.mode === 'notify'" label="静默" />
          <p class="field-note">
            <template v-if="scheduleForm.mode === 'notify'"><code>notify</code> 不调模型，没有谁能替这一轮宣布不发 —— 这个开关对它没有意义。</template>
            <template v-else>打开之后，模型这一轮没什么可说时可以宣布不投递：<b>消息不发，正文照常进上下文</b>，所以它下一轮知道自己查过了。连着静默太多次会在这条任务的行上说出来。</template>
          </p>
        </div>
        <label class="wide">{{ scheduleForm.mode === 'agent' ? '任务描述（给模型看）' : '要发出的正文' }}<textarea v-model="scheduleForm.text" data-field="text" rows="4" :disabled="!editable" :maxlength="schedules.settings?.maxPayloadChars ?? 2000" :placeholder="scheduleForm.mode === 'agent' ? '汇总昨天群里聊了什么，300 字以内' : '该喝水了'" /></label>
      </div>
      <template #footer>
        <UiButton v-if="!scheduleForm.isNew" variant="outlined" severity="danger" icon="pi pi-trash" label="永久删除" @click="purgeSchedule()" />
        <UiButton variant="text" label="取消" @click="scheduleDialog = false" />
        <UiButton :loading="scheduleSaving" :disabled="!editable" icon="pi pi-check" :label="scheduleForm.isNew ? '排上' : '保存'" @click="submitSchedule()" />
      </template>
    </UiModal>
  </article>
</template>
