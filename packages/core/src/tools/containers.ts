import { z } from 'zod';
import type { Sqlite } from '@luoli/db';
import type { Role } from '@luoli/shared';
import type { Sandbox } from '../sandbox/index.js';
import { BACKGROUND_LOG_DIR, sanitizeLogName } from '../sandbox/containers.js';
import type { ToolExecutionContext, ToolRegistry } from './registry.js';
import { builtinPolicy } from './registry.js';

export interface ContainerToolDependencies {
  sandbox: Sandbox;
  db: Sqlite;
}

export interface ChatCandidate {
  chatId: string;
  label: string;
  /** 字段名是 `type` 不是 `kind`，理由同 `ContainerEvent.type`（docs/10 §2 那道双向断言）。 */
  type: 'group' | 'private';
}

interface PrincipalRow { tgId: string; displayName: string | null; username: string | null; chatType: string | null }

/**
 * 会话候选表。没有 `chats` 表，名字在 `principals`：群取 `chat:<id>` 那行的 `display_name`，
 * **私聊要优先取 `user:<id>`** —— `chat:<id>` 对私聊只存了 `first_name`。与 WebUI 的
 * `chatIdentity()`（`ConsoleView.vue`）同一套 join，两处漂开的表现是「界面上叫这个名字，
 * 跟模型说这个名字它找不到」。
 */
export function chatCandidates(db: Sqlite): ChatCandidate[] {
  const chats = db.prepare("SELECT tg_id AS tgId,display_name AS displayName,username,chat_type AS chatType FROM principals WHERE kind='chat'").all() as PrincipalRow[];
  const users = new Map((db.prepare("SELECT tg_id AS tgId,display_name AS displayName,username,chat_type AS chatType FROM principals WHERE kind='user'").all() as PrincipalRow[]).map((row) => [row.tgId, row]));
  return chats.map((chat) => {
    const isPrivate = chat.chatType ? chat.chatType === 'private' : !chat.tgId.startsWith('-');
    const source = (isPrivate ? users.get(chat.tgId) ?? chat : chat);
    const name = source.displayName || `未登记${isPrivate ? '用户' : '群聊'} ${chat.tgId}`;
    return { chatId: chat.tgId, type: isPrivate ? 'private' as const : 'group' as const,
      label: source.username ? `${name} (@${source.username})` : name };
  });
}

export type ChatResolution =
  | { ok: true; chatId: string; label: string }
  | { ok: false; error: 'chat_not_found' | 'ambiguous_chat'; hint: string; candidates: ChatCandidate[] };

/**
 * 把「xxx 群」解析成一个 chatId。
 *
 * **匹配不唯一就拒绝并交回候选，不挑一个。** 一次模糊匹配错了，`container_reset` 重置的就是
 * 另一个群的容器 ——「摘除比伪造安全」（docs/reviews/16 §5）。零命中同样交回现有列表，
 * 而不是空成功。纯函数式接口，`tests/sandbox.persistent.test.ts` 直接打它。
 */
export function resolveChatTarget(candidates: ChatCandidate[], raw: string): ChatResolution {
  const query = raw.trim();
  if (!query) return { ok: false, error: 'chat_not_found', hint: 'chat 不能是空的。', candidates };
  const byId = candidates.find((candidate) => candidate.chatId === query);
  if (byId) return { ok: true, chatId: byId.chatId, label: byId.label };
  // 库里没登记过这个会话，但它长得就是一个 chat id —— 照收。定时任务与刚加进来的群都可能
  // 还没在 principals 里留下名字，而「这个 id 我不认识」不该挡住 owner 用 id 直接点名。
  if (/^-?\d+$/.test(query)) return { ok: true, chatId: query, label: `未登记会话 ${query}` };
  const needle = query.toLowerCase();
  const hits = candidates.filter((candidate) => candidate.label.toLowerCase().includes(needle));
  if (hits.length === 1) return { ok: true, chatId: hits[0]!.chatId, label: hits[0]!.label };
  if (hits.length === 0) {
    return { ok: false, error: 'chat_not_found', candidates,
      hint: `没有名字里含「${query}」的会话。candidates 里是现在认识的全部会话，照着挑一个再来（也可以直接给 chat id）。` };
  }
  return { ok: false, error: 'ambiguous_chat', candidates: hits,
    hint: `「${query}」同时匹配 ${hits.length} 个会话，没有动任何容器。从 candidates 里挑一个更准的名字或直接给 chat id。` };
}

