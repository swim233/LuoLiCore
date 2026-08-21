import { existsSync, realpathSync, statSync } from 'node:fs';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError, type ClientCapabilities, type ClientConnection, type ClientContext, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type StopReason } from '@agentclientprotocol/sdk';
import { elideMiddleBytes } from '@luoli/shared';
import { resolveHarnessDir } from '../agent/harness.js';
import { KeyedMutex } from '../turn/keyed-mutex.js';
import { acpFailure, type AcpErrorCode, type AcpFailure } from './errors.js';
import { AcpChild, spawnAcpAgent } from './process.js';
import { resolveAcpAgent, type AcpAgentSettings, type AcpPermissionMode, type AcpSettings } from './schema.js';
import { AcpUpdateSink, runAcpPrompt } from './session.js';
import type { LogSink } from '../log/sink.js';

/**
 * M13 · ACP 客户端的连接与进程生命周期。形状照 `mcp/manager.ts` 抄（那是全仓唯一另一个 stdio
 * JSON-RPC 客户端，坑都在里面）：`#children` / `#closing` / `#intentional` 三件套、握手超时后
 * **当场**收掉连接与子进程、stderr 逐行进 `LogSink`。
 *
 * 两处刻意不同：
 *
 * - **不缓存连接、不落库 `sessionId`。** 作用域 = 一次工具调用，一次调用 spawn 一次（严格不比
 *   今天的 `spawn_harness` 差 —— 它也是每次 spawn）。理由**不是**「落库会引入进程内状态假设」
 *   （那个说法是反的：`sessionId` 是指向外部存储的句柄，与 `sandbox_containers.container_id`
 *   同型，落库是合规形态）。真正的理由是：**持久化 `sessionId` 会把第三道门从「一次审批」偷偷
 *   改成「一次审批，此后永久」** —— 一条 `session/load` 带着当初被批过的 `cwd` 重新进那个目录，
 *   而这一次没有任何人点头。`fork` / `resume` 同理。所以本版不做追问，也没有 `acp_follow_up`。
 * - **不 unref 子进程。** unref 是把「进程退不出去」换成「退出时把一个正在改文件的 agent 连账都
 *   不记地丢掉」。正确答案是 `#children` + `close()`，并在 `apps/bot/src/main.ts` 的 `shutdown()`
 *   里紧挨着 `await mcp.close()` 等它。
 */

/**
 * `initialize` 里申报的客户端能力。**这一轮是空的，而空是有意义的** ——
 * ACP 明文规定：字段省略 == UNSUPPORTED。谎报一个我们不会答的 method 会让 agent 发出请求之后
 * 挂在那里等，而它正握着一个半改完的文件。
 *
 * 所以这一轮**不申报 `fs` 也不申报 `terminal`**：omp 会退回自己直接读写磁盘（它本来就是本机
 * CLI），我们照旧拿得到产出。波 3 接反向 fs / terminal 时，这个常量与对应的 handler
 * **必须同一个提交**落地 —— 先申报后实现的那一版，中间每一次 `fs/read_text_file` 都是一次挂死。
 */
export const ACP_CLIENT_CAPABILITIES: ClientCapabilities = {};

/**
 * 波 3 的接入点。**契约在这里，实现不在** —— 呈现层卡片与逐条审批各自按这份签名实现，互不阻塞。
 *
 * - `onUpdate`：每条 `session/update` 原样过一遍（呈现层）。**被 `maxUpdatesPerPrompt` 丢弃的
 *   那些不会给它** —— 上界的意义就是「后面这些我们不处理」，绕过上界喂给呈现层等于没有上界。
 * - `requestPermission`：接真审批（波 3）。给了它就完全接管，`floorPermission` 不再参与；
 *   没给就走地板。`signal` 在本次请求被取消 / 连接关闭时 abort。
 */
