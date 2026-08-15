import { randomBytes } from 'node:crypto';

export const ROLES = ['blocked', 'limited', 'trusted', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function minRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
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
  role: 'user' | 'assistant' | 'tool' | 'system';
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
  config: Readonly<Record<string, unknown>>;
}

export const untrusted = (source: string, text: string, nonce = randomBytes(6).toString('hex')): string => {
  const safeSource = source.replaceAll('&', '＆').replaceAll('"', '＂').replaceAll("'", '＇').replaceAll('<', '＜').replaceAll('>', '＞');
  const safeText = String(text).replaceAll('</untrusted-content', '<\\/untrusted-content');
  return `<untrusted-content id="${nonce}" source="${safeSource}">\n${safeText}\n</untrusted-content id="${nonce}">`;
};
