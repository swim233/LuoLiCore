import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { roleRank, type Role } from "@luoli/shared";
import { SkillPackageError, installSkillPackage } from "../skills/package.js";
import type { Config } from "../config/schema.js";
import type { McpPersistPorts } from "../mcp/persist.js";
import { persistMcpServers } from "../mcp/persist.js";
import type { PluginManager } from "../plugins/manager.js";
import type { SkillLoader } from "../skills/loader.js";
import type { CustomToolManager } from "./custom.js";
import {
  builtinPolicy,
  type ToolExecutionContext,
  type ToolRegistry,
} from "./registry.js";

export interface AuthoringToolDependencies {
  customTools: CustomToolManager;
  skills: SkillLoader;
  plugins: PluginManager;
  mcp: McpPersistPorts;
  /** 随包分发的说明文档 skill，模型不得覆写：它们是模型下一次要读的文档。 */
  reservedSkills: readonly string[];
}

/**
 * `install_skill` 的 source 允许指向的位置只有两处：本轮 workspace，以及本会话在附件库中的
 * 子目录，用户在聊天里发送的 zip 落在后者（`packages/telegram/src/media.ts`）。
 *
 * `media.dir` 之下按 chatId 分目录存放所有会话的附件，因此这里必须限定到本会话那一层：
 * 不限定即意味着一次 `install_skill` 就能读取任意其他会话的文件。
 *
 * 判据用 `realpath` 而非 `resolve`：`resolve` 识别不出路径中途的软链接，而 workspace 是模型
 * 可写的目录，它完全可以先 `ln -s / w` 再 `install_skill('w/etc/...')`。
 */
function resolveAuthoringSource(
  input: string,
  roots: readonly string[],
): string | null {
  if (!input || input.includes("\0")) return null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const realRoot = realpathSync(root);
    const candidate = isAbsolute(input)
      ? resolve(input)
      : resolve(realRoot, input);
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (real === realRoot || real.startsWith(`${realRoot}${sep}`)) return real;
  }
  return null;
}

const settings = (
  context: ToolExecutionContext,
): Config["tools"]["selfExtend"] =>
  (context.turn.config as Readonly<Config>).tools.selfExtend;
/**
 * 七个工具共用的准入判据。`role === 'owner'` 这道下限必须写在 `available()` 中，仅靠
 * `TOOL_POLICY` 里的 `minRole: 'owner'` 拦不住：运维可以 `PATCH /api/tools/write_plugin`
 * 把 minRole 放宽到 `trusted`（带二次确认），而 `effectivePolicy()` 承认该覆盖。
 * 一次放宽即等于允许任意受信会话的成员向本进程写入全信任代码（docs/14 A27）。
 * 形式参照 `spawn_harness`：它的 owner 与私聊判定同样写在 `available()` 中（docs/09 §3.7 第一条不变量）。
 */
const gate = (
  role: Role,
  context: ToolExecutionContext,
  channel: (config: Config["tools"]["selfExtend"]) => boolean,
): boolean =>
  role === "owner" && settings(context).enabled && channel(settings(context));
const execMax = (context: ToolExecutionContext): number =>
  (context.turn.config as Readonly<Config>).tools.exec.maxTimeoutMs;

/**
 * 自我扩展的七个工具（docs/07 §6）。
 *
 * 一律无条件注册，开关放在 `available()` 中。按配置跳过注册会触发 `main.ts` 中
 * 每个 `TOOL_POLICY` 条目都必须已注册那条启动断言，表现为关闭该功能后进程无法启动。
 *
 * `inputSchema` 里没有 `chatId` / `userId`（docs/05 §8）：落点一律取自 `context.turn`。
 *
 * 共同约束：模型可以创建，但不能让自己创建的东西生效。自定义工具与 plugin 落库即禁用，
 * MCP server 落地即 `enabled: false`，均需 owner 在 WebUI 查看正文或 argv 后手动启用。
 * 唯一例外是运维显式打开 `tools.selfExtend.customTools.autoEnable`。
 */
