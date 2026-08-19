import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Role } from '@luoli/shared';
import { elideMiddleBytes } from '@luoli/shared';

/** 本进程是否跑在容器里。docker 和 podman 各自留的标记文件。 */
function detectContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * `ulimit -u` 对应 RLIMIT_NPROC，内核按 **UID 全局的任务数**计数 —— 而且数的是**线程**不是进程，
 * 也不是当前进程树。直接设成 `pidsLimit` 的后果是宿主上该用户的线程数早就远超它（一个桌面会话
 * 轻松四千多），于是子 shell 连一次 fork 都做不成：bash 打五行
 * `fork: retry: Resource temporarily unavailable`，重试约 15 秒后以 254 退出。
 * 所以按「当前占用 + pidsLimit」设：fork 炸弹最多再撑 pidsLimit 个任务，正常命令照跑。
 * 计数与 spawn 之间必然有窗口，但 jail 本就不是安全边界（§5.4），松一点好过必然失败。
 * 读不到 /proc（非 Linux）时返回 null —— 宁可不设这一条，也不要设成一个注定 fork 失败的值。
 */
function nprocCeiling(pidsLimit: number): number | null {
  try {
    const uid = userInfo().uid;
    let tasks = 0;
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (statSync(`/proc/${entry}`).uid !== uid) continue;
        tasks += readdirSync(`/proc/${entry}/task`).length;
      } catch { /* 进程在遍历途中退出 */ }
    }
    return tasks + pidsLimit;
  } catch { return null; }
}

export interface SandboxConfig {
  mode: 'none' | 'jail' | 'docker';
  bypassRoles: Role[];
  dockerBin: string;
  /** 本进程视角的 workspace 根，用来把 run() 收到的绝对路径换算成相对路径。 */
  workspaceDir: string;
  /** 宿主视角的同一个目录；本进程也在宿主上跑时留空。见 #hostPath。 */
  hostWorkspaceDir: string;
  image: string;
  network: 'none' | 'bridge';
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  readOnlyRoot: boolean;
  tmpfsMb: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** 「输出超限 / 超时 / 被取消」三条路共用同一个 `kill()`，所以这一位**分不出**是哪一种：
   *  输出超限看 `truncated`，超时看 `durationMs` 是否贴着 `timeoutMs`。 */
  killed: boolean;
  oom: boolean;
  /** 只在输出撞上 `2 × maxOutputBytes`、子进程被就地 SIGKILL 时出现：`bash` / `python` 把整个
   *  结果原样交回模型（registry 的 `{ok,error,hint}` 那一套），而这一次是**我们**杀的 ——
   *  不说清楚它会原样重试，再被杀一次（docs/28 · L-TOOL-01）。 */
  hint?: string;
}

/**
 * 一次沙箱执行的事实（`docs/10 §2` 的 `sandbox.run`）。`turnId` 让它进得了那一轮的 trace ——
 * 沙箱执行此前在日志里**完全不存在**，一次 OOM 或被 SIGKILL 的命令只能从 `tool.call` 的输出里猜。
 */
export interface SandboxRunEvent {
  turnId: string;
  role: Role;
  mode: 'host' | 'jail' | 'docker';
  image: string | null;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  killed: boolean;
  oom: boolean;
  truncated: boolean;
  /** 被拒（沙箱未启用 / docker 不可用 / 路径映射不成立）时的原因，正常执行是 undefined。 */
  denied?: string;
}

/** 按字节算预算、按字符边界切，且结果真的不超过 `max`（docs/27 · T-04：此前那个按比例估的
 *  码点数会算出一个超预算的结果）。与工具输出归一化共用同一份实现。 */
function clipped(buffer: string, max: number): { value: string; truncated: boolean } {
  return elideMiddleBytes(buffer, max, (omitted) => `\n…省略 ${omitted} bytes…\n`);
}

export class Sandbox {
  #dockerAvailable: boolean | null = null;
  readonly #inContainer: boolean;
  readonly #cfg: () => SandboxConfig;
  readonly #warn: ((message: string) => void) | undefined;
  #warnedMode: string | null = null;
  #seq = 0;

