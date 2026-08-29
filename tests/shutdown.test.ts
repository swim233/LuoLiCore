import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { code, codeIndex, source } from './support/source.js';

/**
 * SIGTERM 退出路径（docs/24 §3 指出的两处测试空白之一）。两条用例的覆盖面不同，
 * 各自的边界写明，避免误以为一条通过即覆盖全部：
 *
 * 1. 真实进程：启动进程 → 建立一条 SSE 连接 → 发送 SIGTERM → 在 `graceMs + 1s` 内以 0 退出。
 *    这正是 `docs/22 §6.1` 建议的方式。它拦截的是 `D-OPS-02`：SSE 的 heartbeat 与未关闭的连接
 *    会让 `http.close` 永不回调，进程只能等待 SIGKILL。
 * 2. 源码级：关停路径必须仍然调用 `turnRegistry.abortAll`。这一条拦截的是 `R-OPS-01`：
 *    修复 D-OPS-02 时该调用被删除，`abortAll` 一度成为全仓库只有测试在调用的方法。
 *    不用真实进程验证它的原因：触发它需要一个在宽限期内无法排空的在途轮次，而在途轮次只能
 *    从 Telegram 入口产生，而本测试必须清空 `BOT_TOKEN`（否则会抢占本机运行中 bot 的
 *    长轮询）。源码断言比一条无法实际验证的声明更可靠。
 */

const PORT = 8799;
/** 崩溃那条用例使用独立端口：它需要启动两个进程，与上面那条共用端口会让监听方变成竞态。 */
const CRASH_PORT = 8801;
const GRACE_MS = 2000;

interface Started { child: ReturnType<typeof spawn>; stderr: string[]; stdout: string[] }

