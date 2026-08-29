import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcpManager, AcpTerminals, PathJail, configSchema, type AcpSettings } from '@luoli/core';

/**
 * M13 · 反向终端（`terminal/*`，`docs/05 §3.5.2`）。
 *
 * 分为两层：`AcpTerminals` 的生命周期、上界与回收直接测试（真实启动进程、真实终止进程组、真实统计句柄）；
 * 非 host 时不申报 terminal 那一条只有走完整握手才能验证，因为申报值由客户端计算，外部
 * 唯一可观察的位置是 agent 在 `initialize` 中收到的那一份，因此该条使用 fixture 与 `ACP_CAPS`。
 *
 * 不使用真实 `omp`（用例必须离线且确定）。
 */
const FIXTURE = resolve('tests/fixtures/acp-agent.mjs');
const ROOT = resolve('data/acp-term-work');
/**
 * 长时间运行的命令写成脚本文件而非 `-e`。原因是 fixture 的 argv 以逗号分隔，而任何
 * `setTimeout(fn, ms)` 都包含一个逗号：写成 `-e` 的版本会被切成两段，node 立即因语法错误退出，
 * 于是命令仍在宿主上运行这几条用例实际都在验证一个已退出的进程（编写时确实出现过该假通过）。
 */
const SLEEPER = resolve(ROOT, 'sleeper.cjs');
let METHOD_LOG = '';
let caseSeq = 0;

const events: Array<{ level: string; kind: string; summary: string; data?: Record<string, unknown> }> = [];
const log = { event: (event: { level: string; kind: string; summary: string }) => { events.push(event); return 1; },
  publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as never;

const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const methods = (): string[] => lines(METHOD_LOG);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/** `process.kill(pid, 0)` 不发送信号，只查询该 pid 是否存在，是泄漏检测唯一可靠的判据。 */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

const LIMITS = { maxTerminals: 3, maxTimeoutMs: 5000, maxOutputBytes: 65_536 };
/** 完全按 `AcpManager.#surface` 的构造方式：root 与 base 都经 realpath 处理，因此边界与 cwd 是同一字面量。 */
function terminals(limits: Partial<typeof LIMITS> = {}, denyGlobs: string[] = []): AcpTerminals {
  const root = realpathSync(ROOT);
  return new AcpTerminals(new PathJail(root, denyGlobs, { base: root }), root, { ...LIMITS, ...limits });
}
const create = (subject: AcpTerminals, command: string, args: string[] = [], extra: Record<string, unknown> = {}): string =>
  subject.create({ sessionId: 's', command, args, ...extra } as never).terminalId;

function settings(acp: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): AcpSettings {
  return configSchema.parse({ access: { bootstrapOwnerId: '1' }, agent: { acp: {
    enabled: true, allowedDirs: [ROOT], permissionMode: 'auto', ...acp,
    agents: [{ name: 'fixture', command: FIXTURE, profile: '', tools: [], handshakeTimeoutMs: 4000, timeoutMs: 8000, ...agent }],
  } } }).agent.acp;
}
/** `plan` 的结果由用例给出：本节验证的正是结果不是 host 时的行为。 */
const host = (mode: 'none' | 'host' | 'docker' = 'host') => ({
  fs: { denyGlobs: [] as string[], maxReadBytes: 262_144, maxWriteBytes: 5_242_880, backupDir: '.luoli-bak' },
  exec: { maxTimeoutMs: 5000, maxOutputBytes: 65_536 },
  plan: () => ({ mode, ...(mode === 'host' ? {} : { reason: '沙箱未启用，执行类工具已禁用' }) }),
});

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(SLEEPER, 'setInterval(function () {}, 60000);\n');
  chmodSync(FIXTURE, 0o755);
  caseSeq += 1;
  METHOD_LOG = resolve(`data/acp-term-methods-${caseSeq}.log`);
  rmSync(METHOD_LOG, { force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('ACP_')) delete process.env[key];
  process.env.ACP_METHOD_LOG = METHOD_LOG;
  events.length = 0;
});

