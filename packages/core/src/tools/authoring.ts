import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { roleRank, type Role } from '@luoli/shared';
import { SkillPackageError, installSkillPackage } from '../skills/package.js';
import type { Config } from '../config/schema.js';
import type { McpPersistPorts } from '../mcp/persist.js';
import { persistMcpServers } from '../mcp/persist.js';
import type { PluginManager } from '../plugins/manager.js';
import type { SkillLoader } from '../skills/loader.js';
import type { CustomToolManager } from './custom.js';
import { builtinPolicy, type ToolExecutionContext, type ToolRegistry } from './registry.js';

export interface AuthoringToolDependencies {
  customTools: CustomToolManager;
  skills: SkillLoader;
  plugins: PluginManager;
  mcp: McpPersistPorts;
  /** 随包发的说明书 skill，模型不许覆写 —— 它们是它自己下一次要读的那份文档。 */
  reservedSkills: readonly string[];
}

/**
 * `install_skill` 的 source 能指到哪儿。**只有两处**：本轮 workspace，以及本会话在附件库里的
 * 那个子目录 —— 用户在聊天里丢的 zip 就落在后者（`packages/telegram/src/media.ts`）。
 *
 * `media.dir` 底下是**按 chatId 分目录存着所有会话的附件**，所以这里必须限定到本会话那一层：
 * 不限定就等于凭一个 `install_skill` 把任意别的会话的文件读进来。
 *
 * 判据走 `realpath` 而不是 `resolve`：`resolve` 认不出中途的软链接，而 workspace 是模型自己
 * 能往里写东西的目录 —— 它完全可以先 `ln -s / w` 再 `install_skill('w/etc/...')`。
 */
function resolveAuthoringSource(input: string, roots: readonly string[]): string | null {
  if (!input || input.includes('\0')) return null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const realRoot = realpathSync(root);
    const candidate = isAbsolute(input) ? resolve(input) : resolve(realRoot, input);
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (real === realRoot || real.startsWith(`${realRoot}${sep}`)) return real;
  }
  return null;
}

const settings = (context: ToolExecutionContext): Config['tools']['selfExtend'] => (context.turn.config as Readonly<Config>).tools.selfExtend;
/**
 * 七个工具共用的准入判据。**`role === 'owner'` 这道地板必须在 `available()` 里**，光靠
 * `TOOL_POLICY` 里那个 `minRole: 'owner'` 拦不住 —— 运维可以 `PATCH /api/tools/write_plugin`
 * 把 minRole 放宽到 `trusted`（带二次确认），而 `effectivePolicy()` 认那条覆盖。
 * 一次放宽就等于让任意受信会话里的成员往本进程里写全信任代码（docs/14 A27）。
 * 形状照 `spawn_harness`：它的 owner + 私聊判定同样写在 `available()` 里（docs/09 §3.7 第一条不变量）。
 */
const gate = (role: Role, context: ToolExecutionContext, channel: (config: Config['tools']['selfExtend']) => boolean): boolean =>
  role === 'owner' && settings(context).enabled && channel(settings(context));
const execMax = (context: ToolExecutionContext): number => (context.turn.config as Readonly<Config>).tools.exec.maxTimeoutMs;

/**
 * 自我扩展的七个工具（docs/07 §6）。
 *
 * **一律无条件注册，开关放在 `available()` 里。** 按配置跳过注册会撞上 `main.ts` 的
 * 「每个 `TOOL_POLICY` 条目都必须已注册」那条启动断言 —— 表现是关掉这个功能之后进程起不来。
 *
 * `inputSchema` 里没有 `chatId` / `userId`（docs/05 §8）：落点一律取自 `context.turn`。
 *
 * 共同的纪律：**模型能创建，但不能让自己创建的东西生效**。自定义工具与 plugin 落库即禁用，
 * MCP server 落地即 `enabled: false`，全都要 owner 在 WebUI 看过正文 / argv 再点启用。
 * 唯一的例外是运维显式打开 `tools.selfExtend.customTools.autoEnable`。
 */
