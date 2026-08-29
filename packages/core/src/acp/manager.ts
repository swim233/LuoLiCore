import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError, type ClientCapabilities, type ClientConnection, type ClientContext, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type StopReason } from '@agentclientprotocol/sdk';
import { elideMiddleBytes } from '@luoli/shared';
import { resolveHarnessDir } from '../agent/harness.js';
import { FileTools } from '../tools/files.js';
import { PathJail } from '../tools/jail.js';
import { KeyedMutex } from '../turn/keyed-mutex.js';
import { acpFailure, type AcpErrorCode, type AcpFailure } from './errors.js';
import { AcpFs } from './fs.js';
import { AcpChild, spawnAcpAgent } from './process.js';
import { resolveAcpAgent, type AcpAgentSettings, type AcpPermissionMode, type AcpSettings } from './schema.js';
import type { AcpRunLedger } from './runs.js';
import { AcpUpdateSink, runAcpPrompt } from './session.js';
import { AcpTerminals } from './terminals.js';
import type { LogSink } from '../log/sink.js';

/**
 * M13 · ACP 客户端的连接与进程生命周期。形状沿用 `mcp/manager.ts`（全仓唯一另一个 stdio
 * JSON-RPC 客户端，已知问题都集中在那里）：`#children` / `#closing` / `#intentional` 三件套、
 * 握手超时后立即回收连接与子进程、stderr 逐行写入 `LogSink`。
 *
 * 两处刻意不同：
 *
 * - 不缓存连接、不持久化 `sessionId`。作用域为一次工具调用，每次调用 spawn 一次（不劣于现有的
 *   `spawn_harness`，它同样每次 spawn）。理由不是持久化会引入进程内状态假设（该说法不成立：
 *   `sessionId` 是指向外部存储的句柄，与 `sandbox_containers.container_id` 同型，持久化是合规
 *   形态）。真正的理由是持久化 `sessionId` 会把第三道门从一次审批变为一次审批后永久有效 ——
 *   一条 `session/load` 带着当初被批准的 `cwd` 重新进入该目录，而本次无人审批。`fork` / `resume`
 *   同理。因此本版不做追问，也没有 `acp_follow_up`。
 * - 不 unref 子进程。unref 是用进程无法退出换取退出时丢弃一个正在修改文件的 agent 且不留记录。
 *   正确做法是 `#children` + `close()`，并在 `apps/bot/src/main.ts` 的 `shutdown()` 中紧接
 *   `await mcp.close()` 等待它。
 */

/**
 * `initialize` 中申报的客户端能力。按本次调用实时计算，而非常量 —— ACP 明确规定字段省略即
 * UNSUPPORTED，而虚报一个我们不会响应的 method 会使 agent 发出请求后一直等待，此刻它正持有一个
 * 修改到一半的文件。
 *
 * 因此两项都在能力确实就绪后才置位：`fs` 需要一个可成功构造的 jail（root = `realpathSync(dir)`），
 * `terminal` 还需额外满足 `sandbox.plan(role, root).mode === 'host'`。不满足则不申报 —— 而不是
 * 申报后让 agent 每次 create 都失败（它会反复尝试，且每次失败都会自行编造一段解释）。
 */
export function acpClientCapabilities(enabled: { fs: boolean; terminal: boolean }): ClientCapabilities {
  return { ...(enabled.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}), ...(enabled.terminal ? { terminal: true } : {}) };
}

/**
 * 逐条审批的处理器需等 manager 解析完成后才能构造：jail 的 root 必须是 `realpathSync(dir)`
 * （与 `session/new` 的 `cwd` 为同一字面量），而 agent 名字要等 `resolveAcpAgent` 选定。
 * 因此 `AcpClientHooks.permission` 接收的是工厂而非处理器。
 */
export interface AcpPermissionBinding {
  /** 本次会话的 jail。仅用于判定路径是否在边界内、是否命中 denyGlobs，不做读写。 */
  jail: PathJail;
  agent: string;
  /**
   * 结论无法表达时调用它（agent 未提供任何能表达我方答案的选项）—— 实现为 `session/cancel`
   * 加 `acp_permission_unanswerable`。不能用 `{outcome:'cancelled'}` 搪塞：该词在协议中表示
   * client 取消了这一轮，把人工拒绝表述为用户取消会使 agent 对这一轮的记录失真。
   */
  onUnanswerable(): void;
}

/**
 * 反向调用与呈现层的接入点。
 *
 * - `onUpdate`：每条 `session/update` 原样透传（呈现层）。被 `maxUpdatesPerPrompt` 丢弃的不会
 *   传入 —— 上界的含义即后续内容不再处理，绕过上界喂给呈现层等于上界失效。
 * - `permission`：逐条审批（`docs/05 §3.5.3`）。仅在 `permissionMode === 'ask'` 档位被调用，
 *   一旦给出处理器即完全接管，`floorPermission` 不再参与 —— 两者串联会使谁先应答变成必须读代码
 *   才能确定的问题。`signal` 在本次请求被取消或连接关闭时 abort，实现方必须 settle。
 */
export interface AcpClientHooks {
  onUpdate?(notification: SessionNotification): void;
  permission?(binding: AcpPermissionBinding): (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
}

type PermissionKind = RequestPermissionRequest['options'][number]['kind'];

/**
 * 不询问用户的两档（`auto` / `deny`）如何应答。`auto` 是默认档，因此该函数属于出厂路径。
 *
 * `auto` 选第一个 allow 选项 —— 这是语义上诚实的一档：启动该 agent 本身已经过一次审批，
 * 批准一次即批准它本趟在该目录内的全部操作（`docs/14` T17，Q8-c 的原有语义）。
 * `deny` 选第一个 reject 选项；一个都未提供时按协议返回 `cancelled`（唯一不需要 optionId 的合法
 * 出口），而不是强行选一个 allow —— `deny` 的语义不能因对方未提供选项而反转。
 *
 * `ask` 不走此处，而走 `hooks.permission`（`acpPermissionGate`）。它落到本函数只有一种可能：
 * 运行时未接入审批通道，而 `spawn_acp.available()` 本应已将工具挡在目录之外
 * （`permissionMode === 'ask'` 且无 broker → 不进入目录，与 `allowedDirs` 为空同形态）。
 * 若确实到达此处则按 `deny` 处理 —— 名为 `ask` 的档位实际放行，正是 `docs/reviews/16 §5` 所述的
 * 伪造一道门。调用方据此将该情形记为 warn。
 */
export function floorPermission(request: RequestPermissionRequest, mode: AcpPermissionMode): RequestPermissionResponse {
  const pick = (...kinds: PermissionKind[]): string | null =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)?.optionId).find((id) => id !== undefined) ?? null;
  const chosen = mode === 'auto' ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } };
}

