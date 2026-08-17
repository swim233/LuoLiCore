import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'chokidar';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sqlite } from '@luoli/db';
import { readAppKv, writeAppKv } from '@luoli/db';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import type { ToolRegistry } from '../tools/registry.js';

export interface LoadedPlugin {
  name: string;
  version?: string;
  hooks: Record<string, (...arguments_: unknown[]) => unknown>;
  tools: Record<string, unknown>;
  enabled: boolean;
  errors: number;
  onUnload?: () => Promise<void> | void;
  signature: string;
}

export class PluginManager {
  readonly #plugins = new Map<string, LoadedPlugin>();
  #watcher: FSWatcher | null = null;
  #reconciling = false;
  #pendingRescan = false;

  constructor(private readonly db: Sqlite, readonly directory: string, private readonly timeoutMs: number, private readonly disableAfter: number, private readonly order: readonly string[] = [], private registry?: ToolRegistry,
    private readonly onAutoDisable?: (name: string, error: string) => void) {}
  bindRegistry(registry: ToolRegistry): void { this.registry = registry; }

  async reconcile(): Promise<void> {
    if (existsSync(this.directory)) for (const name of readdirSync(this.directory)) {
      const path = join(this.directory, name, 'plugin.js');
      if (!existsSync(path)) continue;
      this.db.prepare("INSERT INTO plugins(name,path,min_role,enabled,updated_at) VALUES (?,?,'trusted',0,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path,updated_at=excluded.updated_at").run(name, path, Date.now());
    }
    const enabled = new Map((this.db.prepare('SELECT name,enabled,config_json AS config FROM plugins').all() as Array<{ name: string; enabled: number; config: string | null }>).map((row) => [row.name, row]));
    const desired = new Map<string, { path: string; row: { name: string; enabled: number; config: string | null }; signature: string }>();
    if (existsSync(this.directory)) for (const name of readdirSync(this.directory)) {
      const row = enabled.get(name);
      const path = join(this.directory, name, 'plugin.js');
      if (!row?.enabled || !existsSync(path)) continue;
      const signature = createHash('sha256').update(readFileSync(path)).update('\0').update(row.config ?? '').digest('hex');
      desired.set(name, { path, row, signature });
    }
    for (const [name, plugin] of this.#plugins) {
      if (desired.get(name)?.signature === plugin.signature) continue;
      await plugin.onUnload?.();
      this.#plugins.delete(name);
    }
    for (const [name, target] of desired) {
      if (this.#plugins.has(name)) continue;
      try {
        const imported = await import(`${pathToFileURL(target.path).href}?v=${target.signature}`) as { default?: Record<string, unknown> };
        const definition = imported.default;
        if (!definition || definition.name !== name) throw new Error('plugin name mismatch');
        const context = { name, config: target.row.config ? JSON.parse(target.row.config) as Record<string, unknown> : {}, storage: { get: (key: string) => readAppKv(this.db, `plugin:${name}.${key}`), set: (key: string, value: unknown) => writeAppKv(this.db, `plugin:${name}.${key}`, value, 'plugin') } };
        const rawTools = typeof definition.tools === 'function' ? (definition.tools as (ctx: unknown) => unknown)(context) : definition.tools;
        const plugin: LoadedPlugin = { name, signature: target.signature,
          hooks: definition.hooks && typeof definition.hooks === 'object' ? definition.hooks as LoadedPlugin['hooks'] : {},
          tools: rawTools && typeof rawTools === 'object' ? rawTools as Record<string, unknown> : {}, enabled: true, errors: 0 };
        if (typeof definition.version === 'string') plugin.version = definition.version;
        if (typeof definition.onUnload === 'function') plugin.onUnload = definition.onUnload as () => Promise<void> | void;
        if (typeof definition.onLoad === 'function') await (definition.onLoad as (ctx: unknown) => Promise<void> | void)(context);
        const definitionRole = ['blocked', 'limited', 'trusted', 'owner'].includes(String(definition.minRole)) ? String(definition.minRole) : null;
        if (definitionRole) this.db.prepare("UPDATE plugins SET min_role=CASE WHEN min_role='trusted' THEN ? ELSE min_role END WHERE name=?").run(definitionRole, name);
        this.#plugins.set(name, plugin);
        this.db.prepare('UPDATE plugins SET load_error=NULL,updated_at=? WHERE name=?').run(Date.now(), name);
      } catch (error) {
        this.db.prepare('UPDATE plugins SET load_error=?,updated_at=? WHERE name=?').run(error instanceof Error ? error.message : String(error), Date.now(), name);
      }
    }
    this.registry?.unregisterBySource('plugin');
    if (this.registry) for (const entry of this.toolEntries()) {
      const tool = entry.tool as { description?: string; inputSchema?: z.ZodType<unknown>; execute?: (input: unknown) => Promise<unknown> | unknown };
      if (!tool.execute) continue;
      const role = (this.db.prepare('SELECT min_role FROM plugins WHERE name=?').pluck().get(entry.plugin) as Role | undefined) ?? 'trusted';
      this.registry.registerExternal({ name: entry.name, description: tool.description ?? `Plugin ${entry.plugin} tool`, inputSchema: tool.inputSchema ?? z.record(z.unknown()), minRole: role, source: 'plugin', execute: tool.execute });
    }
  }

  async hook(name: string, ...arguments_: unknown[]): Promise<Array<{ plugin: string; result: unknown }>> {
    const output: Array<{ plugin: string; result: unknown }> = [];
    for (const plugin of this.list()) {
      const hook = plugin.hooks[name];
      if (!hook || !plugin.enabled) continue;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('plugin hook timeout')), this.timeoutMs);
        });
        const result = await Promise.race([Promise.resolve(hook(...arguments_)), timeout]);
        clearTimeout(timer);
        plugin.errors = 0;
        output.push({ plugin: plugin.name, result });
      } catch (error) {
        plugin.errors += 1;
        if (plugin.errors >= this.disableAfter) {
          plugin.enabled = false;
          const message = error instanceof Error ? error.message : String(error);
          this.db.prepare('UPDATE plugins SET enabled=0,load_error=?,updated_at=? WHERE name=?').run(message, Date.now(), plugin.name);
          // 自动禁用是「运维不点就永远不会恢复」的状态：不告警的话，一个 plugin 悄悄下线，
          // 用户只看到某个能力没了（`alerts.on` 的 plugin_auto_disabled）。
          this.onAutoDisable?.(plugin.name, message);
        }
      }
    }
    return output;
  }

  list(): LoadedPlugin[] {
    return [...this.#plugins.values()].sort((left, right) => {
      const li = this.order.indexOf(left.name); const ri = this.order.indexOf(right.name);
      return (li < 0 ? Number.MAX_SAFE_INTEGER : li) - (ri < 0 ? Number.MAX_SAFE_INTEGER : ri) || left.name.localeCompare(right.name);
    });
  }

  toolEntries(): Array<{ plugin: string; name: string; tool: unknown }> {
    return this.list().flatMap((plugin) => Object.entries(plugin.tools).map(([name, tool]) => ({ plugin: plugin.name, name: `${plugin.name}_${name}`, tool })));
  }

  /**
   * `plugins.watch`：目录变动后重跑 `reconcile()`。**默认关，而且应该保持关**——
   * plugin 是进程内全信任运行的（docs/14 A27），热加载等于让磁盘上的一次写入直接拿到 root。
   * 开它的唯一场景是自己在本机写 plugin。
   *
   * 与 `SkillLoader.startWatching` 同一形状：100ms 去抖（编辑器保存会连发好几个事件），
   * 重入由 `#reconciling` 挡住 —— `reconcile()` 是 async，去抖只能挡住「连发」，挡不住
   * 「上一轮还没跑完」。两轮叠着跑会让同一个 plugin 的 `onUnload` 和新实例的加载交错。
   */
  startWatching(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.directory, { ignoreInitial: true });
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.#watcher.on('all', () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { void this.#rescan(); }, 100);
    });
  }

  async #rescan(): Promise<void> {
    if (this.#reconciling) { this.#pendingRescan = true; return; }
    this.#reconciling = true;
    try {
      do { this.#pendingRescan = false; await this.reconcile(); } while (this.#pendingRescan);
    } catch { /* reconcile 自己已经把逐个 plugin 的错误记进库了；这里兜的是遍历本身失败 */ }
    finally { this.#reconciling = false; }
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = null;
    await Promise.all([...this.#plugins.values()].map((plugin) => plugin.onUnload?.()));
    this.#plugins.clear();
  }
}
