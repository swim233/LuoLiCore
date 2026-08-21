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
 * **为什么不复用 `Sandbox.run`**：那是一次性阻塞调用（spawn → 等 close → 交回全部输出），而 ACP 的
 * 终端是**有状态的句柄** —— `create` 立刻返回一个 id，之后 `output` 随时来取增量、`wait_for_exit`
 * 单独等、`kill` 与 `release` 是两个动词。这条路要的是 `terminalId → 进程` 的映射，不是一次采集。
 *
 * ## 执行面：宿主直跑
 *
 * cwd = 本次会话的 root（`realpathSync` 过的那一个，与 jail 边界、`session/new` 的 cwd 是同一个
 *字面量）。ACP 这条路是 owner + 仅私聊，而 `sandbox.bypassRoles: ['owner']` 下 `plan('owner')`
 * 本来就回 `'host'`；更根本的是**今天的 `spawn_harness` 就是宿主起 CLI，它自己 fork 的 shell 一样
 * 在宿主上跑** —— 宿主直跑不是退步，是与既有那条路持平。
 *
 * **排除掉的另两个方案写在这里，别让下一个人重新试一遍：**
 *
 * - **为 ACP 新起一个把仓库挂进去的容器。** 收益是幻觉：agent 要改仓库，所以仓库必须 `:rw` 挂进去，
 *   而容器里的 `rm -rf` 照样毁得掉那份仓库；同时 agent 自己（`read`/`write`/`edit` 那三个内建工具）
 *   仍在宿主上直接碰磁盘，于是「命令在容器里、文件改在宿主上」，工具链与 `node_modules` 还各一份
 *   （容器里 `pnpm test` 装的依赖宿主看不见，反之亦然）。多一层隔离的样子，一分隔离都没多。
 * - **复用会话持久容器（`ContainerManager.prepareExec`）—— 明确错误。** 它挂进去的是
 *   `data/workspace/<chatId>`，而 ACP 的仓库根本不在那底下：命令会在一个空目录里跑，`git status`
 *   报 `not a repository`，而模型会把这句话当成「仓库坏了」。那个方法的签名看起来正好合用
 *   （给个 chatId 就能在容器里跑一条命令），所以这个坑要点名。
 *
 * ## 输出上界：从头部丢、保尾部
 *
 * 协议明文：超限时 client「truncates from the beginning of the output」，且必须切在字符边界上。
 * 这与本仓 `elideMiddleBytes`（留头留尾、省略中间）**刻意分岔**：那个的消费者是我们自己的模型，
 * 而它读的是一次 `bash` 调用的完整回执 —— 头部有命令回显、尾部有报错，中间才是可丢的。这一份的
 * 消费者是外部 agent，它自己知道发了什么命令，要的是「最后发生了什么」。
 */

/** `outputByteLimit` 的下限。低于这个数连一行报错都装不下，那时「有上界」还不如「没结果」。 */
const MIN_OUTPUT_BYTES = 1024;
/** `kill` / `release` 时 SIGTERM 之后等多久上 SIGKILL。比 `AcpChild` 那道梯子短 —— 这里杀的是
 *  一条命令而不是一个正在改文件的 agent，而 `release` 常常在关停的关键路径上。 */
const KILL_GRACE_MS = 2000;

