import { isJsonNumber, type JsonObject, type JsonValue } from '../services/json.js';
import type { Comparison, Condition, Scalar } from './describe.js';
import { lookup } from './items.js';

// 条件的计算（ADR-0014）：一条（parseJson 解析的，数字保住原文的写法）符不符合描述的 where。
// 比法的规则写在 rules.ts 的比法表里（元文档里的 {{ops}} 也从那里来），这里照着算

/** 一条符不符合条件；没写条件时都符合 */
export function matches(item: JsonObject, condition: Condition | undefined): boolean {
  if (condition === undefined) return true;
  if ('all' in condition) return condition.all.every((child) => matches(item, child));
  if ('any' in condition) return condition.any.some((child) => matches(item, child));
  return compare(lookup(item, condition.field), condition);
}

/** 字段的值当文字：字符串原样，数字是原文的写法，布尔值是 true、false；别的（没有、null、对象、列表）没有 */
function textOf(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (isJsonNumber(value)) return value.rawJSON;
  return undefined;
}

/** 条件里的值当文字 */
const scalarText = (value: Scalar) => String(value);

/** 写得像一个数字（JSON 的数字，前面可以有 +，小数点两边可以省一边） */
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const integer = /^[+-]?\d+$/;

/** 两段文字都能当成有限的数字时比大小（-1、0、1）；整数用 BigInt 比，大整数不走样。不能时 undefined */
function compareNumbers(a: string, b: string): number | undefined {
  if (!numeric.test(a) || !numeric.test(b)) return undefined;
  if (integer.test(a) && integer.test(b)) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const [x, y] = [Number(a), Number(b)];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return x < y ? -1 : x > y ? 1 : 0;
}

function equals(field: JsonValue | undefined, value: Scalar): boolean {
  const text = textOf(field);
  return text !== undefined && text === scalarText(value);
}

function compare(field: JsonValue | undefined, { op, value }: Comparison): boolean {
  switch (op) {
    case 'eq':
      return equals(field, value as Scalar);
    case 'ne':
      return !equals(field, value as Scalar);
    case 'in':
      return (value as Scalar[]).some((candidate) => equals(field, candidate));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const order = orderOf(field, value as Scalar);
      if (order === undefined) return false;
      if (op === 'gt') return order > 0;
      if (op === 'gte') return order >= 0;
      if (op === 'lt') return order < 0;
      return order <= 0;
    }
    case 'contains': {
      if (typeof field === 'string') {
        return field.toLowerCase().includes(scalarText(value as Scalar).toLowerCase());
      }
      if (Array.isArray(field)) return field.some((element) => equals(element, value as Scalar));
      return false;
    }
  }
}

/**
 * 字段和值的先后：两边都能当成数字时按数字比；不然两边都是字符串时按字典序比；别的情况 undefined
 */
function orderOf(field: JsonValue | undefined, value: Scalar): number | undefined {
  const text = textOf(field);
  if (text === undefined || typeof value === 'boolean') return undefined;
  if (typeof field !== 'boolean') {
    const byNumber = compareNumbers(text, scalarText(value));
    if (byNumber !== undefined) return byNumber;
  }
  if (typeof field === 'string' && typeof value === 'string') {
    return field < value ? -1 : field > value ? 1 : 0;
  }
  return undefined;
}
