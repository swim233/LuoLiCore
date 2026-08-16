import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
