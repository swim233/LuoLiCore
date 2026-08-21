import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACP_ERROR_HINTS, AcpLineOverflowError, AcpManager, ACP_CLIENT_CAPABILITIES, acpChildEnv, acpStopReasonError, buildAcpArgv, clipToJsonBudget, configSchema, enabledAcpAgents, floorPermission, guardedByteStream, resolveAcpAgent, ToolRegistry, registerBuiltins, TOOL_POLICY, type AcpAgentSettings, type AcpSettings, type ToolExecutionContext } from '@luoli/core';

/**
 * M13 · ACP 客户端的运行时用例。**一律用 fixture，不碰真 `omp`** —— 用例必须离线且确定性。
 * fixture 的行为由 env 脚本化（见 `tests/fixtures/acp-agent.mjs` 开头那份清单）。
 *
 * fixture 走 shebang 直接执行而不是 `node <file>`：`buildAcpArgv` 的第一项恒为 `acp` 子命令，
 * `spawn(node, ['acp', …, fixture])` 会让 node 去找一个叫 `acp` 的文件。走 shebang 之后那些 flag
 * 变成 fixture 自己忽略的 argv —— 顺带证明了 argv 真的被下发出去了。
 */
const FIXTURE = resolve('tests/fixtures/acp-agent.mjs');
const WORK = resolve('data/acp-work');
/**
 * **每个用例一份 spawn 日志。** 共用一份再断言全局条数的话，任何一个用例漏掉一条活着的子进程
 * 都会静默把下一个用例的数字挪一格 —— 实测四次连跑里有一次在「目录互斥」那条上数到三个 pid，
 * 而那条用例自己只该起两个。计数只算自己起的，这类串味就不存在了。
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

/** 经真 `configSchema` 走一遍：默认值、`--tools` 的四项、extraArgs 的闸都要真的参与用例。 */
function settings(acp: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): AcpSettings {
  return configSchema.parse({ access: { bootstrapOwnerId: '1' }, agent: { acp: {
    enabled: true, allowedDirs: [WORK], ...acp,
    agents: [{ name: 'fixture', command: FIXTURE, profile: '', tools: [], handshakeTimeoutMs: 4000, timeoutMs: 8000, ...agent }],
  } } }).agent.acp;
}

/** 每个用例自己的 env 脚本。`ACP_*` 直接落在 `process.env` 上 —— `acpChildEnv()` 会整份交下去。 */
function script(vars: Record<string, string>): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('ACP_')) delete process.env[key];
  process.env.ACP_SPAWN_LOG = SPAWN_LOG;
  process.env.ACP_METHOD_LOG = METHOD_LOG;
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

const run = (manager: AcpManager, acp: AcpSettings, task = '把 probe.txt 里的 hello 改成 HELLO', extra: Record<string, unknown> = {}) =>
  manager.run({ task, dir: WORK }, acp, { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, ...extra });

