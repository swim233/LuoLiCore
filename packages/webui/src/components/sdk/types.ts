import type { GridColumn, TagSeverity } from "../../ui/types";

/**
 * SDK 接入页（来源 / 密钥）共用的行类型、列定义与纯函数（docs/12-sdk.md T3.11）。
 *
 * 放在 `.ts` 而不是留在 SFC 内：`.vue` 不进 `tsc --noEmit`（根 tsconfig 里
 * `packages/**\/*.vue` 是空转），`components/tasks/types.ts` 同理。
 */

// ── 行类型（字段对齐 `packages/server/src/sdk/admin.ts` 的响应，见 reports/T3.3.impl.md）──

/** `GET /api/sdk/sources` 的一行。内建 `telegram` 行与 `create()` 生成的 `sdk` 行同表返回。 */
export interface SourceRow {
  id: string;
  kind: "telegram" | "sdk";
  name: string;
  createdAt: number;
  disabledAt: number | null;
  /**
   * 这个来源的 SDK 会话能调哪些工具（`docs/12 §8`）。`null` = 用默认（记忆三件），
   * 空数组 = 一件都不给。两者不同，界面必须能把它们分开显示。
   */
  tools: string[] | null;
}

/** `GET /api/tools` 里本页用得上的两项：名字由键给出，值里只取这两个字段。 */
export interface ToolChoice {
  name: string;
  /** 配了也不生效（结构性禁止的派发族与 Telegram 输出，判据在服务端）。 */
  sdkForbidden: boolean;
}

/** `GET /api/sdk/sources/:id/keys` 的一行：从不携带密文，回显走单独的 `/reveal` 端点。 */
export interface ApiKeyRow {
  id: string;
  sourceId: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  disabledAt: number | null;
  lastUsedAt: number | null;
}

export const SOURCE_COLUMNS: GridColumn[] = [
  { key: "name", header: "名称" },
  { key: "kind", header: "类型" },
  { key: "state", header: "状态" },
  { key: "createdAt", header: "创建时间" },
];

export const KEY_COLUMNS: GridColumn[] = [
  { key: "id", header: "ID" },
  { key: "label", header: "备注" },
  { key: "createdAt", header: "创建时间" },
  { key: "expiresAt", header: "过期时间" },
  { key: "lastUsedAt", header: "最后使用" },
  { key: "state", header: "状态" },
  { key: "actions", header: "" },
];

export const SOURCE_KIND_LABELS: Record<SourceRow["kind"], string> = {
  telegram: "内建",
  sdk: "接入方",
};
export const SOURCE_KIND_SEVERITY: Record<SourceRow["kind"], TagSeverity> = {
  telegram: "info",
  sdk: "secondary",
};

const ACTIVE_STATE: { label: string; severity: TagSeverity } = {
  label: "启用中",
  severity: "success",
};
const DISABLED_STATE: { label: string; severity: TagSeverity } = {
  label: "已停用",
  severity: "secondary",
};

/** 来源与密钥共用同一套二态：`disabled_at` 均为软停用列，语义相同。 */
export function disabledState(disabledAt: number | null): {
  label: string;
  severity: TagSeverity;
} {
  return disabledAt === null ? ACTIVE_STATE : DISABLED_STATE;
}

/**
 * 内建来源与已停用来源不接受新签发（`admin.ts` 的 400 `source_not_sdk` / `source_disabled`）。
 * 文案与服务端错误信封逐字同源，界面不另造一套说法。空串表示可以签发。
 */
export function issueDisabledReason(source: SourceRow | null): string {
  if (!source) return "";
  if (source.kind !== "sdk") return "该来源不支持签发密钥";
  if (source.disabledAt !== null) return "来源已停用，无法签发密钥";
  return "";
}

/**
 * 默认三件。与 `SDK_AGENT_TOOLS` 同源的那份判据在服务端，这里只用于**显示**
 * 「未配置时实际生效的是哪几件」——不参与任何准入判定，写错了也只影响这一行提示文字。
 */
export const SDK_DEFAULT_TOOLS = ["memory_read", "memory_list", "memory_write"];

/**
 * 未配置（`null`）与配了空数组是两种状态，摘要文案必须把它们分开。
 *
 * 入参容忍 `undefined`：连的服务端可能还没有这一列（旧版本），那种情况等同于「用默认」，
 * 不该让整张卡在这里崩掉。
 */
export function toolsSummary(tools: string[] | null | undefined): string {
  if (tools === null || tools === undefined)
    return `默认 ${SDK_DEFAULT_TOOLS.length} 件（记忆读写）`;
  if (tools.length === 0) return "不给任何工具";
  return `${tools.length} 件`;
}

/** 归一化：非数组一律按「未配置」处理，与 `SourcesCard` 对 `sources` 的做法同一理由。 */
export function normalizeSource(row: SourceRow): SourceRow {
  return { ...row, tools: Array.isArray(row.tools) ? row.tools : null };
}
