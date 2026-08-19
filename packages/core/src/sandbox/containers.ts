import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { SandboxContainer, SandboxContainerRepository, Sqlite } from '@luoli/db';
import { deleteAppKv, readAppKv, writeAppKv } from '@luoli/db';
import { KeyedMutex } from '../turn/keyed-mutex.js';
import type { SandboxResult } from './exec-stream.js';
import { collectProcess } from './exec-stream.js';

export interface PersistentSandboxConfig {
  enabled: boolean;
  idleTtlMs: number;
  /** 0 = 不设绝对上限（docs/11：本仓库里 0 一律是「不清」）。 */
  maxLifetimeMs: number;
  maxContainers: number;
  /** **与 `sandbox.network` 是两个键**：那个管一次性容器，这个管持久容器。 */
  network: 'none' | 'bridge';
  reapCron: string;
}

/** `ContainerManager` 从 `SandboxConfig` 里真正用到的那部分，避免它反向依赖 `Sandbox`。 */
export interface ContainerRuntimeConfig {
  dockerBin: string;
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  readOnlyRoot: boolean;
  tmpfsMb: number;
  maxOutputBytes: number;
  persistent: PersistentSandboxConfig;
}

export type ContainerReapReason = 'idle' | 'hard' | 'respec' | 'reset' | 'disabled' | 'orphan' | 'exited' | 'gone';

/** 一次回收 tick 的结果。注册点把它原样落进日志（照 `MaintenanceService.cleanup()` 的约定）。 */
export interface ReapCounts {
  idle: number; hard: number; respec: number; exited: number; gone: number; orphans: number; adopted: number;
}

export interface ContainerEvent {
  /** 字段名是 `type` 而不是 `kind`：`tests/docs.test.ts` 把源码里的 `kind:` 字面量与
   *  `docs/10 §2` 那张表**双向**焊死，而这几个值不是日志 kind（日志 kind 由装配方拼成
   *  `sandbox.container.*` 的字面量再发）。占用 `kind` 只会让那道断言多一条永远解释不清的豁免。 */
  type: 'created' | 'reaped' | 'limit' | 'exec';
  chatId?: string;
  name?: string;
  ok?: boolean;
  data: Record<string, unknown>;
  durationMs?: number;
}

/** 容器里放后台进程日志的目录，相对 `/workspace`。`container_logs` 与 `background` 共用这一个约定。 */
export const BACKGROUND_LOG_DIR = '.luoli-logs';

/**
 * 后台日志名。**这是拼进 shell 的路径片段**，所以字符集在这里就焊死：`..` 或 `/` 溜进去
 * 等于让模型往工作区之外写文件。工具层的 zod 也会挡一道，这里是第二道（同 §3.11 的
 * 「目录过滤不是边界」）。
 */
export function sanitizeLogName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/\.+/g, '.').replace(/^[.-]+/, '');
  return cleaned.slice(0, 64) || 'task';
}
/** 容器里放 exec 进程组 pid 的目录。在 tmpfs 上，不落进用户的工作区。 */
const EXEC_PID_DIR = '/tmp/.luoli-exec';
const DOCKER_CALL_TIMEOUT_MS = 20_000;
/** 建容器要拉起一个进程，比一次 `docker inspect` 慢得多，但也不能没有上界（croner 的 `protect:true`
 *  会让一次不返回的回收把整条 cron 永久打死）。 */
const DOCKER_CREATE_TIMEOUT_MS = 60_000;

/**
 * docker 容器名的合法字符集是 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`。chatId 常为负数（`-100123`），
 * 而 WebUI 试跑的 turnId 里还有冒号（`dryrun:<ulid>`）—— 后者是一个**既有 bug**：docker 模式下
 * 那条路的 `bash` 一直以 `invalid name` 收场，而不是一个沙箱层的错误。两处共用这一道。
 */
export function sanitizeDockerToken(raw: string): string {
  const replaced = raw.replace(/^-/, 'n').replace(/[^a-zA-Z0-9_.-]/g, '-');
  return /^[a-zA-Z0-9]/.test(replaced) ? replaced : `x${replaced}`;
}

