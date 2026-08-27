import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { code, codeIndex, source } from './support/source.js';

/**
 * SIGTERM 退出路径（docs/24 §3 点名的两处测试空白之一）。两条腿，覆盖面**不一样**，
 * 各自的边界写清楚，别让人以为一条绿灯管了全部：
 *
 * 1. **真实进程**：起进程 → 建一条 SSE 连接 → SIGTERM → 在 `graceMs + 1s` 内以 0 退出。
 *    这正是 `docs/22 §6.1` 建议的那条。它挡的是 `D-OPS-02`：SSE 的 heartbeat 与未关闭的连接
 *    会让 `http.close` 永远不回调，进程只能等 SIGKILL。
 * 2. **源码级**：关停路径必须仍然调 `turnRegistry.abortAll`。这一条挡的是 `R-OPS-01` ——
 *    修 D-OPS-02 时那句被删了，`abortAll` 一度成为全仓库只剩测试在调的方法。
 *    **为什么不用真实进程测它**：要触发它得有一个在宽限期内排不空的在途轮次，而在途轮次只能
 *    从 Telegram 入口开出来，这个测试又必须把 `BOT_TOKEN` 清空（否则会抢走本机在跑的那个 bot 的
 *    长轮询）。源码断言比一条测不到的空话诚实。
 */

const PORT = 8799;
/** 崩溃那条用例自己一个端口：它要连起两个进程，与上面那条共用端口的话「谁在听」会变成竞态。 */
const CRASH_PORT = 8801;
const GRACE_MS = 2000;

interface Started { child: ReturnType<typeof spawn>; stderr: string[]; stdout: string[] }