beforeEach(() => {
  mkdirSync(WORK, { recursive: true });
  // fixture 走 shebang 直接执行，所以执行位是它的前提；checkout 丢了这一位的表现会是一整片
  // `acp_spawn_failed`，与「实现坏了」长得一模一样。
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
  it('argv：--approval-mode 无条件下发，--tools 空数组不下发，会话模式不上 argv', () => {
    const base: AcpAgentSettings = { name: 'a', enabled: true, command: 'omp', profile: 'telegram', approvalMode: 'write',
      tools: ['read', 'write', 'edit', 'bash'], model: '', mode: 'plan', extraArgs: ['--no-session'],
      handshakeTimeoutMs: 1, timeoutMs: 1, maxOutputBytes: 1 };
    expect(buildAcpArgv(base)).toEqual(['acp', '--profile=telegram', '--approval-mode=write', '--tools=read,write,edit,bash', '--no-session']);
    // `mode` 一个字都不该出现在 argv 上：omp 的 `--mode` 是输出格式（text/json/rpc/rpc-ui），
    // 下发过去会把 stdio 上的 JSON-RPC 弄坏。会话模式只能走 `session/set_config_option`。
    expect(buildAcpArgv(base).join(' ')).not.toContain('--mode');
    // profile 空 = 不加；tools 空数组 = 不加（空的 `--tools=` 是「一个工具都不给」，不是「全给」）。
    expect(buildAcpArgv({ ...base, profile: '', tools: [], extraArgs: [] })).toEqual(['acp', '--approval-mode=write']);
    // yolo 也照样显式下发：profile 里写着什么都盖过去，不显式盖就是静默失去权限门。
    expect(buildAcpArgv({ ...base, approvalMode: 'yolo', profile: '', tools: [], extraArgs: [] })).toContain('--approval-mode=yolo');
  });

  it('extraArgs 写一份我们管着的 flag 时 schema 当场拒收', () => {
    const bad = (extraArgs: string[]) => () => configSchema.parse({ access: { bootstrapOwnerId: '1' },
      agent: { acp: { agents: [{ name: 'a', command: 'omp', extraArgs }] } } });
    expect(bad(['--approval-mode=yolo'])).toThrow(/extraArgs|approval-mode/);
    expect(bad(['--tools'])).toThrow();
    expect(bad(['--auto-approve'])).toThrow();
    expect(bad(['--cwd=/etc'])).toThrow();
    // 不在名单上的照收 —— 这个闸是为了「一行配置静默去掉一道门」，不是为了禁止所有自定义参数。
    expect(() => configSchema.parse({ access: { bootstrapOwnerId: '1' },
      agent: { acp: { agents: [{ name: 'a', command: 'omp', extraArgs: ['--no-session', '--thinking=low'] }] } } })).not.toThrow();
  });

  it('本轮不申报 fs / terminal —— 协议里省略就等于 UNSUPPORTED', () => {
    // 谎报一个我们不会答的 method 会让 agent 发出请求之后挂住，而它正握着一个半改完的文件。
    expect(ACP_CLIENT_CAPABILITIES).toEqual({});
    expect(ACP_CLIENT_CAPABILITIES.fs).toBeUndefined();
    expect(ACP_CLIENT_CAPABILITIES.terminal).toBeUndefined();
  });

  it('StopReason 五档：只有 end_turn 算成功', () => {
    expect(acpStopReasonError('end_turn')).toBeNull();
    expect(acpStopReasonError('max_tokens')).toBe('acp_max_tokens');
    expect(acpStopReasonError('max_turn_requests')).toBe('acp_max_turn_requests');
    expect(acpStopReasonError('refusal')).toBe('acp_refusal');
    expect(acpStopReasonError('cancelled')).toBe('acp_cancelled');
    // 每一档都要有一句能照着做的 hint —— 交回 `error` 而没有 hint 时模型只会原样重试。
    for (const code of ['acp_max_tokens', 'acp_max_turn_requests', 'acp_refusal', 'acp_cancelled'] as const) {
      expect(ACP_ERROR_HINTS[code].length).toBeGreaterThan(10);
    }
  });

  /**
   * 错误契约与 `docs/05 §3.5.1` 那张表**双向**焊住，照 `docs/10 §2` 那张 kind 表的先例。
   *
   * 「`errors.ts` 一处定义」这句话本身不构成保证：文案只有一份，但那一份与文档对不对得上仍然要有
   * 东西量。少一行 = 模型交回一个手册里查不到的错误码；多一行 = 手册写了一个永远不会出现的档。
   */
  it('错误码与 docs/05 §3.5.1 的契约表逐条对得上', () => {
    const doc = readFileSync('docs/05-tools-and-permissions.md', 'utf8');
    const section = /^#### 3\.5\.1[\s\S]*?(?=^### 3\.6)/m.exec(doc)?.[0];
    expect(section, 'docs/05 里找不到 §3.5.1 那一节').toBeTruthy();
    const documented = new Set<string>();
    for (const line of section!.split('\n')) {
      if (!line.startsWith('|')) continue;
      // 只认**第一列**：其余列的正文里会引用别的错误码（`acp_line_too_long` 那行就提到
      // `acp_connection_lost`），认全表等于让「文档里提到过」变成「表里有」。
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
    // 分段累计而不是逐块判：50 + 50 各自不到 64，跨块那一行才越界。
    const ok = guardedByteStream(Readable.from([Buffer.from('x'.repeat(60)), Buffer.from('\n'), Buffer.from('x'.repeat(60)), Buffer.from('\n')]), 64).getReader();
    for (;;) { const { done } = await ok.read(); if (done) break; }
  });

  it('结果按构造有界：JSON 转义放大之后仍然装得下', () => {
    const nasty = '"\n\t'.repeat(4000);
    const clip = clipToJsonBudget(nasty, 1024);
    expect(clip.truncated).toBe(true);
    // 判据是**序列化之后**的字节数：`#normalizeOutput` 量的是 `JSON.stringify(rest)`。
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
    // 停用的与不存在的都是 null —— 不「随便挑一个」：那台 agent 的 --tools / --approval-mode 可能完全不同。
    expect(resolveAcpAgent(two, 'c')).toBeNull();
    expect(resolveAcpAgent(two, 'nope')).toBeNull();
  });

  it('permission 地板：deny 真拒、auto 放行、ask 本轮按放行且标记出来', () => {
    const request = { sessionId: 's', toolCall: { toolCallId: 't' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' as const }, { optionId: 'no', name: 'Reject', kind: 'reject_once' as const }] };
    expect(floorPermission(request, 'auto')).toEqual({ response: { outcome: { outcome: 'selected', optionId: 'ok' } }, floored: false });
    expect(floorPermission(request, 'deny')).toEqual({ response: { outcome: { outcome: 'selected', optionId: 'no' } }, floored: false });
    // `ask` 这一档的真实行为在波 3。`floored: true` 是它每次记一条 warn 的依据 ——
    // 「我配的是 ask 但它没问我」必须在日志里有一行。
    expect(floorPermission(request, 'ask')).toEqual({ response: { outcome: { outcome: 'selected', optionId: 'ok' } }, floored: true });
    // 一个 reject 档都没给时 `deny` 回 cancelled，**不翻成放行**。
    expect(floorPermission({ ...request, options: [request.options[0]!] }, 'deny')).toEqual({ response: { outcome: { outcome: 'cancelled' } }, floored: false });
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
    // 「起得来但握不上手」的那条不能留下来：MCP 那边正是这个形态让 `shutdown()` 回不去
    // （docs/28 · L-EXT-03）。fixture 在这一档扛住 stdin 结束，所以只有信号收得掉它。
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
    // `close()` 返回之后立刻判，不给它任何宽限：返回即已死才是这条断言的意思。
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
    // 不报 `acp_connection_lost`：那句话会让运维去查 agent 的退出码，而什么也查不到。
    expect(await run(manager, settings())).toMatchObject({ ok: false, error: 'acp_line_too_long' });
    await manager.close();
  });

  it('一趟正常的任务：session/new → prompt → close，产出与计数都在', async () => {
    script({ ACP_TEXT: '改好了：hello → HELLO', ACP_TOOL_CALL: '1', ACP_COST_STEPS: '0.004', ACP_COST: '0.004' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings());
    expect(result).toMatchObject({ ok: true, stopReason: 'end_turn', agent: 'fixture', toolCalls: 1, updatesDropped: 0, costUsd: 0.004 });
    expect(result.output).toContain('HELLO');
    // 会话作用域 = 一次工具调用：`finally` 里一定要有 `session/close`（不落库 sessionId 的另一半）。
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
    // 运维要的是 plan（只读规划），静默退回 default 等于让它真的去改文件。
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
      // 最危险的是 `max_tokens`：它长得最像成功，而产出是做了一半的改动。
      expect(await run(manager, settings())).toMatchObject({ ok: false, error, stopReason });
    }
    await manager.close();
  });

  it('maxUpdatesPerPrompt 撞上界只丢弃、不断连', async () => {
    script({ ACP_FLOOD: '50' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({ maxUpdatesPerPrompt: 10 }));
    // 与 `collectProcess` 刻意分岔：那边溢出源是我们杀得掉的字节流，这边 agent 正在改真实文件。
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
    // 这一条是「我们走的是协议」的证据：协议要求 agent 停模型请求、abort 在途工具、发完待发的
    // update，然后用 cancelled 应答 —— 直接杀进程会让它死在半个写操作上。
    expect(methods()).toContain('session/cancel');
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled', stopReason: 'cancelled' });
    await manager.close();
  });

  /**
   * 复审揪出来的那个 blocker。握手最长四跳 × `handshakeTimeoutMs`（默认合起来两分钟），
   * `/cancel` 完全可能落在那一段里 —— 而 ACP 没有「预先取消」的语义：照发一条 `session/cancel`
   * 再照发 `session/prompt`，agent 会把 cancel 丢掉、把任务整个跑完、答一句 `end_turn`，
   * 于是一轮**已经取消**的调用改完了整个仓库还报 `ok: true`。
   */
  it('握手期间被取消：不发 prompt，也绝不报成功', async () => {
    // 撑开握手窗口：fixture 本身快到毫秒级，不 delay 的话 abort 永远落在 prompt 已经在飞之后，
    // 用例就量不到这条路（写这条时第一版正是这么假过的）。
    script({ ACP_TEXT: '我把整个仓库都改了', ACP_DELAY_AT: 'session/new', ACP_DELAY_MS: '900' });
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = run(manager, settings(), '慢慢改', { abortSignal: controller.signal });
    await waitUntil(() => methods().includes('session/new'));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled' });
    // 判据是**它有没有真的干活**，不是错误码：`session/prompt` 一次都不能出现。
    expect(methods()).not.toContain('session/prompt');
    await manager.close();
  });

  it('取消之后 agent 恰好跑完了，照样不算成功', async () => {
    // 竞态的另一半：cancel 送到时 prompt 已经在返回路上，agent 如实答 `end_turn`。
    // 此前这一档落在「按 stopReason 判」那一支上 → ok:true，而文件已经被改、这一轮本该是取消的。
    script({ ACP_TEXT: '改完了', ACP_IGNORE_CANCEL: '1', ACP_FINISH_ANYWAY: '1', ACP_SLEEP_MS: '250' });
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = run(manager, settings(), '慢慢改', { abortSignal: controller.signal });
    await waitUntil(() => methods().includes('session/prompt'));
    controller.abort();
    const result = await pending;
    // 两件事都说得出来：我们取消了（`error`），而它报的是它跑完了（`stopReason`）。
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled', stopReason: 'end_turn' });
    await manager.close();
  });

  it('子进程留下一个占着 stdio 的孙进程时，close() 仍然在上界内返回', async () => {
    script({ ACP_LEAK_FD: '1', ACP_TEXT: '顺手起了个后台进程' });
    const manager = new AcpManager(log);
    const started = Date.now();
    // 一趟**正常**的任务就够：agent 自己答完、我们照常 `session/close`，然后走关停梯。
    expect(await run(manager, settings())).toMatchObject({ ok: true });
    const [pid] = pids();
    await manager.close();
    // 关停梯的绝对上界是 SIGTERM(0) → SIGKILL(5s) → 拆管道(7s)。`'close'` 要求三条管道全关，
    // 而那个孙进程一直握着两条 —— 没有这个上界的话 `close()` 永远不返回，`shutdown()` 跟着钉住。
    expect(Date.now() - started).toBeLessThan(14_000);
    expect(alive(pid!)).toBe(false);
  });

  it('agents[].timeoutMs 到点同样走 session/cancel，且错误码是 timeout 不是 cancelled', async () => {
    script({ ACP_NEVER_STOP: '1' });
    const manager = new AcpManager(log);
    const result = await run(manager, settings({}, { timeoutMs: 400 }));
    expect(methods()).toContain('session/cancel');
    // 我们自己的取消原因压过 agent 那句 cancelled：`acp_timeout` 的 hint 里有下一步该做什么。
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
    expect(methods().some((line) => line.includes('"optionId":"reject"'))).toBe(true);
    rmSync(METHOD_LOG, { force: true });
    script({ ACP_PERMISSION: '1', ACP_SLEEP_MS: '50' });
    await run(manager, settings({ permissionMode: 'auto' }));
    expect(methods().some((line) => line.includes('"optionId":"allow"'))).toBe(true);
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'info')).toBe(true);
    rmSync(METHOD_LOG, { force: true });
    events.length = 0;
    script({ ACP_PERMISSION: '1', ACP_SLEEP_MS: '50' });
    await run(manager, settings({ permissionMode: 'ask' }));
    // `ask` 这一档本轮暂按放行，而它**必须留一行 warn** —— 否则「我配的是 ask 但它没问我」
    // 在任何地方都看不出来。
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'warn')).toBe(true);
    await manager.close();
  });

  it('同一个目录上硬互斥：第二个调用等着，不会各起一个 agent 改同一个仓库', async () => {
    script({ ACP_SLEEP_MS: '700' });
    const manager = new AcpManager(log);
    const first = run(manager, settings(), '第一个', { dirWaitMs: 5000 });
    // 等「第一个真的在跑 prompt 了」而不是等一个墙钟数：一台忙机器上 spawn + 握手完全可能超过
    // 250 ms，那样断言会在第一个都还没起来的时候就通过 —— 通过得毫无意义。
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
    // 放弃等待的那两个仍然要把队列走完，否则这个键会永远堵住 —— 第四个调用照常拿得到锁。
    script({});
    expect(await run(manager, settings(), '第四个')).toMatchObject({ ok: true });
    await manager.close();
  });

  it('交回给模型的结果按构造有界，中间截断永不触发', async () => {
    script({ ACP_TEXT: '"行\n'.repeat(3000) });
    const manager = new AcpManager(log);
    const result = await run(manager, settings(), '写一大堆', { outputBudgetBytes: 8192 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    // 判据就是 `#normalizeOutput` 那一行的判据：`JSON.stringify(rest)` 的字节数不超上界，
    // 于是 `stopReason` 与几个计数永远不会被中间截断吃掉。
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
    expect(Object.keys(result).at(-1)).toBe('output');
    // **失败路径才是最紧的那一档**：多出中文 hint、detail、以及一段全是引号的 stderr 尾巴。
    // 固定字段按固定余量估的那一版在这里会超（实测 5.2 KB > 4 KB 的余量），而这一路恰好是
    // 最不该被截的 —— 被吃掉的正好是 `error` 与 `hint`。
    script({ ACP_TEXT: '"行\n'.repeat(3000), ACP_STOP_REASON: 'max_tokens', ACP_STDERR_LINES: '400' });
    const failed = await run(manager, settings(), '写一大堆', { outputBudgetBytes: 4096 });
    expect(failed).toMatchObject({ ok: false, error: 'acp_max_tokens', truncated: true });
    expect(failed.hint).toBeTruthy();
    expect(failed.stderr).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(failed))).toBeLessThanOrEqual(4096);
    // 最紧的那一档：中文 hint + **中文 detail** + 一段带 ANSI 转义的 stderr 全都在。三者的 JSON
    // 转义放大合起来实测能到 13 KB，按固定余量估的那一版在这里必破 —— 而这正是最不该被截的一路
    // （被吃掉的是 `error` 与 `hint`）。
    script({ ACP_REJECT_CONFIG: 'long', ACP_STDERR_LINES: '400' });
    const worst = await run(manager, settings({}, { mode: 'plan' }), '换个模式', { outputBudgetBytes: 4096 });
    expect(worst).toMatchObject({ ok: false, error: 'acp_session_failed' });
    expect(worst.detail!.length).toBeGreaterThan(20);
    expect(worst.stderr).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThanOrEqual(4096);
    // `detail` 的上界是**字节**而不是码元：中文按码元切出来是三倍。
    expect(Buffer.byteLength(worst.detail!)).toBeLessThanOrEqual(512);
    await manager.close();
  });
});

