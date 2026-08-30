import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ACP_APPROVAL_MODES, ACP_ERROR_HINTS, ACP_PERMISSION_MODES, AcpLineOverflowError, AcpManager, AcpRunRecorder, acpChildEnv, acpClientCapabilities, acpStopReasonError, buildAcpArgv, clipToJsonBudget, configSchema, enabledAcpAgents, floorPermission, guardedByteStream, resolveAcpAgent, ToolRegistry, registerBuiltins, TOOL_POLICY, type AcpAgentSettings, type AcpSettings, type ToolExecutionContext } from '@luoli/core';

/**
 * M13 · ACP 客户端的运行时用例。一律使用 fixture，不接触真实 `omp`：用例必须离线且确定。
 * fixture 的行为由 env 脚本化（见 `tests/fixtures/acp-agent.mjs` 开头的清单）。
 *
 * fixture 通过 shebang 直接执行而非 `node <file>`：`buildAcpArgv` 的第一项恒为 `acp` 子命令，
 * `spawn(node, ['acp', …, fixture])` 会让 node 去查找一个名为 `acp` 的文件。改用 shebang 后这些 flag
 * 成为 fixture 自身忽略的 argv，同时也证明了 argv 确实被下发。
 */
const FIXTURE = resolve('tests/fixtures/acp-agent.mjs');
const WORK = resolve('data/acp-work');
/**
 * 每个用例独立一份 spawn 日志。共用一份再断言全局条数时，任一用例遗漏一个存活的子进程
 * 都会静默使下一个用例的计数偏移一位：实测四次连续运行中有一次在目录互斥那条用例上数到三个 pid，
 * 而该用例本身只应启动两个。计数只统计本用例启动的进程，即可消除这类干扰。
 */
let SPAWN_LOG = '';
let METHOD_LOG = '';
let caseSeq = 0;

const events: Array<{ level: string; kind: string; summary: string; data?: unknown }> = [];
const log = { event: (event: { level: string; kind: string; summary: string }) => { events.push(event); return 1; },
  publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as never;

const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const pids = (): number[] => lines(SPAWN_LOG).map(Number);
const methods = (): string[] => lines(METHOD_LOG);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

/** 经真实 `configSchema` 处理一遍：默认值、`--tools` 的四项、extraArgs 的闸都要实际参与用例。 */
function settings(acp: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): AcpSettings {
  return configSchema.parse({ access: { bootstrapOwnerId: '1' }, agent: { acp: {
    enabled: true, allowedDirs: [WORK], ...acp,
    agents: [{ name: 'fixture', command: FIXTURE, profile: '', tools: [], handshakeTimeoutMs: 4000, timeoutMs: 8000, ...agent }],
  } } }).agent.acp;
}

/** 每个用例独立的 env 脚本。`ACP_*` 直接写入 `process.env`，`acpChildEnv()` 会整份传递下去。 */
function script(vars: Record<string, string>): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('ACP_')) delete process.env[key];
  process.env.ACP_SPAWN_LOG = SPAWN_LOG;
  process.env.ACP_METHOD_LOG = METHOD_LOG;
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

const run = (manager: AcpManager, acp: AcpSettings, task = '把 probe.txt 里的 hello 改成 HELLO', extra: Record<string, unknown> = {}) =>
  manager.run({ task, dir: WORK }, acp, { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, ...extra });
/**
 * 宿主侧闸门。`plan` 的结果由用例给出，`degraded` 那几条 note 的产生条件全部依赖它
 * （`reason` 更是用例可控的任意长度，正对应一条 note 中嵌入不可控长度字符串的形态）。
 */
const host = (mode: 'none' | 'host' | 'docker' = 'host', reason?: string) => ({
  fs: { denyGlobs: [] as string[], maxReadBytes: 262_144, maxWriteBytes: 5_242_880, backupDir: '.luoli-bak' },
  exec: { maxTimeoutMs: 5000, maxOutputBytes: 65_536 },
  plan: () => ({ mode, ...(reason ? { reason } : {}) }),
});

beforeEach(() => {
  mkdirSync(WORK, { recursive: true });
  // fixture 通过 shebang 直接执行，因此可执行位是前提；checkout 丢失该位的表现是大面积
  // `acp_spawn_failed`，与实现本身出错的现象完全相同。
  chmodSync(FIXTURE, 0o755);
  caseSeq += 1;
  SPAWN_LOG = resolve(`data/acp-spawns-${caseSeq}.log`);
  METHOD_LOG = resolve(`data/acp-methods-${caseSeq}.log`);
  rmSync(SPAWN_LOG, { force: true });
  rmSync(METHOD_LOG, { force: true });
  events.length = 0;
  script({});
});