export interface AcpRunInput { task: string; dir: string; agent?: string }
export interface AcpTrace { traceId?: string; chatId?: string; userId?: string; key?: string }

/**
 * 反向调用面所需的宿主侧闸门。由调用方从本轮 `turn.config` 实时读取后传入，`AcpManager` 自身
 * 不持有配置（`docs/11` 的 `agent.acp` 整段处于热更新白名单，依赖的正是这条纪律）。
 *
 * 整段缺失即 fs 与 terminal 都不申报，退回 agent 直接访问磁盘的路径。分段用例以及任何手工构造
 * manager 的场景落在这一档，默认必须是不申报，而非申报一个未实现的能力。
 */
export interface AcpHostAccess {
  /**
   * jail 与 `FileTools` 的参数。不复用 `dependencies.filesFor(workspace, role)` —— 那份的 root 是
   * `data/workspace/<chatId>`（`docs/14 Q8-b` 明确规定不复用），且 `tools.fs.allowHostFsForOwner`
   * 一旦开启其 root 即变为 `/`：ACP 路径的边界必须是本次被批准的那个仓库目录，跟随全局开关等于
   * 把批准一个目录变成批准整台机器。
   */
  fs: { denyGlobs: readonly string[]; maxReadBytes: number; maxWriteBytes: number; backupDir: string };
  /** `tools.exec.maxTimeoutMs` / `tools.exec.maxOutputBytes`：终端的硬期限与单终端输出上界。 */
  exec: { maxTimeoutMs: number; maxOutputBytes: number };
  /**
   * `sandbox.plan(role, root)`。不是 `'host'` 时整个 terminal capability 都不申报 —— 申报后每次
   * create 都失败是最差形态：agent 会反复尝试，而每次得到的错误都无法据此改变行为。
   * fail-closed 落在申报那一刻。
   */
  plan(root: string): { mode: 'none' | 'host' | 'docker'; reason?: string };
}

export interface AcpRunOptions {
  abortSignal: AbortSignal;
  /**
   * 整个结果对象序列化后的字节上界。必须与 `ToolRegistry.#normalizeOutput` 所用的一致
   * （`main.ts` 将其接为 `tools.exec.maxOutputBytes`）—— 先量固定字段、余量分配给 `output`，
   * 因此那道中间截断永不触发；传入不相关的数值会使该保证静默失效。
   */
  outputBudgetBytes: number;
  hooks?: AcpClientHooks;
  host?: AcpHostAccess;
  trace?: AcpTrace;
  /**
   * 目录互斥的等待上界，默认 `ACP_DIR_WAIT_MS`。只有测试用例会传 —— 生产调用方不传，
   * 以保证该上界只有一处定义（在工具壳中给出数值即构成第二份默认值，两份终将不一致）。
   */
  dirWaitMs?: number;
}

/**
 * 返回给模型的结果。按构造即有界，使 `#normalizeOutput` 的中间截断永不触发；
 * 字段顺序有意义 —— 长字段排在最后，即使仍被截断，`ok` / `error` / `stopReason` 与几个计数
 * 仍位于头部（`elideMiddleBytes` 保留首尾）。
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
  /** 它自身工具调用中报告 `failed` 的条数，为 0 时不输出。执行完成与执行完成但半数步骤失败
   *  是两回事，而 `stopReason: 'end_turn'` 无法表达后者。 */
  failures?: number;
  thoughts?: number;
  /** 经 `fs/write_text_file` 修改过的不同文件数，为 0 时不输出 —— 在未写入任何内容的任务中，
   *  该数字的价值高于它占用的字节：模型据此判断 agent 是否只做了读取。 */
  filesWritten?: number;
  /** 启动过的终端数（`terminal/create`），为 0 时不输出。它是命令是否真正执行的唯一凭据。 */
  terminals?: number;
  costUsd?: number;
  contextUsed?: number;
  ms?: number;
  /**
   * 具备能力却未申报的原因，逐条以自然语言给出。这一份面向模型，与 `acp.run` 那条 warn 的
   * `data.degraded` 同源（`AcpSurface.notes`）—— 此前它只写入日志，运维可在 WebUI 中看到而模型
   * 完全看不到，导致模型让 agent 去执行命令、得到一个无法解释的失败，然后绕行或编造原因。
   * 为 0 条时不输出该键（同 `filesWritten` / `terminals`）。
   *
   * 上界为 `DEGRADED_MAX_NOTES` × `DEGRADED_NOTE_BYTES`：其中一条 note 内嵌 jail 构造失败的
   * `error.message`，长度不可控。
   */
  degraded?: string[];
  truncated?: boolean;
  output?: string;
  stderr?: string;
}

/** 目录互斥的等待上界。足以覆盖一次短调用，同时保证第二个调用能拿到可操作的答复。 */
export const ACP_DIR_WAIT_MS = 30_000;
/** `session/close` 的上界。它只是善后步骤，超时即转入关停流程，不应阻塞一次工具调用。 */
const CLOSE_TIMEOUT_MS = 3000;
/** `,"truncated":true,"output":""` 这几个键名占用的字节。固定字段长度实测得出，此处不做估算。 */
const RESULT_KEY_OVERHEAD = 48;
/** 失败时附带的 stderr 尾部。足以呈现一条报错，又不至于占用正文预算。 */
const STDERR_TAIL_BYTES = 1024;
/**
 * 单条 `degraded` note 的字节上界，实测得出：`#surface` 中最长的固定 note（`approvalMode` 被调回
 * 非 yolo 的那条）为 326 字节，384 留有余量，因此固定 note 不会被截断 —— 唯一会触及该上界的是
 * 内嵌 jail 构造失败 `error.message` 的那条，而这正是它存在的理由。
 */
