import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import type { AgentManager, Config, ContextEngine, FileTools, MemoryStore, ModelRegistry, QuotaGuard, QuotaReservation, Sandbox, SkillLoader, ToolRegistry, UsageLedger, LogSink } from '@luoli/core';
import { builtinPolicy, runSubAgent, webFetch, webSearch } from '@luoli/core';
import type { ArchiveRepository } from '@luoli/db';
import type { ToolExecutionContext } from './registry.js';

/** 一次投递的落点。thread 必须跟着走，否则话题群里的追发会掉到「General」去。 */
export interface TelegramTarget {
  chatId: string;
  threadId: number | null;
  turnId: string;
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

const target = (context: ToolExecutionContext): TelegramTarget =>
  ({ chatId: context.turn.chatId, threadId: context.turn.threadId, turnId: context.turn.turnId });
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

export function registerBuiltins(registry: ToolRegistry, dependencies: { db: import('@luoli/db').Sqlite; filesFor: (workspace: string) => FileTools; sandbox: Sandbox; archive: ArchiveRepository; context: ContextEngine; memory: MemoryStore; skills: SkillLoader; agents: AgentManager; models: ModelRegistry; ledger: UsageLedger; log: LogSink; quota?: QuotaGuard; telegram: TelegramToolBridge | null; maxWebBytes: number; maxAsksPerRun?: number; askTimeoutMs?: number; webSearch?: { provider: '' | 'brave' | 'serper' | 'tavily'; apiKey: string } }): void {
  registry.register({ name: 'read_file', description: '读取工作目录或 skill:// 资源，支持 offset/limit 分页。', inputSchema: z.object({ path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }), policy: builtinPolicy('read_file'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => {
      if (!input.path.startsWith('skill://')) return dependencies.filesFor(context.workspace).read(input.path, input.offset, input.limit);
      const path = dependencies.skills.resolveResource(input.path, context.turn.effectiveRole);
      const buffer = readFileSync(path);
      const offset = input.offset ?? 0;
      const limit = input.limit ?? Math.min(buffer.length, 262_144);
      const content = buffer.subarray(offset, offset + limit).toString('utf8');
      return { ok: true, path: input.path, content, offset, bytes: Buffer.byteLength(content), truncated: offset + limit < buffer.length, nextOffset: offset + limit < buffer.length ? offset + limit : null };
    } });
  registry.register({ name: 'list_dir', description: '列出工作目录。', inputSchema: z.object({ path: z.string().default('.'), depth: z.number().int().min(1).max(5).default(1) }), policy: builtinPolicy('list_dir'), sourcePriority: 100,
    execute: (input, context) => dependencies.filesFor(context.workspace).list(input.path, input.depth) });
  registry.register({ name: 'glob', description: '按 glob 模式查找工作目录文件。', inputSchema: z.object({ pattern: z.string(), path: z.string().default('.') }), policy: builtinPolicy('glob'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => dependencies.filesFor(context.workspace).glob(input.pattern, input.path) });
  registry.register({ name: 'grep', description: '以正则搜索工作目录文本。', inputSchema: z.object({ pattern: z.string(), path: z.string().default('.'), ignoreCase: z.boolean().default(false) }), policy: builtinPolicy('grep'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => dependencies.filesFor(context.workspace).grep(input.pattern, input.path, input.ignoreCase) });
  registry.register({ name: 'write_file', description: '原子写入工作目录文件，覆盖前自动备份。', inputSchema: z.object({ path: z.string(), content: z.string() }), policy: builtinPolicy('write_file'), sourcePriority: 100,
    approvalTargetExists: (input, context) => dependencies.filesFor(context.workspace).exists((input as { path: string }).path),
    execute: (input, context) => dependencies.filesFor(context.workspace).write(input.path, input.content) });
  registry.register({ name: 'edit_file', description: '以唯一 oldString 修改文件。', inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string(), replaceAll: z.boolean().default(false) }), policy: builtinPolicy('edit_file'), sourcePriority: 100,
    execute: (input, context) => dependencies.filesFor(context.workspace).edit(input.path, input.oldString, input.newString, input.replaceAll) });
  registry.register({ name: 'delete_file', description: '将文件移入回收站，不物理删除。', inputSchema: z.object({ path: z.string() }), policy: builtinPolicy('delete_file'), sourcePriority: 100,
    execute: (input, context) => dependencies.filesFor(context.workspace).remove(input.path) });
  registry.register({ name: 'move_file', description: '移动工作目录文件，不覆盖目标。', inputSchema: z.object({ from: z.string(), to: z.string() }), policy: builtinPolicy('move_file'), sourcePriority: 100,
    approvalTargetExists: (input, context) => dependencies.filesFor(context.workspace).exists((input as { to: string }).to),
    execute: (input, context) => dependencies.filesFor(context.workspace).move(input.from, input.to) });
  registry.register({ name: 'bash', description: '在工作目录执行命令；非 owner 必须使用可用沙箱。', inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional(), description: z.string() }), policy: builtinPolicy('bash'), sourcePriority: 100,
    available: (role, context) => dependencies.sandbox.plan(role, context.workspace).allowed,
    execute: async (input, context) => dependencies.sandbox.run(input.command, context.turn.effectiveRole, context.workspace, context.turn.abortSignal, input.timeoutMs, context.turn.turnId) });
  registry.register({ name: 'python', description: '在工作目录执行 Python 代码；非 owner 必须使用可用沙箱。', inputSchema: z.object({ code: z.string(), timeoutMs: z.number().int().positive().optional(), description: z.string() }), policy: builtinPolicy('python'), sourcePriority: 100,
    available: (role, context) => dependencies.sandbox.plan(role, context.workspace).allowed,
    execute: async (input, context) => dependencies.sandbox.run(`python3 - <<'PY'\n${input.code}\nPY`, context.turn.effectiveRole, context.workspace, context.turn.abortSignal, input.timeoutMs, context.turn.turnId) });
  registry.register({ name: 'search_messages', description: '在当前会话内搜索聊天记录。', inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(100).default(20) }), policy: builtinPolicy('search_messages'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => ({ ok: true, messages: dependencies.archive.scope(context.turn.chatId, context.turn.threadId).search(input.query, input.limit) }) });
  registry.register({ name: 'read_messages', description: '按时间读取当前会话聊天记录。', inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }), policy: builtinPolicy('read_messages'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => ({ ok: true, messages: dependencies.archive.scope(context.turn.chatId, context.turn.threadId).recent(input.limit).reverse() }) });
  registry.register({ name: 'get_message', description: '读取当前会话的单条归档消息。', inputSchema: z.object({ messageId: z.number().int().positive() }), policy: builtinPolicy('get_message'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => ({ ok: true, message: dependencies.archive.scope(context.turn.chatId, context.turn.threadId).byId(input.messageId) }) });
  registry.register({ name: 'admin_search_messages', description: '跨会话搜索聊天记录，仅 owner。', inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(100).default(20) }), policy: builtinPolicy('admin_search_messages'), sourcePriority: 100, untrustedOutput: true,
    execute: (input) => ({ ok: true, messages: dependencies.archive.adminSearchAll(input.query, input.limit) }) });
  registry.register({ name: 'context_stats', description: '读取当前上下文窗口和提交状态。', inputSchema: z.object({}), policy: builtinPolicy('context_stats'), sourcePriority: 100,
    execute: (_input, context) => ({ ok: true, ...dependencies.context.stats(context.turn.key) }) });
  const memoryScopeSchema = (isPrivate: boolean) => z.object({ scope: isPrivate ? z.enum(['pubmemory', 'primemory']) : z.enum(['pubmemory']) });
  registry.register({ name: 'memory_read', description: '读取公开记忆或当前用户私有记忆。', inputSchema: memoryScopeSchema(true),
    inputSchemaFor: (context) => memoryScopeSchema(context.turn.isPrivate), policy: builtinPolicy('memory_read'), sourcePriority: 100,
    execute: (input, context) => ({ ok: true, content: dependencies.memory.read(input.scope, input.scope === 'primemory' ? context.turn.initiatorUserId : null, context.turn.effectiveRole, context.turn.initiatorUserId, context.turn.isPrivate).content }) });
  const memoryWriteSchema = (isPrivate: boolean) => z.object({ scope: isPrivate ? z.enum(['pubmemory', 'primemory']) : z.enum(['pubmemory']), section: z.string(), content: z.string().max(2000), reason: z.string() });
  registry.register({ name: 'memory_write', description: '把长期有效事实写入公开或当前用户私有记忆，一轮结束时批量落盘。', inputSchema: memoryWriteSchema(true),
    inputSchemaFor: (context) => memoryWriteSchema(context.turn.isPrivate), policy: builtinPolicy('memory_write'), sourcePriority: 100,
    execute: (input, context) => dependencies.memory.queueWrite({ scope: input.scope, subject: input.scope === 'primemory' ? context.turn.initiatorUserId : null,
      section: input.section, lines: input.content.split('\n').filter(Boolean), actor: 'model', turnId: context.turn.turnId,
      chatId: context.turn.chatId, userId: context.turn.initiatorUserId }, context.turn.effectiveRole, context.turn.isPrivate, (context.turn.config as Readonly<Config>).memory.pubWriteMinRole) });
  registry.register({ name: 'load_skill', description: '渐进式载入 Skill 正文与资源清单。', inputSchema: z.object({ name: z.string() }), policy: builtinPolicy('load_skill'), sourcePriority: 80,
    execute: (input, context) => {
      const loaded = (context.turn.loadedSkills ??= new Set());
      if (loaded.has(input.name)) return { ok: true, alreadyLoaded: true };
      const result = dependencies.skills.load(input.name, context.turn.effectiveRole, registry.activeNames(context.turn.effectiveRole, context));
      if (result.ok !== false) {
        loaded.add(input.name);
        const allowed = Array.isArray(result.allowedTools) ? result.allowedTools.filter((name): name is string => typeof name === 'string') : [];
        const set = (context.turn.skillAllowedTools ??= new Set());
        for (const name of allowed) set.add(name);
        dependencies.context.appendDelta(context.turn, { id: crypto.randomUUID(), role: 'user', origin: 'note', parts: [{ type: 'text', text: String(result.body ?? '') }], textPreview: `Skill ${input.name}`, pruneLevel: 2 });
      }
      return result;
    } });
  registry.register({ name: 'memory_list', description: '列出全部记忆文档，仅 owner。', inputSchema: z.object({}), policy: builtinPolicy('memory_list'), sourcePriority: 100,
    execute: () => ({ ok: true, documents: dependencies.memory.list() }) });
  registry.register({ name: 'list_agents', description: '列出当前权限可派发的子 agent。', inputSchema: z.object({}), policy: builtinPolicy('list_agents'), sourcePriority: 90,
    execute: (_input, context) => ({ ok: true, agents: dependencies.agents.available(context.turn.effectiveRole).map(({ name, description }) => ({ name, description })) }) });
  registry.register({ name: 'spawn_agent', description: '派发独立上下文子 agent；task 必须自包含。', inputSchema: z.object({ agent: z.string(), task: z.string().min(10), context: z.string().optional(), modelAlias: z.string().optional(), label: z.string().optional() }), policy: builtinPolicy('spawn_agent'), sourcePriority: 90,
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
      try {
        // provider 重试设置与配额预留都从本轮取：子 agent 的花费必须落进主 agent 那份预留，
        // 否则配额只看得见主 agent（docs/20 · W-QUOTA-01）。
        const live = context.turn.config as Readonly<Config>;
        const result = await runSubAgent(run, definition, input.task, input.context, context.turn, { db: dependencies.db, agents: dependencies.agents, registry: dependencies.models, tools: registry, ledger: dependencies.ledger, log: dependencies.log, workspace: context.workspace,
          provider: { maxRetries: live.provider.maxRetries, retryBaseMs: live.provider.retryBaseMs, retryMaxMs: live.provider.retryMaxMs },
          ...(dependencies.quota ? { quota: dependencies.quota } : {}), reservation: (context.turn.reservation as QuotaReservation | undefined) ?? null }, input.modelAlias);
        dependencies.db.prepare("UPDATE tasks SET state='done',result_summary=?,updated_at=?,finished_at=? WHERE id=?").run(result.summary, Date.now(), Date.now(), taskId);
        dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'done', progress: null });
        return { ok: true, taskId, runId: run.id, agent: definition.name, ...result };
      } catch (error) {
        dependencies.db.prepare("UPDATE tasks SET state='failed',result_summary=?,updated_at=?,finished_at=? WHERE id=?").run(error instanceof Error ? error.message : String(error), Date.now(), Date.now(), taskId);
        dependencies.log.publish('task.updated', { id: taskId, turnId: context.turn.turnId, title, state: 'failed', progress: null });
        return { ok: false, error: error instanceof Error ? error.message : 'subagent_failed', taskId, runId: run.id };
      }
    } });
  registry.register({ name: 'read_agent_result', description: '分页读取子 agent 完整结果。', inputSchema: z.object({ runId: z.string(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(262_144).default(65_536) }), policy: builtinPolicy('read_agent_result'), sourcePriority: 90,
    execute: (input) => ({ ok: true, ...dependencies.agents.result(input.runId, input.offset, input.limit) }) });
  registry.register({ name: 'ask_parent', description: '向父 agent 提问；仅子 agent 可用。', inputSchema: z.object({ question: z.string(), options: z.array(z.string()).default([]), default: z.string().optional() }), policy: builtinPolicy('ask_parent'), sourcePriority: 90,
    available: (_role, context) => context.agentKind === 'sub', execute: async (input, context) => {
      const run = context.agentRunId ? dependencies.agents.byId(context.agentRunId) : null;
      const parent = run?.parentRunId ? dependencies.agents.byId(run.parentRunId) : null;
      if (!run || !parent) return { ok: false, error: 'parent_agent_unavailable' };
      const count = dependencies.db.prepare("SELECT COUNT(*) FROM agent_messages WHERE from_run_id=? AND kind='ask'").pluck().get(run.id) as number;
      if (count >= (dependencies.maxAsksPerRun ?? 5)) return { ok: false, error: 'agent_ask_limit_exceeded' };
      const askId = dependencies.agents.ask(run, parent, input);
      // 父 agent 仲裁（agent.askArbiter / askEscalateToUser）尚未实现。此前这里拿子 agent 自己的
      // options[0] 当答复并返回 ok:true，等于伪造"请示已获批"（docs/19 · R-TOOL-01）。
      if (input.default !== undefined) { dependencies.agents.answer(askId, input.default, 'rule'); return { ok: true, askId, answer: input.default, source: 'default' }; }
      dependencies.agents.answer(askId, null, 'timeout');
      return { ok: false, error: 'ask_parent_not_implemented', hint: '父 agent 仲裁尚未实现；请在 task 里自带决策依据，或提供 default', askId };
    } });
  registry.register({ name: 'report_progress', description: '报告子 agent 当前进度。', inputSchema: z.object({ status: z.string(), current: z.number().optional(), total: z.number().optional(), detail: z.string().optional() }), policy: builtinPolicy('report_progress'), sourcePriority: 90,
    available: (_role, context) => context.agentKind === 'sub', execute: (input, context) => {
      const run = context.agentRunId ? dependencies.agents.byId(context.agentRunId) : null;
      if (!run) return { ok: false, error: 'agent_run_unavailable' };
      dependencies.agents.progress(run, input);
      dependencies.log.publish('task.updated', { id: null, runId: run.id, turnId: context.turn.turnId, state: 'running', progress: input });
      return { ok: true };
    } });
  registry.register({ name: 'set_model', description: '切换当前轮模型别名。', inputSchema: z.object({ alias: z.enum(['main', 'high', 'low', 'vision']) }), policy: builtinPolicy('set_model'), sourcePriority: 90,
    execute: (input, context) => { Object.assign(context.turn, { modelAliasOverride: input.alias }); return { ok: true, alias: input.alias }; } });
  registry.register({ name: 'web_search', description: '搜索公开网络。', inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(10).default(5) }), policy: builtinPolicy('web_search'), sourcePriority: 100, untrustedOutput: true,
    available: () => Boolean(dependencies.webSearch?.provider && dependencies.webSearch.apiKey), execute: (input, context) => webSearch(dependencies.webSearch!.provider as 'brave' | 'serper' | 'tavily', dependencies.webSearch!.apiKey, input.query, input.limit ?? 5, context.turn.abortSignal) });
  registry.register({ name: 'send_message', description: '向当前会话追发一条消息（正文请直接写进回复，这个工具用于分段或中间产物）。', inputSchema: z.object({ text: z.string().min(1) }), policy: builtinPolicy('send_message'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => claimExtraMessage(context) ?? dependencies.telegram!.sendMessage(target(context), input.text) });
  registry.register({ name: 'send_photo', description: '把工作目录内的图片发到当前会话。', inputSchema: z.object({ photo: z.string(), caption: z.string().optional() }), policy: builtinPolicy('send_photo'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const file = resolveOutgoingFile(context, dependencies.filesFor(context.workspace), input.photo);
      if (!file.ok) return file;
      return claimExtraMessage(context) ?? dependencies.telegram!.sendPhoto(target(context), file.absolute, input.caption);
    } });
  registry.register({ name: 'react', description: '给消息加 emoji reaction；不填 messageId 就点触发本轮的那条消息。', inputSchema: z.object({ messageId: z.number().int().positive().optional(), emoji: z.string() }), policy: builtinPolicy('react'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId) return { ok: false, error: 'message_id_required', hint: '本轮没有触发消息，请先用 read_messages 取到 tgMessageId。' };
      return dependencies.telegram!.react(target(context), messageId, input.emoji);
    } });
  registry.register({ name: 'send_file', description: '把工作目录内的文件作为文档发到当前会话。', inputSchema: z.object({ file: z.string(), caption: z.string().optional() }), policy: builtinPolicy('send_file'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const file = resolveOutgoingFile(context, dependencies.filesFor(context.workspace), input.file);
      if (!file.ok) return file;
      return claimExtraMessage(context) ?? dependencies.telegram!.sendFile(target(context), file.absolute, input.caption);
    } });
  registry.register({ name: 'pin_message', description: '置顶当前会话的消息；不填 messageId 就置顶触发本轮的那条。', inputSchema: z.object({ messageId: z.number().int().positive().optional() }), policy: builtinPolicy('pin_message'), sourcePriority: 100,
    available: () => Boolean(dependencies.telegram), execute: async (input, context) => {
      const messageId = input.messageId ?? context.turn.triggerTgMessageId;
      if (!messageId) return { ok: false, error: 'message_id_required', hint: '本轮没有触发消息，请先用 read_messages 取到 tgMessageId。' };
      return dependencies.telegram!.pin(target(context), messageId);
    } });
  registry.register({ name: 'web_fetch', description: '获取公开 HTTP/HTTPS 页面；拒绝私网和元数据地址。', inputSchema: z.object({ url: z.string().url() }), policy: builtinPolicy('web_fetch'), sourcePriority: 100, untrustedOutput: true,
    execute: (input, context) => webFetch(input.url, dependencies.maxWebBytes, context.turn.abortSignal) });
}
