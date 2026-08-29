import { z } from "zod";
import type { Sqlite } from "@luoli/db";
import type { Role } from "@luoli/shared";
import type { Sandbox } from "../sandbox/index.js";
import { BACKGROUND_LOG_DIR, sanitizeLogName } from "../sandbox/containers.js";
import type { ToolExecutionContext, ToolRegistry } from "./registry.js";
import { builtinPolicy } from "./registry.js";

export interface ContainerToolDependencies {
  sandbox: Sandbox;
  db: Sqlite;
}

export interface ChatCandidate {
  chatId: string;
  label: string;
  /** 字段名是 `type` 而非 `kind`，理由同 `ContainerEvent.type`（docs/10 §2 的双向断言）。 */
  type: "group" | "private";
}

interface PrincipalRow {
  tgId: string;
  displayName: string | null;
  username: string | null;
  chatType: string | null;
}

/**
 * 会话候选表。系统没有 `chats` 表，两类会话的来源因此各不相同：
 *
 * - 群 / 频道取 `principals` 里 `chat:<id>` 行的 `display_name`（Telegram 群 / 频道 id 恒负，
 *   `LIKE '-%'` 顺带挡掉迁移 0015 之前遗留的私聊行）
 * - **私聊改从 `contexts` 枚举**：私聊已不占 `chat:` 行（docs/05 §2.2），聊过哪些私聊的权威
 *   来源只剩上下文表；名字仍回 `user:<id>` 行上取（`chat:<id>` 对私聊本来也只存 `first_name`）
 *
 * 与 WebUI 的 `chatIdentity()`（`ConsoleView.vue`）共用同一套 join，两处漂移的表现是界面显示的
 * 名称传给模型后无法匹配。
 */
export function chatCandidates(db: Sqlite): ChatCandidate[] {
  const groups = db
    .prepare(
      "SELECT tg_id AS tgId,display_name AS displayName,username,chat_type AS chatType FROM principals WHERE kind='chat' AND tg_id LIKE '-%'",
    )
    .all() as PrincipalRow[];
  // 同一个 chat_id 在 thread scope 下会有多行，DISTINCT 是必须的。
  const privates = db
    .prepare(
      "SELECT DISTINCT chat_id AS tgId FROM contexts WHERE chat_id NOT LIKE '-%'",
    )
    .all() as Array<{ tgId: string }>;
  const users = new Map(
    (
      db
        .prepare(
          "SELECT tg_id AS tgId,display_name AS displayName,username,chat_type AS chatType FROM principals WHERE kind='user'",
        )
        .all() as PrincipalRow[]
    ).map((row) => [row.tgId, row]),
  );
  const label = (source: PrincipalRow | undefined, fallback: string): string =>
    source?.username
      ? `${source.displayName || fallback} (@${source.username})`
      : source?.displayName || fallback;
  return [
    ...groups.map((chat) => ({
      chatId: chat.tgId,
      type: "group" as const,
      label: label(chat, `未登记群聊 ${chat.tgId}`),
    })),
    ...privates.map((chat) => ({
      chatId: chat.tgId,
      type: "private" as const,
      label: label(users.get(chat.tgId), `未登记用户 ${chat.tgId}`),
    })),
  ];
}

export type ChatResolution =
  | { ok: true; chatId: string; label: string }
  | {
      ok: false;
      error: "chat_not_found" | "ambiguous_chat";
      hint: string;
      candidates: ChatCandidate[];
    };

/**
 * 把群名解析成一个 chatId。
 *
 * 匹配不唯一时拒绝并返回候选，不自行选择。一次模糊匹配出错，`container_reset` 重置的就是
 * 另一个群的容器（摘除比伪造安全，docs/reviews/16 §5）。零命中同样返回现有列表，
 * 而不是空成功。纯函数式接口，`tests/sandbox.persistent.test.ts` 直接调用它。
 */