/** @param options.imports 额外的 `--import`，位于入口之前；崩溃那条用例借此把触发器注入真实进程。 */
async function startBot(dataDir: string, options: { port?: number; imports?: readonly string[] } = {}): Promise<Started> {
  const port = options.port ?? PORT;
  const imports = (options.imports ?? []).flatMap((path) => ['--import', pathToFileURL(path).href]);
  const child = spawn(process.execPath, ['--import', 'tsx', ...imports, resolve('apps/bot/src/main.ts')], {
    env: {
      ...process.env,
      // BOT_TOKEN 必须为空：提供真实 token 时该测试进程会抢占 getUpdates 的长轮询，
      // 导致本机运行中的 bot 掉线。Telegram 入口禁用时 WebUI 仍会启动，本用例验证的正是它。
      BOT_TOKEN: '',
      LUOLI_OWNER_ID: '1',
      LUOLI_MASTER_KEY: 'x'.repeat(32),
      WEBUI_PASSWORD: 'shutdown-test-password',
      LUOLI_DATA_DIR: dataDir,
      LUOLI_WEBUI_HOST: '127.0.0.1',
      LUOLI_CONFIG: resolve(dataDir, 'config.yaml'),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  // 等待 HTTP 端口确实开始监听。采用轮询而非 sleep：tsx 冷启动在慢机器上可能需要数秒。
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bot 启动就退出了（code ${child.exitCode}）：\n${stderr.join('')}${stdout.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch { /* 尚未启动 */ }
    if (Date.now() > deadline) {
      // 若保留它，下一次运行本用例时 `/api/health` 会立即响应，而该响应来自上一次遗留的
      // 进程，新启动的进程仍在初始化且尚未占用端口，导致断言全部作用于错误的进程。
      child.kill('SIGKILL');
      throw new Error(`bot 在 40s 内没有开始监听：\n${stderr.join('')}${stdout.join('')}`);
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  return { child, stdout, stderr };
}

/** SIGKILL 仍存活的进程，并等待端口确实释放；断言失败时同样需要清理干净（同上）。 */
async function reap(children: readonly ReturnType<typeof spawn>[]): Promise<void> {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const deadline = Date.now() + 5000;
  while (children.some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline)
    await new Promise((settle) => setTimeout(settle, 50));
}

describe('SIGTERM 退出路径', () => {
  it('挂着一条 SSE 连接时也能在宽限期内自己退干净', async () => {
    const dataDir = resolve('./data/shutdown-test');
    rmSync(dataDir, { recursive: true, force: true });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
    // 宽限期缩短至 2s：默认 30s 会让本用例本身耗时三十秒。
    writeFileSync(resolve(dataDir, 'config.yaml'), `general:\n  shutdown:\n    graceMs: ${GRACE_MS}\nwebui:\n  port: ${PORT}\n`);

    const { child, stdout, stderr } = await startBot(dataDir);
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once('exit', (code, signal) => { exited = { code, signal }; });

    // SSE：在 `EventStreamRegistry.closeAll()` 与 `await http.close()` 之前，仅这一条连接就足以让
    // `http.close` 永不回调（keep-alive 的流无人关闭），进程只能等待 SIGKILL。
    const abort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${PORT}/api/events`, { signal: abort.signal }).catch(() => null);

    const sentAt = Date.now();
    child.kill('SIGTERM');
    // 上界为 graceMs + 1s，与 docs/22 §6.1 的建议一致。
    const limit = GRACE_MS + 1000;
    while (!exited && Date.now() - sentAt < limit + 500) await new Promise((settle) => setTimeout(settle, 50));
    const elapsed = Date.now() - sentAt;
    abort.abort();
    void stream;

    if (!exited) { child.kill('SIGKILL'); throw new Error(`SIGTERM 之后 ${elapsed}ms 仍未退出\n${stderr.join('')}${stdout.join('')}`); }
    const outcome = exited as { code: number | null; signal: NodeJS.Signals | null };
    expect(outcome.signal, `进程是被信号杀掉的而不是自己退的\n${stderr.join('')}`).toBeNull();
    expect(outcome.code, `退出码不是 0\n${stderr.join('')}`).toBe(0);
    expect(elapsed, `退出用了 ${elapsed}ms，超过 graceMs + 1s`).toBeLessThan(limit);
    // 关停路径上的那条日志必须仍命名为 `system.stop`：`docs/10 §7.4` 的事件表记录的即是它，改名会
    // 导致文档与实现不一致（R-OPS-01 一并修复的正是这一点）。
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain('system.shutdown');
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);

  it('关停路径仍然中断排不空的在途轮次', () => {
    const main = source('apps/bot/src/main.ts');
    // `drain()` 只负责等待。宽限期内未排空的轮次必须被主动 abort，否则要么把进程拖到 systemd 的
    // SIGKILL，要么在退出后留下 running 行等待下次 recoverAfterCrash 处理（docs/24 · R-OPS-01）。
    expect(main).toContain(code("turnRegistry.abortAll('shutdown')"));
    // `drain` 的返回值必须被使用：`await turnRegistry.drain(graceMs)` 丢弃返回值正是那次回归的形态。
    expect(main).toMatch(/if\s*\(!\(await turnRegistry\.drain\(/);
    // 收尾三项同样固定（同一次回归中被替换的）：带 checkpoint 的关闭数据库、事件名、skills 的 await。
    expect(main).toContain(code('closeDatabase(db)'));
    expect(main).toContain(code("kind: 'system.stop'"));
    expect(main).toContain(code('await skills.close()'));
  });

  /**
   * `docs/reviews/28 · L-OPS-02`：HTTP 自 `serve()` 起即开始监听，而 `restart`、信号处理器与
   * crash handler 此前都位于文件末尾。窗口期内收到 `POST /api/restart` 会得到
   * `ReferenceError: Cannot access 'restart' before initialization`，而 `uncaughtException`
   * 尚未注册，因此不留下任何日志（实测 2/2）。
   *
   * 采用源码级断言而非真实进程：该窗口仅约 1 秒，依靠竞态触发的测试会是本仓最不稳定的
   * 一条。而装配顺序是静态事实，固定它即可。
   */
  it('关停 / 重启 / 崩溃处理器都装在 HTTP 开始监听之前', () => {
    const main = source('apps/bot/src/main.ts');
    const listen = codeIndex(main, 'http = config.webui.enabled ? serve(');
    expect(listen, '找不到 HTTP 监听那一行 —— 这条断言的锚点没了').toBeGreaterThan(0);
    for (const marker of ['const restart = async (reason: string)', 'const shutdown = async (signal: string)',
      "process.once('SIGTERM'", "process.once('SIGINT'", "process.on('uncaughtException'", "process.on('unhandledRejection'"]) {
      const at = codeIndex(main, marker);
      expect(at, `找不到 ${marker}`).toBeGreaterThan(0);
      expect(at, `${marker} 排在 serve() 之后 —— 启动窗口里它不可用`).toBeLessThan(listen);
    }
    // `http` 必须声明为 `let`：改回 `const` 只是把 TDZ 从 `restart` 转移到 `http` 上。
    // 空白压平后无法锚定行首，因此正反各断言一次，比原先的 `/^let http: /m` 更严格。
    expect(main).toContain(code('let http:'));
    expect(main).not.toContain(code('const http:'));
    // webhook 模式的那个 throw 同样要在监听之前，否则 `/api/health` 会在整个窗口期内返回 ok。
    expect(codeIndex(main, 'is not implemented; only polling is supported')).toBeLessThan(listen);
  });

  /**
   * 关停时被中止的长轮询不属于 Telegram 故障。
   *
   * 生产库中 `kind='tg.api' AND level='error'` 共 42 条，全部落在某次 `system.stop` 的 3 秒内
   * （共 56 次关停），即该部署至今没有发生过一次真实的 Telegram API 故障，而日志中留有 42 条
   * error 级噪声：真实故障与正常重启在日志上表现相同（docs/28 · L-TG-01）。`UpdatePoller.stop()` 会 abort
   * 在途的 `getUpdates`，`#fetch` 的 catch 确实吞掉了它，但 span 在更低一层（transformer）已记为
   * error。降级本身（`span().end()` 的 level 覆盖）由 `log.span.test.ts` 固定，这里固定的是接线：
   * 判据必须由装配方实际传入，否则 transformer 无从得知系统正在关停。
   */
  it('关停判据从 main.ts 传进 Telegram transformer，且只对 abort 生效', () => {
    const main = source('apps/bot/src/main.ts');
    expect(main, 'main.ts 没把关停判据传给 createTelegramBot').toContain(code('stopping: () => shuttingDown'));
    const bot = source('packages/telegram/src/bot.ts');
    // transformer 那一段：判据是 `stopping() && isAbortLike(error)`；关停期间确实发生 API 故障
    // （发送最后一条消息被拒）仍记为 error，这是收窄而非放行。
    expect(bot).toContain(code('dependencies.stopping?.() === true && isAbortLike(error)'));
    expect(bot).toContain(code("reason: 'shutdown'"));
    expect(bot).toContain(code("{ level: 'info', summary: `${method} aborted during shutdown` }"));
    // `stopping` 必须可选：缺失时行为与此前一致（适用于测试与未启用 Telegram 的部署）。
    expect(bot).toContain(code('stopping?: () => boolean;'));
  });

  /**
   * `docs/reviews/28 · L-OPS-01`：第二个实例启动会直接把在位实例仍在执行的轮次改为
   * `failed/process_restarted`、释放已认领的消息、清零在途预留，结果是后启动者获胜。
   * 这里直接测试那把锁，而不是启动两个真实进程（后者需要 40 秒乘以 2 才能得到同一判据）。
   */
  it('同一个库上第二个实例拿不到锁，而主人死掉之后能被接手', async () => {
    const { acquireInstanceLock } = await import('@luoli/db');
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const holderPid = (file: string): number => (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid;
    const dir = resolve('./data/lock-test');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const dbPath = resolve(dir, 'luoli.db');

    const first = acquireInstanceLock(dbPath);
    expect(first.ok).toBe(true);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    // 同一进程再次获取同样视为在位：用一个真实存在的其他 pid 模拟在位实例。
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), host: 'somewhere' }));
    const second = acquireInstanceLock(dbPath);
    expect(second.ok, '主人还活着的时候不该放行').toBe(false);
    if (!second.ok) expect(second.holder.pid).toBe(process.ppid);

    // 持有者已退出：pid 使用一个不可能存在的值。接管成功，并报告原有的 pid。
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0x7ff_ffff, startedAt: 1, host: 'gone' }));
    const third = acquireInstanceLock(dbPath);
    expect(third.ok, 'stale 锁必须能被接手，否则一次崩溃就要人手动删文件').toBe(true);
    if (third.ok) {
      expect(third.lock.stolenFrom).toBe(0x7ff_ffff);
      // 抢占按代进行：第 1 代的那个 claim 即为胜出凭据，release 需要一并清除它。
      expect(existsSync(`${dbPath}.lock.1`)).toBe(true);
      third.lock.release();
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
      expect(existsSync(`${dbPath}.lock.1`)).toBe(false);
    }

    /**
     * 抢占不能依靠写入后回读来判定胜负：write 与 read 是两次 syscall，在 `write(A) → read(A) →
     * write(B) → read(B)` 的时序下两个进程都会读到自己的 pid，于是两个实例同时进入 `recoverAfterCrash`，
     * 而这正是本锁要防止的情形。判据是同一代的 claim 只能由一个进程独占创建，因此当该代
     * 已被一个存活进程占用时，后来者必须被拒绝，即使锁文件中的 pid 已经退出。
     */
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0x7ff_ffff, startedAt: 1, host: 'gone', gen: 0 }));
    writeFileSync(`${dbPath}.lock.1`, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), host: 'somewhere', gen: 1 }));
    const raced = acquireInstanceLock(dbPath);
    expect(raced.ok, '这一代已经被活着的进程抢走了，后来者不该也拿到锁').toBe(false);
    if (!raced.ok) expect(raced.holder.pid).toBe(process.ppid);
    // 失败的一方不得覆盖锁文件：覆盖后两个实例都会认为自己在位。
    expect(holderPid(`${dbPath}.lock`)).toBe(0x7ff_ffff);

    // 抢占方在创建 claim 之后、写入锁文件之前崩溃：该代归属已退出的进程，继续尝试下一代，
    // 而不是永久拒绝后续实例。胜出方顺带清除更早的 claim。
    writeFileSync(`${dbPath}.lock.1`, JSON.stringify({ pid: 0x7ff_fffe, startedAt: 1, host: 'gone', gen: 1 }));
    const fourth = acquireInstanceLock(dbPath);
    expect(fourth.ok, 'claim 的主人也死了时必须能往下一代找').toBe(true);
    if (fourth.ok) {
      expect(existsSync(`${dbPath}.lock.2`)).toBe(true);
      expect(existsSync(`${dbPath}.lock.1`), '赢的那个要清掉更早的 claim').toBe(false);
      expect(holderPid(`${dbPath}.lock`)).toBe(process.pid);
      fourth.lock.release();
    }

    // 锁文件损坏（手工编辑或写入中断）时视为无持有者，而不是永久拒绝后续实例。
    writeFileSync(`${dbPath}.lock`, '{ 半截');
    expect(acquireInstanceLock(dbPath).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('拿锁排在 recoverAfterCrash 之前', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    // 若顺序颠倒，被拒绝启动的实例会先把在位实例的在途轮次判为失败，拒绝启动
    // 就变成了自身不运行却破坏了在位实例。
    expect(source.indexOf('acquireInstanceLock(')).toBeLessThan(source.indexOf('recoverAfterCrash(db)'));
  });
});

