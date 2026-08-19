import { z } from 'zod';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentManager, Config, ContextEngine, FileTools, MemoryStore, ModelRegistry, QuotaGuard, QuotaReservation, Sandbox, SkillLoader, ToolRegistry, UsageLedger, LogSink } from '@luoli/core';
import { DEFAULT_WEB_RETRY, NOTE_PREFIX, arbitrateAsk, builtinPolicy, numberLines, readSlice, runHarness, runSubAgent, webFetch, webSearch, type WebRetryOptions } from '@luoli/core';
import type { ArchiveRepository, ArchivedMessage, ScopedArchiveRepository } from '@luoli/db';
import { archiveQuery } from '@luoli/db';
import { citeArchivedMessages } from './cite.js';
import { registerScheduleTools, type ScheduleToolDependencies } from './schedule.js';
import type { Role } from '@luoli/shared';
import type { ToolExecutionContext } from './registry.js';

/** 一次投递的落点。thread 必须跟着走，否则话题群里的追发会掉到「General」去。 */
export interface TelegramTarget {
  chatId: string;
  threadId: number | null;
  turnId: string;
  /** 这次投递该挂在哪个 span 之下（`docs/10 §1`）。工具路径给的是本次 `tool.call` 的 span id。 */
  parentSpanId?: string;
}

/**
 * Telegram 侧工具的适配层契约（实现在 `packages/telegram/src/tools.ts`）。core 只负责本轮语义
 * ——jail 解析、大小与条数上限、messageId 缺省——真正的 API 调用、emoji 白名单、发出去之后
 * 写回归档都在适配层。
 *
 * 依赖里这一项**故意是必填的**（没有 Telegram 入口就显式传 `null`）：它曾经是可选的，于是
 * `main.ts` 少传一个 key 就让五个工具永久消失 —— `available()` 判的就是它在不在，而
 * `TOOL_POLICY ↔ 注册表` 的启动断言只看「注册没注册」，一个字都没报，模型答「我没有这个功能」。
 * 写成必填之后，同样的遗漏是一个编译错误。
 */
export interface TelegramToolBridge {
  sendMessage(target: TelegramTarget, text: string): Promise<object>;
  sendPhoto(target: TelegramTarget, absolutePath: string, caption?: string): Promise<object>;
  sendFile(target: TelegramTarget, absolutePath: string, caption?: string): Promise<object>;
  react(target: TelegramTarget, messageId: number, emoji: string): Promise<object>;
  pin(target: TelegramTarget, messageId: number): Promise<object>;
}

/**
 * 上传的耗时跟文件大小走（`tools.tg.maxFileSendMb` 默认 50MB），拿 `tools.defaultTimeoutMs`
 * 的 60s 去卡它等于把正常的大文件上传砍成 `tool_timeout`。给一个够宽但仍然有限的预算 ——
 * 「没有上限」在这条链上就是卡死一整轮。
 */
const UPLOAD_TIMEOUT_MS = 300_000;
/** `python` 的脚本落点（doc §3.3）。带前导点，所以默认不会出现在 `list_dir` / `glob` 里。 */
const PYTHON_TMP_DIR = '.luoli-tmp';

const target = (context: ToolExecutionContext): TelegramTarget =>
  ({ chatId: context.turn.chatId, threadId: context.turn.threadId, turnId: context.turn.turnId, ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}) });
/** 取本轮那份合并后的配置：运维在 WebUI 改了上限，下一轮就该生效（`tools.tg` 在热更新白名单里）。 */
const tgLimits = (context: ToolExecutionContext): Config['tools']['tg'] => (context.turn.config as Readonly<Config>).tools.tg;

/**
 * 追发预算按**调用次数**扣，成功与否都算：上限防的是刷屏，而失败重试同样在刷屏。
 * 计数挂在 turn 上而不是模块级 Map —— 轮次对象随轮次消亡，不需要谁去清理。
 */
function claimExtraMessage(context: ToolExecutionContext): { ok: false; error: string; hint: string } | null {
  const max = tgLimits(context).maxExtraMessagesPerTurn;
  const used = context.turn.extraMessages ?? 0;
  if (used >= max) return { ok: false, error: 'extra_message_limit_exceeded', hint: `本轮最多追发 ${max} 条（tools.tg.maxExtraMessagesPerTurn）；正文请直接写进回复。` };
  Object.assign(context.turn, { extraMessages: used + 1 });
  return null;
}

/**
 * `read_messages` 的 `anchor`：消息 id 或 ISO 时间（docs/05 §3.2）。数字串一律按 id 认 ——
 * 模型十有八九把上下文里 `#12841` 的数字当字符串递过来，而 `Date.parse('12841')` 在某些运行时
 * 会解析成一个年份，于是它读到一段完全不相干的记录，还以为那就是自己要的位置。
 * 解析失败交回 `false`，让调用方给出一句能照着改的错误，而不是悄悄退回「最近 N 条」。
 */
function resolveAnchor(anchor: number | string | undefined): { anchorId?: number; anchorDate?: number } | false {
  if (anchor === undefined) return {};
  if (typeof anchor === 'number') return { anchorId: anchor };
  const trimmed = anchor.trim().replace(/^#/, '');
  if (/^\d+$/.test(trimmed)) return { anchorId: Number(trimmed) };
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? false : { anchorDate: parsed };
}
/** `search_messages` 的 after / before。`undefined`（没传）与解析失败必须分开，后者要报错。 */
function parseMoment(value: string | undefined): number | null | false {
  if (value === undefined) return null;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? false : parsed;
}

/** 三个列表型检索工具共用的渲染（doc §3.2 的 `#id [时间] 发言人: 正文` 一行一条）。 */
function cite(messages: readonly ArchivedMessage[], context: ToolExecutionContext, scope: ScopedArchiveRepository): string[] {
  return citeArchivedMessages(messages, { timezone: (context.turn.config as Readonly<Config>).general.timezone,
    resolveReplies: (ids) => scope.archiveIdsByTgMessageIds(ids) });
}

/**
 * 短词进不了 trigram 索引，剔掉是**正确降级**（`archiveQuery` 的 docstring 写明了理由）——
 * 但不说出来就是「我按你写的都查了」的假象：`search_messages("名字 李小明")` 只按 `李小明`
 * 检索过，而模型据此判定「没有这回事」（docs/28 · L-DB-01）。给的是可操作的下一步，
 * 不是一句免责声明。两个检索工具共用一份文案 —— 各写一份的结果是其中一个以后忘了改。
 */
function droppedTokenNote(query: string): { note?: string } {
  const dropped = archiveQuery(query).dropped;
  return dropped.length ? { note: `以下词短于 3 个字、trigram 索引检索不到，本次未参与检索：${dropped.join('、')}。需要按它们找就把它们单独作为 query 再查一次（单独查会走逐字匹配）。` } : {};
}

/** workspace 内的绝对路径 + 大小闸门。越界、不存在、超限三种都要在调 API 之前变成 `ok:false`。 */
function resolveOutgoingFile(context: ToolExecutionContext, files: FileTools, path: string): { ok: false; error: string; hint?: string } | { ok: true; absolute: string } {
  let absolute: string;
  try { absolute = files.resolve(path); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'path_invalid', hint: '只能发工作目录内的文件。' }; }
  if (!files.exists(path)) return { ok: false, error: 'file_not_found', hint: path };
  const bytes = statSync(absolute).size;
  const limit = tgLimits(context).maxFileSendMb * 1024 * 1024;
  if (bytes > limit) return { ok: false, error: 'file_too_large', hint: `${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${tgLimits(context).maxFileSendMb}MB 上限（tools.tg.maxFileSendMb）` };
  return { ok: true, absolute };
}

