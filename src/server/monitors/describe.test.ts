import { afterEach, describe, expect, it } from 'vitest';
import { closeAll } from '../../net/test-server.js';
import { fakeService } from '../services/test-services.js';
import { checkMonitor, type MonitorPurpose } from './describe.js';
import { monitorFields, monitorLimits, monitorOps } from './rules.js';
import { layerFor } from './test-monitors.js';

afterEach(closeAll);

// 两个服务：demo（最短间隔 60 秒；接口 item 有路径参数 id、查询参数 lang、q，search 有查询参数 q）、
// slow（最短间隔 90 秒，向上取整是 2 分钟）
function services() {
  return layerFor([
    fakeService(),
    fakeService({ name: 'slow', limits: { minIntervalSeconds: 90, maxRequestsPerDay: 10 } }),
  ]).layer;
}

const valid = {
  service: 'demo',
  endpoint: 'search',
  params: { q: '上海' },
  interval_minutes: 10,
  items: 'alerts',
  key: 'id',
  where: { field: 'messageType.code', op: 'in', value: ['alert', 'update'] },
  title: 'headline',
  show: ['headline', 'severity'],
  mode: 'reply',
};

function check(input: unknown, purpose: MonitorPurpose = 'task') {
  return checkMonitor(input, { services: services(), purpose });
}

/** 检查不过时的问题；通过了算测试失败 */
function problems(input: unknown, purpose: MonitorPurpose = 'task'): string[] {
  const result = check(input, purpose);
  if (result.ok) throw new Error('应当不通过');
  return result.problems;
}

/** 换掉 valid 里的几个字段（值是 undefined 的去掉） */
function changed(fields: Record<string, unknown>) {
  const input: Record<string, unknown> = { ...valid, ...fields };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) delete input[name];
  return input;
}

