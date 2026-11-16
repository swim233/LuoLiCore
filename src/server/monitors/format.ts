import { isJsonNumber, stringifyJson, type JsonObject, type JsonValue } from '../services/json.js';
import type { MonitorDescription } from './describe.js';
import { lookup } from './items.js';
import { monitorLimits } from './rules.js';

// 条目写成文字（ADR-0014），事件和试跑都用：标题一行；show 的每个字段一行「路径: 值」。
// 值是字符串原样写，数字（原文的写法）、布尔值写成文字，对象和列表写成紧凑的 JSON，没有的写「（没有）」；
// 每个值最多 maxShownChars 个字，超出的截短并标出来

/** 一个值写成文字（没截短） */
function plain(value: JsonValue | undefined): string {
  if (value === undefined) return '（没有）';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (isJsonNumber(value)) return value.rawJSON;
  return stringifyJson(value);
}

/** 截短到 maxShownChars 个字，超出的标出来 */
function capped(text: string): string {
  const chars = [...text];
  if (chars.length <= monitorLimits.maxShownChars) return text;
  return `${chars.slice(0, monitorLimits.maxShownChars).join('')}…（共 ${chars.length} 字，后面截掉了）`;
}

/** 一条的标题：title 指到的值，写成一行（换行、连着的空白压成一个空格）；没有时写「（没有标题）」 */
export function titleOf(item: JsonObject, { title }: Pick<MonitorDescription, 'title'>): string {
  const value = lookup(item, title);
  if (value === undefined || value === null) return '（没有标题）';
  return capped(plain(value).replace(/\s+/g, ' ').trim()) || '（没有标题）';
}

/** 一条写成文字：标题一行，show 的每个字段一行「路径: 值」 */
export function itemText(
  item: JsonObject,
  monitor: Pick<MonitorDescription, 'title' | 'show'>,
): string {
  return [
    titleOf(item, monitor),
    ...monitor.show.map((path) => `${path}: ${capped(plain(lookup(item, path)))}`),
  ].join('\n');
}
