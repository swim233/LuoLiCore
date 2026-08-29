import { z } from 'zod';

/**
 * M13 · ACP（Agent Client Protocol）客户端的配置形状与运行时窄契约。
 *
 * 本文件不 import 任何 SDK 运行时：`config/schema.ts` 要 import 它，而后者被
 * `scripts/config-schema.ts` 与 WebUI 间接依赖 —— 那两处都不该为了生成一份 JSON Schema
 * 把整个 ACP SDK 拉进依赖图。
 *
 * 配置新开 `agent.acp` 而不扩 `agent.harness`：后者 `args` 的契约是任务正文作为 argv 的
 * 最后一项，而 ACP 下任务走 `session/prompt`，argv 里没有任务。同键异义会构成失效开关，
 * 因此两块并存（docs/04 §6.2）。
 */

/**
 * omp 的 `--approval-mode`：agent 内部哪些工具自动放行。三档都保留，默认 `yolo`。
 *
 * 默认取 `yolo` 的依据是另两档下 `bash` 可证明不可用：实测 omp 17.4.0 在 `write` 下会把 `bash`
 * 问过来（`session/request_permission`，kind `execute`，四个档一个不少），从它自己给的 options 里
 * 挑一个 `allow_always` 回过去，它仍把那次调用记成 `Tool call denied by user: bash` ——
 * `terminal/create` 一次都不发生。换 `yolo` 后同一条命令立刻走通（`terminals: 1`，跑的是我们的终端）。
 * 默认值里留一个不可用的工具，模型会反复尝试、失败、然后绕路或编造理由
 * （摘除比伪造安全，`docs/16 §5`）。
 *
 * `always-ask` 更不能当默认：它有可复现的 edit 故障 —— 文件未被修改、`fs/write_text_file`
 * 一次都没走，而 agent 认为已完成。
 *
 * 代价：`yolo` 等于关闭 agent 内部全部自动放行判据。约束仍由三道门承担
 * （owner + 仅私聊 + 目录白名单，`docs/05 §3.5.1`），需要逐条拦截就把 `permissionMode` 拨到 `ask`。
 */
export const ACP_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;
export type AcpApprovalMode = (typeof ACP_APPROVAL_MODES)[number];
/**
 * agent 发起 `session/request_permission` 时本系统怎么回。与上一项是两件事：
 * 上一项是 agent 内部的自动放行档位，本项是本系统侧的门。
 *
 * 默认 `auto` 即 `docs/14 §2 Q8-c` 的原义：启动这台 agent 整体走一次审批，批准后其内部执行
 * 不再逐条拦截。`ask`（逐条询问真人）整条链已实现且有用例，但默认不生效 ——
 * 机制存在与默认生效是两件事。
 */
export const ACP_PERMISSION_MODES = ['ask', 'auto', 'deny'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODES)[number];
/**
 * ACP 的会话模式，`''` 表示用 agent 自己的默认。
 *
 * 不是 argv 上的 `--mode`：omp 的 `--mode` 是输出格式（text / json / rpc / rpc-ui），
 * 下发会破坏 ACP 的 stdio 协议本身；会话模式只能在 `session/new` 之后走
 * `session/set_config_option`（实测 `configId: 'mode'`，非法值当场被拒）。
 */
export const ACP_SESSION_MODES = ['', 'default', 'plan'] as const;
export type AcpSessionMode = (typeof ACP_SESSION_MODES)[number];

/**
 * argv 上由本系统接管的 flag。写进 `extraArgs` 当场拒绝（WebUI 得到 400），而不是依赖
 * 「后出现者覆盖」这种取决于对方参数解析顺序的行为兜底 —— `--approval-mode` 与 `--tools`
 * 是权限门，运维在界面填一行 extraArgs 即可绕开权限门是必须排除的形态。
 *
 * `--auto-approve` / `--no-tools` 不由本系统下发，但各自足以单独废掉一道门，一并拦截。
 * `--cwd` 拦截的原因是目录白名单判的是进程 cwd 与 `session/new` 的 cwd（同一个值），
 * 从 argv 另行覆盖会使实际工作目录不可追溯。
 */
export const ACP_MANAGED_FLAGS = ['--approval-mode', '--tools', '--no-tools', '--auto-approve', '--profile', '--model', '--mode', '--cwd'] as const;

/**
 * 一台 ACP agent 的启动参数。
 *
 * `approvalMode` 与 `tools` 是一等配置键并无条件下发成 flag，不放进自由格式的 `args`：
 * omp 的 profile 里可能写着 `approvalMode: yolo`，不显式覆盖即静默失去权限门；运维在 WebUI
 * 把自由 `args` 改成 `['acp']` 同样会静默移除它，结果是界面显示门关闭而运行时开启。
 */
