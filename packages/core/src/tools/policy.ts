import type { Role } from '@luoli/shared';

export type ApprovalPolicy = 'never' | 'always' | 'conditional';
export type ToolScope = 'workspace' | 'chat' | 'private' | 'global' | 'sandbox' | 'telegram';

export interface ToolPolicyEntry {
  minRole: Role;
  approval: ApprovalPolicy;
  scope: ToolScope;
  source: 'builtin' | 'agent' | 'plugin' | 'mcp';
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