/**
 * `system.crash` 与 `system.unhandled_rejection` 的行为契约（`docs/10 §2` 的事件表）。
 * 核心要求是两者都不允许在日志中不留痕迹：曾经有一次 uncaught 的流错误直接终止了进程，
 * 日志中没有任何记录，排查只能翻查 `turns` 表推测最后一条 `turn.start` 之后发生了什么。
 *
 * 采用真实进程：那两个处理器固定在 `apps/bot/src/main.ts` 模块顶层，没有可单独 import 的导出，
 * 而在测试中复制一份等于验证了另一个实现。因此启动真实进程，用 `--import` 加载一个仅负责触发的 fixture
 * （`tests/fixtures/fatal-trigger.mjs`，它不复制处理器），再检查 stderr、落盘的
 * `system.jsonl` 以及进程是否退出。
 */
describe('崩溃与未处理的 rejection', () => {
  it('unhandledRejection 只留证据不退出，uncaughtException 落 system.crash 后才退出，下次启动照常收尾', async () => {
    const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
    const { closeDatabase, openDatabase } = await import('@luoli/db');
    const dataDir = resolve('./data/crash-test');
    const logsDir = resolve(dataDir, 'logs');
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    // `logs.dir` 默认为 cwd 下的 `./logs`，与本机运行中的 bot 共用同一目录，断言会读到其他进程的记录。
    //
    // `sandbox.dockerBin` 必须指向一个必然失败的目标。启动时那次 `void reapContainers()`
    // 在 `sandbox.persistent.enabled=false`（默认）下会执行 `#sweepOrphans(counts, new Set())`：
    // 宿主上每一个带 `luoli.managed=1` 标签的容器都不在那张空表中，于是逐个执行 `docker rm -f`。
    // 本用例启动两次进程，相当于把 `sandbox.containers.docker.test.ts` 正在使用的容器删除两次。
    writeFileSync(resolve(dataDir, 'config.yaml'),
      `general:\n  shutdown:\n    graceMs: ${GRACE_MS}\nwebui:\n  port: ${CRASH_PORT}\nlogs:\n  dir: ${logsDir}\nsandbox:\n  mode: none\n  dockerBin: /bin/false\n`);
    /** 落盘的 system.jsonl。按 UTC 日期分目录，因此扫描目录而非自行计算当天日期（跨零点会出错）。 */
    interface Line { level: string; kind: string; data?: { event?: string; detail?: string } }
    const systemLog = (): Line[] => (existsSync(logsDir) ? readdirSync(logsDir, { withFileTypes: true }) : [])
      .filter((entry) => entry.isDirectory()).map((entry) => resolve(logsDir, entry.name, 'system.jsonl'))
      .filter((path) => existsSync(path))
      // 只读取完整的行：urgent 档使用 appendFileSync，读取时可能正遇到其他进程写入到一半。
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.startsWith('{') && line.endsWith('}'))
        .map((line) => JSON.parse(line) as Line));

    // 启动过的进程一律登记：断言中途失败也要清理干净，否则它会占用 8801 端口直到下一次运行本用例。
    const running: Array<ReturnType<typeof spawn>> = [];
    try {
      const crashed = await startBot(dataDir, { port: CRASH_PORT, imports: [resolve('tests/fixtures/fatal-trigger.mjs')] });
      running.push(crashed.child);
      // 等待 `close` 而非 `exit`：子进程写入管道的 stderr 是异步的，`exit` 时刻最后一批数据
      // 可能尚未到达父进程，而 stderr 中是否包含崩溃原因正是本用例要断言的内容之一。
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      crashed.child.once('close', (code, signal) => { exited = { code, signal }; });

      // 第一步触发 unhandledRejection。日志与 stderr 两侧都要等待：前者通过 appendFileSync
      // 立即落盘，后者需经过管道传输，只等待前者会让 stderr 的断言随机落空。
      const wrote = (marker: string): boolean => crashed.stderr.join('').includes(marker);
      const rejectionDeadline = Date.now() + 20_000;
      crashed.child.kill('SIGUSR2');
      while (!(systemLog().some((line) => line.kind === 'system.unhandled_rejection') && wrote('[unhandled] unhandledRejection:'))
        && Date.now() < rejectionDeadline) await new Promise((settle) => setTimeout(settle, 100));
      const rejection = systemLog().find((line) => line.kind === 'system.unhandled_rejection');
      expect(rejection, `一个泄漏的 promise 在日志里一个字都没留下\n${crashed.stderr.join('')}`).toBeDefined();
      expect(rejection!.level).toBe('error');
      expect(rejection!.data?.event).toBe('unhandledRejection');
      // detail 记录的是 stack 而非单句 message：没有调用栈时该日志只能说明存在一个未处理的 promise。
      expect(rejection!.data?.detail).toContain('luoli-fatal-fixture-rejection');
      expect(rejection!.data?.detail).toMatch(/\n\s+at /);
      expect(wrote('[unhandled] unhandledRejection:'), 'stderr 上没有那条 rejection').toBe(true);
      // 进程不退出：rejection 属于单次调用失败，而非进程级不可恢复状态。上一版两者共用一个
      // 处理器并一律 exit(1)，代价是某个私聊中泄漏的一个 promise 终止了当时所有并发轮次。
      expect(exited, 'unhandledRejection 把进程带走了').toBeNull();
      expect((await fetch(`http://127.0.0.1:${CRASH_PORT}/api/health`)).ok, 'rejection 之后 HTTP 面不再服务').toBe(true);

      // 第二步触发 uncaughtException。
      crashed.child.kill('SIGUSR2');
      const exitDeadline = Date.now() + 30_000;
      while (!exited && Date.now() < exitDeadline) await new Promise((settle) => setTimeout(settle, 50));
      if (!exited) throw new Error(`uncaughtException 之后 30s 仍未退出\n${crashed.stderr.join('')}`);
      const outcome = exited as { code: number | null; signal: NodeJS.Signals | null };
      expect(outcome.code, `退出码不是 1\n${crashed.stderr.join('')}`).toBe(1);
      expect(wrote('[crash] uncaughtException:'), 'stderr 上没有崩溃原因 —— 日志写不进去时它是最后一道').toBe(true);
      // 这一行在 `process.exit(1)` 之前完成写入：`system.crash` 在 LogSink 中走 urgent 档
      // （appendFileSync 立即落盘），依赖那个 200ms 的缓冲定时器时进程已经退出。
      const crash = systemLog().find((line) => line.kind === 'system.crash');
      expect(crash, '崩溃在日志里一个字都没留下').toBeDefined();
      expect(crash!.level).toBe('error');
      expect(crash!.data?.event).toBe('uncaughtException');
      expect(crash!.data?.detail).toContain('luoli-fatal-fixture-exception');
      expect(crash!.data?.detail).toMatch(/\n\s+at /);

      // 崩溃路径不自行收尾（崩溃的含义即在于此）：数据库中残留的在途轮次交由下一次启动的 recoverAfterCrash 处理。
      const dbPath = resolve(dataDir, 'luoli.db');
      const seed = openDatabase(dbPath);
      seed.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,queued_at,started_at) VALUES('turn-crashed','chat:1','1','2','trusted','running',?,?)")
        .run(Date.now(), Date.now());
      closeDatabase(seed);
      const restarted = await startBot(dataDir, { port: CRASH_PORT });
      running.push(restarted.child);
      const after = openDatabase(dbPath);
      const row = after.prepare("SELECT state, error FROM turns WHERE id='turn-crashed'").get() as { state: string; error: string } | undefined;
      // 不调用 closeDatabase：其中的 `wal_checkpoint(TRUNCATE)` 会与在位实例竞争。
      after.close();
      expect(row, '在途轮次没被判死 —— 它会一直挂在 running 上').toMatchObject({ state: 'failed', error: 'process_restarted' });
      expect(systemLog().some((line) => line.kind === 'system.recovered'), '一次非正常重启 reap 了什么在日志里没有痕迹').toBe(true);
      // 崩溃未执行 shutdown，锁文件保持原样；下一个实例按持有者已退出接管，而不是被永久拒绝。
      expect(restarted.stdout.join('')).toContain('[lock] 已接管');
    } finally {
      await reap(running);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});
