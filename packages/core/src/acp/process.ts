import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Writable, type Readable } from 'node:stream';
import type { AcpAgentSettings } from './schema.js';

/**
 * M13 · ACP agent 的子进程侧：argv 构造、env 策略、Node stream ↔ Web stream 桥、stderr 环形缓冲、
 * 以及 `stdin.end → SIGTERM → 5s → SIGKILL` 那道关停梯。
 *
 * **这个文件不 import SDK。** 上面那几样都是纯的，纯函数的用例不该为了量一次 argv 把整个 SDK
 * 拖进来（`buildAcpArgv` / `guardedByteStream` 各有自己的用例）。
 *
 * SDK 不管进程也不做 initialize —— 子进程与握手都是我们的账。这和 MCP 那边正好相反：那边
 * `StdioClientTransport` 起进程但**不 unref**，坑在泄漏；这边 SDK 连 `command` 都不收。
 */

/** SDK 的 `ndJsonStream` 按 `\n` 切，一个吐 500 MB 单行的 agent 会把它整行缓冲住。 */
export const ACP_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** stderr 尾巴的上界，**按码元数**（不是字节 —— 这里量的是 JS 字符串长度，中文一个字算一个）。
 *  它只用来在失败时给一句「它自己说了什么」，不是日志（日志逐行走 LogSink），真正交回模型的那份
 *  由 `AcpManager` 再按字节裁一次。 */
const STDERR_RING_CHARS = 8192;
/** 半行缓冲的上界，同 `McpManager.#pipeStderr`：一台不打换行的 agent 不该让这个缓冲无界涨。 */
const STDERR_PARTIAL_MAX = 8192;
/** SIGTERM 之后等多久上 SIGKILL。 */
const KILL_AFTER_MS = 5000;
/**
 * SIGKILL 之后再等多久就放弃等 `'close'`。
 *
 * ChildProcess 的 `'close'` 要求进程已死**并且**三条 stdio 管道全关。一个被 agent 丢到后台、
 * 继承了它 stdout/stderr 的孙进程（omp 的 `bash` 就会留下这种）能把那两个 fd 一直握着 ——
 * 那时 agent 本身早已被 SIGKILL 收掉，而我们在等一个永远不来的事件，`shutdown()` 就卡在这里。
 * 这正是 `docs/28 · L-EXT-03` 那个形态：`shutdown()` 只设 `process.exitCode`，等不完就是不退。
 * 所以关停梯必须有一个**绝对**上界，到点自己把管道拆掉。
 */
const DRAIN_AFTER_KILL_MS = 2000;
const NEWLINE = 0x0a;

export class AcpLineOverflowError extends Error {
  constructor(readonly limit: number) { super(`acp line exceeded ${limit} bytes`); }
}

export interface AcpExit { code: number | null; signal: NodeJS.Signals | null }

/**
 * 一台 agent 的 argv。**`--approval-mode` 无条件下发** —— omp 的 profile 里可能写着
 * `approvalMode: yolo`，不显式盖过就是静默失去权限门。`--tools` 只在非空时下发（空数组 = 全开，
 * 那是 omp 自己的默认，加一个空的 `--tools=` 反而是「一个工具都不给」）。
 *
 * `mode`（default / plan）**不在这里** —— omp 的 `--mode` 是输出格式（text/json/rpc/rpc-ui），
 * 下发过去会把 stdio 上的 JSON-RPC 弄坏。会话模式走 `session/set_config_option`。
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
 * 不给子进程的环境变量。整份 `process.env` 交过去 —— agent 要用它自己的登录态
 * （`~/.omp` 下的 provider key / OAuth state、`ANTHROPIC_API_KEY` 之类），剥成 `PATH/LANG/TZ`
 * 那样（沙箱的做法）它就没法工作了。
 *
 * 但**本项目自己的密钥不给**：`LUOLI_MASTER_KEY` 能解开库里全部 provider key，`BOT_TOKEN` 是
 * bot 身份本身。与 `agent/harness.ts` 的 `HARNESS_ENV_DENY` 同一份判据 —— 两处都是「我们看不见
 * 内部行为的进程」。
 */
export const ACP_ENV_DENY = new Set(['LUOLI_MASTER_KEY', 'BOT_TOKEN', 'WEBUI_PASSWORD']);

export function acpChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !ACP_ENV_DENY.has(key)) out[key] = value;
  return out;
}

/**
 * 把 Node 的 stdout 包成 Web `ReadableStream`，顺带数「距上一个 `\n` 多少字节」。
 *
 * 这是 `sandbox/exec-stream.ts` 里 `collectProcess` 那个 `2×cap` 就地 kill 的 ACP 对偶：
 * 越界就 error 掉整条流（连接随之关闭，manager 把它映射成 `acp_line_too_long`），
 * 而不是把一行 500 MB 的 JSON 攒进内存等 SDK 来切。
 *
 * 用 `ByteLengthQueuingStrategy` + `pause()/resume()` 做背压：不给背压的话消费端慢一点，
 * 队列就是第二个无界缓冲 —— 上界白设了。
 */
