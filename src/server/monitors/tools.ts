import { z } from 'zod';
import { defineTool, ToolError, type ToolDefinition } from '../../core/index.js';
import type { ServiceLayer } from '../services/layer.js';
import { resultNotice } from '../services/tools.js';
import type { MonitorPurpose } from './describe.js';
import { itemText, titleOf } from './format.js';
import { fieldPaths } from './items.js';
import { monitorFields, type MonitorField } from './rules.js';
import { runTrial, type TrialResult } from './trial.js';

// 监视的工具（ADR-0014）：试跑 try_monitor。由洛璃服务提供，装上了服务时才有

/** 试跑结果里写全的条数，其余只列标题 */
const shownItems = 5;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * 描述里每个字段在工具参数里的类型。where 是递归的结构，有的模型接口不认递归的参数结构，
 * 这里不展开，当成一个对象，由代码校验（describe.ts）。mode 写成字符串：decide 要能进来、得到「还不支持」
 */
const fieldTypes = {
  service: z.string(),
  endpoint: z.string(),
  params: z.record(z.string(), scalar),
  interval_minutes: z.number(),
  items: z.string(),
  key: z.string(),
  where: z.record(z.string(), z.unknown()),
  title: z.string(),
  show: z.array(z.string()),
  mode: z.string(),
} satisfies Record<MonitorField, z.ZodType>;

/**
 * 工具参数里的 monitor：字段的说明取自 rules.ts 的字段表。试跑时必填的是表里的「必填」，
 * 「建任务时必填」的可以不写
 */
export function monitorInput(purpose: MonitorPurpose) {
  const shape = Object.fromEntries(
    monitorFields.map(({ name, required, text }) => {
      const type = fieldTypes[name];
      const needed = required === 'yes' || (required === 'task' && purpose === 'task');
      const note =
        required === 'task' && purpose === 'try' ? '（建任务时必填，试跑时可以不写）' : '';
      return [name, (needed ? type : type.optional()).describe(`${text}${note}`)];
    }),
  );
  return z.object(shape).describe('监视任务的描述，各字段的写法见 read_docs 的 monitor');
}

const tryDescription = [
  '试跑一个监视任务的描述：照描述真的查一次（算进这个服务当天的请求数），告诉你取到几条、每条有哪些字段、哪几条符合 where。',
  '建监视任务之前先用它试，不对就改了再试；通过了再用 create_task 建（kind 写 monitor）。描述怎么写见 read_docs 的 monitor。',
  'CLI 会话不能建监视任务，也不用试。',
].join('\n');

/**
 * 造试跑的工具：服务层，和检查会话的函数（能建任务的会话才能试；不能时返回说明，如 CLI 会话）
 */
export function createTryMonitorTool({
  layer,
  checkConversation,
}: {
  layer: Pick<ServiceLayer, 'services' | 'check' | 'call'>;
  checkConversation: (conversationId: string | undefined) => Promise<string | undefined>;
}): ToolDefinition {
  return defineTool({
    name: 'try_monitor',
    description: tryDescription,
    input: z.object({ monitor: monitorInput('try') }),
    timeoutMs: 30_000,
    summary: ({ input }) => {
      const { service, endpoint } = (input.monitor ?? {}) as {
        service?: string;
        endpoint?: string;
      };
      const info = layer.services.find(({ name }) => name === service);
      const endpointTitle = info?.endpoints.find(({ id }) => id === endpoint)?.title ?? endpoint;
      return ['试跑', info?.title ?? service, endpointTitle].filter(Boolean).join(' · ');
    },
    async execute({ monitor }, ctx) {
      const rejected = await checkConversation(ctx.conversation.id);
      if (rejected) throw new ToolError(rejected);
      const result = await runTrial(layer, monitor, { purpose: 'try', signal: ctx.abortSignal });
      if (!result.ok) throw new ToolError(failureText(result));
      return trialText(result);
    },
  });
}

/** 试跑没通过：是哪一步、为什么 */
function failureText(result: Extract<TrialResult, { ok: false }>): string {
  switch (result.step) {
    case 'describe':
      return `试跑没通过：描述有问题，改了再试。\n${result.error
        .split('\n')
        .map((line) => `- ${line}`)
        .join('\n')}`;
    case 'call':
      return `试跑没通过：调接口出错。${result.error}`;
    case 'parse':
      return `试跑没通过：${result.error}`;
    case 'items':
      return `试跑没通过：返回的样子和描述对不上。${result.error}`;
  }
}

/** 试跑通过：取到几条、几条符合，字段，提醒，前几条的内容，最后告诉她可以建 */
export function trialText(result: Extract<TrialResult, { ok: true }>): string {
  const { monitor, items, matched, warnings } = result;
  const filtered = monitor.where !== undefined;
  const count =
    items.length === 0
      ? '取到 0 条。'
      : filtered
        ? `取到 ${items.length} 条，其中 ${matched.filter(Boolean).length} 条符合 where。`
        : `取到 ${items.length} 条（没写 where，每一条都算）。`;
  const lines = [resultNotice, `试跑通过。${count}`];
  if (items.length > 0) {
    lines.push(`每条的字段（从第一条取）：${fieldPaths(items[0]!.data).join('、')}`);
  } else {
    lines.push('现在没有条目，没法核对字段，照文档写的为准。');
  }
  if (warnings.length > 0) lines.push('提醒：', ...warnings.map((warning) => `- ${warning}`));
  if (items.length > 0) {
    const mark = (index: number) => (filtered ? (matched[index] ? '（符合）' : '（不符合）') : '');
    lines.push('---');
    const full = items.slice(0, shownItems).map((item, index) => {
      return `第 ${item.position} 条${mark(index)}：\n${itemText(item.data, monitor)}`;
    });
    lines.push(full.join('\n\n'));
    const rest = items.slice(shownItems);
    if (rest.length > 0) {
      lines.push(
        '',
        `其余 ${rest.length} 条只列标题：`,
        ...rest.map(
          (item, index) =>
            `- 第 ${item.position} 条${mark(index + shownItems)}：${titleOf(item.data, monitor)}`,
        ),
      );
    }
    lines.push('---');
  }
  const missing = (['interval_minutes', 'mode'] as const).filter(
    (name) => monitor[name] === undefined,
  );
  lines.push(
    `可以用 create_task 建这个监视任务：kind 写 monitor，monitor 里放这份描述${
      missing.length > 0 ? `（建的时候还要写 ${missing.join('、')}）` : ''
    }。`,
  );
  return lines.join('\n');
}