describe('ACP 终端 · 生命周期', () => {
  it('create → wait_for_exit → output → release 各是一个动词，kill 之后 output 照旧读得到', async () => {
    const subject = terminals();
    const id = create(subject, process.execPath, ['-e', 'process.stdout.write("hi\\n"); process.exit(3)']);
    expect(await subject.waitForExit(id)).toEqual({ exitCode: 3, signal: null });
    expect(subject.output(id)).toMatchObject({ output: 'hi\n', truncated: false, exitStatus: { exitCode: 3, signal: null } });
    // `kill` 不释放句柄：协议明确规定 kill 之后仍可读取 output，这正是它与 release 的分工。
    subject.kill(id);
    expect(subject.output(id)).toMatchObject({ output: 'hi\n' });
    subject.release(id);
    // 已 release 的以及从未创建的，一律返回明确的错误而不是挂起的请求。
    expect(() => subject.output(id)).toThrow(/terminalId/);
    expect(() => subject.output('term_nope')).toThrow(/terminalId/);
    expect(subject.releaseAll()).toEqual([]);
  });

  it('argv 直传不过 shell —— 一个带 shell 元字符的参数只是普通字符', async () => {
    const subject = terminals();
    // 拼接回 `sh -c "…"` 的实现会在此实际执行 `echo pwned`，导致输出中出现 pwned。
    const id = create(subject, process.execPath, ['-e', 'process.stdout.write(process.argv[1] ?? "")', '$(echo pwned); rm -rf /']);
    await subject.waitForExit(id);
    const output = String(subject.output(id).output);
    expect(output).toContain('$(echo pwned)');
    expect(output).not.toContain('pwned\n');
    subject.releaseAll();
  });

  it('杀的是整个进程组，孙进程不会留成孤儿', async () => {
    const subject = terminals();
    const pidFile = resolve(ROOT, 'grandchild.pid');
    rmSync(pidFile, { force: true });
    // 父进程 fork 一个存活 60 秒的孙进程后自身等待。`child.kill()` 只能终止最外层那一个，
    // `process.kill(-pid)` 才能终止整个进程组；`make -j8` 遗留八个孤儿进程正是前者的表现。
    const id = create(subject, process.execPath, ['-e',
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000)`]);
    await waitUntil(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(grandchild).toBeGreaterThan(0);
    subject.release(id);
    await waitUntil(() => !alive(grandchild), 8000);
    expect(alive(grandchild)).toBe(false);
    rmSync(pidFile, { force: true });
  });

  it('泄漏收尾：agent 没 release 的那些被收拾掉，且 leaked 留下凭据', async () => {
    const subject = terminals();
    const pidFile = resolve(ROOT, 'leaked.pid');
    rmSync(pidFile, { force: true });
    create(subject, process.execPath, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000)`]);
    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // 判据是 `process.kill(pid, 0)` 抛错，而非 releaseAll 的返回值：后者是本方自行记录的数据，
    // 而本用例要证明的是宿主上确实没有残留进程。
    expect(alive(pid)).toBe(true);
    expect(subject.releaseAll()).toHaveLength(1);
    expect(subject.leaked).toHaveLength(1);
    await waitUntil(() => !alive(pid), 8000);
    expect(() => process.kill(pid, 0)).toThrow();
    rmSync(pidFile, { force: true });
  });

  it('spawn 同步抛与 ENOENT 都收成一个已退出的终端，而不是一个挂住的请求', async () => {
    const subject = terminals();
    // ENOENT 异步到达。返回 `exitCode: null` 而非构造一个 127：127 是 shell 的约定，而这条路径上没有 shell。
    const missing = create(subject, resolve(ROOT, 'definitely-not-here'));
    expect(await subject.waitForExit(missing)).toEqual({ exitCode: null, signal: null });
    expect(String(subject.output(missing).output)).toContain('spawn failed');
    // 参数本身不合法时 `spawn` 同步抛错（`command` 中包含一个 NUL 字节即可触发）。
    const nul = create(subject, `${process.execPath}\0evil`);
    expect(await subject.waitForExit(nul)).toEqual({ exitCode: null, signal: null });
    expect(String(subject.output(nul).output)).toContain('spawn failed');
    subject.releaseAll();
  });
});

