import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Writable, type Readable } from 'node:stream';
import type { AcpAgentSettings } from './schema.js';

/**
 * M13 · ACP agent 的子进程侧：argv 构造、env 策略、Node stream ↔ Web stream 桥、stderr 环形缓冲、
 * 以及 `stdin.end → SIGTERM → 5s → SIGKILL` 关停梯。
 *
 * 本文件不 import SDK：上述几项都是纯逻辑，纯函数的用例不应为了校验一次 argv 而引入整个 SDK
 * （`buildAcpArgv` / `guardedByteStream` 各有独立用例）。
 *
 * SDK 不管理进程也不执行 initialize —— 子进程与握手由本模块负责。这与 MCP 相反：那边
 * `StdioClientTransport` 启动进程但不 unref，问题在泄漏；这边 SDK 连 `command` 都不接收。
 */

/** SDK 的 `ndJsonStream` 按 `\n` 切分，输出 500 MB 单行的 agent 会使其整行缓冲。 */
export const ACP_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** stderr 尾部的上界，按码元数计（非字节 —— 此处量的是 JS 字符串长度，中文一字计一）。
 *  仅用于失败时给出子进程自身的输出，不承担日志职责（日志逐行走 LogSink），交回模型的那份
 *  由 `AcpManager` 再按字节裁剪一次。 */
const STDERR_RING_CHARS = 8192;
/** 半行缓冲的上界，同 `McpManager.#pipeStderr`：不输出换行的 agent 不应使该缓冲无界增长。 */
const STDERR_PARTIAL_MAX = 8192;
/** SIGTERM 之后多久升级为 SIGKILL。 */
const KILL_AFTER_MS = 5000;
/**
 * SIGKILL 之后等待 `'close'` 的上界。
 *
 * ChildProcess 的 `'close'` 要求进程已退出并且三条 stdio 管道全部关闭。被 agent 放到后台、
 * 继承其 stdout/stderr 的孙进程（omp 的 `bash` 会留下这类进程）可以长期持有那两个 fd ——
 * 此时 agent 本身已被 SIGKILL 回收，而进程在等待一个不会到达的事件，`shutdown()` 因此阻塞。
 * 这即 `docs/28 · L-EXT-03` 的形态：`shutdown()` 只设置 `process.exitCode`，等待不结束即不退出。
 * 因此关停梯必须有绝对上界，超时后主动销毁管道。
 */
const DRAIN_AFTER_KILL_MS = 2000;
const NEWLINE = 0x0a;

export class AcpLineOverflowError extends Error {
  constructor(readonly limit: number) { super(`acp line exceeded ${limit} bytes`); }
}

export interface AcpExit { code: number | null; signal: NodeJS.Signals | null }

/**
 * 一台 agent 的 argv。`--approval-mode` 无条件下发 —— omp 的 profile 里可能写着
 * `approvalMode: yolo`，不显式覆盖即静默失去权限门。`--tools` 仅在非空时下发（空数组表示全开，
 * 即 omp 自身的默认；下发一个空的 `--tools=` 反而等于不提供任何工具）。
 *
 * `mode`（default / plan）不在此处 —— omp 的 `--mode` 是输出格式（text/json/rpc/rpc-ui），
 * 下发会破坏 stdio 上的 JSON-RPC。会话模式走 `session/set_config_option`。
 */
export function buildAcpArgv(agent: AcpAgentSettings): string[] {
  return ['acp',
    ...(agent.profile ? [`--profile=${agent.profile}`] : []),
    `--approval-mode=${agent.approvalMode}`,
    ...(agent.tools.length ? [`--tools=${agent.tools.join(',')}`] : []),
    ...(agent.model ? [`--model=${agent.model}`] : []),
    ...agent.extraArgs];
}

/**
 * 不传给子进程的环境变量。整份 `process.env` 需要传递 —— agent 依赖自身登录态
 * （`~/.omp` 下的 provider key / OAuth state、`ANTHROPIC_API_KEY` 等），若像沙箱那样剥成
 * `PATH/LANG/TZ` 它无法工作。
 *
 * 但本项目自身的密钥不传：`LUOLI_MASTER_KEY` 可解开库中全部 provider key，`BOT_TOKEN` 即
 * bot 身份本身。与 `agent/harness.ts` 的 `HARNESS_ENV_DENY` 采用同一判据 —— 两处都是
 * 内部行为不可观测的进程。
 */
