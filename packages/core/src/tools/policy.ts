import { roleRank, type Role } from "@luoli/shared";

export const APPROVAL_POLICIES = ["never", "conditional", "always"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];
/**
 * 谁在调这个工具（`docs/04 §1`）。`main` 只对话与派发，工具执行整体下沉给 `lw` —— 内建的轻任务
 * worker，拿的是调用者有效角色下的全集。`sdk` 是第三方经 `/sdk/v1` 接入的顶层入口
 * （`docs/12-sdk.md` T3.4，`docs/05 §3.13`），角色恒 `trusted`，不接派发，白名单见 `SDK_AGENT_TOOLS`。
 *
 * **没有 `harness` 这一档**：外部 harness 与 ACP 自带整套工具，它们内部的调用一次都不经过本注册表
 * （`docs/14` T17），因此没有任何代码会构造一个 harness 侧的 `ToolExecutionContext`。加一个谁都不产生
 * 的枚举值，等于在权限判据里放一条永远走不到的分支。
 */
export type AgentKind = "main" | "lw" | "sdk";
export type ToolScope =
  "workspace" | "chat" | "private" | "global" | "sandbox" | "telegram";

export interface ToolPolicyEntry {
  minRole: Role;
  approval: ApprovalPolicy;
  scope: ToolScope;
  source: "builtin" | "agent" | "plugin" | "mcp" | "custom";
}

