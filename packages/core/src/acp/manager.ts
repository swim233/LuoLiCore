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
 * `initialize` 里申报的客户端能力。**按本次调用现算，不是常量** ——
 * ACP 明文规定：字段省略 == UNSUPPORTED，而谎报一个我们不会答的 method 会让 agent 发出请求之后
 * 挂在那里等，此刻它正握着一个半改完的文件。
 *
 * 所以这两位都是**能力真的到位了才置**：`fs` 要有一个建得起来的 jail（root = `realpathSync(dir)`），
 * `terminal` 还要额外过 `sandbox.plan(role, root).mode === 'host'`。拿不到就不申报 —— 而不是申报了
 * 让 agent 每次 create 都撞一个错（它会反复试，而每次失败都是一段它自己编出来的解释）。
 */
export function acpClientCapabilities(enabled: { fs: boolean; terminal: boolean }): ClientCapabilities {
  return { ...(enabled.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}), ...(enabled.terminal ? { terminal: true } : {}) };
}

/**
 * 逐条审批的处理器要等 manager 解析完才建得出来：jail 的 root 必须是 `realpathSync(dir)`
 * （与 `session/new` 的 `cwd` 同一个字面量），而 agent 名字要等 `resolveAcpAgent` 挑完。
 * 所以 `AcpClientHooks.permission` 收的是一个**工厂**而不是一个处理器。
 */
export interface AcpPermissionBinding {
  /** 本次会话的 jail。**只用来判「这条路径在边界内吗 / 撞 denyGlobs 了吗」，不读写。** */
  jail: PathJail;
  agent: string;
  /**
   * 结论表达不出来时调它（agent 一个能表达我们答案的档都没给）—— 实现是 `session/cancel`
   * + `acp_permission_unanswerable`。**不能回 `{outcome:'cancelled'}` 糊过去**：那个词在协议里
   * 的意思是「client 取消了这一轮」，把「人拒绝了」说成「用户取消了」会让 agent 记错这一轮。
   */
  onUnanswerable(): void;
}

/**
 * 反向调用与呈现层的接入点。
 *
 * - `onUpdate`：每条 `session/update` 原样过一遍（呈现层）。**被 `maxUpdatesPerPrompt` 丢弃的
 *   那些不会给它** —— 上界的意义就是「后面这些我们不处理」，绕过上界喂给呈现层等于没有上界。
 * - `permission`：逐条审批（`docs/05 §3.5.3`）。**只在 `permissionMode === 'ask'` 那一档被调用，
 *   而它一旦给出处理器就完全接管，`floorPermission` 不再参与** —— 两者串联的话「谁先答」就变成
 *   一个要看代码才知道的问题。`signal` 在本次请求被取消 / 连接关闭时 abort，实现方**必须 settle**。
 */
