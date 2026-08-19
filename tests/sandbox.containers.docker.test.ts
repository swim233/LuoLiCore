import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxContainerRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContainerManager, Sandbox, containerNameFor, type ContainerRuntimeConfig, type SandboxConfig } from '@luoli/core';

/**
 * 会话级持久容器的**真执行**（docs/05 §5.5）。判定层在 `sandbox.persistent.test.ts`，
 * 这一份专找那种读码看不出来的：后台进程跨两次 exec 到底还活不活着、取消打的是进程还是容器、
 * 重启之后对账会不会把在用的容器误杀。
 *
 * **docker 不可用时整份 skip** —— 没有 docker 的 CI 上让它红一片，下一次就没人看这份用例了。
 */
const IMAGE = 'luoli-sandbox:latest';
const dockerReady = ((): boolean => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch { return false; }
})();

const ROOT = resolve('./data/containers-live.test');
const CHAT = '-100777';
const OTHER = '-100778';
const dbPath = './data/containers-live.test.db';
/** 用例自己收尾：留下的容器会占着宿主的内存直到有人手动 `docker rm -f`。 */
const purge = (): void => {
  for (const chatId of [CHAT, OTHER]) {
    try { execFileSync('docker', ['rm', '-f', containerNameFor(chatId)], { stdio: 'ignore', timeout: 20_000 }); } catch { /* 本来就没有 */ }
  }
};

const runtimeConfig = (overrides: Partial<ContainerRuntimeConfig['persistent']> = {}): ContainerRuntimeConfig => ({
  dockerBin: 'docker', image: IMAGE, memoryMb: 256, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 32, maxOutputBytes: 65_536,
  persistent: { enabled: true, idleTtlMs: 3_600_000, maxLifetimeMs: 0, maxContainers: 8, network: 'none', reapCron: '*/5 * * * *', ...overrides },
});

const harness = (overrides: Partial<ContainerRuntimeConfig['persistent']> = {}) => {
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repo = new SandboxContainerRepository(db);
  return { db, repo, manager: new ContainerManager(db, repo, () => runtimeConfig(overrides)) };
};
/**
 * 每个用例自己开一张干净的库 + 干净的宿主容器（仓库纪律：用例自己 rmSync 清库，不引 mock 层）。
 * **回收与对账那几条断言的是全局条数**，用例之间留下的容器会让它们互相污染 —— 而那种红是
 * 「上一条用例没收干净」，不是被测行为出了问题，最难查。
 */
const fresh = (overrides: Partial<ContainerRuntimeConfig['persistent']> = {}) => {
  purge();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  return harness(overrides);
};
/**
 * 容器里在跑什么 —— 走**宿主侧**的 `docker top`，不在容器里跑 `ps`。
 * `python:3.12-slim` 里根本没有 `ps`（procps 是这一轮才加进镜像的），而
 * `ps … | grep -c` 在 `ps: not found` 之下照样打印 `0` —— 一条永远为真的断言比没有断言更糟。
 */
const runningIn = (chatId: string, needle: string): number => {
  const out = execFileSync('docker', ['top', containerNameFor(chatId), '-eo', 'pid,args'], { encoding: 'utf8', timeout: 20_000 });
  return out.split('\n').filter((line) => line.includes(needle)).length;
};
const workspaceFor = (chatId: string): string => {
  const path = resolve(ROOT, chatId);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  return path;
};