export function registerAuthoringTools(
  registry: ToolRegistry,
  dependencies: AuthoringToolDependencies,
): void {
  const customToolsOn = (role: Role, context: ToolExecutionContext): boolean =>
    gate(role, context, (config) => config.customTools.enabled);

  registry.register({
    name: "define_tool",
    description:
      "将一段常用做法封装为自定义工具：提供名字、描述、参数 JSON Schema 和一段 bash/python 正文，之后即可像内建工具那样按参数调用。" +
      '正文通过 $1（参数 JSON 文件路径）和 $LUOLI_ARG_<参数名大写>（顶层标量参数）获取入参 —— 参数永远不会被拼进命令行。编写前先调用 load_skill("writing-tools")。',
    inputSchema: z.object({
      name: z
        .string()
        .min(2)
        .max(41)
        .describe("小写字母开头的 [a-z0-9_]，注册时自动加 custom_ 前缀"),
      description: z
        .string()
        .min(1)
        .max(200)
        .describe("下一轮你只能据此判断是否调用它"),
      runtime: z.enum(["bash", "python"]).describe("正文使用哪个解释器执行"),
      body: z
        .string()
        .min(1)
        .describe(
          "脚本正文。参数从 $1 指向的 JSON 文件或 $LUOLI_ARG_* 环境变量读取",
        ),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          '参数的 JSON Schema，形如 {"type":"object","properties":{...},"required":[...]}',
        ),
      minRole: z
        .enum(["trusted", "owner"])
        .optional()
        .describe("谁能调用它，默认取配置中的默认值"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("单次执行的墙钟上限"),
    }),
    // 上限随配置走，让模型看到的 schema 即真实上限。
    inputSchemaFor: (context) =>
      z.object({
        name: z.string().min(2).max(41),
        description: z.string().min(1).max(200),
        runtime: z.enum(["bash", "python"]),
        body: z.string().min(1).max(settings(context).customTools.maxBodyChars),
        params: z.record(z.unknown()).optional(),
        minRole: z.enum(["trusted", "owner"]).optional(),
        timeoutMs: z.number().int().positive().max(execMax(context)).optional(),
      }),
    policy: builtinPolicy("define_tool"),
    sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (input, context) =>
      dependencies.customTools.define(input, context),
  });

  registry.register({
    name: "delete_tool",
    description:
      "删除一个自己定义的工具（只能删除 custom_ 开头的工具）。达到数量上限时先用它腾出位置。",
    inputSchema: z.object({ name: z.string().min(1) }),
    policy: builtinPolicy("delete_tool"),
    sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (input, context) =>
      dependencies.customTools.remove(input.name, context),
  });

  registry.register({
    name: "list_tools",
    description:
      "列出你自己定义过的工具，带启用状态与作用域。定义后未出现在工具目录中时使用它查看原因。",
    inputSchema: z.object({}),
    policy: builtinPolicy("list_tools"),
    sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (_input, context) => dependencies.customTools.list(context),
  });

  registry.register({
    name: "write_skill",
    description:
      "写一份 SKILL.md 给自己：将一套做法、清单或格式固化下来，之后通过 load_skill 渐进式取用。" +
      'allowed-tools 一旦声明就会在载入后收窄本轮可用工具，不声明则不收窄。编写前先调用 load_skill("writing-skills")。',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe("kebab-case，同时是目录名"),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("skill 目录中的那一行，决定你此后是否会想起载入它"),
      body: z.string().min(1).describe("SKILL.md 正文（Markdown）"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("声明后即收窄；不确定则不要提供"),
      requiresTools: z
        .array(z.string())
        .optional()
        .describe(
          "这份 skill 必需的工具。声明后即为门控：这些工具在本轮不可用时它不会进入目录",
        ),
      minRole: z
        .enum(["limited", "trusted", "owner"])
        .optional()
        .describe("谁能载入它，不能低于配置下限"),
      enabled: z
        .boolean()
        .optional()
        .describe(
          "设为 false = 禁用这份 skill（当前没有删除工具，使用本工具代替）",
        ),
    }),
    policy: builtinPolicy("write_skill"),
    sourcePriority: 90,
    available: (role, context) =>
      gate(role, context, (config) => config.skills.enabled),
    execute: (input, context) => {
      if (dependencies.reservedSkills.includes(input.name)) {
        return {
          ok: false,
          error: "skill_reserved",
          hint: `${input.name} 是随包发的说明文档，不允许修改 —— 请更换名字。`,
        };
      }
      const floor = settings(context).skills.minRole;
      // 只能收紧，不能放宽：min-role 低于下限的 skill 等于把这段正文推送到更多人的上下文中。
      if (input.minRole && roleRank(input.minRole) < roleRank(floor)) {
        return {
          ok: false,
          error: "min_role_too_low",
          hint: `min-role 不能低于 ${floor}。`,
        };
      }
      const write = {
        description: input.description,
        body: input.body,
        minRole: (input.minRole ?? floor) as Role,
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.requiresTools ? { requiresTools: input.requiresTools } : {}),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      };
      try {
        const existing = dependencies.skills.read(input.name);
        const skill = existing
          ? dependencies.skills.update(input.name, write)
          : dependencies.skills.create(input.name, write);
        return {
          ok: true,
          name: skill.name,
          created: !existing,
          minRole: skill.minRole,
          enabled: skill.enabled,
          hint: skill.enabled
            ? "下一轮即会出现在 skill 目录中，使用 load_skill 获取正文。"
            : "已保存但停用，不会出现在目录中。",
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "skill_write_failed",
        };
      }
    },
  });

  registry.register({
    name: "install_skill",
    description:
      "安装一个 skill 包：带 scripts/、bin/、references/ 的整棵目录，压缩包或已解开的目录均可，场景：安装用户发送的 skill 包。" +
      "**安装后处于停用状态**，需 owner 在 WebUI 复核附带的脚本与二进制后点击启用 —— 包内可能含可执行文件，这一点与只写一段正文的 write_skill 不同。" +
      'source 只能指向你的工作目录或本会话收到的附件。安装前先调用 load_skill("writing-skills")。',
    inputSchema: z.object({
      source: z
        .string()
        .min(1)
        .describe(
          "压缩包或目录的路径：工作目录内的相对路径，或本会话附件的绝对路径",
        ),
      name: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "安装后的名字（kebab-case，同时是目录名）。不提供则取包内 SKILL.md 声明的名字",
        ),
      subdir: z
        .string()
        .min(1)
        .optional()
        .describe(
          "包内有多份 SKILL.md 时使用该参数指定其一；报 skill_ambiguous_root 时会列出候选",
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe("同名已存在时覆盖（旧的那份会留档）"),
    }),
    policy: builtinPolicy("install_skill"),
    sourcePriority: 90,
    available: (role, context) =>
      gate(role, context, (config) => config.skills.enabled),
    execute: async (input, context) => {
      const config = context.turn.config as Readonly<Config>;
      const source = resolveAuthoringSource(input.source, [
        context.workspace,
        join(config.media.dir, context.turn.chatId),
      ]);
      if (!source) {
        return {
          ok: false,
          error: "skill_source_forbidden",
          hint: `${input.source} 不在你的工作目录中，也不是本会话收到的附件 —— 这两处之外的路径不予安装。`,
        };
      }
      try {
        const installed = await installSkillPackage(
          dependencies.skills,
          source,
          {
            limits: config.skills.package,
            minRoleFloor: settings(context).skills.minRole,
            origin: input.source,
            ...(input.name ? { name: input.name } : {}),
            ...(input.subdir ? { subdir: input.subdir } : {}),
            ...(input.overwrite === undefined
              ? {}
              : { overwrite: input.overwrite }),
          },
        );
        return {
          ok: true,
          name: installed.name,
          enabled: false,
          files: installed.files,
          bytes: installed.bytes,
          hint:
            `已安装但**停用**，因此当前尚未出现在你的 skill 目录中。owner 需在 WebUI 的扩展页复核 SKILL.md 与这 ${installed.files.length} 个文件后点击启用；` +
            `启用之后使用 load_skill("${installed.name}") 获取正文，附属文件通过 read_file("skill://${installed.name}/<相对路径>") 读取。` +
            (installed.backedUp ? "被覆盖的那份已留档。" : ""),
        };
      } catch (error) {
        if (error instanceof SkillPackageError) {
          return {
            ok: false,
            error: error.code,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error.candidates ? { candidates: error.candidates } : {}),
          };
        }
        return {
          ok: false,
          error: "skill_package_failed",
          hint: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  registry.register({
    name: "write_plugin",
    description:
      "写一个 plugin（进程内运行的 JS 模块，能注册工具、挂载 hook）。**只接受 .js，没有转译步骤**。" +
      '写完之后它处于禁用状态，需 owner 在 WebUI 复核源码后启用 —— plugin 在 bot 进程内以全信任方式运行，具有与 bot 进程相同的权限。编写前先调用 load_skill("writing-plugins")。',
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "kebab-case，同时是目录名，必须与 definePlugin 里的 name 一致",
        ),
      source: z
        .string()
        .min(1)
        .describe(
          "plugin.js 的完整内容（ESM，default export 一个 definePlugin 的结果）",
        ),
    }),
    inputSchemaFor: (context) =>
      z.object({
        name: z.string().min(1).max(64),
        source: z.string().min(1).max(settings(context).plugins.maxBodyChars),
      }),
    policy: builtinPolicy("write_plugin"),
    sourcePriority: 90,
    available: (role, context) =>
      gate(role, context, (config) => config.plugins.enabled),
    execute: async (input) => {
      try {
        const written = await dependencies.plugins.writeSource(
          input.name,
          input.source,
        );
        return {
          ok: true,
          name: written.name,
          created: written.created,
          enabled: false,
          backedUp: written.backup !== null,
          hint:
            `${written.reset ? "源码已变更，已打回未启用。" : "已写入，处于未启用状态。"}${written.backup ? "被覆盖的那份已留档在同目录下。" : ""}` +
            `owner 需在 WebUI 的扩展页复核源码后点击启用；启用后它的工具会以 ${input.name}_<工具名> 出现。`,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "plugin_write_failed";
        return {
          ok: false,
          error: message,
          ...(message === "invalid_plugin_name"
            ? { hint: "名字必须是 kebab-case（小写字母数字，连字符分隔）。" }
            : {}),
        };
      }
    },
  });

  registry.register({
    name: "install_mcp",
    description:
      "登记一台 MCP server（stdio 启动本地进程，或 http 连接远端），它的工具会以 mcp__<server>__<工具名> 出现。" +
      '登记后处于禁用状态：owner 需在 WebUI 复核这条命令行 / URL 后启用 —— stdio 的 server 以 bot 进程的身份运行于沙箱之外。登记前先调用 load_skill("installing-mcp")。',
    inputSchema: z.object({
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
        .describe("server 名，会成为工具名前缀"),
      transport: z.enum(["stdio", "http"]),
      command: z
        .string()
        .min(1)
        .optional()
        .describe("stdio：可执行文件，如 npx"),
      args: z
        .array(z.string())
        .optional()
        .describe(
          'stdio：参数，如 ["-y","@modelcontextprotocol/server-github"]',
        ),
      url: z.string().url().optional().describe("http：服务地址"),
      toolAllow: z
        .array(z.string())
        .optional()
        .describe("只放行这些工具名（glob）"),
      toolDeny: z
        .array(z.string())
        .optional()
        .describe("拦截这些工具名（glob）"),
      timeoutMs: z.number().int().positive().optional(),
    }),
    policy: builtinPolicy("install_mcp"),
    sourcePriority: 90,
    available: (role, context) =>
      gate(role, context, (config) => config.mcp.enabled),
    execute: (input, context) => {
      const allowed = settings(context).mcp.allowTransports;
      if (!allowed.includes(input.transport))
        return {
          ok: false,
          error: "transport_not_allowed",
          hint: `这台机器只允许 ${allowed.join(" / ")}。`,
        };
      if (input.transport === "stdio" && !input.command)
        return {
          ok: false,
          error: "command_required",
          hint: "stdio 必须提供 command。",
        };
      if (input.transport === "http" && !input.url)
        return {
          ok: false,
          error: "url_required",
          hint: "http 必须提供 url。",
        };
      // 取实时配置而非 `turn.config`。后者是开轮时冻结的快照，`configStore.replace` 不会
      // 回写它：同一轮内连续安装两台时，第二次读到的 `current` 仍为空，于是整份 `mcp.servers`
      // 被覆写成只剩第二台，第一台连同其 revision 一并消失。运维在轮次进行中修改 MCP 同理。
      const current = dependencies.mcp.config().mcp.servers;
      if (current.some((server) => server.name === input.name))
        return {
          ok: false,
          error: "already_exists",
          hint: `已存在名为 ${input.name} 的 server，使用 list_mcp 查看。`,
        };
      // `enabled: false` 固定写死，不接受入参。模型登记的是一条会以 bot 进程身份长期运行的
      // argv，或一个能向系统提示词注入工具描述的远端，该步骤必须经人工确认。
      const server = {
        name: input.name,
        transport: input.transport,
        enabled: false,
        ...(input.transport === "stdio"
          ? { command: input.command!, args: input.args ?? [] }
          : { url: input.url! }),
        ...(input.toolAllow ? { toolAllow: input.toolAllow } : {}),
        ...(input.toolDeny ? { toolDeny: input.toolDeny } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      };
      const saved = persistMcpServers(
        dependencies.mcp,
        [...current, server],
        `model:${context.turn.initiatorUserId}`,
      );
      if (!saved.ok)
        return {
          ok: false,
          error: "invalid_mcp_server",
          hint: saved.details
            .map((detail) => `${detail.path}: ${detail.message}`)
            .join("; "),
        };
      return {
        ok: true,
        name: input.name,
        enabled: false,
        hint: "已登记但未启用。owner 在 WebUI 的扩展页确认之后才会连接，届时它的工具才会出现在你的目录中。",
      };
    },
  });

  registry.register({
    name: "list_mcp",
    description:
      "列出已登记的 MCP server 与它们的连接状态。登记前先查看是否存在重复。",
    inputSchema: z.object({}),
    policy: builtinPolicy("list_mcp"),
    sourcePriority: 90,
    available: (role, context) =>
      gate(role, context, (config) => config.mcp.enabled),
    execute: () => ({
      ok: true,
      servers: dependencies.mcp.config().mcp.servers.map((server) => ({
        name: server.name,
        transport: server.transport,
        enabled: server.enabled !== false,
        target:
          server.transport === "stdio"
            ? [server.command, ...server.args].join(" ")
            : server.url,
      })),
    }),
  });
}