/** @param options.imports 额外的 `--import`，排在入口之前 —— 崩溃那条用例靠它把扳机塞进真进程。 */
async function startBot(dataDir: string, options: { port?: number; imports?: readonly string[] } = {}): Promise<Started> {
  const port = options.port ?? PORT;
  const imports = (options.imports ?? []).flatMap((path) => ['--import', pathToFileURL(path).href]);
  const child = spawn(process.execPath, ['--import', 'tsx', ...imports, resolve('apps/bot/src/main.ts')], {
    env: {
      ...process.env,
      // **BOT_TOKEN 必须为空**：给了真 token 的话这个测试进程会抢走 getUpdates 的长轮询，
      // 把本机在跑的那个 bot 挤下线。Telegram 入口禁用时 WebUI 照常起 —— 这里要测的就是它。
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
  // 等到 HTTP 面真的在听。轮询而不是 sleep：tsx 冷启动在慢机器上能到好几秒。
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bot 启动就退出了（code ${child.exitCode}）：\n${stderr.join('')}${stdout.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) {
      // 留下它的话，下一次跑这份用例时 `/api/health` 会当场答应 —— 而那个 ok 来自上一次跑剩的
      // 进程，新起的那个还在启动、端口也还没抢到，于是断言全打在错的进程上。
      child.kill('SIGKILL');
      throw new Error(`bot 在 40s 内没有开始监听：\n${stderr.join('')}${stdout.join('')}`);
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  return { child, stdout, stderr };
}

/** SIGKILL 掉还活着的那些，并等端口真的松手 —— 断言失败时也要收干净（同上）。 */
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
    // 宽限期压到 2s：默认 30s 会让这条用例本身变成一次三十秒的等待。
    writeFileSync(resolve(dataDir, 'config.yaml'), `general:\n  shutdown:\n    graceMs: ${GRACE_MS}\nwebui:\n  port: ${PORT}\n`);

    const { child, stdout, stderr } = await startBot(dataDir);
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once('exit', (code, signal) => { exited = { code, signal }; });

    // SSE：`EventStreamRegistry.closeAll()` + `await http.close()` 之前，这一条连接足以让
    // `http.close` 永远不回调（keep-alive 的流没人关），进程只能等 SIGKILL。
    const abort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${PORT}/api/events`, { signal: abort.signal }).catch(() => null);

    const sentAt = Date.now();
    child.kill('SIGTERM');
    // 上界 = graceMs + 1s，与 docs/22 §6.1 建议的那条一致。
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
    // 关停路径上那条日志必须还叫 `system.stop`：`docs/10 §7.4` 的事件表写的是它，改名等于
    // 让文档与实现对不上（R-OPS-01 一并修的就是这个）。
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain('system.shutdown');
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);

  it('关停路径仍然中断排不空的在途轮次', () => {
    const main = source('apps/bot/src/main.ts');
    // `drain()` 只是等。宽限期内没排空的轮次必须被主动 abort，否则要么把进程拖到 systemd 的
    // SIGKILL，要么在退出后留下 running 行等下次 recoverAfterCrash 认领（docs/24 · R-OPS-01）。
    expect(main).toContain(code("turnRegistry.abortAll('shutdown')"));
    // `drain` 的返回值必须被用上：`await turnRegistry.drain(graceMs)` 丢弃返回值正是那次回归的形态。
    expect(main).toMatch(/if\s*\(!\(await turnRegistry\.drain\(/);
    // 收尾三件也一并钉住（同一次回归里被换掉的）：带 checkpoint 的关库、事件名、skills 的 await。
    expect(main).toContain(code('closeDatabase(db)'));
    expect(main).toContain(code("kind: 'system.stop'"));
    expect(main).toContain(code('await skills.close()'));
  });

  /**
   * `docs/reviews/28 · L-OPS-02`：HTTP 从 `serve()` 起就在听，而 `restart` / 信号处理器 /
   * crash handler 此前都排在文件末尾 —— 窗口内 `POST /api/restart` 打进来是
   * `ReferenceError: Cannot access 'restart' before initialization`，而 `uncaughtException`
   * 也还没挂上，于是**一个字都不落**（实测 2/2）。
   *
   * 源码级断言而不是真实进程：那个窗口只有 1 秒上下，靠 race 去打它的测试会是本仓最不稳的
   * 一条。装配顺序反过来是**静态**的事实，钉住它就够了。
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
    // `http` 必须是 `let`：改回 `const` 只是把 TDZ 从 `restart` 挪到 `http` 上。
    // 压平之后没有行首可锚，所以正反各断一次 —— 比原先那条 `/^let http: /m` 还紧一格。
    expect(main).toContain(code('let http:'));
    expect(main).not.toContain(code('const http:'));
    // webhook 模式那个 throw 也要在监听之前 —— 否则 `/api/health` 会先回一整个窗口的 ok。
    expect(codeIndex(main, 'is not implemented; only polling is supported')).toBeLessThan(listen);
  });

  /**
   * 关停时被中止的长轮询不是 Telegram 故障。
   *
   * 生产库 `kind='tg.api' AND level='error'` 共 **42 条，42/42** 落在某次 `system.stop` 的 3 秒内
   * （56 次关停）—— 也就是说这个部署至今没有过一次真实的 Telegram API 故障，而日志里躺着 42 条
   * error 级噪声：真出故障时与正常重启长得一样（docs/28 · L-TG-01）。`UpdatePoller.stop()` abort 掉
   * 在途 `getUpdates`，`#fetch` 的 catch 确实吞掉了它，但 span 在更低一层（transformer）已经记成
   * error 了。降级本身（`span().end()` 的 level 覆盖）由 `log.span.test.ts` 钉住，这里钉的是**接线**：
   * 判据要真的从装配方传进来，否则 transformer 永远不知道「我们正在关停」。
   */
  it('关停判据从 main.ts 传进 Telegram transformer，且只对 abort 生效', () => {
    const main = source('apps/bot/src/main.ts');
    expect(main, 'main.ts 没把关停判据传给 createTelegramBot').toContain(code('stopping: () => shuttingDown'));
    const bot = source('packages/telegram/src/bot.ts');
    // transformer 那一段：判据是 `stopping() && isAbortLike(error)` —— 关停期间**真的**出 API 故障
    // （发最后一条消息被拒）照旧记 error，这是收窄不是放行。
    expect(bot).toContain(code('dependencies.stopping?.() === true && isAbortLike(error)'));
    expect(bot).toContain(code("reason: 'shutdown'"));
    expect(bot).toContain(code("{ level: 'info', summary: `${method} aborted during shutdown` }"));
    // `stopping` 必须是可选的：缺它时行为与从前一致（测试与不装 Telegram 的部署）。
    expect(bot).toContain(code('stopping?: () => boolean;'));
  });

  /**
   * `docs/reviews/28 · L-OPS-01`：第二个实例启动会就地把在位实例**仍在执行**的轮次改成
   * `failed/process_restarted`、释放已认领的消息、清零在途预留 —— 赢的是后来者。
   * 这里直接测那把锁，而不是起两个真进程（后者要 40 秒 × 2 才能拿到同一个判据）。
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
    // 同一个进程再拿一次也算「在位」—— 用一个真实存在的别的 pid 冒充在位实例。
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), host: 'somewhere' }));
    const second = acquireInstanceLock(dbPath);
    expect(second.ok, '主人还活着的时候不该放行').toBe(false);
    if (!second.ok) expect(second.holder.pid).toBe(process.ppid);

    // 主人已经死了：pid 用一个不可能存在的值。接手成功，并说出原来那个 pid。
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0x7ff_ffff, startedAt: 1, host: 'gone' }));
    const third = acquireInstanceLock(dbPath);
    expect(third.ok, 'stale 锁必须能被接手，否则一次崩溃就要人手动删文件').toBe(true);
    if (third.ok) {
      expect(third.lock.stolenFrom).toBe(0x7ff_ffff);
      // 抢占按代走：第 1 代那个 claim 就是「谁赢」的凭据，release 要把它一起带走。
      expect(existsSync(`${dbPath}.lock.1`)).toBe(true);
      third.lock.release();
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
      expect(existsSync(`${dbPath}.lock.1`)).toBe(false);
    }

    /**
     * **抢占不能靠写完回读定胜负**：write 与 read 是两次 syscall，`write(A) → read(A) →
     * write(B) → read(B)` 下两个进程都读到自己的 pid，于是两个实例一起进 `recoverAfterCrash`
     * —— 正是这把锁要挡的那件事。判据是「同一代的 claim 只能被一个进程独占创建」，所以这一代
     * 已经被一个**活着**的进程拿走时，后来者必须被拒，哪怕锁文件里那个 pid 已经死了。
     */
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0x7ff_ffff, startedAt: 1, host: 'gone', gen: 0 }));
    writeFileSync(`${dbPath}.lock.1`, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), host: 'somewhere', gen: 1 }));
    const raced = acquireInstanceLock(dbPath);
    expect(raced.ok, '这一代已经被活着的进程抢走了，后来者不该也拿到锁').toBe(false);
    if (!raced.ok) expect(raced.holder.pid).toBe(process.ppid);
    // 输的那个不许覆盖锁文件：覆盖了就是两个实例都认为自己在位。
    expect(holderPid(`${dbPath}.lock`)).toBe(0x7ff_ffff);

    // 抢占方崩在「建了 claim 还没装上锁文件」那一刻：那一代属于死进程，往下一代继续找，
    // 而不是把人永久锁在外面。赢的那个顺手清掉更早的 claim。
    writeFileSync(`${dbPath}.lock.1`, JSON.stringify({ pid: 0x7ff_fffe, startedAt: 1, host: 'gone', gen: 1 }));
    const fourth = acquireInstanceLock(dbPath);
    expect(fourth.ok, 'claim 的主人也死了时必须能往下一代找').toBe(true);
    if (fourth.ok) {
      expect(existsSync(`${dbPath}.lock.2`)).toBe(true);
      expect(existsSync(`${dbPath}.lock.1`), '赢的那个要清掉更早的 claim').toBe(false);
      expect(holderPid(`${dbPath}.lock`)).toBe(process.pid);
      fourth.lock.release();
    }

    // 锁文件被改坏（手工编辑、写了一半）时当成没有主人，而不是把人永久锁在外面。
    writeFileSync(`${dbPath}.lock`, '{ 半截');
    expect(acquireInstanceLock(dbPath).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('拿锁排在 recoverAfterCrash 之前', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    // 顺序反过来的话，被拒绝启动的那个实例已经先把在位实例的在途轮次判死了 —— 拒绝启动
    // 就成了「我不跑，但我顺手把你弄坏了」。
    expect(source.indexOf('acquireInstanceLock(')).toBeLessThan(source.indexOf('recoverAfterCrash(db)'));
  });
});

