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
  // 折叠工具的检索入口（docs/07 §5）。与 `load_skill` 同档同族：两个都是渐进披露的元工具
  // （一个展开 skill 正文、一个展开工具 schema），所以门槛取最低的 `limited` —— 它自己什么都
  // 做不了，只把「本轮你还能调什么」如实报出来，而检索域是从 `active()` 派生的，角色过滤已经
  // 在上游做完了（limited 枚举不到 owner 工具的描述）。**开关不在这一栏上**：折叠集为空时
  // `available()` 让它整个不进目录（纯内建部署的提示词逐字节不变）。
  search_tools: { minRole: 'limited', approval: 'never', scope: 'global', source: 'builtin' },
  // 定时任务是唯一能让 bot 在没人说话时主动花钱的能力，所以起点是 trusted 而不是 limited；
  // 作用域是 chat 而不是 global —— 落点绑死本会话，工具参数里没有 chatId（docs/05 §8）。
  // list / cancel / update 同样收在 trusted：能看见任务名就能看见别人排了什么。
  schedule_create: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  schedule_update: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  schedule_list: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  schedule_cancel: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  // 「本轮不用汇报」（docs/02 §10.5）。角色档与 `schedule_create` 对齐——能排一条静默任务的人
  // 才可能触发一条静默轮次——但**真正的边界不在这一栏上**：两道闸（`agentKind==='main'` 且
  // 本轮 `silenceable`）焊在 `available()` 里，运维把 `tools.overrides.stay_silent.minRole`
  // 调到 limited 也开不出来（docs/05 §4 脚注 ¶，同自定义工具与容器那两道地板）。
  stay_silent: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' },
  // M11 · 起一个外部 harness CLI（Claude Code / Codex）改宿主上的仓库（docs/14 §2 Q8）。
  // `owner` + `approval: 'always'` 是这张表能表达的最严档位，另外两道门（仅私聊、目录白名单）
  // 在 `available()` 里 —— 它们判的是本轮上下文与配置，不是角色。
  // **它内部的工具调用不受这套策略约束**（docs/14 T17）：本系统看不见 harness 的内部行为。
  spawn_harness: { minRole: 'owner', approval: 'always', scope: 'global', source: 'agent' },
  // M13 · 同一件事换成协议（ACP）而不是 argv：起一台本机编码 agent 改宿主上的仓库。
  // 档位与 `spawn_harness` **逐字相同**，而且必须相同 —— 两者的风险面是同一个（`docs/14` T17），
  // 差别只在「它的内部动作我们看得见多少」，而看得见不等于拦得住 —— `session/request_permission`
  // 现在真的接到审批链上了（`docs/05 §3.5.3`），而那**不是**放松这一档的理由：它只看得见 agent
  // 选择问过来的那些动作，`ast_edit` / `eval` / `computer` 压根不经这条链。用可观测性换权限是错的方向。
  spawn_acp: { minRole: 'owner', approval: 'always', scope: 'global', source: 'agent' },
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
 *
 * `search_tools` 在列的理由与 `load_skill` 同一条：元能力不是作业工具。一个
 * `allowed-tools: [bash]` 的 skill 把检索入口一起关掉之后，模型既看不见折叠工具的 schema、
 * 又没有办法问「我还能调什么」—— 而收窄本身照旧生效（展开过的工具仍被 `admit()` 挡住，
 * `search_tools` 因此必须如实回一个 `status: 'narrowed'`）。
 */
export const SKILL_NARROWING_EXEMPT: readonly ToolName[] = ['load_skill', 'search_tools', 'send_message', 'report_progress', 'context_stats'];

/**
 * 目录折叠（`tools.catalog.*`，docs/07 §5）永远不折叠的那两个 —— 渐进披露的**入口**。
 *
 * 折叠它们等于把梯子收走：`load_skill` 被折叠时模型看不见怎么载入 skill 正文，`search_tools`
 * 被折叠时连「有哪些折叠工具」都问不出来，而折叠摘要行里那句「用 search_tools 展开」指向一个
 * 它发不出调用的名字。所以运维用 `tools.catalog.defer` 点名这两个时**静默不生效**。
 */
export const DEFER_EXEMPT: readonly ToolName[] = ['search_tools', 'load_skill'];

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
