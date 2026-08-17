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
});
