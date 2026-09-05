import { randomInt, timingSafeEqual } from "node:crypto";
import type { ApiKeyRepository, ApiKeyRow } from "@luoli/db";
import type { Secrets } from "../secrets.js";

/**
 * `sk-` API key 的签发与校验（docs/12-sdk.md T3.3）。token 形态：`sk-` + id 段（16 字符）+
 * secret 段（32 字符），字母表只用 `[A-Za-z0-9]`（A10）—— 内置脱敏正则
 * `/\bsk-[A-Za-z0-9_-]{16,}\b/g`（`secrets.ts:105`）靠结尾的 `\b` 圈定匹配终点，
 * `\b` 只在字母数字与非字母数字之间成立；字母表若含 `-`/`_`，恰好落在结尾的那一个字符会让
 * `\b` 不成立，尾字符漏出脱敏。
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * `randomInt` 内部按拒绝采样实现（v8 对 crypto.randomInt 的说明），不是「取模」——
 * 62 不整除任何 2 的幂时，裸取模会让靠前的字符出现概率略高于靠后的，这里不需要自己再实现一遍。
 */
function randomToken(length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1)
    out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const TOKEN_PATTERN = /^sk-([A-Za-z0-9]{16})([A-Za-z0-9]{32})$/;

export interface IssueApiKeyInput {
  apiKeys: ApiKeyRepository;
  secrets: Secrets;
  sourceId: string;
  label?: string | null;
  expiresAt?: number | null;
}

export interface IssuedApiKey {
  /** 明文 token，`sk-<id><secret>`。只在这里与回显端点出现，`insert` 之后不再持有。 */
  token: string;
  key: Omit<ApiKeyRow, "secretEnc">;
}

/**
 * id 段由这里生成后传给 `ApiKeyRepository.insert`（该仓储自己不生成 id，见 T3.2 接口说明）。
 * 不做碰撞重试：62^16 的空间比 `sources.create()` 用的 ulid 更大，重试逻辑本身才是需要论证的
 * 复杂度，此前 `ulid()` 在同一代码库里也未做碰撞处理。
 */
export function issueApiKey(input: IssueApiKeyInput): IssuedApiKey {
  const id = randomToken(16);
  const secret = randomToken(32);
  const row = input.apiKeys.insert({
    id,
    sourceId: input.sourceId,
    secretEnc: input.secrets.encrypt(secret),
    label: input.label ?? null,
    expiresAt: input.expiresAt ?? null,
  });
  const { secretEnc: _secretEnc, ...key } = row;
  return { token: `sk-${id}${secret}`, key };
}

export interface VerifyApiKeyInput {
  apiKeys: ApiKeyRepository;
  secrets: Secrets;
  token: string;
  /** 供测试注入固定时钟；缺省 `Date.now()`。 */
  now?: number;
}

export type VerifyApiKeyResult =
  { ok: true; key: Omit<ApiKeyRow, "secretEnc"> } | { ok: false };

/**
 * id 不存在时要走的常量密文，按 `Secrets` 实例持有（`WeakMap`），每个实例只生成一次——不是每次
 * 调用都 `encrypt`（时延会随机波动，抹掉「与真实分支一致」本身的可验证性），也不用单个模块级
 * 变量跨实例共享（一个进程内可能同时存在用不同主密钥构造的 `Secrets`，例如密钥轮换窗口内新旧
 * 两份并存；共享同一份密文会让用旧实例解密新实例生成的密文这种情形提前发生，而不是只在真的
 * 轮换主密钥时才发生）。`WeakMap` 让密文随对应的 `Secrets` 实例一起被回收，不需要手动清理。
 */
const dummyCiphertexts = new WeakMap<Secrets, string>();
function dummyCiphertextFor(secrets: Secrets): string {
  const cached = dummyCiphertexts.get(secrets);
  if (cached) return cached;
  const generated = secrets.encrypt(randomToken(32));
  dummyCiphertexts.set(secrets, generated);
  return generated;
}

/**
 * 解密并常量时间比较，失败一律返回 `false`（含解密本身抛错的情形——主密钥轮换后旧密文
 * 解不开，此时不应该让请求 500，而是按「校验失败」处理，与「secret 不对」不可区分）。
 */
function decryptEquals(
  secrets: Secrets,
  ciphertext: string,
  candidate: Buffer,
): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(secrets.decrypt(ciphertext), "utf8");
  } catch {
    return false;
  }
  return (
    expected.length === candidate.length && timingSafeEqual(expected, candidate)
  );
}

/**
 * 校验流程（docs/12-sdk.md T3.3 验收 6）：id 存在与否走同一段代码——`ciphertext` 取真实行的
 * `secretEnc` 或 `dummyCiphertextFor()`，随后统一 `decryptEquals`，两分支时延一致。
 * 三类失败（id 不存在 / secret 不对 / 已停用或过期）返回值恒为 `{ ok: false }`，
 * 不带任何能区分三者的字段。
 */
export function verifyApiKey(input: VerifyApiKeyInput): VerifyApiKeyResult {
  const match = TOKEN_PATTERN.exec(input.token);
  if (!match) return { ok: false };
  const [, id, secret] = match as unknown as [string, string, string];
  const now = input.now ?? Date.now();
  const row = input.apiKeys.get(id);
  const ciphertext = row ? row.secretEnc : dummyCiphertextFor(input.secrets);
  const matches = decryptEquals(
    input.secrets,
    ciphertext,
    Buffer.from(secret, "utf8"),
  );
  if (!row || !matches) return { ok: false };
  if (row.disabledAt !== null) return { ok: false };
  if (row.sourceDisabledAt !== null) return { ok: false };
  if (row.expiresAt !== null && row.expiresAt <= now) return { ok: false };
  input.apiKeys.touchLastUsed(row.id, now);
  const { secretEnc: _secretEnc, ...key } = row;
  return { ok: true, key };
}