export const TOOL_POLICY = {
  read_file: {
    minRole: "limited",
    approval: "never",
    scope: "workspace",
    source: "builtin",
  },
  list_dir: {
    minRole: "limited",
    approval: "never",
    scope: "workspace",
    source: "builtin",
  },
  glob: {
    minRole: "limited",
    approval: "never",
    scope: "workspace",
    source: "builtin",
  },
  grep: {
    minRole: "limited",
    approval: "never",
    scope: "workspace",
    source: "builtin",
  },
  write_file: {
    minRole: "trusted",
    approval: "conditional",
    scope: "workspace",
    source: "builtin",
  },
  // `edit_file` 与 `write_file` 同档。`FileTools.edit()` 最后一步即 `return this.write(...)`，
  // 且可替换整份文件（`oldString` 取全文或 `replaceAll`）；`write_file` 带
  // `approvalTargetExists` 表明覆盖已存在的文件需审批正是设计意图，而 `edit_file` 只作用于
  // 已存在的文件 —— 标为 never 等于为覆盖审批留下一条绕行路径（docs/27 · C-03）。
  edit_file: {
    minRole: "trusted",
    approval: "conditional",
    scope: "workspace",
    source: "builtin",
  },
  move_file: {
    minRole: "trusted",
    approval: "conditional",
    scope: "workspace",
    source: "builtin",
  },
  delete_file: {
    minRole: "trusted",
    approval: "always",
    scope: "workspace",
    source: "builtin",
  },
  bash: {
    minRole: "trusted",
    approval: "conditional",
    scope: "sandbox",
    source: "builtin",
  },
  python: {
    minRole: "trusted",
    approval: "conditional",
    scope: "sandbox",
    source: "builtin",
  },
  search_messages: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  read_messages: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  get_message: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  context_stats: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  admin_search_messages: {
    minRole: "owner",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  memory_read: {
    minRole: "limited",
    approval: "never",
    scope: "private",
    source: "builtin",
  },
  memory_write: {
    minRole: "limited",
    approval: "conditional",
    scope: "private",
    source: "builtin",
  },
  memory_list: {
    minRole: "owner",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  spawn_worker: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "agent",
  },
  read_worker_result: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "agent",
  },
  ask_parent: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "agent",
  },
  report_progress: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "agent",
  },
  set_model: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "agent",
  },
  web_fetch: {
    minRole: "limited",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  web_search: {
    minRole: "limited",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  send_message: {
    minRole: "limited",
    approval: "never",
    scope: "telegram",
    source: "builtin",
  },
  send_photo: {
    minRole: "limited",
    approval: "never",
    scope: "telegram",
    source: "builtin",
  },
  react: {
    minRole: "limited",
    approval: "never",
    scope: "telegram",
    source: "builtin",
  },
  send_file: {
    minRole: "trusted",
    approval: "never",
    scope: "telegram",
    source: "builtin",
  },
  pin_message: {
    minRole: "trusted",
    approval: "never",
    scope: "telegram",
    source: "builtin",
  },
  load_skill: {
    minRole: "limited",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  // 折叠工具的检索入口（docs/07 §5）。与 `load_skill` 同档同族：两者都是渐进披露的元工具
  // （分别展开 skill 正文与工具 schema），因此门槛取最低的 `limited` —— 它本身不执行任何动作，
  // 只如实报告本轮可调用的工具，且检索域派生自 `active()`，角色过滤已在上游完成
  // （limited 枚举不到 owner 工具的描述）。开关不在该字段上：折叠集为空时
  // `available()` 使其整体不进目录（纯内建部署的提示词逐字节不变）。
  search_tools: {
    minRole: "limited",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  // 定时任务是唯一能让 bot 在无人交互时主动产生花费的能力，因此起点取 trusted 而非 limited；
  // 作用域为 chat 而非 global —— 落点绑定本会话，工具参数中不含 chatId（docs/05 §8）。
  // list / cancel / update 同样收在 trusted：能看到任务名即能看到他人排入的内容。
  schedule_create: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  schedule_update: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  schedule_list: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  schedule_cancel: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  // 本轮不投递（docs/02 §10.5）。角色档与 `schedule_create` 对齐 —— 能排入静默任务的角色
  // 才可能触发静默轮次 —— 但真正的边界不在该字段上：两道闸（`agentKind==='main'` 且
  // 本轮 `silenceable`）固化在 `available()` 中，运维把 `tools.overrides.stay_silent.minRole`
  // 调到 limited 也无法开启（docs/05 §4 脚注 ¶，同自定义工具与容器的两道下限）。
  stay_silent: {
    minRole: "trusted",
    approval: "never",
    scope: "chat",
    source: "builtin",
  },
  // M11 · 启动外部 harness CLI（Claude Code / Codex）修改宿主上的仓库（docs/14 §2 Q8）。
  // `owner` + `approval: 'always'` 是本表可表达的最严档位，另外两道门（仅私聊、目录白名单）
  // 位于 `available()` —— 它们判定的是本轮上下文与配置，而非角色。
  // 其内部的工具调用不受本策略约束（docs/14 T17）：本系统无法观测 harness 的内部行为。
  spawn_harness: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "agent",
  },
  // M13 · 同一能力改用协议（ACP）而非 argv：启动一台本机编码 agent 修改宿主上的仓库。
  // 档位与 `spawn_harness` 完全相同，且必须相同 —— 两者风险面一致（`docs/14` T17），
  // 差别仅在内部动作的可观测程度，而可观测不等于可拦截 —— `session/request_permission`
  // 现已接入审批链（`docs/05 §3.5.3`），但那不构成放宽本档的理由：它只能观测 agent
  // 主动询问的动作，`ast_edit` / `eval` / `computer` 不经该链路。以可观测性换取权限是错误方向。
  spawn_acp: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "agent",
  },
  // M12 · 自我扩展（docs/07 §6）。八条全部为 `owner`，理由同 `spawn_harness`：`resolveEffectiveRole`
  // 只在私聊里给得出 owner（群 / 频道一律封顶 trusted，docs/05 §2.2），因此该档的实际含义是
  // 「owner 且身处私聊」—— 群里再高的授信也够不到这八条，群内注入自然也够不到。
  //
  // 五个写工具为 `approval: 'always'`。owner 因 `approval.skipForOwner`（默认 true）通常无感知，
  // 但该档在表中如实反映策略，并为运维提供真实杠杆：关闭 `skipForOwner` 后每次自撰写
  // 都需确认。它不是本机制的主闸 —— 主闸是落库即禁用、由 owner 在 WebUI 启用。
  define_tool: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  delete_tool: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  list_tools: {
    minRole: "owner",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  write_skill: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  install_skill: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  write_plugin: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  install_mcp: {
    minRole: "owner",
    approval: "always",
    scope: "global",
    source: "builtin",
  },
  list_mcp: {
    minRole: "owner",
    approval: "never",
    scope: "global",
    source: "builtin",
  },
  // 会话级持久容器的管理（docs/05 §3.11）。六条全部为 `owner`，理由同上；另外两道门
  // （持久化未开启时整族不进目录、`chat` 参数的会话解析）位于 `available()` / `execute()`。
  //
  // 这是本表中唯一一族接收落点参数的工具（§8 参数中不含 chatId 的例外），因此 owner 下限
  // 必须同时固化在 `available()` 中 —— 运维可修改 `minRole`，但无法修改 `available()`。
  container_list: {
    minRole: "owner",
    approval: "never",
    scope: "sandbox",
    source: "builtin",
  },
  container_exec: {
    minRole: "owner",
    approval: "conditional",
    scope: "sandbox",
    source: "builtin",
  },
  container_reset: {
    minRole: "owner",
    approval: "conditional",
    scope: "sandbox",
    source: "builtin",
  },
  container_inspect: {
    minRole: "owner",
    approval: "never",
    scope: "sandbox",
    source: "builtin",
  },
  container_keep: {
    minRole: "owner",
    approval: "never",
    scope: "sandbox",
    source: "builtin",
  },
  container_logs: {
    minRole: "owner",
    approval: "never",
    scope: "sandbox",
    source: "builtin",
  },
} as const satisfies Record<string, ToolPolicyEntry>;

export type ToolName = keyof typeof TOOL_POLICY;

/**
 * docs/07 §4 收窄公式中的核心工具集：skill 的 `allowed-tools` 不能收窄掉这几个。
 *
 * `allowed-tools` 表达的是完成该任务需要哪些工具，而非本轮禁止其他行为。一个
 * `allowed-tools: [bash]` 的 skill 曾同时关闭 `send_message` / `report_progress` / `context_stats`，
 * 导致模型执行完 skill 后无法追发消息、worker 无法上报进度。
 *
 * 这不构成放权：skill 的 `allowed-tools` 只能是角色白名单的子集（docs/07 §2），豁免这几个
 * 归还的仍是该角色本就具备的能力。
 *
 * **`send_message` 已从表里摘掉**：`load_skill` 随工具一起下沉，收窄从此只发生在 worker 那一侧
 * （主 agent 的 `skillAllowedTools` 恒空，`admit()` 那条 `.size &&` 直接短路），而 `send_message`
 * 是 `MAIN_ONLY_TOOLS`，worker 先撞 `tool_unavailable_for_worker` 就走不到收窄这一步。
 * 留着它就是一条恒不生效的豁免 —— 而一条读起来像在防某件事、实际什么都不防的规则，
 * 比没有这条规则更坏。
 *
 * `search_tools` 在列的理由与 `load_skill` 相同：元能力不属于作业工具。一个
 * `allowed-tools: [bash]` 的 skill 若同时关闭检索入口，模型既看不到折叠工具的 schema，
 * 也无法查询本轮可调用的工具 —— 而收窄本身照常生效（已展开的工具仍被 `admit()` 拦截，
 * `search_tools` 因此必须如实返回 `status: 'narrowed'`）。
 */
export const SKILL_NARROWING_EXEMPT: readonly ToolName[] = [
  "load_skill",
  "search_tools",
  "report_progress",
  "context_stats",
];

/**
 * 目录折叠（`tools.catalog.*`，docs/07 §5）永不折叠的两个工具 —— 渐进披露的入口。
 *
 * 折叠它们会切断入口：`load_skill` 被折叠时模型无从得知如何载入 skill 正文，`search_tools`
 * 被折叠时无法查询存在哪些折叠工具，而折叠摘要行中「用 search_tools 展开」将指向一个
 * 无法调用的名字。因此运维用 `tools.catalog.defer` 点名这两个时静默不生效。
 */
export const DEFER_EXEMPT: readonly ToolName[] = ["search_tools", "load_skill"];

/**
 * **只有主 agent 能调**的工具（`docs/05 §4`）。worker 侧一律拒。
 *
 * 五族，每族各有自己的理由，不是笼统的「对话面」：
 *
 * - **记忆写入**：记什么是对话层的判断，而 worker 看不到对话（`docs/04 §3.3`）。
 * - **Telegram 输出**：投递通道只有一条，`docs/04 §1.1` 那句「主 agent 永远负责最终对话」
 *   靠它成立。另有两处实打实的坏处：追发额度 `tools.tg.maxExtraMessagesPerTurn` 的计数器挂在
 *   父子共享的 turn 上（worker 会吃掉主 agent 的份），而 worker 的 kernel 刻意不含 Telegram 排版段
 *   （`docs/06 §3.1`），它直接发出去的东西会带转义符。
 * - **定时任务**：它立的是会话层面的约，且 `scope: 'chat'` 绑死本会话 —— 由看得见对话的那一侧下。
 * - **轮次形态开关**：`stay_silent` 本来就焊死了 `agentKind === 'main'`（`docs/02 §10.5`）；
 *   `set_model` 直接改 `turn.modelAliasOverride`，给 worker 等于让它换掉**父轮**的模型。
 * - **派发族与结果读取**：主 agent 的本职。worker 是叶子，给了它就不是叶子了。
 */
export const MAIN_ONLY_TOOLS: ReadonlySet<ToolName> = new Set([
  "memory_write",
  "send_message",
  "send_photo",
  "send_file",
  "react",
  "pin_message",
  "schedule_create",
  "schedule_update",
  "schedule_list",
  "schedule_cancel",
  "stay_silent",
  "set_model",
  "spawn_worker",
  "spawn_harness",
  "spawn_acp",
  "read_worker_result",
] satisfies ToolName[]);

/**
 * 主 agent 调得到的工具全集 = `MAIN_ONLY_TOOLS` 再加几件**两侧都给**的只读查询。
 *
 * 那几件共享是刻意的：记忆与归档都分「读」和「写」两半，把一族拆到两个 agent 手里，模型会先
 * `memory_read` 拿不到想要的、再为了 `memory_list` 派一个 worker。读侧不动外部世界，共享无代价。
 *
 * **这是白名单不是黑名单**，因此 skill / plugin / MCP / custom 那批不必枚举就自动拒 ——
 * 它们压根不在 `TOOL_POLICY` 里，名字落不进这张表。
 *
 * **它不是可见性而是边界。** 同一份判据喂 `#eligible()`（目录）与 `admit()`（准入复查）两处 ——
 * 只挡目录的话，模型沿用上一步的工具名直接调过来照样穿得过去（`docs/05 §4` 那条
 * 「目录过滤不是边界，`execute()` 才是」）。
 */
export const MAIN_AGENT_TOOLS: ReadonlySet<ToolName> = new Set([
  ...MAIN_ONLY_TOOLS,
  "memory_read",
  "memory_list",
  "search_messages",
  "read_messages",
  "get_message",
  "context_stats",
  "admin_search_messages",
] satisfies ToolName[]);

/**
 * worker 用得着、但**不写进主 agent 目录**的内部通道。
 *
 * block 3 现在描述的是「worker 能做什么」，按 worker 视角取数就会把这三个带进来 —— 而它们是
 * worker→父的通道，列在主 agent 的目录里会让模型以为自己可以派一个 worker 去上报进度。
 */
export const WORKER_INTERNAL_TOOLS: readonly ToolName[] = [
  "ask_parent",
  "report_progress",
  "search_tools",
];

/**
 * SDK 会话可调的工具全集（`docs/12-sdk.md` T3.4，`docs/05 §3.13`）。第三方接入方经 `/sdk/v1` 建的轮次
 * 不接派发，本次不做工具调用，模型侧只保留记忆读写三件。
 *
 * `memory_write` 在 `MAIN_ONLY_TOOLS` 里、默认只给 `main`；这里单独把它列进白名单，
 * 而不是让 `sdk` 复用 `lw` 那条「非 `MAIN_ONLY_TOOLS` 即放行」的黑名单算法 —— 黑名单算法会把
 * `bash` / `web_fetch` 等 worker 专属工具一并放出来，与「SDK 只保留记忆三件」的既定结论相悖
 * （`docs/12-sdk.md` §1「不在本次范围」）。
 */
export const SDK_AGENT_TOOLS: ReadonlySet<ToolName> = new Set([
  "memory_read",
  "memory_list",
  "memory_write",
] satisfies ToolName[]);

/**
 * 结构性禁止：无论来源怎么配，SDK 会话都拿不到这两族。
 *
 * 与「默认不给」不是一回事 —— 上面那份白名单是范围决定，可以按来源放开；这里两族是跟 SDK
 * 通道的形状冲突，放开会产生没有正确行为可言的调用：
 *
 * - 派发族：SDK 顶层轮次的 `agent_runs.kind` 恒 `main`、`worker_kind` 恒 `NULL`
 *   （`docs/12 §7`），接了派发之后这条口径与实际产生的 worker 行对不上，记账与审计都会错；
 *   而 `read_worker_result` 没有派发就永远读不到东西。
 * - Telegram 输出五件：SDK 会话没有 Telegram chat，调用只会投到空处；`stay_silent` 同理，
 *   它表达的是「这一轮不回 Telegram」，而 SDK 的调用方在等一个响应体。
 */
// 类型写 `ReadonlySet<string>` 而非 `ReadonlySet<ToolName>`：两个使用点拿到的都是运行期的
// 任意字符串（配置值、模型给的工具名），逐处 `as ToolName` 只是把检查糊掉。元素本身仍由
// 下面的 `satisfies ToolName[]` 保证是真实存在的工具名。
export const SDK_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "spawn_worker",
  "spawn_harness",
  "spawn_acp",
  "read_worker_result",
  "ask_parent",
  "send_message",
  "send_photo",
  "send_file",
  "react",
  "pin_message",
  "stay_silent",
] satisfies ToolName[]);

