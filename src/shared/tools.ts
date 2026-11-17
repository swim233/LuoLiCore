import {
  installTools,
  ToolDefinitionError,
  type InstalledTool,
  type Logger,
  type ToolDefinition,
} from '../core/index.js';
import type { Env } from './config.js';

/**
 * 前端启动时装配工具清单：清单有误时返回错误信息（前端打到 stderr 后退出，同提示词文件出错）；
 * 缺环境变量没装上的，每个用 report 提示一行并记一条 warn tools.skipped（只有工具名与缺的变量名，
 * 不记任何变量的值）；装上的记一条 info tools.installed（没有工具时列表为空）
 */
export function setupTools(
  definitions: readonly ToolDefinition[],
  env: Env,
  { logger, report }: { logger: Logger; report: (line: string) => void },
): { ok: true; tools: InstalledTool[] } | { ok: false; error: string } {
  let setup;
  try {
    setup = installTools(definitions, env);
  } catch (error) {
    if (error instanceof ToolDefinitionError) return { ok: false, error: error.message };
    throw error;
  }
  for (const { name, missing } of setup.skipped) {
    report(`工具 ${name} 未安装：缺少环境变量 ${missing.join('、')}`);
    logger.warn({ tool: name, missing }, 'tools.skipped');
  }
  logger.info({ tools: setup.tools.map((tool) => tool.definition.name) }, 'tools.installed');
  return { ok: true, tools: setup.tools };
}