  /**
   * config 传 getter 时每次读都取最新值。吃启动快照的后果是：事故中在 WebUI 把 `docker` 改成 `none`
   * 想切断执行类工具，接口返回 200、`GET /api/sandbox` 也显示已改，而 bash/python 照跑不误
   * （docs/20 · W-CFG-02）。
   */
  constructor(config: SandboxConfig | (() => SandboxConfig), dockerAvailable?: boolean, inContainer?: boolean, onWarn?: (message: string) => void,
    private readonly onUnavailable?: (reason: string, role: Role) => void,
    /**
     * 每一次执行落一条 `sandbox.run`（`docs/10 §2`）。装配方把它接到 `LogSink` 上 —— 这里只发事实，
     * 不认识 LogSink：沙箱是 `bash` / `python` / 自撰写工具三条路共用的底层，让它持有日志接口
     * 等于给它一个它用不上的依赖方向。可选：测试直接构造时不给，行为一个字不变。
     */
    private readonly onRun?: (event: SandboxRunEvent) => void) {
    this.#cfg = typeof config === 'function' ? config : () => config;
    this.#dockerAvailable = dockerAvailable ?? null;
    this.#inContainer = inContainer ?? detectContainer();
    this.#warn = onWarn;
  }

  setDockerAvailable(available: boolean): void {
    this.#dockerAvailable = available;
  }

