import { readFile } from 'node:fs/promises';

/** 读取 system prompt 文件并去掉首尾空白。相对路径按进程工作目录解析。 */
export async function readInstructions(path = 'prompts/system.md'): Promise<string> {
  return (await readFile(path, 'utf8')).trim();
}
