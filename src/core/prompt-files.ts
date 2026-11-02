import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentLogger, type Logger } from './logger.js';

/**
 * 内置提示文件（仓库 prompts/ 下）与各自的变量：required 必须出现，optional 可以不用，
 * 其他 {{…}} 都算写错
 */
const builtins = {
  messageFormat: { file: 'message-format.md', required: [], optional: [] },
  conversation: { file: 'conversation.md', required: ['title'], optional: [] },
  priorSummary: { file: 'prior-summary.md', required: ['summary'], optional: [] },
  summary: { file: 'summary.md', required: ['scope'], optional: ['maxChars'] },
  scopeIdle: { file: 'summary-scope-idle.md', required: [], optional: [] },
  scopeBefore: { file: 'summary-scope-before.md', required: ['time'], optional: [] },
  scopeRecent: { file: 'summary-scope-recent.md', required: ['keep'], optional: [] },
} as const satisfies Record<
  string,
  { file: string; required: readonly string[]; optional: readonly string[] }
>;

/** 一次读到的提示文字：人设与内置提示，都已去掉首尾空白；内置提示里的变量还没填 */
export type PromptTexts = { persona: string } & Record<keyof typeof builtins, string>;

/**
 * 提示词来源。每次回复、每次摘要开始时 load() 一次，取当前的文字，这次调用都用这一份；
 * 读不了或变量不对时以 PromptFileError reject
 */
export type PromptSource = { load(): Promise<PromptTexts> };

/** 提示词文件读不了或变量不对。信息里列出每个文件与它的问题（含变量名），不含文件内容 */
export class PromptFileError extends Error {
  constructor(readonly problems: Array<{ file: string; problems: string[] }>) {
    const list = problems.map((entry) => `${entry.file}（${entry.problems.join('，')}）`);
    super(`提示词文件有误：${list.join('；')}`);
    this.name = 'PromptFileError';
  }
}

// 变量写法 {{名字}}，名字区分大小写。{{ 与 }} 之间（不跨行）的任何文字都算一个变量，
// 带空格的 {{ title }} 也是，名字不对就报错
const variable = /\{\{([^{}\n]*)\}\}/g;

/** 填变量，一次替换完成：填进去的值里即使有 {{…}} 也不再替换 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(variable, (whole, name: string) => values[name] ?? whole);
}

// 由代码所在位置推出仓库的 prompts/，不受启动目录影响
const repoPrompts = fileURLToPath(new URL('../../prompts/', import.meta.url));

/**
 * 从文件读提示词：人设文件与内置提示文件，每次 load() 都重读并检查。
 * 一个来源由所有会话共用：某个文件的内容与上一次读到的不同时记一条 prompts.changed
 * （只列文件，不记内容）；第一次读不记
 */
export function createPromptFiles({
  personaPath,
  dir = repoPrompts,
  logger = silentLogger,
}: {
  /** 人设文件，相对路径按启动目录解析；不给时用内置目录里的 system.md。人设没有变量，原样使用 */
  personaPath?: string;
  /** 内置提示文件的目录，默认仓库的 prompts/；测试里指向临时目录 */
  dir?: string;
  logger?: Logger;
} = {}): PromptSource {
  // label 写进错误信息与日志：内置文件写仓库相对路径，人设写配置的路径
  const files: Array<{
    key: keyof PromptTexts;
    label: string;
    path: string;
    variables?: { required: readonly string[]; optional: readonly string[] };
  }> = [
    personaPath === undefined
      ? { key: 'persona', label: 'prompts/system.md', path: join(dir, 'system.md') }
      : { key: 'persona', label: personaPath, path: personaPath },
    ...Object.entries(builtins).map(([key, { file, ...variables }]) => ({
      key: key as keyof typeof builtins,
      label: `prompts/${file}`,
      path: join(dir, file),
      variables,
    })),
  ];
  // 每个文件上一次读到的原文；读不了的文件保留更早读到的
  const last = new Map<keyof PromptTexts, string>();
  // 几个会话同时读时，只按最后开始的那次更新上面的记录：较早开始、较晚读完的不会把旧内容
  // 当成又一次变化，也不重复记日志
  let started = 0;
  let applied = 0;

  return {
    async load() {
      const id = ++started;
      const read = await Promise.all(
        files.map(async (file) => {
          try {
            return { ...file, text: await readFile(file.path, 'utf8'), error: undefined };
          } catch (error) {
            return { ...file, text: undefined, error };
          }
        }),
      );

      if (id > applied) {
        applied = id;
        const changed: string[] = [];
        for (const { key, label, text } of read) {
          if (text === undefined) continue;
          const previous = last.get(key);
          if (previous !== undefined && previous !== text) changed.push(label);
          last.set(key, text);
        }
        if (changed.length > 0) logger.info({ files: changed }, 'prompts.changed');
      }

      const problems = read.flatMap(({ label, text, error, variables }) => {
        const found = text === undefined ? [readProblem(error)] : checkVariables(text, variables);
        return found.length > 0 ? [{ file: label, problems: found }] : [];
      });
      if (problems.length > 0) throw new PromptFileError(problems);
      return Object.fromEntries(read.map(({ key, text }) => [key, text!.trim()])) as PromptTexts;
    },
  };
}

function readProblem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return '文件不存在';
  return `读不了（${code ?? (error instanceof Error ? error.message : String(error))}）`;
}

/** 文件里不认识的变量、漏掉的必需变量；人设（没有 variables）不检查 */
function checkVariables(
  text: string,
  variables: { required: readonly string[]; optional: readonly string[] } | undefined,
): string[] {
  if (!variables) return [];
  const names = new Set([...text.matchAll(variable)].map((match) => match[1]!));
  const known = new Set([...variables.required, ...variables.optional]);
  const unknown = [...names].filter((name) => !known.has(name));
  const missing = variables.required.filter((name) => !names.has(name));
  const braces = (list: string[]) => list.map((name) => `{{${name}}}`).join('、');
  return [
    ...(unknown.length > 0 ? [`不认识的变量 ${braces(unknown)}`] : []),
    ...(missing.length > 0 ? [`缺少变量 ${braces(missing)}`] : []),
  ];
}