export function resolveChatTarget(
  candidates: ChatCandidate[],
  raw: string,
): ChatResolution {
  const query = raw.trim();
  if (!query)
    return {
      ok: false,
      error: "chat_not_found",
      hint: "chat 不能为空。",
      candidates,
    };
  const byId = candidates.find((candidate) => candidate.chatId === query);
  if (byId) return { ok: true, chatId: byId.chatId, label: byId.label };
  // 数据库未登记该会话，但其形态就是一个 chat id，予以接受。定时任务与新加入的群都可能
  // 尚未在 principals 留下名称，而未识别该 id 不应阻止 owner 用 id 直接指定。
  if (/^-?\d+$/.test(query))
    return { ok: true, chatId: query, label: `未登记会话 ${query}` };
  const needle = query.toLowerCase();
  const hits = candidates.filter((candidate) =>
    candidate.label.toLowerCase().includes(needle),
  );
  if (hits.length === 1)
    return { ok: true, chatId: hits[0]!.chatId, label: hits[0]!.label };
  if (hits.length === 0) {
    return {
      ok: false,
      error: "chat_not_found",
      candidates,
      hint: `没有名称含「${query}」的会话。candidates 中是当前已知的全部会话，从中选择其一后重试（或直接给出 chat id）。`,
    };
  }
  return {
    ok: false,
    error: "ambiguous_chat",
    candidates: hits,
    hint: `「${query}」同时匹配 ${hits.length} 个会话，未对任何容器执行操作。从 candidates 中选择更精确的名称或直接给出 chat id。`,
  };
}

const remainingText = (expiresAt: number, now: number): string => {
  const ms = expiresAt - now;
  if (ms <= 0) return "已到期（将在下一次回收时移除）";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1
    ? `约 ${hours} 小时`
    : `约 ${Math.max(1, Math.round(ms / 60_000))} 分钟`;
};

/**
 * 六个 owner 工具（docs/05 §3.11）。
 *
 * `owner` 这道下限同时写在每个工具的 `available()` 中，而不只写在 `TOOL_POLICY` 上：
 * 运维可把 `minRole` 覆盖成 `trusted`（`effectivePolicy()` 承认该覆盖），而覆盖绕不过
 * `available()`。缺少这一道，一次放宽即等于允许任意受信会话的成员向其他群的容器执行命令。
 * 形式参照 `spawn_harness` 与 `authoring.ts` 的 `gate()`。
 */