const DEGRADED_NOTE_BYTES = 384;
/**
 * `degraded` 的条数上界。`#surface` 共可产出四条（jail 构造失败 / terminal 未申报 / 配置了 bash
 * 但无终端 / 配置了 bash 但 approvalMode 被调回非 yolo），因此上界取四。不取当前最多同时出现两条
 * 这一数值：该数值由 jail 那条会提前 return 推导而来，新增一条 note 即静默失效。
 */
const DEGRADED_MAX_NOTES = 4;
/** `clipToJsonBudget` 的收敛下限（其内部的 `Math.max(64, …)`）。低于该预算不再裁剪，整段丢弃。 */
const CLIP_FLOOR_BYTES = 64;
/** JSON-RPC 的 `auth_required`（SDK 的 `RequestError.authRequired`）。 */
const AUTH_REQUIRED_CODE = -32000;

const elision = (omitted: number): string => `\n…省略 ${omitted} bytes…\n`;

/** 判据同 `resolveHarnessDir`，但两侧都解析 realpath。详见 `resolveAcpTarget` 中的注释。 */
function insideRealAllowed(root: string, allowedDirs: readonly string[]): boolean {
  for (const entry of allowedDirs) {
    let base = resolve(entry);
    try { base = realpathSync(base); } catch { /* 名单中该项不存在，按字面比较 */ }
    if (root === base || root.startsWith(`${base}${sep}`)) return true;
  }
  return false;
}

/** 选定 agent 与运行目录。`ok:false` 分支携带已分类的失败原因。 */
export type AcpTarget = { ok: true; agent: AcpAgentSettings; root: string } | { ok: false; failure: AcpFailure; agent?: string; dir?: string };

/**
 * 三道门中 agent 与目录这一半。一处实现供两个调用方使用：`run()` 用它作准入判据，工具壳用它
 * 填充进度卡片的表头（agent 名字与相对路径基点）—— 卡片自行再算一遍会使屏幕显示的目录与实际
 * 运行的目录成为两个可能分叉的答案。
 *
 * realpath 是本次调用全程唯一的目录字面量：互斥键、jail 的 root 与 base、`session/new` 的 `cwd`、
 * 子进程的 cwd 全部使用它。互斥的理由是既有的（两条软链指向同一仓库时，按请求路径加锁等于未加）；
 * jail 与 `cwd` 的理由是新增的：`resolveHarnessDir` 只做 `resolve()`，路径中间存在软链时 agent 自行
 * 解析出的绝对路径与 jail 的边界将是两套字面量，导致每一次 `fs/*` 都被判为越界拒绝。
 */
export function resolveAcpTarget(input: AcpRunInput, settings: AcpSettings): AcpTarget {
  if (!settings.enabled || !settings.allowedDirs.length) return { ok: false, failure: acpFailure('acp_disabled') };
  const agent = resolveAcpAgent(settings, input.agent);
  if (!agent) {
    return { ok: false, failure: settings.agents.some((entry) => entry.enabled)
      ? acpFailure('acp_agent_unknown', input.agent ?? settings.defaultAgent) : acpFailure('acp_no_agents') };
  }
  const resolved = resolveHarnessDir(input.dir, settings.allowedDirs);
  if (!resolved) return { ok: false, failure: acpFailure('acp_dir_not_allowed', settings.allowedDirs.join(' · ')), agent: agent.name };
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ok: false, failure: acpFailure('acp_dir_missing'), agent: agent.name, dir: resolved };
  // 解析失败则退回 `resolved`（例如目录刚被删除，下一步的 spawn 会如实失败）。
  let root = resolved;
  try { root = realpathSync(resolved); } catch { /* 使用 resolved */ }
  // 白名单在 realpath 上再判定一次。jail 的边界现在是 realpath，而 `allowedDirs` 中指向别处的软链
  // 原本只意味着 agent 在该处运行，现在还意味着 jail 的边界位于名单之外。两侧都解析：只解析目标
  // 一侧的话，`/home` 本身为软链的部署会把一份可用配置判为越界。
  if (root !== resolved && !insideRealAllowed(root, settings.allowedDirs)) {
    return { ok: false, failure: acpFailure('acp_dir_not_allowed', `${resolved} → ${root}（符号链接解析后落在白名单之外）`), agent: agent.name };
  }
  return { ok: true, agent, root };
}

/**
 * 按序列化后的字节数裁剪。`#normalizeOutput` 统计的是 `JSON.stringify(rest)`，而换行、引号、
 * 控制字符在 JSON 中均需转义 —— 按原文字节裁出的恰好 65536 在序列化后会超出。
 *
 * 按实测比例收缩，最多三轮：每轮预算按 `budget/encoded < 1` 的比例缩减一次，收敛有保证。
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
 * 超时（或本轮被取消）后 reject，但不取消底层操作 —— 调用方随即回收连接与子进程，不留孤儿。
 *
 * 必须识别 `abortSignal`：握手需四跳（initialize / session/new / authenticate /
 * set_config_option），各自最长 `handshakeTimeoutMs`，默认合计两分钟。不识别取消的话，
 * 用户执行 `/cancel` 后仍需等待这两分钟，随后 agent 才开始修改文件。
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
/** 携带已分类的失败穿过握手各层。无副作用 —— 清理统一放在 `#open` 的 catch 中。 */
class AcpFailureError extends Error {
  constructor(readonly failure: AcpFailure) { super(failure.error); }
}

interface OpenSession { child: AcpChild; connection: ClientConnection; cx: ClientContext; sessionId: string; closable: boolean }
type OpenOutcome = { ok: true; session: OpenSession } | { ok: false; failure: AcpFailure; child: AcpChild | null };

/**
 * 本次会话的反向调用面。`capabilities` 由 `fs` / `terminals` 是否存在计算得出，而非另一份需要
 * 手工对齐的声明 —— 二者与申报值分处两地时终会漏改一处，而漏改的表现是一次挂死。
 */
interface AcpSurface {
  fs: AcpFs | null;
  terminals: AcpTerminals | null;
  jail: PathJail | null;
  capabilities: ClientCapabilities;
  /** 具备能力却未申报的原因，逐条以自然语言给出。写入 `acp.run` 的 `data.degraded` 并将该行提升为 warn。 */
  notes: string[];
}

