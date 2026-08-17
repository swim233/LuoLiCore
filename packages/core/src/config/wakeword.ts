/**
 * 唤醒词的可用性判定。运行时匹配（telegram/trigger.ts）与写入端校验（WebUI）必须共用这一份：
 * 分成两份实现会漂移，面板收下一个运行时永远匹配不上的模式，用户只能看到「bot 不理我」。
 */
import { RE2 } from 're2-wasm';

/** 正则只对消息开头这一段求值；匹配由 RE2 保证线性时间。 */
export const WAKEWORD_SCAN_LIMIT = 4096;

export type WakewordKind = 'contains' | 'regex';
export type WakewordCheck =
  | { ok: true; kind: 'contains'; folded: string }
  | { ok: true; kind: 'regex'; regex: RE2 }
  | { ok: false; kind: WakewordKind; reason: string };

/**
 * 「这是正则」的判据。`^` 开头是主规则；`(?i)` 这类内联标志开头的也算——它是写「大小写不敏感的
 * 正则」最自然的拼法，当成包含匹配的话用户拿到的是一个永远匹配不上、面板还标着「包含」的模式，
 * 正是这个文件要挡的那种失败。`(?:` 不会被误判：冒号不在字符类里。
 */
const REGEX_PREFIX = /^(?:\^|\(\?[a-zA-Z-]+\))/;

export function checkWakeword(pattern: string, minLength: number): WakewordCheck {
  const kind: WakewordKind = REGEX_PREFIX.test(pattern) ? 'regex' : 'contains';
  if ([...pattern.replace(REGEX_PREFIX, '')].length < minLength) return { ok: false, kind, reason: `短于 wakewordMinLength=${minLength}` };
  if (kind === 'contains') return { ok: true, kind, folded: pattern.toLocaleLowerCase() };
  if ([...pattern].length > 128) return { ok: false, kind, reason: '正则超过 128 个字符' };
  try { return { ok: true, kind, regex: new RE2(pattern, 'u') }; }
  catch (error) { return { ok: false, kind, reason: `不是 RE2 兼容正则：${error instanceof Error ? error.message : String(error)}` }; }
}

/**
 * 运行时匹配。**contains 型忽略大小写**：手机输入法会把句首的 `nori` 自动改成 `Nori`，
 * 大小写敏感的话唤醒词就成了一条只在特定拼写下生效的暗规则，用户只看到「bot 时灵时不灵」。
 * 正则型按作者写的大小写走，要不敏感就自己写 `^(?i)nori` —— 不替作者改语义，也保住了
 * 「我就是要区分大小写」这个表达能力。
 */
export function matchesWakeword(checked: WakewordCheck, text: string): boolean {
  if (!checked.ok) return false;
  // 正则只看开头这一段（RE2 是线性的，但没必要扫完超长消息）；contains 是 O(n) 的 includes，扫全文没有代价。
  if (checked.kind === 'regex') return checked.regex.test(text.slice(0, WAKEWORD_SCAN_LIMIT));
  return text.toLocaleLowerCase().includes(checked.folded);
}

/** 写入端用：返回每条不会生效的模式及原因，空数组表示整份唤醒词都可用。 */
export function rejectedWakewords(wakewords: readonly string[], minLength: number): string[] {
  return wakewords.flatMap((pattern) => { const checked = checkWakeword(pattern, minLength); return checked.ok ? [] : [`「${pattern}」${checked.reason}`]; });
}
