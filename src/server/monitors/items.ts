import { isJsonNumber, isJsonObject, type JsonObject, type JsonValue } from '../services/json.js';
import { monitorLimits } from './rules.js';

// 取条目（ADR-0014）：服务返回的数据（parseJson 解析的，数字保住原文的写法）按描述的 items 找到那个列表，
// 每条按 key 取出编号。路径一层一层用点连起来，只往对象里走

/** 一条：编号（key 的值；数字是它在原文里的写法）、这一条的数据、在列表里是第几条（从 1 数） */
export type MonitorItem = { key: string; data: JsonObject; position: number };

/** 路径分成一段一段；空字符串是整个值本身 */
export function segments(path: string): string[] {
  return path === '' ? [] : path.split('.');
}

/**
 * 按路径取值：一层一层往对象里走，任何一层不存在、不是对象就是 undefined。空的路径是 value 本身
 */
export function lookup(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of segments(path)) current = childOf(current, segment);
  return current;
}

/** 对象里的一个键；不是对象、没有这个键时 undefined */
function childOf(value: JsonValue | undefined, segment: string): JsonValue | undefined {
  if (!isJsonObject(value) || !Object.hasOwn(value, segment)) return undefined;
  return (value as JsonObject)[segment];
}

/** 值是什么：给说明用 */
export function kindOf(value: JsonValue | undefined): string {
  if (value === undefined) return '没有';
  if (value === null) return '空值（null）';
  if (typeof value === 'string') return '字符串';
  if (typeof value === 'boolean') return '布尔值';
  if (isJsonNumber(value)) return '数字';
  if (Array.isArray(value)) return '列表';
  return '对象';
}

/** 键的清单，最多列 30 个 */
function keysOf(object: JsonObject): string {
  const keys = Object.keys(object);
  if (keys.length === 0) return '（没有键）';
  const shown = keys.slice(0, 30).join('、');
  return keys.length > 30 ? `${shown} 等 ${keys.length} 个` : shown;
}

/** 截短给说明里引用的值 */
function quote(text: string, max = 50): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export type ItemsResult =
  { ok: true; items: MonitorItem[]; warnings: string[] } | { ok: false; error: string };

/**
 * 从返回的数据里取出条目：
 * - items 指到的那一段不存在（或是 null）：0 条，带一句提醒，列出走到的最后一层有哪些键；
 *   指到的不是列表：不通过；
 * - 一次最多处理 maxItems 条，多出来的不要（带提醒）；
 * - 每条要是对象，key 指到的值要是非空的字符串或数字，有一条不是就不通过，说出是第几条；
 * - 同一次返回里编号重复的只算第一条（带提醒）
 */
export function extractItems(
  data: JsonValue,
  { items: itemsPath, key }: { items: string; key: string },
): ItemsResult {
  const warnings: string[] = [];
  // 一层一层走，记着走到的最后一个对象：路径写错时列出它的键
  let current: JsonValue | undefined = data;
  let reached: { object: JsonObject; path: string } | undefined = isJsonObject(data)
    ? { object: data, path: '' }
    : undefined;
  const walked: string[] = [];
  for (const segment of segments(itemsPath)) {
    current = childOf(current, segment);
    if (current === undefined) break;
    walked.push(segment);
    if (isJsonObject(current)) reached = { object: current, path: walked.join('.') };
  }
  if (current === undefined || current === null) {
    const where = reached
      ? `${reached.path ? `那一层（${reached.path}）` : '返回的最外层'}有这些键：${keysOf(reached.object)}`
      : '返回的最外层不是对象';
    warnings.push(
      `items 写的「${itemsPath}」在返回里没有（或者是 null），当作 0 条。${where}。要是路径写错了，改 items`,
    );
    return { ok: true, items: [], warnings };
  }
  if (!Array.isArray(current)) {
    const keys = isJsonObject(current) ? `（这一层有这些键：${keysOf(current)}）` : '';
    const target = itemsPath === '' ? '返回本身' : `items 指到的「${itemsPath}」`;
    return {
      ok: false,
      error: `${target}不是列表，是${kindOf(current)}${keys}。items 要指到返回里那个列表`,
    };
  }

  let list: JsonValue[] = current;
  if (list.length > monitorLimits.maxItems) {
    warnings.push(
      `返回里有 ${list.length} 条，一次最多处理 ${monitorLimits.maxItems} 条，后面的 ${list.length - monitorLimits.maxItems} 条不要了`,
    );
    list = list.slice(0, monitorLimits.maxItems);
  }
  const items: MonitorItem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let firstDuplicate: string | undefined;
  for (const [index, entry] of list.entries()) {
    const position = index + 1;
    if (!isJsonObject(entry)) {
      return {
        ok: false,
        error: `第 ${position} 条不是对象，是${kindOf(entry)}。监视只能盯每一条都是对象的列表`,
      };
    }
    const value = lookup(entry, key);
    const text =
      typeof value === 'string' ? value : isJsonNumber(value) ? value.rawJSON : undefined;
    if (text === undefined || text.trim() === '') {
      const problem =
        value === undefined
          ? '没有这个字段'
          : text === undefined
            ? `是${kindOf(value)}，要是字符串或数字`
            : '是空的字符串';
      return {
        ok: false,
        error: `第 ${position} 条的 key（${key}）${problem}。key 要指到每一条里当编号用的字段`,
      };
    }
    if (seen.has(text)) {
      duplicates++;
      firstDuplicate ??= text;
      continue;
    }
    seen.add(text);
    items.push({ key: text, data: entry, position });
  }
  if (duplicates > 0) {
    warnings.push(
      `有 ${duplicates} 条的编号和前面的重复（如「${quote(firstDuplicate!)}」），只算第一次出现的那条。要是 key 选得不对（不是每条都不一样），换一个字段`,
    );
  }
  return { ok: true, items, warnings };
}

/**
 * 一条里有哪些字段（试跑时给她核对路径）：第一层的键；值是对象的再写出第二层（如 messageType.code）。
 * 值是列表的标「（列表）」，第二层还是对象的标「（对象）」
 */
export function fieldPaths(item: JsonObject): string[] {
  const mark = (path: string, value: JsonValue) =>
    Array.isArray(value) ? `${path}（列表）` : isJsonObject(value) ? `${path}（对象）` : path;
  return Object.entries(item).flatMap(([name, value]) => {
    if (!isJsonObject(value)) return [mark(name, value)];
    const inner = Object.entries(value);
    if (inner.length === 0) return [`${name}（空的对象）`];
    return inner.map(([child, childValue]) => mark(`${name}.${child}`, childValue));
  });
}