/**
 * 把来源上配置的工具名整理成一份可用的集合。
 *
 * `null`（未配置）回落到 `SDK_AGENT_TOOLS` —— 这是存量部署与新建来源的取值，行为与此前一字不差。
 * 配置过的来源按配置走，并在此滤掉结构性禁止的两族。
 *
 * 滤而不是拒：这个函数同时是管理面写入前的校验口和运行期的取数口，两处共用一份判据。运行期
 * 拿到一个当初合法、后来被移出 `TOOL_POLICY` 的名字是可能的（工具改名、插件卸载），那时候
 * 整个来源不该因此不可用。名字是否真的存在于注册表由注册表自己回答：它按名字查不到就不会
 * 出现在目录里，`admit()` 也会拒。
 */
export function sdkToolsFromConfig(
  configured: readonly string[] | null | undefined,
): ReadonlySet<string> {
  if (configured === null || configured === undefined) return SDK_AGENT_TOOLS;
  return new Set(
    configured.filter((name) => !SDK_FORBIDDEN_TOOLS.has(name)),
  );
}

/**
 * 这一档 agent 能不能调这个工具。`#eligible()` 与 `admit()` 共用，判据只有一份。
 *
 * `sdkTools` 只对 `kind === 'sdk'` 有意义：本轮所属来源配出来的工具集，由开轮时写入
 * `RuntimeTurnContext.sdkTools`。不传即 `SDK_AGENT_TOOLS`，因此既有调用点一律行为不变。
 *
 * **这一轴不是安全边界。** 角色轴才是：SDK 会话角色恒 `trusted`（`docs/12 §7`），`minRole`
 * 高于 `trusted` 的工具（如 `memory_list` 的 `owner`）先在角色轴被拒，配进白名单也到不了这里。
 * 审批同理仍然 fail-closed（`docs/05 §3.13`）—— 放开白名单不会把一个需要人工裁决的调用
 * 变成免审批。
 */
