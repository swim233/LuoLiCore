import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { plugins } from '../../plugins/index.js';
import { defineTool } from '../core/index.js';
import { createRequester } from '../net/index.js';
import { closeAll, onClose } from '../net/test-server.js';
import { definePlugin, ServiceConfigError, type Plugin } from '../plugin-api.js';
import type { Env } from '../shared/config.js';
import { openFeedsDb } from './feeds-db.js';
import { installPlugins, setupServiceTools } from './plugins.js';
import { createServiceLayer } from './services/layer.js';
import { fakeDocs, fakeService, recording, tempDir } from './services/test-services.js';

afterEach(closeAll);

const tool = (name: string, env?: string[]) =>
  defineTool({ name, description: name, input: z.object({}), env, execute: () => 'ok' });

// 装配时不取任务服务，任务工具执行时才取
const tasks = () => {
  throw new Error('装配时不该取任务服务');
};

const taskToolNames = ['create_task', 'list_tasks', 'cancel_task'];
const serviceToolNames = ['read_docs', 'call_service'];

/**
 * 照 main.ts 的做法装配：先装插件（工具与服务），装上了服务时建服务层（feeds.db 用内存里的），
 * 再装工具。返回装上的工具名、错误信息、提示行与日志
 */
function assemble(pluginList: readonly Plugin[], env: Env = {}) {
  const { logger, entries, lines, report } = recording();
  const installed = installPlugins({ plugins: pluginList, env, logger, report });
  if (!installed.ok) return { error: installed.error, entries, lines };
  let layer;
  if (installed.services.length > 0) {
    const feeds = openFeedsDb(':memory:');
    const requester = createRequester();
    onClose(async () => {
      await requester.close();
      feeds.close();
    });
    layer = createServiceLayer({ services: installed.services, feeds, requester, logger });
  }
  const result = setupServiceTools({
    tools: installed.tools,
    services: layer,
    tasks,
    env,
    logger,
    report,
  });
  if (!result.ok) return { error: result.error, entries, lines };
  return {
    names: result.tools.map((t) => t.definition.name),
    services: installed.services.map((service) => service.definition.name),
    entries,
    lines,
  };
}

/** 现生成一对 Ed25519 密钥，私钥写到临时文件，返回文件路径 */
function ed25519KeyFile(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const file = join(tempDir(), 'qweather.pem');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return file;
}

