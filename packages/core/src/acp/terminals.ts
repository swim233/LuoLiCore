import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { ulid } from 'ulid';
import { RequestError } from '@agentclientprotocol/sdk';
import { acpChildEnv } from './process.js';
import type { PathJail } from '../tools/jail.js';
import type { CreateTerminalRequest, CreateTerminalResponse, TerminalExitStatus, TerminalOutputResponse, WaitForTerminalExitResponse } from '@agentclientprotocol/sdk';
import type { Readable } from 'node:stream';

/**
 * M13 · `terminal/*` 的宿主侧实现（`docs/05 §3.5.2`）。
 *
 * 不复用 `Sandbox.run` 的原因：那是一次性阻塞调用（spawn → 等 close → 交回全部输出），而 ACP 的
 * 终端是有状态的句柄 —— `create` 立即返回一个 id，其后 `output` 随时取增量、`wait_for_exit`
 * 单独等待、`kill` 与 `release` 是两个独立操作。这条路需要 `terminalId → 进程` 的映射，而非一次采集。
 *
 * ## 执行面：宿主直跑
 *
 * cwd = 本次会话的 root（`realpathSync` 过的那一个，与 jail 边界、`session/new` 的 cwd 是同一个
 *字面量）。ACP 这条路是 owner + 仅私聊，而 `sandbox.bypassRoles: ['owner']` 下 `plan('owner')`
 * 本就返回 `'host'`；更根本的是现有的 `spawn_harness` 同样是宿主启动 CLI，其 fork 出的 shell 也在
 * 宿主上运行 —— 宿主直跑与既有路径的隔离强度持平，并非降级。
 *
 * 以下两个方案已被排除，不必重复尝试：
 *
 * - 为 ACP 新建一个挂载仓库的容器。收益不成立：agent 要修改仓库，仓库必须 `:rw` 挂入，
 *   容器内的 `rm -rf` 同样能破坏该仓库；同时 agent 自身的 `read`/`write`/`edit` 三个内建工具
 *   仍在宿主上直接读写磁盘，形成命令在容器内、文件改在宿主上的割裂，工具链与 `node_modules`
 *   还各存一份（容器内 `pnpm test` 安装的依赖宿主不可见，反之亦然）。隔离性没有实际增加。
 * - 复用会话持久容器（`ContainerManager.prepareExec`）—— 明确错误。它挂载的是
 *   `data/workspace/<chatId>`，而 ACP 的仓库不在其下：命令会在空目录中执行，`git status`
 *   报 `not a repository`，模型会将其理解为仓库损坏。该方法的签名看似适用
 *   （给定 chatId 即可在容器内执行一条命令），因此在此明确标注。
 *
 * ## 输出上界：从头部丢弃、保留尾部
 *
 * 协议规定：超限时 client 需 truncate from the beginning of the output，且必须切在字符边界上。
 * 这与本仓 `elideMiddleBytes`（留头留尾、省略中间）刻意分岔：后者的消费者是本系统的模型，
 * 读的是一次 `bash` 调用的完整回执 —— 头部有命令回显、尾部有报错，中间可丢弃。此处的
 * 消费者是外部 agent，它知道自己发出的命令，需要的是最后发生了什么。
 */

/** `outputByteLimit` 的下限。低于此值连一行报错都容纳不下，上界将失去意义。 */
const MIN_OUTPUT_BYTES = 1024;
/** `kill` / `release` 时 SIGTERM 之后多久升级为 SIGKILL。比 `AcpChild` 的关停梯短 —— 此处终止的是
 *  一条命令而非正在修改文件的 agent，且 `release` 常处于关停的关键路径上。 */
const KILL_GRACE_MS = 2000;

export interface AcpTerminalLimits {
  /** `agent.acp.maxTerminals`：同时存在的终端句柄上界（含已退出但未 release 的，这构成 agent
   *  归还句柄的压力；未 release 的会在 `releaseAll()` 时留下一条记录）。 */
  maxTerminals: number;
  /** `tools.exec.maxTimeoutMs`：一条命令的硬期限。超时终止整个进程组，而非仅停止等待。 */
  maxTimeoutMs: number;
  /** 单个终端保留的输出字节上界。`outputByteLimit` 缺省或超过该值时取此值。 */
  maxOutputBytes: number;
}

