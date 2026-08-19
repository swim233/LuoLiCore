import { roleRank, type Role } from '@luoli/shared';

export const APPROVAL_POLICIES = ['never', 'conditional', 'always'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];
export type ToolScope = 'workspace' | 'chat' | 'private' | 'global' | 'sandbox' | 'telegram';

export interface ToolPolicyEntry {
  minRole: Role;
  approval: ApprovalPolicy;
  scope: ToolScope;
  source: 'builtin' | 'agent' | 'plugin' | 'mcp' | 'custom';
}

export const TOOL_POLICY = {
  read_file: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' },
  list_dir: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' },
  glob: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' },
  grep: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' },
  write_file: { minRole: 'trusted', approval: 'conditional', scope: 'workspace', source: 'builtin' },
  // `edit_file` 与 `write_file` **同档**。`FileTools.edit()` 最后一步就是 `return this.write(...)`，
  // 而它可以把整份文件换掉（`oldString` 取全文、或 `replaceAll`）；`write_file` 带
  // `approvalTargetExists` 说明「覆盖已存在的文件要审批」正是设计意图，而 `edit_file` 恰好**只**
  // 作用于已存在的文件 —— 标成 never 等于给覆盖审批留了一条绕道（docs/27 · C-03）。
  edit_file: { minRole: 'trusted', approval: 'conditional', scope: 'workspace', source: 'builtin' },
  move_file: { minRole: 'trusted', approval: 'conditional', scope: 'workspace', source: 'builtin' },
  delete_file: { minRole: 'trusted', approval: 'always', scope: 'workspace', source: 'builtin' },
  bash: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' },
  python: { minRole: 'trusted', approval: 'conditional', scope: 'sandbox', source: 'builtin' },
  search_messages: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' },
  read_messages: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' },
  get_message: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' },
  context_stats: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' },
  admin_search_messages: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin' },
  memory_read: { minRole: 'limited', approval: 'never', scope: 'private', source: 'builtin' },
  memory_write: { minRole: 'limited', approval: 'conditional', scope: 'private', source: 'builtin' },
  memory_list: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin' },
  spawn_agent: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' },
  list_agents: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' },
  read_agent_result: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' },
  ask_parent: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' },
  report_progress: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' },
  set_model: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'agent' },
  web_fetch: { minRole: 'limited', approval: 'never', scope: 'global', source: 'builtin' },
  web_search: { minRole: 'limited', approval: 'never', scope: 'global', source: 'builtin' },
  send_message: { minRole: 'limited', approval: 'never', scope: 'telegram', source: 'builtin' },
  send_photo: { minRole: 'limited', approval: 'never', scope: 'telegram', source: 'builtin' },
  react: { minRole: 'limited', approval: 'never', scope: 'telegram', source: 'builtin' },
  send_file: { minRole: 'trusted', approval: 'never', scope: 'telegram', source: 'builtin' },
  pin_message: { minRole: 'trusted', approval: 'never', scope: 'telegram', source: 'builtin' },
  load_skill: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' },
  // 定时任务是唯一能让 bot 在没人说话时主动花钱的能力，所以起点是 trusted 而不是 limited；
  // 作用域是 chat 而不是 global —— 落点绑死本会话，工具参数里没有 chatId（docs/05 §8）。
  // list / cancel 同样收在 trusted：能看见任务名就能看见别人排了什么。
  schedule_create: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  schedule_list: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  schedule_cancel: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  // M11 · 起一个外部 harness CLI（Claude Code / Codex）改宿主上的仓库（docs/14 §2 Q8）。
  // `owner` + `approval: 'always'` 是这张表能表达的最严档位，另外两道门（仅私聊、目录白名单）
  // 在 `available()` 里 —— 它们判的是本轮上下文与配置，不是角色。
  // **它内部的工具调用不受这套策略约束**（docs/14 T17）：本系统看不见 harness 的内部行为。
  spawn_harness: { minRole: 'owner', approval: 'always', scope: 'global', source: 'agent' },
  // M12 · 自我扩展（docs/07 §6）。八条全部 `owner`，理由同 `spawn_harness`：`resolveEffectiveRole`
  // 会把不受信群里的 owner 压平，所以这一档实际含义是「owner 且在 owner 信任的会话里」。
  //
  // 五个写工具是 `approval: 'always'`。owner 因 `approval.skipForOwner`（默认 true）通常无感，
  // 但这一档在表里是诚实的，并且给了运维一个真实的杠杆：关掉 `skipForOwner` 之后每一次自撰写
  // 都要点头。**它不是这套东西的主闸** —— 主闸是「落库即禁用，owner 在 WebUI 点开」。
  define_tool: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  delete_tool: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  list_tools: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin' },
  write_skill: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  install_skill: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  write_plugin: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  install_mcp: { minRole: 'owner', approval: 'always', scope: 'global', source: 'builtin' },
  list_mcp: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin' },
  // 会话级持久容器的管理（docs/05 §3.11）。六条全部 `owner`，理由同上；另外两道门
  // （持久化没开时整族不进目录、`chat` 参数的会话解析）在 `available()` / `execute()` 里。
  //
  // **这是本表里唯一一族收落点参数的工具**（§8「参数里没有 chatId」的例外），所以那道
  // owner 地板必须同时焊在 `available()` 里 —— 运维改得动 `minRole`，改不动 `available()`。
  container_list: { minRole: 'owner', approval: 'never', scope: 'sandbox', source: 'builtin' },
  container_exec: { minRole: 'owner', approval: 'conditional', scope: 'sandbox', source: 'builtin' },
  container_reset: { minRole: 'owner', approval: 'conditional', scope: 'sandbox', source: 'builtin' },
  container_inspect: { minRole: 'owner', approval: 'never', scope: 'sandbox', source: 'builtin' },
  container_keep: { minRole: 'owner', approval: 'never', scope: 'sandbox', source: 'builtin' },
  container_logs: { minRole: 'owner', approval: 'never', scope: 'sandbox', source: 'builtin' },
} as const satisfies Record<string, ToolPolicyEntry>;

