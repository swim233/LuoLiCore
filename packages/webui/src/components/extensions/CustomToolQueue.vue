<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import {
  customToolPendingReview,
  relativeTime,
  type CustomToolRow,
} from "./types";

/**
 * 自定义工具是模型自行编写的沙箱脚本。这一段因此采用队列而不是卡片：未审阅的排在最前，
 * 因为这一页对该类别的唯一操作就是阅读正文后作出决定。
 *
 * 未审阅与停用是两档状态：前者尚未复审，后者是复审后关闭的。合并为一个标签会使
 * 运维无法分辨哪些仍在等待处理（docs/09 §3.8）。
 *
 * 正文与参数在这里只读：随手修改一行会使 `definition_hash` 与模型所依据的定义不一致。
 */
const props = defineProps<{
  rows: CustomToolRow[];
  busy: string;
  authoringOff: boolean;
}>();
defineEmits<{
  toggle: [CustomToolRow];
  review: [CustomToolRow];
  remove: [string];
}>();

const sorted = (): CustomToolRow[] =>
  [...props.rows].sort((left, right) => {
    const weight = (row: CustomToolRow): number =>
      customToolPendingReview(row)
        ? 0
        : row.lastError
          ? 1
          : row.enabled === 0
            ? 2
            : 3;
    return weight(left) - weight(right) || left.name.localeCompare(right.name);
  });
</script>

<template>
  <div class="ext-list">
    <article
      v-for="row in sorted()"
      :key="row.name"
      :class="[
        'ext-row',
        'from-model',
        {
          'pending-review': customToolPendingReview(row),
          broken: !!row.lastError,
        },
      ]"
    >
      <div class="ext-row-main">
        <h3>
          <code>custom_{{ row.name }}</code>
          <UiTag
            :value="
              customToolPendingReview(row)
                ? '未审阅'
                : row.enabled === 0
                  ? '停用'
                  : '可用'
            "
            :severity="
              customToolPendingReview(row)
                ? 'warn'
                : row.enabled === 0
                  ? 'secondary'
                  : 'success'
            "
          />
        </h3>
        <p>{{ row.description || "未填写描述" }}</p>
        <code v-if="row.lastError">{{ row.lastError }}</code>
        <p v-if="customToolPendingReview(row)" class="ext-note-warn">
          <i
            class="pi pi-eye"
            aria-hidden="true"
          />尚未经人工复核。启用后以<b>调用者</b>的角色执行。
        </p>
        <div class="ext-chips">
          <UiTag :value="row.runtime" severity="info" />
          <UiTag
            :value="
              row.scope === 'chat' ? `仅会话 ${row.ownerChatId ?? '?'}` : '全局'
            "
            severity="secondary"
          />
          <UiTag
            v-if="row.timeoutMs"
            :value="`${Math.round(row.timeoutMs / 1000)}s 超时`"
            severity="secondary"
          />
          <small class="ext-muted">由 {{ row.createdBy }} 创建</small>
        </div>
      </div>
      <div class="ext-row-side">
        <div class="ext-facts">
          <span><small>最低角色</small>{{ row.minRole }}</span>
          <span
            ><small>{{ row.reviewedAt ? "审阅于" : "创建于" }}</small
            >{{ relativeTime(row.reviewedAt ?? row.updatedAt) }}</span
          >
        </div>
        <div class="ext-actions">
          <UiButton
            size="small"
            label="读脚本"
            icon="pi pi-code"
            @click="$emit('review', row)"
          />
          <UiButton
            size="small"
            :variant="row.enabled === 0 ? 'solid' : 'outlined'"
            :label="row.enabled === 0 ? '启用' : '停用'"
            :loading="busy === `tool:${row.name}`"
            @click="$emit('toggle', row)"
          />
          <UiButton
            size="small"
            variant="text"
            severity="danger"
            icon="pi pi-trash"
            aria-label="删除"
            @click="$emit('remove', row.name)"
          />
        </div>
      </div>
    </article>
    <article v-if="!rows.length" class="ext-empty">
      <i class="pi pi-wrench" aria-hidden="true" />
      <h3>尚无自定义工具</h3>
      <p v-if="authoringOff">
        该通道已关闭（<code>tools.selfExtend.customTools.enabled</code>）：模型无法获取
        <code>define_tool</code>。
      </p>
      <p v-else>
        模型经
        <code>define_tool</code>
        创建的脚本<b>一律为停用状态</b>，启用前需人工复核正文。
      </p>
    </article>
  </div>
</template>
