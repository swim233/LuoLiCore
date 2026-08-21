import { z } from 'zod';

/**
 * M13 · ACP（Agent Client Protocol）客户端的配置形状与运行时窄契约。
 *
 * **这个文件不 import 任何 SDK 运行时。** `config/schema.ts` 要 import 它，而后者被
 * `scripts/config-schema.ts` 与 WebUI 间接吃进去 —— 那两处都不该为了生成一份 JSON Schema
 * 把整个 ACP SDK 拉进依赖图。
 *
 * **配置新开 `agent.acp`，不扩 `agent.harness`**：后者 `args` 的契约是「任务正文作为 argv 的
 * 最后一项」，而 ACP 下任务走 `session/prompt`，argv 里根本没有任务。同名同键语义相反是最坏的
 * 假开关，所以两块并存（docs/04 §6.2）。
 */

/**
 * omp 的 `--approval-mode`：agent **内部**哪些工具自动放行。
 *
 * 默认 `write`（写操作及以下自动放行、exec 要问）。**不用 `always-ask`** —— 实测它有可复现的
 * edit 故障：文件没被改、`fs/write_text_file` 一次都没走，而 agent 自己认为改完了。
 */
export const ACP_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;
export type AcpApprovalMode = (typeof ACP_APPROVAL_MODES)[number];
/**
 * agent 真的问过来时（`session/request_permission`）**我们**怎么回。与上面那个是两件事：
 * 那个是 agent 内部的自动放行档位，这个是本系统侧的门。
 */
export const ACP_PERMISSION_MODES = ['ask', 'auto', 'deny'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODES)[number];
/**
 * ACP 的会话模式，`''` = 用 agent 自己的默认。
 *
 * **不是 argv 上的 `--mode`。** omp 的 `--mode` 是输出格式（text / json / rpc / rpc-ui），
 * 下发过去会把 ACP 的 stdio 协议本身弄坏；会话模式只能在 `session/new` 之后走
 * `session/set_config_option`（实测 `configId: 'mode'`，坏值当场被拒）。
 */
export const ACP_SESSION_MODES = ['', 'default', 'plan'] as const;
export type AcpSessionMode = (typeof ACP_SESSION_MODES)[number];

/**
 * argv 上**我们管着**的 flag。写进 `extraArgs` 当场拒掉（WebUI 得到一个 400），而不是靠
 * 「谁在后面谁赢」那种依赖对方参数解析顺序的巧合来兜底 —— `--approval-mode` 与 `--tools`
 * 是权限门，「运维在界面上填了一行 extraArgs 就把门去掉了」正是这个项目最讨厌的形态。
 *
 * `--auto-approve` / `--no-tools` 不是我们下发的，但它们各自能单手废掉一道门，所以一起挡。
 * `--cwd` 挡掉是因为目录白名单判的是进程 cwd 与 `session/new` 的 cwd（同一个值），
 * 从 argv 上另改一个只会让「它到底在哪个目录里跑」变得查不清。
 */
export const ACP_MANAGED_FLAGS = ['--approval-mode', '--tools', '--no-tools', '--auto-approve', '--profile', '--model', '--mode', '--cwd'] as const;

/**
 * 一台 ACP agent 的启动参数。
 *
 * **`approvalMode` 与 `tools` 是一等配置键，且无条件下发成 flag** —— 不塞进自由格式的 `args`：
 * omp 的 profile 里可能写着 `approvalMode: yolo`，不显式盖过就是静默失去权限门；而运维在 WebUI
 * 把一份自由 `args` 改成 `['acp']` 同样能静默去掉它。那正是「界面上门是关的、运行时开着」。
 */
export const acpAgentSchema = z.object({
  // 与 `mcp.servers[].name` 同一套形态：它会进日志、进错误文案、进 `agent` 参数的 z.enum。
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  /** `--profile=`：omp 的隔离档（凭据 / 会话 / 设置 / 缓存各一份）。空 = 不加这个 flag。 */
  profile: z.string().default(''),
  approvalMode: z.enum(ACP_APPROVAL_MODES).default('write'),
  /**
   * `--tools=`：**这套东西唯一接近「真咽喉点」的手段**。omp 有 31 个内建工具，只有 4 个
   * （read / write / edit / bash）走 ACP，剩下 27 个里 `ast_edit`（不经 `fs/write_text_file`
   * 的写路径）、`eval`（常驻 Python/JS）、`computer`（宿主桌面控制）都是绕过路径。
   * 空数组 = 不加这个 flag（= 全开），所以默认值是显式的。
   *
   * **`bash` 不在默认值里，因为它现在可证明用不了**：`ACP_CLIENT_CAPABILITIES` 不申报
   * `terminal`，而实测在那种情况下 omp 的 `bash` 连权限批了都还是 `Tool call denied by user: bash`
   * （`read`/`write`/`edit` 会退回自己直接动磁盘，所以那三个照常能用）。一个可证明用不了的工具
   * 写在默认值里，模型会试、失败、然后绕路或编一个理由 —— 「摘除比伪造安全」（`docs/16 §5`）。
   * **`bash` 与 terminal capability 同生共死**：哪一轮申报了 `terminal` 并实现了那七个处理器，
   * 就在同一个改动里把它加回来。
   */
  tools: z.array(z.string().min(1)).default(['read', 'write', 'edit']),
  /** `--model=`。空 = 用 profile 默认（实测全局 flag 对 `acp` 子命令有效）。 */
  model: z.string().default(''),
  mode: z.enum(ACP_SESSION_MODES).default(''),
  extraArgs: z.array(z.string()).default([]),
  /** 握手（initialize + session/new）的上界。超时后连接与子进程**当场**收掉，不留孤儿。 */
  handshakeTimeoutMs: z.number().int().positive().default(30_000),
  /** 一次 `session/prompt` 的墙钟上界。到点走 `session/cancel`（协议），而不是直接 SIGTERM。 */
  timeoutMs: z.number().int().positive().default(900_000),
  maxOutputBytes: z.number().int().positive().default(65_536),
}).superRefine((agent, ctx) => {
  for (const [index, value] of agent.extraArgs.entries()) {
    const flag = ACP_MANAGED_FLAGS.find((managed) => value === managed || value.startsWith(`${managed}=`));
    if (flag) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['extraArgs', index], message: `${flag} 由上面的一等配置键下发，不能在 extraArgs 里另写一份 —— 两份哪一份生效取决于对方的参数解析顺序，而其中两个是权限门` });
  }
});