export const acpAgentSchema = z.object({
  // 与 `mcp.servers[].name` 同一套形态：会进日志、错误文案与 `agent` 参数的 z.enum。
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  /** `--profile=`：omp 的隔离档（凭据 / 会话 / 设置 / 缓存各一份）。空则不下发该 flag。 */
  profile: z.string().default(''),
  approvalMode: z.enum(ACP_APPROVAL_MODES).default('yolo'),
  /**
   * `--tools=`：本模块唯一接近单一收口点的手段。omp 有 31 个内建工具，只有 4 个
   * （read / write / edit / bash）走 ACP，剩下 27 个里 `ast_edit`（不经 `fs/write_text_file`
   * 的写路径）、`eval`（常驻 Python/JS）、`computer`（宿主桌面控制）都是绕过路径。
   * 空数组表示不下发该 flag（即全开），因此默认值是显式的。
   *
   * `bash` 在默认值里，其可用性要两个条件同时成立：① 申报 `terminal`（七个 `terminal/*`
   * 处理器 + `acpClientCapabilities`，本轮已实现）；② `approvalMode: 'yolo'`（默认），
   * 否则 agent 内部那道审批会拒绝它 —— 归因见 `ACP_APPROVAL_MODES` 那段。
   *
   * 反向条件同样成立：`sandbox.plan(role, root).mode !== 'host'` 时不申报 `terminal`，
   * 于是此处的 `bash` 变成不可用工具。`AcpManager.#surface` 在该组合下往 `acp.run` 落一条
   * 点名 `bash` 的 warn —— 配置声明与运行时可用性不一致这件事没有别的出口
   * （摘除比伪造安全，`docs/16 §5`）。
   */
  tools: z.array(z.string().min(1)).default(['read', 'write', 'edit', 'bash']),
  /** `--model=`。空则用 profile 默认（实测全局 flag 对 `acp` 子命令有效）。 */
  model: z.string().default(''),
  mode: z.enum(ACP_SESSION_MODES).default(''),
  extraArgs: z.array(z.string()).default([]),
  /** 握手（initialize + session/new）的超时上界。超时后立即回收连接与子进程，不留孤儿。 */
  handshakeTimeoutMs: z.number().int().positive().default(30_000),
  /** 一次 `session/prompt` 的墙钟上界。超时走协议层的 `session/cancel`，而不是直接 SIGTERM。 */
  timeoutMs: z.number().int().positive().default(900_000),
  maxOutputBytes: z.number().int().positive().default(65_536),
}).superRefine((agent, ctx) => {
  for (const [index, value] of agent.extraArgs.entries()) {
    const flag = ACP_MANAGED_FLAGS.find((managed) => value === managed || value.startsWith(`${managed}=`));
    if (flag) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['extraArgs', index], message: `${flag} 由一等配置键下发，不能在 extraArgs 中重复设置：两份哪一份生效取决于对方的参数解析顺序，而其中两项是权限门` });
  }
});

/**
 * `agent.acp` 整段，默认整块关闭，与 `mcp.enabled` / `tools.selfExtend` 同族：这几项开启后
 * 模型即可改变本机状态，默认值必须为关。`allowedDirs` 为空同样等于整个功能关闭
 * （三道门的第二道，语义与实现都复用 `resolveHarnessDir`）。
 */
export const acpSchema = z.object({
  enabled: z.boolean().default(false),
  allowedDirs: z.array(z.string()).default([]),
  /** 多 agent 部署下模型未给 `agent` 参数时用哪个。空则取第一个启用的。 */
  defaultAgent: z.string().default(''),
  /** 默认 `auto`：整趟一次审批管到底。逐条拦截用 `ask`，见 `ACP_PERMISSION_MODES` 那段。 */
  permissionMode: z.enum(ACP_PERMISSION_MODES).default('auto'),
  /**
   * 一次 prompt 最多接收多少条 `session/update`。超限只丢弃、不断连，刻意与 `collectProcess`
   * 的「输出超限就地 SIGKILL」分岔：那边溢出源是可安全终止的字节流，这边 agent 正在修改真实
   * 文件，为 transcript 容量而中止它代价更高。
   * 量级参考：6 秒的琐碎任务 82–104 条，86 秒那次 263 条。
   */
  maxUpdatesPerPrompt: z.number().int().positive().default(2000),
  /**
   * 同时存在的 `terminal/*` 句柄上界，含已退出但未 release 的 —— 这构成 agent 归还句柄的压力。
   * 统计的是存活句柄而非历史总数，行为规范的 agent 不会触及该上界。
   * 超限时 `terminal/create` 返回可据以修正的 `invalidParams`，而不是排队或静默复用。
   */
  maxTerminals: z.number().int().positive().default(8),
  /** Telegram 进度卡片两次编辑的最小间隔（`AcpProgressCard`）。群组 20/分钟 的限流真实存在。 */
  progressIntervalMs: z.number().int().positive().default(5000),
  /**
   * 一次调用的花费上界（USD，0 表示不限）。这是 ACP agent 花费的唯一闸门：它消耗自己那份
   * provider 凭据，不经本项目的 `usage_ledger`，配额与 `quota.perTurn.maxCostUsd` 均观测不到。
   * 判据取 `usage_update` 的 `cost.amount`（累计值），超限走 `session/cancel`。
   */
  maxCostUsd: z.number().nonnegative().default(0),
  agents: z.array(acpAgentSchema).default([]),
});

/**
 * 运行时窄契约。全部字段写成必填：这两个接口的来源只有 zod 输出一处，而 zod 的 `.default()`
 * 保证每项都存在。`?: T | undefined` 适用于调用方持有不完整对象的场景，此处不适用。
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

/** 本轮实际可用的 agent。停用的既不进 `agent` 参数的枚举，也过不了 `execute()` 的复查。 */
export function enabledAcpAgents(settings: AcpSettings): readonly AcpAgentSettings[] {
  return settings.agents.filter((agent) => agent.enabled);
}

/**
 * 选择一台 agent。`requested` 缺省时取 `defaultAgent`，后者未配置则取第一个启用的。
 *
 * 无匹配时返回 `null` 而不是任选一台：模型写错 agent 名应得到可据以修正的错误，
 * 而不是在非预期的 agent 上执行（`--tools` / `--approval-mode` 可能完全不同）。
 */
export function resolveAcpAgent(settings: AcpSettings, requested?: string): AcpAgentSettings | null {
  const active = enabledAcpAgents(settings);
  if (requested) return active.find((agent) => agent.name === requested) ?? null;
  if (settings.defaultAgent) return active.find((agent) => agent.name === settings.defaultAgent) ?? null;
  return active[0] ?? null;
}
