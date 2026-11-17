import { describe, expect, it } from 'vitest';
import { parseJson } from '../services/json.js';
import { extractItems, fieldPaths, lookup } from './items.js';
import { monitorLimits } from './rules.js';

/** 从 JSON 原文取条目 */
const extract = (text: string, items: string, key = 'id') =>
  extractItems(parseJson(text), { items, key });

/** 取到的条目：编号与第几条 */
function keys(text: string, items: string, key = 'id') {
  const result = extract(text, items, key);
  if (!result.ok) throw new Error(result.error);
  return {
    keys: result.items.map(({ key, position }) => [key, position]),
    warnings: result.warnings,
  };
}

/** 不通过时的说明 */
function failure(text: string, items: string, key = 'id'): string {
  const result = extract(text, items, key);
  if (result.ok) throw new Error('应当不通过');
  return result.error;
}

describe('按路径取值', () => {
  const data = parseJson('{"a":{"b":{"c":1.10}},"list":[{"x":1}],"s":"str","n":null}');

  it('一层一层往对象里走；空的路径是整个值', () => {
    expect(lookup(data, 'a.b.c')).toEqual(parseJson('1.10'));
    expect(lookup(data, '')).toBe(data);
    expect(lookup(data, 'n')).toBeNull();
  });

  it('任何一层不存在、不是对象就是没有；不往列表里走，不走进数字', () => {
    expect(lookup(data, 'a.x.c')).toBeUndefined();
    expect(lookup(data, 's.length')).toBeUndefined();
    expect(lookup(data, 'list.0')).toBeUndefined();
    expect(lookup(data, 'list.0.x')).toBeUndefined();
    expect(lookup(data, 'a.b.c.rawJSON')).toBeUndefined();
    expect(lookup(data, 'toString')).toBeUndefined();
    expect(lookup(data, 'a.constructor')).toBeUndefined();
  });
});