export const ACP_ENV_DENY = new Set(['LUOLI_MASTER_KEY', 'BOT_TOKEN', 'WEBUI_PASSWORD']);

export function acpChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !ACP_ENV_DENY.has(key)) out[key] = value;
  return out;
}

/**
 * 把 Node 的 stdout 包装成 Web `ReadableStream`，同时统计距上一个 `\n` 的字节数。
 *
 * 这是 `sandbox/exec-stream.ts` 中 `collectProcess` 那个 `2×cap` 就地 kill 的 ACP 对应实现：
 * 超限即 error 整条流（连接随之关闭，manager 将其映射为 `acp_line_too_long`），
 * 而不是把一行 500 MB 的 JSON 累积在内存中等待 SDK 切分。
 *
 * 用 `ByteLengthQueuingStrategy` + `pause()/resume()` 实现背压：无背压时消费端一旦变慢，
 * 队列就构成第二个无界缓冲，上界将失效。
 */
export function guardedByteStream(source: Readable, limit: number, onOverflow?: () => void): ReadableStream<Uint8Array> {
  let pending = 0;
  /** 返回 true 表示本块内存在越界的行。逐段扫描而非整块累积：代价 O(总字节数)，与行数无关。 */
  const overflows = (chunk: Uint8Array): boolean => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, start);
      if (nl < 0) { pending += chunk.length - start; return pending > limit; }
      if (pending + (nl - start) > limit) return true;
      pending = 0;
      start = nl + 1;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk: Buffer) => {
        if (overflows(chunk)) {
          onOverflow?.();
          source.destroy();
          try { controller.error(new AcpLineOverflowError(limit)); } catch { /* 流已处于 error 态 */ }
          return;
        }
        // enqueue 抛出表示流已被别处 error / close。同时销毁源：否则 stdout 继续被读入无人消费的
        // 目标，且该 refed handle 仍挂在 event loop 上。
        try { controller.enqueue(chunk); } catch { source.destroy(); return; }
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.once('end', () => { try { controller.close(); } catch { /* 流已关闭 */ } });
      source.once('error', (error) => { try { controller.error(error); } catch { /* 流已处于 error 态 */ } });
    },
    pull() { source.resume(); },
    cancel() { source.destroy(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 }));
}

export interface AcpChildOptions {
  /** 逐行的 stderr。连接失败原因多数可从这里读到（同 `mcp.stderr` 的先例）。 */
  onStderrLine?: (line: string) => void;
  /** 子进程自行退出。manager 据此区分主动关停与进程自身终止。 */
  onExit?: (exit: AcpExit) => void;
}

/**
 * 一条已启动的 ACP agent 子进程。不调用 unref —— unref 是用「退出时无记录地丢弃一个正在修改
 * 文件的 agent」换取「进程能退出」。正确做法是 `AcpManager` 的 `#children` + `close()`，
 * 并在 `apps/bot/src/main.ts` 的 `shutdown()` 中紧随 `await mcp.close()` 等待它。
 */
export class AcpChild {
  readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly #exited: Promise<AcpExit>;
  /** 'spawn' → resolve，'error' → reject。ENOENT 异步到达，据此才能区分
   *  `acp_spawn_failed`（未启动）与 `acp_handshake_*`（已启动但握手失败）。 */
  readonly #spawned: Promise<void>;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  #exit: AcpExit | null = null;
  #overflowed = false;
  #closing: Promise<void> | null = null;
  #stderrRing = '';
  #stderrPartial = '';