describe('ACP · 纯函数与契约', () => {
  it('两个默认值是「整趟交给它」：permissionMode=auto + approvalMode=yolo', () => {
    /**
     * 这两个默认值是一次安全取舍，被改回原值时应当有断言报警。二者合起来的语义即
     * `docs/14 §2 Q8-c` 原有那一条：启动该 agent 这一动作整体走一次审批，批准后其内部执行
     * 不再逐条拦截。`approvalMode` 尤其不能退回 `write`：该档位下 `bash` 可证明不可用（实测 omp
     * 17.4.0 会发起询问，本方从它自己给出的 options 中选择 `allow_always` 回复，它仍记录为
     * `Tool call denied by user: bash`，`terminal/create` 一次都不发生）。
     */
    const acp = configSchema.parse({ access: { bootstrapOwnerId: '1' },
      agent: { acp: { agents: [{ name: 'omp', command: 'omp' }] } } }).agent.acp;
    expect(acp.permissionMode).toBe('auto');
    expect(acp.agents[0]!.approvalMode).toBe('yolo');
    // `bash` 保留在默认 `tools` 中：在上述两个默认值下它确实可用（另一必要条件是申报
    // `terminal`，`acpClientCapabilities` 的该位由 `sandbox.plan` 决定）。
    expect(acp.agents[0]!.tools).toEqual(['read', 'write', 'edit', 'bash']);
    // 逐条审批那条路径仍然保留、完整且有用例（`acp.permission.test.ts`），只是不作为默认档。
    // 三档都存在是这条断言的另一半：更换默认值不等于移除其他档位。
    expect([...ACP_PERMISSION_MODES]).toEqual(['ask', 'auto', 'deny']);
    expect([...ACP_APPROVAL_MODES]).toEqual(['always-ask', 'write', 'yolo']);
    // 整块仍默认关闭（`enabled` 与 `allowedDirs` 双闸），上述两个默认值只在启用之后才起作用。
    expect(acp.enabled).toBe(false);
    expect(acp.allowedDirs).toEqual([]);
  });

  it('argv：--approval-mode 无条件下发，--tools 空数组不下发，会话模式不上 argv', () => {
    const base: AcpAgentSettings = { name: 'a', enabled: true, command: 'omp', profile: 'telegram', approvalMode: 'write',
      tools: ['read', 'write', 'edit', 'bash'], model: '', mode: 'plan', extraArgs: ['--no-session'],
      handshakeTimeoutMs: 1, timeoutMs: 1, maxOutputBytes: 1 };
    expect(buildAcpArgv(base)).toEqual(['acp', '--profile=telegram', '--approval-mode=write', '--tools=read,write,edit,bash', '--no-session']);
    // `mode` 不应出现在 argv 中：omp 的 `--mode` 表示输出格式（text/json/rpc/rpc-ui），
    // 下发后会破坏 stdio 上的 JSON-RPC。会话模式只能通过 `session/set_config_option` 设置。
    expect(buildAcpArgv(base).join(' ')).not.toContain('--mode');
    // profile 为空时不添加；tools 为空数组时不添加（空的 `--tools=` 表示不提供任何工具，而非提供全部）。
    expect(buildAcpArgv({ ...base, profile: '', tools: [], extraArgs: [] })).toEqual(['acp', '--approval-mode=write']);
    // yolo 同样显式下发：无论 profile 中的取值如何都予以覆盖，不显式覆盖即静默失去权限门。
    expect(buildAcpArgv({ ...base, approvalMode: 'yolo', profile: '', tools: [], extraArgs: [] })).toContain('--approval-mode=yolo');
  });

  it('extraArgs 写一份我们管着的 flag 时 schema 当场拒收', () => {
    const bad = (extraArgs: string[]) => () => configSchema.parse({ access: { bootstrapOwnerId: '1' },
      agent: { acp: { agents: [{ name: 'a', command: 'omp', extraArgs }] } } });
    expect(bad(['--approval-mode=yolo'])).toThrow(/extraArgs|approval-mode/);
    expect(bad(['--tools'])).toThrow();
    expect(bad(['--auto-approve'])).toThrow();
    expect(bad(['--cwd=/etc'])).toThrow();
    // 不在名单上的仍然接受：该闸用于防止一行配置静默移除一道门，而非禁止所有自定义参数。
    expect(() => configSchema.parse({ access: { bootstrapOwnerId: '1' },
      agent: { acp: { agents: [{ name: 'a', command: 'omp', extraArgs: ['--no-session', '--thinking=low'] }] } } })).not.toThrow();
  });

  it('能力申报是算出来的，缺省不申报 —— 协议里省略就等于 UNSUPPORTED', () => {
    // 谎报一个本方不会响应的 method 会让 agent 发出请求后挂起，而此时它正持有一个改到一半的文件。
    // 因此两位都只在能力确实具备时才置位，缺省情况（没有 host bridge 或 plan 不是 host）为空对象。
    expect(acpClientCapabilities({ fs: false, terminal: false })).toEqual({});
    expect(acpClientCapabilities({ fs: true, terminal: false })).toEqual({ fs: { readTextFile: true, writeTextFile: true } });
    expect(acpClientCapabilities({ fs: true, terminal: true })).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    // fs 未申报而 terminal 已申报不是本方会构造的组合，但结果仍必须是只申报该位，
    // 借此固定两位相互独立这一性质。
    expect(acpClientCapabilities({ fs: false, terminal: true })).toEqual({ terminal: true });
  });

  it('StopReason 五档：只有 end_turn 算成功', () => {
    expect(acpStopReasonError('end_turn')).toBeNull();
    expect(acpStopReasonError('max_tokens')).toBe('acp_max_tokens');
    expect(acpStopReasonError('max_turn_requests')).toBe('acp_max_turn_requests');
    expect(acpStopReasonError('refusal')).toBe('acp_refusal');
    expect(acpStopReasonError('cancelled')).toBe('acp_cancelled');
    // 每一档都要有一句可执行的 hint：只返回 `error` 而没有 hint 时模型只会原样重试。
    for (const code of ['acp_max_tokens', 'acp_max_turn_requests', 'acp_refusal', 'acp_cancelled'] as const) {
      expect(ACP_ERROR_HINTS[code].length).toBeGreaterThan(10);
    }
  });

  /**
   * 错误契约与 `docs/05 §3.5.1` 的表双向固定，参照 `docs/10 §2` 那张 kind 表的先例。
   *
   * `errors.ts` 单点定义本身不构成保证：文案只有一份，但这一份与文档是否一致仍需要断言验证。
   * 少一行意味着模型返回一个手册中查不到的错误码；多一行意味着手册记录了一个永不出现的档位。
   */
  it('错误码与 docs/05 §3.5.1 的契约表逐条对得上', () => {
    const doc = readFileSync('docs/05-tools-and-permissions.md', 'utf8');
    const section = /^#### 3\.5\.1[\s\S]*?(?=^### 3\.6)/m.exec(doc)?.[0];
    expect(section, 'docs/05 里找不到 §3.5.1 那一节').toBeTruthy();
    const documented = new Set<string>();
    for (const line of section!.split('\n')) {
      if (!line.startsWith('|')) continue;
      // 只解析第一列：其余列的正文中会引用其他错误码（`acp_line_too_long` 那行就提到了
      // `acp_connection_lost`），解析全表等于把文档中提及等同于表中存在。
      for (const match of (line.slice(1).split('|')[0] ?? '').matchAll(/`(acp_[a-z_]+)`/g)) documented.add(match[1]!);
    }
    expect([...documented].sort()).toEqual(Object.keys(ACP_ERROR_HINTS).sort());
  });

  it('env 策略：本项目自己的密钥不给子进程', () => {
    process.env.LUOLI_MASTER_KEY = 'x';
    process.env.BOT_TOKEN = 'y';
    const env = acpChildEnv();
    expect(env.LUOLI_MASTER_KEY).toBeUndefined();
    expect(env.BOT_TOKEN).toBeUndefined();
    expect(env.WEBUI_PASSWORD).toBeUndefined();
    expect(env.PATH).toBeDefined();
    delete process.env.LUOLI_MASTER_KEY;
    delete process.env.BOT_TOKEN;
  });

  it('单行字节上界：越界当场 error 掉流，而不是把一行 500 MB 攒进内存', async () => {
    const source = Readable.from([Buffer.from('{"a":1}\n'), Buffer.from('x'.repeat(50)), Buffer.from('y'.repeat(50)), Buffer.from('\n')]);
    const reader = guardedByteStream(source, 64).getReader();
    await expect((async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })()).rejects.toBeInstanceOf(AcpLineOverflowError);
    // 分段累计而非逐块判断：50 与 50 各自不足 64，跨块的那一行才越界。
    const ok = guardedByteStream(Readable.from([Buffer.from('x'.repeat(60)), Buffer.from('\n'), Buffer.from('x'.repeat(60)), Buffer.from('\n')]), 64).getReader();
    for (;;) { const { done } = await ok.read(); if (done) break; }
  });

  it('结果按构造有界：JSON 转义放大之后仍然装得下', () => {
    const nasty = '"\n\t'.repeat(4000);
    const clip = clipToJsonBudget(nasty, 1024);
    expect(clip.truncated).toBe(true);
    // 判据是序列化之后的字节数：`#normalizeOutput` 测量的是 `JSON.stringify(rest)`。
    expect(Buffer.byteLength(JSON.stringify(clip.value)) - 2).toBeLessThanOrEqual(1024);
    expect(clipToJsonBudget('短的', 1024).truncated).toBe(false);
  });

  it('agent 选择：requested / defaultAgent / 第一个启用的，选不到就是 null', () => {
    const two = configSchema.parse({ access: { bootstrapOwnerId: '1' }, agent: { acp: { agents: [
      { name: 'a', command: 'x' }, { name: 'b', command: 'y' }, { name: 'c', command: 'z', enabled: false }] } } }).agent.acp;
    expect(enabledAcpAgents(two).map((agent) => agent.name)).toEqual(['a', 'b']);
    expect(resolveAcpAgent(two)?.name).toBe('a');
    expect(resolveAcpAgent({ ...two, defaultAgent: 'b' })?.name).toBe('b');
    expect(resolveAcpAgent(two, 'b')?.name).toBe('b');
    // 已停用与不存在的都返回 null，不会任选一个：那台 agent 的 --tools 与 --approval-mode 可能完全不同。
    expect(resolveAcpAgent(two, 'c')).toBeNull();
    expect(resolveAcpAgent(two, 'nope')).toBeNull();
  });

  it('不问人的那两档：auto 放行、deny 真拒，而落到地板上的 ask 按 deny 算', () => {
    const request = { sessionId: 's', toolCall: { toolCallId: 't' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' as const }, { optionId: 'no', name: 'Reject', kind: 'reject_once' as const }] };
    expect(floorPermission(request, 'auto')).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } });
    expect(floorPermission(request, 'deny')).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    // `ask` 实际走到这个函数只有一种可能：运行时未接入审批通道，而 `available()` 本应已把工具挡在
    // 目录之外。此时结果是拒绝而非放行：一个名为 `ask` 的档位实际放行正属于伪造一道门。
    expect(floorPermission(request, 'ask')).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    // 未提供任何 reject 档位时返回 cancelled，不转换为放行。
    expect(floorPermission({ ...request, options: [request.options[0]!] }, 'deny')).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(floorPermission({ ...request, options: [request.options[0]!] }, 'ask')).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('ACP · 进程与连接生命周期', () => {
  it('功能关着 / 目录不在白名单 / 目录不存在：一个子进程都不起', async () => {
    const manager = new AcpManager(log);
    expect(await run(manager, settings({ enabled: false }))).toMatchObject({ ok: false, error: 'acp_disabled' });
    expect(await run(manager, settings({ allowedDirs: [] }))).toMatchObject({ ok: false, error: 'acp_disabled' });
    const outside = await manager.run({ task: 'x'.repeat(20), dir: `${WORK}-secrets` }, settings(), { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536 });
    // 逐段比较：`data/acp-work` 不放行 `data/acp-work-secrets`（同 `resolveHarnessDir`）。
    expect(outside).toMatchObject({ ok: false, error: 'acp_dir_not_allowed' });
    const missing = await manager.run({ task: 'x'.repeat(20), dir: `${WORK}/nope` }, settings({ allowedDirs: [WORK] }), { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536 });
    expect(missing).toMatchObject({ ok: false, error: 'acp_dir_missing' });
    expect(pids()).toEqual([]);
    await manager.close();
  });

  it('spawn ENOENT 与握手超时是两档，而且超时的那条子进程当场被收掉', async () => {
    const manager = new AcpManager(log);
    expect(await run(manager, settings({}, { command: '/nonexistent/acp-binary' }))).toMatchObject({ ok: false, error: 'acp_spawn_failed' });
    expect(pids()).toEqual([]);
    script({ ACP_HANG_AT: 'initialize' });
    const hung = await run(manager, settings({}, { handshakeTimeoutMs: 400 }));
    expect(hung).toMatchObject({ ok: false, error: 'acp_handshake_timeout' });
    const [pid] = pids();
    expect(pid).toBeGreaterThan(0);
    // 可启动但握手失败的那条不能残留：MCP 侧正是这一形态导致 `shutdown()` 无法返回
    // （docs/28 · L-EXT-03）。fixture 在该档位下会忽略 stdin 结束，因此只有信号能终止它。
    await waitUntil(() => !alive(pid!));
    expect(alive(pid!)).toBe(false);
    await manager.close();
  });

  it('close() 等到每条子进程真死（包括从没进过会话的那条）', async () => {
    script({ ACP_HANG_AT: 'initialize' });
    const manager = new AcpManager(log);
    const pending = run(manager, settings({}, { handshakeTimeoutMs: 30_000 }));
    await waitUntil(() => pids().length === 1);
    const [pid] = pids();
    await manager.close();
    // `close()` 返回后立即判断，不留任何宽限：返回即已终止才是这条断言的含义。
    expect(alive(pid!)).toBe(false);
    await pending;
  });

  it('协议版本谈不下来时如实报错，不硬着头皮开会话', async () => {
    script({ ACP_PROTOCOL_VERSION: '99' });
    const manager = new AcpManager(log);
    expect(await run(manager, settings())).toMatchObject({ ok: false, error: 'acp_protocol_unsupported' });
    expect(methods()).not.toContain('session/new');
    await manager.close();
  });

  it('单行越界：连接断掉，但错误码说得出是我们的上界掐的', async () => {
    script({ ACP_LONG_LINE: '1', ACP_LONG_LINE_BYTES: '9000000' });
    const manager = new AcpManager(log);
    // 不报 `acp_connection_lost`：该提示会引导运维去查 agent 的退出码，而实际查不到任何信息。
    expect(await run(manager, settings())).toMatchObject({ ok: false, error: 'acp_line_too_long' });
    await manager.close();
  });

  it('一趟正常的任务：session/new → prompt → close，产出与计数都在', async () => {
    script({ ACP_TEXT: '改好了：hello → HELLO', ACP_TOOL_CALL: '1', ACP_COST_STEPS: '0.004', ACP_COST: '0.004' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings());
    expect(result).toMatchObject({ ok: true, stopReason: 'end_turn', agent: 'fixture', toolCalls: 1, updatesDropped: 0, costUsd: 0.004 });
    expect(result.output).toContain('HELLO');
    // 会话作用域等于一次工具调用：`finally` 中必须有 `session/close`（这是不落库 sessionId 的另一半）。
    expect(methods()).toContain('session/close');
    expect(methods()).toContain('session/prompt');
    expect(events.some((event) => event.kind === 'acp.run' && event.level === 'info')).toBe(true);
    await manager.close();
    expect(pids().filter(alive)).toEqual([]);
  });

  it('会话模式走 session/set_config_option，而它失败必须硬失败', async () => {
    script({});
    const manager = new AcpManager(log);
    expect(await run(manager, settings({}, { mode: 'plan' }))).toMatchObject({ ok: true });
    expect(methods()).toContain('session/set_config_option');
    rmSync(METHOD_LOG, { force: true });
    // 运维需要的是 plan（只读规划），静默回退到 default 等于允许它真正修改文件。
    script({ ACP_REJECT_CONFIG: '1' });
    expect(await run(manager, settings({}, { mode: 'plan' }))).toMatchObject({ ok: false, error: 'acp_session_failed' });
    expect(methods()).not.toContain('session/prompt');
    await manager.close();
  });

  it('没申报 sessionCapabilities.close 的 agent 不会收到 session/close', async () => {
    script({ ACP_NO_CLOSE: '1' });
    const manager = new AcpManager(log);
    expect(await run(manager, settings())).toMatchObject({ ok: true });
    expect(methods()).not.toContain('session/close');
    await manager.close();
  });

  it('auth_required 时拿本机凭据试一次，成了就照常开会话', async () => {
    script({ ACP_AUTH_REQUIRED: '1' });
    const manager = new AcpManager(log);
    expect(await run(manager, settings())).toMatchObject({ ok: true });
    expect(methods().filter((method) => method === 'session/new')).toHaveLength(2);
    expect(methods()).toContain('authenticate');
    await manager.close();
  });

  it('StopReason 的四个非正常档都不报成功', async () => {
    const manager = new AcpManager(log);
    for (const [stopReason, error] of [['max_tokens', 'acp_max_tokens'], ['max_turn_requests', 'acp_max_turn_requests'], ['refusal', 'acp_refusal']] as const) {
      script({ ACP_STOP_REASON: stopReason });
      // 最危险的是 `max_tokens`：它的外观最接近成功，而产出是只完成一半的改动。
      expect(await run(manager, settings())).toMatchObject({ ok: false, error, stopReason });
    }
    await manager.close();
  });

  it('maxUpdatesPerPrompt 撞上界只丢弃、不断连', async () => {
    script({ ACP_FLOOD: '50' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({ maxUpdatesPerPrompt: 10 }));
    // 与 `collectProcess` 有意分开处理：那边的溢出源是可终止的字节流，这里 agent 正在修改真实文件。
    expect(result).toMatchObject({ ok: true, stopReason: 'end_turn', updates: 10 });
    expect(result.updatesDropped).toBeGreaterThanOrEqual(40);
    await manager.close();
  });

  it('abort 走 session/cancel，不是直接 SIGTERM', async () => {
    script({ ACP_NEVER_STOP: '1' });
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = run(manager, settings(), '慢慢改', { abortSignal: controller.signal });
    await waitUntil(() => methods().includes('session/prompt'));
    controller.abort();
    const result = await pending;
    // 这条断言是遵循协议的证据：协议要求 agent 停止模型请求、abort 在途工具、发送完待发的
    // update，然后以 cancelled 应答；直接终止进程会让它中断在一个未完成的写操作上。
    expect(methods()).toContain('session/cancel');
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled', stopReason: 'cancelled' });
    await manager.close();
  });

  /**
   * 复审发现的阻塞级缺陷。握手最长四跳乘以 `handshakeTimeoutMs`（默认合计两分钟），
   * `/cancel` 完全可能落在这一段内，而 ACP 没有预先取消的语义：先发一条 `session/cancel`
   * 再发 `session/prompt` 时，agent 会丢弃 cancel、把任务完整执行完并回复 `end_turn`，
   * 于是一次已被取消的调用改完整个仓库后仍报告 `ok: true`。
   */
  it('握手期间被取消：不发 prompt，也绝不报成功', async () => {
    // 拉长握手窗口：fixture 本身耗时在毫秒级，不加 delay 时 abort 永远发生在 prompt 已发出之后，
    // 用例就覆盖不到这条路径（本用例的第一版正因此假通过）。
    script({ ACP_TEXT: '我把整个仓库都改了', ACP_DELAY_AT: 'session/new', ACP_DELAY_MS: '900' });
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = run(manager, settings(), '慢慢改', { abortSignal: controller.signal });
    await waitUntil(() => methods().includes('session/new'));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled' });
    // 判据是它是否实际执行了任务，而非错误码：`session/prompt` 一次都不应出现。
    expect(methods()).not.toContain('session/prompt');
    await manager.close();
  });

  it('取消之后 agent 恰好跑完了，照样不算成功', async () => {
    // 竞态的另一半：cancel 到达时 prompt 已在返回途中，agent 如实回复 `end_turn`。
    // 此前该档位走按 stopReason 判定的分支得到 ok:true，而文件已被修改、本轮本应视为取消。
    script({ ACP_TEXT: '改完了', ACP_IGNORE_CANCEL: '1', ACP_FINISH_ANYWAY: '1', ACP_SLEEP_MS: '250' });
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = run(manager, settings(), '慢慢改', { abortSignal: controller.signal });
    await waitUntil(() => methods().includes('session/prompt'));
    controller.abort();
    const result = await pending;
    // 两件事都要表述清楚：本方发起了取消（`error`），而对方报告的是已执行完成（`stopReason`）。
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled', stopReason: 'end_turn' });
    await manager.close();
  });

  it('子进程留下一个占着 stdio 的孙进程时，close() 仍然在上界内返回', async () => {
    script({ ACP_LEAK_FD: '1', ACP_TEXT: '顺手起了个后台进程' });
    const manager = new AcpManager(log);
    const started = Date.now();
    // 一次正常任务即可：agent 自行完成回复，本方照常执行 `session/close`，随后进入关停流程。
    expect(await run(manager, settings())).toMatchObject({ ok: true });
    const [pid] = pids();
    await manager.close();
    // 关停流程的绝对上界是 SIGTERM(0) → SIGKILL(5s) → 拆除管道(7s)。`'close'` 要求三条管道全部关闭，
    // 而那个孙进程始终持有其中两条；没有该上界时 `close()` 永不返回，`shutdown()` 随之阻塞。
    expect(Date.now() - started).toBeLessThan(14_000);
    expect(alive(pid!)).toBe(false);
  });

  it('agents[].timeoutMs 到点同样走 session/cancel，且错误码是 timeout 不是 cancelled', async () => {
    script({ ACP_NEVER_STOP: '1' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({}, { timeoutMs: 400 }));
    expect(methods()).toContain('session/cancel');
    // 本方的取消原因优先于 agent 返回的 cancelled：`acp_timeout` 的 hint 中包含下一步操作。
    expect(result).toMatchObject({ ok: false, error: 'acp_timeout' });
    await manager.close();
  });

  it('maxCostUsd 撞线时按协议取消 —— 它是 ACP 花费唯一的闸', async () => {
    script({ ACP_COST: '0.01', ACP_COST_STEPS: '0.01,0.09', ACP_SLEEP_MS: '400', ACP_NEVER_STOP: '1' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({ maxCostUsd: 0.02 }));
    expect(methods()).toContain('session/cancel');
    expect(result).toMatchObject({ ok: false, error: 'acp_cost_exceeded', costUsd: 0.09 });
    await manager.close();
  });

  it('permissionMode 真的下发到 session/request_permission 的答复上', async () => {
    const manager = new AcpManager(log);
    script({ ACP_PERMISSION: '1', ACP_SLEEP_MS: '50' });
    await run(manager, settings({ permissionMode: 'deny' }));
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    rmSync(METHOD_LOG, { force: true });
    script({ ACP_PERMISSION: '1', ACP_SLEEP_MS: '50' });
    await run(manager, settings({ permissionMode: 'auto' }));
    expect(methods().some((line) => line.includes('"optionId":"allow_once"'))).toBe(true);
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'info')).toBe(true);
    rmSync(METHOD_LOG, { force: true });
    events.length = 0;
    script({ ACP_PERMISSION: '1', ACP_SLEEP_MS: '50' });
    await run(manager, settings({ permissionMode: 'ask' }));
    // 未接入 `hooks.permission` 的 `ask`：按 deny 处理而非放行，并记录一行 warn。
    // 生产环境中 `available()` 已把工具挡在目录之外，执行到这里说明有调用绕过了那道门。
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'warn')).toBe(true);
    await manager.close();
  });

  it('同一个目录上硬互斥：第二个调用等着，不会各起一个 agent 改同一个仓库', async () => {
    script({ ACP_SLEEP_MS: '700' });
    const manager = new AcpManager(log);
    const first = run(manager, settings(), '第一个', { dirWaitMs: 5000 });
    // 等待第一个确实进入 prompt 阶段，而不是等待一个固定时长：繁忙机器上 spawn 加握手完全可能超过
    // 250 ms，那样断言会在第一个尚未启动时就通过，通过结果没有意义。
    await waitUntil(() => methods().includes('session/prompt'));
    const second = run(manager, settings(), '第二个', { dirWaitMs: 5000 });
    await waitUntil(() => methods().filter((method) => method === 'session/prompt').length > 1, 300);
    expect(pids()).toHaveLength(1);
    expect(await Promise.all([first, second])).toMatchObject([{ ok: true }, { ok: true }]);
    expect(pids()).toHaveLength(2);
    await manager.close();
  });

  it('等锁有界且可取消：等不到时是一句能照着做的错，不是干等十五分钟', async () => {
    script({ ACP_SLEEP_MS: '1500' });
    const manager = new AcpManager(log);
    const first = run(manager, settings());
    await waitUntil(() => pids().length === 1);
    // 外层工具是 `timeoutMs: null`，所以这道等待必须自己有上界。
    expect(await run(manager, settings(), '第二个', { dirWaitMs: 200 })).toMatchObject({ ok: false, error: 'acp_dir_busy' });
    const controller = new AbortController();
    const cancelled = run(manager, settings(), '第三个', { dirWaitMs: 30_000, abortSignal: controller.signal });
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: 'acp_cancelled' });
    await first;
    // 放弃等待的那两个仍需把队列执行完，否则该键会永久阻塞，第四个调用应能正常获取锁。
    script({});
    expect(await run(manager, settings(), '第四个')).toMatchObject({ ok: true });
    await manager.close();
  });

  it('交回给模型的结果按构造有界，中间截断永不触发', async () => {
    script({ ACP_TEXT: '"行\n'.repeat(3000) });
    const manager = new AcpManager(log);
    const result = await run(manager, settings(), '写一大堆', { outputBudgetBytes: 8192 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    // 判据与 `#normalizeOutput` 中那一行一致：`JSON.stringify(rest)` 的字节数不超过上界，
    // 因此 `stopReason` 与几个计数永远不会被中间截断影响。
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
    expect(Object.keys(result).at(-1)).toBe('output');
    // 失败路径是最紧的一档：额外包含中文 hint、detail，以及一段全是引号的 stderr 尾部。
    // 按固定余量估算固定字段的那一版在此会超限（实测 5.2 KB 超过 4 KB 的余量），而这条路径恰恰
    // 最不应被截断：被截掉的正是 `error` 与 `hint`。
    script({ ACP_TEXT: '"行\n'.repeat(3000), ACP_STOP_REASON: 'max_tokens', ACP_STDERR_LINES: '400' });
    const failed = await run(manager, settings(), '写一大堆', { outputBudgetBytes: 4096 });
    expect(failed).toMatchObject({ ok: false, error: 'acp_max_tokens', truncated: true });
    expect(failed.hint).toBeTruthy();
    expect(failed.stderr).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(failed))).toBeLessThanOrEqual(4096);
    // 最紧的一档：中文 hint、中文 detail，以及一段含 ANSI 转义的 stderr 同时存在。三者经 JSON
    // 转义放大后实测可达 13 KB，按固定余量估算的那一版在此必然超限，而这正是最不应被截断的路径
    // （被截掉的是 `error` 与 `hint`）。
    script({ ACP_REJECT_CONFIG: 'long', ACP_STDERR_LINES: '400' });
    const worst = await run(manager, settings({}, { mode: 'plan' }), '换个模式', { outputBudgetBytes: 4096 });
    expect(worst).toMatchObject({ ok: false, error: 'acp_session_failed' });
    expect(worst.detail!.length).toBeGreaterThan(20);
    expect(worst.stderr).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThanOrEqual(4096);
    // `detail` 的上界以字节计而非码元：中文按码元截取会放大三倍。
    expect(Buffer.byteLength(worst.detail!)).toBeLessThanOrEqual(512);
    await manager.close();
  });

  /**
   * 具备能力却未申报这件事必须让模型也能看到。此前那几条理由只进入 `acp.run` 的
   * `data.degraded`：运维可在 WebUI 日志中看到，而模型完全看不到，于是它让 agent 执行命令、
   * 得到一个无法解释的失败，然后绕行或自行编造原因。结果中的那一份与日志中的那一份同源
   * （`AcpSurface.notes`），而不是需要手动对齐的第二份文案。
   */
  it('terminal 没申报时结果里带那句人话，而它与 acp.run 的 data.degraded 同源', async () => {
    script({ ACP_TEXT: '我没法跑命令' });
    const manager = new AcpManager(log);
    // `sandbox.plan` 不是 host 时整个 terminal capability 不申报，而配置中仍保留 `bash`。
    const result = await run(manager, settings({}, { tools: ['read', 'bash'] }), '跑一下测试',
      { host: host('docker', 'owner 不在 sandbox.bypassRoles 里') });
    expect(result).toMatchObject({ ok: true });
    expect(result.degraded).toEqual(expect.arrayContaining([expect.stringContaining('该工具无法执行')]));
    expect(result.degraded!.some((note) => note.includes('sandbox.plan=docker'))).toBe(true);
    // 同源：日志那一行的 `data.degraded` 是同一份未截断的 notes。
    const line = events.find((event) => event.kind === 'acp.run')!;
    expect(line.level).toBe('warn');
    expect((line.data as { degraded: string[] }).degraded).toHaveLength(result.degraded!.length);
    // 长字段仍排在最后：该键位于 output 与 stderr 之前，被中间截断影响的不应是工具不可执行这类信息。
    const keys = Object.keys(result);
    expect(keys.indexOf('degraded')).toBeLessThan(keys.indexOf('output'));
    await manager.close();
  });

  it('一切正常时这个键不出现 —— 同 filesWritten / terminals 的口径', async () => {
    script({ ACP_TEXT: '改好了' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({}, { tools: ['read', 'write', 'bash'] }), '改一行', { host: host('host') });
    expect(result).toMatchObject({ ok: true });
    // 0 条时不出现该键：一个恒为 `[]` 的键每次都占用几个字节，还让模型每轮读一遍无降级信息。
    expect(result).not.toHaveProperty('degraded');
    expect(Object.keys(result)).not.toContain('degraded');
    // 该档位下 `bash` 确实可用（已申报 terminal 且 approvalMode 默认为 yolo），因此不应有任何 note。
    expect(events.find((event) => event.kind === 'acp.run')!.level).toBe('info');
    await manager.close();
  });

  it('一条不可控长度的 note 被截到上界之内，结果整体仍在预算内', async () => {
    script({ ACP_TEXT: '"行\n'.repeat(3000), ACP_STOP_REASON: 'max_tokens', ACP_STDERR_LINES: '400' });
    const manager = new AcpManager(log);
    // `plan.reason` 由沙箱侧给出，长度不可控（该 note 中还可能嵌入 jail 构造失败的 `error.message`）。
    // 失败路径叠加最小预算是最紧的一档：hint、detail、stderr 与 degraded 需要同时容纳。
    const result = await run(manager, settings({}, { tools: ['bash'] }), '写一大堆',
      { outputBudgetBytes: 4096, host: host('docker', '长'.repeat(3000)) });
    expect(result).toMatchObject({ ok: false, error: 'acp_max_tokens' });
    // 上界是 `DEGRADED_NOTE_BYTES`（384 字节）与 `DEGRADED_MAX_NOTES`（4 条）。按字节计量而非
    // 码元：这几句全为中文，按码元截取会放大三倍。
    expect(result.degraded!.length).toBeLessThanOrEqual(4);
    for (const note of result.degraded!) expect(Buffer.byteLength(note)).toBeLessThanOrEqual(384);
    // 确实发生了截断（而非恰好较短），且截断位置在中间，首尾仍可辨识这是哪一条。
    const clipped = result.degraded!.find((note) => note.includes('省略'))!;
    expect(clipped).toContain('terminal 未申报');
    expect(clipped).toContain('bytes');
    // 结构上有界这条保证仍然成立：`#normalizeOutput` 的中间截断不会触发。
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    expect(Object.keys(result).at(-1)).toBe('output');
    await manager.close();
  });
});

describe('ACP · spawn_acp 的三道门', () => {
  /** 逐条审批的 broker。存在即可，本节验证的是准入而非审批本身（后者在 acp.permission.test.ts）。 */
  const approvals = { requestExternal: async () => ({ approved: true }), recordDecided: () => undefined };
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  registerBuiltins(registry, { log, acp: new AcpManager(log), telegram: null, approvals,
    sandbox: { plan: () => ({ allowed: false }) }, schedule: { deliverable: () => false } } as never);

  const context = (config: unknown, role: string, isPrivate: boolean): ToolExecutionContext => ({
    turn: { turnId: 't', key: 'k', chatId: 'c', threadId: null, initiatorUserId: 'u', effectiveRole: role, isPrivate,
      baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
      delta: [], abortSignal: new AbortController().signal, config }, workspace: '.', agentKind: 'main' } as never);
  const on = (acp: Record<string, unknown>) => configSchema.parse({ access: { bootstrapOwnerId: '1' },
    agent: { acp: { enabled: true, allowedDirs: [WORK], agents: [{ name: 'fixture', command: FIXTURE }], ...acp } } });

  it('无条件注册，靠 available() 关 —— 否则 main.ts 那条启动断言把进程拦死', () => {
    expect(registry.names()).toContain('spawn_acp');
    expect(TOOL_POLICY.spawn_acp).toMatchObject({ minRole: 'owner', approval: 'always' });
    // 档位与 `spawn_harness` 逐字相同：风险面是同一个，可观测性不换权限。
    expect(TOOL_POLICY.spawn_acp).toEqual(TOOL_POLICY.spawn_harness);
  });

  it('默认配置（整块关 / 白名单为空）下不进模型的工具目录', () => {
    const off = configSchema.parse({ access: { bootstrapOwnerId: '1' } });
    expect(registry.activeNames('owner', context(off, 'owner', true))).not.toContain('spawn_acp');
    expect(registry.activeNames('owner', context(on({ allowedDirs: [] }), 'owner', true))).not.toContain('spawn_acp');
    expect(registry.activeNames('owner', context(on({ enabled: false }), 'owner', true))).not.toContain('spawn_acp');
    // 没有任何已启用 agent 时同样不进入目录：进入目录后再报告无可用 agent 是纯粹的浪费。
    expect(registry.activeNames('owner', context(on({ agents: [{ name: 'x', command: 'y', enabled: false }] }), 'owner', true))).not.toContain('spawn_acp');
  });

  /**
   * `ask` 需要一条真实的审批通道，无法接入时整个工具不进入目录：保留自动放行会让一个名为 `ask`
   * 的档位实际在放行，正是 `docs/reviews/16 §5` 所说的伪造一道门。判据落在 `available()` 而非
   * `execute()`：模型不会去尝试一个必然被拒的调用。
   *
   * `ask` 不是默认档（默认为 `auto`，`docs/14 §2 Q8-c`），因此这道闸只对主动配置了它的部署生效，
   * 用例据此显式写出 `permissionMode: 'ask'`，而不是依赖默认值引入。
   */
  it('ask 档没有审批 broker 时不进目录，默认档 auto 与 deny 照旧进', () => {
    const noBroker = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
    registerBuiltins(noBroker, { log, acp: new AcpManager(log), telegram: null,
      sandbox: { plan: () => ({ allowed: false }) }, schedule: { deliverable: () => false } } as never);
    expect(noBroker.activeNames('owner', context(on({ permissionMode: 'ask' }), 'owner', true))).not.toContain('spawn_acp');
    // 默认档（不提供该键）与 `deny` 都不需要 broker，因此缺少审批通道不会拦住它们。
    for (const acp of [{}, { permissionMode: 'auto' }, { permissionMode: 'deny' }]) {
      expect(noBroker.activeNames('owner', context(on(acp), 'owner', true))).toContain('spawn_acp');
    }
    // 存在 broker 时 `ask` 正常进入：缺失的是通道，而非该档位本身。
    expect(registry.activeNames('owner', context(on({ permissionMode: 'ask' }), 'owner', true))).toContain('spawn_acp');
  });

  it('仅 owner、仅私聊', () => {
    const config = on({});
    expect(registry.activeNames('owner', context(config, 'owner', true))).toContain('spawn_acp');
    expect(registry.activeNames('owner', context(config, 'owner', false))).not.toContain('spawn_acp');
    expect(registry.activeNames('trusted', context(config, 'trusted', true))).not.toContain('spawn_acp');
  });

  it('运维覆盖 minRole 也绕不过 available()：目录与准入两侧同时拒绝', async () => {
    registry.bindOverrides(() => ({ spawn_acp: { minRole: 'limited' } }));
    const config = on({});
    expect(registry.activeNames('trusted', context(config, 'trusted', false))).not.toContain('spawn_acp');
    expect(await registry.execute('spawn_acp', { task: 'x'.repeat(20), dir: WORK }, context(config, 'trusted', false)))
      .toMatchObject({ ok: false, error: 'tool_unavailable' });
    registry.bindOverrides(() => ({}));
  });

  it('第三道门：审批被拒时一个子进程都不起', async () => {
    // `approval: 'always'` 仅在表中声明不足以说明问题，需要证明它确实排在 spawn 之前。用例的判据是
    // spawn 日志：拒绝之后该日志必须为空（`available()` 与 `admit()` 都已放行，
    // 拦截它的只能是审批）。
    const denied = new ToolRegistry(log, { request: async () => false }, { maxRegistered: 200, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
    registerBuiltins(denied, { log, acp: new AcpManager(log), telegram: null, approvals,
      sandbox: { plan: () => ({ allowed: false }) }, schedule: { deliverable: () => false } } as never);
    const ctx = context(on({}), 'owner', true);
    expect(denied.activeNames('owner', ctx)).toContain('spawn_acp');
    expect(await denied.execute('spawn_acp', { task: 'x'.repeat(20), dir: WORK }, ctx)).toMatchObject({ ok: false, error: '未获批准' });
    expect(pids()).toEqual([]);
  });

  it('多 agent 时才给 agent 参数加枚举，单 agent 部署 schema 逐字节不变', () => {
    /** 模型实际看到的那一份：`inputSchemaFor` 每轮从 `turn.config` 实时计算（与 archive 那四个上限一致）。 */
    const schemaOf = (config: unknown) => {
      const ctx = context(config, 'owner', true);
      const tool = registry.active('owner', ctx).find((entry) => entry.name === 'spawn_acp')!;
      return tool.inputSchemaFor?.(ctx) ?? tool.inputSchema;
    };
    const one = schemaOf(on({}));
    const two = schemaOf(on({ agents: [{ name: 'a', command: 'x' }, { name: 'b', command: 'y' }] }));
    expect(Object.keys((one as unknown as { shape: object }).shape).sort()).toEqual(['dir', 'task']);
    expect(Object.keys((two as unknown as { shape: object }).shape).sort()).toEqual(['agent', 'dir', 'task']);
    expect(two.safeParse({ task: 'x'.repeat(20), dir: WORK, agent: 'nope' }).success).toBe(false);
    expect(two.safeParse({ task: 'x'.repeat(20), dir: WORK, agent: 'b' }).success).toBe(true);
  });
});

/**
 * 外部花费落库（迁移 `0014`）。本节验证的不是记录了多少，而是它没有进入哪些位置：
 * 那个数字不属于本系统，它是外部 agent 自身 provider 账单的累计值，口径由对方决定、本方无法核对，
 * 也没有 tokens × prices 可供重算。对真实数据库运行（遵循本仓约定，不引入 mock 层）。
 */
describe('ACP · 外部花费落库，但不进任何计价口径', () => {
  const DB_PATH = resolve('data/acp-runs.test.db');
  const TURN = 'turn-acp-external-1';
  const fresh = () => {
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
    const db = openDatabase(DB_PATH);
    migrateDatabase(db);
    // 本轮的主 run 需先存在：ACP 那一行要挂在它之下（该调用发生在主 agent 的一次工具调用中）。
    db.prepare(`INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at)
      VALUES ('main-1',?,0,'main','main','fast','owner','running',?)`).run(TURN, Date.now());
    return db;
  };

  it('花费进 external_cost_usd，cost_usd 恒 0，usage_ledger / quota_counters 零新增', async () => {
    const db = fresh();
    script({ ACP_TEXT: '改好了', ACP_TOOL_CALL: '1', ACP_COST: '0.42', ACP_COST_STEPS: '0.11,0.42' });
    const manager = new AcpManager(log, new AcpRunRecorder(db));
    const result = await run(manager, settings(), '把 probe.txt 里的 hello 改成 HELLO', { trace: { traceId: TURN } });
    expect(result).toMatchObject({ ok: true, costUsd: 0.42 });
    const row = db.prepare("SELECT * FROM agent_runs WHERE turn_id=? AND kind='sub'").get(TURN) as Record<string, unknown>;
    // 累计值取观察到的最大值（0.11 之后又收到 0.42），并写入该列。
    expect(row.external_cost_usd).toBe(0.42);
    /**
     * 这是整块的核心判据：`cost_usd` 恒为 0，因此外部数字在结构上不会进入任何 `SUM(cost_usd)`。
     * 断言写成全表求和而非只检查这一行：将来有人把它改回 cost_usd 正是要防的情形。
     */
    expect(db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS value FROM agent_runs').pluck().get()).toBe(0);
    expect(row.cost_usd).toBe(0);
    // 行的身份：`kind='sub'`（`CHECK` 只有两档，迁移是追加式的、未改动任何 CHECK），加上两个可将它
    // 与本系统自身子 agent 区分开的字段。
    expect(row.agent_name).toBe('acp:fixture');
    expect(row.model_alias).toBe('external');
    expect(row.parent_run_id).toBe('main-1');
    expect(row.depth).toBe(1);
    expect(row.state).toBe('done');
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    // 用量数据是自描述的：读者应一眼看出这些数字并非来自本系统。
    expect(JSON.parse(row.external_usage_json as string)).toMatchObject({ source: 'acp', agent: 'fixture', costUsd: 0.42, toolCalls: 1 });
    /**
     * 三张与计价相关的表一行都不得新增。`usage_ledger` 的行带 provider 身份（`provider_id` 与
     * `model_id` 必填、用量页按其分桶），写入一条 `provider_id='omp'` 等于凭空造出一个本系统并不拥有的
     * provider；`quota_counters` 的分母是本系统的 key，掺入外部花费后该比例看似权威、实则
     * 无意义；`turns.cost_usd` 同理（本用例甚至未创建 turn 行，因此同时证明它未写入任何内容）。
     */
    expect(db.prepare('SELECT COUNT(*) AS value FROM usage_ledger').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS value FROM quota_counters').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS value FROM turns').pluck().get()).toBe(0);
    // 日志与库里那一行之间唯一的接缝。
    const line = events.find((event) => event.kind === 'acp.run')!;
    expect((line.data as { runId: string }).runId).toBe(row.id);
    await manager.close();
    closeDatabase(db);
  });

  it('它一次 usage_update 都没报 → external_cost_usd 是 NULL，不是 0', async () => {
    const db = fresh();
    // 未上报与上报 0 是两回事，因此该列可空而非 default 0：写 0 会让一次没有账单
    // 的调用看起来像一次零成本调用。
    script({ ACP_TEXT: '看了看，没动手' });
    const manager = new AcpManager(log, new AcpRunRecorder(db));
    expect(await run(manager, settings(), '看一眼 probe.txt 里写了什么', { trace: { traceId: TURN } })).toMatchObject({ ok: true });
    const row = db.prepare("SELECT external_cost_usd AS cost, cost_usd AS ours FROM agent_runs WHERE turn_id=? AND kind='sub'").get(TURN) as { cost: number | null; ours: number };
    expect(row.cost).toBeNull();
    expect(row.ours).toBe(0);
    await manager.close();
    closeDatabase(db);
  });

  it('没有 traceId 就不落行 —— 挂不上 turn 的 trace 行没有读法', async () => {
    const db = fresh();
    script({ ACP_TEXT: 'ok', ACP_COST: '0.01' });
    const manager = new AcpManager(log, new AcpRunRecorder(db));
    expect(await run(manager, settings())).toMatchObject({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS value FROM agent_runs WHERE kind='sub'").pluck().get()).toBe(0);
    await manager.close();
    closeDatabase(db);
  });

  it('记账失败不改变调用的结果 —— 只多一条 warn', async () => {
    const db = fresh();
    script({ ACP_TEXT: 'ok', ACP_COST: '0.01' });
    // 一次成功的 ACP 调用已经完成了对仓库的修改。若因写库失败而报告 ok:false，模型会认为什么都
    // 没有发生，其后果远比丢失一行记账严重。
    const manager = new AcpManager(log, { record: () => { throw new Error('disk full'); } });
    expect(await run(manager, settings(), '把 probe.txt 里的 hello 改成 HELLO', { trace: { traceId: TURN } })).toMatchObject({ ok: true });
    expect(events.some((event) => event.kind === 'acp.run' && event.level === 'warn'
      && typeof (event.data as { recordFailed?: string }).recordFailed === 'string')).toBe(true);
    await manager.close();
    closeDatabase(db);
  });
});
