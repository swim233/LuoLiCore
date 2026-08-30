import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Sandbox, ToolRegistry, newToolScope } from '@luoli/core';
import type { ApprovalBroker, LogSink, SandboxConfig } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

const broker: ApprovalBroker = { request: async () => true };
const log = { span: () => ({ id: 'span', end: () => undefined }) } as unknown as LogSink;
const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} } satisfies RuntimeTurnContext;
const sandboxConfig = { mode: 'none' as const, bypassRoles: ['owner' as const], dockerBin: 'docker', image: 'none', network: 'none' as const, memoryMb: 128, cpus: 1, pidsLimit: 8, readOnlyRoot: true, tmpfsMb: 8, workspaceDir: './data/sandbox-map.test', hostWorkspaceDir: '', defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024 };

describe('sandbox fail-closed visibility', () => {
  it('hides execution tools from trusted roles while preserving owner bypass', () => {
    const sandbox = new Sandbox(sandboxConfig);
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, available: (role, context) => sandbox.plan(role, context.workspace).allowed, execute: () => ({ ok: true }) });
    // `lw`：`bash` 随执行整体下沉到 worker 那一侧（docs/05 §4），主 agent 侧目录里恒无此名 ——
    // 本条判的是沙箱不可用时的 fail-closed 与 owner 的 bypass，两条闸不能混。
    const context = { turn, workspace: '.', agentKind: 'lw' as const, ...newToolScope() };
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(registry.activeNames('owner', { ...context, turn: { ...turn, effectiveRole: 'owner' } })).toContain('bash');
  });

  // 事故中在 WebUI 把 docker 改成 none 想切断执行类工具，返回 200、GET /api/sandbox 显示已改，
  // 而 bash/python 照跑不误 —— 吃启动快照的后果（docs/20 · W-CFG-02）。
  it('follows sandbox.mode and bypassRoles through a hot reload', () => {
    let live: SandboxConfig = { ...sandboxConfig, mode: 'docker', bypassRoles: ['owner'] };
    const sandbox = new Sandbox(() => live, true, false);
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'never', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, available: (role, context) => sandbox.plan(role, context.workspace).allowed, execute: () => ({ ok: true }) });
    const context = { turn, workspace: '.', agentKind: 'lw' as const, ...newToolScope() };
    expect(registry.activeNames('trusted', context)).toContain('bash');
    live = { ...live, mode: 'none' as const };
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(sandbox.plan('trusted').allowed).toBe(false);
    // 被拒那一档的 mode 要说实话：沙箱未启用就是 'none'，不是随便挑一个执行模式的名字。
    expect(sandbox.plan('trusted').mode).toBe('none');
    live = { ...live, mode: 'docker' as const, bypassRoles: [] };
    expect(sandbox.plan('owner').allowed).toBe(true);
  });

  it('hides Docker execution tools when Docker is known unavailable', () => {
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker' }, false, false);
    expect(sandbox.plan('trusted').allowed).toBe(false);
    expect(sandbox.plan('owner').allowed).toBe(true);
  });

  it('records a failed Docker binary probe and remains fail closed', async () => {
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker', dockerBin: 'definitely-missing-docker' }, undefined, false);
    const result = await sandbox.probe();
    expect(result.available).toBe(false);
    expect(sandbox.plan('trusted').allowed).toBe(false);
  });
});