  constructor(command: string, args: readonly string[], cwd: string, private readonly options: AcpChildOptions = {}) {
    this.#child = spawn(command, [...args], { cwd, env: acpChildEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>;
    // stdin 的 EPIPE 必须有监听者：子进程先退出时该 'error' 无监听者会导致整个进程崩溃，
    // 而子进程先退出正是关停与超时两条路径上的常态。
    this.#child.stdin.on('error', () => undefined);
    this.#spawned = new Promise<void>((resolve, reject) => {
      this.#child.once('spawn', resolve);
      this.#child.once('error', reject);
    });
    this.#exited = new Promise<AcpExit>((resolve) => {
      this.#child.once('close', (code, signal) => {
        this.#exit = { code, signal };
        resolve(this.#exit);
        this.options.onExit?.(this.#exit);
      });
      // spawn 失败时 'close' 同样会触发（code=null），因此无需第二条路径；只需避免 reject
      // 变成 unhandledRejection —— `#spawned` 由 manager await，此处不 await。
      this.#child.once('error', () => undefined);
    });
    this.#pipeStderr();
    this.stdin = Writable.toWeb(this.#child.stdin) as WritableStream<Uint8Array>;
    this.stdout = guardedByteStream(this.#child.stdout, ACP_MAX_LINE_BYTES, () => { this.#overflowed = true; });
  }

  get pid(): number | undefined { return this.#child.pid; }
  get spawned(): Promise<void> { return this.#spawned; }
  get exited(): Promise<AcpExit> { return this.#exited; }
  exitStatus(): AcpExit | null { return this.#exit; }
  /** 曾出现单行越界。连接会因此断开，而断开本身无法区分原因 —— 由该标志位区分。 */
  overflowed(): boolean { return this.#overflowed; }
  stderrTail(): string { return this.#stderrRing; }

  #pipeStderr(): void {
    this.#child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.#stderrRing = (this.#stderrRing + text).slice(-STDERR_RING_CHARS);
      this.#stderrPartial += text;
      const lines = this.#stderrPartial.split('\n');
      this.#stderrPartial = (lines.pop() ?? '').slice(-STDERR_PARTIAL_MAX);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.options.onStderrLine?.(trimmed);
      }
    });
  }

  /**
   * `stdin.end → SIGTERM → 5s → SIGKILL`，等待 'close' 实际到达。
   *
   * SIGTERM 紧接 stdin.end 而不预留等待：执行到此处时 `session/close` 已应答，无内容需要 flush；
   * 而 `close()` 位于 `shutdown()` 的关键路径上，每条子进程各等一秒会使停机时间随 agent 数量增长。
   *
   * 该关停梯有绝对上界（`KILL_AFTER_MS + DRAIN_AFTER_KILL_MS`）。SIGKILL 之后仍收不到
   * `'close'` 的唯一原因是 stdio 管道未关闭（见 `DRAIN_AFTER_KILL_MS` 的注释），此时进程本身
   * 已退出 —— 继续等待只会阻塞 `shutdown()`，因此超时后主动 destroy 三条管道并返回。
   *
   * 可重复调用并返回同一个 promise：首次已完整走过关停梯，若第二次立即返回则等同于未等待其退出。
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      if (this.#exit) return;
      try { this.#child.stdin.end(); } catch { /* stdin 已关闭 */ }
      try { this.#child.kill('SIGTERM'); } catch { /* 进程已不存在 */ }
      const hard = setTimeout(() => { try { this.#child.kill('SIGKILL'); } catch { /* 同上 */ } }, KILL_AFTER_MS);
      hard.unref?.();
      const deadline = new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), KILL_AFTER_MS + DRAIN_AFTER_KILL_MS);
        timer.unref?.();
      });
      try {
        if (await Promise.race([this.#exited.then(() => true), deadline])) return;
        // 进程已退出但管道未关闭。销毁它们：既给 `'close'` 补发的机会（`#exit` 因而仍可能填上），
        // 也把这三个 refed handle 从 event loop 上摘除 —— 后者才是进程无法退出的真正来源。
        for (const pipe of [this.#child.stdout, this.#child.stderr, this.#child.stdin]) {
          try { pipe.destroy(); } catch { /* 管道已销毁 */ }
        }
      } finally { clearTimeout(hard); }
    })();
    return this.#closing;
  }
}

export function spawnAcpAgent(agent: AcpAgentSettings, cwd: string, options?: AcpChildOptions): AcpChild {
  return new AcpChild(agent.command, buildAcpArgv(agent), cwd, options);
}
