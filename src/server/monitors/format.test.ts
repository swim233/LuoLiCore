import { describe, expect, it } from 'vitest';
import { parseJson, type JsonObject } from '../services/json.js';
import { itemText, titleOf } from './format.js';
import { monitorLimits } from './rules.js';

const item = parseJson(
  '{"headline":"上海中心气象台发布\\n大风  蓝色预警","severity":"minor","id":202611161600008896177761,"price":1.10,' +
    '"urgent":false,"none":null,"color":{"code":"blue","name":"蓝色"},"supersedes":["a",2],"description":"第一段\\n第二段"}',
) as JsonObject;

describe('条目写成文字', () => {
  it('标题一行，show 的每个字段一行「路径: 值」：字符串原样，数字照原文，布尔值、null 写成文字，对象和列表是紧凑的 JSON，没有的写「（没有）」', () => {
    const show = [
      'severity',
      'id',
      'price',
      'urgent',
      'none',
      'color',
      'supersedes',
      'color.name',
      'missing',
      'description',
    ];
    expect(itemText(item, { title: 'headline', show })).toBe(
      [
        '上海中心气象台发布 大风 蓝色预警',
        'severity: minor',
        'id: 202611161600008896177761',
        'price: 1.10',
        'urgent: false',
        'none: null',
        'color: {"code":"blue","name":"蓝色"}',
        'supersedes: ["a",2]',
        'color.name: 蓝色',
        'missing: （没有）',
        'description: 第一段\n第二段',
      ].join('\n'),
    );
  });

  it('标题没有、是 null、是空白时写「（没有标题）」；标题是数字、对象时写成文字', () => {
    expect(titleOf(item, { title: 'missing' })).toBe('（没有标题）');
    expect(titleOf(item, { title: 'none' })).toBe('（没有标题）');
    expect(titleOf(parseJson('{"t":" \\n "}') as JsonObject, { title: 't' })).toBe('（没有标题）');
    expect(titleOf(item, { title: 'id' })).toBe('202611161600008896177761');
    expect(titleOf(item, { title: 'color' })).toBe('{"code":"blue","name":"蓝色"}');
  });

  it(`每个值最多 ${monitorLimits.maxShownChars} 个字，超出的截短并标出来；标题也是`, () => {
    const max = monitorLimits.maxShownChars;
    const long = parseJson(
      JSON.stringify({ t: '题'.repeat(max + 5), d: '字'.repeat(max), e: '多'.repeat(max + 1) }),
    ) as JsonObject;
    const [title, d, e] = itemText(long, { title: 't', show: ['d', 'e'] }).split('\n');
    expect(title).toBe(`${'题'.repeat(max)}…（共 ${max + 5} 字，后面截掉了）`);
    expect(d).toBe(`d: ${'字'.repeat(max)}`);
    expect(e).toBe(`e: ${'多'.repeat(max)}…（共 ${max + 1} 字，后面截掉了）`);
  });
});