export function containerNameFor(chatId: string): string {
  return `luoli-box-${sanitizeDockerToken(chatId)}`;
}

/**
 * 容器一旦跑起来，`--memory` / `--network` / image 都改不动了。把它们的指纹写进 label，
 * 与当前配置不符的容器由回收销毁、下次用时懒加载 —— 没有这一条，运维在 WebUI 换了镜像之后
 * 所有已存在的容器会一直用旧的，而界面上显示的是新的。
 */
export function specHashOf(config: ContainerRuntimeConfig): string {
  const spec = [config.image, config.memoryMb, config.cpus, config.pidsLimit, config.readOnlyRoot, config.tmpfsMb, config.persistent.network].join('|');
  return createHash('sha256').update(spec).digest('hex').slice(0, 16);
}

/**
 * 到期判定。**钉住只豁免滑动那一档** —— 豁免了绝对上限它就不是上限了（docs/05 §5.5）。
 * 纯函数，`tests/sandbox.persistent.test.ts` 直接打它。
 */
export function reapReasonFor(row: Pick<SandboxContainer, 'expiresAt' | 'hardExpiresAt' | 'pinned'>, now: number): 'idle' | 'hard' | null {
  if (row.hardExpiresAt !== null && row.hardExpiresAt <= now) return 'hard';
  if (row.pinned) return null;
  return row.expiresAt <= now ? 'idle' : null;
}

/** `maxLifetimeMs: 0` = 不设上限 → `hard_expires_at` 存 NULL，而不是 `createdAt + 0`。 */
export function hardExpiryFor(createdAt: number, maxLifetimeMs: number): number | null {
  return maxLifetimeMs > 0 ? createdAt + maxLifetimeMs : null;
}

/**
 * RUNTIME 块里「工作目录」那一行括号内的措辞（docs/06 §1）。
 *
 * **剩余时间是近似值**：滑动 TTL 每次执行都会重置，写一个精确到分钟的值只会让模型据此
 * 做时间规划，然后发现自己算错了。持久化没开时原样交回 mode —— 那一档措辞不变。
 */
export function sandboxLabel(mode: string, persistent: PersistentSandboxConfig, expiry: ContainerExpiryHint): string {
  if (mode !== 'docker' || !persistent.enabled) return mode;
  const life = expiry.state === 'pinned' ? '已钉住，不会被回收'
    : expiry.state === 'none' ? `闲置约 ${Math.round(persistent.idleTtlMs / 3_600_000)} 小时后回收`
      : `约 ${Math.max(1, Math.round(expiry.remainingMs / 3_600_000))} 小时后回收，每次执行重新计时`;
  return `${mode} · 常驻容器（${life}；装的包和跑着的进程都留到下一轮，后台任务记得把输出重定向到文件）· ${persistent.network === 'bridge' ? '可出网' : '无网络'}`;
}

/** 没有容器 / 钉住不回收 / 还剩这么久。三种状态在措辞上完全不同，压成一个数字就得靠猜。 */
export type ContainerExpiryHint = { state: 'none' } | { state: 'pinned' } | { state: 'ttl'; remainingMs: number };

const reapMarkerKey = (chatId: string): string => `sandboxReaped:${chatId}`;
const REAP_NOTE: Record<ContainerReapReason, string> = {
  idle: '闲置超时被回收',
  hard: '达到容器最长存活时间被回收',
  respec: '沙箱配置改了，旧容器已按新配置重建',
  reset: '被 owner 重置',
  disabled: '持久容器功能被关掉了',
  orphan: '与记录对不上，已清理',
  exited: '自己退出了',
  gone: '不见了',
};

export interface PreparedExec {
  ok: true;
  argv: string[];
  /** 取消 / 超时 / 输出超限时调它：打容器里那个进程组，**不打容器**。 */
  cancel: () => void;
  /** 执行结束后推进滑动到期。失败也要调（用过就是用过）。 */
  settle: () => void;
  note?: string;
}