export function toolCallableBy(
  kind: AgentKind,
  name: string,
  sdkTools?: ReadonlySet<string>,
): boolean {
  if (kind === "sdk")
    return (sdkTools ?? SDK_AGENT_TOOLS).has(name) &&
      !SDK_FORBIDDEN_TOOLS.has(name);
  return kind === "main"
    ? MAIN_AGENT_TOOLS.has(name as ToolName)
    : !MAIN_ONLY_TOOLS.has(name as ToolName);
}

/**
 * 运维在工具页保存的覆盖项（`tools.overrides.<name>`，docs/09 §3.7）。
 *
 * 后三项均可缺席且无默认值：字段不存在即采用代码中的取值。为它们写死默认值等于把每一条
 * 历史覆盖固定在写入当天的策略上 —— 此后 `TOOL_POLICY` 的修改无法影响这些工具，而覆盖层
 * 只应表达本机相对默认策略的偏移量。
 */
export interface ToolOverride {
  enabled?: boolean | undefined;
  minRole?: Role | undefined;
  approval?: ApprovalPolicy | undefined;
  timeoutMs?: number | undefined;
}

/** `never < conditional < always`，数值越大越严格。与 `APPROVAL_POLICIES` 的下标同序。 */
export function approvalRank(policy: ApprovalPolicy): number {
  return APPROVAL_POLICIES.indexOf(policy);
}