describe('服务启动时装配插件与工具', () => {
  it('插件清单（没配和风天气）：工具还是 fetch 加任务的三个，和以前一样；和风天气不装，提示一行', () => {
    const { names, entries, lines } = assemble(plugins);

    expect(names).toEqual(['fetch', ...taskToolNames]);
    const missing = [
      'QWEATHER_API_HOST',
      'QWEATHER_DEVELOPER_ID',
      'QWEATHER_PROJECT_ID',
      'QWEATHER_KEY_ID',
      'QWEATHER_PRIVATE_KEY_FILE',
    ];
    expect(lines).toEqual([`服务 qweather 没有装上：缺少环境变量 ${missing.join('、')}`]);
    expect(entries).toEqual([
      { level: 'warn', msg: 'services.skipped', fields: { service: 'qweather', missing } },
      { level: 'info', msg: 'services.installed', fields: { services: [] } },
      { level: 'info', msg: 'tools.installed', fields: { tools: ['fetch', ...taskToolNames] } },
    ]);
  });

  it('插件清单（配好了和风天气）：装上 qweather；工具是 fetch、读文档与调服务、任务的三个', () => {
    const env = {
      QWEATHER_API_HOST: 'https://abc123.def.qweatherapi.com/',
      QWEATHER_DEVELOPER_ID: 'developer-id-1',
      QWEATHER_PROJECT_ID: 'project-id-1',
      QWEATHER_KEY_ID: 'key-id-0001',
      QWEATHER_PRIVATE_KEY_FILE: ed25519KeyFile(),
    };
    const { names, services, entries, lines } = assemble(plugins, env);

    expect(services).toEqual(['qweather']);
    expect(names).toEqual(['fetch', ...serviceToolNames, ...taskToolNames]);
    expect(lines).toEqual([]);
    expect(entries.map(({ msg, fields }) => [msg, fields])).toEqual([
      ['services.installed', { services: ['qweather'] }],
      ['tools.installed', { tools: ['fetch', ...serviceToolNames, ...taskToolNames] }],
    ]);
  });

  it('几个插件的工具按清单的先后排，插件里按插件自己的先后', () => {
    const { names } = assemble([
      definePlugin({ name: 'b', tools: [tool('b2'), tool('b1')] }),
      definePlugin({ name: 'a', tools: [tool('a1')] }),
    ]);

    expect(names).toEqual(['b2', 'b1', 'a1', ...taskToolNames]);
  });

  it('装上了服务时：插件的工具、读文档与调服务、任务的三个；没有服务的插件可以只有工具，没有工具的插件可以只有服务', () => {
    const { names, services } = assemble([
      definePlugin({ name: 'a', tools: [tool('a1')] }),
      definePlugin({ name: 'b', services: [fakeService({ name: 'one' })] }),
      definePlugin({ name: 'c', tools: [tool('c1')], services: [fakeService({ name: 'two' })] }),
    ]);

    expect(services).toEqual(['one', 'two']);
    expect(names).toEqual(['a1', 'c1', ...serviceToolNames, ...taskToolNames]);
  });

  it('插件名不合规、插件重名时返回错误信息（服务打到 stderr 后退出），不提示、不记 tools.installed', () => {
    const { error, entries, lines } = assemble([
      definePlugin({ name: 'Weather', tools: [tool('w')] }),
      definePlugin({ name: 'dup', tools: [tool('d1')] }),
      definePlugin({ name: '2x', tools: [] }),
      definePlugin({ name: 'dup', tools: [tool('d2')] }),
      definePlugin({ name: 'a-b', tools: [] }),
      definePlugin({ name: '', tools: [] }),
    ]);

    const rule = '名字只能用小写字母、数字和下划线，以字母开头';
    expect(error).toBe(
      `插件定义有误：Weather（${rule}）；dup（重名）；2x（${rule}）；a-b（${rule}）；（空）（${rule}）`,
    );
    expect(lines).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('工具的规则照旧：不同插件里的工具重名、和任务工具重名时报工具重名', () => {
    const { error } = assemble([
      definePlugin({ name: 'a', tools: [tool('same'), tool('list_tasks')] }),
      definePlugin({ name: 'b', tools: [tool('same')] }),
    ]);

    expect(error).toBe('工具定义有误：same（重名）；list_tasks（重名）');
  });

  it('插件的工具和读文档、调服务重名时也报工具重名', () => {
    const { error } = assemble([
      definePlugin({ name: 'a', tools: [tool('read_docs')], services: [fakeService()] }),
    ]);

    expect(error).toBe('工具定义有误：read_docs（重名）');
  });

  it('工具的规则照旧：缺环境变量的插件工具不装，提示一行，记 tools.skipped', () => {
    const { names, entries, lines } = assemble([
      definePlugin({ name: 'a', tools: [tool('needs_key', ['LUOLI_TEST_KEY']), tool('free')] }),
    ]);

    expect(names).toEqual(['free', ...taskToolNames]);
    expect(lines).toEqual(['工具 needs_key 没有装上：缺少环境变量 LUOLI_TEST_KEY']);
    expect(entries).toEqual([
      { level: 'info', msg: 'services.installed', fields: { services: [] } },
      {
        level: 'warn',
        msg: 'tools.skipped',
        fields: { tool: 'needs_key', missing: ['LUOLI_TEST_KEY'] },
      },
      { level: 'info', msg: 'tools.installed', fields: { tools: ['free', ...taskToolNames] } },
    ]);
  });
});

describe('装配服务', () => {
  it('缺环境变量（空字符串算缺）的服务不装：各提示一行，记 services.skipped（不记变量的值）', () => {
    const { names, services, entries, lines } = assemble(
      [
        definePlugin({
          name: 'p',
          services: [
            fakeService({ name: 'needs', env: ['LUOLI_TEST_A', 'LUOLI_TEST_B'] }),
            fakeService({ name: 'free' }),
          ],
        }),
      ],
      { LUOLI_TEST_A: '机密-值-7f1e', LUOLI_TEST_B: '' },
    );

    expect(services).toEqual(['free']);
    expect(names).toEqual(['read_docs', 'call_service', ...taskToolNames]);
    expect(lines).toEqual(['服务 needs 没有装上：缺少环境变量 LUOLI_TEST_B']);
    expect(entries.slice(0, 2)).toEqual([
      {
        level: 'warn',
        msg: 'services.skipped',
        fields: { service: 'needs', missing: ['LUOLI_TEST_B'] },
      },
      { level: 'info', msg: 'services.installed', fields: { services: ['free'] } },
    ]);
    expect(JSON.stringify([entries, lines])).not.toContain('机密');
  });

  it('声明有误时报错，一次把问题列全；不装任何东西', () => {
    const docs = fakeDocs('bad', ['ok_one', 'ok_two'], ['ok_two.md']);
    const { error, entries, lines } = assemble([
      definePlugin({
        name: 'p',
        services: [
          fakeService({
            name: 'Bad-Name',
            title: ' ',
            summary: '',
            env: ['lower-case', 'X', 'X'],
            baseUrl: 'ftp://example.com',
            auth: { type: 'header', header: 'Bad Header', env: 'NOT_LISTED' },
            endpoints: [
              { id: 'ok_one', title: '一', path: '/a/{x}/{x}', query: ['x', 'bad name', 'q', 'q'] },
              { id: 'ok_two', title: '二', path: 'no-slash', query: [] },
              { id: 'ok_two', title: '', path: '/a/../b', query: [] },
              { id: 'Bad', title: '坏', path: '/a/{1x}', query: [] },
              { id: 'half', title: '半', path: '/a/b{x}', query: [] },
            ],
            limits: {
              minIntervalSeconds: 0,
              maxRequestsPerDay: 1.5,
              maxRequestsPerDayEnv: 'bad env',
            },
            docs,
          }),
        ],
      }),
    ]);

    expect(lines).toEqual([]);
    expect(entries).toEqual([]);
    const problems = [
      '名字只能用小写字母、数字和下划线，以字母开头',
      '没有名称',
      '没有简介',
      '环境变量名 lower-case 不合规',
      '环境变量重复',
      '地址只能是 http 或 https',
      '认证的请求头名 Bad Header 不合规',
      '认证用的环境变量 NOT_LISTED 不在 env 里',
      '接口 ok_one 的路径参数重复',
      '接口 ok_one 的查询参数 x 和路径参数重名',
      '接口 ok_one 的查询参数名 bad name 不合规',
      '接口 ok_one 的查询参数重复',
      '接口 id ok_two 重复',
      '接口 ok_two 的路径 no-slash 写法不对（以 / 开头，路径参数单独占一段，写成 {名字}）',
      '接口 ok_two 没有名称',
      '接口 ok_two 的路径 /a/../b 写法不对（以 / 开头，路径参数单独占一段，写成 {名字}）',
      '接口 id Bad 只能用小写字母、数字和下划线，以字母开头',
      '接口 Bad 的路径 /a/{1x} 写法不对（以 / 开头，路径参数单独占一段，写成 {名字}）',
      '接口 half 的路径 /a/b{x} 写法不对（以 / 开头，路径参数单独占一段，写成 {名字}）',
      '最短间隔要是正整数（秒）',
      '每天的上限要是正整数',
      '每天上限的环境变量名 bad env 不合规',
      '缺文档 ok_two.md、half.md',
    ];
    expect(error).toBe(`服务定义有误：Bad-Name（${problems.join('，')}）`);
  });

  it('服务重名（不同插件里也算）、缺总说明时报错', () => {
    const { error } = assemble([
      definePlugin({ name: 'a', services: [fakeService({ name: 'same' })] }),
      definePlugin({
        name: 'b',
        services: [
          fakeService({ name: 'same' }),
          fakeService({
            name: 'other',
            docs: fakeDocs('other', ['item', 'search'], ['overview.md']),
          }),
        ],
      }),
    ]);

    expect(error).toBe('服务定义有误：same（重名）；other（缺文档 overview.md）');
  });

  it('配置有误时报错：说清是哪个服务的哪一项，不带变量的值；几个问题一起列出', () => {
    const env = { LUOLI_TEST_SECRET: 'secret-value-9a8b', LUOLI_TEST_LIMIT: '12abc' };
    const { error, entries } = assemble(
      [
        definePlugin({
          name: 'p',
          services: [
            fakeService({
              name: 'signed',
              env: ['LUOLI_TEST_SECRET'],
              auth: {
                type: 'custom',
                setup: (values) => {
                  throw new ServiceConfigError(
                    `LUOLI_TEST_SECRET 不对：${values.LUOLI_TEST_SECRET}`,
                  );
                },
              },
              limits: {
                minIntervalSeconds: 60,
                maxRequestsPerDay: 100,
                maxRequestsPerDayEnv: 'LUOLI_TEST_LIMIT',
              },
            }),
            fakeService({
              name: 'computed',
              env: ['LUOLI_TEST_SECRET'],
              baseUrl: (values) => `not a url ${values.LUOLI_TEST_SECRET}`,
            }),
            fakeService({
              name: 'broken',
              env: ['LUOLI_TEST_SECRET'],
              auth: {
                type: 'custom',
                setup: () => {
                  throw new Error('意外的错误 secret-value-9a8b');
                },
              },
            }),
          ],
        }),
      ],
      env,
    );

    expect(error).toBe(
      [
        '服务 signed 的配置有误：LUOLI_TEST_SECRET 不对：***',
        '服务 signed 的配置有误：LUOLI_TEST_LIMIT 要是正整数',
        '服务 computed 的配置有误：地址不是合法的网址',
        '服务 broken 的配置有误：认证的配置检查出错',
      ].join('\n'),
    );
    expect(error).not.toContain('secret-value');
    expect(entries.map(({ msg }) => msg)).not.toContain('services.installed');
  });

  it('每天的上限可以用环境变量改；不设、设成空的用声明里的', () => {
    const service = fakeService({
      limits: {
        minIntervalSeconds: 60,
        maxRequestsPerDay: 100,
        maxRequestsPerDayEnv: 'LUOLI_TEST_LIMIT',
      },
    });
    const limitOf = (env: Env) => {
      const { logger, report } = recording();
      const installed = installPlugins({
        plugins: [definePlugin({ name: 'p', services: [service] })],
        env,
        logger,
        report,
      });
      return installed.ok ? installed.services[0]!.maxRequestsPerDay : installed.error;
    };
    expect(limitOf({})).toBe(100);
    expect(limitOf({ LUOLI_TEST_LIMIT: '' })).toBe(100);
    expect(limitOf({ LUOLI_TEST_LIMIT: '20' })).toBe(20);
    expect(limitOf({ LUOLI_TEST_LIMIT: '0' })).toBe(
      '服务 demo 的配置有误：LUOLI_TEST_LIMIT 要是正整数',
    );
  });
});
