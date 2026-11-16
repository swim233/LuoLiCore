import type { InstalledTool, Logger, ToolDefinition } from '../core/index.js';
import type { Plugin } from '../plugin-api.js';
import type { Env } from '../shared/config.js';
import { setupTools } from '../shared/tools.js';
import { createTaskTools } from './tasks/tools.js';

// 插件（ADR-0014）：服务启动时装配插件清单（plugins/index.ts），取出插件里的工具，
// 后面接上服务自己的任务工具（ADR-0010），一起交给工具的装配

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
 * 服务启动时装配工具：插件的工具在前，后面接上任务的三个工具，按这个顺序发给模型。
 * 插件清单或工具清单有误时返回错误信息（服务打到 stderr 后退出）；缺环境变量的工具不装，
 * 各提示一行（见 setupTools）。任务服务要等包过一层的存储建好才有，给的是取服务的函数，
 * 任务工具执行时才取它
 */
export function setupServiceTools({
  plugins,
  tasks,
  env,
  logger,
  report,
}: {
  plugins: readonly Plugin[];
  tasks: Parameters<typeof createTaskTools>[0];
  env: Env;
  logger: Logger;
  report: (line: string) => void;
}): { ok: true; tools: InstalledTool[] } | { ok: false; error: string } {
  let fromPlugins: ToolDefinition[];
  try {
    fromPlugins = pluginTools(plugins);
  } catch (error) {
    if (error instanceof PluginDefinitionError) return { ok: false, error: error.message };
    throw error;
  }
  return setupTools([...fromPlugins, ...createTaskTools(tasks)], env, { logger, report });
}