describe('取条目', () => {
  it('列表在返回里、返回数据本身是列表：编号是字符串或数字，数字按原文的写法；记下是第几条', () => {
    expect(keys('{"data":{"alerts":[{"id":"a1"},{"id":7}]}}', 'data.alerts').keys).toEqual([
      ['a1', 1],
      ['7', 2],
    ]);
    expect(keys('[{"meta":{"id":1.10}},{"meta":{"id":1.1}}]', '', 'meta.id').keys).toEqual([
      ['1.10', 1],
      ['1.1', 2],
    ]);
  });

  it('数字不走样：超过安全整数的编号照原文，两个只差 1 的大整数是两条', () => {
    const result = keys('{"alerts":[{"id":9007199254740993},{"id":9007199254740992}]}', 'alerts');
    expect(result.keys).toEqual([
      ['9007199254740993', 1],
      ['9007199254740992', 2],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('条目留着原来的数据（数字保住原文）', () => {
    const result = extract('{"alerts":[{"id":"x","price":1.10,"tags":["a"]}]}', 'alerts');
    expect(result.ok && JSON.stringify(result.items[0]!.data)).toBe(
      '{"id":"x","price":1.10,"tags":["a"]}',
    );
  });

  it('空的列表：0 条，没有提醒', () => {
    expect(keys('{"alerts":[],"metadata":{"zeroResult":true}}', 'alerts')).toEqual({
      keys: [],
      warnings: [],
    });
  });

  it('items 指到的那一段没有、是 null：0 条，提醒里列出走到的最后一层有哪些键', () => {
    expect(keys('{"code":"200","warning":{"list":[]}}', 'alerts')).toEqual({
      keys: [],
      warnings: [
        'items 填的「alerts」在返回数据中不存在（或为 null），按 0 条处理。返回数据的最外层包含这些键：code、warning。若路径有误，请修改 items',
      ],
    });
    expect(keys('{"data":{"items":null,"total":0}}', 'data.items').warnings).toEqual([
      'items 填的「data.items」在返回数据中不存在（或为 null），按 0 条处理。该层（data）包含这些键：items、total。若路径有误，请修改 items',
    ]);
    expect(keys('{"data":{"page":{}}}', 'data.page.list.x').warnings[0]).toContain(
      '该层（data.page）包含这些键：（无键）',
    );
    expect(keys('"text"', 'alerts').warnings[0]).toContain('返回数据的最外层不是对象');
  });

  it('items 指到的不是列表：不通过，说是什么；是对象时列出键', () => {
    expect(failure('{"alerts":{"a":1,"b":2}}', 'alerts')).toBe(
      'items 指向的「alerts」不是列表，是对象（此层包含这些键：a、b）。items 须指向返回数据中的条目列表',
    );
    expect(failure('{"alerts":"none"}', 'alerts')).toBe(
      'items 指向的「alerts」不是列表，是字符串。items 须指向返回数据中的条目列表',
    );
    expect(failure('{"alerts":[]}', '')).toBe(
      '返回数据本身不是列表，是对象（此层包含这些键：alerts）。items 须指向返回数据中的条目列表',
    );
  });

  it('有一条不是对象、key 没有或不是字符串和数字、是空的：不通过，说出是第几条', () => {
    expect(failure('[{"id":"a"},"b"]', '')).toBe(
      '第 2 条不是对象，是字符串。监听任务仅支持每个条目都是对象的列表',
    );
    expect(failure('[{"id":"a"},{"name":"b"}]', '')).toBe(
      '第 2 条的 key（id）字段不存在。key 须指向每个条目中用作编号的字段',
    );
    expect(failure('[{"id":{"v":1}}]', '')).toBe(
      '第 1 条的 key（id）是对象，须为字符串或数字。key 须指向每个条目中用作编号的字段',
    );
    expect(failure('[{"id":true}]', '')).toContain('是布尔值，须为字符串或数字');
    expect(failure('[{"id":null}]', '')).toContain('是空值（null），须为字符串或数字');
    expect(failure('[{"id":"  "}]', '')).toBe(
      '第 1 条的 key（id）是空字符串。key 须指向每个条目中用作编号的字段',
    );
  });

  it('同一次返回里编号重复：只算第一次出现的那条，带一句提醒', () => {
    expect(keys('[{"id":"a"},{"id":"b"},{"id":"a"},{"id":"b"}]', '')).toEqual({
      keys: [
        ['a', 1],
        ['b', 2],
      ],
      warnings: [
        '有 2 条的编号与前面的条目重复（如「a」），仅保留首次出现的那条。若 key 选择不当（并非每条都不同），请更换字段',
      ],
    });
  });

  it(`一次最多处理 ${monitorLimits.maxItems} 条，多出来的不要，带一句提醒；多出来的里有毛病也不管`, () => {
    const max = monitorLimits.maxItems;
    const list = [...Array.from({ length: max + 2 }, (_, index) => ({ id: index })), 'bad'];
    const result = keys(JSON.stringify(list), '');
    expect(result.keys).toHaveLength(max);
    expect(result.keys.at(-1)).toEqual([String(max - 1), max]);
    expect(result.warnings).toEqual([
      `返回数据共 ${max + 3} 条，每次最多处理 ${max} 条，其后的 3 条已丢弃`,
    ]);
  });
});

describe('一条里有哪些字段', () => {
  it('第一层的键，值是对象的写出第二层；列表、更深的对象标出来', () => {
    const item = parseJson(
      '{"id":"1","messageType":{"code":"alert","supersedes":[]},"color":{"code":"red","meta":{"a":1}},"tags":["x"],"empty":{},"n":null}',
    ) as Parameters<typeof fieldPaths>[0];
    expect(fieldPaths(item)).toEqual([
      'id',
      'messageType.code',
      'messageType.supersedes（列表）',
      'color.code',
      'color.meta（对象）',
      'tags（列表）',
      'empty（空对象）',
      'n',
    ]);
  });
});