/**
 * 代码默认 + 运维覆盖 → 本次生效的策略。
 *
 * 合并实现只有这一份，`ToolRegistry` 与 `GET /api/tools` 共用。拆成两份必然漂移，漂移的
 * 表现是界面显示的权限与运行时判定不一致 —— 运维依据面板误认为已收紧。
 */
export function effectiveToolPolicy(
  base: ToolPolicyEntry,
  override?: ToolOverride,
): ToolPolicyEntry {
  if (!override) return base;
  return {
    ...base,
    minRole: override.minRole ?? base.minRole,
    approval: override.approval ?? base.approval,
  };
}

/**
 * 覆盖中哪些字段比代码默认更宽松。空数组表示纯收紧或未变更。
 *
 * `timeoutMs` 不在其列：它是资源参数而非权限闸，仍进审计但不应阻碍修改。`enabled` 同样不计 ——
 * 启停一直是该面板的既有能力，把重新启用也设为需确认只会削弱确认框的有效性。
 */
export function relaxedFields(
  base: ToolPolicyEntry,
  override?: ToolOverride,
): Array<"minRole" | "approval"> {
  const effective = effectiveToolPolicy(base, override);
  const out: Array<"minRole" | "approval"> = [];
  if (roleRank(effective.minRole) < roleRank(base.minRole)) out.push("minRole");
  if (approvalRank(effective.approval) < approvalRank(base.approval))
    out.push("approval");
  return out;
}