describe('ACP 终端 · 上界', () => {
  it('maxTerminals 数的是活着的句柄，含已退出但没 release 的那些', async () => {
    const subject = terminals({ maxTerminals: 2 });
    const first = create(subject, process.execPath, ['-e', 'process.exit(0)']);
    const second = create(subject, process.execPath, ['-e', 'process.exit(0)']);
    await subject.waitForExit(first);
    await subject.waitForExit(second);
    // 两个都已执行完毕但都未 release，上界仍然拦住第三个，这正是促使 agent 归还已用完句柄的机制。
    expect(() => create(subject, process.execPath, ['-e', 'process.exit(0)'])).toThrow(/maxTerminals|release/);
    subject.release(first);
    // 归还一个即可再创建一个：统计的是存活句柄数，而非历史总数。
    const third = create(subject, process.execPath, ['-e', 'process.exit(0)']);
    await subject.waitForExit(third);
    subject.releaseAll();
  });

  it('输出超上界时**保留的是尾部**，且切口落在字符边界上', async () => {
    // 协议明确规定：超限时 client 从输出开头截断。这与本仓 `elideMiddleBytes` 保留首尾的做法
    // 有意分开：后者的消费者是本系统的模型（开头有命令回显、结尾有报错），
    // 而这一份的消费者是 agent，它已知自己发送的命令，需要的是最后发生了什么。
    const subject = terminals({ maxOutputBytes: 1024 });
    const id = create(subject, process.execPath, ['-e',
      'for (let i = 0; i < 2000; i += 1) process.stdout.write(`行${i}\\n`); process.stdout.write("TAIL-MARKER\\n")']);
    await subject.waitForExit(id);
    const snapshot = subject.output(id);
    expect(snapshot.truncated).toBe(true);
    expect(String(snapshot.output)).toContain('TAIL-MARKER');
    expect(String(snapshot.output)).not.toContain('行0\n');
    expect(Buffer.byteLength(String(snapshot.output))).toBeLessThanOrEqual(1024);
    // 截断位置落在字符边界上：解码结果中不得出现替换字符（按码元截断的实现会在此产生 U+FFFD）。
    expect(String(snapshot.output)).not.toContain('�');
    subject.releaseAll();
  });

  it('outputByteLimit 由 agent 给，但收在我们的上界之内', async () => {
    const subject = terminals({ maxOutputBytes: 2048 });
    // agent 请求一个大于本方上界的数值：按其请求处理会使上界失效。
    const greedy = create(subject, process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { outputByteLimit: 1_000_000 });
    await subject.waitForExit(greedy);
    expect(Buffer.byteLength(String(subject.output(greedy).output))).toBeLessThanOrEqual(2048);
    subject.releaseAll();
  });

  it('硬期限到点杀进程组，并在输出里说清是谁掐的', async () => {
    const subject = terminals({ maxTimeoutMs: 300 });
    const id = create(subject, process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const exit = await subject.waitForExit(id);
    // 到时终止而非到时停止等待：后者会留下一条仍在宿主上运行的命令，而没有任何一方在等待它的输出。
    expect(exit.signal ?? exit.exitCode).toBeTruthy();
    expect(String(subject.output(id).output)).toContain('maxTimeoutMs');
    subject.releaseAll();
  });

  /**
   * ⚠️ cwd 判据不是命令可访问范围的边界，它只是阻止 agent 把工作目录设到别处。
   * 终端在宿主上直接运行，一条命令可读取的内容即该进程所属用户可读取的内容，与 `spawn_harness`
   * 完全同形（那条路径上它 fork 的 shell 同样在宿主上运行），这正是 §3.5.2 中宿主直跑不是退步
   * 那句话的另一半。因此本用例验证的是 cwd 参数本身经过判定，不要将其理解为沙箱。
   */
  it('cwd 越界与 denyGlobs 命中都在 create 之前就被拒，一个进程都不起', () => {
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: resolve('data') })).toThrow(/cwd/);
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: '/etc' })).toThrow(/cwd/);
    // 命令的 cwd 与待读写的文件在路径可达性上没有理由使用两套判据，因此 `jail.resolve`
    // 同时处理 denyGlobs。
    const secret = resolve(ROOT, 'secret');
    mkdirSync(resolve(secret, 'deep'), { recursive: true });
    const glob = secret.replaceAll('\\', '/');
    // 一条 `X/**` 即可：minimatch 下它本身不匹配 `X`，而 `PathJail` 会为每条该形态的 glob 派生一条
    // 去掉后缀的模式（`tools.fs.denyGlobs` 的默认值几乎全是该形态，运维直接复用一条 `.../**` 时
    // 把 cwd 设为该目录同样要拦截）。两条同时书写自然也会拒绝。
    expect(() => create(terminals({}, [glob, `${glob}/**`]), process.execPath, ['-e', ''], { cwd: secret })).toThrow(/cwd/);
    expect(() => create(terminals({}, [`${glob}/**`]), process.execPath, ['-e', ''], { cwd: secret })).toThrow(/cwd/);
    // 该目录下的路径仍然拒绝：收紧的是 X 自身这一档，而非替换原有语义。
    expect(() => create(terminals({}, [`${glob}/**`]), process.execPath, ['-e', ''], { cwd: resolve(secret, 'deep') })).toThrow(/cwd/);
    // 不存在的目录同样返回明确的错误，而不是一次 spawn 失败。
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: resolve(ROOT, 'nope') })).toThrow(/cwd/);
    rmSync(secret, { recursive: true, force: true });
  });

  it('wait_for_exit 认 abortSignal —— 不 settle 的话 agent 就挂在那儿', async () => {
    const subject = terminals();
    const id = create(subject, process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const controller = new AbortController();
    const pending = subject.waitForExit(id, controller.signal);
    controller.abort();
    // 取消时返回当前状态（进程仍在运行，`kill` 是另一个操作），因此两项都为 null。
    expect(await pending).toEqual({ exitCode: null, signal: null });
    // 已经 abort 的 signal 也必须立即 settle，而不是等待一个永不到达的事件。
    expect(await subject.waitForExit(id, controller.signal)).toEqual({ exitCode: null, signal: null });
    subject.releaseAll();
  });
});