export type ToolName = keyof typeof TOOL_POLICY;

/**
 * docs/07 §4 收窄公式里的「核心工具集」：skill 的 `allowed-tools` 收窄不到这几个。
 *
 * `allowed-tools` 表达的是「这件事要用哪些工具」，不是「这一轮不许再干别的」。一个
 * `allowed-tools: [bash]` 的 skill 曾经把 `send_message` / `report_progress` / `context_stats`
 * 一起关掉，于是模型跑完 skill 连一句话都追发不出去、子 agent 连进度都报不了。
 *
 * 这不是放权：skill 的 `allowed-tools` 只能是角色白名单的子集（docs/07 §2），豁免这几个
 * 交回去的仍然是该角色本来就有的东西。
 */
export const SKILL_NARROWING_EXEMPT: readonly ToolName[] = ['load_skill', 'send_message', 'report_progress', 'context_stats'];

/**
 * 运维在工具页按下的那一份覆盖（`tools.overrides.<name>`，docs/09 §3.7）。
 *
 * 后三项都是可缺席的，**没有默认值**：字段不在 = 用代码里那份。给它们写死一个默认值等于把每一条
 * 历史覆盖行钉在写它那天的策略上 —— 此后 `TOOL_POLICY` 怎么改都推不动这些工具，而覆盖层本来
 * 只该表达「这台机器上我要偏离多少」。
 */
export interface ToolOverride { enabled?: boolean | undefined; minRole?: Role | undefined; approval?: ApprovalPolicy | undefined; timeoutMs?: number | undefined }

/** `never < conditional < always`，数字越大越严。与 `APPROVAL_POLICIES` 的下标同序。 */
export function approvalRank(policy: ApprovalPolicy): number { return APPROVAL_POLICIES.indexOf(policy); }

/**
 * 代码默认 + 运维覆盖 → 本次生效的策略。
 *
 * **只有这一份合并实现**，`ToolRegistry` 与 `GET /api/tools` 共用。分成两份必然漂移，而漂移的
 * 表现是界面上显示的权限和运行时判的不是一回事 —— 运维照着面板以为自己关严了。
 */
export function effectiveToolPolicy(base: ToolPolicyEntry, override?: ToolOverride): ToolPolicyEntry {
  if (!override) return base;
  return { ...base, minRole: override.minRole ?? base.minRole, approval: override.approval ?? base.approval };
}

/**
 * 覆盖里哪些字段**比代码默认更松**。空数组 = 纯收紧、或者根本没动。
 *
 * `timeoutMs` 不在其列：它是资源旋钮不是权限闸，照样进审计但不该拦着人改。`enabled` 同样不算 ——
 * 启停一直是这个面板的既有能力，把「重新启用」也做成要确认只会让人对确认框脱敏。
 */
export function relaxedFields(base: ToolPolicyEntry, override?: ToolOverride): Array<'minRole' | 'approval'> {
  const effective = effectiveToolPolicy(base, override);
  const out: Array<'minRole' | 'approval'> = [];
  if (roleRank(effective.minRole) < roleRank(base.minRole)) out.push('minRole');
  if (approvalRank(effective.approval) < approvalRank(base.approval)) out.push('approval');
  return out;
}
