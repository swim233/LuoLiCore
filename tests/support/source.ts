import { readFileSync } from 'node:fs';

/**
 * 源码级断言的**唯一**读取口。
 *
 * 仓库里有十来条断言读的是 `.ts` 源文本而不是行为 —— 「关停路径仍然调 `abortAll`」
 * 「处理器装在 `serve()` 之前」「命令白名单与 `/help` 同步」这一类，判据本身就长在源码结构上，
 * 行为化要么装不起来（依赖 `D-04` 的 `composeRuntime`）要么测不出顺序。
 *
 * 它们此前逐字匹配源文本，于是 `b7e24ae`（一次纯格式化）把源码从单引号改成双引号、
 * 顺带重排折行之后，**十条断言集体变红**。红本身不是问题，问题是红着的时候它们什么都不挡：
 * 一道判据永远失败与一道判据永远通过，对「谁来守住这件事」是同一个答案。
 *
 * 所以两侧都过同一套归一化：
 * - **引号归一**（`'` → `"`）—— 换 prettier 配置、换 eslint quotes 规则都不再复发；
 * - **空白压平**（任意空白串 → 一个空格）—— 吸收掉折行与缩进，`printWidth` 改了也不复发。
 *
 * 代价说清楚：归一化之后断言匹配的是「归一化后的源码」而不是逐字源码，理论上会放过
 * 「引号不同因而语义不同」的情况 —— 而在 TS 里 `'x'` 与 `"x"` 本来就是同一个字符串。
 * 真正的限制是**行内空格**：`f(a, b)` 与 `f(a,b)` 归一化后仍然不同，所以 needle 要照
 * 格式化后的样子写。这不是遗漏，是这层抽象的边界。
 *
 * 归一化之后源码里的字符串引号**恒为 `"`**，所以自己写正则去扫源码时直接写双引号即可
 * （`/bot\.command\("([a-z_]+)"/`）—— 这正是「下次格式化不再复发」那一半。
 *
 * 需要按行判断的断言不要用这里（压平之后没有行了）—— 那种自己 `readFileSync` 并说明理由。
 */
const normalize = (text: string): string =>
  text.replace(/'/g, '"').replace(/\s+/g, ' ');

/** 读一份源码，归一化。断言的左侧。 */
export const source = (path: string): string =>
  normalize(readFileSync(path, 'utf8'));

/** 把一段期望的代码过同一套归一化。断言的右侧 —— **两侧都要过**，只过一侧等于没归一化。 */
export const code = (snippet: string): string => normalize(snippet);

/**
 * `code(snippet)` 在 `source(path)` 里的位置，找不到回 -1。
 * 顺序类断言（「A 排在 B 之前」）用它，别自己拿 `indexOf` 打未归一化的文本。
 * 压平不改变相对顺序，所以比较位置仍然成立。
 */
export const codeIndex = (text: string, snippet: string): number =>
  text.indexOf(code(snippet));
