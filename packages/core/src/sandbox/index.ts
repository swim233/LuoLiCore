import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Role } from '@luoli/shared';

/** 本进程是否跑在容器里。docker 和 podman 各自留的标记文件。 */
function detectContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
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
  killed: boolean;
  oom: boolean;
}

function clipped(buffer: string, max: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(buffer) <= max) return { value: buffer, truncated: false };
  const chars = [...buffer];
  const half = Math.max(1, Math.floor(chars.length * (max / Buffer.byteLength(buffer)) / 2));
  const omitted = Buffer.byteLength(buffer) - max;
  return { value: `${chars.slice(0, half).join('')}\n…省略 ${omitted} bytes…\n${chars.slice(-half).join('')}`, truncated: true };
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
  constructor(config: SandboxConfig | (() => SandboxConfig), dockerAvailable?: boolean, inContainer?: boolean, onWarn?: (message: string) => void) {
    this.#cfg = typeof config === 'function' ? config : () => config;
    this.#dockerAvailable = dockerAvailable ?? null;
    this.#inContainer = inContainer ?? detectContainer();
    this.#warn = onWarn;
  }

  setDockerAvailable(available: boolean): void {
    this.#dockerAvailable = available;
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

  async run(command: string, role: Role, workspace: string, abortSignal: AbortSignal, timeoutMs = this.#cfg().defaultTimeoutMs, turnId = 'adhoc'): Promise<SandboxResult> {
    if (abortSignal.aborted) return { ok: false, exitCode: null, stdout: '', stderr: 'cancelled', truncated: false, durationMs: 0, killed: true, oom: false };
    const plan = this.plan(role, workspace);
    if (!plan.allowed) return { ok: false, exitCode: null, stdout: '', stderr: plan.reason ?? 'denied', truncated: false, durationMs: 0, killed: false, oom: false };
    const mounted = plan.mode === 'docker' ? this.#hostPath(workspace) : workspace;
    if (mounted === null) return { ok: false, exitCode: null, stdout: '', stderr: `workspace 不在 sandbox.workspaceDir 之下，无法换算成宿主路径：${workspace}`, truncated: false, durationMs: 0, killed: false, oom: false };
    // 建目录放在放行之后：被拒的调用不该在盘上留下痕迹。容器内建的目录经 ./data 绑定挂载
    // 同步到宿主，所以 #hostPath 换算出来的路径此刻在宿主上也已存在。
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const timeout = Math.min(timeoutMs, this.#cfg().maxTimeoutMs);
    // 名字必须带 turnId（docs/05 §5.3）：`Date.now()` 在并发上限 8 的同一毫秒里会撞名，
    // `docker run --name` 冲突让第二个容器直接失败；而且 /cancel 想按 turn 找容器也无从找起。
    this.#seq += 1;
    const name = `luoli-sbx-${turnId}-${this.#seq}`;
    const dockerArgs = ['run', '--rm', '--name', name, `--network=${this.#cfg().network}`, `--memory=${this.#cfg().memoryMb}m`, `--memory-swap=${this.#cfg().memoryMb}m`, `--cpus=${this.#cfg().cpus}`, `--pids-limit=${this.#cfg().pidsLimit}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', `--tmpfs=/tmp:rw,size=${this.#cfg().tmpfsMb}m,noexec`, '-v', `${mounted}:/workspace:rw`, '-w', '/workspace', '-e', 'HOME=/workspace', '-e', 'LANG=C.UTF-8'];
    if (this.#cfg().readOnlyRoot) dockerArgs.push('--read-only');
    dockerArgs.push(this.#cfg().image, 'timeout', '-s', 'KILL', String(Math.ceil(timeout / 1000)), 'sh', '-c', command);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'TZ'].includes(key) && !/(TOKEN|KEY|SECRET|LUOLI|BOT_TOKEN)/i.test(key)));
    const limitedCommand = `ulimit -v ${Math.ceil(this.#cfg().memoryMb * 1024)} -t ${Math.ceil(timeout / 1000)} -f ${Math.ceil(this.#cfg().maxOutputBytes / 512)} -u ${this.#cfg().pidsLimit}; exec /bin/sh -c ${JSON.stringify(command)}`;
    const child = plan.mode === 'docker'
      ? spawn(this.#cfg().dockerBin, dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', limitedCommand], { cwd: workspace, env: { ...env, HOME: workspace }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const kill = (): void => {
      killed = true;
      if (plan.mode === 'docker') spawn(this.#cfg().dockerBin, ['kill', name], { stdio: 'ignore' });
      else if (child.pid) process.kill(-child.pid, 'SIGKILL');
    };
    const timer = setTimeout(kill, timeout);
    abortSignal.addEventListener('abort', kill, { once: true });
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', kill);
    const out = clipped(stdout, this.#cfg().maxOutputBytes);
    const err = clipped(stderr, this.#cfg().maxOutputBytes);
    const oom = exitCode === 137 || /out of memory|oom/i.test(stderr);
    return { ok: exitCode === 0, exitCode, stdout: out.value, stderr: err.value, truncated: out.truncated || err.truncated, durationMs: Math.round(performance.now() - started), killed, oom };
  }
}