export interface AcpClientHooks {
  onUpdate?(notification: SessionNotification): void;
  permission?(binding: AcpPermissionBinding): (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
}

type PermissionKind = RequestPermissionRequest['options'][number]['kind'];

/**
 * **不问人的那两档**（`auto` / `deny`）怎么答。**`auto` 是默认档**，所以这个函数是出厂路径。
 *
 * `auto` 选第一个 allow 档 —— 语义上诚实的一档：起这台 agent 本身已经过了一次审批，
 * **批准一次 = 批准它这一趟在那个目录里做的全部事情**（`docs/14` T17，Q8-c 原本的语义）。
 * `deny` 选第一个 reject 档；一个都没给时按协议回 `cancelled`（唯一不需要 optionId 的合法出口），
 * 而不是硬挑一个 allow —— `deny` 的语义不能因为对方没提供选项就翻过来。
 *
 * **`ask` 走的不是这里**，而是 `hooks.permission`（`acpPermissionGate`）。它落到这个函数上只有一种
 * 可能：运行时压根没接审批通道，而 `spawn_acp.available()` 本该已经把工具挡在目录外
 * （`permissionMode === 'ask'` 且没有 broker → 不进目录，照 `allowedDirs` 为空的同一形态）。
 * 真走到了就**按 `deny` 处理** —— 一个叫 `ask` 的档实际在放行，正是 `docs/reviews/16 §5` 说的
 * 伪造一道门。调用方据此把这一条记成 warn。
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
 * 反向调用面要用的宿主侧闸门。**由调用方从本轮 `turn.config` 现读再传进来**，`AcpManager` 自己
 * 不持有配置（`docs/11` 的 `agent.acp` 整段在热更新白名单里，靠的就是这条纪律）。
 *
 * 整段缺席 = **fs 与 terminal 都不申报**，回到「agent 自己直接碰磁盘」那条老路。分段用例（以及任何
 * 手工造 manager 的地方）落在这一档，缺省必须是「不申报」而不是「申报一个没实现的东西」。
 */
export interface AcpHostAccess {
  /**
   * jail 与 `FileTools` 的参数。**不复用 `dependencies.filesFor(workspace, role)`** ——
   * 那份的 root 是 `data/workspace/<chatId>`（`docs/14 Q8-b` 明说不复用），而且
   * `tools.fs.allowHostFsForOwner` 一开它的 root 就成了 `/`：ACP 这条路的边界必须是**这次被批准的
   * 那个仓库目录**，跟着一个全局开关走等于把「批准一个目录」变成「批准整台机器」。
   */
  fs: { denyGlobs: readonly string[]; maxReadBytes: number; maxWriteBytes: number; backupDir: string };
  /** `tools.exec.maxTimeoutMs` / `tools.exec.maxOutputBytes`。终端的硬期限与单个终端的输出上界。 */
  exec: { maxTimeoutMs: number; maxOutputBytes: number };
  /**
   * `sandbox.plan(role, root)`。**不是 `'host'` 就整个 terminal capability 不申报** ——
   * 申报了每次 create 都失败是最坏的形态：agent 会反复试，而它每次拿到的都是一个它没法据此改变
   * 行为的错。fail-closed 落在申报那一刻。
   */
  plan(root: string): { mode: 'host' | 'jail' | 'docker'; reason?: string };
}

export interface AcpRunOptions {
  abortSignal: AbortSignal;
  /**
   * 整个结果对象序列化之后的字节上界。**必须就是 `ToolRegistry.#normalizeOutput` 量的那一个**
   * （`main.ts` 把它接成 `tools.exec.maxOutputBytes`）—— 我们先量固定字段、把剩下的给
   * `output`，所以那道中间截断永不触发；给一个不相干的数字只会让这个保证悄悄失效。
   */
  outputBudgetBytes: number;
  hooks?: AcpClientHooks;
  host?: AcpHostAccess;
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
  /** 它自己那些工具调用里报了 `failed` 的条数。0 时不出现。「跑完了」与「跑完了但一半步骤失败了」
   *  是两件事，而 `stopReason: 'end_turn'` 说不出后者。 */
  failures?: number;
  thoughts?: number;
  /** 经 `fs/write_text_file` 改过的**不同**文件数。0 时不出现 —— 一次「什么都没写」的任务里
   *  这个数字比它占的字节更值钱：模型据此判断「它是不是只看了看」。 */
  filesWritten?: number;
  /** 起过的终端数（`terminal/create`）。0 时不出现。它是「命令到底跑了没有」唯一的凭据。 */
  terminals?: number;
  costUsd?: number;
  contextUsed?: number;
  ms?: number;
  /**
   * 有能力却没申报出去的理由，逐条人话。**这一份是给模型看的**，与 `acp.run` 那条 warn 的
   * `data.degraded` 同源（`AcpSurface.notes`）—— 此前它只进日志，运维在 WebUI 里看得见而模型一个字
   * 都看不到，于是模型让 agent 去跑命令、拿回一个说不清的失败、然后绕路或者编一个理由。0 条时
   * **不出现这个键**（同 `filesWritten` / `terminals`）。
   *
   * 按 `DEGRADED_MAX_NOTES` × `DEGRADED_NOTE_BYTES` 有界：其中一条 note 里嵌着 jail 构造失败的
   * `error.message`，那是不可控长度的。
   */
  degraded?: string[];
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
/**
 * 单条 `degraded` note 的字节上界。量出来的：`#surface` 里最长那条固定 note（`approvalMode` 被拨回
 * 非 yolo 那句）是 326 字节，384 给它留一点余量，于是**固定 note 一条都不会被截** —— 唯一会撞上
 * 这个数的是嵌着 jail 构造失败 `error.message` 的那条，而那正是它存在的理由。
 */
const DEGRADED_NOTE_BYTES = 384;
/**
 * `degraded` 的条数上界。`#surface` 一共能产出四条（jail 建不起来 / terminal 未申报 / 有 bash 而没
 * 终端 / 有 bash 而 approvalMode 被拨回非 yolo），所以上界就写四。**不写「今天最多同时出现两条」
 * 那个数**：那是从「jail 那条会提前 return」推出来的，加一条 note 就悄悄失效。
 */
const DEGRADED_MAX_NOTES = 4;
/** `clipToJsonBudget` 的收敛下限（它自己的 `Math.max(64, …)`）。低于这个预算就别裁了，整段丢。 */
const CLIP_FLOOR_BYTES = 64;
/** JSON-RPC 的 `auth_required`（SDK 的 `RequestError.authRequired`）。 */
const AUTH_REQUIRED_CODE = -32000;

const elision = (omitted: number): string => `\n…省略 ${omitted} bytes…\n`;

/** `resolveHarnessDir` 的判据，但**两侧都解 realpath**。见 `resolveAcpTarget` 里那段注释。 */
function insideRealAllowed(root: string, allowedDirs: readonly string[]): boolean {
  for (const entry of allowedDirs) {
    let base = resolve(entry);
    try { base = realpathSync(base); } catch { /* 名单里那条不存在，按字面比 */ }
    if (root === base || root.startsWith(`${base}${sep}`)) return true;
  }
  return false;
}

/** 挑哪台 agent、在哪个目录跑。`ok:false` 那一支带着已经分好档的失败。 */
export type AcpTarget = { ok: true; agent: AcpAgentSettings; root: string } | { ok: false; failure: AcpFailure; agent?: string; dir?: string };

/**
 * 三道门里「哪台 agent + 哪个目录」这一半。**一处实现两个调用方**：`run()` 拿它当准入判据，
 * 而工具壳拿它给进度卡片填表头（agent 名字与相对化路径的基点）—— 卡片自己再算一遍的话，
 * 「屏幕上说的目录」与「真的在跑的目录」就是两个可以分叉的答案。
 *
 * **realpath 是这一整趟的唯一目录字面量**：互斥键、jail 的 root+base、`session/new` 的 `cwd`、
 * 子进程的 cwd 全用它。互斥的理由是老的（两条软链指向同一个仓库时，按请求路径加锁等于没加）；
 * jail 与 `cwd` 的理由是新的：`resolveHarnessDir` 只做 `resolve()`，路径中间有一段软链时 agent 自己
 * 解析出来的绝对路径与 jail 的边界会是**两套字面量**，于是每一次 `fs/*` 都是一次越界拒绝。
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
  // 解不开就退回 `resolved`（目录刚被删这类情况，下一步的 spawn 会如实失败）。
  let root = resolved;
  try { root = realpathSync(resolved); } catch { /* 用 resolved */ }
  // 白名单在 realpath 上**再判一遍**。jail 的边界现在是 realpath，而 `allowedDirs` 里一条指向别处的
  // 软链原本只是「agent 在那儿跑」，现在还等于「jail 的边界在名单之外」。两侧都解析：只解析目标那
  // 一侧的话，`/home` 本身是软链的部署会把一份能用的配置判成越界。
  if (root !== resolved && !insideRealAllowed(root, settings.allowedDirs)) {
    return { ok: false, failure: acpFailure('acp_dir_not_allowed', `${resolved} → ${root}（软链解开之后落在白名单外）`), agent: agent.name };
  }
  return { ok: true, agent, root };
}

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