describe('ACP 终端 · 申报是 fail-closed 的', () => {
  /** 从 method log 中取出 `initialize` 收到的那份能力。申报值由客户端计算，外部只有此处可观察。 */
  const advertised = (): Record<string, unknown> | null => {
    const line = methods().find((entry) => entry.startsWith('caps:'));
    return line ? (JSON.parse(line.slice('caps:'.length)) as Record<string, unknown> | null) : null;
  };
  const run = (manager: AcpManager, hostAccess: unknown) =>
    manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings(), { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: hostAccess as never });

  it('plan 是 host 时 fs 与 terminal 都申报，而 bash 因此真的执行得了', async () => {
    process.env.ACP_CAPS = '1';
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = ['-e', 'process.stdout.write("BASH-RAN\\n")'].join(',');
    const manager = new AcpManager(log);
    const result = await run(manager, host('host'));
    expect(result.ok).toBe(true);
    expect(advertised()).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    // 这一条是 `bash` 当前是否可执行的离线对照：命令确实执行、输出确实返回给了 agent。
    expect(methods().some((line) => line.startsWith('terminal_created:'))).toBe(true);
    expect(methods().some((line) => line.startsWith('terminal_output:') && line.includes('BASH-RAN'))).toBe(true);
    expect(result.terminals).toBe(1);
    await manager.close();
  });

  it('plan 不是 host 时整个 terminal capability 不申报 —— 不是申报了每次 create 都失败', async () => {
    process.env.ACP_CAPS = '1';
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    const manager = new AcpManager(log);
    const result = await run(manager, host('docker'));
    // fs 仍然申报（jail 可以构造），terminal 那一位不申报。申报后让 agent 每次 create 都遇到错误
    // 是最糟的形态：它会反复尝试，而每次失败都会产生一段自行推断的解释。
    expect(advertised()).toEqual({ fs: { readTextFile: true, writeTextFile: true } });
    // 未申报的 method 仍返回 `methodNotFound`（-32601）：不遵守约定的 agent 应得到明确的错误。
    expect(methods().some((line) => line === 'terminal_error:-32601')).toBe(true);
    expect(result.terminals).toBeUndefined();
    // 降级本身必须有可见记录：`acp.run` 提升为 warn，原因写入 `data.degraded`。
    const line = events.find((event) => event.kind === 'acp.run');
    expect(line?.level).toBe('warn');
    expect(JSON.stringify(line?.data?.degraded)).toContain('terminal 未申报');
    await manager.close();
  });

  it('没有 host bridge 时两位都不申报，回到「agent 自己碰磁盘」那条老路', async () => {
    process.env.ACP_CAPS = '1';
    const manager = new AcpManager(log);
    expect(await manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings(),
      { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500 })).toMatchObject({ ok: true });
    expect(advertised()).toEqual({});
    await manager.close();
  });

  /**
   * ⚠️ 申报 `terminal` 是 `bash` 可执行的必要条件而非充分条件，这是实测修正的一条判断。
   * omp 17.4.0 在 `approvalMode` 非 `yolo` 时会就 `bash` 发起询问，本方从它给出的选项中选择
   * `allow_always` 回复，它仍会记录为 `Tool call denied by user: bash`，而 `terminal/create`
   * 一次都不发生。阻止它的是 agent 内部的审批。本用例保证该组合的限制有明确说明：
   * 默认值未替运维改为 `yolo`（那是一次安全取舍），因此默认组合下这一行必须存在。
   */
  it('terminal 申报了但 approvalMode 非 yolo 时，那一行 warn 点名这个组合', async () => {
    process.env.ACP_CAPS = '1';
    const manager = new AcpManager(log);
    await manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings({}, { tools: ['read', 'write', 'edit', 'bash'], approvalMode: 'write' }),
      { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: host('host') as never });
    const line = events.find((event) => event.kind === 'acp.run');
    expect(line?.level).toBe('warn');
    expect(JSON.stringify(line?.data?.degraded)).toContain('approvalMode=write');
    events.length = 0;
    // `yolo` 档位不应产生该 warn：它是该组合确实可用的唯一档位。
    await manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings({}, { tools: ['read', 'write', 'edit', 'bash'], approvalMode: 'yolo' }),
      { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: host('host') as never });
    expect(events.find((event) => event.kind === 'acp.run')?.data?.degraded).toEqual([]);
    await manager.close();
  });

  it('配置里留着 bash 而 terminal 没申报时，那一行 warn 点名它', async () => {
    process.env.ACP_CAPS = '1';
    const manager = new AcpManager(log);
    await manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings({}, { tools: ['read', 'write', 'edit', 'bash'] }),
      { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: host('none' as never) as never });
    // 一个可证明不可用的工具留在配置中时，模型会尝试、失败，然后绕行或自行推断原因，因此必须明确说明。
    expect(JSON.stringify(events.find((event) => event.kind === 'acp.run')?.data?.degraded)).toContain('bash');
    await manager.close();
  });

  it('命令跑到我们收摊时还在跑 = 漏 release，那一行被抬成 warn', async () => {
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    process.env.ACP_TERMINAL_NO_RELEASE = '1';
    // 不等待它退出：等待时硬期限（`maxTimeoutMs`）会先终止该命令，于是该档位再也无法验证
    // 有命令存活到系统收尾时刻这一情形，而那正是三道 release 兜底要拦截的唯一形态。
    process.env.ACP_TERMINAL_NO_WAIT = '1';
    const manager = new AcpManager(log);
    const result = await run(manager, host('host'));
    expect(result.ok).toBe(true);
    const line = events.find((event) => event.kind === 'acp.run');
    // 遗漏 release 属于 agent 的缺陷。本方代为清理，但这意味着有命令在宿主上运行到了系统收尾时刻，
    // 不记录一行的话该事实无处可查。
    expect(line?.level).toBe('warn');
    expect(line?.data?.terminalsLeaked).toBe(1);
    await manager.close();
  });

  it('agent 自己 kill 过再忘了 release 的**不算**漏 —— 那不是「命令还在跑」', async () => {
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    process.env.ACP_TERMINAL_NO_RELEASE = '1';
    process.env.ACP_TERMINAL_KILL = '1';
    const manager = new AcpManager(log);
    expect(await run(manager, host('host'))).toMatchObject({ ok: true });
    // 判据是宿主上是否仍有进程，而非句柄是否已归还。若把已 kill 但未 release 也提升为 warn，
    // agent 每次提前终止一条命令都会产生一条告警，而告警过多会导致无人查看，这正是本档位要避免的。
    const line = events.find((event) => event.kind === 'acp.run');
    expect(line?.level).toBe('info');
    expect(line?.data?.terminalsLeaked).toBe(0);
    await manager.close();
  });
});