export function registerBuiltins(registry: ToolRegistry, dependencies: { db: import('@luoli/db').Sqlite; filesFor: (workspace: string, role: Role) => FileTools; sandbox: Sandbox; archive: ArchiveRepository; context: ContextEngine; memory: MemoryStore; skills: SkillLoader; agents: AgentManager; models: ModelRegistry; ledger: UsageLedger; log: LogSink; quota?: QuotaGuard; telegram: TelegramToolBridge | null; schedule: ScheduleToolDependencies; maxWebBytes: number; maxAsksPerRun?: number; web?: WebRetryOptions; webSearch?: { provider: '' | 'brave' | 'serper' | 'tavily' | 'exa'; apiKey: string } }): void {
  const web = dependencies.web ?? DEFAULT_WEB_RETRY;
  // 跟 `telegram` 同样是必填：漏传一个 key 就让三个工具永久消失，而
  // 「TOOL_POLICY ↔ 注册表」的启动断言只看注册没注册，一个字都不会报。
  registerScheduleTools(registry, dependencies.schedule);
  /** 每个 agent_run 上一次向 SSE 广播进度的时刻（`agent.progressThrottleMs`）。 */
  const progressBroadcast = new Map<string, number>();
  /**
   * `agent.maxConcurrentSubagents`：同一轮里**同时在跑**的子 agent 数上限。
   * 模型可以在一步里并排发多个 `spawn_agent`，每个都是一次真实的模型调用 —— 不设闸的话
   * 一步就能把 provider 的并发配额和本机内存一起打满。这与 `agent.maxSubagentsPerTurn`
   * 是两件事：那个数的是一轮**总共**派过几个，这个数的是此刻同时有几个在跑。
   */
  const running = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  /**
   * 一轮里排队的 `spawn_agent` **全部**被 abort（`/cancel`）时，`releaseSlot` 一次都不会被调到，
   * 于是 `waiting` 里留下一个空数组条目、`running` 可能留下一个 0，进程生命周期内不回收
   * （docs/27 · R-07）。`drop` 那条 abort 路径顺手清一次：队列空了、没有在跑的，就把两个键都删掉。
   */
  const collectSlots = (turnId: string): void => {
    if (waiting.get(turnId)?.length || running.get(turnId)) return;
    waiting.delete(turnId);
    running.delete(turnId);
  };
  /**
   * 拿到槽位返回 true。排队时**必须认 abortSignal**：这个 promise 原本只由 `releaseSlot` 唤醒，
   * 于是 `/cancel` 之后排在后面的 `spawn_agent` 照样会醒过来、照样真的去派一个子 agent —— 一轮
   * 已经取消的对话继续烧 token，而没有任何人还在等它的结果（`timeoutMs: null`，注册表那道兜底
   * 的 race 也不会砍它）。
   */
  const acquireSlot = async (turnId: string, limit: number, abortSignal: AbortSignal): Promise<boolean> => {
    if (abortSignal.aborted) return false;
    if ((running.get(turnId) ?? 0) < limit) { running.set(turnId, (running.get(turnId) ?? 0) + 1); return true; }
    const queue = waiting.get(turnId) ?? [];
    waiting.set(turnId, queue);
    const admitted = await new Promise<boolean>((resolve) => {
      const admit = (): void => { abortSignal.removeEventListener('abort', drop); resolve(true); };
      // 出队时把自己从队列里摘掉，否则 releaseSlot 会把一个已经放弃的等待者当成「唤醒了一个」，
      // 而真正在排队的那个继续等 —— 槽位就这么漏掉一个。
      const drop = (): void => { const at = queue.indexOf(admit); if (at >= 0) queue.splice(at, 1); collectSlots(turnId); resolve(false); };
      queue.push(admit);
      abortSignal.addEventListener('abort', drop, { once: true });
    });
    if (!admitted) return false;
    running.set(turnId, (running.get(turnId) ?? 0) + 1);
    return true;
  };
  const releaseSlot = (turnId: string): void => {
    running.set(turnId, Math.max(0, (running.get(turnId) ?? 1) - 1));
    const next = waiting.get(turnId)?.shift();
    if (next) next();
    else { waiting.delete(turnId); if (!running.get(turnId)) running.delete(turnId); }
  };
  // 两个 web 工具自带预算（单次 timeoutMs × 最多 retries+1 次 + 退避），整体会比
  // `tools.defaultTimeoutMs` 长。给注册表报一份自己的账，别让兜底那道 race 在重试走完前先砍掉。
  const webBudgetMs = (web.retries + 1) * web.timeoutMs + 5000;
  registry.register({ name: 'read_file', description: '读取工作目录或 skill:// 资源，支持 offset/limit 分页（知道路径要看内容时用它，不要为此起 bash 里的 cat/head）。正文每行带 `行号<TAB>` 前缀，那只是给你定位用的坐标，不是文件内容：写回文件时（edit_file 的 oldString/newString、write_file 的 content）一律不能带它。', inputSchema: z.object({ path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }), policy: builtinPolicy('read_file'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => {
      if (!input.path.startsWith('skill://')) return dependencies.filesFor(context.workspace, context.turn.effectiveRole).read(input.path, input.offset, input.limit);
      const path = dependencies.skills.resolveResource(input.path, context.turn.effectiveRole);
      const offset = input.offset ?? 0;
      // skill 资源同样受 `tools.fs.maxReadBytes` 管。此前这一支写死 256KB 且照收模型传的任意
      // `limit`，于是 skill 目录里一个大文件能整份读进来 —— 两条读路径的预算必须是同一份，
      // 现在连读法也是同一份（`readSlice` 定位读，docs/27 · R-02）。
      const budget = (context.turn.config as Readonly<Config>).tools.fs.maxReadBytes;
      const slice = readSlice(path, offset, Math.min(input.limit ?? budget, budget));
      const more = offset + slice.read < slice.size;
      return { ok: true, path: input.path, content: numberLines(slice.content, slice.firstLine), offset, bytes: Buffer.byteLength(slice.content), truncated: more, nextOffset: more ? offset + slice.read : null };
    } });
  registry.register({ name: 'list_dir', description: '列出工作目录下有什么（只想知道目录结构时用它，不要为此起 bash）。depth 默认 1，别一上来就摊开五层。', inputSchema: z.object({ path: z.string().default('.'), depth: z.number().int().min(1).max(5).default(1) }), policy: builtinPolicy('list_dir'), sourcePriority: 100,
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).list(input.path, input.depth) });
  registry.register({ name: 'glob', description: '按文件名形状找文件（知道名字或后缀、不知道在哪时用它；知道内容里有什么字就用 grep）。', inputSchema: z.object({ pattern: z.string(), path: z.string().default('.') }), policy: builtinPolicy('glob'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).glob(input.pattern, input.path) });
  registry.register({ name: 'grep', description: '按内容搜工作目录里的文本（知道要找什么字、不知道在哪个文件时用它，不要为此起 bash 里的 rg/grep）。glob 限定文件名，contextLines 附带命中行前后各若干行。', inputSchema: z.object({ pattern: z.string(), path: z.string().default('.'), glob: z.string().optional(), contextLines: z.number().int().min(0).max(10).default(0), ignoreCase: z.boolean().default(false) }), policy: builtinPolicy('grep'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).grep(input.pattern, input.path, input.ignoreCase, input.glob, input.contextLines) });
  registry.register({ name: 'write_file', description: '原子写入工作目录文件，覆盖前自动备份。', inputSchema: z.object({ path: z.string(), content: z.string() }), policy: builtinPolicy('write_file'), sourcePriority: 100,
    approvalTargetExists: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).exists((input as { path: string }).path),
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).write(input.path, input.content) });
  registry.register({ name: 'edit_file', description: '以唯一 oldString 修改文件。', inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string(), replaceAll: z.boolean().default(false) }), policy: builtinPolicy('edit_file'), sourcePriority: 100,
    // 与 `write_file` 同一个判据（`when: 'target_exists'`）：edit 的最后一步就是 write，
    // 而它作用的对象**总是**一个已存在的文件（docs/27 · C-03）。
    approvalTargetExists: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).exists((input as { path: string }).path),
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).edit(input.path, input.oldString, input.newString, input.replaceAll) });
  registry.register({ name: 'delete_file', description: '将文件移入回收站，不物理删除。删目录要显式 recursive:true，且只允许作用在二级及更深的路径。', inputSchema: z.object({ path: z.string(), recursive: z.boolean().default(false) }), policy: builtinPolicy('delete_file'), sourcePriority: 100,
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).remove(input.path, input.recursive) });
  registry.register({ name: 'move_file', description: '移动工作目录文件，不覆盖目标。', inputSchema: z.object({ from: z.string(), to: z.string() }), policy: builtinPolicy('move_file'), sourcePriority: 100,
    approvalTargetExists: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).exists((input as { to: string }).to),
    execute: (input, context) => dependencies.filesFor(context.workspace, context.turn.effectiveRole).move(input.from, input.to) });
  // `timeoutMs: null` = 这个工具自己管超时。sandbox.run 会按 `tools.exec.maxTimeoutMs`（默认 300s）
  // kill 进程，比 `tools.defaultTimeoutMs` 长得多；套上兜底那道 race 只会把正常的长命令砍成
  // `tool_timeout`，而进程还在后台跑着。
  // `timeoutMs` 的上界写进 schema（doc §3.3）：`sandbox.run` 反正会按 `maxTimeoutMs` 夹一次，
  // 但夹在里面模型就永远不知道自己要的 30 分钟被改成了 5 分钟，然后据此去解释「命令没跑完」。
  const bashSchema = (max: number) => z.object({ command: z.string(), timeoutMs: z.number().int().positive().max(max).optional(), description: z.string() });
  const pythonSchema = (max: number) => z.object({ code: z.string(), timeoutMs: z.number().int().positive().max(max).optional(), description: z.string() });
  const execMax = (context: ToolExecutionContext): number => (context.turn.config as Readonly<Config>).tools.exec.maxTimeoutMs;
  registry.register({ name: 'bash', description: '在工作目录执行命令；非 owner 必须使用可用沙箱。留给真正需要执行的事（跑脚本、装依赖、处理数据）：读文件用 read_file、搜内容用 grep、找文件用 glob、看目录用 list_dir —— 那些工具带路径拦截、分页和统一的引用格式，用 cat/rg/ls 绕过去出错时也更难说清坏在哪一步。', inputSchema: bashSchema(300_000), inputSchemaFor: (context) => bashSchema(execMax(context)), policy: builtinPolicy('bash'), sourcePriority: 100, timeoutMs: null,
    available: (role, context) => dependencies.sandbox.plan(role, context.workspace).allowed,
    // `chatId` 显式传：持久容器按会话分（docs/05 §5.5），不传就退回一次性容器。
    execute: async (input, context) => dependencies.sandbox.run(input.command, context.turn.effectiveRole, context.workspace, context.turn.abortSignal, input.timeoutMs, context.turn.turnId, { chatId: context.turn.chatId }) });
  registry.register({ name: 'python', description: '在工作目录执行 Python 代码；非 owner 必须使用可用沙箱。留给真正需要计算或处理数据的事：单纯读文件 / 搜内容 / 列目录一律走 read_file / grep / glob / list_dir。', inputSchema: pythonSchema(300_000), inputSchemaFor: (context) => pythonSchema(execMax(context)), policy: builtinPolicy('python'), sourcePriority: 100, timeoutMs: null,
    available: (role, context) => dependencies.sandbox.plan(role, context.workspace).allowed,
    execute: async (input, context) => {
      // 落成临时文件再跑（doc §3.3），不用 heredoc：`python3 - <<'PY'` 里正文只要出现一行 `PY`
      // 就把脚本从那里截断，而 stdin 整条被 heredoc 占着 —— 脚本里的 `input()` 读到的是自己
      // 的后半截，`sys.argv[0]` 是 `-`，traceback 里的文件名是 `<stdin>` 且没有源码行。
      //
      // 路径按 **workspace** 拼，不走 `filesFor`：`tools.fs.allowHostFsForOwner` 打开时 owner 的
      // jail 根是 `/`，`.luoli-tmp/x.py` 会落到 `/.luoli-tmp/` 去，而沙箱的 cwd 仍是 workspace ——
      // 写得进去也跑不到（还大概率因为 `/` 不可写直接失败）。这个路径是本工具自己生成的，
      // 不经模型的手，所以不需要那层 jail；交给沙箱的则是 workspace 内的相对路径，宿主与容器
      // （cwd=/workspace）两种形态下都指同一个文件。
      const directory = join(context.workspace, PYTHON_TMP_DIR);
      const name = `${crypto.randomUUID()}.py`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, name), input.code, { mode: 0o600 });
      try { return await dependencies.sandbox.run(`python3 ${JSON.stringify(`${PYTHON_TMP_DIR}/${name}`)}`, context.turn.effectiveRole, context.workspace, context.turn.abortSignal, input.timeoutMs, context.turn.turnId, { chatId: context.turn.chatId }); }
      finally { try { rmSync(join(directory, name)); } catch { /* 沙箱里删掉了、或整个 workspace 被清了 */ } }
    } });
  // 四个 `tools.archive.*Limit` 从这里生效。走 `inputSchemaFor` 而不是注册期固定：那是**每轮**
  // 取一次 `turn.config`，所以热更新和 perChat 覆盖都能落到模型看到的那份 schema 上。
  const archiveLimits = (context: ToolExecutionContext): Config['tools']['archive'] => (context.turn.config as Readonly<Config>).tools.archive;
  /**
   * 回忆隔断（`context.recallBarrier`）：清空上下文那一刻的 `messages.id`，0 = 不设限。
   * 下限灌进 SQL 而不是过滤返回值 —— 后者会让 `limit:20` 先取满再被削短，模型看到的是
   * 「一共只有这么几条」。开关每次调用现读，所以改完下一次工具调用就生效。
   */
  const recallFloor = (context: ToolExecutionContext): number =>
    (context.turn.config as Readonly<Config>).context.recallBarrier ? dependencies.context.recallFloor(context.turn.key) : 0;
  /**
   * **隔断削短了结果就必须说出来。** 不说的话模型拿到的是一段没有更早历史的归档，而它会把这个
   * 当成「本来就没有」——照 `droppedTokenNote` 同一条先例（沉默的降级等于假象）。
   */
  const barrierNote = (floor: number): { recallBarrier?: string } => floor > 0
    ? { recallBarrier: `上下文在 #${floor} 之后被清空过，那之前的消息不在检索范围内（context.recallBarrier 开着）。用户提起更早的事，请让他重说一次。` }
    : {};
  const limitField = (fallback: number, max: number) => z.number().int().min(1).max(max).default(Math.min(fallback, max));
  const searchSchema = (limits: { defaultSearchLimit: number; maxSearchLimit: number }) =>
    z.object({ query: z.string(), from: z.string().optional(), after: z.string().optional(), before: z.string().optional(), kind: z.string().optional(),
      limit: limitField(limits.defaultSearchLimit, limits.maxSearchLimit) });
  const adminSearchSchema = (limits: { defaultSearchLimit: number; maxSearchLimit: number }) =>
    z.object({ query: z.string(), limit: limitField(limits.defaultSearchLimit, limits.maxSearchLimit) });
  const readSchema = (limits: { defaultReadLimit: number; maxReadLimit: number }) =>
    z.object({ anchor: z.union([z.number().int().positive(), z.string().min(1)]).optional(), direction: z.enum(['before', 'after', 'around']).default('before'),
      limit: limitField(limits.defaultReadLimit, limits.maxReadLimit) });
  registry.register({ name: 'search_messages', description: '在当前会话内搜索聊天记录；可按发言人、时间区间、消息类型过滤。', inputSchema: searchSchema({ defaultSearchLimit: 20, maxSearchLimit: 100 }),
    inputSchemaFor: (context) => searchSchema(archiveLimits(context)), policy: builtinPolicy('search_messages'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => {
      const after = parseMoment(input.after);
      const before = parseMoment(input.before);
      if (after === false || before === false) return { ok: false, error: 'invalid_time_filter', hint: 'after / before 要写成 ISO 时间，例如 2026-08-14 或 2026-08-14T10:02:00Z' };
      const scope = dependencies.archive.scope(context.turn.chatId, context.turn.threadId);
      const floor = recallFloor(context);
      const messages = cite(scope.search(input.query, input.limit, { from: input.from ?? null, after, before, kind: input.kind ?? null, minId: floor || null }), context, scope);
      return { ok: true, messages, ...droppedTokenNote(input.query), ...barrierNote(floor) };
    } });
  registry.register({ name: 'read_messages', description: '按顺序读取当前会话聊天记录。anchor 可以是消息 id 或 ISO 时间，direction 决定往哪边读；不给 anchor 就是最近若干条。', inputSchema: readSchema({ defaultReadLimit: 50, maxReadLimit: 200 }),
    inputSchemaFor: (context) => readSchema(archiveLimits(context)), policy: builtinPolicy('read_messages'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => {
      const anchor = resolveAnchor(input.anchor);
      if (anchor === false) return { ok: false, error: 'invalid_anchor', hint: 'anchor 要么是消息 id（如 12841 或 #12841），要么是 ISO 时间（如 2026-08-14T10:02:00Z）' };
      const scope = dependencies.archive.scope(context.turn.chatId, context.turn.threadId);
      const floor = recallFloor(context);
      return { ok: true, messages: cite(scope.window({ ...anchor, direction: input.direction, limit: input.limit, minId: floor }), context, scope), ...barrierNote(floor) };
    } });
  registry.register({ name: 'get_message', description: '读取当前会话的单条归档消息。', inputSchema: z.object({ messageId: z.number().int().positive() }), policy: builtinPolicy('get_message'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => {
      const floor = recallFloor(context);
      const message = dependencies.archive.scope(context.turn.chatId, context.turn.threadId).byId(input.messageId, floor);
      // 被隔断挡住时**不能**回 `message: null`：那和「这条消息不存在」长得一模一样，而模型会据此
      // 换个 id 再试一遍。如实说是被挡住的（「摘除比伪造安全」，docs/16 §5）。
      if (!message && floor > 0 && input.messageId <= floor) return { ok: false, error: 'recall_barrier', hint: barrierNote(floor).recallBarrier };
      return { ok: true, message };
    } });
  // 跨会话检索**不给**过滤参数：`adminSearchAll` 不认它们，而收下一个参数再默默忽略比没有这个
  // 参数更糟 —— 模型会以为自己已经按人过滤过了（「摘除比伪造安全」，docs/16 §5）。
  registry.register({ name: 'admin_search_messages', description: '跨会话搜索聊天记录，仅 owner。', inputSchema: adminSearchSchema({ defaultSearchLimit: 20, maxSearchLimit: 100 }),
    inputSchemaFor: (context) => adminSearchSchema(archiveLimits(context)), policy: builtinPolicy('admin_search_messages'), sourcePriority: 100, untrustedOutput: true,
    // 跨会话的行不带 thread 作用域，回复标记换不出归档 id，所以只带 `[chat:<id>]` 不带 `↩︎`。
    // 短词丢弃的 note 与 `search_messages` 同办：跨会话检索走的是同一个 `archiveQuery`，
    // 只在其中一个工具上说出来，等于让 owner 那条路继续拿到「我全查过了」的假象。
    execute: (input, context) => ({ ok: true, messages: citeArchivedMessages(dependencies.archive.adminSearchAll(input.query, input.limit),
      { timezone: (context.turn.config as Readonly<Config>).general.timezone, withChat: true }), ...droppedTokenNote(input.query) }) });
  // 只回摘要（窗口区间 / 条数 / tokens / 认领水位）。带上整份历史时输出会被 `maxOutputBytes`
  // 从中间截断，模型拿到的是一段掐断的 JSON —— 前半是最早的历史、后半是 commit 列表，
  // 既烧 token 又没有信息（docs/27 · R-03）。逐条历史在 WebUI 的会话页。
  registry.register({ name: 'context_stats', description: '读取当前上下文窗口和提交状态的摘要（窗口 ordinal 区间、消息数、tokens、背景认领水位）。不含逐条历史。', inputSchema: z.object({}), policy: builtinPolicy('context_stats'), sourcePriority: 100,
    execute: (_input, context) => ({ ok: true, ...dependencies.context.stats(context.turn.key) }) });
  const memoryScopeSchema = (isPrivate: boolean) => z.object({ scope: isPrivate ? z.enum(['pubmemory', 'primemory']) : z.enum(['pubmemory']) });
  registry.register({ name: 'memory_read', description: '读取公开记忆或当前用户私有记忆。', inputSchema: memoryScopeSchema(true),
    inputSchemaFor: (context) => memoryScopeSchema(context.turn.isPrivate), policy: builtinPolicy('memory_read'), sourcePriority: 100,
    execute: (input, context) => ({ ok: true, content: dependencies.memory.read(input.scope, input.scope === 'primemory' ? context.turn.initiatorUserId : null, context.turn.effectiveRole, context.turn.initiatorUserId, context.turn.isPrivate).content }) });
  const memoryWriteSchema = (isPrivate: boolean) => z.object({ scope: isPrivate ? z.enum(['pubmemory', 'primemory']) : z.enum(['pubmemory']), section: z.string(), content: z.string().max(2000), reason: z.string() });
  registry.register({ name: 'memory_write', description: '把长期有效事实写入公开或当前用户私有记忆，一轮结束时批量落盘。', inputSchema: memoryWriteSchema(true),
    inputSchemaFor: (context) => memoryWriteSchema(context.turn.isPrivate), policy: builtinPolicy('memory_write'), sourcePriority: 100,
    // `memory.pubWriteRequiresApproval`：全局单份 PUBMEMORY 会流到所有会话与所有私聊（docs/14 T4），
    // 开了它之后每一次公开记忆写入都要 owner 点头。私有记忆不受管 —— 那是写给用户自己的。
    approvalFor: (input, context) => input.scope === 'pubmemory' && (context.turn.config as Readonly<Config>).memory.pubWriteRequiresApproval ? 'always' : null,
    execute: (input, context) => {
      const memory = (context.turn.config as Readonly<Config>).memory;
      return dependencies.memory.queueWrite({ scope: input.scope, subject: input.scope === 'primemory' ? context.turn.initiatorUserId : null,
        section: input.section, lines: input.content.split('\n').filter(Boolean), actor: 'model', turnId: context.turn.turnId,
        chatId: context.turn.chatId, userId: context.turn.initiatorUserId, requireSourceTag: memory.requireSourceTag },
      context.turn.effectiveRole, context.turn.isPrivate, memory.pubWriteMinRole);
    } });
  registry.register({ name: 'load_skill', description: '渐进式载入 Skill 正文与资源清单。', inputSchema: z.object({ name: z.string() }), policy: builtinPolicy('load_skill'), sourcePriority: 80,
    execute: (input, context) => {
      const loaded = (context.turn.loadedSkills ??= new Set());
      if (loaded.has(input.name)) return { ok: true, alreadyLoaded: true };
      const result = dependencies.skills.load(input.name, context.turn.effectiveRole, registry.activeNames(context.turn.effectiveRole, context));
      if (result.ok !== false) {
        loaded.add(input.name);
        // 只有**声明了** `allowed-tools` 的 skill 才动允许集（docs/07 §4：未声明则不收窄）。
        // 此前这里无条件并入 loader 交回的 `allowedTools`，而那一档等于「当前全部可用工具」——
        // 于是先载入一个 `allowed-tools: [read_file]` 的 skill、再载入一个不声明的，前一个的
        // 收窄就被整个抹掉了。
        if (result.narrows === true) {
          const allowed = Array.isArray(result.allowedTools) ? result.allowedTools.filter((name): name is string => typeof name === 'string') : [];
          const set = (context.turn.skillAllowedTools ??= new Set());
          for (const name of allowed) set.add(name);
        }
        // 带来源标注：`role` 只能是 user/assistant/tool（provider 拒收 messages 里的 system，
        // docs/02 不变量 15），而 `NOTE_PREFIX` 只对非 sendable role 生效 —— 够不着这一条。
        // 不标的话模型看到的就是「用户发来一大段 skill 正文」，会把说明书当成用户的要求去执行。
        // **不用 untrusted() 包**：skill 是本地可信资源，包起来等于告诉模型别照着做。
        const body = `${NOTE_PREFIX}以下是 Skill「${input.name}」的正文，由系统按你的 load_skill 调用载入，不是用户发言。\n\n${String(result.body ?? '')}`;
        dependencies.context.appendDelta(context.turn, { id: crypto.randomUUID(), role: 'user', origin: 'note', parts: [{ type: 'text', text: body }], textPreview: `Skill ${input.name}`, pruneLevel: 2 });
      }
      return result;
    } });
  registry.register({ name: 'memory_list', description: '列出全部记忆文档，仅 owner。', inputSchema: z.object({}), policy: builtinPolicy('memory_list'), sourcePriority: 100,
    execute: () => ({ ok: true, documents: dependencies.memory.list() }) });
  registry.register({ name: 'list_agents', description: '列出当前权限可派发的子 agent。', inputSchema: z.object({}), policy: builtinPolicy('list_agents'), sourcePriority: 90,
    execute: (_input, context) => ({ ok: true, agents: dependencies.agents.available(context.turn.effectiveRole).map(({ name, description }) => ({ name, description })) }) });
  // 子 agent 是完整的一条 agent 循环（自己的步数上限、自己的模型超时），墙钟按分钟算：兜底那道
  // race 会在它跑到一半时返回 tool_timeout，而子 agent 还在继续花钱。它的边界是 quota 与 maxSteps。
  registry.register({ name: 'spawn_agent', description: '派发独立上下文子 agent；task 必须自包含。', inputSchema: z.object({ agent: z.string(), task: z.string().min(10), context: z.string().optional(), modelAlias: z.string().optional(), label: z.string().optional() }), policy: builtinPolicy('spawn_agent'), sourcePriority: 90, timeoutMs: null,
    execute: async (input, context) => {
      const perTurn = (context.turn.config as Readonly<Config>).quota.perTurn;
      if (dependencies.ledger.turnCost(context.turn.turnId) >= perTurn.maxCostUsd) return { ok: false, error: 'turn_budget_exhausted' };
      const parent = context.agentRunId ? dependencies.agents.byId(context.agentRunId) : dependencies.agents.createMain(context.turn.turnId, context.turn.effectiveRole, 'main');
      if (!parent) return { ok: false, error: 'parent_agent_unavailable' };
      const { run, definition } = dependencies.agents.spawn(parent, input.agent, input.task, input.modelAlias);
      const taskId = crypto.randomUUID();
      const title = input.label ?? definition.name;
      dependencies.db.prepare("INSERT INTO tasks(id,turn_id,agent_run_id,chat_id,user_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'running',?,?)")
        .run(taskId, context.turn.turnId, run.id, context.turn.chatId, context.turn.initiatorUserId, title, Date.now(), Date.now());
      dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'running', progress: null });
      const live = context.turn.config as Readonly<Config>;
      if (!await acquireSlot(context.turn.turnId, live.agent.maxConcurrentSubagents, context.turn.abortSignal)) {
        dependencies.agents.fail(run, 'turn_cancelled');
        dependencies.db.prepare("UPDATE tasks SET state='failed',result_summary=?,updated_at=?,finished_at=? WHERE id=?").run('turn_cancelled', Date.now(), Date.now(), taskId);
        dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'failed', progress: null });
        return { ok: false, error: 'turn_cancelled', taskId, runId: run.id };
      }
      try {
        // provider 重试设置与配额预留都从本轮取：子 agent 的花费必须落进主 agent 那份预留，
        // 否则配额只看得见主 agent（docs/20 · W-QUOTA-01）。
        const result = await runSubAgent(run, definition, input.task, input.context, context.turn, { db: dependencies.db, agents: dependencies.agents, registry: dependencies.models, tools: registry, ledger: dependencies.ledger, log: dependencies.log, workspace: context.workspace,
          provider: { maxRetries: live.provider.maxRetries, retryBaseMs: live.provider.retryBaseMs, retryMaxMs: live.provider.retryMaxMs,
            requestTimeoutMs: live.provider.requestTimeoutMs, streamIdleTimeoutMs: live.provider.streamIdleTimeoutMs },
          // 子 agent 那一整段挂在**本次** `spawn_agent` 的 `tool.call` 之下（`docs/10 §7` 第 4 条）。
          // `context` 已经是 `execute()` 浅拷贝过的那一份，所以同一步里并排的几个 spawn 各带自己的父。
          ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
          ...(dependencies.quota ? { quota: dependencies.quota } : {}), reservation: (context.turn.reservation as QuotaReservation | undefined) ?? null }, input.modelAlias);
        dependencies.db.prepare("UPDATE tasks SET state='done',result_summary=?,updated_at=?,finished_at=? WHERE id=?").run(result.summary, Date.now(), Date.now(), taskId);
        dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'done', progress: null });
        return { ok: true, taskId, runId: run.id, agent: definition.name, ...result };
      } catch (error) {
        dependencies.db.prepare("UPDATE tasks SET state='failed',result_summary=?,updated_at=?,finished_at=? WHERE id=?").run(error instanceof Error ? error.message : String(error), Date.now(), Date.now(), taskId);
        dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'failed', progress: null });
        return { ok: false, error: error instanceof Error ? error.message : 'subagent_failed', taskId, runId: run.id };
      } finally {
        releaseSlot(context.turn.turnId);
        progressBroadcast.delete(run.id);
      }
    } });
  /**
   * M11 · 起一个外部 harness CLI 改宿主上的仓库（docs/14 §2 Q8）。三道门：
   * `available()` 判**仅 owner + 仅私聊 + 目录白名单非空**（三者任一不成立，工具根本不进模型的
   * 工具目录，而不是进了目录再报错）；`TOOL_POLICY` 判 owner + 每次都审批；`runHarness` 判目录。
   * `timeoutMs: null` —— 它自己有 `agent.harness.timeoutMs`，注册表那道 60s 兜底 race 会在
   * harness 跑到一半时判 `tool_timeout`，而那个进程还在改文件。
   */
  registry.register({ name: 'spawn_harness', description: '在允许的仓库目录里起一个外部 coding harness（Claude Code / Codex）执行任务；仅 owner、仅私聊。', inputSchema: z.object({ task: z.string().min(10), dir: z.string() }), policy: builtinPolicy('spawn_harness'), sourcePriority: 90, timeoutMs: null, untrustedOutput: true,
    available: (role, context) => {
      const harness = (context.turn.config as Readonly<Config>).agent.harness;
      return role === 'owner' && context.turn.isPrivate && harness.allowedDirs.length > 0;
    },
    execute: async (input, context) => {
      const harness = (context.turn.config as Readonly<Config>).agent.harness;
      // `available()` 已经判过一遍，这里再判一次：热更新可能在注册与执行之间把目录名单清空，
      // 而模型完全可能沿用上一步的工具名（禁用必须是硬边界，CLAUDE.md）。
      if (!context.turn.isPrivate || context.turn.effectiveRole !== 'owner') return { ok: false, error: 'harness_forbidden', hint: '仅 owner 在私聊里可用' };
      const started = Date.now();
      const result = await runHarness(input.task, input.dir, harness, context.turn.abortSignal);
      dependencies.log.event({ level: result.ok ? 'info' : 'warn', kind: 'agent.harness', summary: `harness ${result.ok ? 'ok' : result.error} · ${result.dir ?? input.dir}`,
        traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId,
        data: { dir: result.dir ?? input.dir, command: harness.command, exitCode: result.exitCode, timedOut: result.timedOut, ms: Date.now() - started } });
      return result;
    } });
  registry.register({ name: 'read_agent_result', description: '分页读取子 agent 完整结果。', inputSchema: z.object({ runId: z.string(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(262_144).default(65_536) }), policy: builtinPolicy('read_agent_result'), sourcePriority: 90,
    execute: (input) => ({ ok: true, ...dependencies.agents.result(input.runId, input.offset, input.limit) }) });
  // `timeoutMs: null`：仲裁自己有硬期限（`agent.askTimeoutMs`），再叠一层 `tools.defaultTimeoutMs`
  // 的 60s race 只会让默认配置下的仲裁在跑到一半时被判 `tool_timeout`，而模型调用继续花钱。
  registry.register({ name: 'ask_parent', description: '向父 agent 提问；仅子 agent 可用。', inputSchema: z.object({ question: z.string(), options: z.array(z.string()).default([]), default: z.string().optional() }), policy: builtinPolicy('ask_parent'), sourcePriority: 90, timeoutMs: null,
    available: (_role, context) => context.agentKind === 'sub', execute: async (input, context) => {
      const run = context.agentRunId ? dependencies.agents.byId(context.agentRunId) : null;
      const parent = run?.parentRunId ? dependencies.agents.byId(run.parentRunId) : null;
      if (!run || !parent) return { ok: false, error: 'parent_agent_unavailable' };
      const count = dependencies.db.prepare("SELECT COUNT(*) FROM agent_messages WHERE from_run_id=? AND kind='ask'").pluck().get(run.id) as number;
      if (count >= (dependencies.maxAsksPerRun ?? 5)) return { ok: false, error: 'agent_ask_limit_exceeded' };
      const askId = dependencies.agents.ask(run, parent, input);
      const live = context.turn.config as Readonly<Config>;
      // 一次请示是一个 span（`docs/10 §1` 的 span H）：仲裁的模型调用与 `agent.answer` 都挂在它之下。
      // 父是本次 `ask_parent` 的 `tool.call` —— 请示在实现里就是一次工具调用，图里那条 `parent=E`
      // 少画了中间这一跳。
      const askSpan = dependencies.log.span({ level: 'info', kind: 'agent.ask', summary: `${run.agentName} → ${parent.agentName}`,
        traceId: context.turn.turnId, ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
        data: { askId, fromRun: run.id, toRun: parent.id, options: input.options?.length ?? 0 } });
      /** 三条降级路径共用：`agent.answer` 挂在 `agent.ask` 之下，`source` 说清是谁答的。 */
      const answered = (source: 'arbiter' | 'rule' | 'timeout', answer: string | null): void => {
        dependencies.agents.answer(askId, answer, source);
        askSpan.end({ source, answered: answer !== null });
        dependencies.log.event({ level: 'info', kind: 'agent.answer', summary: `${parent.agentName} → ${run.agentName} (${source})`,
          traceId: context.turn.turnId, parentSpanId: askSpan.id, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
          data: { askId, fromRun: parent.id, toRun: run.id, source, chars: answer?.length ?? 0 } });
      };
      // 父 agent 仲裁（docs/14 A7）。此前这里返回 `ask_parent_not_implemented` —— 那是正确的降级
      // （更早的版本拿子 agent 自己的 options[0] 当答复并返回 ok:true，等于伪造「请示已获批」，
      // docs/19 · R-TOOL-01），但它让三个配置键长期挂着。现在真的问一次 low 档模型。
      if (live.agent.askArbiter) {
        const task = dependencies.db.prepare('SELECT task_input AS task FROM agent_runs WHERE id=?').pluck().get(run.id) as string | undefined;
        const verdict = await arbitrateAsk(parent, { question: input.question, options: input.options ?? [], agentName: run.agentName, task: task ?? '' }, context.turn,
          { registry: dependencies.models, ledger: dependencies.ledger, log: dependencies.log, ...(dependencies.quota ? { quota: dependencies.quota } : {}),
            reservation: (context.turn.reservation as QuotaReservation | undefined) ?? null, parentSpanId: askSpan.id,
            provider: { maxRetries: live.provider.maxRetries, retryBaseMs: live.provider.retryBaseMs, retryMaxMs: live.provider.retryMaxMs,
              requestTimeoutMs: live.provider.requestTimeoutMs, streamIdleTimeoutMs: live.provider.streamIdleTimeoutMs } },
          { timeoutMs: live.agent.askTimeoutMs });
        if (verdict.ok) { answered('arbiter', verdict.answer); return { ok: true, askId, answer: verdict.answer, source: 'arbiter' }; }
        // 仲裁没成不是静默事件：它花了钱或者本该花钱，而子 agent 接下来会按「没人应答」走。
        // `escalationRequested` 是刻意记出来的：`askEscalateToUser` 仍未接线（转人工要一条阻塞式
        // 人机通道，docs/25 §8 那个缺口还开着），运维把它打开却什么都没发生时，日志里得有一行。
        dependencies.log.event({ level: verdict.reason === 'cancelled' ? 'info' : 'warn', kind: 'agent.ask_unarbitrated', summary: `ask_parent arbitration ${verdict.reason}`,
          traceId: context.turn.turnId, parentSpanId: askSpan.id, chatId: context.turn.chatId, data: { askId, agentRunId: run.id, reason: verdict.reason, detail: verdict.detail, escalationRequested: live.agent.askEscalateToUser } });
      }
      // 降级顺序：仲裁 → 子 agent 自带的 default → 明说没人应答。**不伪造答复**（docs/16 §5）。
      if (input.default !== undefined) { answered('rule', input.default); return { ok: true, askId, answer: input.default, source: 'default' }; }
      answered('timeout', null);
      return { ok: false, error: 'ask_parent_unanswered', hint: live.agent.askArbiter ? '仲裁没能给出答复；请在 task 里自带决策依据，或调用时提供 default' : '仲裁已关闭（agent.askArbiter=false）；请在 task 里自带决策依据，或调用时提供 default', askId };
    } });
  registry.register({ name: 'report_progress', description: '报告子 agent 当前进度。', inputSchema: z.object({ status: z.string(), current: z.number().optional(), total: z.number().optional(), detail: z.string().optional() }), policy: builtinPolicy('report_progress'), sourcePriority: 90,
    available: (_role, context) => context.agentKind === 'sub', execute: (input, context) => {
      const run = context.agentRunId ? dependencies.agents.byId(context.agentRunId) : null;
      if (!run) return { ok: false, error: 'agent_run_unavailable' };
      dependencies.agents.progress(run, input);
      // 落一条 debug：`docs/10 §2` 给 `agent.progress` 定的字段就是 phase + done/total。它不受
      // 下面那道 SSE 节流管 —— 节流护的是浏览器连接，日志侧本来就按 `logs.level` 分档。
      dependencies.log.event({ level: 'debug', kind: 'agent.progress', summary: `${run.agentName}: ${input.status}`, traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}), key: context.turn.key,
        data: { agentRunId: run.id, phase: input.status, done: input.current ?? null, total: input.total ?? null } });
      // `agent.progressThrottleMs`：库里那行照常更新（它是当前状态，谁读谁看最新的），但 SSE 只在
      // 节流窗口外广播。一个爱汇报的子 agent 每步喊一次，够把 WebUI 的事件流刷成进度条。
      const throttleMs = (context.turn.config as Readonly<Config>).agent.progressThrottleMs;
      const last = progressBroadcast.get(run.id) ?? 0;
      const now = Date.now();
      if (now - last >= throttleMs) {
        progressBroadcast.set(run.id, now);
        dependencies.log.publish('task.updated', { id: null, runId: run.id, turnId: context.turn.turnId, state: 'running', progress: input });
      }
      return { ok: true };
    } });
  // 措辞必须写明「只有本轮」：这个覆盖不跨轮持久（docs/04 §5.2、AC-AGENT-007），而模型据此对
  // 用户说过「切好啦，现在是 vision 模型」——下一轮（真正带图那一轮）早就回到默认别名了
  // （logs/2026-08-18 22:15）。含图轮次现在会自动切 vision，模型不需要自己动手。
  registry.register({ name: 'set_model', description: '为**当前这一轮剩下的步骤**切换模型别名；本轮结束即失效，不跨轮保留，也不需要用它来看图（含图轮次系统会自动切到 vision）。',
    inputSchema: z.object({ alias: z.enum(['main', 'high', 'low', 'vision']) }), policy: builtinPolicy('set_model'), sourcePriority: 90,
    execute: (input, context) => { Object.assign(context.turn, { modelAliasOverride: input.alias }); return { ok: true, alias: input.alias, scope: 'this_turn_only', note: '本轮结束后自动回到默认别名，不要告诉用户已经永久切换。' }; } });
  registry.register({ name: 'web_search', description: '搜索公开网络；瞬时失败（超时/5xx/429）会自动重试。', inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(10).default(5) }), policy: builtinPolicy('web_search'), sourcePriority: 100, untrustedOutput: true, timeoutMs: webBudgetMs,
    available: () => Boolean(dependencies.webSearch?.provider && dependencies.webSearch.apiKey), execute: (input, context) => webSearch(dependencies.webSearch!.provider as 'brave' | 'serper' | 'tavily' | 'exa', dependencies.webSearch!.apiKey, input.query, input.limit ?? 5, context.turn.abortSignal, web, dependencies.maxWebBytes) });
  registry.register({ name: 'send_message', description: '向当前会话追发一条消息（正文请直接写进回复，这个工具用于分段或中间产物）。', inputSchema: z.object({ text: z.string().min(1) }), policy: builtinPolicy('send_message'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => claimExtraMessage(context) ?? dependencies.telegram!.sendMessage(target(context), input.text) });
  registry.register({ name: 'send_photo', description: '把工作目录内的图片发到当前会话。', inputSchema: z.object({ photo: z.string(), caption: z.string().optional() }), policy: builtinPolicy('send_photo'), sourcePriority: 100, timeoutMs: UPLOAD_TIMEOUT_MS,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const file = resolveOutgoingFile(context, dependencies.filesFor(context.workspace, context.turn.effectiveRole), input.photo);
      if (!file.ok) return file;
      return claimExtraMessage(context) ?? dependencies.telegram!.sendPhoto(target(context), file.absolute, input.caption);
    } });
  registry.register({ name: 'react', description: '给消息加 emoji reaction；不填 messageId 就点触发本轮的那条消息。', inputSchema: z.object({ messageId: z.number().int().positive().optional(), emoji: z.string() }), policy: builtinPolicy('react'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId) return { ok: false, error: 'message_id_required', hint: '本轮没有触发消息，请先用 read_messages 取到 tgMessageId。' };
      return dependencies.telegram!.react(target(context), messageId, input.emoji);
    } });
  registry.register({ name: 'send_file', description: '把工作目录内的文件作为文档发到当前会话。', inputSchema: z.object({ file: z.string(), caption: z.string().optional() }), policy: builtinPolicy('send_file'), sourcePriority: 100, timeoutMs: UPLOAD_TIMEOUT_MS,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const file = resolveOutgoingFile(context, dependencies.filesFor(context.workspace, context.turn.effectiveRole), input.file);
      if (!file.ok) return file;
      return claimExtraMessage(context) ?? dependencies.telegram!.sendFile(target(context), file.absolute, input.caption);
    } });
  registry.register({ name: 'pin_message', description: '置顶当前会话的消息；不填 messageId 就置顶触发本轮的那条。', inputSchema: z.object({ messageId: z.number().int().positive().optional() }), policy: builtinPolicy('pin_message'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId) return { ok: false, error: 'message_id_required', hint: '本轮没有触发消息，请先用 read_messages 取到 tgMessageId。' };
      return dependencies.telegram!.pin(target(context), messageId);
    } });
  registry.register({ name: 'web_fetch', description: '获取公开 HTTP/HTTPS 页面；拒绝私网和元数据地址。瞬时失败（超时/5xx/429）会自动重试。', inputSchema: z.object({ url: z.string().url() }), policy: builtinPolicy('web_fetch'), sourcePriority: 100, untrustedOutput: true,
    // `limited` 只在配了 allowlist 时才有 web_fetch（docs/05 §4）：没有白名单就等于把整个互联网
    // 交给权限最低的那档人，而这个工具的输出会直接进上下文。fail-closed 走 `available()`，
    // 所以工具**根本不进目录**，模型不会去试一个必然被拒的调用。
    available: (role, context) => role !== 'limited' || (context.turn.config as Readonly<Config>).tools.web.allowlist.length > 0,
    // 域名白/黑名单从本轮配置取（`tools.web` 在 perChat 白名单里不在，所以就是全局那份，
    // 但仍然走 turn.config —— 热更新后下一轮生效，不用重启）。
    timeoutMs: webBudgetMs, execute: (input, context) => {
      const live = (context.turn.config as Readonly<Config>).tools.web;
      return webFetch(input.url, dependencies.maxWebBytes, context.turn.abortSignal, web, { allowlist: live.allowlist, denylist: live.denylist });
    } });
}