describe.skipIf(!dockerReady)('持久容器 · 真 docker', () => {
  afterAll(() => {
    purge();
    rmSync(ROOT, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  it('同一个会话复用同一个容器，不同会话互不可见', async () => {
    const { db, manager } = fresh();
    const signal = new AbortController().signal;
    const first = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo $$ > /tmp/marker; hostname', timeoutMs: 30_000, abortSignal: signal });
    expect('error' in first, `建容器失败：${JSON.stringify(first)}`).toBe(false);
    expect(first).toMatchObject({ ok: true });
    // /tmp 是容器自己的 tmpfs：同一个容器里读得到，说明这两次 exec 落在同一个容器上。
    const second = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat /tmp/marker', timeoutMs: 30_000, abortSignal: signal });
    expect(second).toMatchObject({ ok: true });
    expect('stdout' in second && second.stdout.trim()).toMatch(/^\d+$/);
    // 另一个会话是另一个容器：它看不到上面那个 /tmp/marker，工作区也是分开的。
    const elsewhere = await manager.exec({ chatId: OTHER, mountedWorkspace: workspaceFor(OTHER), command: 'cat /tmp/marker 2>/dev/null; echo "---"; ls', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in elsewhere && elsewhere.stdout.trim()).toBe('---');
    expect(manager.capacity().used).toBe(2);
    closeDatabase(db);
  }, 180_000);

  /**
   * **这条是整个功能的理由**：`docker run --rm` 结构上做不到跨轮次留住一个进程。
   * 同时钉住那个约定 —— 后台任务必须重定向到文件，否则 exec 一结束管道就关，
   * 进程下一次写 stdout 吃 SIGPIPE 就死了。
   */
  it('后台进程跨两次 exec 还活着，输出落进 .luoli-logs 可回读', async () => {
    const { db, manager } = fresh();
    const signal = new AbortController().signal;
    const started = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), timeoutMs: 30_000, abortSignal: signal,
      command: 'i=0; while [ $i -lt 60 ]; do echo "tick $i"; i=$((i+1)); sleep 1; done', background: { name: 'ticker' } });
    expect(started).toMatchObject({ ok: true });
    await new Promise((done) => { setTimeout(done, 2500); });
    // 第一次 exec 早就结束了，而它起的那个循环还在跑 —— 这正是 `docker run --rm` 做不到的事。
    expect(runningIn(CHAT, 'while')).toBeGreaterThan(0);
    const logs = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat .luoli-logs/ticker.log', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in logs && logs.stdout).toContain('tick 0');
    // 还在往下写 —— 它没有在第一次 exec 结束时被 SIGPIPE 打死。
    expect('stdout' in logs && logs.stdout).toContain('tick 1');
    closeDatabase(db);
  }, 180_000);

  /**
   * `docker kill <容器名>` 在持久容器这一档等于「销毁这个群的整个环境」，而 `/cancel` 与超时
   * 走的是同一个钩子。取消必须只打那个进程组，容器与别人的后台进程照常活着。
   */
  it('取消只杀被取消的那个进程组，容器与后台进程照常活着', async () => {
    const { db, manager } = fresh();
    const controller = new AbortController();
    const slow = manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'sleep 120', timeoutMs: 120_000, abortSignal: controller.signal });
    await new Promise((done) => { setTimeout(done, 1200); });
    controller.abort();
    const startedAt = Date.now();
    const result = await slow;
    // **墙钟本身是判据**：取消要当场生效。这条断言此前不在，于是整条用例靠「等那个 sleep 120
    // 自己跑完」通过 —— 耗时 120 秒、断言全绿，而取消其实一次都没成功过
    // （`kill -KILL -- -<pgid>` 被 dash 拒了，见 containers.ts 里那段注释）。
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect('killed' in result && result.killed).toBe(true);
    expect('ok' in result && result.ok).toBe(false);
    // 容器还在，而且还能用。
    const after = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo still-here', timeoutMs: 30_000, abortSignal: new AbortController().signal });
    expect('stdout' in after && after.stdout.trim()).toBe('still-here');
    // 被取消的那个 sleep 真的没了（整个进程组被 SIGKILL），不是留在容器里跑飞。
    expect(runningIn(CHAT, 'sleep 120')).toBe(0);
    closeDatabase(db);
  }, 180_000);

  /** 到期回收：容器真没了、库里的行也没了，而工作区里的文件一个不动。 */
  it('到期回收销毁容器但不动工作区文件', async () => {
    const { db, repo, manager } = fresh();
    const signal = new AbortController().signal;
    await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo hello > keep-me.txt', timeoutMs: 30_000, abortSignal: signal });
    expect(repo.byChat(CHAT)).not.toBeNull();
    // 把到期时刻推到过去，跑一次回收。
    repo.keep(CHAT, { expiresAt: Date.now() - 1000 });
    const counts = await manager.reap();
    expect(counts.idle).toBe(1);
    expect(repo.byChat(CHAT)).toBeNull();
    expect(() => execFileSync('docker', ['inspect', containerNameFor(CHAT)], { stdio: 'ignore', timeout: 10_000 })).toThrow();
    // 文件还在 —— 容器是环境，workspace 是数据（docs/05 §5.5）。
    expect(readFileSync(resolve(ROOT, CHAT, 'keep-me.txt'), 'utf8').trim()).toBe('hello');
    // 下一次执行会新建，并且带上「上一个被回收了」那句旁白。
    const revived = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat keep-me.txt', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in revived && revived.stdout.trim()).toBe('hello');
    expect('note' in revived && revived.note).toContain('闲置超时被回收');
    closeDatabase(db);
  }, 180_000);

  /** 进程重启时先对账而不是全杀：24h 的 TTL 要扛得住一次重启。 */
  it('重启后的对账认领在用的容器，只收孤儿', async () => {
    const { db, repo, manager } = fresh();
    await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'true', timeoutMs: 30_000, abortSignal: new AbortController().signal });
    const name = repo.byChat(CHAT)!.name;
    closeDatabase(db);
    // 新进程：同一个库、同一批容器。
    const restarted = harness();
    const counts = await restarted.manager.reap();
    expect(counts.adopted).toBe(1);
    expect(counts.gone + counts.idle + counts.hard + counts.respec + counts.exited).toBe(0);
    expect(restarted.repo.byChat(CHAT)?.name).toBe(name);
    execFileSync('docker', ['inspect', name], { stdio: 'ignore', timeout: 10_000 });
    // 库里没有、却带着 luoli.managed 标签的那个是孤儿（上一次崩在建容器与落库之间）。
    execFileSync('docker', ['run', '-d', '--name', 'luoli-box-orphan-test', '--label', 'luoli.managed=1', IMAGE, 'sleep', 'infinity'], { stdio: 'ignore', timeout: 60_000 });
    const swept = await restarted.manager.reap();
    expect(swept.orphans).toBe(1);
    expect(swept.adopted).toBe(1);
    expect(() => execFileSync('docker', ['inspect', 'luoli-box-orphan-test'], { stdio: 'ignore', timeout: 10_000 })).toThrow();
    closeDatabase(restarted.db);
  }, 180_000);

  /** 沙箱配置改了要真的生效：spec 指纹对不上的容器由回收销毁，下次用时按新配置重建。 */
  it('改了资源限制之后旧容器被重建', async () => {
    const { db, repo, manager } = fresh();
    await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'true', timeoutMs: 30_000, abortSignal: new AbortController().signal });
    const before = repo.byChat(CHAT)!.specHash;
    closeDatabase(db);
    const respec = harness();
    const bumped = new ContainerManager(respec.db, respec.repo, () => ({ ...runtimeConfig(), memoryMb: 300 }));
    const counts = await bumped.reap();
    expect(counts.respec).toBe(1);
    expect(respec.repo.byChat(CHAT)).toBeNull();
    const rebuilt = await bumped.ensure(CHAT, workspaceFor(CHAT));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.ok === true && rebuilt.row.specHash).not.toBe(before);
    closeDatabase(respec.db);
  }, 180_000);

  /**
   * `bash` 那条路（`Sandbox.run`）也要真的落进会话容器 —— 工具层与容器层之间那条接线
   * 是「每一半都有测试、没有一条跨过边界」最容易漏掉的位置（docs/00 §2 对第十轮的总结）。
   */
  it('Sandbox.run 在持久模式下走 docker exec，且 chatId 决定落在哪个容器', async () => {
    const { db, repo, manager } = fresh();
    const sandboxConfig: SandboxConfig = { mode: 'docker', bypassRoles: [], dockerBin: 'docker', workspaceDir: ROOT, hostWorkspaceDir: '',
      image: IMAGE, network: 'none', memoryMb: 256, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 32,
      defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, maxOutputBytes: 65_536, persistent: runtimeConfig().persistent };
    const sandbox = new Sandbox(sandboxConfig, true, false);
    sandbox.bindContainers(manager);
    workspaceFor(CHAT);
    writeFileSync(resolve(ROOT, CHAT, 'whoami.txt'), 'chat-777\n');
    const result = await sandbox.run('cat whoami.txt', 'trusted', resolve(ROOT, CHAT), new AbortController().signal, 30_000, 'turn-1', { chatId: CHAT });
    expect(result.ok, result.stderr).toBe(true);
    expect(result.stdout.trim()).toBe('chat-777');
    // 落在了这个会话的常驻容器上，而不是又起了一个一次性的。
    expect(repo.byChat(CHAT)?.execCount).toBeGreaterThan(0);
    execFileSync('docker', ['inspect', containerNameFor(CHAT)], { stdio: 'ignore', timeout: 10_000 });
    closeDatabase(db);
  }, 180_000);
});
