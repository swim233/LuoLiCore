import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { Role } from '@luoli/shared';

export interface SandboxConfig {
  mode: 'none' | 'jail' | 'docker';
  bypassRoles: Role[];
  dockerBin: string;
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

  constructor(private readonly config: SandboxConfig, dockerAvailable?: boolean) {
    this.#dockerAvailable = dockerAvailable ?? null;
  }

  setDockerAvailable(available: boolean): void {
    this.#dockerAvailable = available;
  }
  async probe(): Promise<{ available: boolean; mode: SandboxConfig['mode']; error?: string }> {
    if (this.config.mode !== 'docker') return { available: this.config.mode === 'jail', mode: this.config.mode };
    const result = await new Promise<{ available: boolean; error?: string }>((resolve) => {
      const child = spawn(this.config.dockerBin, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let settled = false;
      const finish = (value: { available: boolean; error?: string }): void => { if (!settled) { settled = true; resolve(value); } };
      let error = '';
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, error: 'probe_timeout' }); }, 5000);
      child.once('error', (cause) => { clearTimeout(timer); finish({ available: false, error: cause.message }); });
      child.once('close', (code) => { clearTimeout(timer); finish(code === 0 ? { available: true } : { available: false, error: error.trim() || `exit_${code}` }); });
    });
    this.#dockerAvailable = result.available;
    return result.error ? { available: result.available, mode: this.config.mode, error: result.error } : { available: result.available, mode: this.config.mode };
  }

  plan(role: Role, _workspace = '.'): { allowed: boolean; mode: 'host' | 'jail' | 'docker'; reason?: string } {
    if (this.config.bypassRoles.includes(role)) return { allowed: true, mode: 'host' };
    if (this.config.mode === 'none') return { allowed: false, mode: 'jail', reason: '沙箱未启用，执行类工具已禁用' };
    if (this.config.mode === 'docker' && this.#dockerAvailable === false) return { allowed: false, mode: 'docker', reason: 'Docker 沙箱不可用，执行类工具已禁用' };
    return { allowed: true, mode: this.config.mode };
  }

  async run(command: string, role: Role, workspace: string, abortSignal: AbortSignal, timeoutMs = this.config.defaultTimeoutMs): Promise<SandboxResult> {
    if (abortSignal.aborted) return { ok: false, exitCode: null, stdout: '', stderr: 'cancelled', truncated: false, durationMs: 0, killed: true, oom: false };
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const plan = this.plan(role, workspace);
    if (!plan.allowed) return { ok: false, exitCode: null, stdout: '', stderr: plan.reason ?? 'denied', truncated: false, durationMs: 0, killed: false, oom: false };
    const timeout = Math.min(timeoutMs, this.config.maxTimeoutMs);
    const name = `luoli-sbx-${Date.now()}`;
    const dockerArgs = ['run', '--rm', '--name', name, `--network=${this.config.network}`, `--memory=${this.config.memoryMb}m`, `--memory-swap=${this.config.memoryMb}m`, `--cpus=${this.config.cpus}`, `--pids-limit=${this.config.pidsLimit}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', `--tmpfs=/tmp:rw,size=${this.config.tmpfsMb}m,noexec`, '-v', `${workspace}:/workspace:rw`, '-w', '/workspace', '-e', 'HOME=/workspace', '-e', 'LANG=C.UTF-8'];
    if (this.config.readOnlyRoot) dockerArgs.push('--read-only');
    dockerArgs.push(this.config.image, 'timeout', '-s', 'KILL', String(Math.ceil(timeout / 1000)), 'sh', '-c', command);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'TZ'].includes(key) && !/(TOKEN|KEY|SECRET|LUOLI|BOT_TOKEN)/i.test(key)));
    const limitedCommand = `ulimit -v ${Math.ceil(this.config.memoryMb * 1024)} -t ${Math.ceil(timeout / 1000)} -f ${Math.ceil(this.config.maxOutputBytes / 512)} -u ${this.config.pidsLimit}; exec /bin/sh -c ${JSON.stringify(command)}`;
    const child = plan.mode === 'docker'
      ? spawn(this.config.dockerBin, dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', limitedCommand], { cwd: workspace, env: { ...env, HOME: workspace }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const kill = (): void => {
      killed = true;
      if (plan.mode === 'docker') spawn(this.config.dockerBin, ['kill', name], { stdio: 'ignore' });
      else if (child.pid) process.kill(-child.pid, 'SIGKILL');
    };
    const timer = setTimeout(kill, timeout);
    abortSignal.addEventListener('abort', kill, { once: true });
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', kill);
    const out = clipped(stdout, this.config.maxOutputBytes);
    const err = clipped(stderr, this.config.maxOutputBytes);
    const oom = exitCode === 137 || /out of memory|oom/i.test(stderr);
    return { ok: exitCode === 0, exitCode, stdout: out.value, stderr: err.value, truncated: out.truncated || err.truncated, durationMs: Math.round(performance.now() - started), killed, oom };
  }
}
