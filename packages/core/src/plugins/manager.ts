import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'chokidar';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sqlite } from '@luoli/db';
import { readAppKv, writeAppKv } from '@luoli/db';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import type { ToolRegistry } from '../tools/registry.js';

/** 三个文件方法共用同一道校验：名字同时是目录段，漏一处就是一条穿越（`readSource` 曾经漏过）。 */
function assertPluginName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid_plugin_name');
}

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
      // 计时器在 finally 里清：钩子抛错时走的是 catch，`clearTimeout` 被跳过，那个定时器要留到
      // `plugins.hookTimeoutMs` 才自灭 —— 一个每条消息都抛的 onMessage 钩子就是每条消息留一个
      // 挂着的定时器（docs/27 · R-07）。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('plugin hook timeout')), this.timeoutMs);
        });
        const result = await Promise.race([Promise.resolve(hook(...arguments_)), timeout]);
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
      } finally { clearTimeout(timer); }
    }
    return output;
  }

  /**
   * 写入一个 plugin 的源码（`write_plugin` 工具、将来的 WebUI 上传）。
   *
   * **内容变了就强制打回未启用。** 这条不变量必须住在这里而不是调用方：`reconcile()` 用
   * `sha256(文件 + 配置)` 当 ESM 的 cache-busting 签名，改一个**已启用** plugin 的文件之后
   * 下一次 reconcile 就会把新代码 import 进本进程 —— 那是不经复审直接拿到 root（docs/14 A27）。
   *
   * 落盘用 tmp + rename（照 `SkillLoader.write`）：chokidar 在 `plugins.watch` 打开时盯着这个
   * 目录，写一半的文件会被它捡去 import。
   */
  async writeSource(name: string, source: string): Promise<{ name: string; path: string; created: boolean; reset: boolean; backup: string | null }> {
    assertPluginName(name);
    const directory = join(this.directory, name);
    const path = join(directory, 'plugin.js');
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const changed = previous !== source;
    const wasEnabled = (this.db.prepare('SELECT enabled FROM plugins WHERE name=?').pluck().get(name) as number | undefined) === 1;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 覆盖前留一份。这个入口现在也给模型用（`write_plugin`），而被覆盖的可能是运维手写的那份 ——
    // `plugin.js` 没有 `write_file` 那样的 backupDir / 回收站，不留档就是真的没了。
    // 备份名不叫 `plugin.js`，所以 `reconcile()` 不会去加载它。
    let backup: string | null = null;
    if (previous !== null && changed) {
      backup = join(directory, `plugin.js.bak-${Date.now()}`);
      writeFileSync(backup, previous, { encoding: 'utf8', mode: 0o600 });
    }
    const temporary = join(directory, `.plugin.js.${process.pid}.tmp`);
    writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    if (changed && wasEnabled) this.db.prepare('UPDATE plugins SET enabled=0,load_error=NULL,updated_at=? WHERE name=?').run(Date.now(), name);
    await this.reconcile();
    return { name, path, created: previous === null, reset: changed && wasEnabled, backup };
  }

  /**
   * owner 复审要看的那份正文。没有这个入口，「启用前先看过」就只是句口号。
   *
   * **名字照样要过正则。** 它是 `GET /api/plugins/:name/source` 的落点，而 Hono 的
   * `ctx.req.param()` 会做百分号解码 —— 少这一道，`..%2F..%2Fetc` 就能把 `join()` 带出插件目录，
   * 读到磁盘上任何一个叫 `plugin.js` 的文件，顺带拿到一个「这个目录存不存在」的探针。
   */
  readSource(name: string): string | null {
    assertPluginName(name);
    const path = join(this.directory, name, 'plugin.js');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  /** 连目录带库里那一行一起删。返回是否真的删掉了东西 —— 目录或行，有一个算一个。 */
  async remove(name: string): Promise<boolean> {
    assertPluginName(name);
    const directory = join(this.directory, name);
    const hadDirectory = existsSync(directory);
    if (hadDirectory) rmSync(directory, { recursive: true, force: true });
    const changes = this.db.prepare('DELETE FROM plugins WHERE name=?').run(name).changes;
    await this.reconcile();
    return hadDirectory || changes === 1;
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
