<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import {
  provenanceOf,
  relativeTime,
  skillPendingReview,
  type ProvenanceKind,
  type SkillRow,
} from "./types";

/**
 * Skill 的内容是模型将直接遵循的说明文本。因此这一段采用阅读式列表而不是卡片网格：描述需要连续阅读，
 * 而卡片网格会把同排每张卡片拉伸到最高一张的高度，一份长描述即可使相邻卡片出现大量空白
 * （`styles.css` 中 `.provider-grid article` 的注释记录了这一点）。
 *
 * 启用前需要查看的内容是正文，安装包引入的还需查看其包含哪些文件。因此「编辑」是主动作，
 * 同时也是阅读入口，这一页没有第二个可查看正文的位置。
 */
const props = defineProps<{
  rows: SkillRow[];
  busy: string;
  masterOff: boolean;
}>();
defineEmits<{ toggle: [SkillRow]; edit: [SkillRow]; remove: [string] }>();

const provenance = (row: SkillRow): ProvenanceKind =>
  row.source === "bundled"
    ? "bundled"
    : row.source === "package"
      ? "package"
      : "local";
const sorted = (): SkillRow[] =>
  [...props.rows].sort((left, right) => {
    // 待处理项排在最前：这一页的主要操作对象就是这几行。
    const weight = (row: SkillRow): number =>
      skillPendingReview(row) ? 0 : row.load_error ? 1 : 2;
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
        `from-${provenance(row)}`,
        { 'pending-review': skillPendingReview(row), broken: !!row.load_error },
      ]"
    >
      <div class="ext-row-main">
        <h3>
          {{ row.name
          }}<UiTag
            :value="provenanceOf(provenance(row)).label"
            severity="secondary"
          />
        </h3>
        <p v-if="row.description">{{ row.description }}</p>
        <p v-else class="ext-muted">未填写描述</p>
        <code v-if="row.load_error">{{ row.load_error }}</code>
        <p v-if="skillPendingReview(row)" class="ext-note-warn">
          <i
            class="pi pi-eye"
            aria-hidden="true"
          />安装后从未启用。点击〔查看正文〕复核 SKILL.md 与附属文件清单。
        </p>
        <div v-if="row.requires_tools?.length" class="ext-chips">
          <small>需要工具</small>
          <UiTag
            v-for="tool in row.requires_tools"
            :key="tool"
            :value="tool"
            severity="info"
          />
          <small class="ext-muted">缺少任一项则不进入模型目录</small>
        </div>
        <div v-if="row.allowed_tools?.length" class="ext-chips">
          <small>收窄到</small>
          <UiTag
            v-for="tool in row.allowed_tools"
            :key="tool"
            :value="tool"
            severity="secondary"
          />
        </div>
      </div>
      <div class="ext-row-side">
        <div class="ext-facts">
          <span><small>最低角色</small>{{ row.min_role ?? "未标注" }}</span>
          <span><small>上次变更</small>{{ relativeTime(row.updated_at) }}</span>
        </div>
        <div class="ext-actions">
          <UiButton
            size="small"
            :variant="row.enabled === 0 ? 'solid' : 'outlined'"
            :label="row.enabled === 0 ? '启用' : '停用'"
            :loading="busy === `skill:${row.name}`"
            :disabled="masterOff && row.enabled === 0"
            @click="$emit('toggle', row)"
          />
          <UiButton
            size="small"
            variant="text"
            icon="pi pi-book"
            :label="row.source === 'bundled' ? '查看正文' : '编辑'"
            @click="$emit('edit', row)"
          />
          <UiButton
            v-if="row.source !== 'bundled'"
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
      <i class="pi pi-book" aria-hidden="true" />
      <h3>尚无 skill</h3>
      <p>
        skill 是一份 <code>SKILL.md</code>，正文由
        <code>load_skill</code> 加载时注入。<br />〔新建 Skill〕创建单份，〔装
        Skill 包〕从 zip 安装整个目录。
      </p>
    </article>
  </div>
</template>