const remainingText = (expiresAt: number, now: number): string => {
  const ms = expiresAt - now;
  if (ms <= 0) return '已到期（下一次回收会收走）';
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `约 ${hours} 小时` : `约 ${Math.max(1, Math.round(ms / 60_000))} 分钟`;
};

/**
 * 六个 owner 工具（docs/05 §3.11）。
 *
 * **`owner` 这道地板同时写在每个工具的 `available()` 里**，不只写在 `TOOL_POLICY` 上 ——
 * 运维能把 `minRole` 覆盖成 `trusted`（`effectivePolicy()` 认那条覆盖），而覆盖绕不过
 * `available()`。少了这一道，一次放宽就等于让任意受信会话里的成员往别的群的容器里执行命令。
 * 形状照 `spawn_harness` 与 `authoring.ts` 的 `gate()`。
 */
export function registerContainerTools(registry: ToolRegistry, dependencies: ContainerToolDependencies): void {
  const manager = (): ReturnType<Sandbox['containers']> => dependencies.sandbox.containers();
  /** 两道门的第一道：非 owner、或持久化没开时，这一族整体不进模型的工具目录。 */
  const gate = (role: Role): boolean => role === 'owner' && manager()?.enabled() === true;
  /** 第二道：模型可能沿用上一步的工具名，禁用必须是硬边界（CLAUDE.md / docs/05 §4 末）。 */
  const guard = (context: ToolExecutionContext): { ok: false; error: string; hint: string } | null => {
    if (context.turn.effectiveRole !== 'owner') return { ok: false, error: 'container_forbidden', hint: '容器管理只有 owner 能用。' };
    if (!manager()?.enabled()) return { ok: false, error: 'persistent_containers_disabled', hint: '持久容器没开（sandbox.persistent.enabled）。现在每次执行都是一次性容器，没有可管理的对象。' };
    return null;
  };
  /** `chat` 参数 → chatId + 宿主侧工作目录。解析失败的两种都原样交回，不猜。 */
  const target = (raw: string): { ok: true; chatId: string; label: string; workspace: string } | { ok: false; error: string; hint: string; candidates?: ChatCandidate[] } => {
    const resolved = resolveChatTarget(chatCandidates(dependencies.db), raw);
    if (!resolved.ok) return { ok: false, error: resolved.error, hint: resolved.hint, candidates: resolved.candidates };
    const workspace = dependencies.sandbox.hostWorkspaceFor(resolved.chatId);
    if (workspace === null) return { ok: false, error: 'workspace_unmappable', hint: '这个会话的工作目录换算不到宿主路径（sandbox.hostWorkspaceDir 没配或越界），建不了容器。' };
    return { ok: true, chatId: resolved.chatId, label: resolved.label, workspace };
  };
  const chatArg = z.string().min(1).describe('目标会话：群名 / 私聊对方的名字（模糊匹配，不唯一会交回候选并拒绝），或直接给 chat id');

  registry.register({
    name: 'container_list',
    description: '列出所有会话的持久沙箱容器：哪个会话、状态、建了多久、上次用是什么时候、还剩多久被回收、有没有被钉住。想知道某一个容器里在跑什么用 container_inspect。',
    inputSchema: z.object({}), policy: builtinPolicy('container_list'), sourcePriority: 100, untrustedOutput: true,
    available: (role) => gate(role),
    execute: (_input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const boxes = manager()!;
      const labels = new Map(chatCandidates(dependencies.db).map((candidate) => [candidate.chatId, candidate.label]));
      const now = Date.now();
      const { used, max } = boxes.capacity();
      return { ok: true, used, max, containers: boxes.list().map((row) => ({
        chat: labels.get(row.chatId) ?? `未登记会话 ${row.chatId}`, chatId: row.chatId, name: row.name, image: row.image,
        createdAt: new Date(row.createdAt).toISOString(), lastUsedAt: new Date(row.lastUsedAt).toISOString(), execCount: row.execCount,
        expiresIn: row.pinned ? '已钉住（闲置不回收）' : remainingText(row.expiresAt, now),
        hardExpiresIn: row.hardExpiresAt === null ? null : remainingText(row.hardExpiresAt, now),
        pinned: row.pinned !== 0, ...(row.lastError ? { lastError: row.lastError } : {}) })) };
    },
  });

  registry.register({
    name: 'container_exec',
    description: '在指定会话的持久容器里执行一条命令。那个会话还没有容器就会建一个。background=true 时命令转入后台并立刻返回，输出写进 .luoli-logs/<name>.log（用 container_logs 回读）—— 起常驻服务必须用这一档，否则命令一结束进程就会因为管道关闭被打死。',
    inputSchema: z.object({
      chat: chatArg,
      command: z.string().min(1).describe('要执行的 shell 命令，工作目录是那个会话的 /workspace'),
      timeoutMs: z.number().int().positive().optional().describe('前台执行的超时；后台档忽略它'),
      background: z.boolean().default(false).describe('转入后台并立刻返回'),
      name: z.string().min(1).max(64).optional().describe('后台任务名，决定日志文件名；不给就叫 task'),
    }),
    policy: builtinPolicy('container_exec'), sourcePriority: 100, untrustedOutput: true,
    // `bash` 同款：自己管期限，套上注册表那道兜底 race 会在命令跑到一半时判 tool_timeout。
    timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const exec = await manager()!.exec({ chatId: found.chatId, mountedWorkspace: found.workspace, command: input.command,
        timeoutMs: input.timeoutMs ?? 60_000, abortSignal: context.turn.abortSignal,
        ...(input.background ? { background: { name: input.name ?? 'task' } } : {}) });
      if ('error' in exec) return exec;
      return { ...exec, chat: found.label,
        ...(input.background ? { log: `${BACKGROUND_LOG_DIR}/${sanitizeLogName(input.name ?? 'task')}.log`,
          note: `${exec.note ? `${exec.note} ` : ''}已转入后台；stdout 里是它的 pid。输出看 container_logs。` } : {}) };
    },
  });

  registry.register({
    name: 'container_reset',
    description: '销毁并重建指定会话的容器。容器里装的东西和跑着的进程都会没，但 /workspace 里的文件默认一个都不动 —— 要连文件一起清必须显式传 wipeWorkspace。',
    inputSchema: z.object({
      chat: chatArg,
      wipeWorkspace: z.boolean().default(false).describe('连 /workspace 里的文件一起清（挪进 .luoli-trash，不真删）。默认 false'),
    }),
    policy: builtinPolicy('container_reset'), sourcePriority: 100, timeoutMs: null,
    available: (role) => gate(role),
    // 「换环境」和「删数据」是两件事，后者要人点头。抬高不放低，照 memory_write 的自抬审批。
    approvalFor: (input) => (input.wipeWorkspace ? 'always' : null),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const boxes = manager()!;
      if (input.wipeWorkspace) {
        // 先把文件挪走再重建：挪的动作要在容器里做（宿主上那条路径在容器化部署里根本不存在），
        // 所以借当前容器跑一次。`.luoli-trash` 与 delete_file 是同一个回收站。
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const wipe = await boxes.exec({ chatId: found.chatId, mountedWorkspace: found.workspace, timeoutMs: 60_000, abortSignal: context.turn.abortSignal,
          command: `set -e; mkdir -p .luoli-trash/${stamp}; for entry in * .[!.]*; do [ -e "$entry" ] || continue; case "$entry" in .luoli-trash) continue;; esac; mv -- "$entry" .luoli-trash/${stamp}/; done; echo moved` });
        if ('error' in wipe) return wipe;
        if (!wipe.ok) return { ok: false, error: 'workspace_wipe_failed', hint: `文件没能挪进回收站，容器也没动：${wipe.stderr.slice(0, 400)}` };
      }
      const reset = await boxes.reset(found.chatId, found.workspace);
      if (!reset.ok) return reset;
      return { ok: true, chat: found.label, name: reset.row.name, image: reset.row.image, wipedWorkspace: input.wipeWorkspace,
        note: input.wipeWorkspace ? '容器已重建，工作区里的文件已挪进 .luoli-trash。' : '容器已重建；工作区里的文件一个都没动。' };
    },
  });

  registry.register({
    name: 'container_inspect',
    description: '看某个会话的容器里在跑什么、吃多少资源、有哪些后台日志。',
    inputSchema: z.object({ chat: chatArg }), policy: builtinPolicy('container_inspect'), sourcePriority: 100, untrustedOutput: true, timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const detail = await manager()!.inspect(found.chatId);
      if (!detail.ok) return detail;
      const now = Date.now();
      return { ok: true, chat: found.label, name: detail.row.name, image: detail.row.image, execCount: detail.row.execCount,
        pinned: detail.row.pinned !== 0, expiresIn: detail.row.pinned ? '已钉住（闲置不回收）' : remainingText(detail.row.expiresAt, now),
        processes: detail.processes, stats: detail.stats, logs: detail.logs };
    },
  });

  registry.register({
    name: 'container_keep',
    description: '给某个会话的容器续期或钉住（钉住 = 闲置多久都不回收，跑长任务时用）。钉住豁免不了容器的最长存活时间那一档。',
    inputSchema: z.object({
      chat: chatArg,
      hours: z.number().positive().max(720).optional().describe('从现在起还留多久；不给就不改到期时间'),
      pin: z.boolean().optional().describe('true = 钉住不回收，false = 取消钉住'),
    }),
    policy: builtinPolicy('container_keep'), sourcePriority: 100,
    available: (role) => gate(role),
    execute: (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const kept = manager()!.keep(found.chatId, { ...(input.hours === undefined ? {} : { hours: input.hours }), ...(input.pin === undefined ? {} : { pin: input.pin }) });
      if (!kept.ok) return kept;
      const now = Date.now();
      // 续期被绝对上限钳过时要说出来，否则「我明明续了 30 天」和实际到期时间对不上。
      const clamped = input.hours !== undefined && kept.row.hardExpiresAt !== null && kept.row.expiresAt === kept.row.hardExpiresAt;
      return { ok: true, chat: found.label, pinned: kept.row.pinned !== 0, expiresIn: remainingText(kept.row.expiresAt, now),
        hardExpiresIn: kept.row.hardExpiresAt === null ? null : remainingText(kept.row.hardExpiresAt, now),
        ...(clamped ? { note: '续到了容器的最长存活时间就停了（sandbox.persistent.maxLifetimeMs），再往后续不动。' } : {}) };
    },
  });

  registry.register({
    name: 'container_logs',
    description: '回读某个会话容器里后台任务的输出（container_exec 的 background 档写进 .luoli-logs/ 的那些）。不给 name 就列出有哪些日志。',
    inputSchema: z.object({
      chat: chatArg,
      name: z.string().min(1).max(64).optional().describe('后台任务名；不给就只列清单'),
      lines: z.number().int().positive().max(1000).default(100).describe('从末尾取多少行'),
    }),
    policy: builtinPolicy('container_logs'), sourcePriority: 100, untrustedOutput: true, timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const file = input.name === undefined ? null : `${BACKGROUND_LOG_DIR}/${sanitizeLogName(input.name)}.log`;
      const command = file === null
        ? `ls -la ${BACKGROUND_LOG_DIR} 2>/dev/null || echo '(这个容器还没有后台日志)'`
        : `tail -n ${input.lines} ${file} 2>/dev/null || echo "(没有 ${file}，用不带 name 的调用看有哪些)"`;
      const read = await manager()!.exec({ chatId: found.chatId, mountedWorkspace: found.workspace, command, timeoutMs: 20_000, abortSignal: context.turn.abortSignal });
      if ('error' in read) return read;
      return { ok: read.ok, chat: found.label, ...(file ? { log: file } : {}), output: read.stdout || read.stderr };
    },
  });
}
