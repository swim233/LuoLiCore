import { z } from "zod";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentManager,
  Config,
  ContextEngine,
  FileTools,
  MemoryStore,
  ModelRegistry,
  QuotaGuard,
  QuotaReservation,
  Sandbox,
  SkillLoader,
  ToolRegistry,
  UsageLedger,
  LogSink,
} from "@luoli/core";
import {
  DEFAULT_WEB_RETRY,
  NOTE_PREFIX,
  acpFailure,
  acpPermissionGate,
  arbitrateAsk,
  builtinPolicy,
  captureImage,
  enabledAcpAgents,
  numberLines,
  readSlice,
  resolveAcpTarget,
  runHarness,
  runSubAgent,
  selfAuthoringDenyGlobs,
  webFetch,
  webSearch,
  type AcpApprovalBroker,
  type AcpManager,
  type AcpSettings,
  type WebAssetStore,
  type WebMediaSink,
  type WebRetryOptions,
} from "@luoli/core";
import type {
  ArchiveRepository,
  ArchivedMessage,
  ScopedArchiveRepository,
} from "@luoli/db";
import { archiveQuery } from "@luoli/db";
import { citeArchivedMessages } from "./cite.js";
import {
  registerScheduleTools,
  type ScheduleToolDependencies,
} from "./schedule.js";
import type { Role } from "@luoli/shared";
import type { ToolExecutionContext } from "./registry.js";

/** 一次投递的目标位置。thread 必须一并传递，否则话题群中的追发会落到 General。 */
export interface TelegramTarget {
  chatId: string;
  threadId: number | null;
  turnId: string;
  /** 本次投递应挂在哪个 span 之下（`docs/10 §1`）。工具路径传入的是本次 `tool.call` 的 span id。 */
  parentSpanId?: string;
}

/**
 * Telegram 侧工具的适配层契约（实现位于 `packages/telegram/src/tools.ts`）。core 只负责本轮语义
 * ——jail 解析、大小与条数上限、messageId 缺省——真正的 API 调用、emoji 白名单、发送后写回归档
 * 均在适配层。
 *
 * 依赖中该项刻意设为必填（没有 Telegram 入口时显式传 `null`）：它此前是可选的，于是
 * `main.ts` 少传一个 key 就使五个工具永久消失 —— `available()` 判定的正是它是否存在，而
 * `TOOL_POLICY ↔ 注册表` 的启动断言只检查是否注册，不会给出任何提示，模型则回答不具备该功能。
 * 改为必填后，同样的遗漏会成为编译错误。
 */
export interface TelegramToolBridge {
  sendMessage(target: TelegramTarget, text: string): Promise<object>;
  sendPhoto(
    target: TelegramTarget,
    absolutePath: string,
    caption?: string,
  ): Promise<object>;
  sendFile(
    target: TelegramTarget,
    absolutePath: string,
    caption?: string,
  ): Promise<object>;
  react(
    target: TelegramTarget,
    messageId: number,
    emoji: string,
  ): Promise<object>;
  pin(target: TelegramTarget, messageId: number): Promise<object>;
  /**
   * ACP 的进度卡片（`docs/05 §3.5.2`）。该项为可选，与上面五个刻意不同 —— 存在即启用：
   * 拿不到时（没有 Telegram 入口，或适配层本版尚未实现）`spawn_acp` 照常运行，只是屏幕上没有
   * 中间进度。上面五个设为必填的理由不适用于它：漏传那五个会使工具永久消失而启动断言只检查是否
   * 注册；本项遗漏只是少一层呈现，工具本身仍在目录中且可正常使用。
   *
   * 返回 `null` 表示该会话无法创建卡片。渲染选项由调用方从本轮 `turn.config` 读取，而非在此读取
   * 全局快照：`output.*` 位于 `PER_CHAT_OVERRIDE_ALLOWLIST` 中，读快照会静默丢弃会话级覆盖。
   */
  openProgressCard?(
    target: {
      chatId: string;
      threadId: number | null;
      turnId?: string;
      parentSpanId?: string;
    },
    options: {
      parseMode: "MarkdownV2" | "HTML" | "none";
      maxMessageChars: number;
      intervalMs: number;
      /** 该 agent 的 `name`，用于卡片表头。不提供时退化为「外部 agent」。 */
      agent?: string;
      /** 会话 root（realpath）。卡片据此将 agent 上报的绝对路径相对化 —— 不提供则每行多一条长路径。 */
      dir?: string;
      thoughts?: boolean;
    },
  ): Promise<AcpProgressCard | null>;
}

/**
 * 一张在途的 ACP 进度卡片。两个方法均不抛出异常 —— 一次文案更新绝不能使一次正在修改仓库的调用
 * 失败（同回执失败不影响审批本身这条纪律）。
 */
export interface AcpProgressCard {
  /** 一条 `session/update` 原文。节流、渲染、去重均在适配层完成。 */
  push(notification: unknown): void;
  /**
   * 终帧。归档只在此处发生一次 —— `ScopedArchiveRepository.append` 是 `INSERT OR IGNORE`，
   * 在首帧归档等于把「正在启动…」永久写入 `messages` 与 FTS。
   */
  close(final: {
    stopReason?: string;
    error?: string;
    files: number;
    failures: number;
    toolCalls: number;
    costUsd?: number;
  }): Promise<string>;
}

/**
 * 上传耗时与文件大小相关（`tools.tg.maxFileSendMb` 默认 50MB），用 `tools.defaultTimeoutMs`
 * 的 60s 限制它等于把正常的大文件上传判为 `tool_timeout`。给出一个足够宽但仍有限的预算 ——
 * 在这条链路上取消上限即意味着整轮阻塞。
 */
const UPLOAD_TIMEOUT_MS = 300_000;
/** `python` 的脚本存放位置（doc §3.3）。带前导点，因此默认不会出现在 `list_dir` / `glob` 中。 */
const PYTHON_TMP_DIR = ".luoli-tmp";

const target = (context: ToolExecutionContext): TelegramTarget => ({
  chatId: context.turn.chatId,
  threadId: context.turn.threadId,
  turnId: context.turn.turnId,
  ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
});
/** 读取本轮合并后的配置：运维在 WebUI 修改上限后，下一轮即应生效（`tools.tg` 在热更新白名单内）。 */
const tgLimits = (context: ToolExecutionContext): Config["tools"]["tg"] =>
  (context.turn.config as Readonly<Config>).tools.tg;

/**
 * 追发预算按调用次数扣减，成功与否均计入：上限防的是刷屏，而失败重试同样构成刷屏。
 * 计数挂在 turn 上而非模块级 Map —— 轮次对象随轮次释放，无需额外清理。
 */
function claimExtraMessage(
  context: ToolExecutionContext,
): { ok: false; error: string; hint: string } | null {
  const max = tgLimits(context).maxExtraMessagesPerTurn;
  const used = context.turn.extraMessages ?? 0;
  if (used >= max)
    return {
      ok: false,
      error: "extra_message_limit_exceeded",
      hint: `本轮最多追发 ${max} 条（tools.tg.maxExtraMessagesPerTurn）；正文请直接写入回复。`,
    };
  Object.assign(context.turn, { extraMessages: used + 1 });
  return null;
}

/**
 * `read_messages` 的 `anchor`：消息 id 或 ISO 时间（docs/05 §3.2）。数字串一律按 id 识别 ——
 * 模型大概率会把上下文中 `#12841` 的数字作为字符串传入，而 `Date.parse('12841')` 在部分运行时
 * 会解析为年份，导致它读到完全不相关的记录，却认为那正是目标位置。
 * 解析失败返回 `false`，由调用方给出可据以修正的错误，而不是静默退回最近 N 条。
 */
function resolveAnchor(
  anchor: number | string | undefined,
): { anchorId?: number; anchorDate?: number } | false {
  if (anchor === undefined) return {};
  if (typeof anchor === "number") return { anchorId: anchor };
  const trimmed = anchor.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed)) return { anchorId: Number(trimmed) };
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? false : { anchorDate: parsed };
}
/** `search_messages` 的 after / before。`undefined`（未传）与解析失败必须区分，后者需报错。 */
function parseMoment(value: string | undefined): number | null | false {
  if (value === undefined) return null;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? false : parsed;
}

/** 三个列表型检索工具共用的渲染（doc §3.2 的 `#id [时间] 发言人: 正文`，一行一条）。 */
function cite(
  messages: readonly ArchivedMessage[],
  context: ToolExecutionContext,
  scope: ScopedArchiveRepository,
): string[] {
  return citeArchivedMessages(messages, {
    timezone: (context.turn.config as Readonly<Config>).general.timezone,
    resolveReplies: (ids) => scope.archiveIdsByTgMessageIds(ids),
  });
}

/**
 * 短词无法进入 trigram 索引，剔除属于正确降级（理由见 `archiveQuery` 的 docstring）——
 * 但不告知即构成已按输入完整检索的假象：`search_messages("名字 李小明")` 实际只按 `李小明`
 * 检索，而模型据此判定不存在相关记录（docs/28 · L-DB-01）。此处给出的是可操作的下一步，
 * 而非免责声明。两个检索工具共用一份文案 —— 各写一份的结果是其中一份日后被遗漏修改。
 */
