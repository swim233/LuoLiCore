import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const GRACE_MS = 2000;

interface Started { child: ReturnType<typeof spawn>; stderr: string[]; stdout: string[] }

async function startBot(dataDir: string): Promise<Started> {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/bot/src/main.ts')], {
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
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`bot 在 40s 内没有开始监听：\n${stderr.join('')}${stdout.join('')}`);
    await new Promise((settle) => setTimeout(settle, 200));
  }
  return { child, stdout, stderr };
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

  it('关停路径仍然中断排不空的在途轮次', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    // `drain()` 只是等。宽限期内没排空的轮次必须被主动 abort，否则要么把进程拖到 systemd 的
    // SIGKILL，要么在退出后留下 running 行等下次 recoverAfterCrash 认领（docs/24 · R-OPS-01）。
    expect(source).toContain("turnRegistry.abortAll('shutdown')");
    // `drain` 的返回值必须被用上：`await turnRegistry.drain(graceMs)` 丢弃返回值正是那次回归的形态。
    expect(source).toMatch(/if\s*\(!\(await turnRegistry\.drain\(/);
    // 收尾三件也一并钉住（同一次回归里被换掉的）：带 checkpoint 的关库、事件名、skills 的 await。
    expect(source).toContain('closeDatabase(db)');
    expect(source).toContain("kind: 'system.stop'");
    expect(source).toContain('await skills.close()');
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
  it('关停 / 重启 / 崩溃处理器都装在 HTTP 开始监听之前', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    const listen = source.indexOf('http = config.webui.enabled ? serve(');
    expect(listen, '找不到 HTTP 监听那一行 —— 这条断言的锚点没了').toBeGreaterThan(0);
    for (const marker of ['const restart = async (reason: string)', 'const shutdown = async (signal: string)',
      "process.once('SIGTERM'", "process.once('SIGINT'", "process.on('uncaughtException'", "process.on('unhandledRejection'"]) {
      const at = source.indexOf(marker);
      expect(at, `找不到 ${marker}`).toBeGreaterThan(0);
      expect(at, `${marker} 排在 serve() 之后 —— 启动窗口里它不可用`).toBeLessThan(listen);
    }
    // `http` 必须是 `let`：改回 `const` 只是把 TDZ 从 `restart` 挪到 `http` 上。
    expect(source).toMatch(/^let http: /m);
    // webhook 模式那个 throw 也要在监听之前 —— 否则 `/api/health` 会先回一整个窗口的 ok。
    expect(source.indexOf("is not implemented; only polling is supported")).toBeLessThan(listen);
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
  it('关停判据从 main.ts 传进 Telegram transformer，且只对 abort 生效', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    expect(main, 'main.ts 没把关停判据传给 createTelegramBot').toContain('stopping: () => shuttingDown');
    const bot = readFileSync(resolve('packages/telegram/src/bot.ts'), 'utf8');
    // transformer 那一段：判据是 `stopping() && isAbortLike(error)` —— 关停期间**真的**出 API 故障
    // （发最后一条消息被拒）照旧记 error，这是收窄不是放行。
    expect(bot).toContain("dependencies.stopping?.() === true && isAbortLike(error)");
    expect(bot).toContain("reason: 'shutdown'");
    expect(bot).toMatch(/\{ level: 'info', summary: `\$\{method\} aborted during shutdown` \}/);
    // `stopping` 必须是可选的：缺它时行为与从前一致（测试与不装 Telegram 的部署）。
    expect(bot).toMatch(/stopping\?: \(\) => boolean;/);
  });

  /**
   * `docs/reviews/28 · L-OPS-01`：第二个实例启动会就地把在位实例**仍在执行**的轮次改成
   * `failed/process_restarted`、释放已认领的消息、清零在途预留 —— 赢的是后来者。
   * 这里直接测那把锁，而不是起两个真进程（后者要 40 秒 × 2 才能拿到同一个判据）。
   */
  it('同一个库上第二个实例拿不到锁，而主人死掉之后能被接手', async () => {
    const { acquireInstanceLock } = await import('@luoli/db');
    const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
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
      third.lock.release();
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
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
