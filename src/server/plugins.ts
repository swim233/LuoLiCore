import type { InstalledTool, Logger, ToolDefinition } from '../core/index.js';
import type { Plugin } from '../plugin-api.js';
import type { Env } from '../shared/config.js';
import { setupTools } from '../shared/tools.js';
import { createMonitorDoc, monitorDocClash, type MonitorDoc } from './monitors/docs.js';
import { createTryMonitorTool } from './monitors/tools.js';
import { installServices, type InstalledService } from './services/install.js';
import type { ServiceLayer } from './services/layer.js';
import { createServiceTools } from './services/tools.js';
import type { TaskService } from './tasks/service.js';
import { createTaskTools } from './tasks/tools.js';

// 插件（ADR-0014）：服务启动时分两步装配插件清单（plugins/index.ts）。先装插件：检查插件名，
// 取出插件里的工具，装上插件声明的服务；再装工具：插件的工具、读文档与调服务两个工具（装上了服务时）、
// 服务自己的任务工具（ADR-0010），最后是试跑监听的工具（装上了服务时），按这个顺序发给模型

/** 插件清单有误（名字不合规、重名）。信息里列出每个插件与它的问题 */
export class PluginDefinitionError extends Error {
  constructor(readonly problems: Array<{ plugin: string; problems: string[] }>) {
    const list = problems.map(
      (entry) => `${entry.plugin || '（空）'}（${entry.problems.join('，')}）`,
    );
    super(`插件定义有误：${list.join('；')}`);
    this.name = 'PluginDefinitionError';
  }
}

// 同工具名的规则
const pluginName = /^[a-z][a-z0-9_]*$/;

/**
 * 插件清单里的全部工具：按插件在清单里的先后，插件里再按插件自己的先后。
 * 先检查插件名（规则同工具名）与重名，有误时抛 PluginDefinitionError；
 * 工具本身（名字、重名、环境变量……）由之后装配工具时检查
 */
function pluginTools(plugins: readonly Plugin[]): ToolDefinition[] {
  // 按名字归并问题，按清单里第一次出现的顺序列出
  const problems = new Map<string, string[]>();
  const report = (name: string, problem: string) => {
    const list = problems.get(name) ?? [];
    if (!list.includes(problem)) list.push(problem);
    problems.set(name, list);
  };
  const counts = new Map<string, number>();
  for (const { name } of plugins) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const { name } of plugins) {
    if (!pluginName.test(name)) report(name, '名字只能用小写字母、数字和下划线，以字母开头');
    if (counts.get(name)! > 1) report(name, '重名');
  }
  if (problems.size > 0) {
    throw new PluginDefinitionError(
      [...problems].map(([plugin, list]) => ({ plugin, problems: list })),
    );
  }
  return plugins.flatMap((plugin) => plugin.tools);
}

/**
 * 第一步，装插件：检查插件名（规则同工具名）与重名，取出插件里的工具（之后装配工具时再检查），
 * 装上插件声明的服务（见 installServices：缺环境变量的不装，各提示一行）。插件或服务有误时返回错误信息
 * （服务打到 stderr 后退出）
 */
export function installPlugins({
  plugins,
  env,
  logger,
  report,
}: {
  plugins: readonly Plugin[];
  env: Env;
  logger: Logger;
  report: (line: string) => void;
}):
  | { ok: true; tools: ToolDefinition[]; services: InstalledService[] }
  | { ok: false; error: string } {
  let tools: ToolDefinition[];
  try {
    tools = pluginTools(plugins);
  } catch (error) {
    if (error instanceof PluginDefinitionError) return { ok: false, error: error.message };
    throw error;
  }
  const installed = installServices(
    plugins.flatMap((plugin) => plugin.services),
    env,
    { logger, report },
  );
  if (!installed.ok) return installed;
  return { ok: true, tools, services: installed.services };
}

/**
 * 第二步，装工具：插件的工具在前；装上了服务时（给了服务层）接上读文档、调服务两个工具；
 * 然后是任务的四个工具；装上了服务时最后是试跑监听的工具（ADR-0014），这时 read_docs 能读元文档
 * 「监听任务的写法」，建任务、改任务能写监听任务。按这个顺序发给模型。
 * 工具清单有误、元文档有误、有服务叫 monitor（和元文档重名）时返回错误信息（服务打到 stderr 后退出）；
 * 缺环境变量的工具不装，各提示一行（见 setupTools）。任务服务要等包过一层的存储建好才有，
 * 给的是取服务的函数，任务工具执行时才取它
 */
export function setupServiceTools({
  tools,
  services,
  tasks,
  env,
  logger,
  report,
  monitorDoc = createMonitorDoc(),
}: {
  /** 插件里的工具（installPlugins 的结果） */
  tools: readonly ToolDefinition[];
  /** 服务层；一个服务都没装上时（不给，或者里面没有服务）没有读文档、调服务、试跑监听三个工具，也不能建监听任务 */
  services?: ServiceLayer;
  tasks: () => Pick<
    TaskService,
    'create' | 'list' | 'cancelIn' | 'update' | 'now' | 'monitorStatus' | 'allows'
  >;
  env: Env;
  logger: Logger;
  report: (line: string) => void;
  /** 元文档；测试里换成临时文件 */
  monitorDoc?: MonitorDoc;
}): { ok: true; tools: InstalledTool[] } | { ok: false; error: string } {
  const layer = services && services.services.length > 0 ? services : undefined;
  if (!layer) return setupTools([...tools, ...createTaskTools(tasks)], env, { logger, report });
  const problem = monitorDocClash(layer.services) ?? monitorDoc.check();
  if (problem) return { ok: false, error: problem };
  return setupTools(
    [
      ...tools,
      ...createServiceTools(layer, { monitorDoc }),
      ...createTaskTools(tasks, { monitors: { services: layer.services } }),
      createTryMonitorTool({ layer, checkConversation: (id) => tasks().allows(id) }),
    ],
    env,
    { logger, report },
  );
}