/**
 * 本次会话的反向调用面。`capabilities` 是**从 `fs` / `terminals` 在不在算出来的**，不是另一份要
 * 手动对齐的声明 —— 那两者与申报值分成两处写的话，迟早有一处漏改，而漏改的表现是一次挂死。
 */
interface AcpSurface {
  fs: AcpFs | null;
  terminals: AcpTerminals | null;
  jail: PathJail | null;
  capabilities: ClientCapabilities;
  /** 有能力没申报出去的理由，逐条人话。进 `acp.run` 的 `data.degraded` 并把那一行抬成 warn。 */
  notes: string[];
}

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
  /**
   * 在途会话的终端集合。三道 release 兜底的**第三道**（进程关停）—— 前两道是 `abortSignal` 与
   * `#run` 的 `finally`。`close()` 只关子进程的话，agent 让我们起的那些命令还在宿主上跑着，
   * 而它们继承的是**本进程**的生命周期之外的东西（`detached: true`），没人收就是真孤儿。
   */
  readonly #terminals = new Set<AcpTerminals>();

  /**
   * `runs` 可选：给了就把每次调用落一行 `agent_runs`（外部花费进 `external_cost_usd`，`cost_usd`
   * 恒 0 —— 见 `runs.ts` 顶部）。缺席时照旧跑，只是那次调用在 trace 骨架上没有行 —— 分段用例与
   * 任何手工造 manager 的地方落在这一档，而**记账失败绝不改变调用的结果**（见 `#record`）。
   */
  constructor(private readonly log: LogSink, private readonly runs?: AcpRunLedger) {}

  /**
   * 跑一次 ACP 任务。三道门的第二道（目录）在这里判第二遍 —— `available()` 判过一次，
   * 热更新可能在注册与执行之间把名单清空（同 `spawn_harness` 的做法）。
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
    // `agent_runs.started_at` 要的是墙钟。`performance.now()` 那个是单调时钟，只用来算 `ms`。
    const startedAt = Date.now();
    // 聚合期的上界只跟 `agents[].maxOutputBytes` 有关：2× 是为了让末尾那次从中间截断能保住头尾
    // （同 `runHarness`）。真正交回去多少由下面**量出来**的预算定 —— 那时才知道 hint / detail /
    // stderr 各占了多少。
    const sink = new AcpUpdateSink({ maxUpdates: settings.maxUpdatesPerPrompt, maxTextBytes: agent.maxOutputBytes * 2, maxCostUsd: settings.maxCostUsd,
      ...(options.hooks?.onUpdate ? { onUpdate: options.hooks.onUpdate } : {}) });
    const surface = this.#surface(agent, dir, settings, options);
    /**
     * 三道 release 兜底的**第一道**：用户 `/cancel`。少了它，一次被取消的调用会留下一条在宿主上
     * 接着跑的命令，而没有任何人还在等它的输出。另两道是下面的 `finally`（工具返回路径）与
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
      // 第二道兜底。**排在结果组装之前** —— `leaked` 要进那条 `acp.run`，而漏 release 是 agent 的
      // bug：不落一行的话「命令还在宿主上跑」这件事在任何地方都说不出口。
      surface.terminals?.releaseAll();
      if (surface.terminals) this.#terminals.delete(surface.terminals);
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
      updates: sink.updates, updatesDropped: sink.dropped, toolCalls: sink.toolCalls,
      ...(sink.failures > 0 ? { failures: sink.failures } : {}),
      thoughts: sink.thoughts,
      // 两个「它到底动了什么」的凭据，都只在非 0 时出现。`stopReason: 'end_turn'` + 一份漂亮的
      // 总结 + `filesWritten: 0` 是一次真实见过的组合（它只是读了读然后描述了一遍）。
      ...(surface.fs && surface.fs.writes > 0 ? { filesWritten: surface.fs.writes } : {}),
      ...(surface.terminals && surface.terminals.created > 0 ? { terminals: surface.terminals.created } : {}),
      ...(sink.costUsd === null ? {} : { costUsd: sink.costUsd }),
      ...(sink.contextUsed === null ? {} : { contextUsed: sink.contextUsed }),
      ms: Math.round(performance.now() - started),
      // 降级同时进结果与日志：`data.degraded` 给运维，这一份给模型。**排在 stderr / output 之前** ——
      // 「它执行不了」这句话被中间截断吃掉的话，模型会照着一份自己编的解释往下走。
      ...(surface.notes.length ? { degraded: surface.notes.slice(0, DEGRADED_MAX_NOTES)
        .map((note) => elideMiddleBytes(note, DEGRADED_NOTE_BYTES, elision).value) } : {}),
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
    const leaked = surface.terminals?.leaked ?? [];
    const runId = this.#record(agent, dir, task, result, sink, surface, startedAt, options.trace);
    /**
     * **`acp.run` 这一行同时是反向调用面那两条 warn 的落点** —— `docs/10 §2` 那张 kind 表被
     * `tests/docs.test.ts` 双向焊住，为「terminal 没申报」和「agent 漏了 release」各开一个新 kind
     * 就是两条只在异常路径上出现的枚举值。它们进这一行的 `data`，并且**把这一行抬成 warn**：
     * 前者是运维要看见的一次能力降级（`sandbox.mode` 配成了 docker 而 owner 不在 `bypassRoles` 里），
     * 后者是 agent 的协议 bug（我们替它收拾了，但那意味着有命令在宿主上跑到了我们收摊的时候）。
     */
    const degraded = surface.notes.length > 0 || leaked.length > 0;
    this.log.event({ level: result.ok && !degraded ? 'info' : 'warn', kind: 'acp.run',
      summary: `acp ${result.ok ? 'ok' : failure!.error} · ${agent.name} · ${dir}${surface.notes.length ? ` · ${surface.notes.join(' · ')}` : ''}${leaked.length ? ` · ${leaked.length} 个终端没 release` : ''}`,
      ...this.#trace(options.trace),
      data: { agent: agent.name, dir, command: agent.command, approvalMode: agent.approvalMode, stopReason: stopReason ?? null,
        error: failure?.error ?? null, updates: sink.updates, dropped: sink.dropped, toolCalls: sink.toolCalls,
        capabilities: Object.keys(surface.capabilities), degraded: surface.notes, filesWritten: surface.fs?.writes ?? 0,
        terminals: surface.terminals?.created ?? 0, terminalsLeaked: leaked.length,
        // `costUsd` 在这条 kind 上一直是「外部 agent 自己报的那个数」，与 `agent_runs.cost_usd`
        // （本系统的钱，ACP 行恒 0）不是一回事 —— 所以那一列的值落在 `external_cost_usd` 上，
        // 而不是在这里换个名字再说一遍。`runId` 是这一行与库里那一行之间唯一的接缝。
        costUsd: sink.costUsd, runId, ms: result.ms } });
    return result;
  }

  /**
   * 落那一行 `agent_runs`。**吞掉自己的异常**：记账失败不该把一次已经改完仓库的成功调用变成失败
   * （反过来更糟 —— 模型会以为什么都没发生）。失败留一条 warn，而它复用 `acp.run` 这个 kind：
   * `docs/10 §2` 那张表被 `tests/docs.test.ts` 双向焊住，为一条只在写库出错时出现的事新开一个
   * 枚举值不值得。
   *
   * 没有 `traceId` 时**不落行**：`agent_runs.turn_id` 挂不上 turn 的行没有读法（trace 树进不去、
   * `ix_agentruns_turn` 上是一条查不出来的孤儿）。生产的调用方恒传，落在这一档的只有用例。
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
         * `external_usage_json` 的载荷。**自描述**（`source` / `agent` / `model` 都在里面）——
         * 读的人第一眼要能看出这些数字的出处不是本系统，否则它与旁边那些自己的读数长得一样。
         * 这里一个 token 数都没有：`usage_update` 给的是上下文占用（`used` / `size`）与一个
         * 已经算好的金额，没有 tokens × prices 可以重算（`ledger/quota.ts` 删掉 `modelCost()`
         * 时的那条禁令：计价只有一份判据）。
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
   * 本次会话的反向调用面：jail、fs、终端，以及**据此算出来的** `clientCapabilities`。
   *
   * 顺序是判据：先把能力建出来，建成了才申报。反过来（先申报再建）的那一版，中间每一次
   * `fs/read_text_file` 都是一次挂死 —— 而此刻 agent 正握着一个半改完的文件。
   */
  #surface(agent: AcpAgentSettings, root: string, settings: AcpSettings, options: AcpRunOptions): AcpSurface {
    const notes: string[] = [];
    const host = options.host;
    if (!host) return { fs: null, terminals: null, jail: null, capabilities: {}, notes };
    let jail: PathJail;
    try { jail = new PathJail(root, [...host.fs.denyGlobs], { base: root }); }
    catch (error) {
      // jail 建不起来（目录在这一瞬被删、权限没了）—— 这一档**不申报任何能力**而不是让整次调用失败：
      // agent 会退回自己直接碰磁盘，产出照旧拿得到，而降级本身进那条 `acp.run` warn。
      notes.push(`fs 未申报（jail 建不起来：${error instanceof Error ? error.message : String(error)}）`);
      return { fs: null, terminals: null, jail: null, capabilities: {}, notes };
    }
    const files = new FileTools(jail, host.fs.maxReadBytes, host.fs.maxWriteBytes, { backupDir: host.fs.backupDir });
    // 终端要**宿主直跑**（cwd = 会话 root）。不是 `'host'` 就整个 capability 不申报，而不是申报了
    // 每次 create 都失败 —— 见 `AcpHostAccess.plan` 那段。
    const plan = host.plan(root);
    const terminals = plan.mode === 'host'
      ? new AcpTerminals(jail, root, { maxTerminals: settings.maxTerminals, maxTimeoutMs: host.exec.maxTimeoutMs, maxOutputBytes: host.exec.maxOutputBytes })
      : null;
    if (!terminals) notes.push(`terminal 未申报（sandbox.plan=${plan.mode}${plan.reason ? `：${plan.reason}` : ''}）`);
    // `agents[].tools` 里配了 `bash` 而终端没申报 = 一个可证明用不了的工具在它的目录里。
    // 那正是上一轮把 `bash` 从默认值里摘掉的理由，配置里又写回来时要说出来。
    if (!terminals && agent.tools.includes('bash')) notes.push('agents[].tools 里有 bash，但 terminal 没申报 —— 它执行不了');
    /**
     * ⚠️ **申报 `terminal` 是让 `bash` 能跑的必要条件，不是充分条件。** omp 17.4.0 实测：
     * `approvalMode` 不是 `yolo` 时，它会把 `bash` 问过来（`session/request_permission`，kind
     * `execute`，四个档一个不少），我们从它自己给的 options 里挑一个 `allow_always` 回过去，
     * 它照旧把那次调用记成 `Tool call denied by user: bash` —— `terminal/create` 一次都不发生
     * （`terminals: 0`）。换成 `yolo` 之后同一条命令立刻走通（`terminals: 1`，跑的是我们的终端）。
     *
     * 也就是说卡住它的是 **agent 自己内部那道审批**，而不是本客户端的能力申报或我们的回答。
     * 这个组合因此是一个可证明用不了的工具留在配置里 —— 模型会试、失败、然后绕路或编一个理由，
     * 而唯一能让它说得出口的地方就是这一行（「摘除比伪造安全」，`docs/16 §5`）。
     *
     * **默认值现在就是 `yolo`**（需求方拍板：整趟交给它），所以这条 warn 只在运维**主动**把它拨回
     * `write` / `always-ask` 而又留着 `bash` 时出现 —— 也就是「界面上配了、运行时用不了」那个形态。
     * 取舍写在 `docs/05 §3.5.1`。
     */
    if (terminals && agent.tools.includes('bash') && agent.approvalMode !== 'yolo') {
      notes.push(`agents[].tools 里有 bash，而 approvalMode=${agent.approvalMode}（默认是 yolo，这是被改过的）—— 实测 omp 在这一档会把 bash 问过来、我们放行、它照旧自己拒掉（terminal 一次都没用上）。要它真能跑命令得配 approvalMode: yolo；想逐条拦就把 agent.acp.permissionMode 拨到 ask`);
    }
    return { fs: new AcpFs(files), terminals, jail, capabilities: acpClientCapabilities({ fs: true, terminal: Boolean(terminals) }), notes };
  }

  #trace(trace?: AcpTrace): { traceId?: string; chatId?: string; userId?: string; key?: string } {
    return { ...(trace?.traceId ? { traceId: trace.traceId } : {}), ...(trace?.chatId ? { chatId: trace.chatId } : {}),
      ...(trace?.userId ? { userId: trace.userId } : {}), ...(trace?.key ? { key: trace.key } : {}) };
  }

  /** spawn → 连接 → initialize（含版本协商与 authenticate 那一支）→ `session/new` → 会话模式。 */
  async #open(agent: AcpAgentSettings, dir: string, settings: AcpSettings, sink: AcpUpdateSink, options: AcpRunOptions, surface: AcpSurface): Promise<OpenOutcome> {
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
      /**
       * 逐条审批的处理器。**只在 `ask` 那一档、且运行时真接上了审批通道时存在**；给出来就完全接管，
       * `floorPermission` 不再参与（串联的话「谁先答」变成一个要看代码才知道的问题）。
       *
       * `jail` 为 null（没有 `host`）时拿不到边界判据，那时按没有 gate 处理 —— 落到地板上的 `ask`
       * 是**按 deny 算**的，fail-closed 在这一侧。
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
          // `ask` 落到地板上 = 运行时压根没接审批通道，而 `available()` 本该已经把工具挡在目录外。
          // 一条 warn 是这件事唯一的凭据 —— 而答案是**拒绝**，不是放行：一个叫 `ask` 的档实际在放行
          // 正是 `docs/reviews/16 §5` 说的伪造一道门。
          this.log.event({ level: settings.permissionMode === 'ask' ? 'warn' : 'info', kind: 'acp.permission',
            summary: `${agent.name} 请求权限（${ctx.params.toolCall.kind ?? 'other'}）→ ${settings.permissionMode === 'ask' ? 'ask 档没有审批通道，按 deny 处理' : settings.permissionMode}`,
            ...this.#trace(options.trace),
            data: { agent: agent.name, mode: settings.permissionMode, gated: false, kind: ctx.params.toolCall.kind ?? null,
              title: ctx.params.toolCall.title ?? null, outcome: response.outcome.outcome } });
          return response;
        })
        /**
         * 反向 fs（`docs/05 §3.5.2`）。**`surface.fs` 为 null 时照旧抛 `methodNotFound`** ——
         * 那一档我们压根没申报（`acpClientCapabilities` 是从它算出来的），而不守规矩的 agent 应该
         * 拿到一个干净的错，不是一个挂住的请求。
         *
         * 读走的是 `FileTools.readText` 而**不是** `read()`：后者无条件加 `行号<TAB>` 前缀，而 ACP 的
         * 写是全量覆盖 —— 读出来改两行写回去就把整个文件换成带行号的垃圾（理由全文在 `fs.ts`）。
         */
        .onRequest('fs/read_text_file', (ctx) => {
          if (!fs) throw RequestError.methodNotFound('fs/read_text_file');
          return fs.readTextFile(ctx.params);
        })
        .onRequest('fs/write_text_file', (ctx) => {
          if (!fs) throw RequestError.methodNotFound('fs/write_text_file');
          return fs.writeTextFile(ctx.params);
        })
        // 反向终端（`docs/05 §3.5.2`）。同上：没申报的那一档抛 `methodNotFound`。
        .onRequest('terminal/create', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/create');
          return terminals.create(ctx.params);
        })
        .onRequest('terminal/output', (ctx) => {
          if (!terminals) throw RequestError.methodNotFound('terminal/output');
          return terminals.output(ctx.params.terminalId);
        })
        // `signal` 在这条请求被取消 / 连接关闭时触发，**必须 settle** —— 不 settle 的话 SDK 那侧留一个
        // 永不应答的请求，而 agent 就挂在那儿。`waitForExit` 自己认它。
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
    // 终端排在子进程**之前**：先把 agent 让我们起的那些命令杀掉，再收 agent 本身。反过来的话
    // 那一小段窗口里 agent 已经没了而它的命令还在往一条没人读的管道里写。
    for (const terminals of [...this.#terminals]) {
      const live = terminals.releaseAll();
      if (live.length) this.log.event({ level: 'warn', kind: 'acp.run', summary: `关停时收拾了 ${live.length} 个没 release 的 ACP 终端`, data: { terminalsLeaked: live.length, at: 'shutdown' } });
      this.#terminals.delete(terminals);
    }
    for (const child of [...this.#children]) void this.#discard(child, this.#connections.get(child));
    await Promise.all([...this.#closing]);
  }
}
