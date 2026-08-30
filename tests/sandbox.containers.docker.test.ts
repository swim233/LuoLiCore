import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxContainerRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContainerManager, Sandbox, containerNameFor, type ContainerRuntimeConfig, type SandboxConfig } from '@luoli/core';

/**
 * 会话级持久容器的真实执行（docs/05 §5.5）。判定层在 `sandbox.persistent.test.ts`，
 * 这一份覆盖读代码确认不了的部分：后台进程跨两次 exec 是否仍存活、取消作用于进程还是容器、
 * 重启后对账是否会误杀在用的容器。
 *
 * docker 不可用时整份 skip：在没有 docker 的 CI 上大面积失败，会导致这份用例被忽略。
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
/** 第二个实例那条用例用的另一张库：实例身份取自库路径指纹，因此两个实例即两张库。 */
const otherDbPath = './data/containers-live-second.test.db';
/** 库里没有、只在宿主上的那个探针容器。 */
const ORPHAN = 'luoli-box-orphan-test';
/** 用例自行收尾：残留容器会一直占用宿主内存，直到有人手动 `docker rm -f`。 */
const purge = (): void => {
  for (const name of [...[CHAT, OTHER].map(containerNameFor), ORPHAN]) {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 }); } catch { /* 原本就不存在 */ }
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
 * 每个用例各自开一张干净的库与干净的宿主容器（仓库纪律：用例自行 rmSync 清库，不引 mock 层）。
 * 回收与对账那几条断言的是全局条数，用例之间残留的容器会造成相互污染，而这类失败的原因是
 * 上一条用例没清理干净、不是被测行为异常，排查成本最高。
 */