describe('ACP 终端 · 关停', () => {
  it('close() 收拾在途会话的终端，而且排在收 agent 之前', async () => {
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    process.env.ACP_TERMINAL_NO_RELEASE = '1';
    process.env.ACP_NEVER_STOP = '1';
    const manager = new AcpManager(log);
    const pending = manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings(),
      { abortSignal: new AbortController().signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: host('host') as never });
    await waitUntil(() => methods().some((line) => line.startsWith('terminal_created:')), 8000);
    await manager.close();
    // 第三道兜底。若 `close()` 只关闭子进程，agent 要求启动的那些命令仍在宿主上运行；
    // 它们是 detached 的，无人回收即成为真正的孤儿进程。
    expect(events.some((event) => event.kind === 'acp.run' && event.level === 'warn' && event.data?.at === 'shutdown')).toBe(true);
    await pending;
  });

  it('abortSignal 是第一道兜底：一次被取消的调用不留下接着跑的命令', async () => {
    writeFileSync(resolve(ROOT, 'probe.txt'), 'hello\n');
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    process.env.ACP_TERMINAL_NO_RELEASE = '1';
    process.env.ACP_NEVER_STOP = '1';
    const manager = new AcpManager(log);
    const controller = new AbortController();
    const pending = manager.run({ task: 'x'.repeat(20), dir: ROOT }, settings(),
      { abortSignal: controller.signal, outputBudgetBytes: 65_536, dirWaitMs: 500, host: host('host') as never });
    await waitUntil(() => methods().some((line) => line.startsWith('terminal_created:')), 8000);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'acp_cancelled' });
    await manager.close();
  });
});
