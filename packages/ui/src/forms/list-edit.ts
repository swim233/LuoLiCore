/* 列表编辑（唤醒词、白名单的群和用户……一组能增、删的文字）的纯逻辑，不碰 DOM。
   列表就是 string[]：编辑中允许有空串（刚点了「添加」还没填的那一行），存下来、拿去用之前过一遍 cleanList。 */
export interface ListRules {
  /** 不许重复（默认 true） */
  unique?: boolean;
  /** 最多几项；不给不限 */
  max?: number;
  /** 重复的判断是否区分大小写（默认不区分） */
  caseSensitive?: boolean;
}

/** 去掉两头的空白；空串返回 null */
export function normalizeItem(raw: string): string | null {
  const v = raw.trim();
  return v === '' ? null : v;
}

const keyOf = (v: string, rules: ListRules) => (rules.caseSensitive ? v : v.toLowerCase());

/** 每一行输入框给读屏的默认名字：「第 1 项」（i 从 0 数起） */
export const defaultItemLabel = (i: number): string => `第 ${i + 1} 项`;

/** 这一项在列表里是不是已经有了（不看第 skip 个：改某一行时不和自己比） */
export function hasItem(
  items: readonly string[],
  value: string,
  rules: ListRules = {},
  skip = -1,
): boolean {
  const k = keyOf(value, rules);
  return items.some((it, i) => i !== skip && it !== '' && keyOf(it, rules) === k);
}

/** 删掉第 i 项 */
export function removeAt(items: readonly string[], i: number): string[] {
  return items.filter((_, j) => j !== i);
}

/** 改第 i 项（编辑中，不去空白、允许空：空白在 cleanList 里才去） */
export function updateAt(items: readonly string[], i: number, value: string): string[] {
  return items.map((it, j) => (j === i ? value : it));
}

/** 在第 at 个位置插一个空行（点「添加」插在末尾，在行里按回车插在下面）；已经满了就原样返回 */
export function insertBlankAt(
  items: readonly string[],
  at: number,
  rules: ListRules = {},
): string[] {
  if (rules.max !== undefined && items.length >= rules.max) return [...items];
  return [...items.slice(0, at), '', ...items.slice(at)];
}

/** 存下来、拿去用之前：每项去两头空白，去掉空的，去掉重复的（留第一个） */
export function cleanList(items: readonly string[], rules: ListRules = {}): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const v = normalizeItem(raw);
    if (v === null) continue;
    if (rules.unique !== false && hasItem(out, v, rules)) continue;
    out.push(v);
  }
  return out;
}

/** 第 i 项是不是和前面的某一项重复（编辑中的行用它标出错） */
export function isDuplicateAt(items: readonly string[], i: number, rules: ListRules = {}): boolean {
  if (rules.unique === false) return false;
  const v = normalizeItem(items[i] ?? '');
  if (v === null) return false;
  return hasItem(items.slice(0, i), v, rules);
}
