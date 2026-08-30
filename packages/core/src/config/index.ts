import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { assignDotted, sortOverrideKeys } from "@luoli/shared";
import { configSchema, type Config } from "./schema.js";

function deepMerge(base: unknown, override: unknown): unknown {
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    !override ||
    typeof override !== "object" ||
    Array.isArray(override)
  )
    return override;
  const result: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(override))
    result[key] = deepMerge(result[key], value);
  return result;
}

function substituteEnvironment(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(
      /\$\{env:([A-Z0-9_]+)\}/g,
      (_, name: string) => process.env[name] ?? "",
    );
  if (Array.isArray(value)) return value.map(substituteEnvironment);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        substituteEnvironment(nested),
      ]),
    );
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

/**
 * 由环境变量最终决定的配置键。env 层在持久化覆盖层之后合并，因此这些键的 `config_kv` 行
 * 一律无效：WebUI 写得进去、`config_revisions` 也记录了，下一次 `loadConfig` 仍返回 env 的值。
 * 表单据此禁用它们并指明应修改哪个环境变量（`GET /api/config/schema` 的 `envPinned`），写入端直接 400：
 * 保存成功但运行时未变是 docs/20 · W-CFG-02 中最具误导性的一类，不能再新增。
 * `appliedIn: 'bot'` 的两条由 `apps/bot/src/main.ts` 的 `envOverlay` 叠加（口令要先过 argon2），
 * 钉住配置的效果与此处相同；`tests/config.persistence.test.ts` 逐条断言 env 确实压过覆盖层。
 */
export const ENV_PINNED_CONFIG_KEYS = [
  { key: "db.path", env: "LUOLI_DATA_DIR", appliedIn: "loadConfig" },
  // 媒体目录跟随数据目录，否则数据库与附件会分属两套部署，而 `gcFiles()` 判定孤儿只看数据库（docs/25 §10）。
  { key: "media.dir", env: "LUOLI_DATA_DIR", appliedIn: "loadConfig" },
  // 日志库同理。它不像媒体那样会被误删，但不跟随的后果是**读到另一套部署的日志**：
  // 主库搬走了而 `logs.dbPath` 还停在相对 cwd 的默认值上，两个实例就会往同一个文件里写。
  { key: "logs.dbPath", env: "LUOLI_DATA_DIR", appliedIn: "loadConfig" },
  {
    key: "access.bootstrapOwnerId",
    env: "LUOLI_OWNER_ID",
    appliedIn: "loadConfig",
  },
  {
    key: "sandbox.hostWorkspaceDir",
    env: "LUOLI_HOST_WORKSPACE_DIR",
    appliedIn: "loadConfig",
  },
  { key: "webui.host", env: "LUOLI_WEBUI_HOST", appliedIn: "bot" },
  { key: "webui.passwordHash", env: "WEBUI_PASSWORD", appliedIn: "bot" },
] as const satisfies ReadonlyArray<{
  key: string;
  env: string;
  appliedIn: "loadConfig" | "bot";
}>;

/** 当前进程中实际被钉住的那几条（环境变量为空或未设置时不计）。 */
export function envPinnedConfigKeys(
  environment: NodeJS.ProcessEnv = process.env,
): Array<{ key: string; env: string }> {
  return ENV_PINNED_CONFIG_KEYS.filter((entry) => environment[entry.env]).map(
    ({ key, env }) => ({ key, env }),
  );
}

export interface ConfigLoadOptions {
  path?: string;
  overrides?: Record<string, unknown>;
  requireOwner?: boolean;
  /** 覆盖层中被剔除的非法路径。调用方应当记入日志：静默丢弃配置与静默崩溃同样严重。 */
  onInvalidOverride?: (dropped: string[], messages: string[]) => void;
}

/** 从 overrides 中移除一条路径，并清理因此变空的父节点，确保重试时结构确实改变。 */
function removeOverridePath(
  root: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): boolean {
  if (!path.length) return false;
  const chain: Array<Record<string, unknown>> = [root];
  for (const part of path.slice(0, -1)) {
    const next = chain.at(-1)![String(part)];
    if (!next || typeof next !== "object" || Array.isArray(next)) return false;
    chain.push(next as Record<string, unknown>);
  }
  const leaf = String(path.at(-1));
  if (!Object.hasOwn(chain.at(-1)!, leaf)) return false;
  delete chain.at(-1)![leaf];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index]!).length) break;
    delete chain[index - 1]![String(path[index - 1])];
  }
  return true;
}

/**
 * 把 `perChat[key]` 的覆盖合并到基础配置上。写入端在 schema 中受白名单约束，
 * 因此这里可以直接深合并。无覆盖时原样返回，不产生额外对象。
 */
export function perChatConfig(
  config: Readonly<Config>,
  key: string,
): Readonly<Config> {
  const override = (config.perChat as Record<string, unknown>)[key];
  if (!override || typeof override !== "object" || Array.isArray(override))
    return config;
  return deepFreeze(deepMerge(config, override) as Config);
}

