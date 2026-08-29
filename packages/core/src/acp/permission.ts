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
 * `agent.acp.permissionMode` 三档中只有 `ask` 走此处：`auto` / `deny` 是不询问人工的两档，
 * 由 `floorPermission` 在 manager 中直接应答（提供该 gate 即完全取代下限逻辑，两者不串联
 * —— 串联会使应答优先级成为必须查阅代码才能确定的问题）。
 */

/**
 * `approvals.tool_name` 恒为该值，不按 `kind` 拆分为 `acp:edit` 之类的名字。
 *
 * `ApprovalRules` 的 pattern 对 `JSON.stringify(input)` 求值，而本路径的 input 中已包含
 * `"kind":"execute"`，精度足够。增加一批工具名带来的后果是：WebUI 工具页多出一批不可操作的行、
 * `tools.overrides` 的键空间多出一批修改无效的键（该表只识别已注册的工具）。
 */
export const ACP_PERMISSION_TOOL_NAME = 'acp_permission';
/**
 * `approvals.decision_channel` 的第四个取值（前三个为 `telegram` / `webui` / `system`，见
 * `docs/03` 的 `approvals` 段）。它标记结论的来源通道而非决策主体 —— 后者记录在
 * `decided_by`，会话内 always 命中时写 `acp:always`。两列取相同值会使按通道分桶的查询多出一个
 * 取值域外的桶，而审批卡该字段渲染的正是 `decided_by · decision_channel`。
 */
export const ACP_DECISION_CHANNEL = 'acp';

/**
 * `toolCall.kind` → 审批风险档，与本系统同类工具对齐（`docs/05 §4` 的矩阵）：
 *
 * - `execute` → high：对应 `bash` / `spawn_harness` 一族，`spawn_acp` 自身即 `approval: 'always'`
 * - `delete` → high：`delete_file` 为 `always`
 * - `edit` / `move` → medium：`edit_file` / `move_file` 为 `conditional`
 * - `read` / `search` / `fetch` / `think` → low
 * - 其余（含 `switch_mode`、`other`，以及 agent 未提供 kind）→ medium，不下调档位。
 *   本层的输入是外部 agent 生成的 JSON：未识别的 kind 更可能是新增的高风险动作，
 *   而非一次无害的读取。
 *
 * 路径落在 jail 之外或命中 `tools.fs.denyGlobs` 时一律提升为 high —— 此时操作对象
 * 已超出本次会话应触及的范围，kind 的取值不再具有参考价值。
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

/** 审批链上本路径所需的两个动作。由 `DatabaseApprovalBroker` 实现。 */
export interface AcpApprovalBroker {
  requestExternal(request: ExternalApprovalRequest): Promise<ApprovalVerdict>;
  recordDecided(request: ExternalApprovalRequest & { approved: boolean; decidedBy: string; channel: string }): void;
}

export interface AcpPermissionGateOptions {
  approvals: AcpApprovalBroker;
  context: ToolExecutionContext;
  /** agent 名字，仅用于日志。 */
  agent: string;
  /** 本次会话的 jail。仅用于判定路径是否在边界内、是否命中 denyGlobs，不做读写。 */
  jail: PathJail;
  log: LogSink;
  /**
   * agent 未提供任何可表达本次结论的档位时调用一次 —— 实现为 `session/cancel`。
   *
   * 不能以 `{outcome:'cancelled'}` 敷衍：该值在协议中的含义是 client 取消了本轮，
   * 如此应答会使 agent 把人工拒绝记录为用户取消，而两者对应的后续行为完全不同
   * （前者应停止，后者应等待下一条指令）。
   */
  onUnanswerable: () => void;
}

const OPTION_KIND_ORDER = { allow: ['allow_once', 'allow_always'], reject: ['reject_once', 'reject_always'] } as const satisfies Record<string, readonly PermissionOptionKind[]>;

/**
 * 一次工具调用（即一条 ACP 会话）的权限闸。返回的函数直接接入 `AcpClientHooks` 的对应位置。
 *
 * `always` 的记忆是该闭包的局部变量，作用域恰为一次 `spawn_acp` 调用 ——
 * 与会话不落库属同一条纪律（`manager.ts` 顶部：持久化会把一次审批变成此后永久授权）。
 */
