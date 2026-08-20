/**
 * dev 文案面板的 Vite 插件：把源码里每一句用户可见的文案包一层 `__LUOLI_C__('id', 原文)`，
 * 于是面板里改字能即时反映到真界面上，按〔保存〕再由 `applyEdits` 写回源码。
 *
 * **生产为零，两道闩**：① `copyEditPlugin()` 在 `COPY_EDIT !== '1'` 时直接返回 `false`
 * （Vite 会忽略假值插件）；② 返回的插件带 `apply: 'serve'`，`vite build` 阶段不参与。
 * 运行时那两个文件在 `packages/webui/src` 之外，生产构建里没有任何引用路径指向它们。
 * `tests/copy-edit.test.ts` 把这三件事焊住。
 *
 * 插桩只做 dev，**不改变语义**：`__LUOLI_C__` 没有覆盖时原样返回第二个参数。
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { BROWSER_FILES, applyChanges, basisOf, elements, extractAll, extractFile, slotsOf, translateOf, utilitiesOf, type Change, type Entry } from './extract.js';
import { rewind, snapshot, steps } from './history.js';

const ROOT = resolve('.');
const BOOT = resolve('scripts/copy/runtime/boot.ts');
const CALL = '__LUOLI_C__';

/**
 * 双引号属性里塞 JS：`"` 只能走实体，`'` 走 JS 转义。
 *
 * **换行必须转义**：HTML 属性值本来可以跨行（`title="第一句\n  第二句"` 在源码里是真换行），
 * 而 Vue 把属性值当 JS 表达式解析 —— 裸换行落在 `'...'` 里就是 `Unterminated string constant`。
 */
const inAttr = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  .replaceAll('"', '&quot;').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
/** 模板串字面量里要挡掉的三个字符；`${}` 是插值，留着。 */
const inTemplate = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$');

/**
 * HTML 实体在属性值与文本位置都会被模板解析器**先解码**，之后才当 JS 表达式解析。
 * `placeholder='一行一条：&#10;让我想想…'` 解码出来是个真换行，落在 `'...'` 里就是
 * `Unterminated string constant`。这种不插桩 —— 面板里仍然列得到、改得动，只是没有即时预览。
 */
const HAS_ENTITY = /&(?:[a-z][a-z0-9]{1,10}|#\d{1,5}|#x[0-9a-f]{1,4});/i;

/**
 * 占位符的**当前值**也要交给运行时，否则改一句带占位的话时预览是坏的。
 *
 * 插桩后传给 `__LUOLI_C__` 的第二个参数是**已经算好**的整句（`` `共 ${n} 条` `` 求值后是「共 42 条」），
 * 而面板里人写的是带占位的模板（`一共 {{ n }} 回`）。没有第三个参数时运行时只能把那份覆盖原样交回去
 * —— 页面上就显示字面的 `{{ n }}`，而带占位的那 282 条恰恰是最需要看清真实字长的（数字、名字、路径）。
 * 所以按源码顺序把表达式再传一遍，运行时按 `slots` 逐个换回去。
 *
 * 代价是那些表达式**求值两次**。这里的表达式全是取值/格式化（`data.steps`、`Number(x).toFixed(4)`），
 * 没有副作用；真出现有副作用的表达式，它在模板里被求值两次本身就已经是个 bug 了。
 */
const slotExprs = (raw: string): string[] => (raw.startsWith('`')
  ? slotsOf(raw).filter((slot) => slot.startsWith('${')).map((slot) => slot.slice(2, -1).trim()) : []);
/**
 * 那串表达式**拼起来语法成立吗**。
 *
 * 最后一道闩，而且是必需的：这些表达式是从源码切出来的，切歪一个字符就会生成一段编译不过的
 * 东西，而插桩坏掉的表现是整页空白。`new Function` 只解析不执行 —— 表达式里的组件作用域变量
 * 在这里当然不存在，那不影响语法判定。切歪了就退回不传值（预览显示字面占位），不把源码弄坏。
 */
function parses(values: readonly string[]): boolean {
  if (!values.length) return false;
  try { new Function(`return [${values.join(', ')}]`); return true; } catch { return false; }
}

/** 模板里的一段文字 → 一个插值调用。`{{ x }}` 转成模板串的 `${x}`，其余部分逐段转义。 */
function textToCall(id: string, raw: string): string | null {
  const body = raw.trim();
  if (HAS_ENTITY.test(body)) return null;
  const parts: string[] = [];
  const values: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(/\{\{([^}]*)\}\}/g)) {
    parts.push(inTemplate(body.slice(cursor, match.index)));
    const expression = (match[1] ?? '').trim();
    parts.push(`\${${expression}}`);
    values.push(expression);
    cursor = (match.index ?? 0) + match[0].length;
  }
  parts.push(inTemplate(body.slice(cursor)));
  const tail = parses(values) ? `, [${values.join(', ')}]` : '';
  const code = `{{ ${CALL}('${id}', \`${parts.join('')}\`${tail}) }}`;
  // 生成物里如果提前出现 `}}`，模板解析器会在那里就把插值收尾。宁可不插桩。
  return code.slice(0, -3).includes('}}') ? null : code;
}

