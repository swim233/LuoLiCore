/**
 * 唤醒词的可用性判定。运行时匹配（telegram/trigger.ts）与写入端校验（WebUI）必须共用这一份：
 * 拆成两份实现会漂移，面板会接受一个运行时永不匹配的模式，用户看到的表现是 bot 无响应。
 */
import { RE2 } from "re2-wasm";

/** 正则只对消息开头这一段求值；匹配由 RE2 保证线性时间。 */
export const WAKEWORD_SCAN_LIMIT = 4096;

export type WakewordKind = "contains" | "regex";
export type WakewordCheck =
  | { ok: true; kind: "contains"; folded: string }
  | { ok: true; kind: "regex"; regex: RE2 }
  | { ok: false; kind: WakewordKind; reason: string };

/**
 * 判定输入是否为正则。以 `^` 开头是主规则；以 `(?i)` 这类内联标志开头的同样计入，因为它是书写
 * 大小写不敏感正则最自然的形式，若按包含匹配处理，用户得到的是一个永不匹配、面板却标为包含的模式，
 * 正是本文件要拦截的失败类型。`(?:` 不会被误判：冒号不在字符类内。
 */
const REGEX_PREFIX = /^(?:\^|\(\?[a-zA-Z-]+\))/;

export function checkWakeword(
  pattern: string,
  minLength: number,
): WakewordCheck {
  const kind: WakewordKind = REGEX_PREFIX.test(pattern) ? "regex" : "contains";
  if ([...pattern.replace(REGEX_PREFIX, "")].length < minLength)
    return { ok: false, kind, reason: `短于 wakewordMinLength=${minLength}` };
  if (kind === "contains")
    return { ok: true, kind, folded: pattern.toLocaleLowerCase() };
  if ([...pattern].length > 128)
    return { ok: false, kind, reason: "正则超过 128 个字符" };
  try {
    return { ok: true, kind, regex: new RE2(pattern, "u") };
  } catch (error) {
    return {
      ok: false,
      kind,
      reason: `不是 RE2 兼容正则：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 运行时匹配。contains 型忽略大小写：手机输入法会把句首的 `nori` 自动改成 `Nori`，
 * 若大小写敏感，唤醒词就成了只在特定拼写下生效的隐式规则，用户看到的表现是 bot 时而无响应。
 * 正则型按作者书写的大小写处理，需要不敏感时自行写 `^(?i)nori`：不替作者改变语义，
 * 同时保留区分大小写这一表达能力。
 */
export function matchesWakeword(checked: WakewordCheck, text: string): boolean {
  if (!checked.ok) return false;
  // 正则只匹配开头这一段（RE2 为线性时间，但无需扫描超长消息）；contains 是 O(n) 的 includes，全文扫描无额外代价。
  if (checked.kind === "regex")
    return checked.regex.test(text.slice(0, WAKEWORD_SCAN_LIMIT));
  return text.toLocaleLowerCase().includes(checked.folded);
}

/** 写入端用：返回每条不会生效的模式及原因，空数组表示整份唤醒词都可用。 */
export function rejectedWakewords(
  wakewords: readonly string[],
  minLength: number,
): string[] {
  return wakewords.flatMap((pattern) => {
    const checked = checkWakeword(pattern, minLength);
    return checked.ok ? [] : [`「${pattern}」${checked.reason}`];
  });
}
