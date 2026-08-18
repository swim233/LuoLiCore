<script setup lang="ts">
// 图片与文件此前在管理端完全不可见：消息行不返回 attachment id，界面上也没有任何地方能点开
// （docs/21 · G-API-08）。这一条带子挂在消息卡片与检索结果下面，图片直接出缩略图，其余给下载。
import { ref } from 'vue';
import UiTag from './UiTag.vue';
import UiModal from './UiModal.vue';
import type { Attachment, TagSeverity } from './types';

defineProps<{ items: Attachment[] }>();

// 服务端只对光栅图放行 `?inline=1`（同源内联 SVG/HTML 等于自造 XSS），这里的判据必须与它一致，
// 否则会画出一张永远加载不出来的缩略图。
const INLINE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ICONS: Record<string, string> = { photo: 'pi pi-image', document: 'pi pi-file', voice: 'pi pi-microphone', audio: 'pi pi-volume-up', sticker: 'pi pi-face-smile' };
// download_state：done / failed / skipped 由 TelegramMedia.insert 写，expired 由
// MaintenanceService.cleanup 写。done 不需要徽标。**expired 与 failed 必须分开**：前者是文件当初
// 下来过、模型也看到过，只是过了 media.retentionDays 被清了；后者是从头到尾就没有过。
const STATES: Record<string, { label: string; severity: TagSeverity; hint: string }> = {
  failed: { label: '下载失败', severity: 'danger', hint: '这条附件没有落盘 —— 模型当时看到的也只是一句「处理失败」占位文本' },
  skipped: { label: '超限未下载', severity: 'warn', hint: '超过 media.maxImageBytes / media.maxDocBytes，当时就没有下载' },
  expired: { label: '已过期', severity: 'info', hint: '文件按 media.retentionDays 清掉了，元数据保留。当时模型看到的是原文件' },
};
const viewed = ref<Attachment | null>(null);
const name = (file: Attachment): string => file.fileName || `${file.kind}-${file.id.slice(0, 8)}`;
const icon = (file: Attachment): string => ICONS[file.kind] ?? 'pi pi-paperclip';
const ready = (file: Attachment): boolean => file.downloadState === 'done' && Boolean(file.hasLocal);
const inlineable = (file: Attachment): boolean => ready(file) && INLINE_IMAGE_MIME.has(file.mime ?? '');
const url = (file: Attachment, inline = false): string => `/api/files/${encodeURIComponent(file.id)}${inline ? '?inline=1' : ''}`;
const state = (file: Attachment): { label: string; severity: TagSeverity; hint: string } | null => STATES[file.downloadState] ?? null;
const bytes = (size: number): string => (size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`);
function meta(file: Attachment): string {
  const parts = [file.mime ?? file.kind, file.sizeBytes ? bytes(file.sizeBytes) : '大小未知'];
  if (file.width && file.height) parts.push(`${file.width}×${file.height}`);
  if (file.durationSec) parts.push(`${file.durationSec}s`);
  // 提取过正文的文档，模型当时读到的是正文而不是文件名 —— 这一点值得写在脸上。
  if (file.extractState === 'done') parts.push('已提取正文');
  return parts.join(' · ');
}
</script>

<template>
  <div v-if="items.length" class="attachment-strip">
    <template v-for="file in items" :key="file.id">
      <button v-if="inlineable(file)" type="button" class="attachment-thumb" :title="`${name(file)}\n${meta(file)}`" @click.stop="viewed = file">
        <img :src="url(file, true)" :alt="name(file)" loading="lazy">
      </button>
      <div v-else class="attachment-chip" :title="file.downloadError ?? meta(file)">
        <i :class="icon(file)" aria-hidden="true" />
        <div><b>{{ name(file) }}</b><small>{{ meta(file) }}</small></div>
        <UiTag v-if="state(file)" :value="state(file)!.label" :severity="state(file)!.severity" :title="state(file)!.hint" />
        <!-- 没落盘的附件不给下载链接：点开必然 404，给一个必然报错的入口比没有更糟。 -->
        <a v-if="ready(file)" :href="url(file)" class="attachment-download" :aria-label="`下载 ${name(file)}`"><i class="pi pi-download" aria-hidden="true" /></a>
      </div>
    </template>
  </div>

  <UiModal :visible="Boolean(viewed)" :title="viewed ? name(viewed) : ''" width="min(880px, 94vw)" @update:visible="viewed = null">
    <figure v-if="viewed" class="attachment-view">
      <img :src="url(viewed, true)" :alt="name(viewed)">
      <figcaption>{{ meta(viewed) }}</figcaption>
    </figure>
    <template #footer>
      <!-- 下载必须是真的 <a href>：走 UiButton 就得自己造一次导航，白绕一圈。 -->
      <a v-if="viewed" class="ui-btn outlined primary" :href="url(viewed)"><i class="pi pi-download" aria-hidden="true" /><span>下载原文件</span></a>
    </template>
  </UiModal>
</template>
