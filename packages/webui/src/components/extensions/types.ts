import type { TagSeverity } from '../../ui/types';

/**
 * 扩展页四类的行类型与它们共用的那一条判据。
 *
 * 这一页的活儿不是「列出扩展」，是**决定模型被允许具备什么能力，并且真的看过**。M12 之后其中
 * 一部分是模型自己写的，所以视觉主轴取「谁写的 / 有没有人看过」而不是「开着还是关着」——
 * `provenanceOf()` 是那条主轴的唯一实现，四类共用。
 */

export interface SkillRow {
  name: string;
  description?: string;
  min_role?: string;
  enabled?: number;
  /** `bundled` 随包发的四份说明书 / `package` 装包装进来的 / `local` 手写或 `write_skill` 写的。 */
  source?: string;
  load_error?: string | null;
  updated_at?: number;
  allowed_tools?: string[];
  /** 这几个工具不在本轮工具集里时，这份 skill 压根不进模型的目录（`SkillLoader.catalog()`）。 */
  requires_tools?: string[];
}

export interface PluginRow {
  name: string;
  version?: string | null;
  min_role?: string;
  enabled?: number;
  load_error?: string | null;
  updated_at?: number;
  /** `{ tools, hooks, commands, agents }`。plugin 侧的「N 个工具」，端点一直在发。 */
  provides_json?: string | null;
}

export interface McpAuthView {
  mode: 'none' | 'bearer' | 'oauth';
  scope: string | null;
  hint: string | null;
  expiresAt: number | null;
  authorizedAt: number | null;
  authorized: boolean;
}

export interface McpRow {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  minRole?: string;
  min_role?: string;
  enabled?: number;
  toolAllow?: string[];
  toolDeny?: string[];
  timeoutMs?: number;
  state?: string | null;
  last_error?: string | null;
  connected_at?: number | null;
  updated_at?: number;
  tools?: Array<{ name?: unknown; description?: unknown }>;
  auth?: { mode?: string; scope?: string } | null;
  credential?: McpAuthView | null;
  pendingAuthorization?: { authorizationUrl: string; expiresAt: number } | null;
}

export interface CustomToolRow {
  name: string;
  description: string;
  runtime: string;
  body: string;
  paramsJson: string;
  minRole: string;
  scope: string;
  ownerChatId: string | null;
  timeoutMs: number | null;
  enabled: number;
  createdBy: string;
  reviewedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

/**
 * 来源。`id` 直接当 CSS 类后缀用（`.ext-row.from-<id>` 决定左侧那条脊的颜色）。
 *
 * **字段名不叫 `kind`**：`tests/docs.test.ts` 反向扫全仓库里带引号字面量的 `kind` 属性，
 * 要求每一个都在 `docs/10` §2 的事件表里有一行或进 `NON_LOG_KINDS`。这四个不是日志事件，
 * 不该去占那张表。（连这句注释本身都得绕开那个模式 —— 它是纯文本匹配。）
 */
export type ProvenanceKind = 'bundled' | 'local' | 'package' | 'model';
export interface Provenance { id: ProvenanceKind; label: string; hint: string }

const PROVENANCE: Record<ProvenanceKind, Provenance> = {
  bundled: { id: 'bundled', label: '随包', hint: '跟着这个版本一起发的，只能启停' },
  local: { id: 'local', label: '本地', hint: '在这台机器上写的' },
  package: { id: 'package', label: '安装包', hint: '从一个 zip 里装进来的，可能带脚本与二进制' },
  model: { id: 'model', label: '模型自撰', hint: '模型自己写下的，启用前该读过正文' },
};

export const provenanceOf = (kind: ProvenanceKind): Provenance => PROVENANCE[kind];

/**
 * **「未审阅」与「停用」是两档。** 前者是没人看过，后者是有人看过之后关掉的 —— 混成一个标签，
 * 运维就分不清哪些在等自己。这条判据在四类上的形状不同，所以由各自的组件决定，
 * 但呈现（琥珀脊 + 虚线边框）统一在 `.ext-row.pending-review` 里。
 */
export const skillPendingReview = (row: SkillRow): boolean => row.enabled === 0 && row.source === 'package';
export const customToolPendingReview = (row: CustomToolRow): boolean => row.enabled === 0 && row.reviewedAt === null;

export const MCP_STATE_LABELS: Record<string, { label: string; severity: TagSeverity }> = {
  up: { label: '已连接', severity: 'success' },
  pending: { label: '等待连接', severity: 'warn' },
  down: { label: '连不上', severity: 'danger' },
  /** 本轮新增。跟 `down` 分开的理由是运维动作完全不同：这一档要人去点一次授权。 */
  needs_auth: { label: '要登录', severity: 'warn' },
  disabled: { label: '停用', severity: 'secondary' },
};

/** 「上次核对」超过这么久就提示可能陈旧。`mcp.healthCheckCron` 默认 5 分钟一次，留一格余量。 */
export const MCP_STALE_AFTER_MS = 6 * 60_000;

export function relativeTime(at?: number | null): string {
  if (!at) return '—';
  const delta = Date.now() - at;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

/** 到期还剩多久。已过期说「已过期」而不是负数 —— 后者读起来像个 bug。 */
export function untilTime(at?: number | null): string {
  if (!at) return '不过期';
  const delta = at - Date.now();
  if (delta <= 0) return '已过期';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟后到期`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时后到期`;
  return `${Math.floor(delta / 86_400_000)} 天后到期`;
}

/** `provides_json` → 「2 个工具 · 1 个 hook」这类一句话。读不出来就当空的，不显示半截 JSON。 */
export function pluginProvides(row: PluginRow): string[] {
  if (!row.provides_json) return [];
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(row.provides_json) as Record<string, unknown>; } catch { return []; }
  const labels: Record<string, string> = { tools: '工具', hooks: 'hook', commands: '命令', agents: 'Agent' };
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = parsed[key];
    return Array.isArray(value) && value.length ? [`${value.length} 个${label}`] : [];
  });
}
