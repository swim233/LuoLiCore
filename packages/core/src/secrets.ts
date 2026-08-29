import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";

/**
 * v1 是裸 `sha256(masterKey)`：无 salt、无 KDF，`LUOLI_MASTER_KEY` 若为人工设定的口令，离线爆破
 * 成本极低（docs/20 · W-SEC-02）。v2 改用 scrypt，salt 随机且与密文一起存储，无需外部存储，
 * 也无需一次性迁移脚本：v1 密文仍可解密，`ProviderStore` 读取时顺带重写为 v2。
 * 派生结果按 salt 缓存：scrypt 一次约 50–100ms，而 `rebuild()` 会把每个 provider 的 key 都解一遍。
 */
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

export class Secrets {
  readonly #master: string | null;
  readonly #legacyKey: Buffer | null;
  readonly #derived = new Map<string, Buffer>();

  constructor(masterKey?: string) {
    this.#master = masterKey ?? null;
    this.#legacyKey = masterKey
      ? createHash("sha256").update(masterKey).digest()
      : null;
  }

  get available(): boolean {
    return this.#master !== null;
  }

  /** 主密钥过短时应在启动日志中提示：scrypt 提高了破解成本，但无法弥补一个 8 位口令。 */
  get weak(): boolean {
    return this.#master !== null && this.#master.length < 32;
  }

  /** 该密文是否仍为 v1（弱派生）。调用方据此决定是否顺带重写。 */
  static isLegacy(value: string): boolean {
    return value.startsWith("v1.");
  }

  #keyFor(salt: string): Buffer {
    if (!this.#master) throw new Error("LUOLI_MASTER_KEY is unavailable");
    const cached = this.#derived.get(salt);
    if (cached) return cached;
    const key = scryptSync(
      this.#master,
      Buffer.from(salt, "base64url"),
      32,
      SCRYPT,
    );
    this.#derived.set(salt, key);
    return key;
  }

  encrypt(value: string): string {
    if (!this.#master) throw new Error("LUOLI_MASTER_KEY is unavailable");
    const salt = randomBytes(16).toString("base64url");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#keyFor(salt), iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return `v2.${salt}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  decrypt(value: string): string {
    if (!this.#master) throw new Error("LUOLI_MASTER_KEY is unavailable");
    const parts = value.split(".");
    const [version] = parts;
    const [key, ivRaw, cipherRaw, tagRaw] =
      version === "v2"
        ? [
            parts[1] ? this.#keyFor(parts[1]) : null,
            parts[2],
            parts[3],
            parts[4],
          ]
        : [this.#legacyKey, parts[1], parts[2], parts[3]];
    if (
      (version !== "v1" && version !== "v2") ||
      !key ||
      !ivRaw ||
      !cipherRaw ||
      !tagRaw
    )
      throw new Error("Unsupported encrypted value");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

const BUILTIN_REDACTIONS = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /Bearer\s+\S+/gi,
];
const STRUCTURAL_FIELDS = new Set([
  "key",
  "kind",
  "traceId",
  "spanId",
  "parentSpanId",
  "chatId",
  "userId",
]);
const SENSITIVE_FIELD =
  /(^|_|\b)(api[_-]?key|apikey|secret|token|password|passwd|credential)s?($|_|\b)/i;

/**
 * @param extra `logs.redactPatterns`：追加到内置规则之上的正则源串，不替换内置规则。写错的正则整条跳过，
 *              而不是让脱敏整体失效：一条拼写错误的规则不应导致 bot token 泄漏。
 */
/** 编译结果按源串缓存：脱敏对每条日志执行，每次重新 new RegExp 是纯粹的浪费。 */
const patternCache = new Map<string, RegExp | null>();
function compilePatterns(sources: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    if (!patternCache.has(source)) {
      try {
        patternCache.set(source, new RegExp(source, "g"));
      } catch {
        patternCache.set(source, null);
      }
    }
    const pattern = patternCache.get(source);
    if (pattern) compiled.push(pattern);
  }
  return compiled;
}

export function redact<T>(
  value: T,
  secrets: string[] = [],
  extra: readonly string[] = [],
): T {
  const extraPatterns = compilePatterns(extra);
  const sanitizeString = (input: string): string => {
    let output = input;
    for (const pattern of BUILTIN_REDACTIONS)
      output = output.replace(pattern, "«redacted»");
    for (const pattern of extraPatterns)
      output = output.replace(pattern, "«redacted»");
    for (const secret of secrets.filter(Boolean))
      output = output.replaceAll(secret, "«redacted»");
    return output;
  };
  const sanitize = (input: unknown, key = ""): unknown => {
    if (
      !STRUCTURAL_FIELDS.has(key) &&
      SENSITIVE_FIELD.test(key) &&
      typeof input === "string" &&
      input.length > 0
    )
      return "«redacted»";
    if (typeof input === "string") return sanitizeString(input);
    if (Array.isArray(input)) return input.map((item) => sanitize(item));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([name, nested]) => [
          name,
          sanitize(nested, name),
        ]),
      );
    return input;
  };
  return sanitize(value) as T;
}
