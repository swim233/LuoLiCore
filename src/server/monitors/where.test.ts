import { describe, expect, it } from 'vitest';
import { parseJson, type JsonObject } from '../services/json.js';
import type { Condition, Scalar } from './describe.js';
import type { MonitorOp } from './rules.js';
import { matches } from './where.js';

// 一条（JSON 原文写，数字保住原文的写法）：各种类型的字段
const item = parseJson(
  '{"code":"alert","num":200,"numText":"200","big":9007199254740993,"price":1.10,"flag":true,"none":null,' +
    '"obj":{"a":1},"tags":["Red",3,true],"text":"Heavy Rain Warning","time":"2026-11-16T10:00+08:00",' +
    '"temp":"12","neg":-5,"color":{"code":"orange"}}',
) as JsonObject;

const is = (field: string, op: MonitorOp, value: Scalar | Scalar[]) =>
  matches(item, { field, op, value });

describe('条件的计算：比法', () => {
  it('eq、ne：按文字比，数字和写成字符串的数字一样；分大小写；没有字段时 eq 不成立、ne 成立', () => {
    expect(is('code', 'eq', 'alert')).toBe(true);
    expect(is('code', 'eq', 'Alert')).toBe(false);
    expect(is('num', 'eq', '200')).toBe(true);
    expect(is('numText', 'eq', 200)).toBe(true);
    expect(is('flag', 'eq', true)).toBe(true);
    expect(is('flag', 'eq', 'true')).toBe(true);
    expect(is('price', 'eq', '1.10')).toBe(true);
    // 按文字比：1.10 和 1.1 不一样
    expect(is('price', 'eq', 1.1)).toBe(false);
    expect(is('big', 'eq', '9007199254740993')).toBe(true);
    expect(is('big', 'eq', '9007199254740992')).toBe(false);
    expect(is('color.code', 'eq', 'orange')).toBe(true);
    for (const field of ['missing', 'none', 'obj', 'tags']) {
      expect(is(field, 'eq', 'x')).toBe(false);
      expect(is(field, 'ne', 'x')).toBe(true);
    }
    expect(is('code', 'ne', 'alert')).toBe(false);
    expect(is('code', 'ne', 'update')).toBe(true);
  });

  it('in：和其中任何一个 eq 就成立', () => {
    expect(is('code', 'in', ['update', 'alert'])).toBe(true);
    expect(is('code', 'in', ['update', 'cancel'])).toBe(false);
    expect(is('num', 'in', [100, '200'])).toBe(true);
    expect(is('missing', 'in', ['x'])).toBe(false);
  });

  it('gt、gte、lt、lte：两边都能当成数字时按数字比（含写成字符串的数字、大整数）', () => {
    expect(is('num', 'gt', 100)).toBe(true);
    expect(is('num', 'gt', 200)).toBe(false);
    expect(is('num', 'gte', 200)).toBe(true);
    expect(is('num', 'lt', '1000')).toBe(true);
    // 按数字比，不是按字典序（"12" > "9" 按字典序不成立）
    expect(is('temp', 'gt', 9)).toBe(true);
    expect(is('temp', 'gt', '9')).toBe(true);
    expect(is('temp', 'lte', '12.0')).toBe(true);
    expect(is('neg', 'lt', 0)).toBe(true);
    expect(is('price', 'gt', 1.09)).toBe(true);
    expect(is('big', 'gt', '9007199254740992')).toBe(true);
    expect(is('big', 'lt', '9007199254740994')).toBe(true);
  });

  it('gt 那几个：不都是数字时，两边都是字符串按字典序比；别的情况不成立', () => {
    expect(is('time', 'gt', '2026-11-16T09:00+08:00')).toBe(true);
    expect(is('time', 'lt', '2026-11-16T09:00+08:00')).toBe(false);
    expect(is('code', 'gte', 'alert')).toBe(true);
    expect(is('code', 'lt', 'b')).toBe(true);
    // 字段是数字、值是不像数字的字符串：不成立
    expect(is('num', 'gt', 'abc')).toBe(false);
    expect(is('num', 'lt', 'abc')).toBe(false);
    // 布尔值、对象、列表、没有、null：都不成立
    for (const field of ['flag', 'obj', 'tags', 'missing', 'none']) {
      for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
        expect(is(field, op, 'a')).toBe(false);
        expect(is(field, op, 1)).toBe(false);
      }
    }
  });

  it('contains：字符串里有这段字（不分大小写）；列表里有一个元素和它 eq；别的不成立', () => {
    expect(is('text', 'contains', 'rain')).toBe(true);
    expect(is('text', 'contains', 'HEAVY RAIN')).toBe(true);
    expect(is('text', 'contains', 'snow')).toBe(false);
    expect(is('numText', 'contains', 0)).toBe(true);
    expect(is('tags', 'contains', 'Red')).toBe(true);
    // 列表里按 eq：分大小写，不找一段
    expect(is('tags', 'contains', 'red')).toBe(false);
    expect(is('tags', 'contains', 'Re')).toBe(false);
    expect(is('tags', 'contains', '3')).toBe(true);
    expect(is('tags', 'contains', true)).toBe(true);
    for (const field of ['num', 'flag', 'obj', 'missing', 'none']) {
      expect(is(field, 'contains', '2')).toBe(false);
    }
  });
});

describe('条件的计算：all、any', () => {
  const yes: Condition = { field: 'code', op: 'eq', value: 'alert' };
  const no: Condition = { field: 'code', op: 'eq', value: 'cancel' };

  it('all 都要满足，any 满足一个就行；可以互相套；没写条件时都符合', () => {
    expect(matches(item, { all: [yes, yes] })).toBe(true);
    expect(matches(item, { all: [yes, no] })).toBe(false);
    expect(matches(item, { any: [no, yes] })).toBe(true);
    expect(matches(item, { any: [no, no] })).toBe(false);
    expect(matches(item, { all: [yes, { any: [no, { all: [yes] }] }] })).toBe(true);
    expect(matches(item, { any: [{ all: [yes, no] }, { all: [no] }] })).toBe(false);
    expect(matches(item, undefined)).toBe(true);
  });

  it('元文档的例子：新发布的和更新的橙色、红色预警', () => {
    const where: Condition = {
      all: [
        { field: 'messageType.code', op: 'in', value: ['alert', 'update'] },
        { field: 'color.code', op: 'in', value: ['orange', 'red'] },
      ],
    };
    const alert = (type: string, color: string) =>
      parseJson(
        JSON.stringify({ messageType: { code: type }, color: { code: color } }),
      ) as JsonObject;
    expect(matches(alert('alert', 'orange'), where)).toBe(true);
    expect(matches(alert('update', 'red'), where)).toBe(true);
    expect(matches(alert('cancel', 'red'), where)).toBe(false);
    expect(matches(alert('alert', 'blue'), where)).toBe(false);
  });
});
