<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import {
  MCP_STALE_AFTER_MS,
  MCP_STATE_LABELS,
  relativeTime,
  untilTime,
  type McpRow,
} from "./types";

/**
 * MCP server 是指向外部进程的一条活动连接。因此这一段采用表格而不是卡片：需要横向比较状态、
 * 凭据、工具条数、上次核对时间这几列，逐行排列才便于对比。
 *
 * 工具清单不再展开在行内。条数没有上限（单台 agent-browser 即可发现 64–70 个），此前它是一个限高的
 * 内嵌滚动区，限高后无法读出总数，因而又在副标题补充了工具条数。这里改为条数进列、
 * 清单进抽屉：既能读出总数，也能读到每个工具的描述（该描述由对端 server 提供，
 * 属于提示注入面之一，需要可见）。
 */
const props = defineProps<{
  rows: McpRow[];
  busy: string;
  masterOff: boolean;
  authAvailable: boolean;
}>();
defineEmits<{
  toggle: [McpRow];
  edit: [McpRow];
  remove: [string];
  reconnect: [McpRow];
  tools: [McpRow];
  login: [McpRow];
  credential: [McpRow];
  signOut: [McpRow];
}>();

const stateOf = (
  row: McpRow,
): { label: string; severity: "success" | "warn" | "danger" | "secondary" } => {
  if (row.enabled === 0) return MCP_STATE_LABELS.disabled as never;
  return (MCP_STATE_LABELS[String(row.state)] ?? {
    label: row.state ? String(row.state) : "未连接",
    severity: "warn",
  }) as never;
};
const authMode = (row: McpRow): "none" | "bearer" | "oauth" =>
  (row.auth?.mode as "none" | "bearer" | "oauth" | undefined) ?? "none";
/**
 * 标记该行数据可能陈旧。`mcp_servers.state` 由 `mcp-health` 每 5 分钟核对一次，子进程被
 * `kill -9` 后最长 5 分钟才会从 `up` 改写，期间界面显示已连接而该 server 的工具
 * 已不在模型目录中。判据使用 `updated_at`（每次成功 reconcile 都会推进）而不是解析 cron。
 */
const stale = (row: McpRow): boolean =>
  row.enabled !== 0 &&
  row.state === "up" &&
  !!row.updated_at &&
  Date.now() - row.updated_at > MCP_STALE_AFTER_MS;
const sorted = (): McpRow[] =>
  [...props.rows].sort((left, right) => {
    const weight = (row: McpRow): number =>
      row.state === "needs_auth" ? 0 : row.state === "down" ? 1 : 2;
    return weight(left) - weight(right) || left.name.localeCompare(right.name);
  });
</script>

<template>
  <div class="ext-table-wrap">
    <table v-if="rows.length" class="ext-table">
      <thead>
        <tr>
          <th>server</th>
          <th>状态</th>
          <th>凭据</th>
          <th>工具</th>
          <th>最低角色</th>
          <th>上次核对</th>
          <th class="ext-col-actions">动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in sorted()"
          :key="row.name"
          :class="{
            'needs-attention':
              row.state === 'needs_auth' || row.state === 'down',
          }"
        >
          <td>
            <b>{{ row.name }}</b>
            <small>{{
              row.transport === "http"
                ? row.url
                : `${row.command ?? "?"} ${(row.args ?? []).join(" ")}`.trim()
            }}</small>
          </td>
          <td>
            <UiTag
              :value="stateOf(row).label"
              :severity="stateOf(row).severity"
            />
            <small v-if="stale(row)" class="ext-stale"
              ><i class="pi pi-clock" aria-hidden="true" />可能已陈旧</small
            >
            <small v-if="row.last_error" class="ext-error">{{
              row.last_error
            }}</small>
          </td>
          <td>
            <template v-if="authMode(row) === 'none'"
              ><small class="ext-muted">不需要</small></template
            >
            <template v-else>
              <UiTag
                :value="authMode(row) === 'oauth' ? 'OAuth' : 'Bearer'"
                :severity="row.credential?.authorized ? 'success' : 'warn'"
              />
              <small
                v-if="row.credential?.authorized && authMode(row) === 'bearer'"
                >····{{ row.credential.hint ?? "" }}</small
              >
              <small v-if="row.credential?.authorized">{{
                untilTime(row.credential.expiresAt)
              }}</small>
              <small v-else class="ext-muted">尚无凭据</small>
            </template>
          </td>
          <td>
            <UiButton
              v-if="row.tools?.length"
              size="small"
              variant="text"
              :label="`${row.tools.length} 个`"
              icon="pi pi-list"
              @click="$emit('tools', row)"
            />
            <small v-else class="ext-muted">—</small>
          </td>
          <td>{{ row.minRole ?? row.min_role ?? "未标注" }}</td>
          <td>
            {{ relativeTime(row.updated_at) }}
            <small v-if="row.connected_at"
              >建立于 {{ relativeTime(row.connected_at) }}</small
            >
          </td>
          <td class="ext-col-actions">
            <div class="ext-actions">
              <UiButton
                v-if="row.state === 'needs_auth' && authMode(row) === 'oauth'"
                size="small"
                label="登录"
                icon="pi pi-sign-in"
                :loading="busy === `mcp:${row.name}`"
                :disabled="!authAvailable"
                @click="$emit('login', row)"
              />
              <UiButton
                v-if="authMode(row) === 'bearer'"
                size="small"
                :variant="row.credential?.authorized ? 'text' : 'solid'"
                :label="row.credential?.authorized ? '换 token' : '填 token'"
                icon="pi pi-key"
                :disabled="!authAvailable"
                @click="$emit('credential', row)"
              />
              <UiButton
                v-if="row.credential?.authorized"
                size="small"
                variant="text"
                label="注销"
                :loading="busy === `mcp:${row.name}`"
                @click="$emit('signOut', row)"
              />
              <UiButton
                size="small"
                :variant="row.enabled === 0 ? 'solid' : 'outlined'"
                :label="row.enabled === 0 ? '启用' : '停用'"
                :loading="busy === `mcp:${row.name}`"
                :disabled="masterOff && row.enabled === 0"
                @click="$emit('toggle', row)"
              />
              <UiButton
                size="small"
                variant="text"
                icon="pi pi-refresh"
                aria-label="重连"
                :loading="busy === `mcp:${row.name}`"
                @click="$emit('reconnect', row)"
              />
              <UiButton
                size="small"
                variant="text"
                icon="pi pi-pencil"
                aria-label="编辑"
                @click="$emit('edit', row)"
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
          </td>
        </tr>
      </tbody>
    </table>
    <article v-else class="ext-empty">
      <i class="pi pi-server" aria-hidden="true" />
      <h3>尚无 MCP server</h3>
      <p>
        工具动态注册进模型目录，传输为 stdio 或 Streamable HTTP。<br />状态列显示<b>要登录</b>时，点击〔登录〕完成浏览器授权。
      </p>
    </article>
  </div>
</template>