export function registerContainerTools(
  registry: ToolRegistry,
  dependencies: ContainerToolDependencies,
): void {
  const manager = (): ReturnType<Sandbox["containers"]> =>
    dependencies.sandbox.containers();
  /** 两道门的第一道：非 owner 或持久化未开启时，这一族整体不进入模型的工具目录。 */
  const gate = (role: Role): boolean =>
    role === "owner" && manager()?.enabled() === true;
  /** 第二道：模型可能沿用上一步的工具名，禁用必须是硬边界（CLAUDE.md / docs/05 §4 末）。 */
  const guard = (
    context: ToolExecutionContext,
  ): { ok: false; error: string; hint: string } | null => {
    if (context.turn.effectiveRole !== "owner")
      return {
        ok: false,
        error: "container_forbidden",
        hint: "容器管理仅 owner 可用。",
      };
    if (!manager()?.enabled())
      return {
        ok: false,
        error: "persistent_containers_disabled",
        hint: "持久容器未启用（sandbox.persistent.enabled）。当前每次执行均为一次性容器，无可管理的对象。",
      };
    return null;
  };
  /** `chat` 参数 → chatId 与宿主侧工作目录。两种解析失败均原样返回，不做推测。 */
  const target = (
    raw: string,
  ):
    | { ok: true; chatId: string; label: string; workspace: string }
    | {
        ok: false;
        error: string;
        hint: string;
        candidates?: ChatCandidate[];
      } => {
    const resolved = resolveChatTarget(chatCandidates(dependencies.db), raw);
    if (!resolved.ok)
      return {
        ok: false,
        error: resolved.error,
        hint: resolved.hint,
        candidates: resolved.candidates,
      };
    const workspace = dependencies.sandbox.hostWorkspaceFor(resolved.chatId);
    if (workspace === null)
      return {
        ok: false,
        error: "workspace_unmappable",
        hint: "该会话的工作目录无法映射到宿主路径（sandbox.hostWorkspaceDir 未配置或越界），无法创建容器。",
      };
    return {
      ok: true,
      chatId: resolved.chatId,
      label: resolved.label,
      workspace,
    };
  };
  const chatArg = z
    .string()
    .min(1)
    .describe(
      "目标会话：群名 / 私聊对方的名称（模糊匹配，匹配不唯一时交回候选并拒绝），或直接给出 chat id",
    );

  registry.register({
    name: "container_list",
    description:
      "列出所有会话的持久沙箱容器：所属会话、状态、已创建时长、最近使用时间、距回收的剩余时间、是否已钉住。使用 container_inspect 查看单个容器内运行的内容。",
    inputSchema: z.object({}),
    policy: builtinPolicy("container_list"),
    sourcePriority: 100,
    untrustedOutput: true,
    available: (role) => gate(role),
    execute: (_input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const boxes = manager()!;
      const labels = new Map(
        chatCandidates(dependencies.db).map((candidate) => [
          candidate.chatId,
          candidate.label,
        ]),
      );
      const now = Date.now();
      const { used, max } = boxes.capacity();
      return {
        ok: true,
        used,
        max,
        containers: boxes.list().map((row) => ({
          chat: labels.get(row.chatId) ?? `未登记会话 ${row.chatId}`,
          chatId: row.chatId,
          name: row.name,
          image: row.image,
          createdAt: new Date(row.createdAt).toISOString(),
          lastUsedAt: new Date(row.lastUsedAt).toISOString(),
          execCount: row.execCount,
          expiresIn: row.pinned
            ? "已钉住（闲置不回收）"
            : remainingText(row.expiresAt, now),
          hardExpiresIn:
            row.hardExpiresAt === null
              ? null
              : remainingText(row.hardExpiresAt, now),
          pinned: row.pinned !== 0,
          ...(row.lastError ? { lastError: row.lastError } : {}),
        })),
      };
    },
  });

  registry.register({
    name: "container_exec",
    description:
      "在指定会话的持久容器内执行一条命令。该会话尚无容器时自动创建。background=true 时命令转入后台并立即返回，输出写入 .luoli-logs/<name>.log（使用 container_logs 回读）—— 启动常驻服务必须使用该档，否则命令结束后进程会因管道关闭而被终止。",
    inputSchema: z.object({
      chat: chatArg,
      command: z
        .string()
        .min(1)
        .describe("待执行的 shell 命令，工作目录为该会话的 /workspace"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("前台执行的超时；后台档忽略该参数"),
      background: z.boolean().default(false).describe("转入后台并立即返回"),
      name: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("后台任务名，决定日志文件名；未提供时取 task"),
    }),
    policy: builtinPolicy("container_exec"),
    sourcePriority: 100,
    untrustedOutput: true,
    // 与 `bash` 相同：自行管理期限，叠加注册表那道兜底会产生竞态，在命令执行中途判为 tool_timeout。
    timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const exec = await manager()!.exec({
        chatId: found.chatId,
        mountedWorkspace: found.workspace,
        command: input.command,
        timeoutMs: input.timeoutMs ?? 60_000,
        abortSignal: context.turn.abortSignal,
        ...(input.background
          ? { background: { name: input.name ?? "task" } }
          : {}),
      });
      if ("error" in exec) return exec;
      return {
        ...exec,
        chat: found.label,
        ...(input.background
          ? {
              log: `${BACKGROUND_LOG_DIR}/${sanitizeLogName(input.name ?? "task")}.log`,
              note: `${exec.note ? `${exec.note} ` : ""}已转入后台；stdout 为该进程的 pid。使用 container_logs 查看输出。`,
            }
          : {}),
      };
    },
  });

  registry.register({
    name: "container_reset",
    description:
      "销毁并重建指定会话的容器。容器内已安装的包与运行中的进程全部丢失，但 /workspace 中的文件默认不做任何改动 —— 要一并清除文件必须显式传入 wipeWorkspace。",
    inputSchema: z.object({
      chat: chatArg,
      wipeWorkspace: z
        .boolean()
        .default(false)
        .describe(
          "一并清除 /workspace 中的文件（移入 .luoli-trash，非实际删除）。默认 false",
        ),
    }),
    policy: builtinPolicy("container_reset"),
    sourcePriority: 100,
    timeoutMs: null,
    available: (role) => gate(role),
    // 更换环境与删除数据是两件事，后者需人工确认。只抬高不降低，参照 memory_write 的自抬审批。
    approvalFor: (input) => (input.wipeWorkspace ? "always" : null),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const boxes = manager()!;
      if (input.wipeWorkspace) {
        // 先移走文件再重建：移动动作必须在容器内执行（容器化部署下宿主上不存在该路径），
        // 因此借当前容器执行一次。`.luoli-trash` 与 delete_file 共用同一个回收站。
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const wipe = await boxes.exec({
          chatId: found.chatId,
          mountedWorkspace: found.workspace,
          timeoutMs: 60_000,
          abortSignal: context.turn.abortSignal,
          command: `set -e; mkdir -p .luoli-trash/${stamp}; for entry in * .[!.]*; do [ -e "$entry" ] || continue; case "$entry" in .luoli-trash) continue;; esac; mv -- "$entry" .luoli-trash/${stamp}/; done; echo moved`,
        });
        if ("error" in wipe) return wipe;
        if (!wipe.ok)
          return {
            ok: false,
            error: "workspace_wipe_failed",
            hint: `文件未能移入回收站，容器未做改动：${wipe.stderr.slice(0, 400)}`,
          };
      }
      const reset = await boxes.reset(found.chatId, found.workspace);
      if (!reset.ok) return reset;
      return {
        ok: true,
        chat: found.label,
        name: reset.row.name,
        image: reset.row.image,
        wipedWorkspace: input.wipeWorkspace,
        note: input.wipeWorkspace
          ? "容器已重建，工作区中的文件已移入 .luoli-trash。"
          : "容器已重建；工作区中的文件未做任何改动。",
      };
    },
  });

  registry.register({
    name: "container_inspect",
    description: "查看指定会话的容器内运行的进程、资源占用与后台日志清单。",
    inputSchema: z.object({ chat: chatArg }),
    policy: builtinPolicy("container_inspect"),
    sourcePriority: 100,
    untrustedOutput: true,
    timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const detail = await manager()!.inspect(found.chatId);
      if (!detail.ok) return detail;
      const now = Date.now();
      return {
        ok: true,
        chat: found.label,
        name: detail.row.name,
        image: detail.row.image,
        execCount: detail.row.execCount,
        pinned: detail.row.pinned !== 0,
        expiresIn: detail.row.pinned
          ? "已钉住（闲置不回收）"
          : remainingText(detail.row.expiresAt, now),
        processes: detail.processes,
        stats: detail.stats,
        logs: detail.logs,
      };
    },
  });

  registry.register({
    name: "container_keep",
    description:
      "为指定会话的容器续期或钉住（钉住 = 无论闲置多久都不回收，用于长时间任务）。钉住不能豁免容器的最长存活时间。",
    inputSchema: z.object({
      chat: chatArg,
      hours: z
        .number()
        .positive()
        .max(720)
        .optional()
        .describe("自当前时间起的保留时长；未提供时不修改到期时间"),
      pin: z
        .boolean()
        .optional()
        .describe("true = 钉住不回收，false = 取消钉住"),
    }),
    policy: builtinPolicy("container_keep"),
    sourcePriority: 100,
    available: (role) => gate(role),
    execute: (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const kept = manager()!.keep(found.chatId, {
        ...(input.hours === undefined ? {} : { hours: input.hours }),
        ...(input.pin === undefined ? {} : { pin: input.pin }),
      });
      if (!kept.ok) return kept;
      const now = Date.now();
      // 续期被绝对上限截断时必须明示，否则用户认知的续期天数与实际到期时间不一致。
      const clamped =
        input.hours !== undefined &&
        kept.row.hardExpiresAt !== null &&
        kept.row.expiresAt === kept.row.hardExpiresAt;
      return {
        ok: true,
        chat: found.label,
        pinned: kept.row.pinned !== 0,
        expiresIn: remainingText(kept.row.expiresAt, now),
        hardExpiresIn:
          kept.row.hardExpiresAt === null
            ? null
            : remainingText(kept.row.hardExpiresAt, now),
        ...(clamped
          ? {
              note: "续期已达容器的最长存活时间（sandbox.persistent.maxLifetimeMs），无法继续延长。",
            }
          : {}),
      };
    },
  });

  registry.register({
    name: "container_logs",
    description:
      "回读指定会话容器内后台任务的输出（container_exec 的 background 档写入 .luoli-logs/ 的日志）。未提供 name 时列出可用的日志文件。",
    inputSchema: z.object({
      chat: chatArg,
      name: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("后台任务名；未提供时仅列出清单"),
      lines: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(100)
        .describe("从末尾读取的行数"),
    }),
    policy: builtinPolicy("container_logs"),
    sourcePriority: 100,
    untrustedOutput: true,
    timeoutMs: null,
    available: (role) => gate(role),
    execute: async (input, context) => {
      const denied = guard(context);
      if (denied) return denied;
      const found = target(input.chat);
      if (!found.ok) return found;
      const file =
        input.name === undefined
          ? null
          : `${BACKGROUND_LOG_DIR}/${sanitizeLogName(input.name)}.log`;
      const command =
        file === null
          ? `ls -la ${BACKGROUND_LOG_DIR} 2>/dev/null || echo '(该容器尚无后台日志)'`
          : `tail -n ${input.lines} ${file} 2>/dev/null || echo "(没有 ${file}，使用不带 name 的调用查看可用日志)"`;
      const read = await manager()!.exec({
        chatId: found.chatId,
        mountedWorkspace: found.workspace,
        command,
        timeoutMs: 20_000,
        abortSignal: context.turn.abortSignal,
      });
      if ("error" in read) return read;
      return {
        ok: read.ok,
        chat: found.label,
        ...(file ? { log: file } : {}),
        output: read.stdout || read.stderr,
      };
    },
  });
}
