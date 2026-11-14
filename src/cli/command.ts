import type { CommandKind } from '../server/types.js';

/**
 * 一行输入是不是指令：去掉前后空白后，不分大小写等于 `/compact` 或 `/clear` 才是。后面跟了字的
 * （`/compact 重点记住旅行计划`）、别的以 `/` 开头的，都不是，当普通消息发出去
 */
export function parseCommand(line: string): CommandKind | undefined {
  const text = line.trim().toLowerCase();
  if (text === '/compact') return 'compact';
  if (text === '/clear') return 'clear';
  return undefined;
}
