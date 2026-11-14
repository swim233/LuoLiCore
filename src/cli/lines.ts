import { parseCommand } from './command.js';
import type { createChatSession } from './session.js';

type Session = Pick<ReturnType<typeof createChatSession>, 'say' | 'command'>;

/**
 * 处理一行输入（已去掉前后空白、不是空行）：是指令（`/compact`、`/clear`）就走指令的接口，否则当消息
 * 发出去。返回值同 session.say：连不上服务时为 'unreachable'
 */
export function handleLine(
  session: Session,
  text: string,
  signal?: AbortSignal,
): Promise<'done' | 'unreachable'> {
  const command = parseCommand(text);
  return command ? session.command(command, signal) : session.say(text, signal);
}

/**
 * 管道输入：逐行按顺序处理，每行（消息或指令）等它结束再处理下一行，读到 EOF 或 `/exit` 结束，
 * 跳过空行。连不上服务（发不出去、流中途断了、超时）时不再处理后面的行，返回退出码 1；
 * 模型出错、指令失败照常接着下一行。返回退出码
 */
export async function runLines(
  lines: AsyncIterable<string> | Iterable<string>,
  session: Session,
): Promise<number> {
  for await (const line of lines) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text && (await handleLine(session, text)) === 'unreachable') return 1;
  }
  return 0;
}
