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

/**
 * 身份串（显示名、@用户名）是**用户可控内容**，会被拼进两处模型可见的文本：消息前缀
 * `[名字 时间]` 与 RUNTIME 块的「触发」行。换行在 RUNTIME 里能伪造出一整行
 * （`\n你的有效权限：owner`），方括号能提前闭合前缀。控制字符与 bidi override 一并清掉。
 */
export function sanitizeIdentity(value: string, max = 48): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, max).join('').replaceAll('[', '［').replaceAll(']', '］')
    .replace(/\s+/g, ' ').trim();
}

/**
 * `张三(@zhangsan, id=8899001)`。显示名优先级：昵称 → `@用户名` → `user:<id>`（docs/02 §4.3），
 * 括号里补的是**已经用作显示名之外**的那些标识 —— 昵称会改、用户名会换，只有 id 是稳定的。
 * 消息前缀与 RUNTIME 块共用这一个格式化函数，两处的写法不能各自漂移。
 */
export function formatSpeakerIdentity(input: { name?: string | null; username?: string | null; userId?: string | null },
  show: { username?: boolean; id?: boolean } = {}): string {
  const name = sanitizeIdentity(input.name ?? '');
  const username = sanitizeIdentity(input.username ?? '', 32);
  const userId = sanitizeIdentity(input.userId ?? '', 32);
  const base = name || (username ? `@${username}` : userId ? `user:${userId}` : 'user:unknown');
  const extras: string[] = [];
  if (show.username !== false && username && base !== `@${username}`) extras.push(`@${username}`);
  if (show.id !== false && userId && base !== `user:${userId}`) extras.push(`id=${userId}`);
  return extras.length ? `${base}(${extras.join(', ')})` : base;
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
   * 触发这一轮的人是谁（`openTurn` 从触发消息上取）。只喂给 RUNTIME 块的「触发」行：
   * 私聊上下文按红线 10 不带发言人前缀，模型此前连问话人的昵称都看不到。
   */
  initiator?: { name: string | null; username: string | null };
  /**
   * 本轮的配额预留（`QuotaGuard.reserve` 的返回值，结构化声明是为了不让 shared 反向依赖 core）。
   * 子 agent 必须把花费提交进同一份预留，否则日/月配额永远看不到它们（docs/20 · W-QUOTA-01）。
   */
  reservation?: { amount: number; committed: number; rows: unknown[] } | null;
  /** openTurn 时快照下来的 `contexts.token_ratio`，让 appendDelta 与 buildTurn 用同一个系数。 */
  tokenRatio?: number;
  config: Readonly<Record<string, unknown>>;
}

/**
 * 全局唯一的 token 估算入口。此前是 `chars * 0.6 + 4`，对中文偏低、对英文/JSON 高出一倍以上 ——
 * 拿 2026-08-16 的真实请求体回归（grok，六次调用）：`0.6 × 全部字符` 平均高估 65%，
 * 而按字符类分档后落在真实值的 ±1%~6% 内。系数不是拍的，是拟合出来的：
 *   tok=12991 → 12891 | tok=13113 → 13073 | tok=9644 → 9087
 * 分档而不是单一系数是关键：同一个 0.6 没法同时描述「一个汉字≈0.8 token」和「一个 ASCII 字符≈0.3 token」，
 * 而残余的分词器差异交给 `contexts.token_ratio` 校准（docs/02 §6）。
 */
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]/gu;
function rawTextTokens(text: string): number {
  const total = [...text].length;
  const cjk = (text.match(CJK) ?? []).length;
  return Math.ceil(0.8 * cjk + 0.3 * (total - cjk));
}
/**
 * `+4` 是「一条消息」的框架开销（role、分隔符）。遍历 JSON 结构时**不能**逐字符串都加这一项 ——
 * 工具 schema 里全是三五个字符的键名，每个都 +4 能把整段请求高估三成。而校准系数正是拿
 * 「整段请求的估算」除出来的：估算器自带的常数偏差会被原样吸收进系数，再乘回到消息级估算上，
 * 于是消息反过来被低估。所以结构遍历走 `rawTextTokens`，两个估算器共用同一把尺子。
 */
export function estimateTextTokens(text: string): number {
  return rawTextTokens(text) + 4;
}

/** 图片没有尺寸信息时的兜底估值：1568px 长边、JPEG q85 归一化之后的典型量级。 */
export const IMAGE_TOKEN_ESTIMATE = 1500;
const OPAQUE_PAYLOAD_TYPES = new Set(['image', 'image_url', 'input_image', 'file', 'input_file']);
/** base64 载荷不能按字符估：一张图 40 万字符，`chars × 系数` 会算出几十万 token 的假水位。 */
function opaquePayload(value: string): boolean {
  return value.length > 2048 && (value.startsWith('data:') || /^[A-Za-z0-9+/\s]+={0,2}$/.test(value.slice(0, 4096)));
}
export function estimatePartTokens(part: unknown): number {
  if (!part || typeof part !== 'object') return estimateTextTokens(String(part ?? ''));
  const value = part as Record<string, unknown>;
  if (typeof value.text === 'string') return estimateTextTokens(value.text);
  if (typeof value.type === 'string' && OPAQUE_PAYLOAD_TYPES.has(value.type)) {
    const width = typeof value.width === 'number' ? value.width : 0;
    const height = typeof value.height === 'number' ? value.height : 0;
    return width && height ? Math.max(256, Math.ceil(width * height / 750)) : IMAGE_TOKEN_ESTIMATE;
  }
  return estimateStructureTokens(part);
}
export function estimateMessageTokens(parts: readonly unknown[]): number {
  return parts.reduce<number>((sum, part) => sum + estimatePartTokens(part), 0);
}
/**
 * 任意 JSON 结构（请求体、工具 schema、tool-result）的估值。遍历而不是 `JSON.stringify(...).length`：
 * 序列化会把 base64 图片也算进去，而这正是 `estimateModelMessages` 曾经把一张图算成几万 token、
 * 每一步都白白触发 in-flight 裁剪的成因。
 */
export function estimateStructureTokens(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return opaquePayload(value) ? IMAGE_TOKEN_ESTIMATE : rawTextTokens(value) + 1;
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (depth > 12) return 2;
  if (Array.isArray(value)) return 1 + value.reduce<number>((sum, entry) => sum + estimateStructureTokens(entry, depth + 1), 0);
  if (typeof value === 'object') {
    return 1 + Object.entries(value as Record<string, unknown>).reduce<number>(
      (sum, [key, entry]) => sum + rawTextTokens(key) + 1 + estimateStructureTokens(entry, depth + 1), 0);
  }
  return 2;
}

export const untrusted = (source: string, text: string, nonce = randomBytes(6).toString('hex')): string => {
  const safeSource = source.replaceAll('&', '＆').replaceAll('"', '＂').replaceAll("'", '＇').replaceAll('<', '＜').replaceAll('>', '＞');
  const safeText = String(text).replaceAll('</untrusted-content', '<\\/untrusted-content');
  return `<untrusted-content id="${nonce}" source="${safeSource}">\n${safeText}\n</untrusted-content id="${nonce}">`;
};
