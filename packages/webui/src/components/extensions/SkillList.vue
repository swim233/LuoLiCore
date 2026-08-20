<script setup lang="ts">
import UiButton from '../../ui/UiButton.vue';
import UiTag from '../../ui/UiTag.vue';
import { provenanceOf, relativeTime, skillPendingReview, type ProvenanceKind, type SkillRow } from './types';

/**
 * Skill 是**模型会照着做的散文**。所以这一段做成阅读式列表而不是卡片网格：描述要一眼读得完，
 * 而卡片网格会把同排每张卡片拉到最高那张的高度，一份长描述就能把邻居撑成散开的空盒子
 * （`styles.css` 的 `.provider-grid article` 那条注释记着这件事）。
 *
 * 说是之前要看的东西：正文；装包进来的还要看它带了哪些文件。所以「编辑」是主动作，
 * 而它同时是「读」的入口 —— 这一页没有第二个能看到正文的地方。
 */
const props = defineProps<{ rows: SkillRow[]; busy: string; masterOff: boolean }>();
defineEmits<{ toggle: [SkillRow]; edit: [SkillRow]; remove: [string] }>();

const provenance = (row: SkillRow): ProvenanceKind => (row.source === 'bundled' ? 'bundled' : row.source === 'package' ? 'package' : 'local');
const sorted = (): SkillRow[] => [...props.rows].sort((left, right) => {
  // 在等人处理的排最前。这一页真正的活儿就是这几行。
  const weight = (row: SkillRow): number => (skillPendingReview(row) ? 0 : row.load_error ? 1 : 2);
  return weight(left) - weight(right) || left.name.localeCompare(right.name);
});
</script>

<template>
  <div class="ext-list">
    <article
      v-for="row in sorted()" :key="row.name"
      :class="['ext-row', `from-${provenance(row)}`, { 'pending-review': skillPendingReview(row), broken: !!row.load_error }]"
    >
      <div class="ext-row-main">
        <h3>{{ row.name }}<UiTag :value="provenanceOf(provenance(row)).label" severity="secondary" /></h3>
        <p v-if="row.description">{{ row.description }}</p>
        <p v-else class="ext-muted">没有写描述 —— 模型在目录里看到的就是这一行，空着等于它不知道什么时候该读这份。</p>
        <code v-if="row.load_error">{{ row.load_error }}</code>
        <p v-if="skillPendingReview(row)" class="ext-note-warn">
          <i class="pi pi-eye" aria-hidden="true" />装进来之后还没被启用过 —— 点〔读一遍〕看过 SKILL.md 与它带的文件清单再决定。
        </p>
        <div v-if="row.requires_tools?.length" class="ext-chips">
          <small>需要工具</small>
          <UiTag v-for="tool in row.requires_tools" :key="tool" :value="tool" severity="info" />
          <small class="ext-muted">这几个工具不在本轮工具集里时，这份 skill 压根不进模型的目录</small>
        </div>
        <div v-if="row.allowed_tools?.length" class="ext-chips">
          <small>收窄到</small>
          <UiTag v-for="tool in row.allowed_tools" :key="tool" :value="tool" severity="secondary" />
        </div>
      </div>
      <div class="ext-row-side">
        <div class="ext-facts">
          <span><small>最低角色</small>{{ row.min_role ?? '未标注' }}</span>
          <span><small>上次变更</small>{{ relativeTime(row.updated_at) }}</span>
        </div>
        <div class="ext-actions">
          <UiButton
            size="small" :variant="row.enabled === 0 ? 'solid' : 'outlined'" :label="row.enabled === 0 ? '启用' : '停用'"
            :loading="busy === `skill:${row.name}`" :disabled="masterOff && row.enabled === 0" @click="$emit('toggle', row)"
          />
          <UiButton size="small" variant="text" icon="pi pi-book" :label="row.source === 'bundled' ? '读一遍' : '编辑'" @click="$emit('edit', row)" />
          <UiButton
            v-if="row.source !== 'bundled'" size="small" variant="text" severity="danger" icon="pi pi-trash"
            aria-label="删除" @click="$emit('remove', row.name)"
          />
        </div>
      </div>
    </article>
    <article v-if="!rows.length" class="ext-empty">
      <i class="pi pi-book" aria-hidden="true" />
      <h3>还没有 skill</h3>
      <p>skill 是一份 <code>SKILL.md</code>：平时只占模型目录里一行标题，被 <code>load_skill</code> 拉起来时才注入正文。<br>用〔新建 Skill〕自己写一份，或者〔装 Skill 包〕从一个 zip 装一整棵目录进来。</p>
    </article>
  </div>
</template>
