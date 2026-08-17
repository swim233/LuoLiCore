/**
 * 唤醒词的可用性判定。运行时匹配（telegram/trigger.ts）与写入端校验（WebUI）必须共用这一份：
 * 分成两份实现会漂移，面板收下一个运行时永远匹配不上的模式，用户只能看到「bot 不理我」。
 */
import { RE2 } from 're2-wasm';

/** 正则只对消息开头这一段求值；匹配由 RE2 保证线性时间。 */
export const WAKEWORD_SCAN_LIMIT = 4096;

export type WakewordKind = 'contains' | 'regex';
export type WakewordCheck =
  | { ok: true; kind: 'contains' }
  | { ok: true; kind: 'regex'; regex: RE2 }
  | { ok: false; kind: WakewordKind; reason: string };

export function checkWakeword(pattern: string, minLength: number): WakewordCheck {
  const kind: WakewordKind = pattern.startsWith('^') ? 'regex' : 'contains';
  if ([...pattern.replace(/^\^/, '')].length < minLength) return { ok: false, kind, reason: `短于 wakewordMinLength=${minLength}` };
  if (kind === 'contains') return { ok: true, kind };
  if ([...pattern].length > 128) return { ok: false, kind, reason: '正则超过 128 个字符' };
  try { return { ok: true, kind, regex: new RE2(pattern, 'u') }; }
  catch (error) { return { ok: false, kind, reason: `不是 RE2 兼容正则：${error instanceof Error ? error.message : String(error)}` }; }
}

/** 写入端用：返回每条不会生效的模式及原因，空数组表示整份唤醒词都可用。 */
export function rejectedWakewords(wakewords: readonly string[], minLength: number): string[] {
  return wakewords.flatMap((pattern) => { const checked = checkWakeword(pattern, minLength); return checked.ok ? [] : [`「${pattern}」${checked.reason}`]; });
}