/**
 * 模板里的 `__LUOLI_C__(…)` 必须落在**组件作用域**里。
 *
 * Vue 的模板编译会把不认识的标识符前缀成 `_ctx.xxx` —— 而它是 `window` 上的全局，`_ctx` 上
 * 当然没有，渲染当场抛 TypeError，表现是那个页面整块空白（仓库里 `console.render.test.ts`
 * 开头记的正是这类事故）。`<script setup>` 的顶层 const 会被暴露给模板，所以补一行绑定即可；
 * 全仓 24 个 SFC 都是 `<script setup>`，`tests/copy-edit.test.ts` 会盯着这条不变。
 */
function bindInScope(text: string): string {
  const tag = /<script\b[^>]*\bsetup\b[^>]*>/.exec(text);
  if (!tag) return text;
  const at = tag.index + tag[0].length;
  return `${text.slice(0, at)}\nconst __LUOLI_C__ = window.__LUOLI_C__;${text.slice(at)}`;
}

/** 一次源码改写：把 `[at, to)` 换成 `text`。`at === to` 是纯插入。 */
interface Splice { at: number; to: number; text: string }

/**
 * 导出只为 `tests/copy-edit.test.ts`：插桩过的每个文件都必须还能被 Vue / TS 解析。
 *
 * `owners` 是元素 key → `<tag` 之后的插入点。有它才能给元素挂上 `data-copy-id`，
 * 让「点界面上的字回跳到面板」成立。**用属性而不是包一层 span**：这个仓库有 12 处 `+ .` 相邻
 * 选择器、8 处 `:nth-child`、4 处 `:last-child`，多套一层元素会把布局改掉，加个属性不会。
 */
export function instrument(source: string, entries: Entry[], owners = new Map<string, number>()): string {
  const splices: Splice[] = [];
  const tagged = new Map<number, string[]>();
  let needsBinding = false;
  for (const entry of entries) {
    // 模板里只能写组件作用域里的名字，script 里只能写 `window.` —— 见 `bindInScope` 与 Entry.zone。
    const call = entry.zone === 'template' ? CALL : `window.${CALL}`;
    const insertPoint = entry.owner ? owners.get(entry.owner) : undefined;
    const remember = (): void => {
      if (insertPoint === undefined || insertPoint < 0) return;
      tagged.set(insertPoint, [...(tagged.get(insertPoint) ?? []), entry.id]);
    };
    if (entry.place === 'attr' && entry.attr) {
      if (source.slice(entry.attr.offset, entry.attr.end) !== `${entry.attr.name}=${entry.raw}`) continue;
      const value = entry.raw.slice(1, -1);
      if (HAS_ENTITY.test(value)) continue;
      splices.push({ at: entry.attr.offset, to: entry.attr.end,
        text: `:${entry.attr.name}="${call}('${entry.id}', '${inAttr(value)}')"` });
      needsBinding = true;
      remember();
      continue;
    }
    if (source.slice(entry.offset, entry.end) !== entry.raw) continue;
    if (entry.place === 'literal') {
      const values = slotExprs(entry.raw);
      const withValues = `${call}('${entry.id}', ${entry.raw}, [${values.join(', ')}])`;
      // 模板区里这一条外面还包着源码自带的 `{{ }}`：生成物里冒出一个 `}}` 会让插值提前收尾，
      // 那时宁可不传值（预览退回显示字面占位），也不能把模板切坏。
      const safe = parses(values) && !(entry.zone === 'template' && withValues.includes('}}'));
      splices.push({ at: entry.offset, to: entry.end, text: safe ? withValues : `${call}('${entry.id}', ${entry.raw})` });
      needsBinding ||= entry.zone === 'template';
      remember();
      continue;
    }
    const interpolation = textToCall(entry.id, entry.raw);
    if (!interpolation) continue;
    const lead = entry.raw.slice(0, entry.raw.length - entry.raw.trimStart().length);
    const tail = entry.raw.slice(entry.raw.trimEnd().length);
    splices.push({ at: entry.offset, to: entry.end, text: `${lead}${interpolation}${tail}` });
    needsBinding = true;
    remember();
  }
  for (const [at, ids] of tagged) splices.push({ at, to: at, text: ` data-copy-id="${[...new Set(ids)].join(' ')}"` });

  let text = source;
  let floor = source.length;
  // 降序一次过：改动只影响更大的 offset，所以前面的 offset 一直有效。重叠的一律丢掉
  // （`dropNested` 之后不该再有，但错位切出来的东西语法都不成立，宁可少插一处）。
  for (const splice of splices.sort((a, b) => b.at - a.at || b.to - a.to)) {
    if (splice.to > floor) continue;
    text = `${text.slice(0, splice.at)}${splice.text}${text.slice(splice.to)}`;
    floor = splice.at;
  }
  // 绑定放在所有替换之后：它会把后面的 offset 全推走。
  return needsBinding ? bindInScope(text) : text;
}

