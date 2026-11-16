import { describe, expect, it } from 'vitest';
import { isJsonNumber, isJsonObject, parseJson, stringifyJson } from './json.js';
import { normalizeJson } from './redact.js';

describe('不让数字走样的 JSON', () => {
  const text =
    '{"id":9007199254740993,"price":1.10,"e":1e2,"neg":-0.0,"list":[202611161600008896177761,2.50],"s":"9007199254740993","ok":true,"none":null}';

  it('解析再序列化：大整数、1.10、1e2、-0.0 都照原文写回去；字符串、布尔值、null 照旧', () => {
    expect(stringifyJson(parseJson(text))).toBe(text);
    // 普通的 JSON.parse 会走样
    expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
  });

  it('解析出来的数字带着原文的写法；对象、数字分得开', () => {
    const value = parseJson(text) as Record<string, unknown>;
    expect(isJsonNumber(value.id)).toBe(true);
    expect((value.id as { rawJSON: string }).rawJSON).toBe('9007199254740993');
    expect((value.price as { rawJSON: string }).rawJSON).toBe('1.10');
    expect(isJsonObject(value)).toBe(true);
    expect(isJsonObject(value.id)).toBe(false);
    expect(isJsonObject(value.list)).toBe(false);
    expect(isJsonObject(value.none)).toBe(false);
    expect(isJsonNumber(value.s)).toBe(false);
  });

  it('排版：数字照原文，缩进照给的空格数', () => {
    expect(stringifyJson(parseJson('{"a":[1.10, 2]}'), 2)).toBe(
      '{\n  "a": [\n    1.10,\n    2\n  ]\n}',
    );
  });

  it('不是 JSON 时抛错', () => {
    expect(() => parseJson('{"a":')).toThrow(SyntaxError);
  });

  it('服务层规整 JSON 时数字不走样：大整数不会变成别的数，1.10 不会变成 1.1', () => {
    expect(normalizeJson('{"id": 9007199254740993, "v": 1.10}', 2)).toEqual({
      text: '{\n  "id": 9007199254740993,\n  "v": 1.10\n}',
      json: true,
    });
    expect(normalizeJson('[1.10,{"x":12345678901234567890}]').text).toBe(
      '[1.10,{"x":12345678901234567890}]',
    );
  });
});
