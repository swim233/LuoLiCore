import { dirname } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ExternalApprovalRequest } from '../approvals.js';
import type { LogSink } from '../log/sink.js';
import type { PathJail } from '../tools/jail.js';
import type { ApprovalRisk, ApprovalVerdict, ToolExecutionContext } from '../tools/registry.js';
import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse, ToolKind } from '@agentclientprotocol/sdk';

/**
 * M13 · `session/request_permission` → 本系统的审批链（`docs/05 §3.5.3`）。
 *
 * `agent.acp.permissionMode` 三档里只有 `ask` 走这里：`auto` / `deny` 是「不问人」的两档，
 * 它们由 `floorPermission` 在 manager 里直接答（**给了这个 gate 就完全取代地板，两者不串联**
 * —— 串起来的话「谁先答」变成一个要看代码才知道的问题）。
 */

/**
 * `approvals.tool_name` 恒为这一个，**不按 `kind` 拆成 `acp:edit` 这类名字**。
 *
 * `ApprovalRules` 的 pattern 是对 `JSON.stringify(input)` 求值的，而这条路的 input 里就有
 * `"kind":"execute"` —— 已经够精准。多一批工具名换来的是：WebUI 工具页上多出一批点不进去的行、
 * `tools.overrides` 的键空间里多出一批运维改了也没用的键（那张表只认注册过的工具）。
 */
export const ACP_PERMISSION_TOOL_NAME = 'acp_permission';

/**
 * `toolCall.kind` → 审批风险档，**与本系统同类工具对齐**（`docs/05 §4` 那张矩阵）：
 *
 * - `execute` → high：`bash` / `spawn_harness` 那一族，`spawn_acp` 自己就是 `approval: 'always'`
 * - `delete` → high：`delete_file` 是 `always`
 * - `edit` / `move` → medium：`edit_file` / `move_file` 是 `conditional`
 * - `read` / `search` / `fetch` / `think` → low
 * - **其余（含 `switch_mode`、`other`、以及 agent 压根没给 kind）→ medium，不猜低档。**
 *   这一层的输入是外部 agent 写的 JSON：一个我们不认识的 kind 更可能是新增的危险动作，
 *   而不是一次无害的读。
 *
 * 路径落在 jail 之外、或撞上 `tools.fs.denyGlobs` 时**一律抬到 high** —— 那时它要动的东西
 * 已经出了这次会话该碰的范围，kind 说什么都不重要了。
 */
export function acpPermissionRisk(kind: ToolKind | null | undefined, outsideJail: boolean): ApprovalRisk {
  if (outsideJail) return 'high';
  switch (kind) {
    case 'execute': case 'delete': return 'high';
    case 'edit': case 'move': return 'medium';
    case 'read': case 'search': case 'fetch': case 'think': return 'low';
    default: return 'medium';
  }
}

/** 审批链上这条路需要的两个动作。`DatabaseApprovalBroker` 实现它。 */
export interface AcpApprovalBroker {
  requestExternal(request: ExternalApprovalRequest): Promise<ApprovalVerdict>;
  recordDecided(request: ExternalApprovalRequest & { approved: boolean; decidedBy: string }): void;
}

export interface AcpPermissionGateOptions {
  approvals: AcpApprovalBroker;
  context: ToolExecutionContext;
  /** agent 名字，只进日志。 */
  agent: string;
  /** 本次会话的 jail。**只用来判「这条路径在边界内吗 / 撞 denyGlobs 了吗」，不读写。** */
  jail: PathJail;
  log: LogSink;
  /**
   * agent 一个能表达我们这次结论的档都没给时调它一次 —— 实现是 `session/cancel`。
   *
   * **不能回 `{outcome:'cancelled'}` 糊过去**：那个词在协议里的意思是「client 取消了这一轮」，
   * 撒这个谎会让 agent 把一次「人拒绝了」记成「用户取消了」，而它接下来的行为完全不同
   * （前者该停、后者该等下一条指令）。
   */
  onUnanswerable: () => void;
}

const OPTION_KIND_ORDER = { allow: ['allow_once', 'allow_always'], reject: ['reject_once', 'reject_always'] } as const satisfies Record<string, readonly PermissionOptionKind[]>;

/**
 * 一次工具调用（= 一条 ACP 会话）的权限闸。**返回的函数直接接成 `AcpClientHooks` 那个位置。**
 *
 * `always` 那份记忆是**这个闭包的局部变量**，所以它的作用域恰好是一次 `spawn_acp` 调用 ——
 * 与会话不落库是同一条纪律（`manager.ts` 顶部那段：存下来就把「一次审批」偷偷变成「此后永久」）。
 */