describe('ACP · spawn_acp 的三道门', () => {
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  registerBuiltins(registry, { log, acp: new AcpManager(log), telegram: null,
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
    // 一台启用的 agent 都没有时同样不进：进了目录再报「没有 agent」是纯粹的浪费。
    expect(registry.activeNames('owner', context(on({ agents: [{ name: 'x', command: 'y', enabled: false }] }), 'owner', true))).not.toContain('spawn_acp');
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
    // `approval: 'always'` 光在表里写着不算 —— 要证明它真的排在 spawn 之前。用例的判据是
    // spawn 日志：拒了之后那份日志必须一行都没有（`available()` 与 `admit()` 都放行了，
    // 挡住它的只能是审批）。
    const denied = new ToolRegistry(log, { request: async () => false }, { maxRegistered: 200, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
    registerBuiltins(denied, { log, acp: new AcpManager(log), telegram: null,
      sandbox: { plan: () => ({ allowed: false }) }, schedule: { deliverable: () => false } } as never);
    const ctx = context(on({}), 'owner', true);
    expect(denied.activeNames('owner', ctx)).toContain('spawn_acp');
    expect(await denied.execute('spawn_acp', { task: 'x'.repeat(20), dir: WORK }, ctx)).toMatchObject({ ok: false, error: '未获批准' });
    expect(pids()).toEqual([]);
  });

  it('多 agent 时才给 agent 参数加枚举，单 agent 部署 schema 逐字节不变', () => {
    /** 模型真正看到的那一份：`inputSchemaFor` 每轮从 `turn.config` 现算（同 archive 那四个上限）。 */
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