// bypassRoles 命中时 plan 给的是 'host' —— 「不受沙箱约束」：直接 spawn `/bin/sh`，不套任何前缀，
// 也不进容器。run() 曾经只分 docker / 非 docker 两支，于是 owner 也吃了非 docker 那支的资源限制，
// 私聊里每条 bash 都回 `fork: 资源暂时不可用`，看起来像沙箱坏了，实际上 owner 压根不该进沙箱。
// 这条必须让命令真的 fork（管道），否则 bash 会把末条命令直接 exec 掉，根本测不到。
describe('sandbox host execution bypasses the sandbox', () => {
  const workspace = resolve('./data/sandbox-host.test');
  const bypassing = { ...sandboxConfig, mode: 'docker' as const, workspaceDir: './data/sandbox-host.test', memoryMb: 1024, maxOutputBytes: 65_536, defaultTimeoutMs: 20_000, maxTimeoutMs: 20_000 };
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('runs an owner pipeline on the host, outside the sandbox', async () => {
    const sandbox = new Sandbox(bypassing);
    expect(sandbox.plan('owner').mode).toBe('host');
    const result = await sandbox.run('/bin/echo a | /bin/cat', 'owner', workspace, new AbortController().signal);
    expect(result.stderr).not.toMatch(/fork/);
    expect(result.stdout.trim()).toBe('a');
    expect(result.ok).toBe(true);
  });

  /**
   * 沙箱执行此前在日志里**完全不存在**：`docs/10 §2` 有 `sandbox.run` 这一行，而源码零处发出
   * （docs/28 · L-LOG-01）。一次 OOM、一次被 SIGKILL 的命令、以及「非 owner 请求执行但沙箱不可用」
   * 都只能从 `tool.call` 的输出里猜。被拒那一档同样要落 —— 模型侧只看到一句工具失败。
   */
  it('每次执行都交出一条 sandbox.run，被拒那一档带 denied', async () => {
    const runs: Array<Record<string, unknown>> = [];
    const sandbox = new Sandbox(bypassing, true, false, undefined, undefined, (event) => runs.push({ ...event }));
    const result = await sandbox.run('/bin/echo hi', 'owner', workspace, new AbortController().signal, 20_000, 'turn-42');
    expect(result.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ turnId: 'turn-42', role: 'owner', mode: 'host', ok: true, exitCode: 0, killed: false, oom: false, truncated: false });
    expect(runs[0]!.durationMs).toEqual(expect.any(Number));
    // mode=none 时非 owner 被拒：这条路本来一个字都不落。
    const closed = new Sandbox({ ...bypassing, mode: 'none' as const, bypassRoles: [] }, true, false, undefined, undefined, (event) => runs.push({ ...event }));
    expect((await closed.run('true', 'trusted', workspace, new AbortController().signal, 1000, 'turn-43')).ok).toBe(false);
    expect(runs[1]).toMatchObject({ turnId: 'turn-43', role: 'trusted', ok: false, exitCode: null, mode: 'none' });
    expect(String(runs[1]!.denied)).toContain('沙箱未启用');
  });
});

// 输出上限有两道：`clipped()` 头尾各半（只置 truncated），以及单条流累计到 `2 × maxOutputBytes`
// 时当场 SIGKILL（docs/05 §3.3）。第二道以前一并把 `ok` 判成 false —— 而它唯一还起作用的场合
// 恰好是 bug（docs/28 · L-TOOL-01）。
describe('sandbox output cap', () => {
  const workspace = resolve('./data/sandbox-cap.test');
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('kills the child once a single stream passes twice the cap, and says so in the hint', async () => {
    // owner 走 bypassRoles → 宿主直跑，与 mode 取哪一档无关。
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'none', workspaceDir: './data/sandbox-cap.test' });
    const result = await sandbox.run(`while :; do echo ${'A'.repeat(32)}; done`, 'owner', workspace, new AbortController().signal);
    expect(result.killed).toBe(true);
    expect(result.truncated).toBe(true);
    // SIGKILL 掉的进程退出码不是 0，这一次照常记失败。
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(sandboxConfig.maxOutputBytes);
    expect(result.hint).toContain('SIGKILL');
    expect(result.hint).toContain(String(sandboxConfig.maxOutputBytes * 2));
  });

  // 「子进程已自己退出 0、最后一批输出在 close 之前才 flush 完」的窗口里 kill() 打空，
  // 于是 `exitCode === 0 && truncatedByCap` —— 旧表达式把这一次成功调用记成失败，模型收到
  // ok:false 会原地重试，三次之后 bash 被停用一整轮。
  //
  // 宿主分支上那个窗口靠调度，稳不下来；docker 分支能把**同一个状态组合**确定性地造出来：
  // kill() 在 docker 模式下另起一个 `docker kill <name>`，对已经退出的子进程本就打空，而
  // dockerBin 换成 /bin/echo 时子进程把 argv（远超 2×64 字节）打回 stdout 后自己退 0。
  it('keeps a self-exited zero as success even when the output cap fired', async () => {
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker', dockerBin: '/bin/echo', maxOutputBytes: 64, workspaceDir: './data/sandbox-cap.test' }, true, false);
    const result = await sandbox.run('true', 'trusted', workspace, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.hint).toContain('SIGKILL');
  });
});