export class AcpManager {
  /**
   * 全部已启动且未关闭完成的子进程。`close()` 关闭的是这个集合而非仅当前一条：握手超时被丢弃的、
   * prompt 中途失败的、竞态泄漏的都在其中，遗漏一条即遗漏一个 refed 的子进程 ——
   * `shutdown()` 只设置 `process.exitCode`，event loop 不空进程就不会退出（docs/28 · L-EXT-03）。
   */
  readonly #children = new Set<AcpChild>();
  /** 每条子进程对应的连接。`close()` 需要访问它 —— 只终止进程而不先关闭连接，SDK 侧会持续等待
   *  一个不会到来的响应（顺序颠倒的表现见 `#discard` 的注释）。 */
  readonly #connections = new WeakMap<AcpChild, ClientConnection>();
  /** 正在关闭中的条目。`close()` 必须等待这些 promise，不能仅再调用一次 `child.close()`。 */
  readonly #closing = new Set<Promise<void>>();
  /** 主动关闭的条目。`onExit` 据此区分调用正常收尾与子进程自行终止，后者才需要告警。 */
  readonly #intentional = new WeakSet<AcpChild>();
  /**
   * 目录互斥。只有一个键空间（`dir:<realpath>`）—— 此处不像 `McpManager` 存在嵌套持锁
   * （`reconcile` → `connect`），因此无需第二个键空间来规避自等待。
   */
  readonly #mutex = new KeyedMutex();
  /**
   * 在途会话的终端集合。三道 release 兜底中的第三道（进程关停）—— 前两道是 `abortSignal` 与
   * `#run` 的 `finally`。若 `close()` 只关闭子进程，agent 要求启动的那些命令仍在宿主上运行，
   * 而它们继承的生命周期在本进程之外（`detached: true`），无人回收即成为真正的孤儿进程。
   */
  readonly #terminals = new Set<AcpTerminals>();

  /**
   * `runs` 可选：传入时每次调用写入一行 `agent_runs`（外部花费计入 `external_cost_usd`，
   * `cost_usd` 恒为 0 —— 见 `runs.ts` 开头）。缺失时照常运行，只是该次调用在 trace 骨架上没有行
   * —— 分段用例与任何手工构造 manager 的场景落在这一档，而记账失败绝不改变调用结果（见 `#record`）。
   */
  constructor(private readonly log: LogSink, private readonly runs?: AcpRunLedger) {}