export function guardedByteStream(source: Readable, limit: number, onOverflow?: () => void): ReadableStream<Uint8Array> {
  let pending = 0;
  /** 返回 true = 这一块里有一行越界了。逐段扫而不是整块攒：代价是 O(总字节数)，与行数无关。 */
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
          try { controller.error(new AcpLineOverflowError(limit)); } catch { /* 已经 error 过 */ }
          return;
        }
        // enqueue 抛 = 流已经被别处 error / close 掉了。**顺手把源拆掉** —— 不拆的话 stdout
        // 继续被读进一个没人要的地方，那条 refed handle 也还挂在 event loop 上。
        try { controller.enqueue(chunk); } catch { source.destroy(); return; }
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.once('end', () => { try { controller.close(); } catch { /* 已经关了 */ } });
      source.once('error', (error) => { try { controller.error(error); } catch { /* 已经 error 过 */ } });
    },
    pull() { source.resume(); },
    cancel() { source.destroy(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 }));
}

export interface AcpChildOptions {
  /** 逐行的 stderr。**这是「为什么它连不上」最常见的答案所在**（同 `mcp.stderr` 那条先例）。 */
  onStderrLine?: (line: string) => void;
  /** 子进程自己退了。manager 靠它区分「我们关的」与「它自己死的」。 */
  onExit?: (exit: AcpExit) => void;
}

/**
 * 一条起好的 ACP agent 子进程。**不 unref** —— unref 是把「进程退不出去」换成「退出时把一个
 * 正在改文件的 agent 连账都不记地丢掉」。正确答案是 `AcpManager` 的 `#children` + `close()`，
 * 并在 `apps/bot/src/main.ts` 的 `shutdown()` 里紧挨着 `await mcp.close()` 等它。
 */
export class AcpChild {
  readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly #exited: Promise<AcpExit>;
  /** 'spawn' → resolve，'error' → reject。ENOENT 是异步来的，靠它才分得开
   *  `acp_spawn_failed`（起不来）与 `acp_handshake_*`（起来了但握不上手）。 */
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
    // stdin 的 EPIPE 必须有人接：子进程先死一步时这个 'error' 没有监听者就会打崩整个进程，
    // 而「子进程先死」正是关停与超时两条路上的常态。
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
      // spawn 失败时 'close' 也会来（code=null），所以这里不需要第二条路；只是别让 reject
      // 变成 unhandledRejection —— `#spawned` 那份由 manager await，这份不 await。
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
  /** 单行越界过。连接会因此断开，而「断开」本身分不出原因 —— 这一位才分得出。 */
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
   * `stdin.end → SIGTERM → 5s → SIGKILL`，**等到 'close' 真的到达为止**。
   *
   * SIGTERM 紧跟在 stdin.end 之后而不是先等一段：走到这里时 `session/close` 已经答复过了，
   * 没有什么还需要 flush；而 `close()` 在 `shutdown()` 的关键路径上，每条子进程各等一秒会
   * 让停机时间跟着 agent 数量涨。
   *
   * **这条梯子有绝对上界**（`KILL_AFTER_MS + DRAIN_AFTER_KILL_MS`）。SIGKILL 之后仍然等不到
   * `'close'` 的唯一原因是 stdio 管道还开着（见 `DRAIN_AFTER_KILL_MS` 那条注释），那时进程本身
   * 已经死了 —— 再等下去只会把 `shutdown()` 钉住，所以到点自己 destroy 三条管道并返回。
   *
   * 可重复调，返回同一个 promise：第一次已经把梯子走了一遍，第二次立刻返回等于**没等**它死。
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      if (this.#exit) return;
      try { this.#child.stdin.end(); } catch { /* 已经关了 */ }
      try { this.#child.kill('SIGTERM'); } catch { /* 已经没了 */ }
      const hard = setTimeout(() => { try { this.#child.kill('SIGKILL'); } catch { /* 同上 */ } }, KILL_AFTER_MS);
      hard.unref?.();
      const deadline = new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), KILL_AFTER_MS + DRAIN_AFTER_KILL_MS);
        timer.unref?.();
      });
      try {
        if (await Promise.race([this.#exited.then(() => true), deadline])) return;
        // 进程已死、管道没关。拆掉它们：既让 `'close'` 有机会补发（`#exit` 因此仍可能填上），
        // 也把这三个 refed handle 从 event loop 上摘掉 —— 后者才是「进程退不出去」的真正来源。
        for (const pipe of [this.#child.stdout, this.#child.stderr, this.#child.stdin]) {
          try { pipe.destroy(); } catch { /* 已经拆了 */ }
        }
      } finally { clearTimeout(hard); }
    })();
    return this.#closing;
  }
}

export function spawnAcpAgent(agent: AcpAgentSettings, cwd: string, options?: AcpChildOptions): AcpChild {
  return new AcpChild(agent.command, buildAcpArgv(agent), cwd, options);
}