export function acpPermissionGate(options: AcpPermissionGateOptions): (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse> {
  /**
   * `allow_always` / `reject_always` 的落点。仅存于内存，绝不写入 `approval.rules`。
   *
   * 该表是运维面的配置：pattern 走 RE2 且长度 ≤128（`ApprovalRules`），写入绝对路径多半
   * 无法编译通过；更重要的是它会进入 `config_revisions` 与配置导出 —— 一次点击将变成永久
   * 全局授权，而操作者的预期只是放行当前这一步。
   *
   * 键取 `kind` + 第一条路径所在目录：agent 在同一目录内连续修改十个文件属常态，
   * 而切换目录值得再次询问。
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
    // `toolCallId` 进入 input 是刻意设计：`approval.rememberWithinTurn` 的记忆键包含 input，
    // 若不带每次变化的字段，agent 对同一文件的第二次请求会复用第一次的结论 ——
    // 而批准后再次修改正是本层需要暴露的行为。
    const input = { agent: options.agent, kind: kind ?? null, title: request.toolCall.title ?? null,
      paths, outsideJail: outside, toolCallId: request.toolCall.toolCallId };
    const base: ExternalApprovalRequest = { toolName: ACP_PERMISSION_TOOL_NAME, input, context, risk, exemptOwnerSkip: true };
    const key = `${kind ?? 'other'} ${paths[0] ? dirname(paths[0]) : ''}`;

    const option = (bucket: 'allow' | 'reject'): PermissionOption | undefined =>
      OPTION_KIND_ORDER[bucket].map((wanted) => request.options.find((entry) => entry.kind === wanted)).find((entry) => entry !== undefined);

    const record = (approved: boolean, decidedBy: string): void => {
      // `channel` 表示通道而非主体：`decidedBy` 中的 `acp:always` 表示决策方，而通道列的取值域为
      // `telegram` / `webui` / `system` / `acp`。两列写入相同字符串会使审批卡重复显示（docs/21 §18）。
      try { approvals.recordDecided({ ...base, approved, decidedBy, channel: ACP_DECISION_CHANNEL }); }
      catch (error) { log.event({ level: 'warn', kind: 'approval.receipt_failed', summary: 'acp always 决策写入数据库失败', traceId: context.turn.turnId, data: { error: error instanceof Error ? error.message : String(error) } }); }
    };

    /** 把批准 / 拒绝映射为一个 optionId。无法映射时如实失败 —— 绝不改用其他档位替代。 */
    const answer = (approved: boolean, decidedBy: string): RequestPermissionResponse => {
      const chosen = option(approved ? 'allow' : 'reject');
      if (!chosen) {
        // 结论无法表达的两种形态均在此处理：拒绝但无 reject 档（常见），批准但无 allow 档（罕见，
        // 但同样不能以 reject 冒充批准）。返回 JSON-RPC error 并立即取消本轮。
        options.onUnanswerable();
        throw RequestError.invalidParams({ toolCallId: request.toolCall.toolCallId, options: request.options.map((entry) => entry.kind) },
          `本次权限请求的结论为「${approved ? '批准' : '拒绝'}」，但 options 中没有可表达该结论的档位（收到：${request.options.map((entry) => entry.kind).join(' / ') || '空数组'}）。本轮已按协议取消。`);
      }
      // 此处选中的是 `*_always` 档，即已告知 agent 后续同样处理。此后对同一
      // (kind, 目录) 再次询问没有意义：结论已经给出。记入会话内存，下次直接按此应答，
      // 但审计行仍逐条写入。
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
      // 命中缓存同样写入一条 `approvals` 行。否则一次批准后修改 40 个文件在审计中
      // 只剩最初那一条，而 always 档恰恰最需要被统计。
      record(remembered === 'allow', 'acp:always');
      return answer(remembered === 'allow', 'acp:always');
    }

    // `signal` 在该请求被取消或连接关闭时触发。必须 settle —— 否则 SDK 侧会留下
    // 一个永不应答的请求，agent 将持续阻塞（即先申报后实现那一版的表现）。
    let onAbort!: () => void;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      onAbort = () => resolve('cancelled');
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    let verdict: ApprovalVerdict | 'cancelled';
    try { verdict = await Promise.race([approvals.requestExternal(base), cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
    // 该档使用 `cancelled` 是准确的：协议中其含义正是 client 取消了本次请求，此处确实如此。
    if (verdict === 'cancelled') {
      log.event({ level: 'info', kind: 'acp.permission', summary: `${options.agent} 请求权限（${kind ?? 'other'}）→ 取消`,
        traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
        data: { agent: options.agent, mode: 'ask', kind: kind ?? null, title: request.toolCall.title ?? null, outcome: 'cancelled', risk, paths: paths.length, outsideJail: outside } });
      return { outcome: { outcome: 'cancelled' } };
    }
    return answer(verdict.approved, 'human');
  };
}