  /**
   * 执行一次 ACP 任务。三道门的第二道（目录）在此二次判定 —— `available()` 已判定过一次，
   * 而热更新可能在注册与执行之间清空名单（做法同 `spawn_harness`）。
   */
  async run(input: AcpRunInput, settings: AcpSettings, options: AcpRunOptions): Promise<AcpRunResult> {
    const target = resolveAcpTarget(input, settings);
    if (!target.ok) return { ...target.failure, ...(target.agent ? { agent: target.agent } : {}), ...(target.dir ? { dir: target.dir } : {}) };
    const { agent, root } = target;
    const release = await this.#acquireDir(root, options.abortSignal, options.dirWaitMs ?? ACP_DIR_WAIT_MS);
    if (!release) return { ...acpFailure(options.abortSignal.aborted ? 'acp_cancelled' : 'acp_dir_busy'), agent: agent.name, dir: root };
    try { return await this.#run(agent, root, input.task, settings, options); }
    finally { release(); }
  }

  async #run(agent: AcpAgentSettings, dir: string, task: string, settings: AcpSettings, options: AcpRunOptions): Promise<AcpRunResult> {
    const started = performance.now();
    // `agent_runs.started_at` 需要墙钟时间。`performance.now()` 是单调时钟，仅用于计算 `ms`。
    const startedAt = Date.now();
    // 聚合期的上界只与 `agents[].maxOutputBytes` 相关：取 2× 是为了让最后一次中间截断能保留首尾
    // （同 `runHarness`）。实际返回多少由下方实测得出的预算决定 —— 到那时才知道 hint / detail /
    // stderr 各占多少。
    const sink = new AcpUpdateSink({ maxUpdates: settings.maxUpdatesPerPrompt, maxTextBytes: agent.maxOutputBytes * 2, maxCostUsd: settings.maxCostUsd,
      ...(options.hooks?.onUpdate ? { onUpdate: options.hooks.onUpdate } : {}) });
    const surface = this.#surface(agent, dir, settings, options);
    /**
     * 三道 release 兜底中的第一道：用户执行 `/cancel`。缺少它时，一次被取消的调用会留下一条仍在
     * 宿主上运行的命令，而已无人等待其输出。另两道是下方的 `finally`（工具返回路径）与
     * `close()`（进程关停）。
     */
    const onAbort = (): void => { surface.terminals?.releaseAll(); };
    if (surface.terminals) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      this.#terminals.add(surface.terminals);
    }
    let opened: OpenOutcome;
    let child: AcpChild | null;
    let failure: AcpFailure | null;
    let stopReason: StopReason | undefined;
    try {
      opened = await this.#open(agent, dir, settings, sink, options, surface);
      child = opened.ok ? opened.session.child : opened.child;
      failure = opened.ok ? null : opened.failure;
      if (opened.ok) {
        try {
          const outcome = await runAcpPrompt(opened.session.cx, { agent, sessionId: opened.session.sessionId, task, sink,
            abortSignal: options.abortSignal, closed: opened.session.connection.closed });
          stopReason = outcome.stopReason ?? undefined;
          failure = outcome.failure;
        } catch (error) { failure = acpFailure('acp_prompt_failed', error); }
        finally { await this.#closeSession(opened.session); }
      }
    } finally {
      options.abortSignal.removeEventListener('abort', onAbort);
      // 第二道兜底，排在结果组装之前 —— `leaked` 需写入那条 `acp.run`，而漏 release 属于 agent 的
      // 缺陷：不记录一行的话，命令仍在宿主上运行这一事实在任何地方都无从体现。
      surface.terminals?.releaseAll();
      if (surface.terminals) this.#terminals.delete(surface.terminals);
    }
    // 单行越界优先级最高：连接因此断开，而断开本身无法区分原因（`acp_connection_lost` 会将其
    // 表述为 agent 自行终止，运维据此去查退出码将一无所获）。
    if (child?.overflowed()) failure = acpFailure('acp_line_too_long');
    else if (failure?.error === 'acp_connection_lost' && child) {
      const exit = child.exitStatus();
      failure = acpFailure('acp_connection_lost', `exit=${exit?.code ?? 'null'} signal=${exit?.signal ?? 'null'}`);
    }
    /**
     * 除 `output` 之外的全部字段。先将其序列化并统计长度，剩余部分才是 `output` 的预算 ——
     * 上界因此不依赖对 hint / detail / stderr / dir 长度的估计：中文 hint 加中文 detail 加一段
     * 全为引号的 stderr 实测可占 5.2 KB，而按固定余量估算的数值曾为 4 KB，导致
     * `#normalizeOutput` 的中间截断在失败路径上确实会触发（而失败路径恰恰最不应被截断）。
     *
     * `output` 排在最后是第二道保险：即使仍被截断，`elideMiddleBytes` 保留首尾，`ok` / `error` /
     * `hint` / `stopReason` 与几个计数仍位于头部。
     */
    const head = {
      ok: failure === null,
      ...(failure ? { error: failure.error, hint: failure.hint, ...(failure.detail ? { detail: failure.detail } : {}) } : {}),
      agent: agent.name, dir,
      ...(stopReason ? { stopReason } : {}),
      updates: sink.updates, updatesDropped: sink.dropped, toolCalls: sink.toolCalls,
      ...(sink.failures > 0 ? { failures: sink.failures } : {}),
      thoughts: sink.thoughts,
      // 两个用于判断 agent 实际改动了什么的凭据，均只在非 0 时输出。`stopReason: 'end_turn'` 加
      // 一份完整的总结加 `filesWritten: 0` 是实际观察到的组合（它只做了读取然后进行了描述）。
      ...(surface.fs && surface.fs.writes > 0 ? { filesWritten: surface.fs.writes } : {}),
      ...(surface.terminals && surface.terminals.created > 0 ? { terminals: surface.terminals.created } : {}),
      ...(sink.costUsd === null ? {} : { costUsd: sink.costUsd }),
      ...(sink.contextUsed === null ? {} : { contextUsed: sink.contextUsed }),
      ms: Math.round(performance.now() - started),
      // 降级信息同时写入结果与日志：`data.degraded` 面向运维，这一份面向模型。排在 stderr / output
      // 之前 —— 能力不可用这一结论若被中间截断丢弃，模型会依据自行编造的解释继续执行。
      ...(surface.notes.length ? { degraded: surface.notes.slice(0, DEGRADED_MAX_NOTES)
        .map((note) => elideMiddleBytes(note, DEGRADED_NOTE_BYTES, elision).value) } : {}),
      // stderr 只在失败时附带：成功路径上它属于噪声（omp 将 console.* 全部重定向到 stderr），
      // 而失败时它往往是唯一能说明原因的信息。
      ...(failure && child?.stderrTail() ? { stderr: elideMiddleBytes(child!.stderrTail(), STDERR_TAIL_BYTES, elision).value } : {}),
    };
    // `,"truncated":true,"output":""` 这几个键名本身也需计入。
    const budget = Math.min(agent.maxOutputBytes, options.outputBudgetBytes - Buffer.byteLength(JSON.stringify(head)) - RESULT_KEY_OVERHEAD);
    // 预算小到无法容纳省略说明本身时整段丢弃，不保留片段。`elideMiddleBytes` 返回的是
    // 首 1 字节加省略说明加尾 1 字节，而该说明约二十字节，`clipToJsonBudget` 的收敛下限又是 64
    // —— 门槛若写 0，`0 < budget < 64` 这一档返回的内容会长于预算，上界在最紧处反而被突破。
    // （能触及此处的只有极端的 `tools.exec.maxOutputBytes` 配置，但上界必须始终成立。）
    const clipped = budget > CLIP_FLOOR_BYTES ? clipToJsonBudget(sink.text(), budget) : { value: '', truncated: sink.text().length > 0 };
    const result: AcpRunResult = { ...head,
      ...(clipped.truncated || sink.textTruncated() || clipped.value.length < sink.text().length ? { truncated: true } : {}),
      output: clipped.value };
    const leaked = surface.terminals?.leaked ?? [];
    const runId = this.#record(agent, dir, task, result, sink, surface, startedAt, options.trace);
    /**
     * `acp.run` 这一行同时承载反向调用面的两条 warn —— `docs/10 §2` 的 kind 表被
     * `tests/docs.test.ts` 双向约束，为 terminal 未申报与 agent 漏 release 各新增一个 kind，
     * 等于引入两个只在异常路径出现的枚举值。它们写入本行的 `data`，并将本行提升为 warn：
     * 前者是运维需要感知的一次能力降级（`sandbox.mode` 配置为 docker 而 owner 不在 `bypassRoles` 中），
     * 后者是 agent 的协议缺陷（我方已代为清理，但这意味着有命令一直运行到我方收尾时刻）。
     */
    const degraded = surface.notes.length > 0 || leaked.length > 0;
    this.log.event({ level: result.ok && !degraded ? 'info' : 'warn', kind: 'acp.run',
      summary: `acp ${result.ok ? 'ok' : failure!.error} · ${agent.name} · ${dir}${surface.notes.length ? ` · ${surface.notes.join(' · ')}` : ''}${leaked.length ? ` · ${leaked.length} 个终端未 release` : ''}`,
      ...this.#trace(options.trace),
      data: { agent: agent.name, dir, command: agent.command, approvalMode: agent.approvalMode, stopReason: stopReason ?? null,
        error: failure?.error ?? null, updates: sink.updates, dropped: sink.dropped, toolCalls: sink.toolCalls,
        capabilities: Object.keys(surface.capabilities), degraded: surface.notes, filesWritten: surface.fs?.writes ?? 0,
        terminals: surface.terminals?.created ?? 0, terminalsLeaked: leaked.length,
        // `costUsd` 在该 kind 上始终表示外部 agent 自行上报的数值，与 `agent_runs.cost_usd`
        // （本系统的花费，ACP 行恒为 0）不是同一回事 —— 因此该列的值落在 `external_cost_usd`，
        // 而不是在此换个名字重复一次。`runId` 是本行与库中对应行之间唯一的关联点。
        costUsd: sink.costUsd, runId, ms: result.ms } });
    return result;
  }