const fresh = (overrides: Partial<ContainerRuntimeConfig['persistent']> = {}) => {
  purge();
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  return harness(overrides);
};
/**
 * 查容器内在跑什么：走宿主侧的 `docker top`，而不是在容器里执行 `ps`。
 * `python:3.12-slim` 里没有 `ps`（procps 是这一轮才加进镜像的），而 `ps … | grep -c` 在
 * `ps: not found` 之下照样输出 `0`，恒真的断言比没有断言更糟。
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
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  it('同一个会话复用同一个容器，不同会话互不可见', async () => {
    const { db, manager } = fresh();
    const signal = new AbortController().signal;
    const first = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo $$ > /tmp/marker; hostname', timeoutMs: 30_000, abortSignal: signal });
    expect('error' in first, `建容器失败：${JSON.stringify(first)}`).toBe(false);
    expect(first).toMatchObject({ ok: true });
    // /tmp 是容器自身的 tmpfs：同一容器内读得到，即说明两次 exec 落在同一个容器上。
    const second = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat /tmp/marker', timeoutMs: 30_000, abortSignal: signal });
    expect(second).toMatchObject({ ok: true });
    expect('stdout' in second && second.stdout.trim()).toMatch(/^\d+$/);
    // 另一个会话对应另一个容器：它读不到上面那个 /tmp/marker，工作区也相互隔离。
    const elsewhere = await manager.exec({ chatId: OTHER, mountedWorkspace: workspaceFor(OTHER), command: 'cat /tmp/marker 2>/dev/null; echo "---"; ls', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in elsewhere && elsewhere.stdout.trim()).toBe('---');
    expect(manager.capacity().used).toBe(2);
    closeDatabase(db);
  }, 180_000);

  /**
   * 这条用例是整个功能存在的理由：`docker run --rm` 结构上做不到跨轮次留住一个进程。
   * 同时固定一项约定：后台任务必须重定向到文件，否则 exec 一结束管道就关闭，
   * 进程下一次写 stdout 会因 SIGPIPE 终止。
   */
  it('后台进程跨两次 exec 还活着，输出落进 .luoli-logs 可回读', async () => {
    const { db, manager } = fresh();
    const signal = new AbortController().signal;
    const started = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), timeoutMs: 30_000, abortSignal: signal,
      command: 'i=0; while [ $i -lt 60 ]; do echo "tick $i"; i=$((i+1)); sleep 1; done', background: { name: 'ticker' } });
    expect(started).toMatchObject({ ok: true });
    await new Promise((done) => { setTimeout(done, 2500); });
    // 第一次 exec 已经结束，而它起的那个循环还在跑，这正是 `docker run --rm` 做不到的。
    expect(runningIn(CHAT, 'while')).toBeGreaterThan(0);
    const logs = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat .luoli-logs/ticker.log', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in logs && logs.stdout).toContain('tick 0');
    // 仍在持续写入：它没有在第一次 exec 结束时被 SIGPIPE 终止。
    expect('stdout' in logs && logs.stdout).toContain('tick 1');
    closeDatabase(db);
  }, 180_000);

  /**
   * 在持久容器这一档，`docker kill <容器名>` 等于销毁这个群的整个环境，而 `/cancel` 与超时
   * 走的是同一个钩子。取消必须只作用于目标进程组，容器与其他后台进程保持存活。
   */
  it('取消只杀被取消的那个进程组，容器与后台进程照常活着', async () => {
    const { db, manager } = fresh();
    const controller = new AbortController();
    const slow = manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'sleep 120', timeoutMs: 120_000, abortSignal: controller.signal });
    await new Promise((done) => { setTimeout(done, 1200); });
    controller.abort();
    const startedAt = Date.now();
    const result = await slow;
    // 墙钟耗时本身即判据：取消要当场生效。这条断言此前不在，整条用例靠等那个 sleep 120 自己
    // 跑完而通过：耗时 120 秒、断言全绿，而取消实际一次都没成功过
    // （`kill -KILL -- -<pgid>` 被 dash 拒绝，见 containers.ts 里那段注释）。
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect('killed' in result && result.killed).toBe(true);
    expect('ok' in result && result.ok).toBe(false);
    // 容器仍在，且仍可使用。
    const after = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo still-here', timeoutMs: 30_000, abortSignal: new AbortController().signal });
    expect('stdout' in after && after.stdout.trim()).toBe('still-here');
    // 被取消的那个 sleep 确实已终止（整个进程组被 SIGKILL），而不是留在容器里继续跑。
    expect(runningIn(CHAT, 'sleep 120')).toBe(0);
    closeDatabase(db);
  }, 180_000);

  /** 到期回收：容器与库里对应的行都被删除，而工作区里的文件保持不变。 */
  it('到期回收销毁容器但不动工作区文件', async () => {
    const { db, repo, manager } = fresh();
    const signal = new AbortController().signal;
    await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'echo hello > keep-me.txt', timeoutMs: 30_000, abortSignal: signal });
    expect(repo.byChat(CHAT)).not.toBeNull();
    // 把到期时刻提前到过去，执行一次回收。
    repo.keep(CHAT, { expiresAt: Date.now() - 1000 });
    const counts = await manager.reap();
    expect(counts.idle).toBe(1);
    expect(repo.byChat(CHAT)).toBeNull();
    expect(() => execFileSync('docker', ['inspect', containerNameFor(CHAT)], { stdio: 'ignore', timeout: 10_000 })).toThrow();
    // 文件仍在：容器是环境，workspace 是数据（docs/05 §5.5）。
    expect(readFileSync(resolve(ROOT, CHAT, 'keep-me.txt'), 'utf8').trim()).toBe('hello');
    // 下一次执行会新建容器，并附带上一个容器已被回收的说明。
    const revived = await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'cat keep-me.txt', timeoutMs: 30_000, abortSignal: signal });
    expect('stdout' in revived && revived.stdout.trim()).toBe('hello');
    expect('note' in revived && revived.note).toContain('闲置超时被回收');
    closeDatabase(db);
  }, 180_000);

  /** 进程重启时先对账而不是全部销毁：24h 的 TTL 要能跨越一次重启。 */
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
    // 库里没有、带 luoli.managed 且归属本实例的那个才是孤儿（上一次崩在建容器与落库之间）。
    const mine = restarted.manager.instanceLabel;
    execFileSync('docker', ['run', '-d', '--name', ORPHAN, '--label', 'luoli.managed=1', '--label', `luoli.instance=${mine}`, IMAGE, 'sleep', 'infinity'], { stdio: 'ignore', timeout: 60_000 });
    const swept = await restarted.manager.reap();
    expect(swept.orphans).toBe(1);
    expect(swept.adopted).toBe(1);
    expect(() => execFileSync('docker', ['inspect', ORPHAN], { stdio: 'ignore', timeout: 10_000 })).toThrow();
    closeDatabase(restarted.db);
  }, 180_000);

  /**
   * `docs/29 · M-OPS-01`：第二个实例一启动就 `docker rm -f` 掉第一个实例正在用的持久容器。
   *
   * 成因是 `luoli.managed=1` 这个标签不带实例身份，而 `#sweepOrphans` 的判据只有带这个标签且
   * 不在本实例库里。影响最大的是 `persistent.enabled=false` 那一支：known 集为空，于是起一个
   * 默认配置的实例就等于清空宿主上所有 luoli 持久容器。该问题实测复现过：跑 docker 用例期间起
   * `pnpm dev`，运行中的容器当场被删除。
   *
   * 两个实例对应两张库，所以这里开第二张库。判据落在容器是否还在上，不只是计数器。
   */
  it('另一个实例的容器一个都不碰，认不出主人的也不碰', async () => {
    const { db, repo, manager } = fresh();
    await manager.exec({ chatId: CHAT, mountedWorkspace: workspaceFor(CHAT), command: 'true', timeoutMs: 30_000, abortSignal: new AbortController().signal });
    const name = repo.byChat(CHAT)!.name;
    // 加实例标签之前建的容器：识别不出归属，同样一个都不动（删掉别人正在用的不可逆，
    // 漏掉一个已停止的孤儿只占一点磁盘）。
    execFileSync('docker', ['run', '-d', '--name', ORPHAN, '--label', 'luoli.managed=1', IMAGE, 'sleep', 'infinity'], { stdio: 'ignore', timeout: 60_000 });

    for (const persistent of [true, false]) {
      // 第二个实例：另一张库对应另一个 `luoli.instance`，它的库里没有任何容器行。
      for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${otherDbPath}${suffix}`, { force: true });
      const second = openDatabase(otherDbPath);
      migrateDatabase(second);
      const intruder = new ContainerManager(second, new SandboxContainerRepository(second), () => ({ ...runtimeConfig(), persistent: { ...runtimeConfig().persistent, enabled: persistent } }));
      expect(intruder.instanceLabel, '两张库应当给出两个不同的实例标签').not.toBe(manager.instanceLabel);
      const counts = await intruder.reap();
      expect(counts.orphans, `persistent=${persistent} 时删了别人的容器`).toBe(0);
      expect(counts.foreign).toBe(1);
      expect(counts.legacy).toBe(1);
      // 核心判据：两个容器都还在宿主上。
      execFileSync('docker', ['inspect', name], { stdio: 'ignore', timeout: 10_000 });
      execFileSync('docker', ['inspect', ORPHAN], { stdio: 'ignore', timeout: 10_000 });
      closeDatabase(second);
    }
    // 在位的那个实例照旧能认领到自己的容器。
    expect((await manager.reap()).adopted).toBe(1);
    execFileSync('docker', ['inspect', name], { stdio: 'ignore', timeout: 10_000 });
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${otherDbPath}${suffix}`, { force: true });
    closeDatabase(db);
  }, 240_000);

  /** 沙箱配置变更要真的生效：spec 指纹对不上的容器由回收销毁，下次使用时按新配置重建。 */
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
   * `bash` 那条路（`Sandbox.run`）同样要落进会话容器：工具层与容器层之间的这条接线，
   * 正是两侧各有测试、却没有一条跨越边界时最容易漏掉的位置（docs/00 §2 对第十轮的总结）。
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
    // 落在了这个会话的常驻容器上，而不是另起了一个一次性容器。
    expect(repo.byChat(CHAT)?.execCount).toBeGreaterThan(0);
    execFileSync('docker', ['inspect', containerNameFor(CHAT)], { stdio: 'ignore', timeout: 10_000 });
    closeDatabase(db);
  }, 180_000);
});
