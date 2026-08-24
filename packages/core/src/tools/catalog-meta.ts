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

/** 一次检索最多报几个。上限 20 焊在 schema 里 —— 一次展开二十个已经把「按需」的意义用完了。 */
const DEFAULT_LIMIT = 8;
/**
 * 描述在结果里截到这个长度。**tool result 会永久留在上下文里**（`docs/02`：`context_messages`
 * 只追加），把一份 4KB 的 MCP 描述抄进来等于给这一整段会话每轮都记一次账；而完整 schema
 * 下一步由 provider 的 tools 数组权威送达，这里只需要够模型认出「是不是我要的那个」。
 */
const MAX_DESCRIPTION_CHARS = 240;
/** minimatch 的元字符。一个不含它们的 `query` 按子串搜，含了就按 glob 匹配名字。 */
const GLOB_CHARS = /[*?[]/;

/**
 * 做法与 `custom.ts` 里那份同一条（控制字符能在目录里伪造分隔行、多行描述会把摘要撑开），
 * 只是上限不同：那份管的是模型自撰写工具的注册名片（200），这份管的是检索结果（240）。
 * 复用不成是因为那一份是模块私有的常量绑定，导出它等于让两个上限从此绑在一起。
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
        "query / names / group 至少给一个：三个都空等于让我把整份目录再抄一遍给你",
    },
  );

/**
 * `search_tools` —— 折叠目录的检索与展开入口（`docs/07 §5`）。
 *
 * 与 `builtins.ts` 分文件只为了并行改动，装配位置在 `main.ts` 那一串 `register*Tools` 里；
 * 它进了 `TOOL_POLICY`，所以**必须无条件注册**（那条启动断言只看注册没注册），开关全焊在
 * `available()` 里 —— 与自我扩展八工具、`stay_silent`、容器族同形。
 */
export function registerCatalogTools(
  registry: ToolRegistry,
  dependencies: { log: LogSink },
): void {
  registry.register({
    name: "search_tools",
    description:
      "按关键词、名字或分组检索本轮的折叠工具并展开它们：展开过的工具从下一步起可以直接调用。" +
      "目录里那几行「折叠工具」摘要就是它的入口 —— 摘要只有名字，要用哪个先在这里搜一下，不可以根据名字猜参数。" +
      "一次尽量把要用的都搜出来，跨轮想重新用某个工具直接用 names 精确指定。",
    inputSchema: searchSchema,
    policy: builtinPolicy("search_tools"),
    sourcePriority: 80,
    /**
     * 两道闸。`agentKind === 'main'`：**子 agent 拿到的是父轮同一个 turn 对象**
     * （`agent/subagent.ts` 的 `runSubAgent` 直接收 `turn`，`stay_silent` 为此写过同样的闸），
     * 让子 agent 调它就会往父轮的 `expandedTools` 里写，而子 agent 那条路没有 per-step 重算 ——
     * 展开对它自己毫无作用，只剩往父轮漏状态。子 agent 的 `definition.tools` 白名单本来就是比
     * 折叠更强的表达（`docs/07 §4.1`）。
     *
     * `hasDeferrable`：折叠集为空时整个工具不进目录 —— 纯内建部署（mcp 未开、无 plugin/custom）
     * 的提示词逐字节不变。不需要另判 `deferExternal`，`#deferredFor` 已经把它算进去了；
     * 而运维在工具页把这个工具关掉时，`activeView` 的折叠摘要也就没人能展开了 —— 那一档由
     * 提示层回退整目录常驻兜住（`docs/07 §5`），不在这里再判一次。
     */
    available: (role, context) =>
      context.agentKind === "main" && registry.hasDeferrable(role),
    execute: (input, context) => {
      // 检索域从 `activeView()` 派生 ⇒ 角色、`available()`、运维禁用、`maxRegistered` 截断
      // 全部已经滤过：limited 用户在这里枚举不到 owner 工具的描述，摘要里也不会出现一个
      // 开轮冻结的 toolSet 里根本没有的名字。
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
      // 三个通道取**并集**：每一个都是「找到它」的一种办法，给了两个不该让结果更少。
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
      // 判据与 `admit()` 的 `skill_narrowed` 那条逐字对齐。被收窄挡住的必须如实标出来 ——
      // 否则模型会对着一个展开了却调不动的工具原地重试。
      const narrowed = (name: string): boolean =>
        Boolean(context.turn.skillAllowedTools?.size) &&
        !SKILL_NARROWING_EXEMPT.includes(name as ToolName) &&
        !context.turn.skillAllowedTools!.has(name);
      const already = context.turn.expandedTools;
      /**
       * 收窄挡住的**照样记进 `expandedTools`**，只是它仍然调不动。
       *
       * 「展开」与「可调用」是两件事：`expandedTools` 记的是这一轮展开过什么，收窄是它下游的
       * 另一道过滤（`prepareStep` 那条 `先扩张后收窄，收窄永远赢`，`docs/07 §2.2`）。
       *
       * ⚠ 少了这一笔就是一个**死循环**：`runtime.ts` 的 `repairToolCall` 靠「原名不在
       * `expandedTools` 里」判断这次值不值得改写成一次检索。折叠且被收窄的工具如果永远进不了
       * 这个集合，就会走成「模型调 X → NoSuchToolError → 改写成检索 → 回一个 narrowed → 模型
       * 再调 X → 再改写 → …」，一路烧到步数上限。记上之后第二次尝试落回一句明确的
       * `NoSuchToolError`，模型看到的是失败而不是一个来回。
       *
       * 代价是这类工具白占一格 `maxExpandedPerTurn`（32 格，一次最多报 8 个）—— 拿一格额度换一个
       * 说不清的空轮，这笔换算不用犹豫。
       */
      const fresh = shown
        .filter((tool) => deferred.has(tool.name) && !already?.has(tool.name))
        .map((tool) => tool.name);
      // 护栏在**写之前**判：每一次展开都会改请求体第 0 段（tools 数组），本轮剩余步骤的前缀缓存
      // 整段作废重写一次（`docs/04 §2.1`）。压的是展开**次数**累计到的工具数，不是目录大小。
      const budget = (context.turn.config as Readonly<Config>).tools.catalog
        .maxExpandedPerTurn;
      if ((already?.size ?? 0) + fresh.length > budget) {
        return {
          ok: false,
          error: "expansion_limit",
          hint: `本轮最多展开 ${budget} 个工具，已展开 ${already?.size ?? 0} 个。用 names 精确指定需要调用的工具。`,
        };
      }
      if (fresh.length) {
        const expanded = (context.turn.expandedTools ??= new Set());
        for (const name of fresh) expanded.add(name);
      }
      const matches = shown.map((tool) => ({
        name: tool.name,
        description: normalizeDescription(tool.description),
        // 常驻工具不属于任何折叠组，报 `resident` 而不是留空：形状统一，模型也就不用猜缺字段的含义。
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
          "expanded 的从**下一步**起可以直接调用（这一步还发不出去）；already_active 本来就能调；" +
          "narrowed 的被本轮载入的 skill 挡住了，这一轮调不动，别重试。要更多结果就加大 limit 或换个关键词。",
      };
    },
  });
}