export function acpPermissionGate(options: AcpPermissionGateOptions): (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse> {
  /**
   * `allow_always` / `reject_always` 的落点。**只在内存里，绝不落成 `approval.rules`。**
   *
   * 那张表是运维面的配置：pattern 走 RE2 且 ≤128 字符（`ApprovalRules`），硬塞一条绝对路径进去
   * 多半直接编译不过；更要紧的是它会进 `config_revisions` 与配置导出 —— 一次点击变成一条**永久
   * 全局**授权，而按下去的人以为自己只是放过了眼前这一步。
   *
   * 键 = `kind` + 第一条路径所在的**目录**：agent 在同一个目录里连着改十个文件是常态，
   * 而「换个目录」值得再问一次。
   */
  const always = new Map<string, 'allow' | 'reject'>();
  const { approvals, context, jail, log } = options;

  const insideJail = (path: string): boolean => {
    try { jail.resolve(path); return true; }
    catch { return false; }
  };

  return async (request, signal) => {
    const kind = request.toolCall.kind;
    const paths = (request.toolCall.locations ?? []).map((location) => location.path).filter((path): path is string => typeof path === 'string' && path.length > 0);
    const outside = paths.some((path) => !insideJail(path));
    const risk = acpPermissionRisk(kind, outside);
    // `toolCallId` 进 input 是刻意的：`approval.rememberWithinTurn` 的记忆键含 input，
    // 不带一个每次都变的字段的话，agent 对同一个文件的第二次请求会拿到第一次的答案 ——
    // 而「批了之后它又改了一次」正是这一层要看得见的东西。
    const input = { agent: options.agent, kind: kind ?? null, title: request.toolCall.title ?? null,
      paths, outsideJail: outside, toolCallId: request.toolCall.toolCallId };
    const base: ExternalApprovalRequest = { toolName: ACP_PERMISSION_TOOL_NAME, input, context, risk, exemptOwnerSkip: true };
    const key = `${kind ?? 'other'} ${paths[0] ? dirname(paths[0]) : ''}`;

    const option = (bucket: 'allow' | 'reject'): PermissionOption | undefined =>
      OPTION_KIND_ORDER[bucket].map((wanted) => request.options.find((entry) => entry.kind === wanted)).find((entry) => entry !== undefined);

    const record = (approved: boolean, decidedBy: string): void => {
      try { approvals.recordDecided({ ...base, approved, decidedBy }); }
      catch (error) { log.event({ level: 'warn', kind: 'approval.receipt_failed', summary: 'acp always-decision 落库失败', traceId: context.turn.turnId, data: { error: error instanceof Error ? error.message : String(error) } }); }
    };

    /** 把「批 / 拒」翻成一个 optionId。翻不出来就是翻不出来 —— 绝不换一个档凑。 */
    const answer = (approved: boolean, decidedBy: string): RequestPermissionResponse => {
      const chosen = option(approved ? 'allow' : 'reject');
      if (!chosen) {
        // 表达不出结论的两种形态都在这里：拒绝但没有 reject 档（常见），批准但没有 allow 档（罕见，
        // 但同样不能拿 reject 冒充「批了」）。回一个 JSON-RPC error + 立刻取消这一轮。
        options.onUnanswerable();
        throw RequestError.invalidParams({ toolCallId: request.toolCall.toolCallId, options: request.options.map((entry) => entry.kind) },
          `本次权限请求的结论是「${approved ? '批准' : '拒绝'}」，而 options 里没有能表达它的档（收到的是 ${request.options.map((entry) => entry.kind).join(' / ') || '空数组'}）。这一轮已按协议取消。`);
      }
      // 我们选中的是 `*_always` 那一档 —— 也就是**已经告诉 agent「以后都这样」**。此后对同一个
      // (kind, 目录) 再问一次是纯粹的表演：答案已经给出去了。记进会话内存，下一次直接照答，
      // 但审计行照旧一条一条落。
      if (chosen.kind === 'allow_always' || chosen.kind === 'reject_always') always.set(key, approved ? 'allow' : 'reject');
      log.event({ level: approved ? 'info' : 'warn', kind: 'acp.permission',
        summary: `${options.agent} 请求权限（${kind ?? 'other'}）→ ${approved ? '批准' : '拒绝'}${decidedBy === 'acp:always' ? '（会话内 always）' : ''}`,
        traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
        data: { agent: options.agent, mode: 'ask', kind: kind ?? null, title: request.toolCall.title ?? null,
          outcome: chosen.optionId, risk, paths: paths.length, outsideJail: outside, decidedBy } });
      return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
    };

    const remembered = always.get(key);
    if (remembered) {
      // **命中也要落一条 `approvals` 行。** 不落的话「批了一次之后它改了 40 个文件」在审计里
      // 只剩最初那一条，而 always 这一档恰恰是最需要被数出来的。
      record(remembered === 'allow', 'acp:always');
      return answer(remembered === 'allow', 'acp:always');
    }

    // `signal` 在这条请求被取消 / 连接关闭时触发。**必须 settle** —— 不 settle 的话 SDK 那侧
    // 留着一个永不应答的请求，而 agent 就挂在那儿（那正是「先申报后实现」那一版的形态）。
    let onAbort!: () => void;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      onAbort = () => resolve('cancelled');
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    let verdict: ApprovalVerdict | 'cancelled';
    try { verdict = await Promise.race([approvals.requestExternal(base), cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
    // 这一档 `cancelled` 是**真话**：协议里它的意思正是「client 取消了这次请求」，而这里确实是。
    if (verdict === 'cancelled') {
      log.event({ level: 'info', kind: 'acp.permission', summary: `${options.agent} 请求权限（${kind ?? 'other'}）→ 取消`,
        traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
        data: { agent: options.agent, mode: 'ask', kind: kind ?? null, title: request.toolCall.title ?? null, outcome: 'cancelled', risk, paths: paths.length, outsideJail: outside } });
      return { outcome: { outcome: 'cancelled' } };
    }
    return answer(verdict.approved, 'human');
  };
}
