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
 * MCP server 是**别人进程上的一条活的连接**。所以这一段是表而不是卡片：要比较的是状态、
 * 凭据、工具条数、上次核对时间这几列，而一行一行竖着排才比得出来。
 *
 * 工具清单不再摊在行里。条数没有上限（一台 agent-browser 就发现 64–70 个），此前它是一个封高的
 * 内嵌滚动区 —— 封高之后清单里读不出总数，所以又在副标题补了「N 个工具」。这里改成条数进列、
 * 清单进抽屉：既读得出总数，也读得到每个工具的描述（那份描述由对面那台 server 写，
 * 是提示注入面之一，值得能看见）。
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
 * 「这一行可能是陈旧的」。`mcp_servers.state` 由 `mcp-health` 每 5 分钟对一次账，子进程被
 * `kill -9` 之后最长 5 分钟才从 `up` 改过来 —— 期间界面写着「已连接」而那台 server 的工具
 * 已经不在模型目录里了。判据用 `updated_at`（每次成功 reconcile 都会推）而不是去解 cron。
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
              <small v-else class="ext-muted">还没有凭据</small>
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
              >连接建立于 {{ relativeTime(row.connected_at) }}</small
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
      <h3>还没有 MCP server</h3>
      <p>
        MCP server 把它自己的工具动态挂进模型的目录 ——
        本地进程（stdio）或者一个远端地址（Streamable HTTP）都行。<br />远端那种常常要登录：登记完之后这一行会显示<b>要登录</b>，点〔登录〕走一遍浏览器授权。
      </p>
    </article>
  </div>
</template>
