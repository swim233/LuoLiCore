import { asSchema } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, ToolError, type ToolDefinition } from '../../core/index.js';
import { closeAll } from '../../net/test-server.js';
import { localDay, type ServiceLayer } from '../services/layer.js';
import { resultNotice } from '../services/tools.js';
import { monitorFields } from './rules.js';
import { serving, servingWith } from './test-monitors.js';
import { createTryMonitorTool } from './tools.js';

afterEach(closeAll);

type Layer = Pick<ServiceLayer, 'services' | 'check' | 'call'>;

/** 造试跑的工具；CLI 会话（conversation 为 cli）不能试 */
function tryTool(layer: Layer) {
  const tool = createTryMonitorTool({
    layer,
    checkConversation: async (id) => (id === 'cli' ? 'CLI 会话不能建任务' : undefined),
  });
  const run = (monitor: Record<string, unknown>, conversation = 'web') =>
    Promise.resolve(
      tool.execute(tool.input.parse({ monitor }), {
        conversation: { id: conversation },
        triggers: [],
        abortSignal: new AbortController().signal,
        logger: silentLogger,
        env: {},
      }),
    ) as Promise<string>;
  return { tool, run };
}

async function toolError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ToolError);
  return (error as ToolError).message;
}

/** 七条预警：第 1、4、6 条是新发布的橙色预警，其余是取消的；编号是 24 位的数字字符串，第 7 条用数字 */
function alerts() {
  const type = (index: number) => ([1, 4, 6].includes(index) ? 'alert' : 'cancel');
  const list = Array.from({ length: 7 }, (_, i) => {
    const index = i + 1;
    const id = index === 7 ? '202611161600008896177767' : `"20261116160000889617776${index}"`;
    return `{"id":${id},"headline":"预警 ${index}","messageType":{"code":"${type(index)}"},"severity":"moderate","level":1.10}`;
  });
  return `{"code":"200","alerts":[${list.join(',')}]}`;
}

const description = {
  service: 'demo',
  endpoint: 'search',
  params: { q: '上海' },
  items: 'alerts',
  key: 'id',
  where: { field: 'messageType.code', op: 'eq', value: 'alert' },
  title: 'headline',
  show: ['severity', 'level'],
};