export type PrepareFailure = { ok: false; error: string; hint?: string };

/**
 * 会话级持久容器的生命周期（docs/05 §5.5）。
 *
 * **真相在 DB 与 docker 两边，互为校验**：DB 存 docker 存不下的东西（滑动到期、钉住、spec 指纹
 * —— label 建完就改不了），docker 存「它到底还在不在」。进程内不留任何一份权威副本
 * （`docs/01 §3.1`），所以重启之后先对账而不是全杀，24h 的 TTL 才扛得住一次重启。
 */
export class ContainerManager {
  readonly #mutex = new KeyedMutex();

  constructor(
    private readonly db: Sqlite,
    private readonly repo: SandboxContainerRepository,
    private readonly config: () => ContainerRuntimeConfig,
    private readonly onEvent?: (event: ContainerEvent) => void,
  ) {}

  enabled(): boolean {
    return this.config().persistent.enabled;
  }

  list(): SandboxContainer[] {
    return this.repo.list();
  }

  capacity(): { used: number; max: number } {
    return { used: this.repo.count(), max: this.config().persistent.maxContainers };
  }

  /** RUNTIME 块那一行要区分的三种状态（见 `sandboxLabel`）。 */
  expiryHintFor(chatId: string, now = Date.now()): ContainerExpiryHint {
    const row = this.repo.byChat(chatId);
    if (!row) return { state: 'none' };
    // 钉住豁免滑动那一档，但豁免不了绝对上限 —— 两者都没有才是真的「不回收」。
    if (row.pinned && row.hardExpiresAt === null) return { state: 'pinned' };
    const deadline = row.pinned ? row.hardExpiresAt! : Math.min(row.expiresAt, row.hardExpiresAt ?? row.expiresAt);
    return { state: 'ttl', remainingMs: Math.max(0, deadline - now) };
  }

