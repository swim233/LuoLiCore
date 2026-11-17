import { z } from 'zod';
import { defineTool, ToolError, type ToolDefinition } from '../../core/index.js';
import type { ServiceLayer } from '../services/layer.js';
import { resultNotice } from '../services/tools.js';
import type { MonitorPurpose } from './describe.js';
import { itemText, titleOf } from './format.js';
import { fieldPaths } from './items.js';
import { monitorFields, type MonitorField } from './rules.js';
import { fetchFailureText, runTrial, type TrialResult } from './trial.js';

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
 * 「建任务时必填」的可以不写；建任务时两样都必填；改任务（update）时都可以不写，只写要改的，
 * 可以不写的字段（params、where）写 null 是去掉
 */
export function monitorInput(purpose: MonitorPurpose | 'update') {
  const shape = Object.fromEntries(
    monitorFields.map(({ name, required, text }) => {
      const type = fieldTypes[name];
      if (purpose === 'update') {
        return required === 'no'
          ? [name, type.nullable().optional().describe(`${text}。填 null 表示去掉此字段`)]
          : [name, type.optional().describe(text)];
      }
      const needed = required === 'yes' || (required === 'task' && purpose === 'task');
      const note = required === 'task' && purpose === 'try' ? '（创建任务时必填，测试时可选）' : '';
      return [name, (needed ? type : type.optional()).describe(`${text}${note}`)];
    }),
  );
  return z
    .object(shape)
    .describe(
      purpose === 'update'
        ? '监听任务的描述中要修改的字段，仅填写要修改的；各字段的写法见 read_docs 的 monitor'
        : '监听任务的描述，各字段的写法见 read_docs 的 monitor',
    );
}

const tryDescription = [
  '此工具用于测试监听任务的描述：按描述实际执行一次请求（计入此服务当天的请求次数），返回获取到的条目数、每个条目有哪些字段、哪些条目符合 where。',
  '创建监听任务前先用此工具测试，有问题就修改后重新测试；测试通过后再用 create_task 创建（kind 填 monitor）。描述的写法见 read_docs 的 monitor。',
  'CLI 会话不能创建监听任务，无需测试。',
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
      return ['测试', info?.title ?? service, endpointTitle].filter(Boolean).join(' · ');
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
  if (result.step === 'describe') {
    return `测试未通过：描述有问题，请修改后重新测试。\n${problemList(result.error.split('\n'))}`;
  }
  return `测试未通过：${fetchFailureText(result)}`;
}

/** 描述的问题逐条列出 */
export function problemList(problems: readonly string[]): string {
  return problems.map((line) => `- ${line}`).join('\n');
}

/** 试跑通过：取到几条、几条符合，字段，提醒，前几条的内容，最后告诉她可以建 */
export function trialText(result: Extract<TrialResult, { ok: true }>): string {
  const { monitor, items, matched, warnings } = result;
  const filtered = monitor.where !== undefined;
  const count =
    items.length === 0
      ? '获取到 0 条。'
      : filtered
        ? `获取到 ${items.length} 条，其中 ${matched.filter(Boolean).length} 条符合 where。`
        : `获取到 ${items.length} 条（未填写 where，全部符合）。`;
  const lines = [resultNotice, `测试通过。${count}`];
  if (items.length > 0) {
    lines.push(`条目的字段（取自第一条）：${fieldPaths(items[0]!.data).join('、')}`);
  } else {
    lines.push('当前没有条目，无法核对字段，以文档为准。');
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
        `其余 ${rest.length} 条仅列标题：`,
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
    `可以用 create_task 创建此监听任务：kind 填 monitor，monitor 填这份描述${
      missing.length > 0 ? `（创建时还需填写 ${missing.join('、')}）` : ''
    }。`,
  );
  return lines.join('\n');
}
