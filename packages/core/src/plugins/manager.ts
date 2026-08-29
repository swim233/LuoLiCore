import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "chokidar";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Sqlite } from "@luoli/db";
import { readAppKv, writeAppKv } from "@luoli/db";
import { z } from "zod";
import type { Role } from "@luoli/shared";
import type { ToolRegistry } from "../tools/registry.js";
import type { LogSink } from "../log/sink.js";

/** 三个文件方法共用同一道校验：名字同时充当目录段，漏一处即构成路径穿越（`readSource` 曾漏过）。 */
function assertPluginName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error("invalid_plugin_name");
}

/**
 * 热重载在当前运行时下是否可靠。
 *
 * tsx 的 ESM loader 按文件路径缓存模块、忽略 URL 上的 `?v=`，因此 `reconcile()` 中用于
 * cache-busting 的 `import()` 在 `pnpm dev` 下完全失效：reconcile 每次都实际执行（`onUnload` /
 * `onLoad` / DB 状态均正确、无 `load_error`），但加载到的始终是本进程首次 import 的代码
 * （docs/28 · L-EXT-04）。生产环境不受影响 —— `pnpm start` 以纯 node 运行 `dist/`。
 * 修不了的问题不伪装成已修复（`docs/reviews/16 §5`），此处仅将其显式暴露。
 *
 * 判据取进程入口是否为 `.ts`，而不探测 tsx 的内部 API：能直接运行 `.ts` 入口即意味着存在一层
 * 转译 loader，其模块缓存语义不由本项目决定；而 tsx 没有稳定的存在性标记可查
 * （`process.env.TSX`、`import.meta` 上的字段都不是契约），探测结果会随其实现变更静默失效。
 * 误判为不可靠的代价只是多一条警告，误判为可靠的代价是本缺陷原样复发。
 */
export function isHotReloadReliable(
  entry: string | undefined = process.argv[1],
): boolean {
  return !/\.[cm]?ts$/.test(entry ?? "");
}

/** 启动告警与 `POST /api/plugins/:name/reload` 的响应共用同一份文案：两处表述不一致时，
 *  reload 返回 ok 与启动时的警告会被视为两件事。 */
