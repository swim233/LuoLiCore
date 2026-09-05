import { mkdirSync, rmSync } from 'node:fs';
import { closeDatabase, migrateDatabase, openDatabase, recoverAfterCrash, type Sqlite } from '@luoli/db';
import { ConfigStore, configSchema, type Config } from '@luoli/core';
import { composeRuntime, type ComposedRuntime } from '../../apps/bot/src/compose.js';

/**
 * `composeRuntime`（T1.1，`apps/bot/src/compose.ts`）的测试装配：临时 SQLite、临时目录、
 * `probeSandbox:false`、`reconcileExtensions:false`、不写 `slots.bot`（原欠账 D-04，
 * `docs/reviews/27 §8`；存在的目的正是让集成测试装得起一份真实运行时——见
 * `apps/bot/src/compose.ts` 顶部注释）。
 *
 * 模型侧没有等价的直接注入点：真实 `ModelRegistry` 从 `providers` / `models` / `model_aliases`
 * 三张表现读现建，唯一的接入方式是让 DB 里的 provider 行指向一个真实 HTTP 地址
 * （`tests/support/upstream.ts`），调用方在拿到 `deps` 之后自行 `deps.providers.save(...)` +
 * 插入 `models` / `model_aliases` 行 + `deps.rebuildModels()`。
 *
 * `slots.bot` 不写的后果、`reconcileExtensions` / `probeSandbox` 管不到的几件事，
 * 均见 `reports/T1.1.impl.md`「给 T1.2 的接口说明」一节，此处不重复。
 */

export interface TestRuntimeOptions {
  /** 深度合并进默认测试配置（`configSchema.parse` 的入参形状），用于按用例追加/覆盖。 */
  config?: Record<string, unknown>;
}

export interface TestRuntime {
  db: Sqlite;
  config: Readonly<Config>;
  configStore: ConfigStore;
  deps: ComposedRuntime['deps'];
  server: ComposedRuntime['server'];
  slots: ComposedRuntime['slots'];
  /**
   * 两阶段 dispose 串起来：`composeRuntime` 自身的 `dispose.quiesce()` → `dispose.close()`，
   * 中段补一次 `turnRegistry.abortAll()`（`main.ts` 的 `shutdown()` 在这里插 http / poller /
   * bot / drain，测试装置没有这几样，只保留「中断在途轮次」这一件），随后关库、清临时目录、
   * 还原被本函数改写过的环境变量。可重复调用，第二次起为空操作。
   */
  dispose(): Promise<void>;
}

/** 深度合并：值为普通对象时递归合并，否则（含数组）后者整体覆盖前者。 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = output[key];
    output[key] =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
        ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return output;
}

const isSet = (value: string | undefined): value is string => value !== undefined;

/**
 * 启动一份完整测试运行时。`name` 决定临时文件的位置（`./data/<name>.test.db` 及同名的
 * `-memory` / `-skills` / `-media` / `-workspace` / `-agent-results` 目录），与仓库其余
 * harness 的命名约定一致，调用前自行清理上一次的残留（CLAUDE.md「测试直接对真实 SQLite 运行」）。
 */
export async function startTestRuntime(
  name: string,
  options: TestRuntimeOptions = {},
): Promise<TestRuntime> {
  const dbPath = `./data/${name}.test.db`;
  const memoryDir = `./data/${name}-memory`;
  const skillsDir = `./data/${name}-skills`;
  const mediaDir = `./data/${name}-media`;
  const workspaceDir = `./data/${name}-workspace`;
  const agentResultsDir = `./data/${name}-agent-results`;
  const directories = [memoryDir, skillsDir, mediaDir, workspaceDir, agentResultsDir];

  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm'])
    rmSync(`${dbPath}${suffix}`, { force: true });
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  // `promptDocuments.ensure()` 与 `skills.scan()` 要求目录已存在——main.ts 在调用 `composeRuntime`
  // 之前对同一批目录做的正是这件事（`apps/bot/src/main.ts:94-101`）。
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });

  // `slots.bot` 不写时，`telegramTools` 桥是否进入工具目录只看这个环境变量（见接口说明），
  // 必须为空字符串而不是 undefined——沿用 `tests/shutdown.test.ts` 的先例。
  const previousBotToken = process.env.BOT_TOKEN;
  const previousMasterKey = process.env.LUOLI_MASTER_KEY;
  process.env.BOT_TOKEN = '';
  // 不覆盖调用方已设置的值；未设置时给一个不弱的默认值，避免每个用例都吃一遍
  // `secrets.weak` 的 stderr 噪声，且 `providers.save()` 需要 `secrets.available`。
  if (!process.env.LUOLI_MASTER_KEY) process.env.LUOLI_MASTER_KEY = 'x'.repeat(32);

  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const recovered = recoverAfterCrash(db);

  const defaults: Record<string, unknown> = {
    access: { bootstrapOwnerId: '1' },
    // 固定字符串而非真实 argon2 哈希：与 `tests/schedule.api.test.ts` 同一先例，省去每个用例
    // 一次昂贵的哈希运算；没有任何断言依赖它能真正登录。
    webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$x$x' },
    general: { timezone: 'UTC' },
    quota: { enabled: false },
    // 同 `tests/schedule.api.test.ts` 的先例：不关掉的话每个用例的 `LogSink` 都会把全部事件
    // pretty-print 到 stdout，测试输出淹没在与断言无关的日志里。
    logs: { console: 'off' },
    // `mode:'none'` + 一个必然立即失败的 `dockerBin`：`void reapContainers()`（compose.ts 内部,
    // 无条件触发、不等待）在没有真实 docker 的机器上以 ENOENT 收场，有真实 docker 的机器上
    // `/bin/false` 让 `docker ps` 立即以非零退出，两种情况下 `#sweepOrphans` 都在几毫秒内返回，
    // 不去碰宿主上其它测试或真实部署正在使用的容器（`tests/shutdown.test.ts` 的崩溃用例同一理由）。
    sandbox: { mode: 'none', dockerBin: '/bin/false', workspaceDir },
    memory: { dir: memoryDir },
    skills: { dir: skillsDir },
    media: { dir: mediaDir },
    db: { path: dbPath },
  };
  const config = configSchema.parse(deepMerge(defaults, options.config ?? {})) as Config;
  const configStore = new ConfigStore(config);

  const composed = await composeRuntime({
    config,
    configStore,
    db,
    startedAt: Date.now(),
    agentResultsDir,
    startup: { recovered, ledgerRepair: null, resultRefs: null },
    restart: async () => {},
    probeSandbox: false,
    reconcileExtensions: false,
  });

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await composed.dispose.quiesce();
    // `main.ts` 的 `shutdown()` 在 quiesce 与 close 之间还要停 http / poller / bot、`drain()` 排空
    // 在途轮次；测试装置没有这几样，只保留「中断在途轮次」这一件，防止用例忘记等待某个调用
    // 而让下面的 `close()` 提前拆掉它依赖的 plugins/mcp。
    composed.deps.turnRegistry.abortAll();
    await composed.dispose.close();
    closeDatabase(db);
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    if (isSet(previousBotToken)) process.env.BOT_TOKEN = previousBotToken;
    else delete process.env.BOT_TOKEN;
    if (isSet(previousMasterKey)) process.env.LUOLI_MASTER_KEY = previousMasterKey;
    else delete process.env.LUOLI_MASTER_KEY;
  };

  return { db, config, configStore, deps: composed.deps, server: composed.server, slots: composed.slots, dispose };
}