class HostTerminal {
  readonly #child: ChildProcessByStdio<null, Readable, Readable> | null;
  readonly #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  readonly #limit: number;
  readonly #settled: Promise<void>;
  #text = '';
  #bytes = 0;
  #truncated = false;
  #exit: TerminalExitStatus | null = null;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #hard: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly id: string, request: CreateTerminalRequest, cwd: string, limits: AcpTerminalLimits) {
    this.#limit = Math.max(MIN_OUTPUT_BYTES, Math.min(request.outputByteLimit ?? limits.maxOutputBytes, limits.maxOutputBytes));
    let resolveSettled!: () => void;
    this.#settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const finish = (exit: TerminalExitStatus): void => {
      if (this.#exit) return;
      this.#exit = exit;
      if (this.#deadline) clearTimeout(this.#deadline);
      if (this.#hard) clearTimeout(this.#hard);
      resolveSettled();
    };
    // argv 直传，不经 shell。ACP 给的是 command + args 数组，严格优于 `bash` 工具的字符串命令，
    // 将其拼回 `sh -c "..."` 会引入引号注入面（一个带空格的文件名即可触发）。
    // env 取整份 `acpChildEnv()`（agent 本身即以此启动，剥成 PATH/LANG/TZ 后 git / node 均不可用），
    // 再叠加 agent 给出的若干项。`ACP_ENV_DENY` 仍然生效 —— 它约束的是本系统的密钥不进入该进程，
    // 而 agent 只能注入它自己的值。
    const env: Record<string, string> = acpChildEnv();
    for (const entry of request.env ?? []) env[entry.name] = entry.value;
    let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
    try {
      // `detached: true` 使其成为进程组组长，`process.kill(-pid)` 因而能覆盖其 fork 出的
      // 全部孙进程。非 detached 时 `child.kill()` 只终止最外层进程，`make -j8` 会留下八个孤儿。
      // 不调用 `unref()`：该进程需被统计、终止与等待，摘掉 handle 等于关停时无记录地丢弃它。
      child = spawn(request.command, [...(request.args ?? [])], { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;
    } catch (error) {
      // 参数非法时 `spawn` 同步抛出（`command` 含一个 NUL 字节即可触发）。该情形不应变成
      // 挂起的请求：当场收敛为一个已退出的终端，并把原始错误放进输出。
      this.#push(`luoli: spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      finish({ exitCode: null, signal: null });
    }
    this.#child = child;
    if (!child) return;
    child.stdout.on('data', (chunk: Buffer) => this.#push(this.#decoders.stdout.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => this.#push(this.#decoders.stderr.write(chunk)));
    // ENOENT 异步到达。取 `exitCode: null` 而非构造 127：127 是 shell 的约定，而此路径没有
    // shell —— 如实表达进程未启动（原因在输出里），优于给出一个形似 shell 的数字。
    child.once('error', (error) => {
      this.#push(`luoli: spawn failed: ${error.message}\n`);
      finish({ exitCode: null, signal: null });
    });
    child.once('close', (code, signal) => {
      this.#push(this.#decoders.stdout.end());
      this.#push(this.#decoders.stderr.end());
      finish({ exitCode: code, signal });
    });
    this.#deadline = setTimeout(() => {
      this.#push(`\nluoli: 命令超过 ${limits.maxTimeoutMs}ms（tools.exec.maxTimeoutMs）已被终止。\n`);
      this.kill();
    }, limits.maxTimeoutMs);
    this.#deadline.unref?.();
  }

  /**
   * 追加一段已完整解码的文本（`StringDecoder` 保证不切开多字节字符），超限则从头部丢弃。
   *
   * 按字节而非码元裁剪：`outputByteLimit` 的单位是字节。裁剪点用 `0xC0` 掩码后移至下一个前导字节，
   * 切口因而必然落在字符边界上（协议要求），代价是保留字节数可能略少于上界 —— 协议允许。
   */
  #push(text: string): void {
    if (!text) return;
    this.#text += text;
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes <= this.#limit) return;
    const buffer = Buffer.from(this.#text, 'utf8');
    let cut = buffer.length - this.#limit;
    while (cut < buffer.length && (buffer[cut]! & 0xC0) === 0x80) cut += 1;
    this.#text = buffer.subarray(cut).toString('utf8');
    this.#bytes = buffer.length - cut;
    this.#truncated = true;
  }

  snapshot(): TerminalOutputResponse {
    return { output: this.#text, truncated: this.#truncated, ...(this.#exit ? { exitStatus: this.#exit } : {}) };
  }

  /**
   * 等待进程退出。`signal` 在请求被取消或连接关闭时触发 —— 必须 settle，否则 SDK 侧留下一个
   * 永不应答的请求，agent 将一直阻塞。取消时返回当前状态（进程仍在运行，终止是 `kill` 的职责）；
   * 此时尚未退出，因此 exitCode / signal 均为 null。
   */
  async waitForExit(signal?: AbortSignal): Promise<WaitForTerminalExitResponse> {
    if (!this.#exit && signal) {
      if (signal.aborted) return { exitCode: null, signal: null };
      let onAbort!: () => void;
      const aborted = new Promise<void>((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
      try { await Promise.race([this.#settled, aborted]); }
      finally { signal.removeEventListener('abort', onAbort); }
    } else await this.#settled;
    return { exitCode: this.#exit?.exitCode ?? null, signal: this.#exit?.signal ?? null };
  }

  /** 终止整个进程组但不摘除句柄 —— `terminal/kill` 之后 `terminal/output` 仍须能读到输出。 */
  kill(): void {
    if (this.#exit || !this.#child?.pid) return;
    this.#signal('SIGTERM');
    this.#hard ??= (() => { const timer = setTimeout(() => this.#signal('SIGKILL'), KILL_GRACE_MS); timer.unref?.(); return timer; })();
  }

  #signal(sig: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (!pid) return;
    // 负 pid 表示整个进程组（`detached: true` 使子进程成为组长）。进程组已不存在时抛 ESRCH，
    // 退回按单个 pid 发送 —— 非 POSIX 平台上 `-pid` 本就不成立。
    try { process.kill(-pid, sig); } catch { try { this.#child?.kill(sig); } catch { /* 进程已不存在 */ } }
  }

  /** 完整回收：终止进程组、清理 timer、把管道从 event loop 上摘除。`release` 与 `releaseAll` 共用。 */
  dispose(): void {
    this.kill();
    if (this.#deadline) clearTimeout(this.#deadline);
    if (this.#hard) clearTimeout(this.#hard);
    // 不等待 `'close'`：`release` 的语义是释放该句柄，且常处于关停的关键路径上。
    // 进程已收到 SIGTERM（并在 `KILL_GRACE_MS` 后升级为 SIGKILL），不会留下孤儿。
    for (const pipe of [this.#child?.stdout, this.#child?.stderr]) { try { pipe?.destroy(); } catch { /* 管道已销毁 */ } }
  }

  get live(): boolean { return this.#exit === null; }
}

/**
 * 一次 ACP 会话的终端集合，作用域与会话一致 —— `AcpManager` 每次调用创建一个，
 * prompt 收尾时调用 `releaseAll()`。
 *
 * 三道 release 兜底：`abortSignal`（用户 `/cancel`）、工具返回路径上的 `finally`、关停时的
 * `AcpManager.close()`。缺少任一道都会在宿主上留下持续运行且无人接收输出的命令。
 */
export class AcpTerminals {
  readonly #terminals = new Map<string, HostTerminal>();
  #created = 0;
  #leaked: string[] = [];

  constructor(private readonly jail: PathJail, private readonly root: string, private readonly limits: AcpTerminalLimits) {}

  get created(): number { return this.#created; }
  /** `releaseAll()` 回收的句柄（agent 创建后未 release）。`acp.run` 的 data 携带该项。 */
  get leaked(): readonly string[] { return this.#leaked; }

  create(request: CreateTerminalRequest): CreateTerminalResponse {
    // 统计存活句柄而非历史总数：agent 正常 release 时不会触及该上界。
    if (this.#terminals.size >= this.limits.maxTerminals) {
      throw RequestError.invalidParams({ terminals: this.#terminals.size },
        `当前有 ${this.#terminals.size} 个终端未 release（agent.acp.maxTerminals），请先 terminal/release 已用完的句柄`);
    }
    const cwd = this.#cwd(request.cwd);
    const id = `term_${ulid()}`;
    this.#terminals.set(id, new HostTerminal(id, request, cwd, this.limits));
    this.#created += 1;
    return { terminalId: id };
  }

  /**
   * 命令的工作目录。缺省为会话 root；给定时必须落在 jail 边界内 —— `jail.resolve` 同时处理
   * `denyGlobs`，命令的 cwd 与待读写的文件没有理由采用两套判据。
   *
   * 但这一道拦不住命令本身。以 `/**` 结尾的 deny glob 现在同时拒绝该目录自身
   * （`PathJail` 派生一条去掉后缀的模式），因此将 cwd 设为受保护目录这一档确实被挡住；
   * 挡不住的是更底层的一点：命令在宿主上直接执行，而 `denyGlobs` 只由 `PathJail` 执行 ——
   * 一条 `cat ~/.ssh/id_rsa` 不经过本函数（同 `docs/14` T19）。此处的判据是一致性（同一个
   * jail 判定 cwd 与文件），而非边界。真正的边界仍只有 `allowedDirs` 白名单 + 仅 owner + 仅私聊。
   */
  #cwd(requested?: string | null): string {
    if (!requested) return this.root;
    let resolved: string;
    try { resolved = this.jail.resolve(requested); }
    catch (error) { throw RequestError.invalidParams({ cwd: requested }, `cwd 不在本次会话允许的目录内：${error instanceof Error ? error.message : 'path_denied'}`); }
    try { if (!statSync(resolved).isDirectory()) throw new Error('not_a_directory'); }
    catch { throw RequestError.invalidParams({ cwd: requested }, 'cwd 不存在，或不是目录'); }
    return resolved;
  }

  #get(terminalId: string): HostTerminal {
    const terminal = this.#terminals.get(terminalId);
    // 已 release 或从未创建的句柄一律返回明确错误 —— 而不是挂起的请求。
    if (!terminal) throw RequestError.invalidParams({ terminalId }, '不存在该 terminalId（未创建，或已 release）');
    return terminal;
  }

  output(terminalId: string): TerminalOutputResponse { return this.#get(terminalId).snapshot(); }
  waitForExit(terminalId: string, signal?: AbortSignal): Promise<WaitForTerminalExitResponse> { return this.#get(terminalId).waitForExit(signal); }
  /** 终止但不摘除句柄：协议规定 `kill` 之后 `output` 仍须可读，这正是它与 `release` 的分工。 */
  kill(terminalId: string): void { this.#get(terminalId).kill(); }

  release(terminalId: string): void {
    const terminal = this.#get(terminalId);
    this.#terminals.delete(terminalId);
    terminal.dispose();
  }

  /**
   * 兜底回收，返回仍存活的句柄（进程未退出且未 release）—— 那属于 agent 的缺陷，
   * 调用方须将其记录为可见凭据，否则命令仍在宿主上运行这一事实没有任何出口。
   */
  releaseAll(): readonly string[] {
    const live: string[] = [];
    for (const [id, terminal] of this.#terminals) {
      if (terminal.live) live.push(id);
      terminal.dispose();
    }
    this.#terminals.clear();
    if (live.length) this.#leaked = [...this.#leaked, ...live];
    return live;
  }
}
