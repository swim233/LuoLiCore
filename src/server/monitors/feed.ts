import type { FeedItem, FeedsDb } from '../feeds-db.js';
import { isJsonObject, parseJson, type JsonObject } from '../services/json.js';
import { maxResultChars, resultNotice } from '../services/tools.js';
import { formatLocal } from '../tasks/schedule.js';
import type { MonitorDescription } from './describe.js';
import { sourceSpec } from './engine.js';
import { itemText } from './format.js';
import { matches } from './where.js';

// 查动态（ADR-0014，read_feed 工具）：翻看一个监听任务的来源存下来的条目，由新到旧，按任务现在的
// where 过滤，每条照任务现在的 title、show 写成文字。只读 feeds.db，不发请求

/** 查动态的几道上限；测试里可以换小 */
export type FeedLimits = {
  /** 整个结果最多几个字（同 call_service） */
  maxChars: number;
  /** 一次最多往前翻几条动态（有 where 时可能翻很多条才凑够） */
  maxScan: number;
  /** 读库时一批读几条 */
  batch: number;
};

export const feedLimits: FeedLimits = { maxChars: maxResultChars, maxScan: 2000, batch: 200 };

/** 返回几条：最多、默认 */
export const maxFeedItems = 20;
export const defaultFeedItems = 10;

/** 存的时候截掉了、解析不出来的条目写成这一句 */
const unreadable = '（此条目过长，保存时已截断，无法显示）';

/** 一条动态的数据；截掉了、解析不出来时没有 */
function dataOf(item: FeedItem): JsonObject | undefined {
  if (item.truncated) return undefined;
  try {
    const value = parseJson(item.data);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 一条写成结果里的一段：序号、什么时候存的，然后是条目的文字 */
function entryText(item: FeedItem, monitor: MonitorDescription): string {
  const data = dataOf(item);
  const head = `序号 ${item.id}（${formatLocal(new Date(item.firstSeenAt))} 获取）：`;
  return `${head}\n${data ? itemText(data, monitor) : unreadable}`;
}

const charsOf = (text: string) => [...text].length;

/**
 * 查动态的结果（给模型看的文字）。ref 是任务的 id（如 t7），monitor 是任务现在的描述；limit 是要几条，
 * before 给了时只看序号（动态的 id）小于它的。
 * - 来源按描述认，只找不建；来源不存在、一条都没存时只有一句。
 * - 由新到旧分批往前翻（一批 limits.batch 条），截掉的条目算符合；凑够 limit 条、翻到头、
 *   或者翻满 limits.maxScan 条时停下。
 * - 整个结果最多 limits.maxChars 个字：下一条放不下就停在上一条（第一条照样给出）。
 * - 结尾一行说还有没有更早的、该怎么接着看
 */
export function feedText(
  feeds: FeedsDb | undefined,
  {
    ref,
    monitor,
    limit = defaultFeedItems,
    before,
    limits = feedLimits,
  }: {
    ref: string;
    monitor: MonitorDescription;
    limit?: number;
    before?: number;
    limits?: FeedLimits;
  },
): string {
  const source = feeds?.findSource(sourceSpec(monitor));
  const total = source ? feeds!.itemCount(source.id) : 0;
  if (!source || total === 0) return `监听任务 ${ref} 尚未保存任何条目。`;
  const filtered = monitor.where !== undefined;

  // 往前翻：凑够 limit 条、翻到头、翻满 maxScan 条时停
  const found: FeedItem[] = [];
  let scanned = 0;
  let lastScanned: number | undefined;
  let exhausted = false;
  let upper = before;
  scan: while (found.length < limit) {
    const take = Math.min(limits.batch, limits.maxScan - scanned);
    if (take <= 0) break;
    const rows = feeds!.itemsBefore(source.id, upper, take);
    for (const row of rows) {
      scanned++;
      lastScanned = row.id;
      const data = dataOf(row);
      // 截掉的、解析不出来的算符合
      if (!data || matches(data, monitor.where)) {
        found.push(row);
        if (found.length >= limit) break scan;
      }
    }
    if (rows.length < take) {
      exhausted = true;
      break;
    }
    upper = rows.at(-1)!.id;
  }
  // 翻满了 maxScan 条正好到头：看一眼还有没有更早的
  if (!exhausted && found.length < limit && lastScanned !== undefined) {
    exhausted = feeds!.itemsBefore(source.id, lastScanned, 1).length === 0;
  }
  /** 序号小于 id 的还有没有 */
  const olderThan = (id: number) => feeds!.itemsBefore(source.id, id, 1).length > 0;

  if (found.length === 0) {
    if (!exhausted) {
      return `监听任务 ${ref} 已保存 ${total} 条，已检索至序号 ${lastScanned}，尚未找到符合监听范围的条目。更早的条目：before 填 ${lastScanned}。`;
    }
    if (before !== undefined) {
      return filtered
        ? `监听任务 ${ref} 没有序号小于 ${before} 且符合监听范围的条目。`
        : `监听任务 ${ref} 没有序号小于 ${before} 的条目。`;
    }
    return `监听任务 ${ref} 已保存 ${total} 条，其中没有符合监听范围的条目。`;
  }

  const entries = found.map((item) => entryText(item, monitor));
  /** 给出前 count 条时的整个结果 */
  const compose = (count: number) => {
    const shown = found.slice(0, count);
    const lastShown = shown.at(-1)!.id;
    const range = !filtered
      ? before === undefined
        ? `以下为最新的 ${count} 条，由新到旧。`
        : `以下为序号小于 ${before} 的 ${count} 条，由新到旧。`
      : before === undefined
        ? `以下 ${count} 条符合监听范围，由新到旧。`
        : `以下 ${count} 条符合监听范围、序号小于 ${before}，由新到旧。`;
    let ending: string;
    if (count < found.length || (found.length >= limit && olderThan(lastShown))) {
      ending = `更早的条目：before 填 ${lastShown}。`;
    } else if (!exhausted && found.length < limit) {
      ending = `已检索至序号 ${lastScanned}，尚未检索完。更早的条目：before 填 ${lastScanned}。`;
    } else {
      ending = '没有更早的条目。';
    }
    return [
      resultNotice,
      `监听任务 ${ref} 已保存 ${total} 条。${range}`,
      '---',
      entries.slice(0, count).join('\n\n'),
      '---',
      ending,
    ].join('\n');
  };
  // 放得下几条就给几条；第一条自己就超了也照样给出
  let count = 1;
  let text = compose(1);
  while (count < found.length) {
    const next = compose(count + 1);
    if (charsOf(next) > limits.maxChars) break;
    count++;
    text = next;
  }
  return text;
}