export function registerAuthoringTools(registry: ToolRegistry, dependencies: AuthoringToolDependencies): void {
  const customToolsOn = (role: Role, context: ToolExecutionContext): boolean => gate(role, context, (config) => config.customTools.enabled);

  registry.register({
    name: 'define_tool',
    description: '把一段常用做法固化成你自己的工具：给它名字、描述、参数 JSON Schema 和一段 bash/python 正文，之后就能像内建工具那样按参数调用。'
      + '正文通过 $1（参数 JSON 文件路径）和 $LUOLI_ARG_<参数名大写>（顶层标量参数）拿到入参 —— 参数永远不会被拼进命令行。写之前先 load_skill("writing-tools")。',
    inputSchema: z.object({
      name: z.string().min(2).max(41).describe('小写字母开头的 [a-z0-9_]，注册时自动加 custom_ 前缀'),
      description: z.string().min(1).max(200).describe('下一轮你只能靠这句话决定要不要调它'),
      runtime: z.enum(['bash', 'python']).describe('正文用哪个解释器跑'),
      body: z.string().min(1).describe('脚本正文。参数从 $1 指向的 JSON 文件或 $LUOLI_ARG_* 环境变量读'),
      params: z.record(z.unknown()).optional().describe('参数的 JSON Schema，形如 {"type":"object","properties":{...},"required":[...]}'),
      minRole: z.enum(['trusted', 'owner']).optional().describe('谁能调它，默认取配置里的默认值'),
      timeoutMs: z.number().int().positive().optional().describe('单次执行的墙钟上限'),
    }),
    // 上限随配置走，让模型看到的 schema 就是真实上限。
    inputSchemaFor: (context) => z.object({
      name: z.string().min(2).max(41), description: z.string().min(1).max(200), runtime: z.enum(['bash', 'python']),
      body: z.string().min(1).max(settings(context).customTools.maxBodyChars), params: z.record(z.unknown()).optional(),
      minRole: z.enum(['trusted', 'owner']).optional(), timeoutMs: z.number().int().positive().max(execMax(context)).optional(),
    }),
    policy: builtinPolicy('define_tool'), sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (input, context) => dependencies.customTools.define(input, context),
  });

  registry.register({
    name: 'delete_tool',
    description: '删掉一个自己定义的工具（只能删 custom_ 开头的那些）。撞上数量上限时先用这个腾位置。',
    inputSchema: z.object({ name: z.string().min(1) }),
    policy: builtinPolicy('delete_tool'), sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (input, context) => dependencies.customTools.remove(input.name, context),
  });

  registry.register({
    name: 'list_tools',
    description: '列出你自己定义过的工具，带启用状态与作用域。定义完却在工具目录里找不到时用它看是为什么。',
    inputSchema: z.object({}),
    policy: builtinPolicy('list_tools'), sourcePriority: 90,
    available: (role, context) => customToolsOn(role, context),
    execute: (_input, context) => dependencies.customTools.list(context),
  });

  registry.register({
    name: 'write_skill',
    description: '写一份 SKILL.md 给自己：把一套做法、清单或格式固化下来，之后靠 load_skill 渐进式取用。'
      + 'allowed-tools 一旦声明就会在载入后收窄本轮可用工具，不声明则不收窄。写之前先 load_skill("writing-skills")。',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('kebab-case，同时是目录名'),
      description: z.string().min(1).max(500).describe('目录里那一行，决定你以后会不会想起来载入它'),
      body: z.string().min(1).describe('SKILL.md 正文（Markdown）'),
      allowedTools: z.array(z.string()).optional().describe('声明了就会收窄；不确定就别给'),
      minRole: z.enum(['limited', 'trusted', 'owner']).optional().describe('谁能载入它，不能低于配置下限'),
      enabled: z.boolean().optional().describe('置 false = 退休这份 skill（没有删除工具，用它）'),
    }),
    policy: builtinPolicy('write_skill'), sourcePriority: 90,
    available: (role, context) => gate(role, context, (config) => config.skills.enabled),
    execute: (input, context) => {
      if (dependencies.reservedSkills.includes(input.name)) {
        return { ok: false, error: 'skill_reserved', hint: `${input.name} 是随包发的说明书，改不得 —— 换个名字。` };
      }
      const floor = settings(context).skills.minRole;
      // 只能写得更严，不能更松：一份 min-role 比下限还低的 skill 等于把这段正文推给更多人的上下文。
      if (input.minRole && roleRank(input.minRole) < roleRank(floor)) {
        return { ok: false, error: 'min_role_too_low', hint: `min-role 不能低于 ${floor}。` };
      }
      const write = { description: input.description, body: input.body, minRole: (input.minRole ?? floor) as Role,
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}), ...(input.enabled === undefined ? {} : { enabled: input.enabled }) };
      try {
        const existing = dependencies.skills.read(input.name);
        const skill = existing ? dependencies.skills.update(input.name, write) : dependencies.skills.create(input.name, write);
        return { ok: true, name: skill.name, created: !existing, minRole: skill.minRole, enabled: skill.enabled,
          hint: skill.enabled ? '下一轮就会出现在 skill 目录里，用 load_skill 取正文。' : '已保存但停用，不会出现在目录里。' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'skill_write_failed' };
      }
    },
  });

  registry.register({
    name: 'install_skill',
    description: '把一个 skill 包装进来：带 scripts/、bin/、references/ 的整棵目录，zip 或已解开的目录都行（用户在聊天里发的 zip 就用这个装）。'
      + '**装完是停用状态**，要 owner 在 WebUI 看过附带的脚本与二进制再点启用 —— 包里可能带可执行文件，这一点和只写一段正文的 write_skill 不同。'
      + 'source 只能指向你的工作目录或本会话收到的附件。写之前先 load_skill("writing-skills")。',
    inputSchema: z.object({
      source: z.string().min(1).describe('zip 或目录的路径：工作目录内的相对路径，或本会话附件的绝对路径'),
      name: z.string().min(1).max(64).optional().describe('装成什么名字（kebab-case，同时是目录名）。不给则取包里 SKILL.md 声明的那个'),
      subdir: z.string().min(1).optional().describe('包里有多份 SKILL.md 时用它指一个；报 skill_ambiguous_root 时会把候选列出来'),
      overwrite: z.boolean().optional().describe('同名已存在时覆盖（旧的那棵会留档）'),
    }),
    policy: builtinPolicy('install_skill'), sourcePriority: 90,
    available: (role, context) => gate(role, context, (config) => config.skills.enabled),
    execute: async (input, context) => {
      const config = context.turn.config as Readonly<Config>;
      const source = resolveAuthoringSource(input.source, [context.workspace, join(config.media.dir, context.turn.chatId)]);
      if (!source) {
        return { ok: false, error: 'skill_source_forbidden',
          hint: `${input.source} 不在你的工作目录里，也不是本会话收到的附件 —— 这两处之外的路径不给装。` };
      }
      try {
        const installed = await installSkillPackage(dependencies.skills, source, {
          limits: config.skills.package, minRoleFloor: settings(context).skills.minRole, origin: input.source,
          ...(input.name ? { name: input.name } : {}), ...(input.subdir ? { subdir: input.subdir } : {}),
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        });
        return { ok: true, name: installed.name, enabled: false, files: installed.files, bytes: installed.bytes,
          hint: `已装好但**停用**，所以现在还不在你的 skill 目录里。owner 要在 WebUI 的扩展页看过 SKILL.md 与这 ${installed.files.length} 个文件再点启用；`
            + `启用之后用 load_skill("${installed.name}") 取正文，附属文件走 read_file("skill://${installed.name}/<相对路径>")。`
            + (installed.backedUp ? '被覆盖的那棵已留档。' : '') };
      } catch (error) {
        if (error instanceof SkillPackageError) {
          return { ok: false, error: error.code, ...(error.hint ? { hint: error.hint } : {}), ...(error.candidates ? { candidates: error.candidates } : {}) };
        }
        return { ok: false, error: 'skill_package_failed', hint: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    name: 'write_plugin',
    description: '写一个 plugin（进程内运行的 JS 模块，能注册工具、挂 hook）。**只认 .js，没有转译步骤**。'
      + '写完之后它是禁用状态，要 owner 在 WebUI 看过源码再启用 —— plugin 在 bot 进程里全信任运行，等于 root。写之前先 load_skill("writing-plugins")。',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('kebab-case，同时是目录名，必须与 definePlugin 里的 name 一致'),
      source: z.string().min(1).describe('plugin.js 的完整内容（ESM，default export 一个 definePlugin 的结果）'),
    }),
    inputSchemaFor: (context) => z.object({ name: z.string().min(1).max(64), source: z.string().min(1).max(settings(context).plugins.maxBodyChars) }),
    policy: builtinPolicy('write_plugin'), sourcePriority: 90,
    available: (role, context) => gate(role, context, (config) => config.plugins.enabled),
    execute: async (input) => {
      try {
        const written = await dependencies.plugins.writeSource(input.name, input.source);
        return { ok: true, name: written.name, created: written.created, enabled: false, backedUp: written.backup !== null,
          hint: `${written.reset ? '源码变了，已打回未启用。' : '已写入，处于未启用状态。'}${written.backup ? '被覆盖的那份已留档在同目录下。' : ''}`
            + `owner 要在 WebUI 的扩展页看过源码再点启用；启用后它的工具会以 ${input.name}_<工具名> 出现。` };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'plugin_write_failed';
        return { ok: false, error: message, ...(message === 'invalid_plugin_name' ? { hint: '名字要是 kebab-case（小写字母数字，连字符分隔）。' } : {}) };
      }
    },
  });

  registry.register({
    name: 'install_mcp',
    description: '登记一台 MCP server（stdio 起本地进程，或 http 连远端），它的工具会以 mcp__<server>__<工具名> 出现。'
      + '登记后是禁用状态：owner 要在 WebUI 看过这条命令行 / URL 再启用 —— stdio 的 server 以 bot 进程的身份跑在沙箱之外。写之前先 load_skill("installing-mcp")。',
    inputSchema: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('server 名，会成为工具名前缀'),
      transport: z.enum(['stdio', 'http']),
      command: z.string().min(1).optional().describe('stdio：可执行文件，如 npx'),
      args: z.array(z.string()).optional().describe('stdio：参数，如 ["-y","@modelcontextprotocol/server-github"]'),
      url: z.string().url().optional().describe('http：服务地址'),
      toolAllow: z.array(z.string()).optional().describe('只放行这些工具名（glob）'),
      toolDeny: z.array(z.string()).optional().describe('挡掉这些工具名（glob）'),
      timeoutMs: z.number().int().positive().optional(),
    }),
    policy: builtinPolicy('install_mcp'), sourcePriority: 90,
    available: (role, context) => gate(role, context, (config) => config.mcp.enabled),
    execute: (input, context) => {
      const allowed = settings(context).mcp.allowTransports;
      if (!allowed.includes(input.transport)) return { ok: false, error: 'transport_not_allowed', hint: `这台机器只允许 ${allowed.join(' / ')}。` };
      if (input.transport === 'stdio' && !input.command) return { ok: false, error: 'command_required', hint: 'stdio 必须给 command。' };
      if (input.transport === 'http' && !input.url) return { ok: false, error: 'url_required', hint: 'http 必须给 url。' };
      // **取活的配置，不取 `turn.config`。** 后者是开轮时冻结的快照，`configStore.replace` 不会
      // 回写它 —— 同一轮里连装两台的话，第二次读到的 `current` 还是空的，于是整份 `mcp.servers`
      // 被覆写成只剩第二台，第一台连同它的 revision 一起消失。运维在轮次进行中改 MCP 同理。
      const current = dependencies.mcp.config().mcp.servers;
      if (current.some((server) => server.name === input.name)) return { ok: false, error: 'already_exists', hint: `已经有一台叫 ${input.name} 的了，用 list_mcp 看看。` };
      // **`enabled: false` 是写死的，不接受入参。** 模型登记的是一条会以 bot 进程身份长期运行的
      // argv / 一个能往系统提示词里塞工具描述的远端 —— 那一步必须有人看过。
      const server = { name: input.name, transport: input.transport, enabled: false,
        ...(input.transport === 'stdio' ? { command: input.command!, args: input.args ?? [] } : { url: input.url! }),
        ...(input.toolAllow ? { toolAllow: input.toolAllow } : {}), ...(input.toolDeny ? { toolDeny: input.toolDeny } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) };
      const saved = persistMcpServers(dependencies.mcp, [...current, server], `model:${context.turn.initiatorUserId}`);
      if (!saved.ok) return { ok: false, error: 'invalid_mcp_server', hint: saved.details.map((detail) => `${detail.path}: ${detail.message}`).join('; ') };
      return { ok: true, name: input.name, enabled: false, hint: '已登记但未启用。owner 在 WebUI 的扩展页确认之后才会连接，届时它的工具才会出现在你的目录里。' };
    },
  });

  registry.register({
    name: 'list_mcp',
    description: '列出已登记的 MCP server 与它们的连接状态。装之前先看一眼有没有重复的。',
    inputSchema: z.object({}),
    policy: builtinPolicy('list_mcp'), sourcePriority: 90,
    available: (role, context) => gate(role, context, (config) => config.mcp.enabled),
    execute: () => ({ ok: true, servers: dependencies.mcp.config().mcp.servers.map((server) => ({
      name: server.name, transport: server.transport, enabled: server.enabled !== false,
      target: server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url })) }),
  });
}
