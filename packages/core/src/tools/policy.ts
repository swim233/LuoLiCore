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
  edit_file: { minRole: 'trusted', approval: 'never', scope: 'workspace', source: 'builtin' },
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
