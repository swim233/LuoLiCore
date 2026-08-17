import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { assignDotted } from '@luoli/shared';
import { configSchema, type Config } from './schema.js';

function deepMerge(base: unknown, override: unknown): unknown {
  if (!base || typeof base !== 'object' || Array.isArray(base) || !override || typeof override !== 'object' || Array.isArray(override)) return override;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) result[key] = deepMerge(result[key], value);
  return result;
}

function substituteEnvironment(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
  if (Array.isArray(value)) return value.map(substituteEnvironment);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, substituteEnvironment(nested)]));
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export interface ConfigLoadOptions {
  path?: string;
  overrides?: Record<string, unknown>;
  requireOwner?: boolean;
  /** 覆盖层里被剔除的非法路径。调用方应当把它记进日志——静默丢弃配置和静默崩溃一样糟。 */
  onInvalidOverride?: (dropped: string[], messages: string[]) => void;
}

/** 从 overrides 里摘掉一条路径；顺带清掉因此变空的父节点，保证重试时形状真的变了。 */
function removeOverridePath(root: Record<string, unknown>, path: ReadonlyArray<string | number>): boolean {
  if (!path.length) return false;
  const chain: Array<Record<string, unknown>> = [root];
  for (const part of path.slice(0, -1)) {
    const next = chain.at(-1)![String(part)];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
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
 * 把 `perChat[key]` 的覆盖并到基础配置上。写入端在 schema 里受白名单约束，
 * 所以这里可以直接深合并。没有覆盖时原样返回，不产生额外对象。
 */
export function perChatConfig(config: Readonly<Config>, key: string): Readonly<Config> {
  const override = (config.perChat as Record<string, unknown>)[key];
  if (!override || typeof override !== 'object' || Array.isArray(override)) return config;
  return deepFreeze(deepMerge(config, override) as Config);
}

export function dottedOverrides(rows: Array<{ key: string; valueJson: string }>, onRejected?: (key: string) => void): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const row of rows) if (!assignDotted(root, row.key, JSON.parse(row.valueJson, (key, value: unknown) => key === '__proto__' ? undefined : value) as unknown)) onRejected?.(row.key);
  return root;
}

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<Readonly<Config>> {
  const path = resolve(options.path ?? process.env.LUOLI_CONFIG ?? './config/config.yaml');
  let file: unknown = {};
  try {
    file = YAML.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const envLayer: Record<string, unknown> = {};
  if (process.env.LUOLI_DATA_DIR) envLayer.db = { path: resolve(process.env.LUOLI_DATA_DIR, 'luoli.db') };
  if (process.env.LUOLI_OWNER_ID) envLayer.access = { bootstrapOwnerId: process.env.LUOLI_OWNER_ID };
  if (process.env.LUOLI_HOST_WORKSPACE_DIR) envLayer.sandbox = { hostWorkspaceDir: process.env.LUOLI_HOST_WORKSPACE_DIR };
  const overrides = structuredClone(options.overrides ?? {});
  const compose = (): unknown => substituteEnvironment(deepMerge(deepMerge(file, overrides), envLayer));
  // 持久化覆盖层来自 WebUI / 命令写入，可能带着历史遗留的非法路径。整层丢弃太粗暴、直接抛出会让
  // 进程再也起不来（docs/19-review-round4.md · R-CFG-01），所以逐条摘掉出问题的路径后重试。
  let parsed = configSchema.safeParse(compose());
  const dropped: string[] = [];
  const messages: string[] = [];
  for (let attempt = 0; !parsed.success && attempt < 16; attempt += 1) {
    const removed = parsed.error.issues.filter((issue) => removeOverridePath(overrides, issue.path));
    if (!removed.length) break;
    for (const issue of removed) { dropped.push(issue.path.join('.')); messages.push(`${issue.path.join('.')}: ${issue.message}`); }
    parsed = configSchema.safeParse(compose());
  }
  if (!parsed.success) throw parsed.error;
  if (dropped.length) options.onInvalidOverride?.(dropped, messages);
  if ((options.requireOwner ?? true) && !parsed.data.access.bootstrapOwnerId) throw new Error('access.bootstrapOwnerId: LUOLI_OWNER_ID is required');
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
