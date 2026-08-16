import { randomBytes } from 'node:crypto';

export const ROLES = ['blocked', 'limited', 'trusted', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function minRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
}

/**
 * 点号路径展开的唯一入口。三处（WebUI 写入、持久化覆盖层、config_kv 读取）都必须走它：
 * 裸的 `cursor[part]` 遇到 `__proto__` 会把值写进 `Object.prototype`，而这**发生在 schema 校验之前**
 * ——之后每一次 `configSchema.safeParse` 都会因为枚举到继承键而失败，配置面板被一次请求永久打死；
 * 若这样一行落进 `config_kv`，启动时重放污染会让 `removeOverridePath` 也救不回来（docs/20 · W-CFG-01）。
 * 返回 false 表示该键被拒绝，调用方必须报错或告警，不能静默丢。
 */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
export function assignDotted(root: Record<string, unknown>, key: string, value: unknown): boolean {
  const parts = key.split('.').filter(Boolean);
  if (!parts.length || parts.some((part) => FORBIDDEN_PATH_SEGMENTS.has(part))) return false;
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) { cursor[part] = value; break; }
    const current = cursor[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  return true;
}

export type Result<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string; hint?: string };

export interface AccessContext {
  userId: string;
  chatId: string;
  userRole: Role;
  chatRole: Role;
  effectiveRole: Role;
  isPrivate: boolean;
}

export interface NewContextMessage {
  id: string;
  ordinal?: number;
  // system 不在这里：AI SDK v7 的 standardizePrompt 直接拒收 messages 里的 system 消息
  // （docs/02 不变量 15）。系统旁白一律以 origin:'note' + role:'user' 落库。
  role: 'user' | 'assistant' | 'tool';
  origin: 'background' | 'trigger' | 'assistant' | 'tool_call' | 'tool_result' | 'note';
  parts: unknown[];
  textPreview?: string;
  speaker?: string;
  speakerUserId?: string;
  sourceMessageId?: number;
  sourceTs?: number;
  tokens?: number;
  pruneLevel?: number;
  meta?: Record<string, unknown>;
}

export interface MaterializedContext {
  messages: NewContextMessage[];
  ordinals: number[];
  tokens: number;
  windowStart: number;
  headOrdinal: number;
}

export interface RuntimeTurnContext {
  turnId: string;
  key: string;
  chatId: string;
  threadId: number | null;
  initiatorUserId: string;
  effectiveRole: Role;
  isPrivate: boolean;
  baseCommitId: string | null;
  claimThroughMessageId?: number;
  finalized?: boolean;
  modelAliasOverride?: string;
  snapshot: MaterializedContext;
  delta: NewContextMessage[];
  abortSignal: AbortSignal;
  loadedSkills?: Set<string>;
  skillAllowedTools?: Set<string>;
  /**
   * 本轮的配额预留（`QuotaGuard.reserve` 的返回值，结构化声明是为了不让 shared 反向依赖 core）。
   * 子 agent 必须把花费提交进同一份预留，否则日/月配额永远看不到它们（docs/20 · W-QUOTA-01）。
   */
  reservation?: { amount: number; committed: number; rows: unknown[] } | null;
  config: Readonly<Record<string, unknown>>;
}

export const untrusted = (source: string, text: string, nonce = randomBytes(6).toString('hex')): string => {
  const safeSource = source.replaceAll('&', '＆').replaceAll('"', '＂').replaceAll("'", '＇').replaceAll('<', '＜').replaceAll('>', '＞');
  const safeText = String(text).replaceAll('</untrusted-content', '<\\/untrusted-content');
  return `<untrusted-content id="${nonce}" source="${safeSource}">\n${safeText}\n</untrusted-content id="${nonce}">`;
};
