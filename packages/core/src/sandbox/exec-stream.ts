import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { elideMiddleBytes } from '@luoli/shared';

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
  /** 交给模型的一句旁白，与失败无关。现在只有一个来源：持久容器刚被回收、这一次是新建的
   *  （docs/06 §1）—— 不说的话模型只会发现自己起的后台进程凭空消失了。 */
  note?: string;
}

/** 按字节算预算、按字符边界切，且结果真的不超过 `max`（docs/27 · T-04：此前那个按比例估的
 *  码点数会算出一个超预算的结果）。与工具输出归一化共用同一份实现。 */
export function clipped(buffer: string, max: number): { value: string; truncated: boolean } {
  return elideMiddleBytes(buffer, max, (omitted) => `\n…省略 ${omitted} bytes…\n`);
}

export interface CollectOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal: AbortSignal;
  /**
   * 超时 / 取消 / 输出超限三条路共用它，**由调用方决定杀什么** —— 这正是一次性容器与持久
   * 容器唯一真正分岔的地方：前者 `docker kill <容器>`，后者必须打容器里那个进程组，
   * 因为杀掉容器等于销毁整个会话的环境（docs/05 §5.5）。
   */
  kill: () => void;
}

/**
 * 一次子进程执行的采集：输出上限、超时、取消、OOM 判定。
 *
 * 抽出来是因为**持久容器与一次性容器只在 argv 与 kill 上不同**，其余每一条都是同一套规则；
 * 各写一份的后果是两边慢慢漂开，而 `L-TOOL-01`（`ok` 的判据）这类坑要重新踩一遍。
 */
export async function collectProcess(child: ChildProcessByStdio<null, Readable, Readable>, options: CollectOptions): Promise<SandboxResult> {
  const started = performance.now();
  const cap = options.maxOutputBytes;
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
    options.kill();
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
  const timer = setTimeout(kill, options.timeoutMs);
  options.abortSignal.addEventListener('abort', kill, { once: true });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  options.abortSignal.removeEventListener('abort', kill);
  stdout += stdoutDecoder.end();
  stderr += stderrDecoder.end();
  const out = clipped(stdout, cap);
  const err = clipped(stderr, cap);
  const oom = exitCode === 137 || /out of memory|oom/i.test(stderr);
  // `ok` 只看退出码。`truncatedByCap` 同一行就 `kill()` 了子进程，退出码本来就不是 0 ——
  // 那个 `&& !truncatedByCap` 唯一还起作用的场合恰好是 bug：子进程已自己退出 0、最后一批
  // >2×cap 的输出在 `close` 之前才 flush 完，`kill()` 打空，于是一次**成功**调用被记成失败，
  // 连着三次就把 bash 停掉一整轮（docs/28 · L-TOOL-01）。
  return { ok: exitCode === 0, exitCode, stdout: out.value, stderr: err.value,
    truncated: truncatedByCap || out.truncated || err.truncated, durationMs: Math.round(performance.now() - started), killed, oom,
    ...(truncatedByCap ? { hint: `输出超过 ${cap * 2} 字节（tools.exec.maxOutputBytes 的两倍）后子进程已被 SIGKILL，交回的只有头尾各半 —— 命令可能没跑完。把输出收窄再来（重定向到文件后分段 read_file、用 grep/head 过滤、只打印统计），别原样重试。` } : {}) };
}
