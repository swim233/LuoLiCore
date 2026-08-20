<script setup lang="ts">
import UiButton from '../../ui/UiButton.vue';
import UiTag from '../../ui/UiTag.vue';
import { customToolPendingReview, relativeTime, type CustomToolRow } from './types';

/**
 * 自定义工具是**模型自己写的沙箱脚本**。这一段因此是一条队列而不是一片卡片：未审阅的排在最前，
 * 因为这一页对这一类的唯一活儿就是「读过正文再决定」。
 *
 * 「未审阅」与「停用」是两档 —— 前者没人看过，后者有人看过之后关掉的。混成一个标签，
 * 运维就分不清哪些在等自己（docs/09 §3.8）。
 *
 * 正文与参数在这里**只读**：顺手改一行会让 `definition_hash` 与模型以为的那份定义脱节。
 */
const props = defineProps<{ rows: CustomToolRow[]; busy: string; authoringOff: boolean }>();
defineEmits<{ toggle: [CustomToolRow]; review: [CustomToolRow]; remove: [string] }>();

const sorted = (): CustomToolRow[] => [...props.rows].sort((left, right) => {
  const weight = (row: CustomToolRow): number => (customToolPendingReview(row) ? 0 : row.lastError ? 1 : row.enabled === 0 ? 2 : 3);
  return weight(left) - weight(right) || left.name.localeCompare(right.name);
});
</script>

<template>
  <div class="ext-list">
    <article
      v-for="row in sorted()" :key="row.name"
      :class="['ext-row', 'from-model', { 'pending-review': customToolPendingReview(row), broken: !!row.lastError }]"
    >
      <div class="ext-row-main">
        <h3>
          <code>custom_{{ row.name }}</code>
          <UiTag
            :value="customToolPendingReview(row) ? '未审阅' : row.enabled === 0 ? '停用' : '可用'"
            :severity="customToolPendingReview(row) ? 'warn' : row.enabled === 0 ? 'secondary' : 'success'"
          />
        </h3>
        <p>{{ row.description || '模型没有写描述。' }}</p>
        <code v-if="row.lastError">{{ row.lastError }}</code>
        <p v-if="customToolPendingReview(row)" class="ext-note-warn">
          <i class="pi pi-eye" aria-hidden="true" />还没有人读过这段脚本。启用之后它会以<b>调用者</b>的角色执行，而那时正文已经不在对话里了。
        </p>
        <div class="ext-chips">
          <UiTag :value="row.runtime" severity="info" />
          <UiTag :value="row.scope === 'chat' ? `仅会话 ${row.ownerChatId ?? '?'}` : '全局'" severity="secondary" />
          <UiTag v-if="row.timeoutMs" :value="`${Math.round(row.timeoutMs / 1000)}s 超时`" severity="secondary" />
          <small class="ext-muted">由 {{ row.createdBy }} 写下</small>
        </div>
      </div>
      <div class="ext-row-side">
        <div class="ext-facts">
          <span><small>最低角色</small>{{ row.minRole }}</span>
          <span><small>{{ row.reviewedAt ? '审阅于' : '写下于' }}</small>{{ relativeTime(row.reviewedAt ?? row.updatedAt) }}</span>
        </div>
        <div class="ext-actions">
          <UiButton size="small" label="读脚本" icon="pi pi-code" @click="$emit('review', row)" />
          <UiButton
            size="small" :variant="row.enabled === 0 ? 'solid' : 'outlined'" :label="row.enabled === 0 ? '启用' : '停用'"
            :loading="busy === `tool:${row.name}`" @click="$emit('toggle', row)"
          />
          <UiButton size="small" variant="text" severity="danger" icon="pi pi-trash" aria-label="删除" @click="$emit('remove', row.name)" />
        </div>
      </div>
    </article>
    <article v-if="!rows.length" class="ext-empty">
      <i class="pi pi-wrench" aria-hidden="true" />
      <h3>模型还没给自己写过工具</h3>
      <p v-if="authoringOff">这条通道当前是关的（<code>tools.selfExtend.customTools.enabled</code>）：模型拿不到 <code>define_tool</code>，也不会知道为什么。</p>
      <p v-else>模型用 <code>define_tool</code> 写下的脚本会落在这里，<b>一律是停用状态</b> —— 等人读过正文再启用。</p>
    </article>
  </div>
</template>