/**
 * `system.crash` 与 `system.unhandled_rejection` 的**行为**契约（`docs/10 §2` 的事件表）。
 * 「两种都不允许在日志里不留痕迹」是这一条的全部：曾经有一次 uncaught 的流错误把进程直接带走、
 * 日志里一个字都没有，排查只能靠翻 `turns` 表猜「最后一条 `turn.start` 之后发生了什么」。
 *
 * **真进程**：那两个处理器焊在 `apps/bot/src/main.ts` 模块顶层，没有可单独 import 的导出，
 * 而照抄一份到测试里等于测了个假的。所以起真进程，`--import` 一个只负责扣扳机的 fixture
 * （`tests/fixtures/fatal-trigger.mjs`，它不复刻处理器），再去看 stderr、看落盘的
 * `system.jsonl`、看进程死没死。
 */
describe('崩溃与未处理的 rejection', () => {
  it('unhandledRejection 只留证据不退出，uncaughtException 落 system.crash 后才退出，下次启动照常收尾', async () => {
    const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
    const { closeDatabase, openDatabase } = await import('@luoli/db');
    const dataDir = resolve('./data/crash-test');
    const logsDir = resolve(dataDir, 'logs');
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    // `logs.dir` 默认是 cwd 下的 `./logs` —— 与本机在跑的那个 bot 共用一棵目录，断言会读到别人的行。
    //
    // **`sandbox.dockerBin` 必须指到一个必然失败的东西上。** 启动时那次 `void reapContainers()`
    // 在 `sandbox.persistent.enabled=false`（默认）下会走 `#sweepOrphans(counts, new Set())`：
    // 宿主上每一个带 `luoli.managed=1` 标签的容器都不在它那张空表里，于是挨个 `docker rm -f`。
    // 这个用例起两次进程，等于把 `sandbox.containers.docker.test.ts` 正在用的容器杀两次。
    writeFileSync(resolve(dataDir, 'config.yaml'),
      `general:\n  shutdown:\n    graceMs: ${GRACE_MS}\nwebui:\n  port: ${CRASH_PORT}\nlogs:\n  dir: ${logsDir}\nsandbox:\n  mode: none\n  dockerBin: /bin/false\n`);
    /** 落盘的 system.jsonl。按 UTC 日期分目录，所以扫目录而不是自己算「今天」（跨零点会算错）。 */
    interface Line { level: string; kind: string; data?: { event?: string; detail?: string } }
    const systemLog = (): Line[] => (existsSync(logsDir) ? readdirSync(logsDir, { withFileTypes: true }) : [])
      .filter((entry) => entry.isDirectory()).map((entry) => resolve(logsDir, entry.name, 'system.jsonl'))
      .filter((path) => existsSync(path))
      // 只收完整的行：urgent 那一档是 appendFileSync，读的时候可能正撞上别人写到一半。
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.startsWith('{') && line.endsWith('}'))
        .map((line) => JSON.parse(line) as Line));

    // 起过的进程一律登记：断言中途红了也要收干净，否则它会带着 8801 端口活到下一次跑这份用例。
    const running: Array<ReturnType<typeof spawn>> = [];
    try {
      const crashed = await startBot(dataDir, { port: CRASH_PORT, imports: [resolve('tests/fixtures/fatal-trigger.mjs')] });
      running.push(crashed.child);
      // 等 `close` 而不是 `exit`：**子进程写给管道的 stderr 是异步的**，`exit` 那一刻最后一批
      // 还可能没送到父进程手上，而「stderr 上有没有崩溃原因」正是这条要断言的东西之一。
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      crashed.child.once('close', (code, signal) => { exited = { code, signal }; });

      // 第一枪：unhandledRejection。日志与 stderr 两边都等 —— 同上，前者是 appendFileSync
      // 立刻落盘，后者要过一趟管道，只等前者的话 stderr 那条断言会随机打空。
      const wrote = (marker: string): boolean => crashed.stderr.join('').includes(marker);
      const rejectionDeadline = Date.now() + 20_000;
      crashed.child.kill('SIGUSR2');
      while (!(systemLog().some((line) => line.kind === 'system.unhandled_rejection') && wrote('[unhandled] unhandledRejection:'))
        && Date.now() < rejectionDeadline) await new Promise((settle) => setTimeout(settle, 100));
      const rejection = systemLog().find((line) => line.kind === 'system.unhandled_rejection');
      expect(rejection, `一个泄漏的 promise 在日志里一个字都没留下\n${crashed.stderr.join('')}`).toBeDefined();
      expect(rejection!.level).toBe('error');
      expect(rejection!.data?.event).toBe('unhandledRejection');
      // detail 是 stack 而不是一句 message —— 没有栈这条日志只说明「有个 promise 挂了」。
      expect(rejection!.data?.detail).toContain('luoli-fatal-fixture-rejection');
      expect(rejection!.data?.detail).toMatch(/\n\s+at /);
      expect(wrote('[unhandled] unhandledRejection:'), 'stderr 上没有那条 rejection').toBe(true);
      // **进程不退出**：rejection 是某一次调用的失败，不是进程级不可恢复状态。上一版两者共用一个
      // 处理器一律 exit(1)，代价是一条私聊里泄漏的一个 promise 带走了当时所有并发轮次。
      expect(exited, 'unhandledRejection 把进程带走了').toBeNull();
      expect((await fetch(`http://127.0.0.1:${CRASH_PORT}/api/health`)).ok, 'rejection 之后 HTTP 面不再服务').toBe(true);

      // 第二枪：uncaughtException。
      crashed.child.kill('SIGUSR2');
      const exitDeadline = Date.now() + 30_000;
      while (!exited && Date.now() < exitDeadline) await new Promise((settle) => setTimeout(settle, 50));
      if (!exited) throw new Error(`uncaughtException 之后 30s 仍未退出\n${crashed.stderr.join('')}`);
      const outcome = exited as { code: number | null; signal: NodeJS.Signals | null };
      expect(outcome.code, `退出码不是 1\n${crashed.stderr.join('')}`).toBe(1);
      expect(wrote('[crash] uncaughtException:'), 'stderr 上没有崩溃原因 —— 日志写不进去时它是最后一道').toBe(true);
      // 这一行是在 `process.exit(1)` **之前**写完的：`system.crash` 在 LogSink 里走 urgent
      // （appendFileSync 立刻落盘），靠那个 200ms 的缓冲定时器的话进程已经没了。
      const crash = systemLog().find((line) => line.kind === 'system.crash');
      expect(crash, '崩溃在日志里一个字都没留下').toBeDefined();
      expect(crash!.level).toBe('error');
      expect(crash!.data?.event).toBe('uncaughtException');
      expect(crash!.data?.detail).toContain('luoli-fatal-fixture-exception');
      expect(crash!.data?.detail).toMatch(/\n\s+at /);

      // 崩溃路径不自己收尾（那正是它崩了的意思）：库里留下的在途轮次交给下一次启动的 recoverAfterCrash。
      const dbPath = resolve(dataDir, 'luoli.db');
      const seed = openDatabase(dbPath);
      seed.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,queued_at,started_at) VALUES('turn-crashed','chat:1','1','2','trusted','running',?,?)")
        .run(Date.now(), Date.now());
      closeDatabase(seed);
      const restarted = await startBot(dataDir, { port: CRASH_PORT });
      running.push(restarted.child);
      const after = openDatabase(dbPath);
      const row = after.prepare("SELECT state, error FROM turns WHERE id='turn-crashed'").get() as { state: string; error: string } | undefined;
      // 不走 closeDatabase：那里的 `wal_checkpoint(TRUNCATE)` 会跟在位实例抢。
      after.close();
      expect(row, '在途轮次没被判死 —— 它会一直挂在 running 上').toMatchObject({ state: 'failed', error: 'process_restarted' });
      expect(systemLog().some((line) => line.kind === 'system.recovered'), '一次非正常重启 reap 了什么在日志里没有痕迹').toBe(true);
      // 崩溃没走 shutdown，锁文件留在原地；下一个实例按「主人已经死了」接手，而不是被永久锁在外面。
      expect(restarted.stdout.join('')).toContain('[lock] 接手了');
    } finally {
      await reap(running);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});