export function dottedOverrides(
  rows: Array<{ key: string; valueJson: string }>,
  onRejected?: (key: string) => void,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // 与 `readPersistedConfig` 顺序一致：先浅后深，更具体的路径优先（见 `sortOverrideKeys`）。
  for (const row of sortOverrideKeys(rows))
    if (
      !assignDotted(
        root,
        row.key,
        JSON.parse(row.valueJson, (key, value: unknown) =>
          key === "__proto__" ? undefined : value,
        ) as unknown,
      )
    )
      onRejected?.(row.key);
  return root;
}

export async function loadConfig(
  options: ConfigLoadOptions = {},
): Promise<Readonly<Config>> {
  const path = resolve(
    options.path ?? process.env.LUOLI_CONFIG ?? "./config/config.yaml",
  );
  let file: unknown = {};
  try {
    file = YAML.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // 这几条与 `ENV_PINNED_CONFIG_KEYS` 中 appliedIn:'loadConfig' 的那几条一一对应，修改时两处同步。
  const envLayer: Record<string, unknown> = {};
  if (process.env.LUOLI_DATA_DIR) {
    envLayer.db = { path: resolve(process.env.LUOLI_DATA_DIR, "luoli.db") };
    // 媒体目录必须跟随数据库。只迁移 `db.path` 而让 `media.dir` 停留在相对 cwd 的默认值上，
    // 会出现数据库在 A、附件在 B 的混合部署状态，而 `gcFiles()` 判定孤儿的依据
    // 正是数据库中是否有行指向它，于是它会把 B 中的用户数据全部当作孤儿删除。
    // 第七轮验证过程中曾因此删除 76 个附件和 90 份子 agent 全文（docs/25 §10）。
    envLayer.media = { dir: resolve(process.env.LUOLI_DATA_DIR, "files") };
    // 日志库同样跟随，理由见 `ENV_PINNED_CONFIG_KEYS` 里那一条。
    envLayer.logs = { dbPath: resolve(process.env.LUOLI_DATA_DIR, "logs.db") };
  }
  if (process.env.LUOLI_OWNER_ID)
    envLayer.access = { bootstrapOwnerId: process.env.LUOLI_OWNER_ID };
  if (process.env.LUOLI_HOST_WORKSPACE_DIR)
    envLayer.sandbox = {
      hostWorkspaceDir: process.env.LUOLI_HOST_WORKSPACE_DIR,
    };
  const overrides = structuredClone(options.overrides ?? {});
  /**
   * `${env:NAME}` 只在文件层展开。此前展开发生在三层合并之后，于是 DB 覆盖层
   * （`config_kv`，WebUI 可写）中的 `${env:LUOLI_MASTER_KEY}` 也会被展开，而 `GET /api/config`
   * 的脱敏按键名判定，向 `general.timezone` 这类键写入它即可让主密钥明文出现在响应、
   * 导出文件和 `config_revisions` 中（docs/27 · S-06）。这不构成提权（能写配置的已是 owner），
   * 但它破坏了主密钥只存在于进程内、只用于解密 provider key 这一性质。
   * 覆盖层中的 `${env:…}` 此后原样保留，一个字面量字符串不产生任何效果。
   */
  const fileLayer = substituteEnvironment(file);
  const compose = (): unknown =>
    deepMerge(deepMerge(fileLayer, overrides), envLayer);
  // 持久化覆盖层来自 WebUI 或命令写入，可能包含历史遗留的非法路径。整层丢弃过于粗暴，直接抛出会让
  // 进程无法启动（docs/19-review-round4.md · R-CFG-01），因此逐条移除出问题的路径后重试。
  let parsed = configSchema.safeParse(compose());
  const dropped: string[] = [];
  const messages: string[] = [];
  for (let attempt = 0; !parsed.success && attempt < 16; attempt += 1) {
    const removed = parsed.error.issues.filter((issue) =>
      removeOverridePath(overrides, issue.path),
    );
    if (!removed.length) break;
    for (const issue of removed) {
      dropped.push(issue.path.join("."));
      messages.push(`${issue.path.join(".")}: ${issue.message}`);
    }
    parsed = configSchema.safeParse(compose());
  }
  if (!parsed.success) throw parsed.error;
  if (dropped.length) options.onInvalidOverride?.(dropped, messages);
  if ((options.requireOwner ?? true) && !parsed.data.access.bootstrapOwnerId)
    throw new Error("access.bootstrapOwnerId: LUOLI_OWNER_ID is required");
  return deepFreeze(parsed.data);
}

export class ConfigStore {
  #current: Readonly<Config>;
  readonly #listeners = new Set<(keys: string[]) => void>();

  constructor(initial: Readonly<Config>) {
    this.#current = initial;
  }

  snapshot(): Readonly<Config> {
    return this.#current;
  }

  replace(next: Readonly<Config>, keys: string[]): void {
    this.#current = next;
    for (const listener of this.#listeners) listener(keys);
  }

  onChange(listener: (keys: string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