function droppedTokenNote(query: string): { note?: string } {
  const dropped = archiveQuery(query).dropped;
  return dropped.length
    ? {
        note: `以下词短于 3 个字、trigram 索引无法检索，本次未参与检索：${dropped.join("、")}。如有需要，请单独作为 query 重新检索一次。`,
      }
    : {};
}

/** workspace 内的绝对路径与大小闸门。越界、不存在、超限三种都需在调用 API 之前转为 `ok:false`。 */
function resolveOutgoingFile(
  context: ToolExecutionContext,
  files: FileTools,
  path: string,
):
  { ok: false; error: string; hint?: string } | { ok: true; absolute: string } {
  let absolute: string;
  try {
    absolute = files.resolve(path);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "path_invalid",
      hint: "只能发送工作目录内的文件。",
    };
  }
  if (!files.exists(path))
    return { ok: false, error: "file_not_found", hint: path };
  const bytes = statSync(absolute).size;
  const limit = tgLimits(context).maxFileSendMb * 1024 * 1024;
  if (bytes > limit)
    return {
      ok: false,
      error: "file_too_large",
      hint: `${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${tgLimits(context).maxFileSendMb}MB 上限（tools.tg.maxFileSendMb）`,
    };
  return { ok: true, absolute };
}

export function registerBuiltins(
  registry: ToolRegistry,
  dependencies: {
    db: import("@luoli/db").Sqlite;
    filesFor: (workspace: string, role: Role) => FileTools;
    sandbox: Sandbox;
    archive: ArchiveRepository;
    context: ContextEngine;
    memory: MemoryStore;
    skills: SkillLoader;
    agents: AgentManager;
    models: ModelRegistry;
    ledger: UsageLedger;
    log: LogSink;
    quota?: QuotaGuard;
    telegram: TelegramToolBridge | null;
    schedule: ScheduleToolDependencies;
    maxWebBytes: number;
    maxAsksPerRun?: number;
    web?: WebRetryOptions;
    webSearch?: {
      provider: "" | "brave" | "serper" | "tavily" | "exa";
      apiKey: string;
    };
    /**
     * 抓取到的图片的去向。可选：不提供时走只报告类型与大小的档位 —— 不伪装成已读取内容
     * （测试与未配置 vision 的部署均落在此处）。`visionAvailable` 每次调用实时计算，因为它判定的是
     * 本轮当前别名是否支持图像，而别名可被 `set_model` 更换。
     *
     * 接收整个 `ToolExecutionContext` 而非仅 `turn`：子 agent 的别名不在 turn 上（它是
     * `runSubAgent` 的局部变量，经 `agentAlias` 传入），而该图片正是要交给它（`docs/04 §5.2`）。
     */
    webMedia?: {
      assets: WebAssetStore;
      visionAvailable: (context: ToolExecutionContext) => boolean;
    };
    /**
     * ACP 客户端（M13）。可选：缺失时 `spawn_acp` 仍会注册（`main.ts` 中每个 `TOOL_POLICY` 条目
     * 都已注册的启动断言要求无条件注册），但 `available()` 恒为假，因此它不会进入模型的工具目录。
     * 分段用例无需启动一个真正管理子进程的 manager。
     */
    acp?: AcpManager;
    /**
     * 审批 broker。只有 ACP 的逐条 permission 使用它（`docs/05 §3.5.3`）：工具自身的审批走的是
     * `ToolRegistry` 持有的同一对象，此处需要的是非工具调用但走同一链路的那两个动作。
     *
     * 可选，而它的缺失构成一道真实的门：`permissionMode === 'ask'` 且缺失时，`spawn_acp` 直接不进入
     * 工具目录（与 `allowedDirs` 为空同形态）—— 名为 `ask` 的默认值实际放行，正是
     * `docs/reviews/16 §5` 所述的伪造一道门。
     */
    approvals?: AcpApprovalBroker;
  },
): void {
  const web = dependencies.web ?? DEFAULT_WEB_RETRY;
  /**
   * 本次调用的图片落地入口。每次调用实时构造：`visionAvailable` 判定的是本轮当前别名的能力位，
   * 而 `set_model` 可在轮内更换它；构造一次并缓存等于把第一步的结果固定下来。
   *
   * 与 MCP 的截图共用 `captureImage`（`media/web-assets.ts`）—— 两份实现即两种行为。
   */
  const webMediaSink = (context: ToolExecutionContext): WebMediaSink | null => {
    const media = dependencies.webMedia;
    if (!media) return null;
    return {
      capture: (input) =>
        captureImage(
          {
            assets: media.assets,
            appendDelta: (turn, message) =>
              dependencies.context.appendDelta(turn, message as never),
            visionAvailable: () => media.visionAvailable(context),
            log: dependencies.log,
            // 子 agent 档位：父轮只保留文字记录、张数按 run 自行统计、已注入图片标志置于其自身（docs/04 §5.2）。
            ...(context.subAgent
              ? {
                  subAgent: {
                    name: context.subAgent.name,
                    images: context.subAgent.images,
                    onInjected: context.subAgent.onMediaInjected,
                  },
                }
              : {}),
          },
          context.turn,
          input,
        ),
    };
  };
  // 与 `telegram` 同样为必填：漏传一个 key 即使五个工具永久消失，而
  // 「TOOL_POLICY ↔ 注册表」的启动断言只检查是否注册，不会给出任何提示。
  registerScheduleTools(registry, dependencies.schedule);
  /** 每个 agent_run 上一次向 SSE 广播进度的时间（`agent.progressThrottleMs`）。 */
  const progressBroadcast = new Map<string, number>();
  /**
   * `agent.maxConcurrentSubagents`：同一轮内同时运行的子 agent 数上限。
   * 模型可在一步中并行发出多个 `spawn_agent`，每个都是一次真实的模型调用 —— 不设闸门时
   * 一步即可耗尽 provider 的并发配额与本机内存。它与 `agent.maxSubagentsPerTurn` 是两回事：
   * 后者统计一轮累计派发数量，本项统计当前同时运行的数量。
   */
  const running = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  /**
   * 一轮内排队的 `spawn_agent` 全部被 abort（`/cancel`）时，`releaseSlot` 一次都不会被调用，
   * 于是 `waiting` 中残留一个空数组条目、`running` 可能残留一个 0，在进程生命周期内不被回收
   * （docs/27 · R-07）。`drop` 的 abort 路径顺带清理一次：队列为空且无运行中任务时，删除两个键。
   */
  const collectSlots = (turnId: string): void => {
    if (waiting.get(turnId)?.length || running.get(turnId)) return;
    waiting.delete(turnId);
    running.delete(turnId);
  };
  /**
   * 获得槽位时返回 true。排队时必须识别 abortSignal：该 promise 原本只由 `releaseSlot` 唤醒，
   * 因此 `/cancel` 之后排在后面的 `spawn_agent` 仍会被唤醒并真正派发一个子 agent —— 已取消的
   * 会话继续消耗 token，而无人等待其结果（`timeoutMs: null`，注册表的兜底 race 也不会终止它）。
   */
  const acquireSlot = async (
    turnId: string,
    limit: number,
    abortSignal: AbortSignal,
  ): Promise<boolean> => {
    if (abortSignal.aborted) return false;
    if ((running.get(turnId) ?? 0) < limit) {
      running.set(turnId, (running.get(turnId) ?? 0) + 1);
      return true;
    }
    const queue = waiting.get(turnId) ?? [];
    waiting.set(turnId, queue);
    const admitted = await new Promise<boolean>((resolve) => {
      const admit = (): void => {
        abortSignal.removeEventListener("abort", drop);
        resolve(true);
      };
      // 出队时需将自身从队列中移除，否则 releaseSlot 会把已放弃的等待者计为一次成功唤醒，
      // 而真正排队的等待者继续等待 —— 由此漏掉一个槽位。
      const drop = (): void => {
        const at = queue.indexOf(admit);
        if (at >= 0) queue.splice(at, 1);
        collectSlots(turnId);
        resolve(false);
      };
      queue.push(admit);
      abortSignal.addEventListener("abort", drop, { once: true });
    });
    if (!admitted) return false;
    running.set(turnId, (running.get(turnId) ?? 0) + 1);
    return true;
  };
  const releaseSlot = (turnId: string): void => {
    running.set(turnId, Math.max(0, (running.get(turnId) ?? 1) - 1));
    const next = waiting.get(turnId)?.shift();
    if (next) next();
    else {
      waiting.delete(turnId);
      if (!running.get(turnId)) running.delete(turnId);
    }
  };
  // 两个 web 工具自带预算（单次 timeoutMs × 最多 retries+1 次，加退避），总时长会超过
  // `tools.defaultTimeoutMs`。向注册表上报自身预算，避免兜底 race 在重试完成前终止调用。
  const webBudgetMs = (web.retries + 1) * web.timeoutMs + 5000;
  registry.register({
    name: "read_file",
    description:
      "读取工作目录或 skill:// 资源，支持 offset/limit 分页（已知路径需查看内容时使用本工具，不要为此调用 bash 的 cat/head）。正文每行带 `行号<TAB>` 前缀，那是用于定位的行号，不是文件内容：写回文件时（edit_file 的 oldString/newString、write_file 的 content）一律不能带它。",
    inputSchema: z.object({
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    policy: builtinPolicy("read_file"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) => {
      if (!input.path.startsWith("skill://"))
        return dependencies
          .filesFor(context.workspace, context.turn.effectiveRole)
          .read(input.path, input.offset, input.limit);
      const path = dependencies.skills.resolveResource(
        input.path,
        context.turn.effectiveRole,
      );
      // 目录判定分支需自行处理：它完全不经过 `FileTools`（理由见 `FileTools.#isDirectory`，
      // 概括为目录的 size 在 btrfs 上为 0，因而 readSync 从不被调用、EISDIR 永不抛出）。
      // 不将 `readSlice` 改为抛出：该函数还有其它调用方。错误码与那一侧保持一致。
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        /* 不存在：readSlice 随后照常如实抛出 ENOENT */
      }
      if (directory)
        return {
          ok: false,
          error: "path_is_directory",
          hint: `${input.path} 是目录不是文件；该 skill 中有哪些文件请查看 load_skill 返回的 files 清单`,
        };
      const offset = input.offset ?? 0;
      // skill 资源同样受 `tools.fs.maxReadBytes` 约束。此前该分支写死 256KB 且接受模型传入的任意
      // `limit`，导致 skill 目录中的大文件可被整份读入 —— 两条读取路径的预算必须一致，
      // 现在读取方式也已统一（`readSlice` 定位读取，docs/27 · R-02）。
      const budget = (context.turn.config as Readonly<Config>).tools.fs
        .maxReadBytes;
      const slice = readSlice(
        path,
        offset,
        Math.min(input.limit ?? budget, budget),
      );
      const more = offset + slice.read < slice.size;
      return {
        ok: true,
        path: input.path,
        content: numberLines(slice.content, slice.firstLine),
        offset,
        bytes: Buffer.byteLength(slice.content),
        truncated: more,
        nextOffset: more ? offset + slice.read : null,
      };
    },
  });
  registry.register({
    name: "list_dir",
    description: "列出工作目录的文件内容",
    inputSchema: z.object({
      path: z.string().default("."),
      depth: z.number().int().min(1).max(5).default(1),
    }),
    policy: builtinPolicy("list_dir"),
    sourcePriority: 100,
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .list(input.path, input.depth),
  });
  registry.register({
    name: "glob",
    description:
      "按文件名模式查找文件（已知文件名或后缀、未知所在位置时使用本工具；已知内容中的文字则使用 grep）。",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().default("."),
    }),
    policy: builtinPolicy("glob"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .glob(input.pattern, input.path),
  });
  registry.register({
    name: "grep",
    description:
      "按内容检索工作目录中的文本（已知要查找的文字、未知所在文件时使用本工具，不要为此调用 bash 的 rg/grep）。glob 限定文件名，contextLines 附带命中行前后各若干行。",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().default("."),
      glob: z.string().optional(),
      contextLines: z.number().int().min(0).max(10).default(0),
      ignoreCase: z.boolean().default(false),
    }),
    policy: builtinPolicy("grep"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .grep(
          input.pattern,
          input.path,
          input.ignoreCase,
          input.glob,
          input.contextLines,
        ),
  });
  registry.register({
    name: "write_file",
    description: "写入工作目录文件，覆盖前会自动备份。",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    policy: builtinPolicy("write_file"),
    sourcePriority: 100,
    approvalTargetExists: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .exists((input as { path: string }).path),
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .write(input.path, input.content),
  });
  registry.register({
    name: "edit_file",
    description: "以唯一 oldString 修改文件。",
    inputSchema: z.object({
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().default(false),
    }),
    policy: builtinPolicy("edit_file"),
    sourcePriority: 100,
    // 与 `write_file` 使用同一判据（`when: 'target_exists'`）：edit 的最后一步即 write，
    // 而其作用对象始终是一个已存在的文件（docs/27 · C-03）。
    approvalTargetExists: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .exists((input as { path: string }).path),
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .edit(input.path, input.oldString, input.newString, input.replaceAll),
  });
  registry.register({
    name: "delete_file",
    description:
      "将文件移入回收站，不物理删除。删除目录需显式传入 recursive:true，且只允许作用于二级及更深的路径。",
    inputSchema: z.object({
      path: z.string(),
      recursive: z.boolean().default(false),
    }),
    policy: builtinPolicy("delete_file"),
    sourcePriority: 100,
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .remove(input.path, input.recursive),
  });
  registry.register({
    name: "move_file",
    description: "移动工作目录文件，不覆盖目标。",
    inputSchema: z.object({ from: z.string(), to: z.string() }),
    policy: builtinPolicy("move_file"),
    sourcePriority: 100,
    approvalTargetExists: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .exists((input as { to: string }).to),
    execute: (input, context) =>
      dependencies
        .filesFor(context.workspace, context.turn.effectiveRole)
        .move(input.from, input.to),
  });
  // `timeoutMs: null` 表示该工具自行管理超时。sandbox.run 会按 `tools.exec.maxTimeoutMs`（默认 300s）
  // 终止进程，远长于 `tools.defaultTimeoutMs`；叠加兜底 race 只会把正常的长命令判为
  // `tool_timeout`，而进程仍在后台运行。
  // `timeoutMs` 的上界写入 schema（doc §3.3）：`sandbox.run` 无论如何都会按 `maxTimeoutMs` 夹取一次，
  // 但仅在内部夹取会使模型无从得知所请求的 30 分钟被改为 5 分钟，进而据此解释命令未执行完。
  const bashSchema = (max: number) =>
    z.object({
      command: z.string(),
      timeoutMs: z.number().int().positive().max(max).optional(),
      description: z.string(),
    });
  const pythonSchema = (max: number) =>
    z.object({
      code: z.string(),
      timeoutMs: z.number().int().positive().max(max).optional(),
      description: z.string(),
    });
  const execMax = (context: ToolExecutionContext): number =>
    (context.turn.config as Readonly<Config>).tools.exec.maxTimeoutMs;
  registry.register({
    name: "bash",
    description:
      "在工作目录执行命令；非 owner 必须使用可用沙箱。仅用于确需执行的操作（运行脚本、安装依赖、处理数据）：读取文件使用 read_file、检索内容使用 grep、查找文件使用 glob、列出目录使用 list_dir —— 这些工具带路径拦截、分页与统一的引用格式，改用 cat/rg/ls 绕过时出错后也更难定位是哪一步失败。",
    inputSchema: bashSchema(300_000),
    inputSchemaFor: (context) => bashSchema(execMax(context)),
    policy: builtinPolicy("bash"),
    sourcePriority: 100,
    timeoutMs: null,
    available: (role, context) =>
      dependencies.sandbox.plan(role, context.workspace).allowed,
    // `chatId` 显式传入：持久容器按会话划分（docs/05 §5.5），不传则退回一次性容器。
    // `parentSpanId` 是 registry 传入的本次 `tool.call` 的 span id —— 不向下传递的话，
    // `sandbox.run` 在 trace 中位于 depth 0，一轮内多次执行只能按时间戳推测配对（docs/29 · M-LOG-02）。
    execute: async (input, context) =>
      dependencies.sandbox.run(
        input.command,
        context.turn.effectiveRole,
        context.workspace,
        context.turn.abortSignal,
        input.timeoutMs,
        context.turn.turnId,
        {
          chatId: context.turn.chatId,
          ...(context.parentSpanId
            ? { parentSpanId: context.parentSpanId }
            : {}),
        },
      ),
  });
  registry.register({
    name: "python",
    description:
      "在工作目录执行 Python 代码；非 owner 必须使用可用沙箱。仅用于确需计算或处理数据的操作：单纯读取文件 / 检索内容 / 列出目录一律使用 read_file / grep / glob / list_dir。",
    inputSchema: pythonSchema(300_000),
    inputSchemaFor: (context) => pythonSchema(execMax(context)),
    policy: builtinPolicy("python"),
    sourcePriority: 100,
    timeoutMs: null,
    available: (role, context) =>
      dependencies.sandbox.plan(role, context.workspace).allowed,
    execute: async (input, context) => {
      // 写入临时文件后执行（doc §3.3），不使用 heredoc：`python3 - <<'PY'` 中正文只要出现一行 `PY`
      // 就会从该处截断脚本，而 stdin 整条被 heredoc 占用 —— 脚本中的 `input()` 读到的是脚本自身
      // 的后半部分，`sys.argv[0]` 为 `-`，traceback 中的文件名为 `<stdin>` 且没有源码行。
      //
      // 路径基于 workspace 拼接，不经 `filesFor`：`tools.fs.allowHostFsForOwner` 开启时 owner 的
      // jail 根为 `/`，`.luoli-tmp/x.py` 会落到 `/.luoli-tmp/`，而沙箱的 cwd 仍为 workspace ——
      // 即使能写入也无法执行（且大概率因 `/` 不可写而直接失败）。该路径由本工具自身生成，
      // 不经模型输入，因此不需要那层 jail；传给沙箱的是 workspace 内的相对路径，在宿主与容器
      // （cwd=/workspace）两种形态下指向同一个文件。
      const directory = join(context.workspace, PYTHON_TMP_DIR);
      const name = `${crypto.randomUUID()}.py`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, name), input.code, { mode: 0o600 });
      try {
        return await dependencies.sandbox.run(
          `python3 ${JSON.stringify(`${PYTHON_TMP_DIR}/${name}`)}`,
          context.turn.effectiveRole,
          context.workspace,
          context.turn.abortSignal,
          input.timeoutMs,
          context.turn.turnId,
          {
            chatId: context.turn.chatId,
            ...(context.parentSpanId
              ? { parentSpanId: context.parentSpanId }
              : {}),
          },
        );
      } finally {
        try {
          rmSync(join(directory, name));
        } catch {
          /* 已在沙箱内被删除，或整个 workspace 已被清理 */
        }
      }
    },
  });
  // 四个 `tools.archive.*Limit` 由此生效。经 `inputSchemaFor` 而非注册期固定：后者每轮读取一次
  // `turn.config`，因此热更新与 perChat 覆盖都能作用于模型看到的那份 schema。
  const archiveLimits = (
    context: ToolExecutionContext,
  ): Config["tools"]["archive"] =>
    (context.turn.config as Readonly<Config>).tools.archive;
  /**
   * 回忆隔断（`context.recallBarrier`）：清空上下文时刻的 `messages.id`，0 表示不设限。
   * 下限写入 SQL 而非过滤返回值 —— 后者会使 `limit:20` 先取满再被削减，模型看到的结果是总数
   * 仅有这几条。开关每次调用实时读取，因此修改后下一次工具调用即生效。
   */
  const recallFloor = (context: ToolExecutionContext): number =>
    (context.turn.config as Readonly<Config>).context.recallBarrier
      ? dependencies.context.recallFloor(context.turn.key)
      : 0;
  /**
   * 隔断削减了结果时必须明确告知。不告知的话模型得到的是一段缺少更早历史的归档，而它会将其
   * 理解为本就不存在 —— 沿用 `droppedTokenNote` 的同一先例（静默降级等同于制造假象）。
   */
  const barrierNote = (floor: number): { recallBarrier?: string } =>
    floor > 0
      ? {
          recallBarrier: `上下文在 #${floor} 之后被清空过，此前的消息不在检索范围内。如果用户提及更早的内容，请用户重新描述一次。`,
        }
      : {};
  const limitField = (fallback: number, max: number) =>
    z.number().int().min(1).max(max).default(Math.min(fallback, max));
  const searchSchema = (limits: {
    defaultSearchLimit: number;
    maxSearchLimit: number;
  }) =>
    z.object({
      query: z.string(),
      from: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      kind: z.string().optional(),
      limit: limitField(limits.defaultSearchLimit, limits.maxSearchLimit),
    });
  const adminSearchSchema = (limits: {
    defaultSearchLimit: number;
    maxSearchLimit: number;
  }) =>
    z.object({
      query: z.string(),
      limit: limitField(limits.defaultSearchLimit, limits.maxSearchLimit),
    });
  const readSchema = (limits: {
    defaultReadLimit: number;
    maxReadLimit: number;
  }) =>
    z.object({
      anchor: z
        .union([z.number().int().positive(), z.string().min(1)])
        .optional(),
      direction: z.enum(["before", "after", "around"]).default("before"),
      limit: limitField(limits.defaultReadLimit, limits.maxReadLimit),
    });
  registry.register({
    name: "search_messages",
    description:
      "在当前会话内搜索聊天记录；可按发言人、时间区间、消息类型过滤。",
    inputSchema: searchSchema({ defaultSearchLimit: 20, maxSearchLimit: 100 }),
    inputSchemaFor: (context) => searchSchema(archiveLimits(context)),
    policy: builtinPolicy("search_messages"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) => {
      const after = parseMoment(input.after);
      const before = parseMoment(input.before);
      if (after === false || before === false)
        return {
          ok: false,
          error: "invalid_time_filter",
          hint: "after / before 需写成 ISO 时间，例如 2026-08-14 或 2026-08-14T10:02:00Z",
        };
      const scope = dependencies.archive.scope(
        context.turn.chatId,
        context.turn.threadId,
      );
      const floor = recallFloor(context);
      const messages = cite(
        scope.search(input.query, input.limit, {
          from: input.from ?? null,
          after,
          before,
          kind: input.kind ?? null,
          minId: floor || null,
        }),
        context,
        scope,
      );
      return {
        ok: true,
        messages,
        ...droppedTokenNote(input.query),
        ...barrierNote(floor),
      };
    },
  });
  registry.register({
    name: "read_messages",
    description:
      "按顺序读取当前会话聊天记录。anchor 可以是消息 id 或 ISO 时间，direction 参数用于决定查询方向是更早还是更晚的聊天记录；不传 anchor 则读取最近若干条。",
    inputSchema: readSchema({ defaultReadLimit: 50, maxReadLimit: 200 }),
    inputSchemaFor: (context) => readSchema(archiveLimits(context)),
    policy: builtinPolicy("read_messages"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) => {
      const anchor = resolveAnchor(input.anchor);
      if (anchor === false)
        return {
          ok: false,
          error: "invalid_anchor",
          hint: "anchor 要么是消息 id（如 12841 或 #12841），要么是 ISO 时间（如 2026-08-14T10:02:00Z）",
        };
      const scope = dependencies.archive.scope(
        context.turn.chatId,
        context.turn.threadId,
      );
      const floor = recallFloor(context);
      return {
        ok: true,
        messages: cite(
          scope.window({
            ...anchor,
            direction: input.direction,
            limit: input.limit,
            minId: floor,
          }),
          context,
          scope,
        ),
        ...barrierNote(floor),
      };
    },
  });
  registry.register({
    name: "get_message",
    description: "读取当前会话的单条归档消息。",
    inputSchema: z.object({ messageId: z.number().int().positive() }),
    policy: builtinPolicy("get_message"),
    sourcePriority: 100,
    untrustedOutput: true,
    execute: (input, context) => {
      const floor = recallFloor(context);
      const message = dependencies.archive
        .scope(context.turn.chatId, context.turn.threadId)
        .byId(input.messageId, floor);
      // 被隔断拦截时不能返回 `message: null`：该结果与消息不存在完全相同，模型会据此更换 id 重试。
      // 需如实说明是被拦截（摘除比伪造安全，docs/16 §5）。
      if (!message && floor > 0 && input.messageId <= floor)
        return {
          ok: false,
          error: "recall_barrier",
          hint: barrierNote(floor).recallBarrier,
        };
      return { ok: true, message };
    },
  });
  // 跨会话检索不提供过滤参数：`adminSearchAll` 不支持它们，而接受参数后静默忽略比不提供该参数
  // 更糟 —— 模型会认为自己已按人过滤（摘除比伪造安全，docs/16 §5）。
  registry.register({
    name: "admin_search_messages",
    description: "跨会话搜索聊天记录，仅 owner。",
    inputSchema: adminSearchSchema({
      defaultSearchLimit: 20,
      maxSearchLimit: 100,
    }),
    inputSchemaFor: (context) => adminSearchSchema(archiveLimits(context)),
    policy: builtinPolicy("admin_search_messages"),
    sourcePriority: 100,
    untrustedOutput: true,
    // 跨会话的行不带 thread 作用域，回复标记无法解析为归档 id，因此只带 `[chat:<id>]` 不带 `↩︎`。
    // 短词丢弃的说明与 `search_messages` 处理一致：跨会话检索使用同一个 `archiveQuery`，
    // 只在其中一个工具上说明，等于让 owner 路径继续得到已完整检索的假象。
    execute: (input, context) => ({
      ok: true,
      messages: citeArchivedMessages(
        dependencies.archive.adminSearchAll(input.query, input.limit),
        {
          timezone: (context.turn.config as Readonly<Config>).general.timezone,
          withChat: true,
        },
      ),
      ...droppedTokenNote(input.query),
    }),
  });
  // 只返回摘要（窗口区间 / 条数 / tokens / 认领水位）。附带完整历史时输出会被 `maxOutputBytes`
  // 从中间截断，模型得到的是被截断的 JSON —— 前半是最早的历史、后半是 commit 列表，
  // 既消耗 token 又没有信息量（docs/27 · R-03）。逐条历史在 WebUI 的会话页查看。
  registry.register({
    name: "context_stats",
    description:
      "读取当前上下文窗口和提交状态的摘要（窗口 ordinal 区间、消息数、tokens、上下文窗口）。",
    inputSchema: z.object({}),
    policy: builtinPolicy("context_stats"),
    sourcePriority: 100,
    execute: (_input, context) => ({
      ok: true,
      ...dependencies.context.stats(context.turn.key),
    }),
  });
  const memoryScopeSchema = (isPrivate: boolean) =>
    z.object({
      scope: isPrivate
        ? z.enum(["pubmemory", "primemory"])
        : z.enum(["pubmemory"]),
    });
  registry.register({
    name: "memory_read",
    description: "读取公开记忆或当前用户私有记忆。",
    inputSchema: memoryScopeSchema(true),
    inputSchemaFor: (context) => memoryScopeSchema(context.turn.isPrivate),
    policy: builtinPolicy("memory_read"),
    sourcePriority: 100,
    execute: (input, context) => ({
      ok: true,
      content: dependencies.memory.read(
        input.scope,
        input.scope === "primemory" ? context.turn.initiatorUserId : null,
        context.turn.effectiveRole,
        context.turn.initiatorUserId,
        context.turn.isPrivate,
      ).content,
    }),
  });
  const memoryWriteSchema = (isPrivate: boolean) =>
    z.object({
      scope: isPrivate
        ? z.enum(["pubmemory", "primemory"])
        : z.enum(["pubmemory"]),
      section: z.string(),
      content: z.string().max(2000),
      reason: z.string(),
    });
  registry.register({
    name: "memory_write",
    description:
      "将决定记录的记忆写入公开记忆或当前用户私有记忆，在一轮对话结束时批量写入。",
    inputSchema: memoryWriteSchema(true),
    inputSchemaFor: (context) => memoryWriteSchema(context.turn.isPrivate),
    policy: builtinPolicy("memory_write"),
    sourcePriority: 100,
    // `memory.pubWriteRequiresApproval`：全局唯一的 PUBMEMORY 会流向所有会话与所有私聊（docs/14 T4），
    // 开启后每一次公开记忆写入都需 owner 批准。私有记忆不受约束 —— 它是写给用户自己的。
    approvalFor: (input, context) =>
      input.scope === "pubmemory" &&
      (context.turn.config as Readonly<Config>).memory.pubWriteRequiresApproval
        ? "always"
        : null,
    execute: (input, context) => {
      const memory = (context.turn.config as Readonly<Config>).memory;
      return dependencies.memory.queueWrite(
        {
          scope: input.scope,
          subject:
            input.scope === "primemory" ? context.turn.initiatorUserId : null,
          section: input.section,
          lines: input.content.split("\n").filter(Boolean),
          actor: "model",
          turnId: context.turn.turnId,
          chatId: context.turn.chatId,
          userId: context.turn.initiatorUserId,
          requireSourceTag: memory.requireSourceTag,
        },
        context.turn.effectiveRole,
        context.turn.isPrivate,
        memory.pubWriteMinRole,
      );
    },
  });
  registry.register({
    name: "load_skill",
    description: "渐进式载入 Skill 正文与资源清单。",
    inputSchema: z.object({ name: z.string() }),
    policy: builtinPolicy("load_skill"),
    sourcePriority: 80,
    execute: (input, context) => {
      const loaded = (context.turn.loadedSkills ??= new Set());
      if (loaded.has(input.name)) return { ok: true, alreadyLoaded: true };
      const result = dependencies.skills.load(
        input.name,
        context.turn.effectiveRole,
        registry.activeNames(context.turn.effectiveRole, context),
      );
      if (result.ok !== false) {
        loaded.add(input.name);
        // 只有声明了 `allowed-tools` 的 skill 才修改允许集（docs/07 §4：未声明则不收窄）。
        // 此前此处无条件并入 loader 返回的 `allowedTools`，而该值等于当前全部可用工具 ——
        // 于是先载入一个 `allowed-tools: [read_file]` 的 skill、再载入一个未声明的，前者的
        // 收窄会被完全抹除。
        if (result.narrows === true) {
          const allowed = Array.isArray(result.allowedTools)
            ? result.allowedTools.filter(
                (name): name is string => typeof name === "string",
              )
            : [];
          const set = (context.turn.skillAllowedTools ??= new Set());
          for (const name of allowed) set.add(name);
        }
        // 附带来源标注：`role` 只能是 user/assistant/tool（provider 拒收 messages 中的 system，
        // docs/02 不变量 15），而 `NOTE_PREFIX` 只对非 sendable role 生效 —— 覆盖不到这一条。
        // 不标注的话，模型看到的是用户发来的一大段 skill 正文，会把说明文档当作用户要求去执行。
        // 不使用 untrusted() 包裹：skill 属于本地可信资源，包裹它等于告知模型不要遵循其内容。
        const body = `${NOTE_PREFIX}以下是 Skill「${input.name}」的正文，由系统按你的 load_skill 调用载入，不是用户发言。\n\n${String(result.body ?? "")}`;
        dependencies.context.appendDelta(context.turn, {
          id: crypto.randomUUID(),
          role: "user",
          origin: "note",
          parts: [{ type: "text", text: body }],
          textPreview: `Skill ${input.name}`,
          pruneLevel: 2,
        });
      }
      return result;
    },
  });
  registry.register({
    name: "memory_list",
    description: "列出全部记忆文档，仅 owner。",
    inputSchema: z.object({}),
    policy: builtinPolicy("memory_list"),
    sourcePriority: 100,
    execute: () => ({ ok: true, documents: dependencies.memory.list() }),
  });
  registry.register({
    name: "list_agents",
    description: "列出当前权限可派发的子 agent。",
    inputSchema: z.object({}),
    policy: builtinPolicy("list_agents"),
    sourcePriority: 90,
    execute: (_input, context) => ({
      ok: true,
      agents: dependencies.agents
        .available(context.turn.effectiveRole)
        .map(({ name, description }) => ({ name, description })),
    }),
  });
  // 子 agent 是一条完整的 agent 循环（自有步数上限与模型超时），墙钟耗时按分钟计：兜底 race
  // 会在其运行中途返回 tool_timeout，而子 agent 仍在继续产生费用。它的边界是 quota 与 maxSteps。
  registry.register({
    name: "spawn_agent",
    description: "派发独立上下文子 agent；task 必须自包含。",
    inputSchema: z.object({
      agent: z.string(),
      task: z.string().min(10),
      context: z.string().optional(),
      modelAlias: z.string().optional(),
      label: z.string().optional(),
    }),
    policy: builtinPolicy("spawn_agent"),
    sourcePriority: 90,
    timeoutMs: null,
    execute: async (input, context) => {
      const perTurn = (context.turn.config as Readonly<Config>).quota.perTurn;
      if (
        dependencies.ledger.turnCost(context.turn.turnId) >= perTurn.maxCostUsd
      )
        return { ok: false, error: "turn_budget_exhausted" };
      const parent = context.agentRunId
        ? dependencies.agents.byId(context.agentRunId)
        : dependencies.agents.createMain(
            context.turn.turnId,
            context.turn.effectiveRole,
            "main",
          );
      if (!parent) return { ok: false, error: "parent_agent_unavailable" };
      const { run, definition } = dependencies.agents.spawn(
        parent,
        input.agent,
        input.task,
        input.modelAlias,
      );
      const taskId = crypto.randomUUID();
      const title = input.label ?? definition.name;
      dependencies.db
        .prepare(
          "INSERT INTO tasks(id,turn_id,agent_run_id,chat_id,user_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'running',?,?)",
        )
        .run(
          taskId,
          context.turn.turnId,
          run.id,
          context.turn.chatId,
          context.turn.initiatorUserId,
          title,
          Date.now(),
          Date.now(),
        );
      dependencies.log.publish("task.updated", {
        id: taskId,
        turnId: context.turn.turnId,
        title,
        state: "running",
        progress: null,
      });
      const live = context.turn.config as Readonly<Config>;
      if (
        !(await acquireSlot(
          context.turn.turnId,
          live.agent.maxConcurrentSubagents,
          context.turn.abortSignal,
        ))
      ) {
        dependencies.agents.fail(run, "turn_cancelled");
        dependencies.db
          .prepare(
            "UPDATE tasks SET state='failed',result_summary=?,updated_at=?,finished_at=? WHERE id=?",
          )
          .run("turn_cancelled", Date.now(), Date.now(), taskId);
        dependencies.log.publish("task.updated", {
          id: taskId,
          turnId: context.turn.turnId,
          title,
          state: "failed",
          progress: null,
        });
        return { ok: false, error: "turn_cancelled", taskId, runId: run.id };
      }
      try {
        // provider 重试设置与配额预留均取自本轮：子 agent 的花费必须计入主 agent 的预留，
        // 否则配额只能统计到主 agent（docs/20 · W-QUOTA-01）。
        const result = await runSubAgent(
          run,
          definition,
          input.task,
          input.context,
          context.turn,
          {
            db: dependencies.db,
            agents: dependencies.agents,
            registry: dependencies.models,
            tools: registry,
            ledger: dependencies.ledger,
            log: dependencies.log,
            workspace: context.workspace,
            provider: {
              maxRetries: live.provider.maxRetries,
              retryBaseMs: live.provider.retryBaseMs,
              retryMaxMs: live.provider.retryMaxMs,
              requestTimeoutMs: live.provider.requestTimeoutMs,
              streamIdleTimeoutMs: live.provider.streamIdleTimeoutMs,
            },
            // 子 agent 整段挂在本次 `spawn_agent` 的 `tool.call` 之下（`docs/10 §7` 第 4 条）。
            // `context` 已是 `execute()` 浅拷贝的副本，因此同一步内并行的多个 spawn 各自持有其父 span。
            ...(context.parentSpanId
              ? { parentSpanId: context.parentSpanId }
              : {}),
            ...(dependencies.quota ? { quota: dependencies.quota } : {}),
            reservation:
              (context.turn.reservation as QuotaReservation | undefined) ??
              null,
          },
          input.modelAlias,
        );
        dependencies.db
          .prepare(
            "UPDATE tasks SET state='done',result_summary=?,updated_at=?,finished_at=? WHERE id=?",
          )
          .run(result.summary, Date.now(), Date.now(), taskId);
        dependencies.log.publish("task.updated", {
          id: taskId,
          turnId: context.turn.turnId,
          title,
          state: "done",
          progress: null,
        });
        return {
          ok: true,
          taskId,
          runId: run.id,
          agent: definition.name,
          ...result,
        };
      } catch (error) {
        dependencies.db
          .prepare(
            "UPDATE tasks SET state='failed',result_summary=?,updated_at=?,finished_at=? WHERE id=?",
          )
          .run(
            error instanceof Error ? error.message : String(error),
            Date.now(),
            Date.now(),
            taskId,
          );
        dependencies.log.publish("task.updated", {
          id: taskId,
          turnId: context.turn.turnId,
          title,
          state: "failed",
          progress: null,
        });
        return {
          ok: false,
          error: error instanceof Error ? error.message : "subagent_failed",
          taskId,
          runId: run.id,
        };
      } finally {
        releaseSlot(context.turn.turnId);
        progressBroadcast.delete(run.id);
      }
    },
  });
  /**
   * M11 · 启动外部 harness CLI 修改宿主上的仓库（docs/14 §2 Q8）。三道门：
   * `available()` 判定仅 owner、仅私聊、目录白名单非空（三者任一不成立时工具不进入模型的工具
   * 目录，而不是进入目录后再报错）；`TOOL_POLICY` 判定 owner 与每次审批；`runHarness` 判定目录。
   * `timeoutMs: null` —— 它自有 `agent.harness.timeoutMs`，注册表的 60s 兜底 race 会在
   * harness 运行中途判为 `tool_timeout`，而该进程仍在修改文件。
   */
  registry.register({
    name: "spawn_harness",
    description:
      "在允许的仓库目录中启动一个外部 coding harness（Claude Code / Codex / omp）执行任务；仅 owner、且仅私聊。",
    inputSchema: z.object({ task: z.string().min(10), dir: z.string() }),
    policy: builtinPolicy("spawn_harness"),
    sourcePriority: 90,
    timeoutMs: null,
    untrustedOutput: true,
    available: (role, context) => {
      const harness = (context.turn.config as Readonly<Config>).agent.harness;
      return (
        role === "owner" &&
        context.turn.isPrivate &&
        harness.allowedDirs.length > 0
      );
    },
    execute: async (input, context) => {
      const harness = (context.turn.config as Readonly<Config>).agent.harness;
      // `available()` 已判定过一次，此处再判定一次：热更新可能在注册与执行之间清空目录名单，
      // 而模型可能沿用上一步的工具名（禁用必须是硬边界，CLAUDE.md）。
      if (!context.turn.isPrivate || context.turn.effectiveRole !== "owner")
        return {
          ok: false,
          error: "harness_forbidden",
          hint: "仅 owner 在私聊中可用",
        };
      const started = Date.now();
      const result = await runHarness(
        input.task,
        input.dir,
        harness,
        context.turn.abortSignal,
      );
      dependencies.log.event({
        level: result.ok ? "info" : "warn",
        kind: "agent.harness",
        summary: `harness ${result.ok ? "ok" : result.error} · ${result.dir ?? input.dir}`,
        traceId: context.turn.turnId,
        chatId: context.turn.chatId,
        userId: context.turn.initiatorUserId,
        data: {
          dir: result.dir ?? input.dir,
          command: harness.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          ms: Date.now() - started,
        },
      });
      return result;
    },
  });
  /**
   * M13 · 启动一台本机编码 agent 修改宿主上的仓库，走 ACP 协议（`docs/05 §3.5`）。
   *
   * 三道门与 `spawn_harness` 完全一致，且必须一致 —— 风险面相同（`docs/14` T17）：
   * `available()` 判定仅 owner、仅私聊、整块启用、目录白名单非空、至少一台已启用的 agent；
   * `TOOL_POLICY` 判定 owner 与每次审批；`AcpManager.run` 再判定一次目录。
   * `timeoutMs: null` —— 它自有 `agents[].timeoutMs`，注册表的 60s 兜底 race 会在 agent
   * 运行中途判为 `tool_timeout`，而该进程仍在修改文件。
   */
  const acpSettings = (context: ToolExecutionContext): AcpSettings =>
    (context.turn.config as Readonly<Config>).agent.acp;
  /**
   * 存在多台 agent 时为 `agent` 参数添加枚举，单 agent 部署的 schema 逐字节不变 ——
   * 只有一台 agent 的部署不应因该特性多出一个模型必须填写的参数。
   */
  const acpInputSchema = (
    names: readonly string[],
  ): z.ZodType<{ task: string; dir: string; agent?: string }> =>
    names.length > 1
      ? z.object({
          task: z.string().min(10),
          dir: z.string(),
          agent: z.enum(names as unknown as [string, ...string[]]),
        })
      : z.object({ task: z.string().min(10), dir: z.string() });
  /**
   * `permissionMode === 'ask'` 但运行时没有审批 broker 时，整个工具不进入目录（与 `allowedDirs`
   * 为空同形态）。名为 `ask` 的档位实际放行，正是 `docs/reviews/16 §5` 所述的伪造一道门；
   * `ask` 不是默认档（默认为 `auto`，`docs/14 §2 Q8-c`），因此该闸门只对主动配置它的部署生效；
   * 且置于 `available()` 优于置于 `execute()`：模型不会去尝试一个必然被拒绝的调用。
   */
  const acpPermissionReady = (acp: AcpSettings): boolean =>
    acp.permissionMode !== "ask" || Boolean(dependencies.approvals);
  registry.register({
    name: "spawn_acp",
    description:
      "在允许的仓库目录中让一台本机 code agent（经 ACP 协议驱动）执行任务；仅 owner、仅私聊。它自带一整套工具（读写与修改文件、执行 shell 命令）并会实际修改仓库 —— 任务需写成自包含的一段话，说明目标、约束与验收方式（例如「改完跑 pnpm test」）。",
    inputSchema: acpInputSchema([]),
    inputSchemaFor: (context) =>
      acpInputSchema(
        enabledAcpAgents(acpSettings(context)).map((agent) => agent.name),
      ),
    policy: builtinPolicy("spawn_acp"),
    sourcePriority: 90,
    timeoutMs: null,
    untrustedOutput: true,
    available: (role, context) => {
      const acp = acpSettings(context);
      return (
        Boolean(dependencies.acp) &&
        role === "owner" &&
        context.turn.isPrivate &&
        acp.enabled &&
        acp.allowedDirs.length > 0 &&
        acp.agents.some((agent) => agent.enabled) &&
        acpPermissionReady(acp)
      );
    },
    execute: async (input, context) => {
      // `available()` 已判定过一次，此处再判定一次：热更新可能在注册与执行之间关闭整块功能或清空
      // 目录名单，而模型可能沿用上一步的工具名（禁用必须是硬边界，CLAUDE.md）。
      // 整块开关与目录名单由 `AcpManager.run` 判定（`acp_disabled`），此处只判定它覆盖不到的两项。
      // 文案经 `acpFailure` 生成而非就地编写：`ACP_ERROR_HINTS` 是唯一来源，工具壳自行复制一份的话，
      // 先改文档的纪律就只能验证到 manager 那一半（`docs/05 §3.5.1` 的表是二者共同的文档来源）。
      if (!dependencies.acp) return acpFailure("acp_unavailable");
      if (!context.turn.isPrivate || context.turn.effectiveRole !== "owner")
        return acpFailure("acp_forbidden");
      const live = context.turn.config as Readonly<Config>;
      const acp = acpSettings(context);
      if (!acpPermissionReady(acp)) return acpFailure("acp_unavailable");
      const approvals = dependencies.approvals;
      /**
       * 进度卡片。渲染选项取自本轮配置 —— `output.*` 位于 `PER_CHAT_OVERRIDE_ALLOWLIST` 中，
       * 读取全局快照会静默丢弃会话级覆盖（`main.ts` 中若干读快照的 getter 属于既有缺陷）。
       * 无法获得卡片时（没有 Telegram 入口 / 适配层未实现 / 该会话无法创建）照常运行，存在即启用。
       */
      // agent 名称与目录经 `resolveAcpTarget` 解析 —— 与 `AcpManager.run` 使用同一判据。卡片自行再算
      // 一遍会使屏幕显示的目录与实际运行的目录成为两个可能分叉的答案；而 `dir` 是卡片将 agent 上报的
      // 绝对路径相对化的基点（不提供时每行退回长路径，在预算较小时会额外丢失一整段）。
      // 无法获得（准入未通过）时不填写：`run()` 随后会用同一判据返回该失败。
      const target = resolveAcpTarget(
        {
          task: input.task,
          dir: input.dir,
          ...(input.agent ? { agent: input.agent } : {}),
        },
        acp,
      );
      const card =
        (await dependencies.telegram
          ?.openProgressCard?.(
            // `turnId` 是卡片两条 `tg.send` / `tg.edit` span 的 traceId —— 不提供则退化为平铺结构
            // （`docs/28 · L-LOG-02`）。`parentSpanId` 使它们挂在本次 `tool.call` 之下。
            {
              chatId: context.turn.chatId,
              threadId: context.turn.threadId,
              turnId: context.turn.turnId,
              ...(context.parentSpanId
                ? { parentSpanId: context.parentSpanId }
                : {}),
            },
            {
              parseMode: live.output.parseMode,
              maxMessageChars: live.output.maxMessageChars,
              intervalMs: acp.progressIntervalMs,
              ...(target.ok
                ? { agent: target.agent.name, dir: target.root }
                : {}),
            },
          )
          .catch(() => null)) ?? null;
      const result = await dependencies.acp.run(
        {
          task: input.task,
          dir: input.dir,
          ...(input.agent ? { agent: input.agent } : {}),
        },
        acp,
        {
          abortSignal: context.turn.abortSignal,
          // 与注册表 `#normalizeOutput` 使用同一上界（`main.ts` 将其接为 `tools.exec.maxOutputBytes`），
          // 由 manager 扣减固定字段的占用 —— 使按构造有界这一保证有一个真实的基数。
          outputBudgetBytes: live.tools.exec.maxOutputBytes,
          /**
           * 反向调用面的宿主侧闸门。jail 不复用 `dependencies.filesFor` —— 那份的 root 是
           * `data/workspace/<chatId>`（`docs/14 Q8-b`），而 `tools.fs.allowHostFsForOwner` 开启后其 root
           * 即为 `/`：ACP 的边界必须是本次被批准的那个仓库目录。`denyGlobs` 照常生效（绝对路径 glob，
           * 不依赖 root），自撰写通道的两条也一并带上 —— 外部 agent 更不应能修改已启用的 plugin。
           */
          host: {
            fs: {
              denyGlobs: [
                ...live.tools.fs.denyGlobs,
                ...selfAuthoringDenyGlobs({
                  skillsDir: live.skills.dir,
                  pluginsDir: live.plugins.dir,
                }),
              ],
              maxReadBytes: live.tools.fs.maxReadBytes,
              maxWriteBytes: live.tools.fs.maxWriteBytes,
              backupDir: live.tools.fs.backupDir,
            },
            exec: {
              maxTimeoutMs: live.tools.exec.maxTimeoutMs,
              maxOutputBytes: live.tools.exec.maxOutputBytes,
            },
            // 终端在宿主直接运行，因此申报前先查询一次。`bypassRoles: ['owner']` 下该查询对 ACP 恒为
            // `'host'`；运维将 owner 从 bypassRoles 中移除时，terminal 能力立即不再申报（而不是申报后
            // 每次 create 都失败）。
            plan: (root) =>
              dependencies.sandbox.plan(context.turn.effectiveRole, root),
          },
          hooks: {
            ...(card
              ? { onUpdate: (notification) => card.push(notification) }
              : {}),
            // 只有 `ask` 档位会被调用（由 manager 判定），因此此处无条件提供：提供后若 mode 为 auto/deny，
            // 它不会被调用，而将 mode 判据复制到此处等于同一判据存在两份。
            ...(approvals
              ? {
                  permission: (binding) =>
                    acpPermissionGate({
                      approvals,
                      context,
                      log: dependencies.log,
                      ...binding,
                    }),
                }
              : {}),
          },
          trace: {
            traceId: context.turn.turnId,
            chatId: context.turn.chatId,
            userId: context.turn.initiatorUserId,
            key: context.turn.key,
          },
        },
      );
      // 终帧。`close` 按契约不抛出异常，但此处 `await` 是刻意的：归档只在这一次发生，而工具返回后
      // 本轮即进入收尾。返回值是适配层自身的凭据，core 不做解释。
      if (card) {
        await card.close({
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
          ...(result.error ? { error: result.error } : {}),
          files: result.filesWritten ?? 0,
          failures: result.failures ?? 0,
          toolCalls: result.toolCalls ?? 0,
          ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
        });
      }
      return result;
    },
  });
  registry.register({
    name: "read_agent_result",
    description: "分页读取子 agent 完整结果。",
    inputSchema: z.object({
      runId: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(262_144).default(65_536),
    }),
    policy: builtinPolicy("read_agent_result"),
    sourcePriority: 90,
    execute: (input) => ({
      ok: true,
      ...dependencies.agents.result(input.runId, input.offset, input.limit),
    }),
  });
  // `timeoutMs: null`：仲裁自有硬期限（`agent.askTimeoutMs`），再叠加一层 `tools.defaultTimeoutMs`
  // 的 60s race 只会使默认配置下的仲裁在运行中途被判为 `tool_timeout`，而模型调用继续产生费用。
  registry.register({
    name: "ask_parent",
    description: "向父 agent 提问；仅子 agent 可用。",
    inputSchema: z.object({
      question: z.string(),
      options: z.array(z.string()).default([]),
      default: z.string().optional(),
    }),
    policy: builtinPolicy("ask_parent"),
    sourcePriority: 90,
    timeoutMs: null,
    available: (_role, context) => context.agentKind === "sub",
    execute: async (input, context) => {
      const run = context.agentRunId
        ? dependencies.agents.byId(context.agentRunId)
        : null;
      const parent = run?.parentRunId
        ? dependencies.agents.byId(run.parentRunId)
        : null;
      if (!run || !parent)
        return { ok: false, error: "parent_agent_unavailable" };
      const count = dependencies.db
        .prepare(
          "SELECT COUNT(*) FROM agent_messages WHERE from_run_id=? AND kind='ask'",
        )
        .pluck()
        .get(run.id) as number;
      if (count >= (dependencies.maxAsksPerRun ?? 5))
        return { ok: false, error: "agent_ask_limit_exceeded" };
      const askId = dependencies.agents.ask(run, parent, input);
      const live = context.turn.config as Readonly<Config>;
      // 一次请示对应一个 span（`docs/10 §1` 的 span H）：仲裁的模型调用与 `agent.answer` 均挂在其下。
      // 父节点是本次 `ask_parent` 的 `tool.call` —— 请示在实现上即一次工具调用，图中的 `parent=E`
      // 遗漏了中间这一跳。
      const askSpan = dependencies.log.span({
        level: "info",
        kind: "agent.ask",
        summary: `${run.agentName} → ${parent.agentName}`,
        traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId,
        userId: context.turn.initiatorUserId,
        key: context.turn.key,
        data: {
          askId,
          fromRun: run.id,
          toRun: parent.id,
          options: input.options?.length ?? 0,
        },
      });
      /** 三条降级路径共用：`agent.answer` 挂在 `agent.ask` 之下，`source` 标明应答方。 */
      const answered = (
        source: "arbiter" | "rule" | "timeout",
        answer: string | null,
      ): void => {
        dependencies.agents.answer(askId, answer, source);
        askSpan.end({ source, answered: answer !== null });
        dependencies.log.event({
          level: "info",
          kind: "agent.answer",
          summary: `${parent.agentName} → ${run.agentName} (${source})`,
          traceId: context.turn.turnId,
          parentSpanId: askSpan.id,
          chatId: context.turn.chatId,
          userId: context.turn.initiatorUserId,
          key: context.turn.key,
          data: {
            askId,
            fromRun: parent.id,
            toRun: run.id,
            source,
            chars: answer?.length ?? 0,
          },
        });
      };
      // 父 agent 仲裁（docs/14 A7）。此前此处返回 `ask_parent_not_implemented` —— 那是正确的降级
      // （更早的版本以子 agent 自身的 options[0] 作为答复并返回 ok:true，等于伪造请示已获批，
      // docs/19 · R-TOOL-01），但它使三个配置键长期未接线。现在会实际调用一次 low 档模型。
      if (live.agent.askArbiter) {
        const task = dependencies.db
          .prepare("SELECT task_input AS task FROM agent_runs WHERE id=?")
          .pluck()
          .get(run.id) as string | undefined;
        const verdict = await arbitrateAsk(
          parent,
          {
            question: input.question,
            options: input.options ?? [],
            agentName: run.agentName,
            task: task ?? "",
          },
          context.turn,
          {
            registry: dependencies.models,
            ledger: dependencies.ledger,
            log: dependencies.log,
            ...(dependencies.quota ? { quota: dependencies.quota } : {}),
            reservation:
              (context.turn.reservation as QuotaReservation | undefined) ??
              null,
            parentSpanId: askSpan.id,
            provider: {
              maxRetries: live.provider.maxRetries,
              retryBaseMs: live.provider.retryBaseMs,
              retryMaxMs: live.provider.retryMaxMs,
              requestTimeoutMs: live.provider.requestTimeoutMs,
              streamIdleTimeoutMs: live.provider.streamIdleTimeoutMs,
            },
          },
          { timeoutMs: live.agent.askTimeoutMs },
        );
        if (verdict.ok) {
          answered("arbiter", verdict.answer);
          return { ok: true, askId, answer: verdict.answer, source: "arbiter" };
        }
        // 仲裁失败不是静默事件：它已产生费用或本应产生费用，而子 agent 随后会按无人应答处理。
        // `escalationRequested` 是刻意记录的：`askEscalateToUser` 仍未接线（转人工需要一条阻塞式
        // 人机通道，docs/25 §8 的缺口仍存在），运维开启它却无任何效果时，日志中需有对应记录。
        dependencies.log.event({
          level: verdict.reason === "cancelled" ? "info" : "warn",
          kind: "agent.ask_unarbitrated",
          summary: `ask_parent arbitration ${verdict.reason}`,
          traceId: context.turn.turnId,
          parentSpanId: askSpan.id,
          chatId: context.turn.chatId,
          data: {
            askId,
            agentRunId: run.id,
            reason: verdict.reason,
            detail: verdict.detail,
            escalationRequested: live.agent.askEscalateToUser,
          },
        });
      }
      // 降级顺序：仲裁 → 子 agent 自带的 default → 明确说明无人应答。不伪造答复（docs/16 §5）。
      if (input.default !== undefined) {
        answered("rule", input.default);
        return { ok: true, askId, answer: input.default, source: "default" };
      }
      answered("timeout", null);
      return {
        ok: false,
        error: "ask_parent_unanswered",
        hint: live.agent.askArbiter
          ? "仲裁未能给出答复；请在 task 中自带决策依据，或在调用时提供 default"
          : "仲裁已关闭（agent.askArbiter=false）；请在 task 中自带决策依据，或在调用时提供 default",
        askId,
      };
    },
  });
  registry.register({
    name: "report_progress",
    description: "报告子 agent 当前进度。",
    inputSchema: z.object({
      status: z.string(),
      current: z.number().optional(),
      total: z.number().optional(),
      detail: z.string().optional(),
    }),
    policy: builtinPolicy("report_progress"),
    sourcePriority: 90,
    available: (_role, context) => context.agentKind === "sub",
    execute: (input, context) => {
      const run = context.agentRunId
        ? dependencies.agents.byId(context.agentRunId)
        : null;
      if (!run) return { ok: false, error: "agent_run_unavailable" };
      dependencies.agents.progress(run, input);
      // 记录一条 debug：`docs/10 §2` 为 `agent.progress` 定义的字段即 phase 与 done/total。它不受
      // 下方 SSE 节流约束 —— 节流保护的是浏览器连接，日志侧本就按 `logs.level` 分级。
      dependencies.log.event({
        level: "debug",
        kind: "agent.progress",
        summary: `${run.agentName}: ${input.status}`,
        traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        key: context.turn.key,
        data: {
          agentRunId: run.id,
          phase: input.status,
          done: input.current ?? null,
          total: input.total ?? null,
        },
      });
      // `agent.progressThrottleMs`：库中该行照常更新（它表示当前状态，读取方总是看到最新值），但 SSE
      // 只在节流窗口外广播。一个高频汇报的子 agent 每步上报一次，足以把 WebUI 的事件流刷成进度条。
      const throttleMs = (context.turn.config as Readonly<Config>).agent
        .progressThrottleMs;
      const last = progressBroadcast.get(run.id) ?? 0;
      const now = Date.now();
      if (now - last >= throttleMs) {
        progressBroadcast.set(run.id, now);
        dependencies.log.publish("task.updated", {
          id: null,
          runId: run.id,
          turnId: context.turn.turnId,
          state: "running",
          progress: input,
        });
      }
      return { ok: true };
    },
  });
  // 文案必须写明仅本轮生效：该覆盖不跨轮持久（docs/04 §5.2、AC-AGENT-007），而模型曾据此告知
  // 用户已切换到 vision 模型 —— 下一轮（真正带图的那一轮）早已回到默认别名
  // （logs/2026-08-18 22:15）。含图轮次现在会自动切换 vision，模型无需自行操作。
  registry.register({
    name: "set_model",
    description:
      "为**当前这一轮剩余的步骤**切换模型别名；本轮结束即失效，不跨轮保留。",
    inputSchema: z.object({ alias: z.enum(["main", "high", "low", "vision"]) }),
    policy: builtinPolicy("set_model"),
    sourcePriority: 90,
    execute: (input, context) => {
      Object.assign(context.turn, { modelAliasOverride: input.alias });
      return {
        ok: true,
        alias: input.alias,
        scope: "this_turn_only",
        note: "本轮结束后自动回到默认别名，不要告知用户已永久切换。",
      };
    },
  });
  registry.register({
    name: "web_search",
    description: "搜索公开网络；瞬时失败（超时/5xx/429）会自动重试。",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    policy: builtinPolicy("web_search"),
    sourcePriority: 100,
    untrustedOutput: true,
    timeoutMs: webBudgetMs,
    available: () =>
      Boolean(
        dependencies.webSearch?.provider && dependencies.webSearch.apiKey,
      ),
    execute: (input, context) =>
      webSearch(
        dependencies.webSearch!.provider as
          "brave" | "serper" | "tavily" | "exa",
        dependencies.webSearch!.apiKey,
        input.query,
        input.limit ?? 5,
        context.turn.abortSignal,
        web,
        dependencies.maxWebBytes,
      ),
  });
  registry.register({
    name: "send_message",
    description:
      "向当前会话追发一条消息（正文请直接写入回复，本工具用于分段或中间产物）。",
    inputSchema: z.object({ text: z.string().min(1) }),
    policy: builtinPolicy("send_message"),
    sourcePriority: 100,
    available: () => Boolean(dependencies.telegram),
    execute: async (input, context) =>
      claimExtraMessage(context) ??
      dependencies.telegram!.sendMessage(target(context), input.text),
  });
  registry.register({
    name: "send_photo",
    description: "将工作目录内的图片发送到当前会话。",
    inputSchema: z.object({
      photo: z.string(),
      caption: z.string().optional(),
    }),
    policy: builtinPolicy("send_photo"),
    sourcePriority: 100,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    available: () => Boolean(dependencies.telegram),
    execute: async (input, context) => {
      const file = resolveOutgoingFile(
        context,
        dependencies.filesFor(context.workspace, context.turn.effectiveRole),
        input.photo,
      );
      if (!file.ok) return file;
      return (
        claimExtraMessage(context) ??
        dependencies.telegram!.sendPhoto(
          target(context),
          file.absolute,
          input.caption,
        )
      );
    },
  });
  registry.register({
    name: "react",
    description:
      "为消息添加 emoji reaction；不填 messageId 则作用于触发本轮的那条消息。",
    inputSchema: z.object({
      messageId: z.number().int().positive().optional(),
      emoji: z.string(),
    }),
    policy: builtinPolicy("react"),
    sourcePriority: 100,
    available: () => Boolean(dependencies.telegram),
    execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId)
        return {
          ok: false,
          error: "message_id_required",
          hint: "本轮没有触发消息，请先使用 read_messages 获取 tgMessageId。",
        };
      return dependencies.telegram!.react(
        target(context),
        messageId,
        input.emoji,
      );
    },
  });
  registry.register({
    name: "send_file",
    description: "将工作目录内的文件作为文档发送到当前会话。",
    inputSchema: z.object({ file: z.string(), caption: z.string().optional() }),
    policy: builtinPolicy("send_file"),
    sourcePriority: 100,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    available: () => Boolean(dependencies.telegram),
    execute: async (input, context) => {
      const file = resolveOutgoingFile(
        context,
        dependencies.filesFor(context.workspace, context.turn.effectiveRole),
        input.file,
      );
      if (!file.ok) return file;
      return (
        claimExtraMessage(context) ??
        dependencies.telegram!.sendFile(
          target(context),
          file.absolute,
          input.caption,
        )
      );
    },
  });
  registry.register({
    name: "pin_message",
    description: "置顶指定的消息；不填 messageId 则置顶触发本轮的那条。",
    inputSchema: z.object({
      messageId: z.number().int().positive().optional(),
    }),
    policy: builtinPolicy("pin_message"),
    sourcePriority: 100,
    available: () => Boolean(dependencies.telegram),
    execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId)
        return {
          ok: false,
          error: "message_id_required",
          hint: "本轮没有触发消息，请先使用 read_messages 获取 tgMessageId。",
        };
      return dependencies.telegram!.pin(target(context), messageId);
    },
  });
  registry.register({
    name: "web_fetch",
    description:
      "获取公开 HTTP/HTTPS 页面；拒绝私有地址、docker 私有地址与元数据地址。瞬时失败（超时/5xx/429）会自动重试。",
    inputSchema: z.object({ url: z.string().url() }),
    policy: builtinPolicy("web_fetch"),
    sourcePriority: 100,
    untrustedOutput: true,
    // `limited` 只在配置了 allowlist 时才拥有 web_fetch（docs/05 §4）：没有白名单等于把整个互联网
    // 开放给权限最低的角色，而该工具的输出会直接进入上下文。fail-closed 落在 `available()`，
    // 因此工具不会进入目录，模型不会去尝试一个必然被拒绝的调用。
    available: (role, context) =>
      role !== "limited" ||
      (context.turn.config as Readonly<Config>).tools.web.allowlist.length > 0,
    // 域名白名单与黑名单取自本轮配置（`tools.web` 不在 perChat 白名单中，因此就是全局那份，
    // 但仍经 turn.config 读取 —— 热更新后下一轮生效，无需重启）。
    timeoutMs: webBudgetMs,
    execute: (input, context) => {
      const live = (context.turn.config as Readonly<Config>).tools.web;
      return webFetch(
        input.url,
        dependencies.maxWebBytes,
        context.turn.abortSignal,
        web,
        { allowlist: live.allowlist, denylist: live.denylist },
        webMediaSink(context),
      );
    },
  });
}