export function copyEditPlugin(): Plugin | false {
  if (process.env.COPY_EDIT !== '1') return false;
  const targets = new Set(BROWSER_FILES.map((file) => resolve(file)));
  const main = resolve('packages/webui/src/main.ts');
  let cache: Entry[] | null = null;
  const all = (): Entry[] => (cache ??= extractAll());
  /**
   * 面板要知道每个元素当前挂着什么：工具类档位、拖拽偏移，以及**删不删得动**。
   *
   * `inner` 是「删了它会连带吃掉几句文案」。这个数必须在按钮旁边显示出来 —— 删一个 `<p>` 和删
   * 一个装着 14 句话的 `<section>` 在界面上长得一模一样，而后者按下去是不可挽回的一大片。
   */
  const boxes = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const byFile = new Map<string, Entry[]>();
    for (const entry of all()) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    for (const file of BROWSER_FILES.filter((name) => name.endsWith('.vue'))) {
      const rows = byFile.get(file) ?? [];
      for (const info of elements(file).values()) {
        out[info.key] = { file: info.file, tag: info.tag, utilities: utilitiesOf(info), offset: translateOf(info),
          basis: basisOf(info), guards: info.guards,
          inner: rows.filter((row) => row.offset >= info.range.start && row.end <= info.range.end).length };
      }
    }
    return out;
  };
  const body = async (request: { on: (event: string, handler: (chunk?: Buffer) => void) => void }): Promise<unknown> =>
    new Promise((done, fail) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => { if (chunk) chunks.push(chunk); });
      request.on('end', () => {
        try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { fail(error); }
      });
    });
  return {
    name: 'luoli:copy-edit',
    apply: 'serve',
    // `.vue` 要在 plugin-vue 解析之前动，拿到的才是原始 SFC 文本 —— 抽取记的 offset 也是对着它的。
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?')[0] ?? id;
      if (!targets.has(path)) return null;
      const file = relative(ROOT, path);
      // 抽取一律读盘（与 CLI 同一条路）；Vite 给的 `code` 只用来核对没被别的插件动过。
      const owners = new Map([...elements(file).values()].map((info) => [info.key, info.attrInsert]));
      let out = readFileSync(file, 'utf8') === code ? instrument(code, extractFile(file), owners) : code;
      if (path === main) out = `import '/@fs/${BOOT}';\n${out}`;
      if (out === code) return null;
      // `__LUOLI_C__` 是 boot.ts 挂在 window 上的全局，所以插桩过的文件不需要加 import ——
      // 少一条注入就少一处能把 `<script setup>` 弄坏的地方。
      return { code: out, map: null };
    },
    handleHotUpdate() { cache = null; },
    configureServer(server) {
      server.middlewares.use('/__copy/entries', (_request, response) => {
        const rows = all().map(({ id, file, line, surface, kind, where, core, slots, pinned, owner }) => ({ id, file, line, surface, kind, where, core, slots, pinned, owner }));
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ entries: rows, elements: boxes() }));
      });
      /**
       * 保存：面板攒起来的**全部**暂存改动（文案 / 贴边间距 / 拖拽偏移）一次写完。
       * 在这之前源码一个字节都没动过 —— 面板上的一切都只是 DOM 预览。
       */
      server.middlewares.use('/__copy/save', (request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        void body(request).then((payload) => {
          const changes = (payload as { changes?: Change[] }).changes ?? [];
          const bad = changes.find((change) => !BROWSER_FILES.includes(change.file) && change.kind !== 'text');
          if (bad) { response.statusCode = 400; response.end(JSON.stringify({ applied: 0, refused: [`不在可改文件列表里：${bad.file}`] })); return; }
          const result = applyChanges(changes);
          // 快照存的是**改动前**那一份，所以它必须在这一刻记下来（`applyChanges` 已经写完盘了，
          // 但它把原文交回来了）。存不下（比如一处都没落地）就不留空层。
          const step = snapshot(result.before, result.applied);
          cache = null;
          response.end(JSON.stringify({ applied: result.applied, refused: result.refused, stuck: result.stuck,
            step, history: steps().length }));
        }, (error: unknown) => {
          response.statusCode = 400;
          response.end(JSON.stringify({ applied: 0, refused: [error instanceof Error ? error.message : String(error)] }));
        });
      });
      server.middlewares.use('/__copy/history', (_request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ steps: steps() }));
      });
      /**
       * 退到某一步保存**之前**。不带 `to` 就是退最近一步。
       *
       * 请求体可以是空的（面板的「撤销上次保存」那个按钮就不带体），所以解析失败一律当 `{}`
       * 而不是 400 —— 这条路上「没有说退到哪」是合法输入，不是错误。
       */
      server.middlewares.use('/__copy/revert', (request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        void body(request).catch(() => ({})).then((payload) => {
          const to = (payload as { to?: string }).to;
          const result = rewind(typeof to === 'string' && to ? to : undefined);
          cache = null;
          response.end(JSON.stringify(result.ok ? { ...result, history: steps().length } : result));
        });
      });
    },
  };
}