describe('描述的检查：字段', () => {
  it('合格的描述整理成只有认得的字段、按字段表的先后，是一份副本', () => {
    // mode 写在最前面：整理以后照字段表排
    const input: Record<string, unknown> = { mode: 'record', ...changed({ mode: undefined }) };
    const result = check(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.monitor)).toEqual(
      monitorFields.map(({ name }) => name).filter((name) => name in input),
    );
    expect(result.monitor).toEqual({ ...valid, mode: 'record' });
    (input.show as string[]).push('改过');
    expect(result.monitor.show).toEqual(['headline', 'severity']);
  });

  it('试跑时 interval_minutes、mode 可以不写，写了照样检查；建任务时必填', () => {
    const bare = changed({ interval_minutes: undefined, mode: undefined });
    expect(check(bare, 'try')).toMatchObject({ ok: true });
    expect(problems(bare, 'task')).toEqual([
      `缺少 interval_minutes（建任务时必填）：${monitorFields.find(({ name }) => name === 'interval_minutes')!.text}`,
      `缺少 mode（建任务时必填）：${monitorFields.find(({ name }) => name === 'mode')!.text}`,
    ]);
    expect(problems(changed({ interval_minutes: 0, mode: 'loud' }), 'try')).toEqual([
      'interval_minutes 不能短于 1 分钟（服务 demo 的最短间隔）',
      'mode 只能是 reply（触发你回复）或 record（只记录）',
    ]);
  });

  it('必填的字段缺了，每个都说出来，带上这个字段写什么', () => {
    const required = monitorFields.filter(({ required }) => required === 'yes');
    const found = problems({}, 'try');
    expect(found).toEqual(required.map(({ name, text }) => `缺少 ${name}：${text}`));
  });

  it('不是对象；有不认得的字段：说出能写哪些', () => {
    for (const input of [null, [], 'qweather', 3]) {
      expect(problems(input)).toEqual([
        'monitor 要写成一个对象，各字段的写法见 read_docs 的 monitor',
      ]);
    }
    expect(problems({ ...valid, item: 'alerts', interval: 5 })).toEqual([
      `monitor 里没有 item 这个字段（能写的：${monitorFields.map(({ name }) => name).join('、')}）`,
      `monitor 里没有 interval 这个字段（能写的：${monitorFields.map(({ name }) => name).join('、')}）`,
    ]);
  });

  it('服务、接口、参数交给服务层检查，说明同 call_service；不发请求', () => {
    expect(problems(changed({ service: 'nope' }))).toEqual([
      '没有这个服务：nope（有：demo、slow）',
    ]);
    expect(problems(changed({ endpoint: 'nope' }))).toEqual([
      '服务 demo 没有接口 nope（有：item、search）',
    ]);
    expect(problems(changed({ params: { city: '上海' } }))).toEqual([
      '参数 city 不认识。接口 search 能用的参数：q',
    ]);
    expect(problems(changed({ endpoint: 'item', params: { q: 'x' } }))).toEqual([
      '缺少路径参数 id。接口 item 能用的参数：id（路径参数，必填）、lang、q',
    ]);
    expect(problems(changed({ params: { q: { x: 1 } } }))).toEqual([
      '参数 q 的值只能是字符串、数字或布尔值',
    ]);
    expect(problems(changed({ params: 'q=1' }))[0]).toContain('参数要写成一个对象');
    expect(problems(changed({ service: 3, endpoint: [] }))).toEqual([
      'service 要是字符串：服务名',
      'endpoint 要是字符串：接口 id',
    ]);
    // 没写 params 也行
    expect(check(changed({ params: undefined }))).toMatchObject({ ok: true });
  });

  it('间隔：整数分钟，不能短于服务的最短间隔（向上取整到分钟），最长 7 天', () => {
    const max = monitorLimits.maxIntervalMinutes;
    expect(check(changed({ interval_minutes: 1 }))).toMatchObject({ ok: true });
    expect(check(changed({ interval_minutes: max }))).toMatchObject({ ok: true });
    expect(problems(changed({ interval_minutes: max + 1 }))).toEqual([
      `interval_minutes 最长 ${max}（7 天）`,
    ]);
    expect(problems(changed({ interval_minutes: 1.5 }))).toEqual([
      'interval_minutes 要是整数（分钟）',
    ]);
    expect(problems(changed({ interval_minutes: '10' }))).toEqual([
      'interval_minutes 要是整数（分钟）',
    ]);
    expect(problems(changed({ service: 'slow', interval_minutes: 1 }))).toEqual([
      'interval_minutes 不能短于 2 分钟（服务 slow 的最短间隔）',
    ]);
    expect(check(changed({ service: 'slow', interval_minutes: 2 }))).toMatchObject({ ok: true });
  });

  it('路径：items 可以是空字符串；别的不能空，每一段不能空，不写数组下标，不太长', () => {
    expect(check(changed({ items: '' }))).toMatchObject({ ok: true });
    expect(check(changed({ key: 'meta.id', title: 'a.b.c' }))).toMatchObject({ ok: true });
    expect(problems(changed({ key: '' }))).toEqual([
      'key 不能是空的：写一个路径，如 messageType.code',
    ]);
    expect(problems(changed({ items: 3 }))).toEqual([
      'items 要是字符串：返回里那个列表的路径，返回本身就是列表时写空字符串',
    ]);
    expect(problems(changed({ items: '.alerts', key: 'a..b', title: 'headline.' }))).toEqual([
      'items 写成了「.alerts」：每一段都不能是空的（不要以点开头或结尾，不要连着写两个点）',
      'key 写成了「a..b」：每一段都不能是空的（不要以点开头或结尾，不要连着写两个点）',
      'title 写成了「headline.」：每一段都不能是空的（不要以点开头或结尾，不要连着写两个点）',
    ]);
    expect(problems(changed({ items: 'data[0].alerts' }))).toEqual([
      'items 写成了「data[0].alerts」：路径不支持数组下标，只能一层一层往对象里走',
    ]);
    expect(problems(changed({ title: 'a'.repeat(monitorLimits.maxPathChars + 1) }))).toEqual([
      `title 太长：路径最多 ${monitorLimits.maxPathChars} 个字`,
    ]);
    expect(check(changed({ title: '长'.repeat(monitorLimits.maxPathChars) }))).toMatchObject({
      ok: true,
    });
    expect(problems(changed({ key: 7 }))).toEqual([
      'key 要是字符串：一个路径，如 messageType.code',
    ]);
  });

  it('show：1 到 12 个路径，不重复，每个都照路径的规矩', () => {
    const max = monitorLimits.maxShow;
    const many = Array.from({ length: max }, (_, index) => `f${index}`);
    expect(check(changed({ show: many }))).toMatchObject({ ok: true });
    for (const show of [[], [...many, 'more'], 'headline']) {
      expect(problems(changed({ show }))).toEqual([`show 要是 1 到 ${max} 个路径组成的数组`]);
    }
    expect(problems(changed({ show: ['a', '', 'b.', 'a'] }))).toEqual([
      'show[1] 不能是空的：写一个路径，如 messageType.code',
      'show[2] 写成了「b.」：每一段都不能是空的（不要以点开头或结尾，不要连着写两个点）',
      'show 里「a」写了不止一次',
    ]);
  });

  it('mode：reply、record；decide 还不支持', () => {
    expect(check(changed({ mode: 'record' }))).toMatchObject({ ok: true });
    expect(problems(changed({ mode: 'decide' }))).toEqual([
      'mode 写 decide（你自己决定）还不支持，现在只能写 reply（触发你回复）或 record（只记录）',
    ]);
  });
});

