/**
 * 占位符（插值）的判定与校验。**纯函数、不碰 node**：`extract.ts`（落盘侧）与 dev 面板
 * （浏览器侧）都要用同一份判据 —— 两边各写一份的必然结果是面板说「可以保存」而落盘拒绝，
 * 或者反过来面板拦住了本来能存的东西。
 *
 * 占位符有两种形态，取决于这句话在源码里长什么样：模板正文里是 `{{ expr }}`，
 * 字符串/模板串里是 `${expr}`。面板里改写时**必须原样留着** —— 少掉一个，界面上就是一个
 * 消失的数字或名字，而这种坏法不会报错。
 */

/**
 * 一句话里的全部占位符，按出现顺序（含重复）。
 *
 * `${}` **要数括号**，不能找第一个 `}`：模板串可以嵌套，
 * `` `固定：恒发「${list[i]}」${i === raw ? '' : `（下标 ${raw} 越界）`}` `` 里第二个占位自己就带着
 * 一层 `${}`。原先这里是 `\$\{[^}]*\}`，切出来的是一段语法不成立的残句 —— 拿它做「在不在」的
 * 检查还看不出问题，一旦拿它生成代码（面板要把占位的当前值传给运行时）就当场把源码切坏。
 */
export function slotsOf(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (text.startsWith('{{', at)) {
      const end = text.indexOf('}}', at + 2);
      if (end < 0) break;
      out.push(text.slice(at, end + 2));
      at = end + 1;
      continue;
    }
    if (!text.startsWith('${', at)) continue;
    let depth = 0;
    let cursor = at + 1;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}' && --depth === 0) break;
    }
    // 括号不闭合（或者 `}` 藏在字符串里）就到此为止：宁可少认一个占位，也不要交出一段残句。
    if (depth !== 0) break;
    out.push(text.slice(at, cursor + 1));
    at = cursor;
  }
  return out;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOf = (text: string, needle: string): number => (needle ? text.split(needle).length - 1 : 0);

/**
 * 把大括号内侧的空白收成记录里那个样子：`{{n}}` / `{{  n  }}` → `{{ n }}`。
 *
 * 为什么要容这一手：人一边打中文一边补大括号，空格多一个少一个是常事，而那不是「改错了」，
 * 是同一个占位。**只容大括号内侧的空白** —— 表达式内部一个字都不动，改表达式是改代码。
 */
export function canonicalSlots(text: string, slots: readonly string[]): string {
  let out = text;
  for (const slot of new Set(slots)) {
    const curly = slot.startsWith('{{');
    const inner = curly ? slot.slice(2, -2).trim() : slot.slice(2, -1).trim();
    if (!inner) continue;
    const loose = new RegExp(`${curly ? '\\{\\{' : '\\$\\{'}\\s*${escapeRe(inner)}\\s*${curly ? '\\}\\}' : '\\}'}`, 'g');
    out = out.replace(loose, slot);
  }
  return out;
}

/**
 * 改写之后**丢掉了**哪些占位符。空数组 = 可以落盘。
 *
 * 判据是**个数**而不是「在不在」：`删除 ${name} 的配置覆盖？删掉之后回到 agents/${name}.md`
 * 这种一句话里同一个占位出现两次的，只留一个照样是坏的（第二处会变成字面量 `agents/.md`），
 * 而 `includes` 检查不出来。多写一个不算错 —— 那个表达式再算一次而已。
 */
export function missingSlots(text: string, original: string, slots: readonly string[]): string[] {
  const next = canonicalSlots(text, slots);
  return [...new Set(slots)].filter((slot) => countOf(next, slot) < countOf(original, slot));
}

/**
 * 把改写后的那句话里的占位换成这一次渲染的**真实值**。dev 面板的即时预览靠它 ——
 * 覆盖层里存的是带占位的模板（`一共 {{ n }} 回`），而页面要显示填好的那句。
 *
 * `texts` 与 `values` 按**源码顺序**一一对应（插桩时一起传出来的），但替换是**按文本**做的：
 * 于是人把占位挪到句首、或者一句里同一个占位出现两次，都还对。
 */
export function fillSlots(text: string, texts: readonly string[], values: readonly unknown[]): string {
  let out = canonicalSlots(text, texts);
  for (const [index, slot] of texts.entries()) {
    if (index >= values.length) break;
    out = out.split(slot).join(String(values[index] ?? ''));
  }
  return out;
}
