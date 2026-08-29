<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import { pluginProvides, relativeTime, type PluginRow } from "./types";

/**
 * Plugin 在 bot 进程内以全信任方式运行，没有沙箱隔离。这一段因此与另外三类区别对待：
 * 每张卡片顶部给出风险说明，主动作是查看源码而不是启用。启用前先查看源码这条要求
 * 必须有对应入口才能成立（`GET /api/plugins/:name/source` 正是为此添加）。
 *
 * `provides` 展示在卡片上：它是 plugin 侧提供的能力条数，端点一直在发送（`provides_json`）而
 * 界面此前未读取，导致启用后会向模型目录添加什么内容在这一页上无法得知。
 */
const props = defineProps<{
  rows: PluginRow[];
  busy: string;
  hotReloadWarning: string;
}>();
defineEmits<{
  toggle: [PluginRow];
  source: [PluginRow];
  reload: [PluginRow];
  remove: [string];
}>();

const sorted = (): PluginRow[] =>
  [...props.rows].sort((left, right) => {
    const weight = (row: PluginRow): number =>
      row.load_error ? 0 : row.enabled === 0 ? 1 : 2;
    return weight(left) - weight(right) || left.name.localeCompare(right.name);
  });
</script>

<template>
  <div class="ext-cards">
    <article
      v-for="row in sorted()"
      :key="row.name"
      :class="['ext-row', 'from-model', { broken: !!row.load_error }]"
    >
      <div class="ext-row-main">
        <h3>
          {{ row.name }}
          <UiTag
            v-if="row.version"
            :value="`v${row.version}`"
            severity="secondary"
          />
          <UiTag
            :value="
              row.enabled === 0
                ? '停用'
                : row.load_error
                  ? '加载失败'
                  : '运行中'
            "
            :severity="
              row.enabled === 0
                ? 'secondary'
                : row.load_error
                  ? 'danger'
                  : 'success'
            "
          />
        </h3>
        <p class="ext-note-warn">
          <i class="pi pi-exclamation-triangle" aria-hidden="true" />在 bot
          进程内<b>全信任</b>运行，无沙箱，与本项目代码同一信任级别。
        </p>
        <code v-if="row.load_error">{{ row.load_error }}</code>
        <div v-if="pluginProvides(row).length" class="ext-chips">
          <small>向运行时注册</small>
          <UiTag
            v-for="entry in pluginProvides(row)"
            :key="entry"
            :value="entry"
            severity="info"
          />
        </div>
        <p v-else class="ext-muted">未声明 tool / hook / command</p>
        <p v-if="hotReloadWarning" class="ext-note-warn">
          <i class="pi pi-info-circle" aria-hidden="true" />{{
            hotReloadWarning
          }}
        </p>
      </div>
      <div class="ext-row-side">
        <div class="ext-facts">
          <span><small>最低角色</small>{{ row.min_role ?? "未标注" }}</span>
          <span><small>上次变更</small>{{ relativeTime(row.updated_at) }}</span>
        </div>
        <div class="ext-actions">
          <UiButton
            size="small"
            label="看源码"
            icon="pi pi-code"
            @click="$emit('source', row)"
          />
          <UiButton
            size="small"
            :variant="row.enabled === 0 ? 'solid' : 'outlined'"
            :label="row.enabled === 0 ? '启用' : '停用'"
            :loading="busy === `plugin:${row.name}`"
            @click="$emit('toggle', row)"
          />
          <UiButton
            size="small"
            variant="text"
            icon="pi pi-refresh"
            aria-label="重载"
            :loading="busy === `plugin:${row.name}`"
            @click="$emit('reload', row)"
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
      <i class="pi pi-box" aria-hidden="true" />
      <h3>尚无 plugin</h3>
      <p>
        plugin 是 <code>plugins/&lt;名字&gt;/plugin.js</code>：可注册工具、hook
        与命令，与本项目代码同一信任级别。<br />模型亦可编写（<code>tools.selfExtend.plugins</code>），一律为停用状态，启用前需人工复核源码。
      </p>
    </article>
  </div>
</template>