describe('描述的检查：条件', () => {
  const where = (condition: unknown) => problems(changed({ where: condition }));
  const fine = (condition: unknown) =>
    expect(check(changed({ where: condition }))).toMatchObject({ ok: true });

  it('每个比法都收；值是字符串、数字、布尔值，in 是它们的数组', () => {
    for (const { op } of monitorOps) {
      fine({ field: 'a', op, value: op === 'in' ? ['x', 2, true] : 'x' });
      if (op !== 'in') fine({ field: 'a', op, value: 3.5 });
    }
    fine({ field: 'a', op: 'eq', value: false });
    fine({ field: 'a', op: 'contains', value: true });
  });

  it('不认得的比法；缺 field、op、value；比较里多写了别的', () => {
    expect(where({ field: 'a', op: 'like', value: 'x' })).toEqual([
      `where.op 写成了「like」：比法只有 ${monitorOps.map(({ op }) => op).join('、')}`,
    ]);
    expect(where({ value: 'x', extra: 1 })).toEqual([
      'where 里没有 extra 这个字段：比较写 { field, op, value }，几个条件用 all、any 包起来',
      'where 缺少 field：要比的字段（路径）',
      `where 缺少 op：比法，${monitorOps.map(({ op }) => op).join('、')} 之一`,
    ]);
    expect(where({ field: 'a', op: 'eq' })).toEqual(['where 缺少 value']);
    expect(where({ field: 'a..b', op: 'eq', value: 1 })).toEqual([
      'where.field 写成了「a..b」：每一段都不能是空的（不要以点开头或结尾，不要连着写两个点）',
    ]);
  });

  it('值：类型不对、太长；in 要 1 到 50 个；只有 in 写数组；大小比较不收布尔值；contains 不收空字符串', () => {
    const maxIn = monitorLimits.maxInValues;
    for (const value of [null, { a: 1 }, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(where({ field: 'a', op: 'eq', value })).toEqual([
        'where.value 只能是字符串、数字或布尔值',
      ]);
    }
    expect(
      where({ field: 'a', op: 'eq', value: 'x'.repeat(monitorLimits.maxValueChars + 1) }),
    ).toEqual([`where.value 太长：字符串最多 ${monitorLimits.maxValueChars} 个字`]);
    fine({ field: 'a', op: 'in', value: Array.from({ length: maxIn }, (_, index) => index) });
    for (const value of [[], Array.from({ length: maxIn + 1 }, (_, index) => index), 'alert']) {
      expect(where({ field: 'a', op: 'in', value })).toEqual([
        `where.value：in 的 value 要是 1 到 ${maxIn} 个值组成的数组`,
      ]);
    }
    expect(where({ field: 'a', op: 'in', value: ['ok', null] })).toEqual([
      'where.value[1] 只能是字符串、数字或布尔值',
    ]);
    expect(where({ field: 'a', op: 'eq', value: ['x'] })).toEqual([
      'where.value 是数组：只有 in 的 value 写数组，eq 写一个值',
    ]);
    expect(where({ field: 'a', op: 'gte', value: true })).toEqual([
      'where.value：gte 要和数字或字符串比，不能是布尔值',
    ]);
    expect(where({ field: 'a', op: 'contains', value: '' })).toEqual([
      'where.value：contains 的 value 不能是空的',
    ]);
  });

  it('all、any：至少一个条件，不能和别的写在一起；位置写成 where.all[1].any[0]', () => {
    fine({
      all: [{ field: 'a', op: 'eq', value: 1 }, { any: [{ field: 'b', op: 'ne', value: 2 }] }],
    });
    expect(where({ all: [] })).toEqual(['where.all 要是数组，里面至少一个条件']);
    expect(where({ any: { field: 'a' } })).toEqual(['where.any 要是数组，里面至少一个条件']);
    expect(where({ all: [{ field: 'a', op: 'eq', value: 1 }], any: [] })).toEqual([
      'where 里 all、any 只能写一个，不能和别的写在一起',
    ]);
    expect(
      where({
        all: [
          { field: 'a', op: 'eq', value: 1 },
          { any: [{ field: 'b', op: 'xx', value: 2 }, 'c'] },
        ],
      }),
    ).toEqual([
      `where.all[1].any[0].op 写成了「xx」：比法只有 ${monitorOps.map(({ op }) => op).join('、')}`,
      'where.all[1].any[1] 要是一个对象：比较写 { field, op, value }，几个条件用 { all: [...] } 或 { any: [...] } 包起来',
    ]);
    expect(where('a = 1')[0]).toContain('where 要是一个对象');
  });

  it('最多套 4 层、比较最多 20 个，到上限的照收', () => {
    const comparison = { field: 'a', op: 'eq', value: 1 };
    const nest = (layers: number): unknown =>
      layers === 0 ? comparison : { [layers % 2 ? 'all' : 'any']: [nest(layers - 1)] };
    fine(nest(monitorLimits.maxDepth));
    expect(where(nest(monitorLimits.maxDepth + 1))).toEqual([
      `where 套得太深：all、any 最多套 ${monitorLimits.maxDepth} 层`,
    ]);

    const max = monitorLimits.maxComparisons;
    fine({ any: Array.from({ length: max }, () => comparison) });
    expect(
      where({ all: [comparison, { any: Array.from({ length: max }, () => comparison) }] }),
    ).toEqual([`where 里的比较太多：最多 ${max} 个，现在有 ${max + 1} 个`]);
  });
});
