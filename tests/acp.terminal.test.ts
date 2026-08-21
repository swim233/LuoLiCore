import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcpManager, AcpTerminals, PathJail, configSchema, type AcpSettings } from '@luoli/core';

/**
 * M13 · 反向终端（`terminal/*`，`docs/05 §3.5.2`）。
 *
 * 两层分工：`AcpTerminals` 的生命周期、上界与回收**直接测**（真起进程、真杀进程组、真数句柄）；
 * 「不是 host 就不申报 terminal」那一条只有走完整握手才量得到 —— 申报值是客户端算出来的，从外面
 * 唯一看得见的地方是 agent 在 `initialize` 里收到的那份，所以那一条走 fixture + `ACP_CAPS`。
 *
 * **不碰真 `omp`**（用例必须离线且确定性）。
 */
const FIXTURE = resolve('tests/fixtures/acp-agent.mjs');
const ROOT = resolve('data/acp-term-work');
/**
 * 「一条跑很久的命令」写成脚本文件而不是 `-e`。**理由是 fixture 的 argv 用逗号分隔**，而任何
 * `setTimeout(fn, ms)` 都自带一个逗号 —— 写成 `-e` 的那一版被切成两段、node 当场语法错误退出，
 * 于是「命令还在宿主上跑」这几条用例全都在测一个**已经死了**的进程（写这几条时真的这么假过一次）。
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
/** `process.kill(pid, 0)` 不发信号，只问「这个 pid 还在吗」—— 泄漏检测唯一可靠的判据。 */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

