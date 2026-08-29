/**
 * 占位符（插值）的判定与校验。纯函数，不依赖 node：`extract.ts`（落盘侧）与 dev 面板
 * （浏览器侧）必须使用同一份判据，各写一份的结果是面板允许保存而落盘拒绝，
 * 或面板拦截了本可保存的内容。
 *
 * 占位符有两种形态，取决于该句在源码中的位置：模板正文中为 `{{ expr }}`，
 * 字符串或模板串中为 `${expr}`。面板中改写时必须原样保留：缺少一个即表现为界面上
 * 数字或名称消失，且这种错误不会报错。
 */

/**
 * 一句文案中的全部占位符，按出现顺序排列（含重复）。
 *
 * `${}` 需要匹配括号计数，不能查找第一个 `}`：模板串可以嵌套，
 * `` `固定：恒发「${list[i]}」${i === raw ? '' : `（下标 ${raw} 越界）`}` `` 中第二个占位符自身就含有
 * 一层 `${}`。此处原为 `\$\{[^}]*\}`，切出的是语法不成立的片段：用于存在性
 * 检查时不会暴露问题，一旦用于生成代码（面板需把占位符的当前值传给运行时）就会破坏源码。
 */
export function slotsOf(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (text.startsWith("{{", at)) {
      const end = text.indexOf("}}", at + 2);
      if (end < 0) break;
      out.push(text.slice(at, end + 2));
      at = end + 1;
      continue;
    }
    if (!text.startsWith("${", at)) continue;
    let depth = 0;
    let cursor = at + 1;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}" && --depth === 0) break;
    }
    // 括号未闭合（或 `}` 位于字符串内）时在此终止：宁可少识别一个占位符，也不返回残缺片段。
    if (depth !== 0) break;
    out.push(text.slice(at, cursor + 1));
    at = cursor;
  }
  return out;
}

const escapeRe = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const countOf = (text: string, needle: string): number =>
  needle ? text.split(needle).length - 1 : 0;

/**
 * 把大括号内侧的空白归一化为记录中的形式：`{{n}}` / `{{  n  }}` → `{{ n }}`。
 *
 * 需要容错的原因：输入中文时补写大括号，空格多一个或少一个属于常见情况，且这不构成修改错误，
 * 仍是同一个占位符。只归一化大括号内侧的空白，表达式内部不做任何改动，修改表达式属于改代码。
 */
export function canonicalSlots(text: string, slots: readonly string[]): string {
  let out = text;
  for (const slot of new Set(slots)) {
    const curly = slot.startsWith("{{");
    const inner = curly ? slot.slice(2, -2).trim() : slot.slice(2, -1).trim();
    if (!inner) continue;
    const loose = new RegExp(
      `${curly ? "\\{\\{" : "\\$\\{"}\\s*${escapeRe(inner)}\\s*${curly ? "\\}\\}" : "\\}"}`,
      "g",
    );
    out = out.replace(loose, slot);
  }
  return out;
}

/**
 * 改写后丢失了哪些占位符。返回空数组表示可以落盘。
 *
 * 判据是出现次数而不是是否存在：`删除 ${name} 的配置覆盖？删掉之后回到 agents/${name}.md`
 * 这类同一占位符在一句中出现两次的情况，只保留一个同样是错误的（第二处会变成字面量 `agents/.md`），
 * 而 `includes` 无法检出。多写一个不算错误，仅表示该表达式多求值一次。
 */
export function missingSlots(
  text: string,
  original: string,
  slots: readonly string[],
): string[] {
  const next = canonicalSlots(text, slots);
  return [...new Set(slots)].filter(
    (slot) => countOf(next, slot) < countOf(original, slot),
  );
}

/**
 * 把改写后文案中的占位符替换为本次渲染的真实值。dev 面板的即时预览依赖该函数：
 * 覆盖层中存储的是带占位符的模板（`一共 {{ n }} 回`），而页面需要显示填充后的结果。
 *
 * `texts` 与 `values` 按源码顺序一一对应（插桩时一并传出），但替换按文本进行：
 * 因此占位符被移到句首、或同一占位符在一句中出现两次时结果仍然正确。
 */
export function fillSlots(
  text: string,
  texts: readonly string[],
  values: readonly unknown[],
): string {
  let out = canonicalSlots(text, texts);
  for (const [index, slot] of texts.entries()) {
    if (index >= values.length) break;
    out = out.split(slot).join(String(values[index] ?? ""));
  }
  return out;
}
