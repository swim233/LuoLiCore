import type { TagSeverity } from "../../ui/types";

/**
 * 扩展页四类的行类型与它们共用的那一条判据。
 *
 * 这一页的职责不是列出扩展，而是决定模型被允许具备什么能力并确认已复审。M12 之后其中
 * 一部分由模型自行编写，因此视觉主轴取来源与是否已复审，而不是启用与否。
 * `provenanceOf()` 是该主轴的唯一实现，四类共用。
 */

export interface SkillRow {
  name: string;
  description?: string;
  min_role?: string;
  enabled?: number;
  /** `bundled` 随包发布的四份说明文档；`package` 由安装包引入；`local` 手写或 `write_skill` 生成。 */
  source?: string;
  load_error?: string | null;
  updated_at?: number;
  allowed_tools?: string[];
  /** 这几个工具不在本轮工具集中时，该 skill 不会进入模型的目录（`SkillLoader.catalog()`）。 */
  requires_tools?: string[];
}

export interface PluginRow {
  name: string;
  version?: string | null;
  min_role?: string;
  enabled?: number;
  load_error?: string | null;
  updated_at?: number;
  /** `{ tools, hooks, commands, agents }`。plugin 侧的能力条数，端点一直在发送。 */
  provides_json?: string | null;
}

export interface McpAuthView {
  mode: "none" | "bearer" | "oauth";
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
 * 来源。`id` 直接用作 CSS 类后缀（`.ext-row.from-<id>` 决定左侧脊线的颜色）。
 *
 * 字段名不叫 `kind`：`tests/docs.test.ts` 反向扫描全仓库中带引号字面量的 `kind` 属性，
 * 要求每一个都在 `docs/10` §2 的事件表中有一行或列入 `NON_LOG_KINDS`。这四个不是日志事件，
 * 不应占用那张表。（这段注释本身也需避开该模式，它是纯文本匹配。）
 */
export type ProvenanceKind = "bundled" | "local" | "package" | "model";
export interface Provenance {
  id: ProvenanceKind;
  label: string;
  hint: string;
}

const PROVENANCE: Record<ProvenanceKind, Provenance> = {
  bundled: {
    id: "bundled",
    label: "随包",
    hint: "随发行版分发，仅可启停",
  },
  local: { id: "local", label: "本地", hint: "在本机创建" },
  package: {
    id: "package",
    label: "安装包",
    hint: "从 zip 安装，可能包含脚本与二进制文件",
  },
  model: {
    id: "model",
    label: "模型自撰",
    hint: "由模型创建，启用前需人工复核正文",
  },
};

export const provenanceOf = (kind: ProvenanceKind): Provenance =>
  PROVENANCE[kind];

/**
 * 未审阅与停用是两档状态。前者是尚未复审，后者是复审后关闭的；合并为一个标签会使
 * 运维无法分辨哪些仍在等待处理。这条判据在四类上的形状不同，因此由各自的组件决定，
 * 但呈现（琥珀脊线与虚线边框）统一在 `.ext-row.pending-review` 中。
 */
export const skillPendingReview = (row: SkillRow): boolean =>
  row.enabled === 0 && row.source === "package";
export const customToolPendingReview = (row: CustomToolRow): boolean =>
  row.enabled === 0 && row.reviewedAt === null;

export const MCP_STATE_LABELS: Record<
  string,
  { label: string; severity: TagSeverity }
> = {
  up: { label: "已连接", severity: "success" },
  pending: { label: "等待连接", severity: "warn" },
  down: { label: "连接失败", severity: "danger" },
  /** 本轮新增。与 `down` 分开的理由是运维动作不同：这一档需要执行一次授权操作。 */
  needs_auth: { label: "要登录", severity: "warn" },
  disabled: { label: "停用", severity: "secondary" },
};

/** 上次核对超过该时长即提示数据可能陈旧。`mcp.healthCheckCron` 默认 5 分钟一次，此处留一档余量。 */
export const MCP_STALE_AFTER_MS = 6 * 60_000;

export function relativeTime(at?: number | null): string {
  if (!at) return "—";
  const delta = Date.now() - at;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

/** 距到期的剩余时长。已过期时显示「已过期」而不是负数，后者容易被误认为缺陷。 */
export function untilTime(at?: number | null): string {
  if (!at) return "不过期";
  const delta = at - Date.now();
  if (delta <= 0) return "已过期";
  if (delta < 3_600_000)
    return `${Math.max(1, Math.floor(delta / 60_000))} 分钟后到期`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时后到期`;
  return `${Math.floor(delta / 86_400_000)} 天后到期`;
}

/** 把 `provides_json` 渲染成一句摘要。解析失败时按空处理，不显示残缺的 JSON。 */
export function pluginProvides(row: PluginRow): string[] {
  if (!row.provides_json) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.provides_json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const labels: Record<string, string> = {
    tools: "工具",
    hooks: "hook",
    commands: "命令",
    agents: "Agent",
  };
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = parsed[key];
    return Array.isArray(value) && value.length
      ? [`${value.length} 个${label}`]
      : [];
  });
}