  /** 发事件不许打断执行：这一层的调用点在返回结果的正路上。 */
  #emit(event: ContainerEvent): void {
    try { this.onEvent?.(event); } catch { /* 观测不该把一次成功的执行变成失败 */ }
  }

  #docker(args: string[], timeoutMs = DOCKER_CALL_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.config().dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value: { code: number | null; stdout: string; stderr: string }): void => { if (!settled) { settled = true; resolve(value); } };
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout, stderr: `${stderr}\ndocker 调用超时（${timeoutMs}ms）` }); }, timeoutMs);
      timer.unref?.();
      child.once('error', (cause) => { clearTimeout(timer); finish({ code: null, stdout, stderr: cause.message }); });
      child.once('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
    });
  }

  /**
   * 容器现在到底在不在、spec 对不对。**每次执行前都问一次** —— 一次 `docker inspect` 约几十毫秒，
   * 而 `docker run` 是几百毫秒，省掉它的代价是「容器被 OOM 杀了而我们还在往里 exec」。
   * 顺带在这里就发现 spec 漂移，不用等下一次 `reapCron`。
   */
  async #probe(name: string): Promise<{ running: boolean; spec: string | null; exists: boolean }> {
    const result = await this.#docker(['inspect', '--format', '{{.State.Running}}\t{{index .Config.Labels "luoli.spec"}}', name]);
    if (result.code !== 0) return { running: false, spec: null, exists: false };
    const [running, spec] = result.stdout.trim().split('\t');
    return { running: running === 'true', spec: spec || null, exists: true };
  }

  async #create(chatId: string, mountedWorkspace: string): Promise<{ ok: true; row: SandboxContainer } | PrepareFailure> {
    const config = this.config();
    const { used, max } = this.capacity();
    if (used >= max) {
      this.#emit({ type: 'limit', chatId, data: { used, max } });
      return { ok: false, error: 'sandbox_container_limit',
        hint: `持久容器已达上限（${used}/${max}）。这个会话没有容器，也不会退回一次性容器 —— 用 container_list 看哪些可以回收，或调高 sandbox.persistent.maxContainers。` };
    }
    const name = containerNameFor(chatId);
    const specHash = specHashOf(config);
    // 同名残留（上一次进程崩在建了容器还没落库那一刻）先清掉，否则 --name 冲突让这里永远失败。
    await this.#docker(['rm', '-f', name]);
    const started = performance.now();
    const args = ['run', '-d', '--init', '--name', name,
      '--label', 'luoli.managed=1', '--label', `luoli.chat=${chatId}`, '--label', `luoli.spec=${specHash}`,
      `--network=${config.persistent.network}`, `--memory=${config.memoryMb}m`, `--memory-swap=${config.memoryMb}m`,
      `--cpus=${config.cpus}`, `--pids-limit=${config.pidsLimit}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=1000:1000', `--tmpfs=/tmp:rw,size=${config.tmpfsMb}m,noexec`,
      '-v', `${mountedWorkspace}:/workspace:rw`, '-w', '/workspace', '-e', 'HOME=/workspace', '-e', 'LANG=C.UTF-8'];
    if (config.readOnlyRoot) args.push('--read-only');
    args.push(config.image, 'sleep', 'infinity');
    const created = await this.#docker(args, DOCKER_CREATE_TIMEOUT_MS);
    if (created.code !== 0) {
      return { ok: false, error: 'sandbox_container_create_failed', hint: created.stderr.trim().slice(0, 600) || `docker run 以 ${created.code} 退出` };
    }
    // 取消要杀整个进程组，而那依赖 setsid。自带镜像有（python:3.12-slim 的 util-linux），
    // 自定义镜像未必 —— 探一次并记下来，没有它时取消只能杀一个 pid，那件事必须说出口。
    const probe = await this.#docker(['exec', name, 'sh', '-c', `command -v setsid >/dev/null && mkdir -p ${EXEC_PID_DIR} ${BACKGROUND_LOG_DIR}`]);
    const hasSetsid = probe.code === 0;
    if (!hasSetsid) await this.#docker(['exec', name, 'sh', '-c', `mkdir -p ${EXEC_PID_DIR} ${BACKGROUND_LOG_DIR}`]);
    const now = Date.now();
    const row = this.repo.create({ chatId, name, containerId: created.stdout.trim().slice(0, 64) || null, image: config.image, specHash,
      hasSetsid, expiresAt: now + config.persistent.idleTtlMs, hardExpiresAt: hardExpiryFor(now, config.persistent.maxLifetimeMs) });
    this.#emit({ type: 'created', chatId, name, durationMs: Math.round(performance.now() - started),
      data: { image: config.image, specHash, hasSetsid, network: config.persistent.network } });
    return { ok: true, row };
  }

  /**
   * 拿到这个会话可用的容器；没有 / 死了 / spec 漂了就重建。**按 chatId 串行** ——
   * 同一会话并发两轮否则会 `--name` 撞车，第二个直接失败。
   */
  async ensure(chatId: string, mountedWorkspace: string): Promise<{ ok: true; row: SandboxContainer; note?: string } | PrepareFailure> {
    return this.#mutex.run(chatId, async () => {
      const config = this.config();
      const existing = this.repo.byChat(chatId);
      if (existing) {
        const probe = await this.#probe(existing.name);
        const specHash = specHashOf(config);
        if (probe.exists && probe.running && probe.spec === specHash) return { ok: true, row: existing };
        await this.#destroy(existing, probe.exists ? (probe.running ? 'respec' : 'exited') : 'gone');
      }
      const created = await this.#create(chatId, mountedWorkspace);
      if (!created.ok) return created;
      const marker = readAppKv<{ reason: ContainerReapReason; at: number }>(this.db, reapMarkerKey(chatId));
      if (!marker) return { ok: true, row: created.row };
      deleteAppKv(this.db, reapMarkerKey(chatId));
      return { ok: true, row: created.row,
        note: `这个会话的容器是刚新建的：上一个${REAP_NOTE[marker.reason]}。容器里之前装的东西、跑着的后台进程都不在了（/workspace 里的文件不受影响）。` };
    });
  }

  /**
   * 把一次执行翻译成 `docker exec` 的 argv + 一个「只杀进程不杀容器」的取消钩子。
   *
   * **`docker kill <容器名>` 在这一档是错的**：一次性容器里它等于「取消这条命令」，持久容器里
   * 它等于「销毁这个群的整个环境」，而 `/cancel` 与超时走的是同一个 `kill()`（docs/05 §5.5）。
   */
  async prepareExec(input: { chatId: string; mountedWorkspace: string; command: string; timeoutMs: number; extraEnv?: Readonly<Record<string, string>>; background?: { name: string } }): Promise<PreparedExec | PrepareFailure> {
    const ready = await this.ensure(input.chatId, input.mountedWorkspace);
    if (!ready.ok) return ready;
    const { row } = ready;
    const config = this.config();
    const execId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const argv = ['exec', '--user=1000:1000', '--workdir=/workspace', '-e', 'HOME=/workspace', '-e', 'LANG=C.UTF-8'];
    for (const [key, value] of Object.entries(input.extraEnv ?? {})) argv.push('-e', `${key}=${value}`);
    argv.push(row.name);
    argv.push(...this.#wrap(row, execId, input.command, input.timeoutMs, input.background));
    return {
      ok: true,
      argv,
      cancel: () => {
        // 打进程组。杀不干净也不去动容器 —— 宁可留一个跑飞的进程，也不能因为一次取消
        // 就把别人的后台服务连根拔掉。
        //
        // **`kill` 后面不能写 `--`。** dash 的内建 kill 不认这个分隔符，`kill -KILL -- -123`
        // 直接 `Illegal number: -` 退 2，于是取消整条静静失效 —— 表现是 `/cancel` 之后那条
        // 命令一直跑到自己的 timeout 才结束（实测于 `sandbox.containers.docker.test.ts`）。
        const target = `$(cat ${EXEC_PID_DIR}/${execId} 2>/dev/null || echo 0)`;
        const signal = row.hasSetsid ? `kill -KILL -${target} 2>/dev/null` : `kill -KILL ${target} 2>/dev/null`;
        void this.#docker(['exec', row.name, 'sh', '-c', `${signal}; rm -f ${EXEC_PID_DIR}/${execId}`], 5000);
      },
      settle: () => { this.repo.touch(input.chatId, Date.now() + config.persistent.idleTtlMs); },
      ...(ready.note ? { note: ready.note } : {}),
    };
  }

  /**
   * 容器里那一层包装。三件事：把进程组 id 落进 pidfile（取消要用）、套上硬期限、
   * 后台任务重定向到文件。
   *
   * **后台任务的重定向不是方便而是必需**：exec 一结束管道就关，后台进程下一次写 stdout
   * 吃 SIGPIPE 就死了 —— 「起了个 server，下一轮发现它不在」正是这么来的。
   */
  #wrap(row: SandboxContainer, execId: string, command: string, timeoutMs: number, background?: { name: string }): string[] {
    const pidFile = `${EXEC_PID_DIR}/${execId}`;
    const record = `mkdir -p ${EXEC_PID_DIR}; echo $$ > ${pidFile}`;
    if (background) {
      const log = `${BACKGROUND_LOG_DIR}/${sanitizeLogName(background.name)}.log`;
      // 后台那一档不套 `timeout`：它的期限是容器的 TTL，不是这一次调用的。
      const script = `mkdir -p ${BACKGROUND_LOG_DIR}; ${record}; ${row.hasSetsid ? 'setsid ' : ''}sh -c ${shellQuote(command)} >> ${log} 2>&1 & echo "$!"`;
      return ['sh', '-c', script];
    }
    const inner = `${record}; exec timeout -s KILL ${Math.ceil(timeoutMs / 1000)} sh -c ${shellQuote(command)}`;
    // `setsid -w` 让被执行的命令成为会话首进程（`$$` 即 pgid），`-w` 保证退出码原样透传。
    return row.hasSetsid ? ['setsid', '-w', 'sh', '-c', inner] : ['sh', '-c', inner];
  }

  /** 一次不经 `Sandbox.run` 的直接执行（`container_*` 工具走这条：它要指定会话，而不是当前轮次的）。 */
  async exec(input: { chatId: string; mountedWorkspace: string; command: string; timeoutMs: number; abortSignal: AbortSignal; background?: { name: string } }): Promise<SandboxResult | PrepareFailure> {
    const prepared = await this.prepareExec(input);
    if (!prepared.ok) return prepared;
    const started = performance.now();
    const child = spawn(this.config().dockerBin, prepared.argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collectProcess(child, { timeoutMs: input.timeoutMs, maxOutputBytes: this.config().maxOutputBytes, abortSignal: input.abortSignal, kill: prepared.cancel });
    prepared.settle();
    this.#emit({ type: 'exec', chatId: input.chatId, name: containerNameFor(input.chatId), ok: result.ok,
      durationMs: Math.round(performance.now() - started),
      data: { exitCode: result.exitCode, ms: result.durationMs, background: Boolean(input.background), killed: result.killed } });
    return prepared.note ? { ...result, note: prepared.note } : result;
  }

  /** 容器里在跑什么 + 吃多少 + 后台日志有哪些。三条 docker 调用，任一失败都只让那一段缺席。 */
  async inspect(chatId: string): Promise<{ ok: true; row: SandboxContainer; processes: string; stats: string; logs: string } | PrepareFailure> {
    const row = this.repo.byChat(chatId);
    if (!row) return { ok: false, error: 'container_not_found', hint: '这个会话现在没有容器。用 container_list 看有哪些，或让它执行一次命令就会建起来。' };
    const [processes, stats, logs] = await Promise.all([
      this.#docker(['top', row.name, '-eo', 'pid,ppid,etime,pcpu,pmem,args']),
      this.#docker(['stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}', row.name]),
      this.#docker(['exec', row.name, 'sh', '-c', `ls -la ${BACKGROUND_LOG_DIR} 2>/dev/null || echo '(没有后台日志)'`]),
    ]);
    return { ok: true, row,
      processes: (processes.code === 0 ? processes.stdout : `读不到进程表：${processes.stderr.trim()}`).slice(0, 8000),
      stats: (stats.code === 0 ? stats.stdout : `读不到资源用量：${stats.stderr.trim()}`).trim(),
      logs: (logs.code === 0 ? logs.stdout : `读不到日志目录：${logs.stderr.trim()}`).slice(0, 4000) };
  }

  async #destroy(row: SandboxContainer, reason: ContainerReapReason): Promise<number> {
    // 销毁前数一下还剩几个非 PID1 进程：容器一没，那个会话里跑着的 server 就没了，
    // 而用户看到的只是「它突然不工作了」。
    let aliveProcs = 0;
    if (reason !== 'gone') {
      const top = await this.#docker(['top', row.name, '-eo', 'pid'], 5000);
      if (top.code === 0) aliveProcs = Math.max(0, top.stdout.trim().split('\n').length - 2);
    }
    await this.#docker(['rm', '-f', row.name]);
    this.repo.remove(row.chatId);
    // 下一次为这个会话建容器时把这句话交给模型（docs/06 §1）—— 它没有别的途径知道
    // 自己起的后台进程为什么不见了。
    writeAppKv(this.db, reapMarkerKey(row.chatId), { reason, at: Date.now() }, 'sandbox-reap');
    this.#emit({ type: 'reaped', chatId: row.chatId, name: row.name,
      data: { reason, aliveProcs, ageMs: Date.now() - row.createdAt, execCount: row.execCount } });
    return aliveProcs;
  }

  /** `container_reset` / WebUI 的「重置」：销毁并立刻重建。**不动 `/workspace` 的文件**。 */
  async reset(chatId: string, mountedWorkspace: string): Promise<{ ok: true; row: SandboxContainer } | PrepareFailure> {
    return this.#mutex.run(chatId, async () => {
      const existing = this.repo.byChat(chatId);
      if (existing) await this.#destroy(existing, 'reset');
      else await this.#docker(['rm', '-f', containerNameFor(chatId)]);
      // 刚销毁的那条标记不该变成「上一个被回收了」的旁白 —— 重置是 owner 自己按的。
      deleteAppKv(this.db, reapMarkerKey(chatId));
      return this.#create(chatId, mountedWorkspace);
    });
  }

  async destroy(chatId: string, reason: ContainerReapReason = 'reset'): Promise<boolean> {
    const row = this.repo.byChat(chatId);
    if (!row) return false;
    await this.#destroy(row, reason);
    return true;
  }

  keep(chatId: string, patch: { hours?: number; pin?: boolean }): { ok: true; row: SandboxContainer } | PrepareFailure {
    const row = this.repo.byChat(chatId);
    if (!row) return { ok: false, error: 'container_not_found', hint: '这个会话现在没有容器。' };
    // 续期钳在绝对上限内：钉住与续期都豁免不了 hard_expires_at（docs/05 §5.5）。
    const requested = patch.hours === undefined ? undefined : Date.now() + Math.round(patch.hours * 3_600_000);
    const expiresAt = requested === undefined ? undefined : (row.hardExpiresAt === null ? requested : Math.min(requested, row.hardExpiresAt));
    this.repo.keep(chatId, { ...(expiresAt === undefined ? {} : { expiresAt }), ...(patch.pin === undefined ? {} : { pinned: patch.pin }) });
    return { ok: true, row: this.repo.byChat(chatId)! };
  }

  /**
   * 回收 + 对账。每个 tick 三件事，返回各自的条数交给注册点原样落日志。
   *
   * **启动时也跑这个，而不是全杀** —— 24h 的 TTL 要扛得住一次进程重启。
   */
  async reap(now = Date.now()): Promise<ReapCounts> {
    const config = this.config();
    const counts: ReapCounts = { idle: 0, hard: 0, respec: 0, exited: 0, gone: 0, orphans: 0, adopted: 0 };
    if (!config.persistent.enabled) {
      // 关掉开关不该让已有容器无人认领地留在宿主上 —— 但也不能只删容器留下库里的行。
      // 走正常的销毁路径，然后再扫一遍标签兜住那些库里本来就没有的。
      for (const row of this.repo.list()) { await this.#destroy(row, 'disabled'); counts.gone += 1; }
      return this.#sweepOrphans(counts, new Set());
    }
    const specHash = specHashOf(config);
    const rows = this.repo.list();
    for (const row of rows) {
      const expiry = reapReasonFor(row, now);
      if (expiry) { await this.#destroy(row, expiry); counts[expiry] += 1; continue; }
      const probe = await this.#probe(row.name);
      if (!probe.exists) { await this.#destroy(row, 'gone'); counts.gone += 1; continue; }
      if (!probe.running) { await this.#destroy(row, 'exited'); counts.exited += 1; continue; }
      if (probe.spec !== specHash || row.specHash !== specHash) { await this.#destroy(row, 'respec'); counts.respec += 1; continue; }
      counts.adopted += 1;
    }
    return this.#sweepOrphans(counts, new Set(this.repo.list().map((row) => row.name)));
  }

  /** 带 `luoli.managed=1` 标签却不在库里的容器：上一次进程崩在建容器与落库之间留下的。 */
  async #sweepOrphans(counts: ReapCounts, known: Set<string>): Promise<ReapCounts> {
    const listed = await this.#docker(['ps', '-a', '--filter', 'label=luoli.managed=1', '--format', '{{.Names}}']);
    if (listed.code !== 0) return counts;
    for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (known.has(name)) continue;
      await this.#docker(['rm', '-f', name]);
      counts.orphans += 1;
    }
    // 对账那一行由调用方（`sandbox-reap` 那条 cron）落 —— 这里再发一次就是同一件事记两遍。
    return counts;
  }
}

/** 单引号包裹 + 内部单引号转义。命令串只经过这一层进 `sh -c`，不做别的拼接。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 容器的 workspace 目录要在建容器之前存在，否则 docker 会在宿主上默默建一个 root 拥有的空目录。 */
export function ensureWorkspaceDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
