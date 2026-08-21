<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import UiTag from '../../ui/UiTag.vue';
import DataGrid from '../../ui/DataGrid.vue';
import { pushToast, toastError } from '../../ui/toast';
import { api } from '../../api/client';
import { APPROVAL_COLUMNS, type ApprovalPage, type ApprovalRow } from './types';

/**
 * 审批卡。
 *
 * 服务端此前硬 `LIMIT 200`，撞上限是**静默截断**；现在走 `?page=&size=`。翻页只影响这张表
 * —— 左侧导航那个角标读的是信封里的 `pending`（**服务端全表**计数），由父层单独拉，
 * 翻到第 2 页角标不变（`AC-WEB-049`）。
 *
 * 普通 `<script setup>`，不 `return` 任何东西（docs/24 · R-UI-01）。
 */
const props = defineProps<{ tick: number; approvalRulesEmpty: boolean; conditionalToolNames: string }>();
/** 裁决之后角标要立刻跟上，不能等下一个 SSE 事件 —— 父层收到这一条就重拉一次全表 pending。 */
const emit = defineEmits<{ changed: [] }>();

const PAGE_SIZE = 20;
const rows = ref<ApprovalRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 归一化而不是直接塞：形状对不上的响应不该让整页崩在 DataGrid 的 `rows` 上（docs/24 · R-UI-01）。
 *  同 `loadConversations`：重拉**不复位页码**，否则事件一到就把人弹回第 1 页。 */
async function reload(target = page.value): Promise<void> {
  loading.value = true;
  try {
    const result = await api<Partial<ApprovalPage>>(`/api/approvals?page=${target}&size=${PAGE_SIZE}`);
    rows.value = Array.isArray(result?.items) ? result.items : [];
    total.value = Number(result?.total ?? 0);
    page.value = Number(result?.page ?? target);
  } catch (error) { toastError('加载审批失败', error); }
  finally { loading.value = false; }
}

const deciding = ref('');
async function decideApproval(approval: ApprovalRow, approved: boolean): Promise<void> {
  const id = String(approval.id);
  deciding.value = id;
  try {
    const result = await api<{ changed: boolean }>(`/api/approvals/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify({ approved }) });
    pushToast(result.changed
      ? { severity: approved ? 'success' : 'warn', summary: approved ? '已批准，工具继续执行' : '已拒绝，工具不会执行', detail: String(approval.tool_name ?? id) }
      : { severity: 'warn', summary: '审批已经失效', detail: '可能已被处理、过期或所属轮次已取消' });
    await reload();
    emit('changed');
  } catch (error) { toastError('提交审批决定失败', error); }
  finally { deciding.value = ''; }
}

onMounted(() => { void reload(); });
watch(() => props.tick, () => { void reload(); });
</script>

<template>
  <article class="surface"><h3>审批</h3><p class="section-note">命中审批规则的工具会暂停到 <code>approval.ttlMs</code>；批准后原调用继续，拒绝、过期或取消后不会执行。</p>
    <p v-if="approvalRulesEmpty" class="callout warn"><i class="pi pi-exclamation-triangle" aria-hidden="true" /><b>0 条规则时 <code>conditional</code> 等于 <code>never</code>。</b><code>approval.enabled</code> 是开的，但 <code>approval.rules</code> 是空的 —— 规则表为空时判定恒为「不需要审批」，于是 <span v-if="conditionalToolNames"><code>{{ conditionalToolNames }}</code></span><span v-else>标着「条件审批」的工具</span> 全部直接执行。规则在「全部配置」的 <code>approval.rules</code> 里加，上面的试跑可以先验一遍。</p>
    <DataGrid :rows="rows" :columns="APPROVAL_COLUMNS" data-key="id" :loading="loading" empty="没有审批记录">
      <template #tool_name="{ data }"><code>{{ data.tool_name }}</code><small class="hit-text">{{ data.input_json }}</small></template>
      <template #risk="{ data }"><UiTag :value="String(data.risk)" :severity="data.risk === 'high' ? 'danger' : data.risk === 'medium' ? 'warn' : 'secondary'" /></template>
      <template #state="{ data }"><UiTag :value="String(data.state)" :severity="data.state === 'pending' ? 'warn' : data.state === 'approved' ? 'success' : data.state === 'denied' ? 'danger' : 'secondary'" /></template>
      <template #requested_at="{ data }">{{ new Date(Number(data.requested_at)).toLocaleString() }}</template>
      <template #actions="{ data }"><div v-if="data.state === 'pending'" class="section-actions"><UiButton size="small" severity="danger" variant="outlined" label="拒绝" :loading="deciding === data.id" @click.stop="decideApproval(data, false)" /><UiButton size="small" label="批准执行" :loading="deciding === data.id" @click.stop="decideApproval(data, true)" /></div><small v-else class="alias-empty">{{ data.decidedByLabel ?? data.decided_by ?? 'system' }}<template v-if="data.decision_channel"> · {{ data.decision_channel }}</template></small></template>
    </DataGrid>
    <footer v-if="total" class="grid-pager">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页</span>
      <button type="button" aria-label="上一页" :disabled="page <= 1 || loading" @click="reload(page - 1)"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
      <button type="button" aria-label="下一页" :disabled="page >= pages || loading" @click="reload(page + 1)"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
    </footer>
  </article>
</template>
