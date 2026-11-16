import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { plugins } from '../../plugins/index.js';
import { defineTool, type Logger } from '../core/index.js';
import { definePlugin } from '../plugin-api.js';
import { setupServiceTools } from './plugins.js';

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

// 装配时不取任务服务，任务工具执行时才取
const tasks = () => {
  throw new Error('装配时不该取任务服务');
};

const taskToolNames = ['create_task', 'list_tasks', 'cancel_task'];

describe('服务启动时装配插件与工具', () => {
  it('插件清单装配出来的工具：fetch 在前，后面接上任务的三个，和搬进插件之前一样', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupServiceTools({ plugins, tasks, env: {}, logger, report });

    expect(result.ok && result.tools.map((t) => t.definition.name)).toEqual([
      'fetch',
      ...taskToolNames,
    ]);
    expect(lines).toEqual([]);
    expect(entries).toEqual([
      { level: 'info', msg: 'tools.installed', fields: { tools: ['fetch', ...taskToolNames] } },
    ]);
  });

  it('几个插件的工具按清单的先后排，插件里按插件自己的先后', () => {
    const { logger, report } = recording();

    const result = setupServiceTools({
      plugins: [
        definePlugin({ name: 'b', tools: [tool('b2'), tool('b1')] }),
        definePlugin({ name: 'a', tools: [tool('a1')] }),
      ],
      tasks,
      env: {},
      logger,
      report,
    });

    expect(result.ok && result.tools.map((t) => t.definition.name)).toEqual([
      'b2',
      'b1',
      'a1',
      ...taskToolNames,
    ]);
  });

  it('插件名不合规、插件重名时返回错误信息（服务打到 stderr 后退出），不提示、不记 tools.installed', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupServiceTools({
      plugins: [
        definePlugin({ name: 'Weather', tools: [tool('w')] }),
        definePlugin({ name: 'dup', tools: [tool('d1')] }),
        definePlugin({ name: '2x', tools: [] }),
        definePlugin({ name: 'dup', tools: [tool('d2')] }),
        definePlugin({ name: 'a-b', tools: [] }),
        definePlugin({ name: '', tools: [] }),
      ],
      tasks,
      env: {},
      logger,
      report,
    });

    const rule = '名字只能用小写字母、数字和下划线，以字母开头';
    expect(result).toEqual({
      ok: false,
      error: `插件定义有误：Weather（${rule}）；dup（重名）；2x（${rule}）；a-b（${rule}）；（空）（${rule}）`,
    });
    expect(lines).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('工具的规则照旧：不同插件里的工具重名、和任务工具重名时报工具重名', () => {
    const { logger, report } = recording();

    const result = setupServiceTools({
      plugins: [
        definePlugin({ name: 'a', tools: [tool('same'), tool('list_tasks')] }),
        definePlugin({ name: 'b', tools: [tool('same')] }),
      ],
      tasks,
      env: {},
      logger,
      report,
    });

    expect(result).toEqual({
      ok: false,
      error: '工具定义有误：same（重名）；list_tasks（重名）',
    });
  });

  it('工具的规则照旧：缺环境变量的插件工具不装，提示一行，记 tools.skipped', () => {
    const { logger, entries, lines, report } = recording();

    const result = setupServiceTools({
      plugins: [
        definePlugin({ name: 'a', tools: [tool('needs_key', ['LUOLI_TEST_KEY']), tool('free')] }),
      ],
      tasks,
      env: {},
      logger,
      report,
    });

    expect(result.ok && result.tools.map((t) => t.definition.name)).toEqual([
      'free',
      ...taskToolNames,
    ]);
    expect(lines).toEqual(['工具 needs_key 没有装上：缺少环境变量 LUOLI_TEST_KEY']);
    expect(entries).toEqual([
      {
        level: 'warn',
        msg: 'tools.skipped',
        fields: { tool: 'needs_key', missing: ['LUOLI_TEST_KEY'] },
      },
      { level: 'info', msg: 'tools.installed', fields: { tools: ['free', ...taskToolNames] } },
    ]);
  });
});