  /**
   * 写入那一行 `agent_runs`。吞掉自身异常：记账失败不应把一次已完成仓库修改的成功调用变为失败
   * （反向更糟 —— 模型会认为什么都没发生）。失败时记录一条 warn，并复用 `acp.run` 这个 kind：
   * `docs/10 §2` 的表被 `tests/docs.test.ts` 双向约束，为一件只在写库出错时发生的事新增枚举值
   * 不值得。
   *
   * 没有 `traceId` 时不写入：`agent_runs.turn_id` 无法关联 turn 的行没有读取路径（无法进入 trace
   * 树、在 `ix_agentruns_turn` 上是查不出的孤儿行）。生产调用方恒传，落在这一档的只有测试用例。
   */
  #record(agent: AcpAgentSettings, dir: string, task: string, result: AcpRunResult, sink: AcpUpdateSink,
    surface: AcpSurface, startedAt: number, trace?: AcpTrace): string | null {
    const turnId = trace?.traceId;
    if (!this.runs || !turnId) return null;
    try {
      return this.runs.record({ turnId, agent: agent.name, dir, task, ok: result.ok,
        ...(result.error ? { error: result.error } : {}), ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        output: result.output ?? '', toolCalls: sink.toolCalls, costUsd: sink.costUsd,
        /**
         * `external_usage_json` 的载荷，自描述（`source` / `agent` / `model` 均包含在内）——
         * 读者需一眼看出这些数值来自外部而非本系统，否则它们与相邻的自有读数外观相同。
         * 此处没有任何 token 计数：`usage_update` 给出的是上下文占用（`used` / `size`）与一个
         * 已计算好的金额，没有 tokens × prices 可供重算（`ledger/quota.ts` 删除 `modelCost()`
         * 时确立的规则：计价判据只有一份）。
         */
        usage: { source: 'acp', agent: agent.name, command: agent.command, model: agent.model || null,
          approvalMode: agent.approvalMode, dir, costUsd: sink.costUsd,
          contextUsed: sink.contextUsed, contextSize: sink.contextSize,
          updates: sink.updates, updatesDropped: sink.dropped, toolCalls: sink.toolCalls, failures: sink.failures,
          thoughts: sink.thoughts, filesWritten: surface.fs?.writes ?? 0, terminals: surface.terminals?.created ?? 0,
          stopReason: result.stopReason ?? null, error: result.error ?? null, ms: result.ms ?? null },
        startedAt, finishedAt: Date.now() });
    } catch (error) {
      this.log.event({ level: 'warn', kind: 'acp.run', summary: `acp 记账失败 · ${agent.name} · ${dir}`,
        ...this.#trace(trace), data: { agent: agent.name, dir, recordFailed: error instanceof Error ? error.message : String(error) } });
      return null;
    }
  }

  /**
   * 本次会话的反向调用面：jail、fs、终端，以及据此计算出的 `clientCapabilities`。
   *
   * 顺序即判据：先构造能力，构造成功后才申报。反向实现（先申报再构造）时，中间每一次
   * `fs/read_text_file` 都会挂死 —— 而此刻 agent 正持有一个修改到一半的文件。
   */
  #surface(agent: AcpAgentSettings, root: string, settings: AcpSettings, options: AcpRunOptions): AcpSurface {
    const notes: string[] = [];
    const host = options.host;
    if (!host) return { fs: null, terminals: null, jail: null, capabilities: {}, notes };
    let jail: PathJail;
    try { jail = new PathJail(root, [...host.fs.denyGlobs], { base: root }); }
    catch (error) {
      // jail 构造失败（目录在此刻被删除、权限丢失）—— 这一档不申报任何能力，而不是使整次调用失败：
      // agent 会退回直接访问磁盘，产出照常可得，而降级本身写入那条 `acp.run` warn。
      notes.push(`fs 未申报（jail 构造失败：${error instanceof Error ? error.message : String(error)}）`);
      return { fs: null, terminals: null, jail: null, capabilities: {}, notes };
    }
    const files = new FileTools(jail, host.fs.maxReadBytes, host.fs.maxWriteBytes, { backupDir: host.fs.backupDir });
    // 终端需在宿主直接运行（cwd = 会话 root）。不是 `'host'` 时整个 capability 都不申报，而不是
    // 申报后每次 create 都失败 —— 详见 `AcpHostAccess.plan` 一段。
    const plan = host.plan(root);
    const terminals = plan.mode === 'host'
      ? new AcpTerminals(jail, root, { maxTerminals: settings.maxTerminals, maxTimeoutMs: host.exec.maxTimeoutMs, maxOutputBytes: host.exec.maxOutputBytes })
      : null;
    if (!terminals) notes.push(`terminal 未申报（sandbox.plan=${plan.mode}${plan.reason ? `：${plan.reason}` : ''}）`);
    // `agents[].tools` 中配置了 `bash` 而终端未申报，等于在其目录中放置一个可证明不可用的工具。
    // 这正是上一轮将 `bash` 从默认值中移除的理由，配置中重新写回时需明确告知。
    if (!terminals && agent.tools.includes('bash')) notes.push('agents[].tools 配置了 bash，但未申报 terminal，该工具无法执行');
    /**
     * ⚠️ 申报 `terminal` 是 `bash` 可运行的必要条件而非充分条件。omp 17.4.0 实测：
     * `approvalMode` 不为 `yolo` 时，它会就 `bash` 发起询问（`session/request_permission`，kind
     * `execute`，四个选项齐备），我方从它提供的 options 中选一个 `allow_always` 应答，
     * 它仍将该次调用记为 `Tool call denied by user: bash` —— `terminal/create` 一次都未发生
     * （`terminals: 0`）。改为 `yolo` 后同一条命令立即执行成功（`terminals: 1`，使用的是我方终端）。
     *
     * 即阻断它的是 agent 内部的审批环节，而非本客户端的能力申报或我方的应答。
     * 该组合因此等于在配置中保留一个可证明不可用的工具 —— 模型会尝试、失败，然后绕行或编造原因，
     * 而唯一能说明此事的位置就是这一行（摘除比伪造安全，`docs/16 §5`）。
     *
     * 默认值现为 `yolo`（需求方决定：整趟交由它处理），因此这条 warn 只在运维主动将其调回
     * `write` / `always-ask` 且仍保留 `bash` 时出现 —— 即界面已配置而运行时不可用的形态。
     * 取舍记录于 `docs/05 §3.5.1`。
     */
    if (terminals && agent.tools.includes('bash') && agent.approvalMode !== 'yolo') {
      notes.push(`agents[].tools 配置了 bash，而 approvalMode=${agent.approvalMode}（默认值为 yolo，此处被改过）。实测 omp 在该档会就 bash 发起询问，我方放行后它仍自行拒绝，terminal 一次未使用。需要执行命令须配置 approvalMode: yolo；如需逐条拦截，将 agent.acp.permissionMode 设为 ask`);
    }
    return { fs: new AcpFs(files), terminals, jail, capabilities: acpClientCapabilities({ fs: true, terminal: Boolean(terminals) }), notes };
  }

  #trace(trace?: AcpTrace): { traceId?: string; chatId?: string; userId?: string; key?: string } {
    return { ...(trace?.traceId ? { traceId: trace.traceId } : {}), ...(trace?.chatId ? { chatId: trace.chatId } : {}),
      ...(trace?.userId ? { userId: trace.userId } : {}), ...(trace?.key ? { key: trace.key } : {}) };
  }

  /** spawn → 连接 → initialize（含版本协商与 authenticate 分支）→ `session/new` → 会话模式。 */
  async #open(agent: AcpAgentSettings, dir: string, settings: AcpSettings, sink: AcpUpdateSink, options: AcpRunOptions, surface: AcpSurface): Promise<OpenOutcome> {
    // `spawn()` 绝大多数失败是异步的（ENOENT 走 'error' 事件，靠 `child.spawned` 分类），但参数
    // 本身非法时它会同步抛出 —— `command` 中一个 NUL 字节即可触发。让该路径同样落入错误契约，
    // 而不是抛出后变成 `execute()` catch 中的裸 `error.message`。
    let child: AcpChild;
    try { child = spawnAcpAgent(agent, dir, {
      // 逐行而非整块处理：一条 500 KB 的调用栈会撑爆日志行，而 `LogSink` 的载荷需要落盘。
      onStderrLine: (line) => this.log.event({ level: 'warn', kind: 'acp.stderr', summary: `${agent.name}: ${line.slice(0, 2000)}`,
        ...this.#trace(options.trace), data: { agent: agent.name } }),
      onExit: (exit) => {
        if (this.#intentional.has(child)) return;
        this.log.event({ level: 'warn', kind: 'acp.disconnect', summary: `${agent.name} 子进程已自行退出（exit=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}）`,
          ...this.#trace(options.trace), data: { agent: agent.name, exitCode: exit.code, signal: exit.signal } });
      },
    }); } catch (error) { return { ok: false, failure: acpFailure('acp_spawn_failed', error), child: null }; }
    this.#children.add(child);
    let connection: ClientConnection | undefined;
    try {
      try { await withTimeout(child.spawned, agent.handshakeTimeoutMs, `${agent.name} spawn`, options.abortSignal); }
      // 超时与取消不归入 `acp_spawn_failed`：该 hint 引导运维检查是否安装、命令是否拼写正确，
      // 而这两档与可执行文件是否存在无关。让它们原样传递到下方的 catch 中分类。
      catch (error) { throw error instanceof AcpTimedOut || error instanceof AcpAborted ? error : new AcpFailureError(acpFailure('acp_spawn_failed', error)); }
      /**
       * 逐条审批的处理器。仅在 `ask` 档位且运行时确实接入审批通道时存在；一旦给出即完全接管，
       * `floorPermission` 不再参与（串联会使谁先应答变成必须读代码才能确定的问题）。
       *
       * `jail` 为 null（无 `host`）时拿不到边界判据，此时按无 gate 处理 —— 落到地板的 `ask`
       * 按 deny 计算，fail-closed 在这一侧。
       */
      const gate = settings.permissionMode === 'ask' && surface.jail
        ? options.hooks?.permission?.({ jail: surface.jail, agent: agent.name, onUnanswerable: () => sink.onPermissionUnanswerable?.() })
        : undefined;
      const fs = surface.fs;
      const terminals = surface.terminals;
      connection = client({ name: 'luolicore' })
        .onNotification('session/update', ({ params }) => { sink.accept(params); })
        .onRequest('session/request_permission', async (ctx) => {
          if (gate) return await gate(ctx.params, ctx.signal);
          const response = floorPermission(ctx.params, settings.permissionMode);
          // `ask` 落到地板意味着运行时未接入审批通道，而 `available()` 本应已将工具挡在目录之外。
          // 一条 warn 是此事的唯一凭据 —— 答案是拒绝而非放行：名为 `ask` 的档位实际放行，
          // 正是 `docs/reviews/16 §5` 所述的伪造一道门。
          this.log.event({ level: settings.permissionMode === 'ask' ? 'warn' : 'info', kind: 'acp.permission',
            summary: `${agent.name} 请求权限（${ctx.params.toolCall.kind ?? 'other'}）→ ${settings.permissionMode === 'ask' ? 'ask 档没有审批通道，按 deny 处理' : settings.permissionMode}`,
            ...this.#trace(options.trace),
            data: { agent: agent.name, mode: settings.permissionMode, gated: false, kind: ctx.params.toolCall.kind ?? null,
              title: ctx.params.toolCall.title ?? null, outcome: response.outcome.outcome } });
          return response;
        })
        /**
         * 反向 fs（`docs/05 §3.5.2`）。`surface.fs` 为 null 时照常抛出 `methodNotFound` ——
         * 该档位下我方未申报（`acpClientCapabilities` 由它计算得出），而不遵守协议的 agent 应当
         * 得到一个明确的错误，而不是一个挂起的请求。
         *
         * 读取走 `FileTools.readText` 而非 `read()`：后者无条件添加 `行号<TAB>` 前缀，而 ACP 的写入
         * 是全量覆盖 —— 读出后修改两行再写回，会把整个文件替换为带行号的无效内容（完整理由见 `fs.ts`）。
         */
        .onRequest('fs/read_text_file', (ctx) => {
          if (!fs) throw RequestError.methodNotFound('fs/read_text_file');
          return fs.readTextFile(ctx.params);
        })
        .onRequest('fs/write_text_file', (ctx) => {
          if (!fs) throw RequestError.methodNotFound('fs/write_text_file');
          return fs.writeTextFile(ctx.params);
        })
        // 反向终端（`docs/05 §3.5.2`）。同上：未申报的档位抛出 `methodNotFound`。
        .onRequest('terminal/create', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/create');
          return terminals.create(ctx.params);
        })
        .onRequest('terminal/output', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/output');
          return terminals.output(ctx.params.terminalId);
        })
        // `signal` 在本请求被取消或连接关闭时触发，必须 settle —— 否则 SDK 侧会留下一个永不应答的
        // 请求，而 agent 将持续挂起。`waitForExit` 自身会识别它。
        .onRequest('terminal/wait_for_exit', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/wait_for_exit');
          return terminals.waitForExit(ctx.params.terminalId, ctx.signal);
        })
        .onRequest('terminal/kill', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/kill');
          terminals.kill(ctx.params.terminalId);
          return {};
        })
        .onRequest('terminal/release', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/release');
          terminals.release(ctx.params.terminalId);
          return {};
        })
        .connect(ndJsonStream(child.stdin, child.stdout));
      this.#connections.set(child, connection);
      const cx = connection.agent;
      const init = await withTimeout(cx.request('initialize', { protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: surface.capabilities, clientInfo: { name: 'luolicore', version: '0.1.0' } }), agent.handshakeTimeoutMs, `${agent.name} initialize`, options.abortSignal);
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpFailureError(acpFailure('acp_protocol_unsupported', `agent 协商出 v${init.protocolVersion}，本客户端只支持 v${PROTOCOL_VERSION}`));
      }
      // MCP server 不透传：那些 server 是以本进程身份配置的，交由另一个 agent 驱动等于把它们的
      // 能力借给一套不受 `TOOL_POLICY` 约束的工具集（同 `docs/14` T17 的原则）。
      const newSession = (): Promise<{ sessionId: string }> => withTimeout(cx.request('session/new', { cwd: dir, mcpServers: [] }), agent.handshakeTimeoutMs, `${agent.name} session/new`, options.abortSignal);
      let sessionId: string;
      try { sessionId = (await newSession()).sessionId; }
      catch (error) {
        const methods = init.authMethods ?? [];
        // 只用它已有的本机凭据尝试一次。需要浏览器授权的类型不在此处处理 —— 那件事在带外完成
        // （沿用 `docs/07 §4.5` 对 stdio MCP server 的先例），我方能做的是如实告知需要登录。
        if (!(error instanceof RequestError) || error.code !== AUTH_REQUIRED_CODE || !methods.length) throw error;
        try {
          await withTimeout(cx.request('authenticate', { methodId: (methods[0] as { id: string }).id }), agent.handshakeTimeoutMs, `${agent.name} authenticate`, options.abortSignal);
          sessionId = (await newSession()).sessionId;
        } catch (retry) { throw new AcpFailureError(acpFailure('acp_auth_required', retry)); }
      }
      // 会话模式（default / plan）只能通过这条路径设置，argv 上的 `--mode` 指的是输出格式。
      // 失败必须硬失败：运维需要的是 plan（只读规划），静默退回 default 等于让它真的修改文件。
      if (agent.mode) {
        try { await withTimeout(cx.request('session/set_config_option', { sessionId, configId: 'mode', value: agent.mode }), agent.handshakeTimeoutMs, `${agent.name} set_config_option`, options.abortSignal); }
        catch (error) { throw error instanceof AcpAborted ? error : new AcpFailureError(acpFailure('acp_session_failed', error)); }
      }
      return { ok: true, session: { child, connection, cx, sessionId, closable: Boolean(init.agentCapabilities?.sessionCapabilities?.close) } };
    } catch (error) {
      // 握手失败的那一条立即回收（连接与进程），不留下可启动但无法握手的孤儿。
      // 不 await：关停流程需走 SIGTERM → 5s → SIGKILL，而 `#closing` 已代 `close()` 记录它。
      void this.#discard(child, connection);
      const failure = error instanceof AcpFailureError ? error.failure
        : error instanceof AcpAborted ? acpFailure('acp_cancelled')
        : error instanceof AcpTimedOut ? acpFailure('acp_handshake_timeout', error.message)
        : acpFailure('acp_handshake_failed', error);
      return { ok: false, failure, child };
    }
  }

  /** `session/close` 属善后步骤（best-effort、短超时），之后才执行连接与进程的关停流程。 */
  async #closeSession(opened: OpenSession): Promise<void> {
    // 只在对方申报了 `sessionCapabilities.close` 时才发送：未申报的 method 不应被调用，
    // 这条纪律与我方那七处 `methodNotFound` 同源（申报什么就响应什么）。
    if (opened.closable) {
      try { await withTimeout(opened.cx.request('session/close', { sessionId: opened.sessionId }), CLOSE_TIMEOUT_MS, 'session/close'); }
      catch { /* 对方已终止或不响应 —— 下一步照常回收进程 */ }
    }
    await this.#discard(opened.child, opened.connection);
  }

  /**
   * 关闭一条：先关闭连接（`session/prompt` 等在途请求会被 SDK 拒绝），再执行进程关停流程。
   * 顺序颠倒会导致子进程已终止而 SDK 仍在等待其响应。
   */
  #discard(child: AcpChild, connection?: ClientConnection): Promise<void> {
    this.#intentional.add(child);
    const done = (async () => {
      try { connection?.close(); } catch { /* 已关闭 */ }
      try { await child.close(); } catch { /* 无法关闭的（已消失）同样要从记录中移除 */ }
      finally { this.#children.delete(child); }
    })();
    this.#closing.add(done);
    void done.finally(() => this.#closing.delete(done));
    return done;
  }

  /**
   * 目录互斥加锁。等待有界且可取消：外层工具为 `timeoutMs: null`，让第二个调用空等十五分钟
   * 等于把并发保护变成并发阻塞。
   *
   * 放弃等待的一侧不退出队列 —— `KeyedMutex` 挂上 tail 后必须被 release，中途放弃会使该键在
   * 进程生命周期内永久阻塞。因此它照常排到队首，随后立即释放锁。
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
    // 终端排在子进程之前：先终止 agent 要求启动的命令，再回收 agent 本身。顺序颠倒会导致在
    // 那段窗口内 agent 已终止而其命令仍在向无人读取的管道写入。
    for (const terminals of [...this.#terminals]) {
      const live = terminals.releaseAll();
      if (live.length) this.log.event({ level: 'warn', kind: 'acp.run', summary: `关停时回收了 ${live.length} 个未 release 的 ACP 终端`, data: { terminalsLeaked: live.length, at: 'shutdown' } });
      this.#terminals.delete(terminals);
    }
    for (const child of [...this.#children]) void this.#discard(child, this.#connections.get(child));
    await Promise.all([...this.#closing]);
  }
}