const LIMITS = { maxTerminals: 3, maxTimeoutMs: 5000, maxOutputBytes: 65_536 };
/** 照 `AcpManager.#surface` 的建法逐字抄：root 与 base 都是 realpath，边界与 cwd 因此是同一个字面量。 */
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
/** `plan` 的答案由用例给：这一节要量的正是「答案不是 host 时会怎样」。 */
const host = (mode: 'host' | 'jail' | 'docker' = 'host') => ({
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
    // `kill` 不摘句柄 —— 协议明说 kill 之后 output 仍然要读得到，那正是它与 release 的分工。
    subject.kill(id);
    expect(subject.output(id)).toMatchObject({ output: 'hi\n' });
    subject.release(id);
    // release 过的、以及压根没建过的，一律是一个**干净的错**而不是一个挂住的请求。
    expect(() => subject.output(id)).toThrow(/terminalId/);
    expect(() => subject.output('term_nope')).toThrow(/terminalId/);
    expect(subject.releaseAll()).toEqual([]);
  });

  it('argv 直传不过 shell —— 一个带 shell 元字符的参数只是普通字符', async () => {
    const subject = terminals();
    // 拼回 `sh -c "…"` 的实现会在这里真的去执行 `echo pwned`，于是输出里出现 pwned。
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
    // 父进程 fork 一个活 60 秒的孙进程再自己等着。`child.kill()` 只打得到最外层那一个，
    // `process.kill(-pid)` 才打得到整组 —— `make -j8` 留下八个孤儿正是前者的表现。
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
    // **判据是 `process.kill(pid, 0)` 抛**，不是「releaseAll 返回了什么」：后者是我们自己记的账，
    // 而这条用例要证明的是宿主上真的没有进程留下来。
    expect(alive(pid)).toBe(true);
    expect(subject.releaseAll()).toHaveLength(1);
    expect(subject.leaked).toHaveLength(1);
    await waitUntil(() => !alive(pid), 8000);
    expect(() => process.kill(pid, 0)).toThrow();
    rmSync(pidFile, { force: true });
  });

  it('spawn 同步抛与 ENOENT 都收成一个已退出的终端，而不是一个挂住的请求', async () => {
    const subject = terminals();
    // ENOENT 是异步来的。`exitCode: null` 而不是编一个 127 —— 127 是 shell 的约定，这条路上没有 shell。
    const missing = create(subject, resolve(ROOT, 'definitely-not-here'));
    expect(await subject.waitForExit(missing)).toEqual({ exitCode: null, signal: null });
    expect(String(subject.output(missing).output)).toContain('spawn failed');
    // 参数本身不合法时 `spawn` 同步抛（`command` 里一个 NUL 字节就够）。
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
    // 两个都跑完了，但都没 release —— 上界照旧拦住第三个。那正是逼 agent 把用完的还回来的压力。
    expect(() => create(subject, process.execPath, ['-e', 'process.exit(0)'])).toThrow(/maxTerminals|release/);
    subject.release(first);
    // 还回来一个就能再开一个：数的是活着的句柄，不是历史总数。
    const third = create(subject, process.execPath, ['-e', 'process.exit(0)']);
    await subject.waitForExit(third);
    subject.releaseAll();
  });

  it('输出超上界时**保留的是尾部**，且切口落在字符边界上', async () => {
    // 协议明文：超限时 client「truncates from the beginning of the output」。这与本仓
    // `elideMiddleBytes` 的留头留尾**刻意分岔** —— 那个的消费者是我们自己的模型（头部有命令回显、
    // 尾部有报错），这一份的消费者是 agent，它自己知道发了什么命令，要的是「最后发生了什么」。
    const subject = terminals({ maxOutputBytes: 1024 });
    const id = create(subject, process.execPath, ['-e',
      'for (let i = 0; i < 2000; i += 1) process.stdout.write(`行${i}\\n`); process.stdout.write("TAIL-MARKER\\n")']);
    await subject.waitForExit(id);
    const snapshot = subject.output(id);
    expect(snapshot.truncated).toBe(true);
    expect(String(snapshot.output)).toContain('TAIL-MARKER');
    expect(String(snapshot.output)).not.toContain('行0\n');
    expect(Buffer.byteLength(String(snapshot.output))).toBeLessThanOrEqual(1024);
    // 切口落在字符边界上：解码结果里不许出现替换字符（按码元裁的实现会在这里露出 U+FFFD）。
    expect(String(snapshot.output)).not.toContain('�');
    subject.releaseAll();
  });

  it('outputByteLimit 由 agent 给，但收在我们的上界之内', async () => {
    const subject = terminals({ maxOutputBytes: 2048 });
    // agent 要一个比我们的上界还大的数：按它的算等于上界白设了。
    const greedy = create(subject, process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { outputByteLimit: 1_000_000 });
    await subject.waitForExit(greedy);
    expect(Buffer.byteLength(String(subject.output(greedy).output))).toBeLessThanOrEqual(2048);
    subject.releaseAll();
  });

  it('硬期限到点杀进程组，并在输出里说清是谁掐的', async () => {
    const subject = terminals({ maxTimeoutMs: 300 });
    const id = create(subject, process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const exit = await subject.waitForExit(id);
    // 「到点杀掉」而不是「到点不再等」：后者留下一条在宿主上接着跑的命令，而没人还在等它的输出。
    expect(exit.signal ?? exit.exitCode).toBeTruthy();
    expect(String(subject.output(id).output)).toContain('maxTimeoutMs');
    subject.releaseAll();
  });

  /**
   * ⚠️ **cwd 那道判据不是「这条命令碰得到什么」的边界，它只是不让 agent 把工作目录设到别处。**
   * 终端是宿主直跑，一条命令能读的东西就是这个进程的用户能读的东西 —— 与 `spawn_harness`
   * 完全同形（那条路上它 fork 的 shell 也一样在宿主上跑），而这正是 §3.5.2 里「宿主直跑不是退步」
   * 那句话的另一半。所以这条用例量的是「cwd 参数本身被判过」，**不要**把它读成沙箱。
   */
  it('cwd 越界与 denyGlobs 命中都在 create 之前就被拒，一个进程都不起', () => {
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: resolve('data') })).toThrow(/cwd/);
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: '/etc' })).toThrow(/cwd/);
    // 命令的 cwd 与要读写的文件在「这条路径碰不碰得到」上没有理由分两套判据，所以 `jail.resolve`
    // 同时管 denyGlobs。
    const secret = resolve(ROOT, 'secret');
    mkdirSync(secret, { recursive: true });
    const glob = secret.replaceAll('\\', '/');
    // ⚠️ **两条 glob 都要写。** minimatch 的 `a/**` 匹配 `a` 底下的东西而**不匹配 `a` 自己**，
    // 于是 `tools.fs.denyGlobs` 里那些 `<root>/config/**` 只挡得住「读那底下的文件」，挡不住
    // 「把 cwd 设成那个目录」。运维照抄一条 `.../**` 会以为两件事都挡了。
    expect(() => create(terminals({}, [glob, `${glob}/**`]), process.execPath, ['-e', ''], { cwd: secret })).toThrow(/cwd/);
    expect(create(terminals({}, [`${glob}/**`]), process.execPath, ['-e', ''], { cwd: secret })).toMatch(/^term_/);
    // 不存在的目录同样是一个干净的错，而不是一次 spawn 失败。
    expect(() => create(terminals(), process.execPath, ['-e', ''], { cwd: resolve(ROOT, 'nope') })).toThrow(/cwd/);
    rmSync(secret, { recursive: true, force: true });
  });

  it('wait_for_exit 认 abortSignal —— 不 settle 的话 agent 就挂在那儿', async () => {
    const subject = terminals();
    const id = create(subject, process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const controller = new AbortController();
    const pending = subject.waitForExit(id, controller.signal);
    controller.abort();
    // 取消时交回**当下**的状态（进程照旧在跑，`kill` 是另一个动词），所以两项都是 null。
    expect(await pending).toEqual({ exitCode: null, signal: null });
    // 已经 abort 过的 signal 也必须立刻 settle，而不是等一个永远不来的事件。
    expect(await subject.waitForExit(id, controller.signal)).toEqual({ exitCode: null, signal: null });
    subject.releaseAll();
  });
});