/**
 * `agent.acp` 整段。**整块默认关**，与 `mcp.enabled` / `tools.selfExtend` 同族：这几件事都是
 * 「打开之后模型能改变本机上的东西」，默认值必须是关。`allowedDirs` 为空同样等于整个功能关闭
 * （三道门的第二道，语义与实现都复用 `resolveHarnessDir`）。
 */
export const acpSchema = z.object({
  enabled: z.boolean().default(false),
  allowedDirs: z.array(z.string()).default([]),
  /** 多 agent 部署时模型不给 `agent` 参数时用哪个。空 = 用第一个启用的。 */
  defaultAgent: z.string().default(''),
  permissionMode: z.enum(ACP_PERMISSION_MODES).default('ask'),
  /**
   * 一次 prompt 最多收多少条 `session/update`。撞上界后**只丢弃、不断连** —— 这里刻意与
   * `collectProcess` 的「输出超限就地 SIGKILL」分岔：那边溢出源是我们杀得掉的字节流，这边
   * agent 正在改真实文件，为了我们的 transcript 装不下而把它掐死是更坏的选择。
   * 量级参考：6 秒的琐碎任务 82–104 条，86 秒那次 263 条。
   */
  maxUpdatesPerPrompt: z.number().int().positive().default(2000),
  maxTerminals: z.number().int().positive().default(8),
  progressIntervalMs: z.number().int().positive().default(5000),
  /**
   * 一次调用的花费上界（USD，0 = 不限）。**这是 ACP agent 花费的唯一闸门** —— 它烧的是自己那份
   * provider 凭据，不经本项目的 `usage_ledger`，配额与 `quota.perTurn.maxCostUsd` 都看不见它。
   * 判据来自 `usage_update` 的 `cost.amount`（累计值），撞线时走 `session/cancel`。
   */
  maxCostUsd: z.number().nonnegative().default(0),
  agents: z.array(acpAgentSchema).default([]),
});

/**
 * 运行时窄契约。可选项一律写成必填 —— 这两个接口的来源只有 zod 输出一处，而 zod 的 `.default()`
 * 保证每一项都在。可选项写成 `?: T | undefined` 是给「调用方手里那份不完整」准备的，这里不是。
 */
export interface AcpAgentSettings {
  name: string;
  enabled: boolean;
  command: string;
  profile: string;
  approvalMode: AcpApprovalMode;
  tools: readonly string[];
  model: string;
  mode: AcpSessionMode;
  extraArgs: readonly string[];
  handshakeTimeoutMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface AcpSettings {
  enabled: boolean;
  allowedDirs: readonly string[];
  defaultAgent: string;
  permissionMode: AcpPermissionMode;
  maxUpdatesPerPrompt: number;
  maxTerminals: number;
  progressIntervalMs: number;
  maxCostUsd: number;
  agents: readonly AcpAgentSettings[];
}

/** 这一轮真的能用的那些。停用的 agent 既不进 `agent` 参数的枚举，也过不了 `execute()` 的复查。 */
export function enabledAcpAgents(settings: AcpSettings): readonly AcpAgentSettings[] {
  return settings.agents.filter((agent) => agent.enabled);
}

/**
 * 挑一台 agent。`requested` 没给时按 `defaultAgent`，它也没配就用第一个启用的。
 *
 * 拿不到时交回 `null` 而不是「随便挑一个」：模型写错 agent 名该得到一句能照着改的错误，
 * 而不是在一台它没打算用的 agent 上跑起来（`--tools` / `--approval-mode` 都可能完全不同）。
 */
export function resolveAcpAgent(settings: AcpSettings, requested?: string): AcpAgentSettings | null {
  const active = enabledAcpAgents(settings);
  if (requested) return active.find((agent) => agent.name === requested) ?? null;
  if (settings.defaultAgent) return active.find((agent) => agent.name === settings.defaultAgent) ?? null;
  return active[0] ?? null;
}
