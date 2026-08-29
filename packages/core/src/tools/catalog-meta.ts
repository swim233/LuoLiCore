import { minimatch } from "minimatch";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import type { LogSink } from "../log/sink.js";
import { SKILL_NARROWING_EXEMPT, type ToolName } from "./policy.js";
import {
  builtinPolicy,
  type RegisteredTool,
  type ToolRegistry,
} from "./registry.js";

/** 一次检索最多返回几个。上限 20 固定在 schema 里：一次展开二十个已经失去按需展开的意义。 */
const DEFAULT_LIMIT = 8;
/**
 * 描述在结果里截到这个长度。tool result 会永久留在上下文里（`docs/02`：`context_messages`
 * 只追加），把一份 4KB 的 MCP 描述抄进来等于让这段会话每轮都为它付一次 token；而完整 schema
 * 下一步由 provider 的 tools 数组权威送达，这里只需让模型辨认出是否为目标工具。
 */
const MAX_DESCRIPTION_CHARS = 240;
/** minimatch 的元字符。不含它们的 `query` 按子串搜索，含则按 glob 匹配名字。 */
const GLOB_CHARS = /[*?[]/;

/**
 * 与 `custom.ts` 里那份同一做法（控制字符能在目录里伪造分隔行、多行描述会撑开摘要），
 * 只是上限不同：那份约束模型自撰写工具的注册名片（200），这份约束检索结果（240）。
 * 未复用是因为那份是模块私有的常量绑定，导出它会让两个上限从此耦合。
 */
function normalizeDescription(value: string): string {
  return value
    .replaceAll(/[\u0000-\u001F\u007F]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

const searchSchema = z
  .object({
    query: z.string().optional(),
    names: z.array(z.string()).optional(),
    group: z.string().optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .refine(
    (value) =>
      Boolean(value.query) ||
      Boolean(value.names?.length) ||
      Boolean(value.group),
    {
      message:
        "query / names / group 至少提供一个：三者均为空等同于返回整份工具目录",
    },
  );

/**
 * `search_tools`：折叠目录的检索与展开入口（`docs/07 §5`）。
 *
 * 与 `builtins.ts` 分文件只为便于并行改动，装配位置在 `main.ts` 的 `register*Tools` 序列中；
 * 它进了 `TOOL_POLICY`，因此必须无条件注册（启动断言只检查是否注册），开关全部落在
 * `available()` 里，与自我扩展八工具、`stay_silent`、容器族同形。
 */
export function registerCatalogTools(
  registry: ToolRegistry,
  dependencies: { log: LogSink },
): void {
  registry.register({
    name: "search_tools",
    description:
      "按关键词、名称或分组检索本轮的折叠工具并展开它们：已展开的工具从下一步起可以直接调用。" +
      "目录中的「折叠工具」摘要行是其入口 —— 摘要只含名称，需要使用某个工具时先在此检索，不可根据名称推测参数。" +
      "尽量一次检索出需要使用的全部工具；跨轮重新使用某个工具时，直接用 names 精确指定。",
    inputSchema: searchSchema,
    policy: builtinPolicy("search_tools"),
    sourcePriority: 80,
    /**
     * 两道闸。`agentKind === 'main'`：子 agent 拿到的是父轮同一个 turn 对象
     * （`agent/subagent.ts` 的 `runSubAgent` 直接接收 `turn`，`stay_silent` 为此写过同样的闸），
     * 允许子 agent 调用会往父轮的 `expandedTools` 写入，而子 agent 那条路没有 per-step 重算：
     * 展开对它自身无效，只会向父轮泄漏状态。子 agent 的 `definition.tools` 白名单本就是比
     * 折叠更强的约束（`docs/07 §4.1`）。
     *
     * `hasDeferrable`：折叠集为空时整个工具不进目录，纯内建部署（mcp 未开、无 plugin/custom）
     * 的提示词逐字节不变。无需另判 `deferExternal`，`#deferredFor` 已将其计入；
     * 运维在工具页关闭本工具时，`activeView` 的折叠摘要也就无人能展开，该档由
     * 提示层回退整目录常驻兜住（`docs/07 §5`），不在这里重复判断。
     */
    available: (role, context) =>
      context.agentKind === "main" && registry.hasDeferrable(role),
    execute: (input, context) => {
      // 检索域从 `activeView()` 派生，因而角色、`available()`、运维禁用、`maxRegistered` 截断
      // 已全部过滤：limited 用户在这里枚举不到 owner 工具的描述，摘要里也不会出现
      // 开轮冻结的 toolSet 中不存在的名字。
      const view = registry.activeView(context.turn.effectiveRole, context);
      const deferred = new Set(view.deferred.map((tool) => tool.name));
      const grouped = input.group
        ? new Set(
            view.groups.find((group) => group.key === input.group)?.names ?? [],
          )
        : null;
      const needle = input.query?.toLowerCase() ?? "";
      const glob =
        input.query && GLOB_CHARS.test(input.query) ? input.query : null;
      // 三个通道取并集：每个通道都是一种检索方式，同时给出两个不应让结果变少。
      const hit = (tool: RegisteredTool): boolean =>
        input.names?.includes(tool.name) === true ||
        grouped?.has(tool.name) === true ||
        (glob
          ? minimatch(tool.name, glob)
          : Boolean(needle) &&
            `${tool.name}\n${tool.description}`.toLowerCase().includes(needle));
      const matched = [...view.resident, ...view.deferred]
        .filter(hit)
        .sort(
          (a, b) =>
            b.sourcePriority - a.sourcePriority || a.name.localeCompare(b.name),
        );
      const limit = input.limit ?? DEFAULT_LIMIT;
      const shown = matched.slice(0, limit);
      // 判据与 `admit()` 的 `skill_narrowed` 逐字对齐。被收窄挡住的必须如实标出，
      // 否则模型会对着一个已展开却调不动的工具反复重试。
      const narrowed = (name: string): boolean =>
        Boolean(context.turn.skillAllowedTools?.size) &&
        !SKILL_NARROWING_EXEMPT.includes(name as ToolName) &&
        !context.turn.skillAllowedTools!.has(name);
      const already = context.turn.expandedTools;
      /**
       * 被收窄挡住的同样记进 `expandedTools`，只是仍然调不动。
       *
       * 展开与可调用是两件事：`expandedTools` 记录这一轮展开过什么，收窄是其下游的
       * 另一道过滤（`prepareStep` 那条 `先扩张后收窄，收窄永远赢`，`docs/07 §2.2`）。
       *
       * ⚠ 缺这一笔会形成死循环：`runtime.ts` 的 `repairToolCall` 依据原名是否在
       * `expandedTools` 中判断本次是否值得改写成一次检索。折叠且被收窄的工具若永远进不了
       * 这个集合，就会陷入模型调 X → NoSuchToolError → 改写成检索 → 返回 narrowed → 模型
       * 再调 X → 再改写的循环，直至耗尽步数上限。记入之后第二次尝试落回明确的
       * `NoSuchToolError`，模型看到的是失败而非一次往返。
       *
       * 代价是这类工具白占一格 `maxExpandedPerTurn`（32 格，一次最多报 8 个）：用一格额度换掉
       * 一个无法解释的空轮是划算的。
       */
      const fresh = shown
        .filter((tool) => deferred.has(tool.name) && !already?.has(tool.name))
        .map((tool) => tool.name);
      // 护栏在写入之前判定：每次展开都会改动请求体第 0 段（tools 数组），本轮剩余步骤的前缀缓存
      // 整段作废并重建一次（`docs/04 §2.1`）。约束的是展开次数累计到的工具数，不是目录大小。
      const budget = (context.turn.config as Readonly<Config>).tools.catalog
        .maxExpandedPerTurn;
      if ((already?.size ?? 0) + fresh.length > budget) {
        return {
          ok: false,
          error: "expansion_limit",
          hint: `本轮最多展开 ${budget} 个工具，已展开 ${already?.size ?? 0} 个。请使用 names 精确指定需要调用的工具。`,
        };
      }
      if (fresh.length) {
        const expanded = (context.turn.expandedTools ??= new Set());
        for (const name of fresh) expanded.add(name);
      }
      const matches = shown.map((tool) => ({
        name: tool.name,
        description: normalizeDescription(tool.description),
        // 常驻工具不属于任何折叠组，报 `resident` 而非留空：结构统一，模型无需推测缺失字段的含义。
        group: deferred.has(tool.name)
          ? (view.groups.find((group) => group.names.includes(tool.name))
              ?.key ?? "deferred")
          : "resident",
        status: narrowed(tool.name)
          ? ("narrowed" as const)
          : fresh.includes(tool.name)
            ? ("expanded" as const)
            : ("already_active" as const),
      }));
      dependencies.log.event({
        level: "info",
        kind: "tool.expanded",
        summary: `search_tools: ${matched.length} matched, ${fresh.length} expanded`,
        traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId,
        userId: context.turn.initiatorUserId,
        key: context.turn.key,
        data: {
          query: input.query,
          names: input.names,
          group: input.group,
          matched: matched.length,
          expanded: fresh,
        },
      });
      return {
        ok: true,
        matches,
        omitted: Math.max(0, matched.length - shown.length),
        hint:
          "expanded 的工具从**下一步**起可以直接调用（本步尚无法发出）；already_active 的工具当前即可调用；" +
          "narrowed 的工具被本轮载入的 skill 拦截，本轮无法调用，不要重试。需要更多结果请加大 limit 或更换关键词。",
      };
    },
  });
}