export interface AcpTerminalLimits {
  /** `agent.acp.maxTerminals`：同时存在的终端句柄上界（**含已退出但没 release 的**，那正是逼 agent
   *  release 的那道压力；漏 release 的会在 `releaseAll()` 时落一条凭据）。 */
  maxTerminals: number;
  /** `tools.exec.maxTimeoutMs`：一条命令的硬期限。到点杀**进程组**，而不是「不再等」。 */
  maxTimeoutMs: number;
  /** 单个终端保留的输出字节上界。`outputByteLimit` 没给、或给了个比它还大的数时用这一个。 */
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
    // **argv 直传，不过 shell。** ACP 给的是 command + args 数组 —— 比 `bash` 工具那个字符串命令
    // 严格更安全，把它拼回 `sh -c "..."` 等于自己造一个引号注入面（一个带空格的文件名就够）。
    // env：整份 `acpChildEnv()`（agent 自己就是这么起的，剥成 PATH/LANG/TZ 之后 git / node 全找不着），
    // 再叠 agent 给的那几个。`ACP_ENV_DENY` 仍然成立 —— 它管的是「我们的密钥不进这个进程」，
    // 而 agent 只能往里塞它自己的值，塞不出我们没给它的东西。
    const env: Record<string, string> = acpChildEnv();
    for (const entry of request.env ?? []) env[entry.name] = entry.value;
    let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
    try {
      // `detached: true` 让它成为**进程组组长**，于是 `process.kill(-pid)` 打得到它 fork 出来的
      // 全部孙进程。不 detached 的话 `child.kill()` 只杀掉最外层那一个，`make -j8` 留下八个孤儿。
      // 不 `unref()`：这条进程要被数、被杀、被等，摘掉 handle 等于关停时把它连账都不记地丢掉。
      child = spawn(request.command, [...(request.args ?? [])], { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;
    } catch (error) {
      // 参数本身不合法时 `spawn` **同步抛**（`command` 里一个 NUL 字节就够）。这一档不该变成
      // 一个挂住的请求：当场收成一个已退出的终端，把原话放进输出里。
      this.#push(`luoli: spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      finish({ exitCode: null, signal: null });
    }
    this.#child = child;
    if (!child) return;
    child.stdout.on('data', (chunk: Buffer) => this.#push(this.#decoders.stdout.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => this.#push(this.#decoders.stderr.write(chunk)));
    // ENOENT 是异步来的。`exitCode: null` 而不是编一个 127：127 是 shell 的约定，而这条路上没有
    // shell —— 说一句我们知道的真话（进程没起来，原因在输出里），比给一个看着像 shell 的数字好。
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
   * 追加一段**已解码完整**的文本（`StringDecoder` 保证不会切开多字节字符），越界就从头部丢。
   *
   * 按字节裁而不是按码元：`outputByteLimit` 说的是字节。裁点用 `0xC0` 掩码往后推到下一个前导字节，
   * 于是切口一定落在字符边界上（协议要求），代价是保留的字节数可能比上界略少 —— 协议明说允许。
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
   * 等它退。`signal` 在这条请求被取消 / 连接关闭时触发 —— **必须 settle**，否则 SDK 那侧留一个
   * 永不应答的请求，而 agent 就挂在那儿。取消时交回**当下**的状态（进程照旧在跑，`kill` 是另一个
   * 动词）；那时还没退，所以 exitCode / signal 都是 null。
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

  /** 杀掉整个进程组，**不**摘掉句柄 —— `terminal/kill` 之后 `terminal/output` 照旧要读得到输出。 */
  kill(): void {
    if (this.#exit || !this.#child?.pid) return;
    this.#signal('SIGTERM');
    this.#hard ??= (() => { const timer = setTimeout(() => this.#signal('SIGKILL'), KILL_GRACE_MS); timer.unref?.(); return timer; })();
  }

  #signal(sig: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (!pid) return;
    // 负 pid = 整个进程组（`detached: true` 让子进程成了组长）。组不存在了（都退了）时 ESRCH，
    // 退回打那一个 pid —— 非 POSIX 平台上 `-pid` 本来就不成立。
    try { process.kill(-pid, sig); } catch { try { this.#child?.kill(sig); } catch { /* 已经没了 */ } }
  }

  /** 拆掉一切：杀进程组、清 timer、把管道从 event loop 上摘掉。`release` 与 `releaseAll` 共用。 */
  dispose(): void {
    this.kill();
    if (this.#deadline) clearTimeout(this.#deadline);
    if (this.#hard) clearTimeout(this.#hard);
    // 不等 `'close'`：`release` 的语义是「这个句柄我不要了」，而它常常在关停的关键路径上。
    // 进程本身已经收到 SIGTERM（并在 `KILL_GRACE_MS` 后 SIGKILL），孤儿不会留下。
    for (const pipe of [this.#child?.stdout, this.#child?.stderr]) { try { pipe?.destroy(); } catch { /* 已经拆了 */ } }
  }

  get live(): boolean { return this.#exit === null; }
}

/**
 * 一次 ACP 会话的终端集合。**作用域与会话同生死** —— `AcpManager` 每次调用建一个，
 * prompt 收尾时 `releaseAll()`。
 *
 * 三道 release 兜底：`abortSignal`（用户 `/cancel`）、工具返回路径上的 `finally`、以及关停时的
 * `AcpManager.close()`。少任何一道都会留下一条在宿主上继续跑的命令，而没有人还在等它的输出。
 */
export class AcpTerminals {
  readonly #terminals = new Map<string, HostTerminal>();
  #created = 0;
  #leaked: string[] = [];

  constructor(private readonly jail: PathJail, private readonly root: string, private readonly limits: AcpTerminalLimits) {}

  get created(): number { return this.#created; }
  /** `releaseAll()` 收拾掉的那些（agent 建了却没 release）。`acp.run` 的 data 带它。 */
  get leaked(): readonly string[] { return this.#leaked; }

  create(request: CreateTerminalRequest): CreateTerminalResponse {
    // 数的是**活着的句柄**，不是历史总数：agent 老老实实 release 时它永远撞不到这个上界。
    if (this.#terminals.size >= this.limits.maxTerminals) {
      throw RequestError.invalidParams({ terminals: this.#terminals.size },
        `已经有 ${this.#terminals.size} 个终端没有 release（agent.acp.maxTerminals），先 terminal/release 掉用完的那些`);
    }
    const cwd = this.#cwd(request.cwd);
    const id = `term_${ulid()}`;
    this.#terminals.set(id, new HostTerminal(id, request, cwd, this.limits));
    this.#created += 1;
    return { terminalId: id };
  }

  /**
   * 命令的工作目录。没给就是会话 root；给了就必须落在 jail 边界内 —— `jail.resolve` 同时管
   * `denyGlobs`，而「命令的 cwd」与「要读写的文件」在这件事上没有理由分两套判据。
   *
   * **但这一道拦不住命令自己。** 以 `/**` 结尾的 deny glob 现在同时拒绝那个目录本身
   * （`PathJail` 派生一条去掉后缀的模式），所以「把 cwd 设成一个被保护目录」这一档是真挡住了；
   * 挡不住的是更根本的那一层：命令在宿主上直跑，而 `denyGlobs` 只被 `PathJail` 执行 —— 一条
   * `cat ~/.ssh/id_rsa` 压根不经这个函数（同 `docs/14` T19）。这里的判据是**一致性**（同一个
   * jail 判 cwd 与判文件），不是一道边界。真边界仍然只有 `allowedDirs` 白名单 + 仅 owner + 仅私聊。
   */
  #cwd(requested?: string | null): string {
    if (!requested) return this.root;
    let resolved: string;
    try { resolved = this.jail.resolve(requested); }
    catch (error) { throw RequestError.invalidParams({ cwd: requested }, `cwd 不在本次会话允许的目录内：${error instanceof Error ? error.message : 'path_denied'}`); }
    try { if (!statSync(resolved).isDirectory()) throw new Error('not_a_directory'); }
    catch { throw RequestError.invalidParams({ cwd: requested }, 'cwd 不存在，或者不是一个目录'); }
    return resolved;
  }

  #get(terminalId: string): HostTerminal {
    const terminal = this.#terminals.get(terminalId);
    // 已经 release 过的、或者压根没建过的，一律是一个干净的错 —— 不是一个挂住的请求。
    if (!terminal) throw RequestError.invalidParams({ terminalId }, '没有这个 terminalId（没建过，或者已经 release 了）');
    return terminal;
  }

  output(terminalId: string): TerminalOutputResponse { return this.#get(terminalId).snapshot(); }
  waitForExit(terminalId: string, signal?: AbortSignal): Promise<WaitForTerminalExitResponse> { return this.#get(terminalId).waitForExit(signal); }
  /** 杀但不摘句柄：协议明说 `kill` 之后 `output` 仍然要读得到（那正是它与 `release` 的分工）。 */
  kill(terminalId: string): void { this.#get(terminalId).kill(); }

  release(terminalId: string): void {
    const terminal = this.#get(terminalId);
    this.#terminals.delete(terminalId);
    terminal.dispose();
  }

  /**
   * 兜底回收。**返回还活着的那些**（进程没退、句柄也没 release）—— 那是 agent 的 bug，
   * 调用方要把它落成一条看得见的凭据，否则「命令还在宿主上跑」这件事没有任何地方说得出口。
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
