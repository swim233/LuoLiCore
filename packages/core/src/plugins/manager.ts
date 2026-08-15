import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
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

  constructor(private readonly db: Sqlite, readonly directory: string, private readonly timeoutMs: number, private readonly disableAfter: number, private readonly order: readonly string[] = [], private registry?: ToolRegistry) {}
  bindRegistry(registry: ToolRegistry): void { this.registry = registry; }

  async reconcile(): Promise<void> {
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
          this.db.prepare('UPDATE plugins SET enabled=0,load_error=?,updated_at=? WHERE name=?').run(error instanceof Error ? error.message : String(error), Date.now(), plugin.name);
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

  async close(): Promise<void> {
    await Promise.all([...this.#plugins.values()].map((plugin) => plugin.onUnload?.()));
    this.#plugins.clear();
  }
}
