import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Sandbox, ToolRegistry } from '@luoli/core';
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
    const context = { turn, workspace: '.', agentKind: 'main' as const };
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(registry.activeNames('owner', { ...context, turn: { ...turn, effectiveRole: 'owner' } })).toContain('bash');
  });

  // 事故中在 WebUI 把 docker 改成 none 想切断执行类工具，返回 200、GET /api/sandbox 显示已改，
  // 而 bash/python 照跑不误 —— 吃启动快照的后果（docs/20 · W-CFG-02）。
  it('follows sandbox.mode and bypassRoles through a hot reload', () => {
    let live: SandboxConfig = { ...sandboxConfig, mode: 'jail', bypassRoles: ['owner'] };
    const warnings: string[] = [];
    const sandbox = new Sandbox(() => live, true, false, (message) => warnings.push(message));
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    registry.register({ name: 'bash', description: '', inputSchema: z.object({ command: z.string() }), policy: { minRole: 'trusted', approval: 'never', scope: 'sandbox', source: 'builtin' }, sourcePriority: 1, available: (role, context) => sandbox.plan(role, context.workspace).allowed, execute: () => ({ ok: true }) });
    const context = { turn, workspace: '.', agentKind: 'main' as const };
    expect(registry.activeNames('trusted', context)).toContain('bash');
    // jail 不是安全边界，plan() 要说出来（docs/05 §5.2 · W-SBX-02）。
    expect(warnings.join('\n')).toContain('jail');
    live = { ...live, mode: 'none' as const };
    expect(registry.activeNames('trusted', context)).not.toContain('bash');
    expect(sandbox.plan('trusted').allowed).toBe(false);
    live = { ...live, mode: 'jail' as const, bypassRoles: [] };
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

// bypassRoles 命中时 plan 给的是 'host' —— 「不受沙箱约束」。run() 曾经只分 docker / 非 docker
// 两支，于是 owner 也吃了 jail 的 ulimit 前缀，私聊里每条 bash 都回 `fork: 资源暂时不可用`。
// 这两条都必须让命令真的 fork（管道），否则 bash 会把末条命令直接 exec 掉，根本测不到。
describe('sandbox host execution bypasses the jail limits', () => {
  const workspace = resolve('./data/sandbox-host.test');
  // pidsLimit 取默认的 128 而不是 fixture 里的 8：基线是 spawn 前采样一次的，可用余量就是 pidsLimit
  // 本身，而 vitest 自己在不停起停线程 —— 设 8 的话这条用例会真的 fork 失败（docs/05 §5.4）。
  const jailable = { ...sandboxConfig, mode: 'jail' as const, workspaceDir: './data/sandbox-host.test', memoryMb: 1024, pidsLimit: 128, maxOutputBytes: 65_536, defaultTimeoutMs: 20_000, maxTimeoutMs: 20_000 };
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('runs an owner pipeline on the host without a ulimit prologue', async () => {
    const sandbox = new Sandbox(jailable);
    expect(sandbox.plan('owner').mode).toBe('host');
    const result = await sandbox.run('/bin/echo a | /bin/cat', 'owner', workspace, new AbortController().signal);
    expect(result.stderr).not.toMatch(/fork/);
    expect(result.stdout.trim()).toBe('a');
    expect(result.ok).toBe(true);
  });

  // ulimit -u 是 RLIMIT_NPROC，按 UID 全局的**任务数**算（线程，不是进程，也不是当前进程树）。
  // 直接取 pidsLimit 的话宿主上早就超了，子 shell 一次 fork 都做不成。
  it('raises the jail nproc ceiling above the host baseline instead of using pidsLimit verbatim', async () => {
    const sandbox = new Sandbox(jailable);
    expect(sandbox.plan('trusted').mode).toBe('jail');
    const limit = await sandbox.run('ulimit -u', 'trusted', workspace, new AbortController().signal);
    expect(Number(limit.stdout.trim())).toBeGreaterThan(jailable.pidsLimit);
    const piped = await sandbox.run('/bin/echo a | /bin/cat', 'trusted', workspace, new AbortController().signal);
    expect(piped.stderr).not.toMatch(/fork/);
    expect(piped.stdout.trim()).toBe('a');
  });
});

// 输出上限有两道：`clipped()` 头尾各半（只置 truncated），以及单条流累计到 `2 × maxOutputBytes`
// 时当场 SIGKILL（docs/05 §3.3）。第二道以前一并把 `ok` 判成 false —— 而它唯一还起作用的场合
// 恰好是 bug（docs/28 · L-TOOL-01）。
describe('sandbox output cap', () => {
  const workspace = resolve('./data/sandbox-cap.test');
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('kills the child once a single stream passes twice the cap, and says so in the hint', async () => {
    // owner 走 bypassRoles → 宿主直跑，不套 ulimit（`-f` 是文件大小，管不到管道，但少一层变量）。
    const sandbox = new Sandbox({ ...sandboxConfig, mode: 'jail', workspaceDir: './data/sandbox-cap.test' });
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
