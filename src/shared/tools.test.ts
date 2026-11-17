import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type Logger } from '../core/index.js';
import { setupTools } from './tools.js';

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recording() {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) =>
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  const lines: string[] = [];
  return { logger, entries, lines, report: (line: string) => lines.push(line) };
}

const tool = (name: string, env?: string[]) =>
  defineTool({ name, description: name, input: z.object({}), env, execute: () => 'ok' });

describe('启动时装配工具清单', () => {
  it('缺环境变量的不装：各提示一行、记一条 tools.skipped（不记变量的值）；装上的记 tools.installed', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupTools(
      [
        tool('dice'),
        tool('search', ['LUOLI_TEST_KEY', 'LUOLI_TEST_URL']),
        tool('mail', ['LUOLI_TEST_MAIL']),
      ],
      { LUOLI_TEST_KEY: '机密-值-3c9d', LUOLI_TEST_URL: '' },
      { logger, report },
    );

    expect(result.ok && result.tools.map((t) => t.definition.name)).toEqual(['dice']);
    expect(lines).toEqual([
      '工具 search 未安装：缺少环境变量 LUOLI_TEST_URL',
      '工具 mail 未安装：缺少环境变量 LUOLI_TEST_MAIL',
    ]);
    expect(entries).toEqual([
      {
        level: 'warn',
        msg: 'tools.skipped',
        fields: { tool: 'search', missing: ['LUOLI_TEST_URL'] },
      },
      {
        level: 'warn',
        msg: 'tools.skipped',
        fields: { tool: 'mail', missing: ['LUOLI_TEST_MAIL'] },
      },
      { level: 'info', msg: 'tools.installed', fields: { tools: ['dice'] } },
    ]);
    expect(JSON.stringify([entries, lines])).not.toContain('机密');
  });

  it('清单为空：没有提示，tools.installed 的列表为空', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupTools([], {}, { logger, report });

    expect(result).toEqual({ ok: true, tools: [] });
    expect(lines).toEqual([]);
    expect(entries).toEqual([{ level: 'info', msg: 'tools.installed', fields: { tools: [] } }]);
  });

  it('清单有误：返回错误信息（前端打到 stderr 后退出），不提示、不记 tools.installed', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupTools([tool('Dice'), tool('ok'), tool('ok')], {}, { logger, report });

    expect(result).toEqual({
      ok: false,
      error: '工具定义有误：Dice（名字只能用小写字母、数字和下划线，以字母开头）；ok（重名）',
    });
    expect(lines).toEqual([]);
    expect(entries).toEqual([]);
  });
});