// docker run -v 的路径由宿主 daemon 解析。本进程在容器里时它和进程视角的路径不是一回事，
// 而 docker 对不存在的宿主路径不报错、只是默默建个空目录 —— 沙箱和 fs 工具会看到两个目录。
describe('sandbox host path mapping', () => {
  const docker = { ...sandboxConfig, mode: 'docker' as const };

  it('refuses to run in a container without an explicit host workspace mapping', async () => {
    const sandbox = new Sandbox(docker, true, true);
    expect(sandbox.plan('trusted').allowed).toBe(false);
    expect(sandbox.plan('trusted').reason).toMatch(/hostWorkspaceDir/);
    // owner 走 bypassRoles，在宿主直跑、不经过 -v，不受映射影响。
    expect(sandbox.plan('owner').allowed).toBe(true);
    const probe = await sandbox.probe();
    expect(probe.available).toBe(false);
    expect(probe.error).toMatch(/hostWorkspaceDir/);
  });

  it('allows execution in a container once the mapping is configured', () => {
    const sandbox = new Sandbox({ ...docker, hostWorkspaceDir: '/srv/luoli/data/workspace' }, true, true);
    expect(sandbox.plan('trusted').allowed).toBe(true);
  });

  it('rewrites the bind mount to the host path', async () => {
    const workspace = resolve(sandboxConfig.workspaceDir, 'chat-1');
    rmSync(sandboxConfig.workspaceDir, { recursive: true, force: true });
    // dockerBin 换成 echo：不真的起容器，直接把参数打回 stdout，断言 -v 的左半边。
    const sandbox = new Sandbox({ ...docker, hostWorkspaceDir: '/srv/luoli/data/workspace', dockerBin: '/bin/echo' }, true, true);
    const result = await sandbox.run('true', 'trusted', workspace, new AbortController().signal);
    expect(result.stdout).toContain('-v /srv/luoli/data/workspace/chat-1:/workspace:rw');
    expect(result.stdout).not.toContain(workspace);
    rmSync(sandboxConfig.workspaceDir, { recursive: true, force: true });
  });

  it('refuses a workspace that escapes sandbox.workspaceDir', async () => {
    const sandbox = new Sandbox({ ...docker, hostWorkspaceDir: '/srv/luoli/data/workspace' }, true, true);
    const result = await sandbox.run('true', 'trusted', resolve('data/elsewhere'), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/workspaceDir/);
  });
});

// 一次性容器名（docs/05 §5.3 写的是 `luoli-sbx-<turnId>-<n>`）。旧实现是 `luoli-sbx-${Date.now()}`：
// 并发上限 8 的同一毫秒里起两个容器就撞名，`docker run --name` 冲突让第二个直接失败，而 /cancel
// 想按 turn 找容器也无从找起（docs/20 · W-SBX-01）。`<n>` 因此必须是递增序号而不是时钟。
describe('sandbox 一次性容器命名', () => {
  const root = './data/sandbox-name.test';
  const workspace = resolve(root, 'chat-1');
  afterAll(() => rmSync(resolve(root), { recursive: true, force: true }));

  it('同一 turn 并发起多个容器时容器名带 turnId 且序号不撞', async () => {
    // dockerBin 换成 echo：命名发生在 spawn 之前，不必真起容器，argv 原样打回 stdout。
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'docker', dockerBin: '/bin/echo', workspaceDir: root }, true, false);
    const signal = new AbortController().signal;
    // 同一个 turnId、同一个 tick 发出去：命名在 run() 里是同步做完的，四次调用落在同一毫秒。
    const results = await Promise.all(Array.from({ length: 4 }, () => sandbox.run('true', 'trusted', workspace, signal, 1000, 'turn-abc')));
    const names = results.map((result) => /--name (\S+)/.exec(result.stdout)?.[1] ?? '');
    for (const name of names) expect(name).toMatch(/^luoli-sbx-turn-abc-\d+$/);
    expect(new Set(names).size).toBe(4);
    // 尾段是序号不是时钟 —— `Date.now()` 是 13 位，这条才是「同一毫秒不撞名」的成因。
    for (const name of names) expect(Number(name.slice('luoli-sbx-turn-abc-'.length))).toBeLessThan(1000);
  });
});