describe('ACP 终端 · 申报是 fail-closed 的', () => {
  /** 从 method log 里把 `initialize` 收到的那份能力捞出来。申报值是客户端算的，外面只有这里看得见。 */
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
    // 这一条是「`bash` 现在到底能不能执行」的离线对偶：命令真的跑了、输出真的回到了 agent 手里。
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
    // fs 照旧申报（jail 建得起来），terminal 那一位**不在**。申报了让 agent 每次 create 都撞一个错
    // 是最坏的形态：它会反复试，而每次失败都换来一段它自己编的解释。
    expect(advertised()).toEqual({ fs: { readTextFile: true, writeTextFile: true } });
    // 没申报的 method 照旧回 `methodNotFound`（-32601）：不守规矩的 agent 该拿到一个干净的错。
    expect(methods().some((line) => line === 'terminal_error:-32601')).toBe(true);
    expect(result.terminals).toBeUndefined();
    // 降级本身必须有一行看得见：`acp.run` 被抬成 warn，理由进 `data.degraded`。
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
   * ⚠️ **申报 `terminal` 是 `bash` 能跑的必要条件，不是充分条件** —— 这是实测纠正的一条判断。
   * omp 17.4.0 在 `approvalMode` 非 `yolo` 时会把 `bash` 问过来、我们从它自己给的选项里挑一个
   * `allow_always` 回过去、它照旧自己记成 `Tool call denied by user: bash`，而 `terminal/create`
   * 一次都不发生。卡住它的是 agent 内部那道审批。这条用例守的是「那个组合有人说得出口」——
   * 默认值没有替运维改成 `yolo`（那是一次安全取舍），所以默认组合下这一行必须在。
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
    // `yolo` 那一档不该有这条 warn —— 它是那个组合真的能用的唯一档位。
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
    // 一个可证明用不了的工具留在配置里，模型会试、失败、然后绕路或编一个理由 —— 所以要说出来。
    expect(JSON.stringify(events.find((event) => event.kind === 'acp.run')?.data?.degraded)).toContain('bash');
    await manager.close();
  });

  it('命令跑到我们收摊时还在跑 = 漏 release，那一行被抬成 warn', async () => {
    process.env.ACP_TERMINAL = process.execPath;
    process.env.ACP_TERMINAL_ARGS = SLEEPER;
    process.env.ACP_TERMINAL_NO_RELEASE = '1';
    // **不等它退出**：等的话硬期限（`maxTimeoutMs`）会先把那条命令收掉，于是这一档就再也量不到
    // 「有命令活到了我们收摊的时候」—— 而那正是三道 release 兜底要挡的唯一形态。
    process.env.ACP_TERMINAL_NO_WAIT = '1';
    const manager = new AcpManager(log);
    const result = await run(manager, host('host'));
    expect(result.ok).toBe(true);
    const line = events.find((event) => event.kind === 'acp.run');
    // 漏 release 是 agent 的 bug。我们替它收拾了，但那意味着有命令在宿主上跑到了我们收摊的时候 ——
    // 不落一行的话这件事在任何地方都说不出口。
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
    // 判据是**宿主上还有没有进程**，不是「句柄还回来了吗」。把「kill 过但没 release」也抬成 warn 的话，
    // 每一次 agent 提前掐掉一条命令都会换来一条告警，而告警一多就没人看了 —— 那正是这一档要避免的。
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
    // 第三道兜底。`close()` 只关子进程的话，agent 让我们起的那些命令还在宿主上跑着 ——
    // 它们是 detached 的，没人收就是真孤儿。
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