describe('试跑的工具', () => {
  it('定义：名字、时限 30 秒、历史呈现用默认的；参数是 monitor，字段的说明取自字段表，where 不展开，试跑时只有「必填」的必填', async () => {
    const { layer } = await serving('[]');
    const { tool } = tryTool(layer);
    expect([tool.name, tool.timeoutMs, tool.history]).toEqual(['try_monitor', 30_000, undefined]);
    expect(tool.description).toContain('read_docs 的 monitor');

    const schema = (await asSchema(tool.input).jsonSchema) as {
      properties: {
        monitor: {
          properties: Record<string, { description: string; type?: string; properties?: unknown }>;
          required: string[];
        };
      };
    };
    const monitor = schema.properties.monitor;
    expect(Object.keys(monitor.properties)).toEqual(monitorFields.map(({ name }) => name));
    for (const { name, text } of monitorFields) {
      expect(monitor.properties[name]!.description.startsWith(text)).toBe(true);
    }
    expect(monitor.required).toEqual(
      monitorFields.filter(({ required }) => required === 'yes').map(({ name }) => name),
    );
    expect(monitor.properties.where).toMatchObject({ type: 'object' });
    expect(monitor.properties.where!.properties).toBeUndefined();
    expect(monitor.properties.mode).toMatchObject({ type: 'string' });
  });

  it('通过：真的查一次（算进当天的请求数）；取到几条、几条符合；字段；前 5 条写全、标出符不符合，其余只列标题；数字照原文', async () => {
    const { layer, feeds, server } = await serving(alerts);
    const { run } = tryTool(layer);

    const output = await run(description);

    expect(output).toBe(
      [
        resultNotice,
        '试跑通过。取到 7 条，其中 3 条符合 where。',
        '每条的字段（从第一条取）：id、headline、messageType.code、severity、level',
        '---',
        '第 1 条（符合）：\n预警 1\nseverity: moderate\nlevel: 1.10',
        '',
        '第 2 条（不符合）：\n预警 2\nseverity: moderate\nlevel: 1.10',
        '',
        '第 3 条（不符合）：\n预警 3\nseverity: moderate\nlevel: 1.10',
        '',
        '第 4 条（符合）：\n预警 4\nseverity: moderate\nlevel: 1.10',
        '',
        '第 5 条（不符合）：\n预警 5\nseverity: moderate\nlevel: 1.10',
        '',
        '其余 2 条只列标题：',
        '- 第 6 条（符合）：预警 6',
        '- 第 7 条（不符合）：预警 7',
        '---',
        '可以用 create_task 建这个监视任务：kind 写 monitor，monitor 里放这份描述（建的时候还要写 interval_minutes、mode）。',
      ].join('\n'),
    );
    expect(server.requests.map(({ path }) => path)).toEqual([
      `/search?q=${encodeURIComponent('上海')}`,
    ]);
    expect(feeds.requestsOn('demo', localDay(new Date()))).toBe(1);
  });

  it('没写 where：每一条都算，不标符不符合；编号是大整数的数字照原文；写了 interval_minutes、mode 就不再提', async () => {
    const { layer } = await serving('[{"id":9007199254740993,"name":"甲"}]');
    const { run } = tryTool(layer);

    const output = await run({
      ...description,
      items: '',
      where: undefined,
      title: 'name',
      show: ['id'],
      interval_minutes: 5,
      mode: 'record',
    });

    expect(output.split('\n').slice(1)).toEqual([
      '试跑通过。取到 1 条（没写 where，每一条都算）。',
      '每条的字段（从第一条取）：id、name',
      '---',
      '第 1 条：',
      '甲',
      'id: 9007199254740993',
      '---',
      '可以用 create_task 建这个监视任务：kind 写 monitor，monitor 里放这份描述。',
    ]);
  });

  it('0 条：说没法核对字段；items 指到的地方没有时带提醒，列出那一层的键', async () => {
    const { layer } = await serving('{"code":"200","warning":[]}');
    const { run } = tryTool(layer);

    expect((await run(description)).split('\n').slice(1)).toEqual([
      '试跑通过。取到 0 条。',
      '现在没有条目，没法核对字段，照文档写的为准。',
      '提醒：',
      '- items 写的「alerts」在返回里没有（或者是 null），当作 0 条。返回的最外层有这些键：code、warning。要是路径写错了，改 items',
      '可以用 create_task 建这个监视任务：kind 写 monitor，monitor 里放这份描述（建的时候还要写 interval_minutes、mode）。',
    ]);
  });

  it('有提醒的逐条写上（编号重复）', async () => {
    const { layer } = await serving('{"alerts":[{"id":"a"},{"id":"a"}]}');
    const { run } = tryTool(layer);
    expect(await run({ ...description, where: undefined })).toContain(
      '提醒：\n- 有 1 条的编号和前面的重复（如「a」），只算第一次出现的那条。',
    );
  });

  it('描述有问题：以错误结束，逐条列出，不发请求', async () => {
    const { layer, server } = await serving('[]');
    const { run } = tryTool(layer);

    const message = await toolError(
      run({ ...description, key: '', where: { field: 'a', op: 'like', value: 1 }, mode: 'decide' }),
    );

    expect(message).toBe(
      [
        '试跑没通过：描述有问题，改了再试。',
        '- key 不能是空的：写一个路径，如 messageType.code',
        '- where.op 写成了「like」：比法只有 eq、ne、in、gt、gte、lt、lte、contains',
        '- mode 写 decide（你自己决定）还不支持，现在只能写 reply（触发你回复）或 record（只记录）',
      ].join('\n'),
    );
    expect(server.requests).toEqual([]);
  });

  it('调接口出错：服务层的说明原样带上', async () => {
    const { layer } = await servingWith((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"维护中"}');
    });
    const { run } = tryTool(layer);
    expect(await toolError(run(description))).toBe(
      '试跑没通过：调接口出错。服务 demo 回了 HTTP 500：{"error":"维护中"}',
    );
  });

  it('正文不是 JSON、返回的样子和描述对不上：说清是哪一步', async () => {
    const page = await serving('<html>维护中</html>', { contentType: 'text/html' });
    expect(await toolError(tryTool(page.layer).run(description))).toBe(
      '试跑没通过：服务返回的正文不是 JSON（text/html）。监视只能盯返回 JSON 的接口',
    );

    const object = await serving('{"alerts":{"id":"a"}}');
    expect(await toolError(tryTool(object.layer).run(description))).toBe(
      '试跑没通过：返回的样子和描述对不上。items 指到的「alerts」不是列表，是对象（这一层有这些键：id）。items 要指到返回里那个列表',
    );

    const keyless = await serving('{"alerts":[{"headline":"x"}]}');
    expect(await toolError(tryTool(keyless.layer).run(description))).toBe(
      '试跑没通过：返回的样子和描述对不上。第 1 条的 key（id）没有这个字段。key 要指到每一条里当编号用的字段',
    );
  });

  it('CLI 会话：照检查会话的说明以错误结束，不发请求', async () => {
    const { layer, server } = await serving('[]');
    const { run } = tryTool(layer);
    expect(await toolError(run(description, 'cli'))).toBe('CLI 会话不能建任务');
    expect(server.requests).toEqual([]);
  });

  it('界面摘要：「试跑 · 服务的名称 · 接口的名称」；认不出的照原样写', async () => {
    const { layer } = await serving('[]');
    const { tool } = tryTool(layer);
    const summary = (monitor: Record<string, unknown>) =>
      (tool as ToolDefinition).summary!({ input: { monitor } });
    expect(summary(description)).toBe('试跑 · 示例服务 · 搜索');
    expect(summary({ ...description, service: 'nope', endpoint: 'x' })).toBe('试跑 · nope · x');
    expect(summary({})).toBe('试跑');
  });
});