  /** 发事件不许打断执行：这一层的调用点在返回结果的正路上，而 `LogSink.event` 之外的回调不保证不抛。 */
  #emit(event: SandboxRunEvent): void {
    try { this.onRun?.(event); } catch { /* 观测不该把一次成功的执行变成失败 */ }
  }

  /**
   * `docker run -v` 里的路径由**宿主** daemon 解析，而 run() 拿到的是本进程视角的路径。
   * 本进程也在宿主上时两者相同；本进程在容器里时不同，且 docker 对不存在的宿主路径不会报错——
   * 它会默默建一个空目录，于是 bash 写的文件 read_file 读不到。所以这里要么映射，要么拒绝。
   */
  #hostPath(workspace: string): string | null {
    if (!this.#cfg().hostWorkspaceDir) return workspace;
    const rel = relative(resolve(this.#cfg().workspaceDir), workspace);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return join(this.#cfg().hostWorkspaceDir, rel);
  }

  /** docker 模式下路径映射本身不成立的情况；plan() 与 probe() 共用同一句话。 */
  #mappingError(): string | null {
    if (this.#cfg().mode !== 'docker' || !this.#inContainer || this.#cfg().hostWorkspaceDir) return null;
    return '本进程在容器内且未配置 sandbox.hostWorkspaceDir：-v 会挂到宿主上不存在的路径，沙箱与文件工具将看到两个不同的目录';
  }

  /**
   * `docker pull <sandbox.image>`。镜像名取自配置而不是请求体：让人从界面上指定任意镜像
   * 等于绕开 `sandbox.image` 那道配置，而沙箱镜像决定了模型能在里面用什么。
   * **只 pull 不 build** —— build 要有 Dockerfile 上下文、会跑任意构建指令、耗时以分钟计，
   * 那是部署动作不是控制台按钮（docs/09 §3.7）。
   */
  async pullImage(): Promise<{ ok: boolean; image: string; error?: string }> {
    const image = this.#cfg().image;
    return new Promise((resolve) => {
      const child = spawn(this.#cfg().dockerBin, ['pull', image], { stdio: ['ignore', 'ignore', 'pipe'] });
      let settled = false;
      let error = '';
      const finish = (value: { ok: boolean; image: string; error?: string }): void => { if (!settled) { settled = true; resolve(value); } };
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      // 拉一个几百 MB 的镜像可能要几分钟，但不能没有上界：这是一个同步等待的 HTTP 请求。
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, image, error: 'pull_timeout' }); }, 600_000);
      timer.unref?.();
      child.once('error', (cause) => { clearTimeout(timer); finish({ ok: false, image, error: cause.message }); });
      child.once('close', (code) => { clearTimeout(timer); finish(code === 0 ? { ok: true, image } : { ok: false, image, error: error.trim().slice(0, 500) || `exit_${code}` }); });
    });
  }

  async probe(): Promise<{ available: boolean; mode: SandboxConfig['mode']; error?: string }> {
    if (this.#cfg().mode !== 'docker') return { available: this.#cfg().mode === 'jail', mode: this.#cfg().mode };
    const mapping = this.#mappingError();
    if (mapping) return { available: false, mode: 'docker', error: mapping };
    const result = await new Promise<{ available: boolean; error?: string }>((resolve) => {
      const child = spawn(this.#cfg().dockerBin, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let settled = false;
      const finish = (value: { available: boolean; error?: string }): void => { if (!settled) { settled = true; resolve(value); } };
      let error = '';
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, error: 'probe_timeout' }); }, 5000);
      child.once('error', (cause) => { clearTimeout(timer); finish({ available: false, error: cause.message }); });
      child.once('close', (code) => { clearTimeout(timer); finish(code === 0 ? { available: true } : { available: false, error: error.trim() || `exit_${code}` }); });
    });
    this.#dockerAvailable = result.available;
    return result.error ? { available: result.available, mode: this.#cfg().mode, error: result.error } : { available: result.available, mode: this.#cfg().mode };
  }

  plan(role: Role, _workspace = '.'): { allowed: boolean; mode: 'host' | 'jail' | 'docker'; reason?: string } {
    const mode = this.#cfg().mode;
    if (this.#cfg().bypassRoles.includes(role)) return { allowed: true, mode: 'host' };
    if (mode === 'none') return { allowed: false, mode: 'jail', reason: '沙箱未启用，执行类工具已禁用' };
    if (mode === 'docker' && this.#dockerAvailable === false) return { allowed: false, mode: 'docker', reason: 'Docker 沙箱不可用，执行类工具已禁用' };
    const mapping = this.#mappingError();
    if (mapping) return { allowed: false, mode: 'docker', reason: `${mapping}，执行类工具已禁用` };
    // jail 只是 ulimit + 目录隔离，不是安全边界（docs/05 §5.2）。模式变了才再说一次，避免刷屏。
    if (mode === 'jail' && this.#warnedMode !== 'jail') this.#warn?.('sandbox.mode=jail：只有 ulimit + 工作目录隔离，同机逃逸手段一概挡不住，不要当成安全边界');
    this.#warnedMode = mode;
    return { allowed: true, mode };
  }

  /**
   * jail 的 ulimit 前缀。**只有 `plan.mode === 'jail'` 能套上**：bypassRoles 命中时 plan 给的是
   * `'host'`，意思就是「这个角色不受沙箱约束」（§5.2）。曾经 run() 只分 docker / 非 docker 两支，
   * 于是 owner 的每条命令都吃了这段 ulimit —— 表现是私聊里 bash 一律
   * `fork: 资源暂时不可用`，看起来像「沙箱坏了」，实际上 owner 压根不该进沙箱。
   */
  #jailed(command: string, timeoutMs: number): string {
    const limits = [`-v ${Math.ceil(this.#cfg().memoryMb * 1024)}`, `-t ${Math.ceil(timeoutMs / 1000)}`, `-f ${Math.ceil(this.#cfg().maxOutputBytes / 512)}`];
    const nproc = nprocCeiling(this.#cfg().pidsLimit);
    if (nproc !== null) limits.push(`-u ${nproc}`);
    return `ulimit ${limits.join(' ')}; exec /bin/sh -c ${JSON.stringify(command)}`;
  }

  /**
   * @param extraEnv 追加给子进程的环境变量。**两条路都不经过 shell 解析** —— docker 走
   *   `-e k=v` 的 argv，宿主/jail 走 `spawn` 的 options —— 所以这是把模型给的值交进脚本时
   *   唯一不需要做引号决策的通道。键名白名单在调用方（`CustomToolManager`）那一层，这里只负责
   *   「叠加在既有三键白名单之上」：`BOT_TOKEN` / `LUOLI_MASTER_KEY` 仍然进不来。
   */
  async run(command: string, role: Role, workspace: string, abortSignal: AbortSignal, timeoutMs = this.#cfg().defaultTimeoutMs, turnId = 'adhoc', extraEnv?: Readonly<Record<string, string>>): Promise<SandboxResult> {
    if (abortSignal.aborted) return { ok: false, exitCode: null, stdout: '', stderr: 'cancelled', truncated: false, durationMs: 0, killed: true, oom: false };
    const plan = this.plan(role, workspace);
    /** 被拒也要落一行：模型侧只看到一句工具失败，而「为什么」是配置层的事。 */
    const denied = (reason: string): SandboxResult => {
      this.#emit({ turnId, role, mode: plan.mode, image: null, exitCode: null, durationMs: 0, ok: false, killed: false, oom: false, truncated: false, denied: reason });
      return { ok: false, exitCode: null, stdout: '', stderr: reason, truncated: false, durationMs: 0, killed: false, oom: false };
    };
    if (!plan.allowed) {
      // 「沙箱不可用而有非 owner 请求执行」是 docs/10 §6 那六类告警之一：对用户表现为工具莫名
      // 失败，而运维那边没有任何信号。owner 走 bypass 不算 —— 那是配置本来就允许的形态。
      if (role !== 'owner') this.onUnavailable?.(plan.reason ?? 'denied', role);
      return denied(plan.reason ?? 'denied');
    }
    const mounted = plan.mode === 'docker' ? this.#hostPath(workspace) : workspace;
    if (mounted === null) return denied(`workspace 不在 sandbox.workspaceDir 之下，无法换算成宿主路径：${workspace}`);
    // 建目录放在放行之后：被拒的调用不该在盘上留下痕迹。容器内建的目录经 ./data 绑定挂载
    // 同步到宿主，所以 #hostPath 换算出来的路径此刻在宿主上也已存在。
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const timeout = Math.min(timeoutMs, this.#cfg().maxTimeoutMs);
    // 名字必须带 turnId（docs/05 §5.3）：`Date.now()` 在并发上限 8 的同一毫秒里会撞名，
    // `docker run --name` 冲突让第二个容器直接失败；而且 /cancel 想按 turn 找容器也无从找起。
    this.#seq += 1;
    const name = `luoli-sbx-${turnId}-${this.#seq}`;
    const dockerArgs = ['run', '--rm', '--name', name, `--network=${this.#cfg().network}`, `--memory=${this.#cfg().memoryMb}m`, `--memory-swap=${this.#cfg().memoryMb}m`, `--cpus=${this.#cfg().cpus}`, `--pids-limit=${this.#cfg().pidsLimit}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', `--tmpfs=/tmp:rw,size=${this.#cfg().tmpfsMb}m,noexec`, '-v', `${mounted}:/workspace:rw`, '-w', '/workspace', '-e', 'HOME=/workspace', '-e', 'LANG=C.UTF-8'];
    // 追加 env 必须在 push image 之前：image 之后的 argv 是**容器里的命令**，`-e` 落到那边就成了
    // 传给 `timeout` 的参数。
    for (const [key, value] of Object.entries(extraEnv ?? {})) dockerArgs.push('-e', `${key}=${value}`);
    if (this.#cfg().readOnlyRoot) dockerArgs.push('--read-only');
    dockerArgs.push(this.#cfg().image, 'timeout', '-s', 'KILL', String(Math.ceil(timeout / 1000)), 'sh', '-c', command);
    // 子进程 env 白名单：只这三个字面量。此前后面还接着 `&& !/(TOKEN|KEY|SECRET|LUOLI)/i.test(key)`
    // —— 前半段已经把 key 限死了，后半段恒为真（docs/27 · T-03）。白名单本身就是那道闸；
    // 真要让它可配，那时再把过滤加回来。
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'TZ'].includes(key)));
    const child = plan.mode === 'docker'
      ? spawn(this.#cfg().dockerBin, dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', plan.mode === 'jail' ? this.#jailed(command, timeout) : command], { cwd: workspace, env: { ...env, HOME: workspace, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now();
    const cap = this.#cfg().maxOutputBytes;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncatedByCap = false;
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      if (plan.mode === 'docker') spawn(this.#cfg().dockerBin, ['kill', name], { stdio: 'ignore' });
      else if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    };
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const current = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, cap * 2 - current);
      const kept = chunk.subarray(0, remaining);
      if (stream === 'stdout') { stdoutBytes += kept.length; stdout += stdoutDecoder.write(kept); }
      else { stderrBytes += kept.length; stderr += stderrDecoder.write(kept); }
      if (kept.length < chunk.length) { truncatedByCap = true; kill(); }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    const timer = setTimeout(kill, timeout);
    abortSignal.addEventListener('abort', kill, { once: true });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', kill);
    stdout += stdoutDecoder.end();
    stderr += stderrDecoder.end();
    const out = clipped(stdout, cap);
    const err = clipped(stderr, cap);
    const oom = exitCode === 137 || /out of memory|oom/i.test(stderr);
    // `ok` 只看退出码。`truncatedByCap` 同一行就 `kill()` 了子进程，退出码本来就不是 0 ——
    // 那个 `&& !truncatedByCap` 唯一还起作用的场合恰好是 bug：子进程已自己退出 0、最后一批
    // >2×cap 的输出在 `close` 之前才 flush 完，`kill()` 打空，于是一次**成功**调用被记成失败，
    // 连着三次就把 bash 停掉一整轮（docs/28 · L-TOOL-01）。
    const durationMs = Math.round(performance.now() - started);
    this.#emit({ turnId, role, mode: plan.mode, image: plan.mode === 'docker' ? this.#cfg().image : null,
      exitCode, durationMs, ok: exitCode === 0, killed, oom, truncated: truncatedByCap || out.truncated || err.truncated });
    return { ok: exitCode === 0, exitCode, stdout: out.value, stderr: err.value, truncated: truncatedByCap || out.truncated || err.truncated, durationMs, killed, oom,
      ...(truncatedByCap ? { hint: `输出超过 ${cap * 2} 字节（tools.exec.maxOutputBytes 的两倍）后子进程已被 SIGKILL，交回的只有头尾各半 —— 命令可能没跑完。把输出收窄再来（重定向到文件后分段 read_file、用 grep/head 过滤、只打印统计），别原样重试。` } : {}) };
  }
}