export interface AcpClientHooks {
  onUpdate?(notification: SessionNotification): void;
  requestPermission?(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

type PermissionKind = RequestPermissionRequest['options'][number]['kind'];

/**
 * ⚠️ **这是本轮的临时地板，它看着像一个洞，因为它就是。** `permissionMode` 为 `ask` 时这里
 * 自动选第一个 allow 档 —— 也就是「agent 问我们准不准，我们说准」。
 *
 * 为什么不 fail-closed 到拒绝：`spawn_acp` 的三道门（owner + 仅私聊 + 目录白名单 + 一次审批）
 * 已经在「起不起这个 agent」那一层拦过了，与 `spawn_harness` 同一条口径 ——
 * **批准一次 = 批准它这一趟在那个目录里做的全部事情**（`docs/14` T17，「不要以为里面还有第四道门」）。
 * 在没有真审批通道的这一轮把每次 permission 都拒掉，得到的是一个能读不能写的半残 agent，
 * 而门的位置一点没变。
 *
 * `deny` 与 `auto` 是**真的**接上的：前者选第一个 reject 档，后者选 allow。`ask` 这一档的真实
 * 行为要等波 3（走 `hooks.requestPermission` → `PendingPrompts`，`docs/05 §6.1`）；在那之前它
 * 每次都记一条 warn，好让「我配的是 ask 但它没问我」在日志里有一行。
 */
export function floorPermission(request: RequestPermissionRequest, mode: AcpPermissionMode): { response: RequestPermissionResponse; floored: boolean } {
  const pick = (...kinds: PermissionKind[]): string | null =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find((id) => id !== undefined) ?? null;
  if (mode === 'deny') {
    const rejected = pick('reject_once', 'reject_always');
    // 一个 reject 档都没给的 agent：按协议回 cancelled（唯一不需要 optionId 的合法出口），
    // 而不是硬挑一个 allow —— `deny` 的语义不能因为对方没提供选项就翻过来。
    return { response: rejected ? { outcome: { outcome: 'selected', optionId: rejected } } : { outcome: { outcome: 'cancelled' } }, floored: false };
  }
  const allowed = pick('allow_once', 'allow_always');
  return { response: allowed ? { outcome: { outcome: 'selected', optionId: allowed } } : { outcome: { outcome: 'cancelled' } }, floored: mode === 'ask' };
}

export interface AcpRunInput { task: string; dir: string; agent?: string }
export interface AcpTrace { traceId?: string; chatId?: string; userId?: string; key?: string }

export interface AcpRunOptions {
  abortSignal: AbortSignal;
  /**
   * 整个结果对象序列化之后的字节上界。**必须就是 `ToolRegistry.#normalizeOutput` 量的那一个**
   * （`main.ts` 把它接成 `tools.exec.maxOutputBytes`）—— 我们先量固定字段、把剩下的给
   * `output`，所以那道中间截断永不触发；给一个不相干的数字只会让这个保证悄悄失效。
   */
  outputBudgetBytes: number;
  hooks?: AcpClientHooks;
  trace?: AcpTrace;
  /**
   * 目录互斥的等待上界，缺省 `ACP_DIR_WAIT_MS`。**只有用例会传** —— 生产的调用方不传，
   * 好让这个上界只有一处定义（工具壳里给一个数就等于第二份默认值，两份迟早不一致）。
   */
  dirWaitMs?: number;
}

/**
 * 交回给模型的结果。**按构造有界**，让 `#normalizeOutput` 的中间截断永不触发；
 * **字段顺序有意义** —— 长字段排最后，万一还是截了，`ok` / `error` / `stopReason` 与几个计数
 * 都在头部活着（`elideMiddleBytes` 留头留尾）。
 */
export interface AcpRunResult {
  ok: boolean;
  error?: AcpErrorCode;
  hint?: string;
  detail?: string;
  agent?: string;
  dir?: string;
  stopReason?: StopReason;
  updates?: number;
  updatesDropped?: number;
  toolCalls?: number;
  thoughts?: number;
  costUsd?: number;
  contextUsed?: number;
  ms?: number;
  truncated?: boolean;
  output?: string;
  stderr?: string;
}

/** 目录互斥的等待上界。够长到能骗过一次短调用，够短到第二个调用还能拿到一个可操作的答复。 */
export const ACP_DIR_WAIT_MS = 30_000;
/** `session/close` 的上界。它只是礼貌收尾，等不到就走关停梯 —— 不该拖住一次工具调用。 */
const CLOSE_TIMEOUT_MS = 3000;
/** `,"truncated":true,"output":""` 这几个键名占的字节。固定字段的长度是量出来的，不在这里估。 */
const RESULT_KEY_OVERHEAD = 48;
/** 失败时附上的 stderr 尾巴。够看一句报错，不够跟正文抢预算。 */
const STDERR_TAIL_BYTES = 1024;
/** `clipToJsonBudget` 的收敛下限（它自己的 `Math.max(64, …)`）。低于这个预算就别裁了，整段丢。 */
const CLIP_FLOOR_BYTES = 64;
/** JSON-RPC 的 `auth_required`（SDK 的 `RequestError.authRequired`）。 */
const AUTH_REQUIRED_CODE = -32000;

const elision = (omitted: number): string => `\n…省略 ${omitted} bytes…\n`;

/**
 * 按**序列化之后**的字节数裁。`#normalizeOutput` 量的是 `JSON.stringify(rest)`，而换行、引号、
 * 控制字符在 JSON 里都要转义 —— 按原文字节裁出来的「刚好 65536」序列化之后就超了。
 *
 * 按实测比例收，最多三轮：每轮预算按 `budget/encoded < 1` 的比例缩一次，收敛有保证。
 */
export function clipToJsonBudget(text: string, budget: number): { value: string; truncated: boolean } {
  let clip = elideMiddleBytes(text, budget, elision);
  for (let round = 0; round < 3; round += 1) {
    const encoded = Buffer.byteLength(JSON.stringify(clip.value)) - 2;
    if (encoded <= budget) break;
    const next = elideMiddleBytes(clip.value, Math.max(64, Math.floor((budget * budget) / encoded)), elision);
    clip = { value: next.value, truncated: true };
  }
  return clip;
}

/**
 * 超时（或本轮被取消）后拒绝，但不取消底层操作 —— 调用方随即把连接与子进程一起收掉，不留孤儿。
 *
 * **`abortSignal` 是必须认的**：握手要走四跳（initialize / session/new / authenticate /
 * set_config_option），各自最长 `handshakeTimeoutMs`，默认合起来两分钟。不认取消的话
 * `/cancel` 之后用户还要等这两分钟，然后 agent 才**开始**改文件。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, abortSignal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AcpTimedOut(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
      if (!abortSignal) return;
      if (abortSignal.aborted) { reject(new AcpAborted(label)); return; }
      onAbort = () => reject(new AcpAborted(label));
      abortSignal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
  }
}

class AcpTimedOut extends Error {}
class AcpAborted extends Error {}
/** 带着一份已经分好档的失败穿过握手那几层。**没有副作用** —— 清理统一在 `#open` 的 catch 里。 */
class AcpFailureError extends Error {
  constructor(readonly failure: AcpFailure) { super(failure.error); }
}

interface OpenSession { child: AcpChild; connection: ClientConnection; cx: ClientContext; sessionId: string; closable: boolean }
type OpenOutcome = { ok: true; session: OpenSession } | { ok: false; failure: AcpFailure; child: AcpChild | null };

export class AcpManager {
  /**
   * 所有起过、还没关完的子进程。`close()` 关它而不是只关「当前那一条」：握手超时被丢掉的、
   * prompt 中途失败的、竞态泄漏的都在这里，而漏掉一条就是漏掉一个 refed 的子进程 ——
   * `shutdown()` 只设 `process.exitCode`，event loop 不空进程就是不退（docs/28 · L-EXT-03）。
   */
  readonly #children = new Set<AcpChild>();
  /** 每条子进程对应的那个连接。`close()` 要拿得到它 —— 只杀进程而不先关连接的话，SDK 那侧还在
   *  等一个不会来的答复（顺序反了的表现见 `#discard` 的注释）。 */
  readonly #connections = new WeakMap<AcpChild, ClientConnection>();
  /** 正在关的那些。`close()` 必须等这些 promise，不能只是再调一次 `child.close()`。 */
  readonly #closing = new Set<Promise<void>>();
  /** 我们主动关的。`onExit` 靠它区分「一次调用正常收尾」与「子进程自己死了」，后者才值得告警。 */
  readonly #intentional = new WeakSet<AcpChild>();
  /**
   * 目录互斥。**只有一个键空间**（`dir:<realpath>`）—— 这里不像 `McpManager` 那样有嵌套持锁
   * （`reconcile` → `connect`），所以不需要第二个键空间去躲自等。
   */
  readonly #mutex = new KeyedMutex();

  constructor(private readonly log: LogSink) {}

  /**
   * 跑一次 ACP 任务。三道门的第二道（目录）在这里判第二遍 —— `available()` 判过一次，
   * 热更新可能在注册与执行之间把名单清空（同 `spawn_harness` 的做法）。
   */
  async run(input: AcpRunInput, settings: AcpSettings, options: AcpRunOptions): Promise<AcpRunResult> {
    if (!settings.enabled || !settings.allowedDirs.length) return acpFailure('acp_disabled');
    const agent = resolveAcpAgent(settings, input.agent);
    if (!agent) return settings.agents.some((entry) => entry.enabled) ? acpFailure('acp_agent_unknown', input.agent ?? settings.defaultAgent) : acpFailure('acp_no_agents');
    const resolved = resolveHarnessDir(input.dir, settings.allowedDirs);
    if (!resolved) return { ...acpFailure('acp_dir_not_allowed', settings.allowedDirs.join(' · ')), agent: agent.name };
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ...acpFailure('acp_dir_missing'), agent: agent.name, dir: resolved };
    // 互斥键按 realpath：两个符号链接指向同一个仓库时，按请求路径加锁等于没加。
    // 解不开就用 resolve 后那份（目录刚被删这类情况，下一步的 spawn 会如实失败）。
    let key = resolved;
    try { key = realpathSync(resolved); } catch { /* 用 resolved */ }
    const release = await this.#acquireDir(key, options.abortSignal, options.dirWaitMs ?? ACP_DIR_WAIT_MS);
    if (!release) return { ...acpFailure(options.abortSignal.aborted ? 'acp_cancelled' : 'acp_dir_busy'), agent: agent.name, dir: resolved };
    try { return await this.#run(agent, resolved, input.task, settings, options); }
    finally { release(); }
  }

  async #run(agent: AcpAgentSettings, dir: string, task: string, settings: AcpSettings, options: AcpRunOptions): Promise<AcpRunResult> {
    const started = performance.now();
    // 聚合期的上界只跟 `agents[].maxOutputBytes` 有关：2× 是为了让末尾那次从中间截断能保住头尾
    // （同 `runHarness`）。真正交回去多少由下面**量出来**的预算定 —— 那时才知道 hint / detail /
    // stderr 各占了多少。
    const sink = new AcpUpdateSink({ maxUpdates: settings.maxUpdatesPerPrompt, maxTextBytes: agent.maxOutputBytes * 2, maxCostUsd: settings.maxCostUsd,
      ...(options.hooks?.onUpdate ? { onUpdate: options.hooks.onUpdate } : {}) });
    const opened = await this.#open(agent, dir, settings, sink, options);
    const child = opened.ok ? opened.session.child : opened.child;
    let failure: AcpFailure | null = opened.ok ? null : opened.failure;
    let stopReason: StopReason | undefined;
    if (opened.ok) {
      try {
        const outcome = await runAcpPrompt(opened.session.cx, { agent, sessionId: opened.session.sessionId, task, sink,
          abortSignal: options.abortSignal, closed: opened.session.connection.closed });
        stopReason = outcome.stopReason ?? undefined;
        failure = outcome.failure;
      } catch (error) { failure = acpFailure('acp_prompt_failed', error); }
      finally { await this.#closeSession(opened.session); }
    }
    // 单行越界压过一切：连接是因此断的，而「断开」本身分不出原因（`acp_connection_lost` 会把
    // 这件事说成 agent 自己死了，运维照那句话去查退出码，什么也查不到）。
    if (child?.overflowed()) failure = acpFailure('acp_line_too_long');
    else if (failure?.error === 'acp_connection_lost' && child) {
      const exit = child.exitStatus();
      failure = acpFailure('acp_connection_lost', `exit=${exit?.code ?? 'null'} signal=${exit?.signal ?? 'null'}`);
    }
    /**
     * 除 `output` 之外的全部字段。**先把它序列化量一遍，剩下的才是 `output` 的预算** ——
     * 上界因此不依赖对 hint / detail / stderr / dir 长度的估计：中文 hint + 中文 detail + 一段
     * 全是引号的 stderr 实测能占 5.2 KB，而按固定余量估出来的那个数字曾经是 4 KB，于是
     * `#normalizeOutput` 的中间截断在失败路径上真的会触发（正是这里最不该被截的那一路）。
     *
     * `output` 排最后是第二道保险：万一还是截了，`elideMiddleBytes` 留头留尾，`ok` / `error` /
     * `hint` / `stopReason` 与几个计数都在头部活着。
     */
    const head = {
      ok: failure === null,
      ...(failure ? { error: failure.error, hint: failure.hint, ...(failure.detail ? { detail: failure.detail } : {}) } : {}),
      agent: agent.name, dir,
      ...(stopReason ? { stopReason } : {}),
      updates: sink.updates, updatesDropped: sink.dropped, toolCalls: sink.toolCalls, thoughts: sink.thoughts,
      ...(sink.costUsd === null ? {} : { costUsd: sink.costUsd }),
      ...(sink.contextUsed === null ? {} : { contextUsed: sink.contextUsed }),
      ms: Math.round(performance.now() - started),
      // stderr 只在失败时附上：成功那一路它是噪声（omp 把 console.* 全重定向到 stderr），
      // 而失败时它常常是唯一说得出原因的东西。
      ...(failure && child?.stderrTail() ? { stderr: elideMiddleBytes(child!.stderrTail(), STDERR_TAIL_BYTES, elision).value } : {}),
    };
    // `,"truncated":true,"output":""` 那几个键名本身也要算进去。
    const budget = Math.min(agent.maxOutputBytes, options.outputBudgetBytes - Buffer.byteLength(JSON.stringify(head)) - RESULT_KEY_OVERHEAD);
    // 预算小到装不下省略说明本身时**整段丢掉**，不留一截。`elideMiddleBytes` 交回的是
    // 「头 1 字节 + 省略说明 + 尾 1 字节」，而那句说明二十来字节，`clipToJsonBudget` 的收敛下限
    // 又是 64 —— 门槛写 0 的话，`0 < budget < 64` 这一档交回的东西比预算还长，「上界」在最紧的
    // 地方反而被它顶破。（撞得到这里的只有荒唐的 `tools.exec.maxOutputBytes`，但上界得是上界。）
    const clipped = budget > CLIP_FLOOR_BYTES ? clipToJsonBudget(sink.text(), budget) : { value: '', truncated: sink.text().length > 0 };
    const result: AcpRunResult = { ...head,
      ...(clipped.truncated || sink.textTruncated() || clipped.value.length < sink.text().length ? { truncated: true } : {}),
      output: clipped.value };
    this.log.event({ level: result.ok ? 'info' : 'warn', kind: 'acp.run', summary: `acp ${result.ok ? 'ok' : failure!.error} · ${agent.name} · ${dir}`,
      ...this.#trace(options.trace),
      data: { agent: agent.name, dir, command: agent.command, approvalMode: agent.approvalMode, stopReason: stopReason ?? null,
        error: failure?.error ?? null, updates: sink.updates, dropped: sink.dropped, toolCalls: sink.toolCalls,
        costUsd: sink.costUsd, ms: result.ms } });
    return result;
  }

  #trace(trace?: AcpTrace): { traceId?: string; chatId?: string; userId?: string; key?: string } {
    return { ...(trace?.traceId ? { traceId: trace.traceId } : {}), ...(trace?.chatId ? { chatId: trace.chatId } : {}),
      ...(trace?.userId ? { userId: trace.userId } : {}), ...(trace?.key ? { key: trace.key } : {}) };
  }

  /** spawn → 连接 → initialize（含版本协商与 authenticate 那一支）→ `session/new` → 会话模式。 */
  async #open(agent: AcpAgentSettings, dir: string, settings: AcpSettings, sink: AcpUpdateSink, options: AcpRunOptions): Promise<OpenOutcome> {
    // `spawn()` 绝大多数失败是异步的（ENOENT 走 'error' 事件，靠 `child.spawned` 分档），但**参数
    // 本身不合法时它同步抛** —— `command` 里一个 NUL 字节就够。让那一路也落进错误契约，而不是
    // 抛出去变成 `execute()` catch 里那句裸的 `error.message`。
    let child: AcpChild;
    try { child = spawnAcpAgent(agent, dir, {
      // 逐行而不是整块：一条 500 KB 的栈会把日志行撑爆，而 `LogSink` 的载荷要落盘。
      onStderrLine: (line) => this.log.event({ level: 'warn', kind: 'acp.stderr', summary: `${agent.name}: ${line.slice(0, 2000)}`,
        ...this.#trace(options.trace), data: { agent: agent.name } }),
      onExit: (exit) => {
        if (this.#intentional.has(child)) return;
        this.log.event({ level: 'warn', kind: 'acp.disconnect', summary: `${agent.name} 子进程自己退了（exit=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}）`,
          ...this.#trace(options.trace), data: { agent: agent.name, exitCode: exit.code, signal: exit.signal } });
      },
    }); } catch (error) { return { ok: false, failure: acpFailure('acp_spawn_failed', error), child: null }; }
    this.#children.add(child);
    let connection: ClientConnection | undefined;
    try {
      try { await withTimeout(child.spawned, agent.handshakeTimeoutMs, `${agent.name} spawn`, options.abortSignal); }
      // 超时与取消**不**归到 `acp_spawn_failed`：那句 hint 让运维去查「装没装、拼没拼错」，
      // 而这两档跟可执行文件在不在毫无关系。让它们照原样穿到下面那个 catch 去分档。
      catch (error) { throw error instanceof AcpTimedOut || error instanceof AcpAborted ? error : new AcpFailureError(acpFailure('acp_spawn_failed', error)); }
      connection = client({ name: 'luolicore' })
        .onNotification('session/update', ({ params }) => { sink.accept(params); })
        .onRequest('session/request_permission', async (ctx) => {
          if (options.hooks?.requestPermission) return await options.hooks.requestPermission(ctx.params, ctx.signal);
          const { response, floored } = floorPermission(ctx.params, settings.permissionMode);
          this.log.event({ level: floored ? 'warn' : 'info', kind: 'acp.permission',
            summary: `${agent.name} 请求权限（${ctx.params.toolCall.kind ?? 'other'}）→ ${floored ? 'ask 档本轮暂按放行' : settings.permissionMode}`,
            ...this.#trace(options.trace),
            data: { agent: agent.name, mode: settings.permissionMode, floored, kind: ctx.params.toolCall.kind ?? null,
              title: ctx.params.toolCall.title ?? null, outcome: response.outcome.outcome } });
          return response;
        })
        // 没申报能力就不该被调，不守规矩的那些照旧要拿到一个干净的 `methodNotFound`。
        // **注意这七行不是那个保证的来源**：SDK 的 `Connection.processIncomingMessage` 对任何
        // 没人认领的 request 已经自己回 `methodNotFound` 了（还有五个 client 方法我们连名字都没写，
        // 走的正是那条默认路）。写出来只为一件事：让波 3 有一个显眼的落点，且**换掉它们的那个提交
        // 必须同时改 `ACP_CLIENT_CAPABILITIES`** —— 先申报后实现的中间态，每一次 `fs/read_text_file`
        // 都是一次挂死。
        .onRequest('fs/read_text_file', () => { throw RequestError.methodNotFound('fs/read_text_file'); })
        .onRequest('fs/write_text_file', () => { throw RequestError.methodNotFound('fs/write_text_file'); })
        .onRequest('terminal/create', () => { throw RequestError.methodNotFound('terminal/create'); })
        .onRequest('terminal/output', () => { throw RequestError.methodNotFound('terminal/output'); })
        .onRequest('terminal/wait_for_exit', () => { throw RequestError.methodNotFound('terminal/wait_for_exit'); })
        .onRequest('terminal/kill', () => { throw RequestError.methodNotFound('terminal/kill'); })
        .onRequest('terminal/release', () => { throw RequestError.methodNotFound('terminal/release'); })
        .connect(ndJsonStream(child.stdin, child.stdout));
      this.#connections.set(child, connection);
      const cx = connection.agent;
      const init = await withTimeout(cx.request('initialize', { protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES, clientInfo: { name: 'luolicore', version: '0.1.0' } }), agent.handshakeTimeoutMs, `${agent.name} initialize`, options.abortSignal);
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpFailureError(acpFailure('acp_protocol_unsupported', `agent 谈出 v${init.protocolVersion}，本客户端只支持 v${PROTOCOL_VERSION}`));
      }
      // MCP server **不透传**：那些 server 是以本进程的身份配起来的，交给另一个 agent 驱动等于
      // 把它们的能力借给一套不受 `TOOL_POLICY` 约束的工具集（`docs/14` T17 的同一条道理）。
      const newSession = (): Promise<{ sessionId: string }> => withTimeout(cx.request('session/new', { cwd: dir, mcpServers: [] }), agent.handshakeTimeoutMs, `${agent.name} session/new`, options.abortSignal);
      let sessionId: string;
      try { sessionId = (await newSession()).sessionId; }
      catch (error) {
        const methods = init.authMethods ?? [];
        // 只拿它已有的本机凭据试一次。要浏览器授权那一类**不在这里做** —— 那件事在带外做
        // （照 `docs/07 §4.5` 对 stdio MCP server 的先例），我们能做的是如实说要登录。
        if (!(error instanceof RequestError) || error.code !== AUTH_REQUIRED_CODE || !methods.length) throw error;
        try {
          await withTimeout(cx.request('authenticate', { methodId: (methods[0] as { id: string }).id }), agent.handshakeTimeoutMs, `${agent.name} authenticate`, options.abortSignal);
          sessionId = (await newSession()).sessionId;
        } catch (retry) { throw new AcpFailureError(acpFailure('acp_auth_required', retry)); }
      }
      // 会话模式（default / plan）**只能走这条路**，argv 上的 `--mode` 是输出格式。
      // 失败必须硬失败：运维要的是 plan（只读规划），静默退回 default 等于让它真的去改文件。
      if (agent.mode) {
        try { await withTimeout(cx.request('session/set_config_option', { sessionId, configId: 'mode', value: agent.mode }), agent.handshakeTimeoutMs, `${agent.name} set_config_option`, options.abortSignal); }
        catch (error) { throw error instanceof AcpAborted ? error : new AcpFailureError(acpFailure('acp_session_failed', error)); }
      }
      return { ok: true, session: { child, connection, cx, sessionId, closable: Boolean(init.agentCapabilities?.sessionCapabilities?.close) } };
    } catch (error) {
      // 握手失败的那一条**当场**收掉（连接 + 进程），不留「起得来但握不上手」的孤儿。
      // 不 await：关停梯要走 SIGTERM → 5s → SIGKILL，而 `#closing` 已经替 `close()` 记着它了。
      void this.#discard(child, connection);
      const failure = error instanceof AcpFailureError ? error.failure
        : error instanceof AcpAborted ? acpFailure('acp_cancelled')
        : error instanceof AcpTimedOut ? acpFailure('acp_handshake_timeout', error.message)
        : acpFailure('acp_handshake_failed', error);
      return { ok: false, failure, child };
    }
  }

  /** `session/close` 是礼貌收尾（best-effort、短超时），之后才走连接与进程的关停梯。 */
  async #closeSession(opened: OpenSession): Promise<void> {
    // 只在对方申报了 `sessionCapabilities.close` 时才发：没申报的 method 不该被调，
    // 这条纪律与我们自己那七个 `methodNotFound` 是同一条（申报什么就答什么）。
    if (opened.closable) {
      try { await withTimeout(opened.cx.request('session/close', { sessionId: opened.sessionId }), CLOSE_TIMEOUT_MS, 'session/close'); }
      catch { /* 它已经死了、或者不肯答 —— 下面那一步照旧把进程收掉 */ }
    }
    await this.#discard(opened.child, opened.connection);
  }

  /**
   * 关一条：先关连接（`session/prompt` 之类的在途请求会被 SDK 拒掉），再走进程的关停梯。
   * 顺序反过来的话，子进程已经没了而 SDK 还在等它答复。
   */
  #discard(child: AcpChild, connection?: ClientConnection): Promise<void> {
    this.#intentional.add(child);
    const done = (async () => {
      try { connection?.close(); } catch { /* 已经关了 */ }
      try { await child.close(); } catch { /* 关不掉的（已经消失）照旧要从账上摘掉 */ }
      finally { this.#children.delete(child); }
    })();
    this.#closing.add(done);
    void done.finally(() => this.#closing.delete(done));
    return done;
  }

  /**
   * 目录互斥的加锁。等待**有界且可取消**：外层工具是 `timeoutMs: null`，让第二个调用干等
   * 十五分钟等于把「并发保护」变成「并发阻塞」。
   *
   * 放弃等待的那一侧**不退出队列** —— `KeyedMutex` 把 tail 挂上之后就必须被 release，半路撒手
   * 会让这个键在进程生命周期内永远堵住。所以它照旧排到队首，然后立刻把锁还回去。
   */
  async #acquireDir(key: string, abortSignal: AbortSignal, waitMs: number): Promise<(() => void) | null> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const granted = Promise.withResolvers<void>();
    const gaveUp = Promise.withResolvers<void>();
    const onAbort = (): void => gaveUp.resolve();
    void this.#mutex.run(`dir:${key}`, () => { granted.resolve(); return held; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (abortSignal.aborted) gaveUp.resolve();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => gaveUp.resolve(), waitMs);
      timer.unref?.();
      if (await Promise.race([granted.promise.then(() => true), gaveUp.promise.then(() => false)])) return release;
      void granted.promise.then(() => release());
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    for (const child of [...this.#children]) void this.#discard(child, this.#connections.get(child));
    await Promise.all([...this.#closing]);
  }
}
