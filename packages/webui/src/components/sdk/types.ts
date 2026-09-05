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
