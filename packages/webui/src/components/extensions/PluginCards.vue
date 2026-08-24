<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import { pluginProvides, relativeTime, type PluginRow } from "./types";

/**
 * Plugin 是**在 bot 进程里全信任跑的代码，没有沙箱**。这一段因此不装作和另外三类一样：
 * 每张卡片顶上一句风险陈述，主动作是〔看源码〕而不是〔启用〕—— 启用前先看过源码，这句话
 * 要么有一个入口，要么就只是句口号（`GET /api/plugins/:name/source` 就是为它加的）。
 *
 * `provides` 摆在卡片上：那是 plugin 侧的「N 个工具」，端点一直在发（`provides_json`）而
 * 界面一直没读 —— 于是「启用它会往模型目录里加什么」在这一页上读不出来。
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
              row.enabled === 0 ? '停用' : row.load_error ? '加载失败' : '在跑'
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
          进程里<b>全信任</b>运行，没有沙箱。启用等于把这段代码当成本项目自己的代码。
        </p>
        <code v-if="row.load_error">{{ row.load_error }}</code>
        <div v-if="pluginProvides(row).length" class="ext-chips">
          <small>它往运行时加了</small>
          <UiTag
            v-for="entry in pluginProvides(row)"
            :key="entry"
            :value="entry"
            severity="info"
          />
        </div>
        <p v-else class="ext-muted">
          这份 plugin 没有声明任何 tool / hook / command。
        </p>
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
      <h3>还没有 plugin</h3>
      <p>
        plugin 是 <code>plugins/&lt;名字&gt;/plugin.js</code>：能注册工具、挂
        hook、加命令，代价是它跟本项目自己的代码同一个信任级别。<br />模型也能写
        plugin（<code>tools.selfExtend.plugins</code>），写下来一律是停用状态，等人读过源码。
      </p>
    </article>
  </div>
</template>