export const HOT_RELOAD_UNRELIABLE_HINT =
  "tsx（pnpm dev）的 ESM loader 按路径缓存模块、忽略 cache-busting 查询串：重载会执行 onUnload/onLoad 并更新数据库，但加载到的仍是本进程第一次 import 的代码。重启进程或使用 pnpm build && pnpm start 以应用 plugin 更改。";

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

  constructor(
    private readonly db: Sqlite,
    readonly directory: string,
    private readonly timeoutMs: number,
    private readonly disableAfter: number,
    private readonly order: readonly string[] = [],
    private registry?: ToolRegistry,
    private readonly onAutoDisable?: (name: string, error: string) => void,
    /**
     * 插件行为此前全程不可观测：单次钩子失败只做 `plugin.errors += 1`，须累计到
     * `plugins.autoDisableAfterErrors` 才经告警落一行，而该行还受 `alerts.on`（默认 `[]`）与
     * `dedupeMinutes` 约束 —— 实测一个三轮必抛的 `beforeTurn`，与 plugin 相关的日志为 0 条
     * （docs/28 · L-LOG-01）。可选：测试与 CLI 场景可不提供，行为不变。
     */
    private readonly log?: LogSink,
  ) {}

  /**
   * `plugin.hook` 只记录耗时超标的那次。钩子每轮执行多次（`onToolCall` 每次工具调用一次，
   * 一轮四十次工具调用 × 三个插件 = 两百余条），逐次记录会淹没 `logs.level='debug'` 的部署，
   * 而钩子耗时 3ms 不构成任何排障答案。判据取超时预算的十分之一（下限 50ms），
   * 即已消耗 10% 预算的那次；运维调小 `plugins.hookTimeoutMs` 时该阈值同步收紧。
   * 判据同时记录在 `docs/10 §2` 的 `plugin.hook` 行。
   */
  get #slowHookMs(): number {
    return Math.max(50, this.timeoutMs / 10);
  }
  bindRegistry(registry: ToolRegistry): void {
    this.registry = registry;
  }
  /** 只读判据而非开关 —— 见 `isHotReloadReliable`。`plugins.watch` 的既定用途是本机开发
   *  plugin，而那恰是其静默失效的场景，因此调用方（启动告警 / reload 端点）必须显式提示。 */
  get hotReloadReliable(): boolean {
    return isHotReloadReliable();
  }
  /** 不可靠时返回提示文案，可靠时返回 `null`。使两处调用方共用同一份字符串。 */
  get hotReloadWarning(): string | null {
    return this.hotReloadReliable ? null : HOT_RELOAD_UNRELIABLE_HINT;
  }

  async reconcile(): Promise<void> {
    if (existsSync(this.directory))
      for (const name of readdirSync(this.directory)) {
        const path = join(this.directory, name, "plugin.js");
        if (!existsSync(path)) continue;
        this.db
          .prepare(
            "INSERT INTO plugins(name,path,min_role,enabled,updated_at) VALUES (?,?,'trusted',0,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path,updated_at=excluded.updated_at",
          )
          .run(name, path, Date.now());
      }
    const enabled = new Map(
      (
        this.db
          .prepare("SELECT name,enabled,config_json AS config FROM plugins")
          .all() as Array<{
          name: string;
          enabled: number;
          config: string | null;
        }>
      ).map((row) => [row.name, row]),
    );
    const desired = new Map<
      string,
      {
        path: string;
        row: { name: string; enabled: number; config: string | null };
        signature: string;
      }
    >();
    if (existsSync(this.directory))
      for (const name of readdirSync(this.directory)) {
        const row = enabled.get(name);
        const path = join(this.directory, name, "plugin.js");
        if (!row?.enabled || !existsSync(path)) continue;
        const signature = createHash("sha256")
          .update(readFileSync(path))
          .update("\0")
          .update(row.config ?? "")
          .digest("hex");
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
        const imported = (await import(
          `${pathToFileURL(target.path).href}?v=${target.signature}`
        )) as { default?: Record<string, unknown> };
        const definition = imported.default;
        if (!definition || definition.name !== name)
          throw new Error("plugin name mismatch");
        const context = {
          name,
          config: target.row.config
            ? (JSON.parse(target.row.config) as Record<string, unknown>)
            : {},
          storage: {
            get: (key: string) => readAppKv(this.db, `plugin:${name}.${key}`),
            set: (key: string, value: unknown) =>
              writeAppKv(this.db, `plugin:${name}.${key}`, value, "plugin"),
          },
        };
        const rawTools =
          typeof definition.tools === "function"
            ? (definition.tools as (ctx: unknown) => unknown)(context)
            : definition.tools;
        const plugin: LoadedPlugin = {
          name,
          signature: target.signature,
          hooks:
            definition.hooks && typeof definition.hooks === "object"
              ? (definition.hooks as LoadedPlugin["hooks"])
              : {},
          tools:
            rawTools && typeof rawTools === "object"
              ? (rawTools as Record<string, unknown>)
              : {},
          enabled: true,
          errors: 0,
        };
        if (typeof definition.version === "string")
          plugin.version = definition.version;
        if (typeof definition.onUnload === "function")
          plugin.onUnload = definition.onUnload as () => Promise<void> | void;
        if (typeof definition.onLoad === "function")
          await (definition.onLoad as (ctx: unknown) => Promise<void> | void)(
            context,
          );
        const definitionRole = [
          "blocked",
          "limited",
          "trusted",
          "owner",
        ].includes(String(definition.minRole))
          ? String(definition.minRole)
          : null;
        if (definitionRole)
          this.db
            .prepare(
              "UPDATE plugins SET min_role=CASE WHEN min_role='trusted' THEN ? ELSE min_role END WHERE name=?",
            )
            .run(definitionRole, name);
        this.#plugins.set(name, plugin);
        // `version` 与 `provides_json` 两列建表时即存在，扩展页也一直读取（`pluginProvides`），
        // 但此前没有任何一条 SQL 写入过它们 —— 导致每张 plugin 卡片都显示未声明任何
        // tool / hook / command，即便该 plugin 已注册两个工具且已列入模型目录
        // （docs/29 · M-WEB-14）。写入的是本次实际装载的内容，而非清单中的声明。
        this.db
          .prepare(
            "UPDATE plugins SET version=?,provides_json=?,load_error=NULL,updated_at=? WHERE name=?",
          )
          .run(
            plugin.version ?? null,
            JSON.stringify({
              tools: Object.keys(plugin.tools),
              hooks: Object.keys(plugin.hooks),
            }),
            Date.now(),
            name,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 加载失败即未提供任何能力：保留上一次的 `provides_json` 会使卡片一边报错一边显示
        // 2 个工具，而本轮这两个工具均不存在。
        this.db
          .prepare(
            "UPDATE plugins SET provides_json=NULL,load_error=?,updated_at=? WHERE name=?",
          )
          .run(message, Date.now(), name);
        // `load_error` 列仅扩展页读取。加载失败与钩子失败共用同一个 kind（对运维是同一件事：
        // 该 plugin 未生效），通过 `phase` 区分 —— 与 `agent.file_invalid` 对称。
        this.log?.event({
          level: "warn",
          kind: "plugin.error",
          summary: `${name} 加载失败：${message}`.slice(0, 300),
          data: { plugin: name, phase: "load", message: message.slice(0, 500) },
        });
      }
    }
    this.registry?.unregisterBySource("plugin");
    if (this.registry)
      for (const entry of this.toolEntries()) {
        const tool = entry.tool as {
          description?: string;
          inputSchema?: z.ZodType<unknown>;
          execute?: (input: unknown) => Promise<unknown> | unknown;
        };
        if (!tool.execute) continue;
        const role =
          (this.db
            .prepare("SELECT min_role FROM plugins WHERE name=?")
            .pluck()
            .get(entry.plugin) as Role | undefined) ?? "trusted";
        this.registry.registerExternal({
          name: entry.name,
          description: tool.description ?? `Plugin ${entry.plugin} tool`,
          inputSchema: tool.inputSchema ?? z.record(z.unknown()),
          minRole: role,
          source: "plugin",
          execute: tool.execute,
        });
      }
  }

  async hook(
    name: string,
    ...arguments_: unknown[]
  ): Promise<Array<{ plugin: string; result: unknown }>> {
    const output: Array<{ plugin: string; result: unknown }> = [];
    for (const plugin of this.list()) {
      const hook = plugin.hooks[name];
      if (!hook || !plugin.enabled) continue;
      // 定时器在 finally 中清理：钩子抛错时走 catch 分支，`clearTimeout` 被跳过，定时器要到
      // `plugins.hookTimeoutMs` 才自行结束 —— 一个每条消息都抛错的 onMessage 钩子会为每条消息
      // 遗留一个挂起的定时器（docs/27 · R-07）。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("plugin hook timeout")),
            this.timeoutMs,
          );
        });
        const result = await Promise.race([
          Promise.resolve(hook(...arguments_)),
          timeout,
        ]);
        plugin.errors = 0;
        const elapsed = Math.round(performance.now() - started);
        if (elapsed >= this.#slowHookMs)
          this.log?.event({
            level: "debug",
            kind: "plugin.hook",
            summary: `${plugin.name}.${name} ${elapsed}ms`,
            durationMs: elapsed,
            data: { plugin: plugin.name, hook: name, ms: elapsed },
          });
        output.push({ plugin: plugin.name, result });
      } catch (error) {
        plugin.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        const disabled = plugin.errors >= this.disableAfter;
        // 每次失败均记录，不等累计到自动禁用阈值：前 `disableAfter - 1` 次此前完全静默。
        this.log?.event({
          level: "warn",
          kind: "plugin.error",
          summary: `${plugin.name}.${name}: ${message}`.slice(0, 300),
          durationMs: Math.round(performance.now() - started),
          data: {
            plugin: plugin.name,
            hook: name,
            message: message.slice(0, 500),
            errors: plugin.errors,
            disabled,
          },
        });
        if (disabled) {
          plugin.enabled = false;
          this.db
            .prepare(
              "UPDATE plugins SET enabled=0,provides_json=NULL,load_error=?,updated_at=? WHERE name=?",
            )
            .run(message, Date.now(), plugin.name);
          // 自动禁用是需运维手动恢复的终态：不告警时 plugin 会静默下线，
          // 用户只观察到某项能力消失（`alerts.on` 的 plugin_auto_disabled）。
          this.onAutoDisable?.(plugin.name, message);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return output;
  }

  /**
   * 写入一个 plugin 的源码（`write_plugin` 工具、后续的 WebUI 上传）。
   *
   * 内容变更即强制回退为未启用。该不变量必须由本函数保证而非调用方：`reconcile()` 用
   * `sha256(文件 + 配置)` 作为 ESM 的 cache-busting 签名，修改一个已启用 plugin 的文件后
   * 下一次 reconcile 会把新代码 import 进本进程 —— 等于未经复审直接取得 root（docs/14 A27）。
   *
   * 落盘用 tmp + rename（参照 `SkillLoader.write`）：`plugins.watch` 开启时 chokidar 监视该
   * 目录，写入未完成的文件会被其 import。
   */
  async writeSource(
    name: string,
    source: string,
  ): Promise<{
    name: string;
    path: string;
    created: boolean;
    reset: boolean;
    backup: string | null;
  }> {
    assertPluginName(name);
    const directory = join(this.directory, name);
    const path = join(directory, "plugin.js");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    const changed = previous !== source;
    const wasEnabled =
      (this.db
        .prepare("SELECT enabled FROM plugins WHERE name=?")
        .pluck()
        .get(name) as number | undefined) === 1;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 覆盖前保留备份。该入口现在也开放给模型（`write_plugin`），被覆盖的可能是运维手写的版本 ——
    // `plugin.js` 没有 `write_file` 那样的 backupDir / 回收站，不留档即不可恢复。
    // 备份文件不命名为 `plugin.js`，因此 `reconcile()` 不会加载它。
    let backup: string | null = null;
    if (previous !== null && changed) {
      backup = join(directory, `plugin.js.bak-${Date.now()}`);
      writeFileSync(backup, previous, { encoding: "utf8", mode: 0o600 });
    }
    const temporary = join(directory, `.plugin.js.${process.pid}.tmp`);
    writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    if (changed && wasEnabled)
      this.db
        .prepare(
          "UPDATE plugins SET enabled=0,load_error=NULL,updated_at=? WHERE name=?",
        )
        .run(Date.now(), name);
    await this.reconcile();
    return {
      name,
      path,
      created: previous === null,
      reset: changed && wasEnabled,
      backup,
    };
  }

  /**
   * owner 复审所需的源码正文。缺少该入口时，启用前先复审无法落实。
   *
   * 名字仍须通过正则校验。本函数是 `GET /api/plugins/:name/source` 的落点，而 Hono 的
   * `ctx.req.param()` 会做百分号解码 —— 缺少该校验时 `..%2F..%2Fetc` 可使 `join()` 逃出插件目录，
   * 读取磁盘上任意名为 `plugin.js` 的文件，并附带一个目录存在性探针。
   */
  readSource(name: string): string | null {
    assertPluginName(name);
    const path = join(this.directory, name, "plugin.js");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /** 同时删除目录与库中对应行。返回是否实际删除了内容 —— 目录或行任一命中即为真。 */
  async remove(name: string): Promise<boolean> {
    assertPluginName(name);
    const directory = join(this.directory, name);
    const hadDirectory = existsSync(directory);
    if (hadDirectory) rmSync(directory, { recursive: true, force: true });
    const changes = this.db
      .prepare("DELETE FROM plugins WHERE name=?")
      .run(name).changes;
    await this.reconcile();
    return hadDirectory || changes === 1;
  }

  list(): LoadedPlugin[] {
    return [...this.#plugins.values()].sort((left, right) => {
      const li = this.order.indexOf(left.name);
      const ri = this.order.indexOf(right.name);
      return (
        (li < 0 ? Number.MAX_SAFE_INTEGER : li) -
          (ri < 0 ? Number.MAX_SAFE_INTEGER : ri) ||
        left.name.localeCompare(right.name)
      );
    });
  }

  toolEntries(): Array<{ plugin: string; name: string; tool: unknown }> {
    return this.list().flatMap((plugin) =>
      Object.entries(plugin.tools).map(([name, tool]) => ({
        plugin: plugin.name,
        name: `${plugin.name}_${name}`,
        tool,
      })),
    );
  }

  /**
   * `plugins.watch`：目录变动后重跑 `reconcile()`。默认关闭且应保持关闭 ——
   * plugin 在进程内全信任运行（docs/14 A27），热加载等于让磁盘上的一次写入直接取得 root。
   * 唯一适用场景是本机开发 plugin，而该场景通常使用 `pnpm dev`（tsx），
   * 恰是重载静默失效的运行时（`isHotReloadReliable`，docs/28 · L-EXT-04）。
   *
   * 与 `SkillLoader.startWatching` 结构一致：100ms 去抖（编辑器保存会连发多个事件），
   * 重入由 `#reconciling` 拦截 —— `reconcile()` 是 async，去抖只能合并连发事件，无法阻止
   * 上一轮尚未完成时再次进入。两轮重叠会使同一 plugin 的 `onUnload` 与新实例加载交错。
   */
  startWatching(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.directory, { ignoreInitial: true });
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.#watcher.on("all", () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        void this.#rescan();
      }, 100);
    });
  }

  async #rescan(): Promise<void> {
    if (this.#reconciling) {
      this.#pendingRescan = true;
      return;
    }
    this.#reconciling = true;
    try {
      do {
        this.#pendingRescan = false;
        await this.reconcile();
      } while (this.#pendingRescan);
    } catch (error) {
      // 捕获的是遍历本身的失败（目录不可读、`unregisterBySource` 抛错）。单个 plugin 的错误由
      // `reconcile()` 记录，但本层此前是空 catch：`plugins.watch` 开启时一次目录扫描失败
      // 不会留下任何痕迹。
      this.log?.event({
        level: "warn",
        kind: "plugin.error",
        summary:
          `插件目录重扫失败：${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
        data: {
          phase: "rescan",
          message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
        },
      });
    } finally {
      this.#reconciling = false;
    }
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = null;
    await Promise.all(
      [...this.#plugins.values()].map((plugin) => plugin.onUnload?.()),
    );
    this.#plugins.clear();
  }
}
