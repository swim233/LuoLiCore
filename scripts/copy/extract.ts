/**
 * 用户可见文案的抽取与落回。dev 文案面板（`scripts/copy/plugin.ts`）与体检脚本（`stats.ts`）
 * 共用这一份实现，id 必须两侧一致，否则面板中保存的内容对不上源码中的位置。
 *
 * 采用 AST 而非正则的原因：文案有一半位于插值与属性中（`:label="\`${n} 轮进行中\`"`、
 * `empty="当前没有正在跑的轮次。"`、`title="..."`），而含中文的行里又混有大量注释。
 * Vue 的模板 AST 与 TS 的 script AST 能区分这两者。
 *
 * 这里不是 i18n 层：源码始终是唯一真相，抽取结果只在改写期间存在。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseSfc } from "vue/compiler-sfc";
import ts from "typescript";
import { canonicalSlots, missingSlots, slotsOf } from "./slots.js";

// 占位符判据由 `slots.ts` 独占（浏览器侧的面板也 import 它），这里只做转发。
export { canonicalSlots, missingSlots, slotsOf } from "./slots.js";

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
/** 属性中会被用户读到的那些。`:foo` 与 `v-bind:foo` 同名，共用同一张表。 */
const COPY_ATTRS = new Set([
  "label",
  "empty",
  "placeholder",
  "title",
  "aria-label",
  "header",
  "summary",
  "detail",
  "value",
  "hint",
  "note",
  "legend",
  "alt",
  "confirm",
  "text",
  "tooltip",
  "unit",
  "suffix",
  "prefix",
]);
/** 图标类名、路径、枚举值这类形似自然语言的 ASCII 串。命中即判定为非文案。 */
const NOT_COPY = /^(pi |\/|https?:|#|[a-z0-9_.-]+$|[A-Za-z-]+\/[A-Za-z-]+)/;

/** 一条文案在源码中的形态，决定 dev 面板如何为它插桩。 */
export type Place =
  /** JS 字符串 / 模板串（script 块里，或模板表达式内部）。 */
  | "literal"
  /** 模板中的一段文字，可能夹带 `{{ }}`。 */
  | "text"
  /** 静态属性 `label="…"`；插桩时需连同属性名一并改为 `:label`。 */
  | "attr";

export interface Entry {
  id: string;
  file: string;
  line: number;
  offset: number;
  end: number;
  surface: string;
  kind: string;
  where: string;
  place: Place;
  /**
   * 位于模板块还是 script 块。dev 面板据此决定如何引用注入的函数：模板中必须使用组件作用域
   * 内的名字（Vue 会给其他标识符加上 `_ctx.` 前缀），而 script 中必须走 `window.`，因为 `defineProps()`
   * 与 `withDefaults()` 会被提升到 setup 之外，引用局部 const 会直接编译失败。
   */
  zone: "template" | "script";
  /** 源码中该段的原始文本（含引号与缩进），落回时用它与当前源码核对。 */
  raw: string;
  /** 展示用的正文，即 raw 去除引号与首尾空白之后的内容。 */
  core: string;
  /** 改写时必须原样保留的插值。空数组表示纯静态串。 */
  slots: string[];
  /** `place: 'attr'` 才有：`name="value"` 整段的范围与属性名。 */
  attr?: { offset: number; end: number; name: string };
  /** 模板条目所属的元素（`elements()` 的 key）。界面回跳与调整位置都依赖它。 */
  owner?: string;
  pinned: string[];
}

/** 一个模板元素，以及向它写入位置信息所需的落点。 */
export interface ElementInfo {
  key: string;
  file: string;
  tag: string;
  /** `<tag` 之后的位置，dev 面板在此插入 `data-copy-id`，或新建 `class` 与 `style`。 */
  attrInsert: number;
  parent: string | null;
  /** 整个元素在源码中的范围（含开闭标签）。实际删除依据它。 */
  range: { start: number; end: number };
  /**
   * 实际删除的否决理由。非空即禁止删除。判据在 `walkElements` 中计算，理由必须可读，
   * 因为面板会原样展示它：给出不能删除的原因比直接禁用按钮更有价值。
   */
  guards: string[];
  /** 静态 `class="…"` 的范围与内容。该属性不存在时为 undefined（工具类需新插入一个）。 */
  classAttr?: {
    offset: number;
    end: number;
    valueOffset: number;
    valueEnd: number;
    value: string;
  };
  /** 静态 `style="…"`，同上。拖拽偏移写入这里。 */
  styleAttr?: {
    offset: number;
    end: number;
    valueOffset: number;
    valueEnd: number;
    value: string;
  };
}

/**
 * 面板写入模板 `class` 的 token，每组一个互斥值，空值即清除该组。
 *
 * 采用工具类而非修改结构的原因：贴边、字号本就属于 CSS 范畴，调整顺序无法表达贴到容器右边缘。
 * 而工具类可逆（移除 token 即恢复原样）、不改动 DOM 结构，也不会让 `.top-actions .search`
 * 这类后代选择器失配。
 *
 * 字号采用基准乘以倍数的方式，倍数写在 class 中、基准写在内联 `--u-base` 中（见 `basisOf`）。
 * 不使用绝对档位：这套界面的字号是 8 个各不相同的 rem 值（`.68` / `.7` / `.76` / `.78` / `.8` /
 * `.82` / `.84` / `.95`），没有统一刻度，同一个绝对小档同时用于标题与脚注会压平层级。
 * 也不能写成 `1.12em`：`em` 用于 `font-size` 时取父级字号，一个 64px 的 `<h1>` 选择放大
 * 会缩至 17.9px。字重相反：`font-weight` 本身即为刻度，因此直接给出 400/500/600/700。
 *
 * `display` 只有一个值：它是隐藏这一动作的落点，再次点击即清除（与其他组语义一致）。
 */
export const UTILITIES = {
  push: { prefix: "u-push", values: ["start", "center", "end"] },
  text: { prefix: "u-text", values: ["start", "center", "end"] },
  gapx: { prefix: "u-gap-x", values: ["0", "1", "2", "3"] },
  gapy: { prefix: "u-gap-y", values: ["0", "1", "2", "3"] },
  size: { prefix: "u-size", values: ["xs", "sm", "lg", "xl"] },
  weight: { prefix: "u-weight", values: ["400", "500", "600", "700"] },
  slant: { prefix: "u-slant", values: ["italic", "normal"] },
  display: { prefix: "u-display", values: ["none"] },
} as const;
export type UtilityGroup = keyof typeof UTILITIES;

const read = (path: string): string => readFileSync(path, "utf8");
const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;
/**
 * 条目与元素的稳定 id。取 `(file, raw, nth)` 而非 `(file, offset)` 是有意为之：offset 每次保存
 * 都会变化，而面板的 `store.overrides[id]` 需要跨越一次保存继续有效。
 *
 * 使用 12 位十六进制而非 6 位。6 位为 24 bit，而本仓库当前抽出 2700 条文案，按生日问题估算
 * 碰撞概率约 20%，属于必然会发生而非几乎不会发生。实际也确已发生：`sandbox.bypassRoles`
 * 与 `approval.skipForOwner` 两条配置说明在 `aa826d` 上重合，`applyChanges` 中的
 * `new Map([id, entry])` 于是静默覆盖了前者，导致在面板中修改前一句会覆盖后一句的源码区间。
 * 12 位为 48 bit，同等规模下碰撞概率约 1.3e-8。碰撞本身仍由下方 `duplicateIds()` 兜底。
 */
const id6 = (...parts: string[]): string =>
  createHash("sha1").update(parts.join(" ")).digest("hex").slice(0, 12);
/** 展示用：将内部换行与缩进压缩为单个空格，否则一条模板正文会占五行。 */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function looksLikeCopy(text: string, fromTextNode: boolean): boolean {
  const value = text.trim();
  if (!value || /^[\d\s.,:;·/|$%+-]*$/.test(value)) return false;
  if (HAN.test(value)) return true;
  if (NOT_COPY.test(value)) return false;
  // 纯 ASCII 的只收自然语言形态的：`LIVE OVERVIEW`、`CONTROL PLANE` 这类小标题位于文本节点中，
  // 属性中则要求含空格，以免把 `severity="secondary"` 收进来。
  return (
    /[A-Za-z]{2}/.test(value) &&
    (fromTextNode ? value.length >= 3 : / /.test(value))
  );
}

// ── 钉住关系：修改这句话会连带影响文档与测试。惰性计算，插件侧用不到。 ──────────
let pinIndex: {
  docs: Map<string, string[]>;
  tests: Map<string, string[]>;
} | null = null;
const walkDir = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkDir(join(dir, e.name))
      : /\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
/** 只收断言中的串。夹具中的中文（`text: '早上好'`）与界面文案无关，混入会让钉住关系全是误报。 */
const ASSERTED =
  /(?:toContain|toBe|toMatch|toHaveText|toContainEqual|toStrictEqual|toEqual)\(\s*(?:'([^'\n]{2,80})'|"([^"\n]{2,80})")/g;
function pins(): { docs: Map<string, string[]>; tests: Map<string, string[]> } {
  if (pinIndex) return pinIndex;
  const docs = new Map<string, string[]>();
  for (const name of readdirSync("docs").filter((n) => n.endsWith(".md"))) {
    const text = read(join("docs", name));
    for (const match of text.matchAll(/「([^」\n]{2,60})」/g)) {
      const [, quoted = ""] = match;
      docs.set(quoted, [
        ...(docs.get(quoted) ?? []),
        `docs/${name}:${lineOf(text, match.index ?? 0)}`,
      ]);
    }
  }
  const tests = new Map<string, string[]>();
  for (const path of walkDir("tests")) {
    const text = read(path);
    for (const match of text.matchAll(ASSERTED)) {
      const value = match[1] ?? match[2] ?? "";
      if (!HAN.test(value)) continue;
      tests.set(value, [
        ...(tests.get(value) ?? []),
        `${path}:${lineOf(text, match.index ?? 0)}`,
      ]);
    }
  }
  pinIndex = { docs, tests };
  return pinIndex;
}
/** 断言常写作 `toContain('要登录')` 而源码中的句子更长，因此正反两个方向都要匹配。 */
function pinsFor(core: string, want: boolean): string[] {
  if (!want) return [];
  const { docs, tests } = pins();
  const hits = [...(docs.get(core) ?? []).map((at) => `文档 ${at}`)];
  for (const [literal, places] of tests) {
    if (literal === core || (literal.length >= 3 && core.includes(literal)))
      hits.push(...places.map((at) => `测试 ${at}`));
  }
  return [...new Set(hits)];
}

// ── script 侧：TS AST ────────────────────────────────────────────────────
/** 一个串的位置信息：从它向上追溯到顶层声明，拼接沿途的属性名与调用名。 */
function describeTs(node: ts.Node): { top: string; where: string } {
  const trail: string[] = [];
  let top = "top";
  for (
    let cursor: ts.Node | undefined = node.parent;
    cursor;
    cursor = cursor.parent
  ) {
    if (
      ts.isPropertyAssignment(cursor) &&
      (ts.isIdentifier(cursor.name) || ts.isStringLiteral(cursor.name))
    )
      trail.unshift(cursor.name.text);
    else if (ts.isCallExpression(cursor)) {
      const callee = cursor.expression;
      trail.unshift(
        `${ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "call"}()`,
      );
    } else if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name)
    ) {
      top = cursor.name.text;
      trail.unshift(cursor.name.text);
    } else if (
      (ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      top = cursor.name.text;
      trail.unshift(`${cursor.name.text}()`);
    }
    if (cursor.parent && ts.isSourceFile(cursor.parent)) break;
  }
  return { top, where: trail.join(" › ") || "顶层" };
}
interface TsHit {
  offset: number;
  end: number;
  raw: string;
  core: string;
  top: string;
  where: string;
  kind: string;
}
function scanScript(content: string, base: number, fileName: string): TsHit[] {
  const source = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: TsHit[] = [];
  const visit = (node: ts.Node): void => {
    const isPlain =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (isPlain || ts.isTemplateExpression(node)) {
      const raw = content.slice(node.getStart(source), node.end);
      const core = raw.slice(1, -1);
      // script 侧只收带中文的：ASCII 串在这里几乎全是标识符、路径、枚举值。
      if (HAN.test(core)) {
        const { top, where } = describeTs(node);
        hits.push({
          offset: base + node.getStart(source),
          end: base + node.end,
          raw,
          core,
          top,
          where,
          kind: /pushToast|toastError/.test(where)
            ? "Toast"
            : /confirm/i.test(where)
              ? "二次确认"
              : /HINT|NOTE|hint|note|description/.test(where)
                ? "说明"
                : "标签",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return hits;
}

// ── 模板侧：Vue AST ─────────────────────────────────────────────────────
const enum NT {
  ELEMENT = 1,
  TEXT = 2,
  INTERPOLATION = 5,
  ATTRIBUTE = 6,
  DIRECTIVE = 7,
}
interface TplHit {
  offset: number;
  end: number;
  raw: string;
  core: string;
  page: string;
  container: string | null;
  kind: string;
  where: string;
  place: Place;
  zone: "template";
  owner: string;
  attr?: { offset: number; end: number; name: string };
}
/** `v-if="active === 'quota'"` 这类分支决定其下区域属于哪个页面。 */
const pageOf = (exp: string): string | null =>
  /(?:active|tab|section|settingsTab|segment)\s*===\s*'([a-z0-9_-]+)'/.exec(
    exp,
  )?.[1] ?? null;
/** 对话框文案位于模板根上，无法判定属于哪一页，因此用其自身标题作为标识，单独归为一类。 */
const CONTAINERS = new Set(["UiModal", "UiDrawer"]);
function containerName(node: any): string | null {
  if (!CONTAINERS.has(node.tag)) return null;
  for (const prop of node.props ?? []) {
    if (
      prop.type === NT.ATTRIBUTE &&
      prop.name === "header" &&
      prop.value?.content
    )
      return prop.value.content;
    if (
      prop.type === NT.DIRECTIVE &&
      prop.arg?.content === "header" &&
      prop.exp
    )
      return flat(prop.exp.content).replace(/^['"`]|['"`]$/g, "");
  }
  for (const prop of node.props ?? []) {
    if (prop.type === NT.DIRECTIVE && prop.name === "model" && prop.exp)
      return prop.exp.content;
  }
  return node.tag;
}

const elementKey = (file: string, tag: string, start: number): string =>
  id6("el", file, tag, String(start));

/** 模板中的所有元素，以及整体移除所需的范围。key 只在源码未变期间稳定，改动后需重新抽取。 */
function walkElements(
  file: string,
  fileText: string,
  ast: any,
): Map<string, ElementInfo> {
  const map = new Map<string, ElementInfo>();
  /**
   * 静态属性的范围，只识别静态形式：`:class` / `:style` 是表达式，向其中写入需要改动代码。
   * 元素只有动态绑定时新插入一个静态属性，Vue 会将两者合并。
   */
  const attrOf = (node: any, name: string): ElementInfo["classAttr"] => {
    const hit = (node.props ?? []).find(
      (p: any) => p.type === NT.ATTRIBUTE && p.name === name && p.value,
    );
    return hit
      ? {
          offset: hit.loc.start.offset,
          end: hit.loc.end.offset,
          valueOffset: hit.value.loc.start.offset + 1,
          valueEnd: hit.value.loc.end.offset - 1,
          value: hit.value.content,
        }
      : undefined;
  };
  /** 元素上有没有某个指令（`v-if` / `v-else` / `v-for`）。 */
  const hasDirective = (node: any, name: string): boolean =>
    (node.props ?? []).some(
      (p: any) => p.type === NT.DIRECTIVE && p.name === name,
    );
  /**
   * 实际删除的三条否决判据。三者都是保存之后才会出错的形态，因此在这里直接禁止删除。
   *
   * ① `v-else` / `v-else-if` 相邻：删除前面的 `v-if` 后，紧随其后的 `v-else` 立即产生编译错误，
   *    表现为整页白屏。全仓有 40 处 `v-else-if` 与 41 处 `v-else`。
   * ② 带 `ref`：脚本中 `xxx.value!.focus()` 这类写法会在运行时报错。全仓 12 处。
   * ③ 唯一根节点：模板根变为空，组件从此无法渲染出任何内容。
   */
  const guardsOf = (
    node: any,
    siblings: any[],
    index: number,
    parentKey: string | null,
  ): string[] => {
    const out: string[] = [];
    const nextElement = siblings
      .slice(index + 1)
      .find((each: any) => each.type === NT.ELEMENT);
    const branching = hasDirective(node, "if") || hasDirective(node, "else-if");
    if (
      branching &&
      nextElement &&
      (hasDirective(nextElement, "else") ||
        hasDirective(nextElement, "else-if"))
    ) {
      out.push(
        `后面紧跟着 v-else/<${nextElement.tag}>，删了它整个文件编译不过`,
      );
    }
    if (
      (node.props ?? []).some(
        (p: any) =>
          (p.type === NT.ATTRIBUTE && p.name === "ref") ||
          (p.type === NT.DIRECTIVE &&
            p.name === "bind" &&
            p.arg?.content === "ref"),
      )
    ) {
      out.push("脚本里用 ref 引着它");
    }
    if (
      !parentKey &&
      siblings.filter((each: any) => each.type === NT.ELEMENT).length === 1
    ) {
      out.push("它是模板唯一的根节点");
    }
    return out;
  };
  const visit = (node: any, parentKey: string | null): void => {
    const kids: any[] = node.children ?? [];
    for (const [index, kid] of kids.entries()) {
      if (kid.type !== NT.ELEMENT) continue;
      const start = kid.loc.start.offset;
      // `<tag` 之后：核对源码确实以该 tag 开头，不匹配时不提供 attrInsert，宁可不插桩。
      const named =
        fileText.slice(start + 1, start + 1 + kid.tag.length) === kid.tag;
      const key = elementKey(file, kid.tag, start);
      const cls = attrOf(kid, "class");
      const style = attrOf(kid, "style");
      map.set(key, {
        key,
        file,
        tag: kid.tag,
        attrInsert: named ? start + 1 + kid.tag.length : -1,
        parent: parentKey,
        range: { start, end: kid.loc.end.offset },
        guards: named
          ? guardsOf(kid, kids, index, parentKey)
          : ["开标签形态不认识，不敢动它"],
        ...(cls ? { classAttr: cls } : {}),
        ...(style ? { styleAttr: style } : {}),
      });
      visit(kid, key);
    }
  };
  visit(ast, null);
  return map;
}

function scanTemplate(
  file: string,
  fileText: string,
  ast: unknown,
  fileName: string,
): { hits: TplHit[]; idents: Map<string, Set<string>> } {
  const hits: TplHit[] = [];
  const idents = new Map<string, Set<string>>();
  const noteIdents = (page: string, exp: string): void => {
    const bag = idents.get(page) ?? new Set<string>();
    for (const name of exp.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? [])
      bag.add(name);
    idents.set(page, bag);
  };
  const fromExpression = (
    exp: { content: string; loc: { start: { offset: number } } },
    page: string,
    box: string | null,
    owner: string,
    kind: string,
    where: string,
  ): void => {
    noteIdents(page, exp.content);
    if (!HAN.test(exp.content)) return;
    for (const hit of scanScript(exp.content, exp.loc.start.offset, fileName)) {
      hits.push({
        offset: hit.offset,
        end: hit.end,
        raw: hit.raw,
        core: hit.core,
        page,
        container: box,
        owner,
        kind,
        where: where || hit.where,
        place: "literal",
        zone: "template",
      });
    }
  };
  const visit = (
    node: any,
    page: string,
    box: string | null,
    tag: string,
    owner: string,
  ): void => {
    if (node.type === NT.TEXT) {
      // raw 必须取自源码切片，不能使用 `node.content`：Vue 的解析器对文本节点做过空白压缩
      // （换行与缩进被合并为一个空格），用 content 核对源码会整条不匹配，表现为这些句子
      // 在落回时被静默拒绝，无法修改。
      const raw = fileText.slice(node.loc.start.offset, node.loc.end.offset);
      if (looksLikeCopy(raw, true)) {
        hits.push({
          offset: node.loc.start.offset,
          end: node.loc.end.offset,
          raw,
          core: flat(raw),
          page,
          container: box,
          owner,
          kind: "正文",
          where: `<${tag}>`,
          place: "text",
          zone: "template",
        });
      }
      return;
    }
    if (node.type === NT.INTERPOLATION) {
      fromExpression(node.content, page, box, owner, "插值", `<${tag}> {{ }}`);
      return;
    }
    if (node.type === NT.ELEMENT) {
      let branch = page;
      for (const prop of node.props ?? []) {
        if (
          prop.type === NT.DIRECTIVE &&
          ["if", "else-if"].includes(prop.name) &&
          prop.exp
        )
          branch = pageOf(prop.exp.content) ?? branch;
      }
      const nested = containerName(node) ?? box;
      const mine = elementKey(file, node.tag, node.loc.start.offset);
      // 总计 {{ n }} 次在 AST 中是三个兄弟节点。逐个生成条目只会得到总计与次两段，
      // 既看不出中间内容，也无法整体改写为其他表述。因此把整串文字与插值合成一条处理。
      // 插值自身含中文的（三元表达式的两种状态）不合并，那两句本应分别修改。
      const inline: any[] = node.children ?? [];
      const mergeable =
        inline.length > 1 &&
        inline.every(
          (child) => child.type === NT.TEXT || child.type === NT.INTERPOLATION,
        ) &&
        inline.some((child) => child.type === NT.INTERPOLATION) &&
        !inline.some(
          (child) =>
            child.type === NT.INTERPOLATION && HAN.test(child.content.content),
        );
      if (mergeable) {
        const offset = inline[0].loc.start.offset;
        const end = inline[inline.length - 1].loc.end.offset;
        const raw = fileText.slice(offset, end);
        if (looksLikeCopy(raw.replace(/\{\{[^}]*\}\}/g, ""), true)) {
          hits.push({
            offset,
            end,
            raw,
            core: flat(raw),
            page: branch,
            container: nested,
            owner: mine,
            kind: "正文",
            where: `<${node.tag}>`,
            place: "text",
            zone: "template",
          });
        }
      }
      for (const prop of node.props ?? []) {
        if (prop.type === NT.ATTRIBUTE) {
          if (
            !prop.value ||
            !COPY_ATTRS.has(prop.name) ||
            !looksLikeCopy(prop.value.content, false)
          )
            continue;
          hits.push({
            offset: prop.value.loc.start.offset,
            end: prop.value.loc.end.offset,
            raw: fileText.slice(
              prop.value.loc.start.offset,
              prop.value.loc.end.offset,
            ),
            core: flat(prop.value.content),
            page: branch,
            container: nested,
            owner: mine,
            place: "attr",
            zone: "template",
            attr: {
              offset: prop.loc.start.offset,
              end: prop.loc.end.offset,
              name: prop.name,
            },
            kind:
              prop.name === "aria-label"
                ? "无障碍"
                : prop.name === "title"
                  ? "悬停提示"
                  : prop.name === "placeholder"
                    ? "输入占位"
                    : prop.name === "empty"
                      ? "空态"
                      : "属性",
            where: `<${node.tag} ${prop.name}>`,
          });
        } else if (prop.type === NT.DIRECTIVE && prop.exp) {
          const arg = prop.arg?.content ?? prop.name;
          if (prop.name === "bind" && !COPY_ATTRS.has(arg)) {
            noteIdents(branch, prop.exp.content);
            continue;
          }
          fromExpression(
            prop.exp,
            branch,
            nested,
            mine,
            prop.name === "on"
              ? "交互"
              : arg === "aria-label"
                ? "无障碍"
                : arg === "title"
                  ? "悬停提示"
                  : arg === "empty"
                    ? "空态"
                    : "属性",
            `<${node.tag} :${arg}>`,
          );
        }
      }
      if (!mergeable)
        for (const child of inline)
          visit(child, branch, nested, node.tag, mine);
      return;
    }
    for (const child of node.children ?? [])
      visit(child, page, box, tag, owner);
  };
  for (const child of (ast as any).children ?? [])
    visit(child, "shell", null, "root", "");
  return { hits, idents };
}

// ── 逐文件抽取 ──────────────────────────────────────────────────────────
interface Sink {
  entries: Entry[];
  seen: Map<string, number>;
  withPins: boolean;
}
function push(
  sink: Sink,
  input: Omit<Entry, "id" | "line" | "slots" | "pinned"> & { fileText: string },
): void {
  const key = `${input.file} ${input.raw}`;
  const nth = (sink.seen.get(key) ?? 0) + 1;
  sink.seen.set(key, nth);
  const { fileText, ...rest } = input;
  sink.entries.push({
    ...rest,
    id: id6(input.file, input.raw, String(nth)),
    line: lineOf(fileText, input.offset),
    slots: slotsOf(input.core),
    pinned: pinsFor(input.core, sink.withPins),
  });
}

function extractVue(sink: Sink, file: string, surfacePrefix: string): void {
  const fileText = read(file);
  const { descriptor } = parseSfc(fileText, { filename: file });
  const short = file.split("/").pop() ?? file;
  let pageIdents = new Map<string, Set<string>>();
  if (descriptor.template?.ast) {
    // compiler-sfc 的模板 AST 使用整份文件的 offset；这里校验一次，不成立时整块跳过而非错位写回。
    const children = descriptor.template.ast.children as Array<{
      type: number;
      content?: string;
      loc: { start: { offset: number }; end: { offset: number } };
    }>;
    const probe = children.find(
      (child) => child.type === NT.TEXT && child.content?.trim(),
    );
    if (
      probe &&
      fileText.slice(probe.loc.start.offset, probe.loc.end.offset) !==
        probe.content
    )
      throw new Error(`${file}: 模板 offset 不是文件绝对量`);
    const { hits, idents } = scanTemplate(
      file,
      fileText,
      descriptor.template.ast,
      short,
    );
    pageIdents = idents;
    for (const hit of hits) {
      push(sink, {
        ...hit,
        file,
        fileText,
        surface: `${surfacePrefix}${hit.container ? "dialogs" : hit.page}`,
        where: hit.container ? `〔${hit.container}〕${hit.where}` : hit.where,
      });
    }
  }
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    for (const hit of scanScript(
      block.content,
      block.loc.start.offset,
      short,
    )) {
      // 顶层声明仅被一个页面引用时归入该页面，否则归入 shared，以免单页文案不完整。
      const owners = [...pageIdents]
        .filter(([, bag]) => bag.has(hit.top))
        .map(([page]) => page);
      const page =
        owners.length === 1
          ? owners[0]
          : owners.length === 0
            ? "script"
            : "shared";
      push(sink, {
        ...hit,
        file,
        fileText,
        surface: `${surfacePrefix}${page}`,
        place: "literal",
        zone: "script",
        where: `${hit.top === "top" ? "" : `${hit.top} · `}${hit.where}`,
      });
    }
  }
}

function extractTs(
  sink: Sink,
  file: string,
  surface: string,
  routeAware: boolean,
): void {
  const fileText = read(file);
  const source = ts.createSourceFile(
    file,
    fileText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes: Array<{ start: number; end: number; path: string }> = [];
  if (routeAware) {
    const collect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(get|post|put|patch|delete|all|use)$/.test(
          node.expression.name.text,
        ) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        routes.push({
          start: node.getStart(source),
          end: node.end,
          path: `${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`,
        });
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(source, collect);
  }
  for (const hit of scanScript(fileText, 0, file)) {
    const route = routes
      .filter((r) => r.start <= hit.offset && hit.offset < r.end)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .at(-1);
    push(sink, {
      ...hit,
      file,
      fileText,
      surface,
      place: "literal",
      zone: "script",
      kind: /apiError\(\)/.test(hit.where) ? "报错" : hit.kind,
      where: route ? `${route.path} · ${hit.where}` : hit.where,
    });
  }
}

/** 可在浏览器中运行的那些文件，dev 面板只能为它们提供即时预览。 */
export const BROWSER_FILES = [
  "packages/webui/src/App.vue",
  "packages/webui/src/views/ConsoleView.vue",
  "packages/webui/src/views/ExtensionsPage.vue",
  "packages/webui/src/views/LoginView.vue",
  "packages/webui/src/views/TasksPage.vue",
  "packages/webui/src/views/WorkerRunsPage.vue",
  "packages/webui/src/views/SdkPage.vue",
  ...readdirSync("packages/webui/src/ui")
    .filter((n) => n.endsWith(".vue"))
    .map((n) => `packages/webui/src/ui/${n}`),
  ...readdirSync("packages/webui/src/components/extensions")
    .filter((n) => n.endsWith(".vue"))
    .map((n) => `packages/webui/src/components/extensions/${n}`),
  ...readdirSync("packages/webui/src/components/tasks")
    .filter((n) => n.endsWith(".vue"))
    .map((n) => `packages/webui/src/components/tasks/${n}`),
  ...readdirSync("packages/webui/src/components/workers")
    .filter((n) => n.endsWith(".vue"))
    .map((n) => `packages/webui/src/components/workers/${n}`),
  ...readdirSync("packages/webui/src/components/sdk")
    .filter((n) => n.endsWith(".vue"))
    .map((n) => `packages/webui/src/components/sdk/${n}`),
  "packages/webui/src/components/extensions/types.ts",
  "packages/webui/src/components/tasks/types.ts",
  "packages/webui/src/components/workers/types.ts",
  "packages/webui/src/components/sdk/types.ts",
  "packages/webui/src/api/client.ts",
  "packages/webui/src/ui/toast.ts",
  "packages/webui/src/ui/confirm.ts",
  "packages/webui/src/main.ts",
];

/**
 * 移除被其他条目整段包含的那些。
 *
 * `` `${cause instanceof Error ? cause.message : '请求失败'}——一次性登录链接 5 分钟有效……` ``
 * 这一句中，TS AST 会同时给出外层模板串与内层的 `'请求失败'`。两者范围重叠：插桩时替换内层后，
 * 外层记录的 offset 即错位，替换结果是一段语法不成立的代码（LoginView 那次即如此）。
 * 保留外层：它才是用户读到的完整句子，内层只是其中一个片段。
 */
function dropNested(entries: Entry[]): Entry[] {
  return entries.filter(
    (entry) =>
      !entries.some(
        (other) =>
          other !== entry &&
          other.offset <= entry.offset &&
          entry.end <= other.end &&
          other.end - other.offset > entry.end - entry.offset,
      ),
  );
}

/** 单个文件的条目，供 dev 面板按文件插桩使用，不计算钉住关系（那需要扫描 docs 与 tests，开销过大）。 */
export function extractFile(file: string): Entry[] {
  const sink: Sink = { entries: [], seen: new Map(), withPins: false };
  const prefix = file.includes("/views/ConsoleView")
    ? "console-"
    : file.includes("ExtensionsPage") ||
        file.includes("/components/extensions/")
      ? "extensions-"
      : file.includes("TasksPage") || file.includes("/components/tasks/")
        ? "tasks-"
        : file.includes("SdkPage") || file.includes("/components/sdk/")
          ? "sdk-"
          : file.includes("LoginView")
            ? "login-"
            : "ui-";
  if (file.endsWith(".vue")) extractVue(sink, file, prefix);
  else extractTs(sink, file, `${prefix}script`, false);
  return dropNested(sink.entries);
}

/** 出现多于一次的 id。空集是常态，非空说明 `id6` 的位数已不够用。 */
export function duplicateIds(entries: Entry[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const entry of entries)
    if (seen.has(entry.id)) twice.add(entry.id);
    else seen.add(entry.id);
  return twice;
}

export function extractAll(): Entry[] {
  const sink: Sink = { entries: [], seen: new Map(), withPins: true };
  extractVue(sink, "packages/webui/src/App.vue", "ui-");
  extractVue(sink, "packages/webui/src/views/ConsoleView.vue", "console-");
  extractVue(
    sink,
    "packages/webui/src/views/ExtensionsPage.vue",
    "extensions-",
  );
  extractVue(sink, "packages/webui/src/views/LoginView.vue", "login-");
  extractVue(sink, "packages/webui/src/views/TasksPage.vue", "tasks-");
  for (const name of readdirSync("packages/webui/src/ui").filter((n) =>
    n.endsWith(".vue"),
  ))
    extractVue(sink, `packages/webui/src/ui/${name}`, "ui-");
  for (const name of readdirSync(
    "packages/webui/src/components/extensions",
  ).filter((n) => n.endsWith(".vue")))
    extractVue(
      sink,
      `packages/webui/src/components/extensions/${name}`,
      "extensions-",
    );
  for (const name of readdirSync("packages/webui/src/components/tasks").filter(
    (n) => n.endsWith(".vue"),
  ))
    extractVue(sink, `packages/webui/src/components/tasks/${name}`, "tasks-");
  extractVue(sink, "packages/webui/src/views/SdkPage.vue", "sdk-");
  for (const name of readdirSync("packages/webui/src/components/sdk").filter(
    (n) => n.endsWith(".vue"),
  ))
    extractVue(sink, `packages/webui/src/components/sdk/${name}`, "sdk-");
  extractTs(
    sink,
    "packages/webui/src/components/extensions/types.ts",
    "extensions-labels",
    false,
  );
  extractTs(
    sink,
    "packages/webui/src/components/tasks/types.ts",
    "tasks-labels",
    false,
  );
  extractTs(
    sink,
    "packages/webui/src/components/sdk/types.ts",
    "sdk-labels",
    false,
  );
  extractTs(sink, "packages/webui/src/api/client.ts", "ui-plumbing", false);
  extractTs(sink, "packages/webui/src/ui/toast.ts", "ui-plumbing", false);
  extractTs(sink, "packages/webui/src/ui/confirm.ts", "ui-plumbing", false);
  extractTs(sink, "packages/webui/src/main.ts", "ui-plumbing", false);
  extractTs(sink, "packages/server/src/app.ts", "api-errors", true);
  extractTs(
    sink,
    "packages/core/src/config/descriptions.ts",
    "config-descriptions",
    false,
  );
  const html = read("packages/webui/index.html");
  const title = /<title>([^<]+)<\/title>/.exec(html);
  const heading = title?.[1] ?? "";
  if (title && heading) {
    push(sink, {
      file: "packages/webui/index.html",
      fileText: html,
      offset: title.index + "<title>".length,
      end: title.index + "<title>".length + heading.length,
      raw: heading,
      core: heading,
      surface: "ui-plumbing",
      kind: "浏览器标题",
      where: "<title>",
      place: "text",
      zone: "script",
    });
  }
  // 同一个文件内部才可能重叠，跨文件的 offset 互不相干。
  const byFile = new Map<string, Entry[]>();
  for (const entry of sink.entries)
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  return [...byFile.values()].flatMap(dropNested);
}

/** 一个 SFC 中的所有模板元素。key 只在源码未变期间稳定，每次改动后需重新获取。 */
export function elements(file: string): Map<string, ElementInfo> {
  if (!file.endsWith(".vue")) return new Map();
  const fileText = read(file);
  const { descriptor } = parseSfc(fileText, { filename: file });
  if (!descriptor.template?.ast) return new Map();
  return walkElements(file, fileText, descriptor.template.ast);
}

/** 元素当前的拖拽偏移（源码中 `style="translate: …"` 那一条）。不存在时为 0,0。 */
export function translateOf(info: ElementInfo): { dx: number; dy: number } {
  const found = /(?:^|;)\s*translate\s*:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(
    info.styleAttr?.value ?? "",
  );
  return { dx: Number(found?.[1] ?? 0), dy: Number(found?.[2] ?? 0) };
}
/**
 * 字号档位的基准（源码中 `style="--u-base: 13.3px"` 那一条）。不存在时为 null。
 *
 * 字号需要存储基准的原因：`.u-size-lg { font-size: 1.12em }` 中的 `em` 取的是父级
 * 字号而非元素自身字号。实测该界面上一个 64px 的 `<h1>`（父级 16px）选择放大后会缩至 17.9px，
 * 与按钮标注的效果相反。因此档位定义为基准乘以倍数：基准由面板测量元素自身字号一次并写入
 * 内联样式，倍数由 class 决定。这样连续点击不会叠加（倍数是替换的），而 CSS 中没有任何单位能
 * 表达元素当前字号的 1.12 倍。
 */
export function basisOf(info: ElementInfo): number | null {
  const found = /(?:^|;)\s*--u-base\s*:\s*([\d.]+)px/.exec(
    info.styleAttr?.value ?? "",
  );
  return found ? Number(found[1]) : null;
}
/** 一个元素当前挂着哪些工具类，按组给出。 */
export function utilitiesOf(
  info: ElementInfo,
): Partial<Record<UtilityGroup, string>> {
  const tokens = (info.classAttr?.value ?? "").split(/\s+/).filter(Boolean);
  const out: Partial<Record<UtilityGroup, string>> = {};
  for (const [group, spec] of Object.entries(UTILITIES) as Array<
    [UtilityGroup, (typeof UTILITIES)[UtilityGroup]]
  >) {
    const hit = spec.values.find((value) =>
      tokens.includes(`${spec.prefix}-${value}`),
    );
    if (hit) out[group] = hit;
  }
  return out;
}

// ── 计算新属性值：纯函数，不写入任何文件 ──────────────────────────────────
/** 工具类：同组互斥，空值即清除该组。 */
export function classValue(
  current: string,
  group: UtilityGroup,
  value: string,
): string {
  const spec = UTILITIES[group];
  const tokens = current
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (token) =>
        !spec.values.some((each) => token === `${spec.prefix}-${each}`),
    );
  if (value) tokens.push(`${spec.prefix}-${value}`);
  return tokens.join(" ");
}
/**
 * 内联样式：按名称设置或清除若干条声明，其余原样保留、顺序不变。值为 null 即移除该条。
 *
 * 同一元素上可能同时存在拖拽偏移与字号基准，必须一次性计算完成：分两次计算时，第二次基于
 * 源码中已过期的值，写入时又指向同一段源码，导致后一条被判为重叠而丢弃。
 */
export function styleValue(
  current: string,
  patch: Record<string, string | null>,
): string {
  const names = Object.keys(patch);
  const kept = current
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !names.includes(part.split(":")[0]?.trim() ?? ""));
  for (const name of names) {
    const value = patch[name];
    if (value) kept.push(`${name}: ${value}`);
  }
  return kept.join("; ");
}
/**
 * 拖拽偏移写入元素自身的 `translate`。
 *
 * 使用独立的 `translate` 属性而非 `transform` 的原因：`styles.css` 中有 16 处
 * `transform: translate`、10 处 `scale`、3 处 `rotate`，按钮按压反馈（`scale(.97)`）、
 * 入场动画（`rise-in`）、页面过渡都在使用 `transform`。写入内联 `transform` 会整条覆盖它们；
 * 而 `translate` 是独立的变换属性，与 `transform` 叠加而非互斥，全仓未使用。
 *
 * 偏移采用固定像素：这套界面存在响应式断点，切换宽度后偏移量不变。小幅微调正是预期效果，
 * 大幅位移则确实会在其他宽度下错位。`0,0` 视为归位，连同声明一并移除（返回 null）。
 */
export const translateValue = (dx: number, dy: number): string | null =>
  Math.round(dx) === 0 && Math.round(dy) === 0
    ? null
    : `${Math.round(dx)}px ${Math.round(dy)}px`;

/**
 * 删除的作用范围。整行只有该元素时，连同缩进与行尾换行一并移除：只删元素本身会留下一行
 * 空白缩进，删除三处即产生三行空白，效果比保留该元素更差。与其他内容同行时只移除元素自身那一段。
 */
function lineWise(
  text: string,
  range: { start: number; end: number },
): { at: number; to: number } {
  const lineStart = text.lastIndexOf("\n", range.start - 1) + 1;
  if (text.slice(lineStart, range.start).trim())
    return { at: range.start, to: range.end };
  const lineEnd = text.indexOf("\n", range.end);
  if (lineEnd >= 0 && !text.slice(range.end, lineEnd).trim())
    return { at: lineStart, to: lineEnd + 1 };
  return { at: lineStart, to: range.end };
}

// ── 落盘：全仓唯一的写入入口 ────────────────────────────────────────────────
/** 一项待保存的改动。三种形态各自指向源码中的一个位置。 */
export type Change =
  /** 修改一句文案。`id` 是 `extractAll()` 的条目 id。 */
  | { kind: "text"; file: string; id: string; value: string }
  /** 贴边 / 对齐 / 间距 / 字号 / 字重 / 斜体 / 隐藏。`key` 是 `elements()` 的元素 key。 */
  | {
      kind: "class";
      file: string;
      key: string;
      group: UtilityGroup;
      value: string;
    }
  /** 自由拖拽的偏移。 */
  | { kind: "style"; file: string; key: string; dx: number; dy: number }
  /** 字号档位的基准（见 `basisOf`）。`px` 为 null 时连同声明一并移除。 */
  | { kind: "basis"; file: string; key: string; px: number | null }
  /** 将该元素从模板中实际移除。`ElementInfo.guards` 非空时一律拒绝。 */
  | { kind: "remove"; file: string; key: string };

interface Splice {
  at: number;
  to: number;
  text: string;
}

/**
 * 把一批暂存改动写回源码。这是唯一写文件的位置：面板上的编辑、贴边、拖拽都只修改 DOM 预览，
 * 点击保存后才执行到这里。
 *
 * 一次性计算完再一次性写入的原因：所有 offset 都是相对同一份原文测量的。逐条写盘时，第一条写入后
 * 其后所有 offset（以及元素 key）全部失效，第二条要么找不到位置、要么切在错误位置。因此每个文件只读一次、
 * 将改动折算成互不重叠的 splice、按 offset 降序一次写完。
 *
 * 返回改动前的文件内容，供撤销上次保存使用。
 */
export function applyChanges(changes: Change[]): {
  applied: number;
  refused: string[];
  stuck: string[];
  before: Record<string, string>;
} {
  const all = extractAll();
  const entries = new Map(all.map((entry) => [entry.id, entry]));
  /**
   * 碰撞的 id 一律拒绝，不做推测。`new Map` 碰撞时保留的是后写入的那一条，而两条 entry 的
   * `offset`/`end` 指向源码中完全不同的两段：按错误的那段 splice 后，用户修改的是 A、实际被改写的是 B，
   * 而 A 的原文仍在。这正是摘除比伪造安全要防的形态（docs/16 §5）：宁可本次保存失败。
   * 改用 12 位 hash 之后这里实际上不应再命中，保留它是因为静默写错的代价远高于拒绝。
   */
  const collided = duplicateIds(all);
  const byFile = new Map<string, Change[]>();
  for (const change of changes)
    byFile.set(change.file, [...(byFile.get(change.file) ?? []), change]);
  const refused: string[] = [];
  /**
   * 未生效的改动分别指向何处（文案条目 id 与元素 key）。`refused` 是供人阅读的说明，
   * 面板无法据此判断应保留哪几条暂存，而清除错误的代价是用户刚输入的内容丢失。
   * 被删除范围覆盖的不计入：那些改动已无意义，保留只会阻碍下一次保存。
   */
  const stuck: string[] = [];
  const before: Record<string, string> = {};
  let applied = 0;
  for (const [file, list] of byFile) {
    const text = read(file);
    const els = elements(file);
    const splices: Splice[] = [];
    /** 同一元素上新插入的 `class` 与 `style` 落在同一位置，需合成一条，否则第二条会被判为重叠而丢弃。 */
    const inserts = new Map<number, string[]>();
    /** 实际删除单独收集：它的范围会整段覆盖其他改动，需在排序之前先移除那些改动。 */
    const removals: Array<{ at: number; to: number; key: string }> = [];
    /** 元素 key → 该元素上累积的 class 档位与内联声明。折算在循环之后统一进行。 */
    const patches = new Map<
      string,
      {
        info: ElementInfo;
        classes: Array<[UtilityGroup, string]>;
        style: Record<string, string | null>;
      }
    >();
    const patchOf = (
      info: ElementInfo,
    ): {
      info: ElementInfo;
      classes: Array<[UtilityGroup, string]>;
      style: Record<string, string | null>;
    } => {
      const found = patches.get(info.key) ?? { info, classes: [], style: {} };
      patches.set(info.key, found);
      return found;
    };
    for (const change of list) {
      if (change.kind === "text") {
        if (collided.has(change.id)) {
          refused.push(
            `${change.id}：这个 id 被两条文案共用，改哪一条都可能写到另一条上，不改`,
          );
          stuck.push(change.id);
          continue;
        }
        const entry = entries.get(change.id);
        if (!entry || entry.file !== file) {
          refused.push(`${change.id}：源码里找不着这一条（重新扫描一次）`);
          stuck.push(change.id);
          continue;
        }
        // 大括号内侧的空白统一规整为记录中的形式（`{{n}}` → `{{ n }}`），落盘的即规整后的版本，
        // 否则源码中会出现同一占位的四种写法。
        const next = canonicalSlots(
          change.value.trim().replace(/\\n/g, "\n"),
          entry.slots,
        );
        if (!next) continue;
        const missing = missingSlots(next, entry.core, entry.slots);
        if (missing.length) {
          refused.push(
            `${entry.core.slice(0, 12)}…：少了插值 ${missing.join(" ")}，不改`,
          );
          stuck.push(change.id);
          continue;
        }
        if (text.slice(entry.offset, entry.end) !== entry.raw) {
          refused.push(`${file}:${entry.line} 的原文与记录对不上，跳过`);
          stuck.push(change.id);
          continue;
        }
        const quote = /^['"`]/.test(entry.raw) ? (entry.raw[0] ?? "") : "";
        const lead = quote
          ? ""
          : entry.raw.slice(0, entry.raw.length - entry.raw.trimStart().length);
        const tail = quote ? "" : entry.raw.slice(entry.raw.trimEnd().length);
        const body =
          quote === "'" || quote === '"'
            ? next.replaceAll(quote, `\\${quote}`)
            : next;
        splices.push({
          at: entry.offset,
          to: entry.end,
          text: `${quote}${lead}${body}${tail}${quote}`,
        });
        applied += 1;
        continue;
      }
      const info = els.get(change.key);
      if (!info) {
        refused.push(
          `${change.kind === "class" ? "版式" : change.kind === "remove" ? "删除" : "拖拽"}：找不到目标元素（重新扫描一次）`,
        );
        stuck.push(change.key);
        continue;
      }
      if (change.kind === "remove") {
        if (info.guards.length) {
          refused.push(`<${info.tag}> 删不了：${info.guards.join("；")}`);
          stuck.push(change.key);
          continue;
        }
        if (
          text.slice(
            info.range.start,
            info.range.start + 1 + info.tag.length,
          ) !== `<${info.tag}`
        ) {
          refused.push(
            `<${info.tag}> 的位置与记录对不上，不敢删（重新扫描一次）`,
          );
          stuck.push(change.key);
          continue;
        }
        removals.push({ ...lineWise(text, info.range), key: change.key });
        applied += 1;
        continue;
      }
      // 档位必须是该组中确实存在的那几个：写入一个 `u-gap-x-99` 等于向源码塞入一个没有规则的 token。
      if (
        change.kind === "class" &&
        change.value &&
        !UTILITIES[change.group].values.includes(change.value as never)
      ) {
        refused.push(`${change.group} 没有 ${change.value} 这一档`);
        stuck.push(change.key);
        continue;
      }
      const patch = patchOf(info);
      if (change.kind === "class")
        patch.classes.push([change.group, change.value]);
      else if (change.kind === "style")
        patch.style["translate"] = translateValue(change.dx, change.dy);
      else
        patch.style["--u-base"] = change.px
          ? `${Math.round(change.px * 10) / 10}px`
          : null;
      // `basis` 不计入计数：它是字号档位的附属项，而非用户的第三项操作。计入后调整一次字号会报告写回 2 处。
      if (change.kind !== "basis") applied += 1;
    }
    /**
     * 每个元素、每个属性折算出一份最终值后只写入一次。
     *
     * 逐条写入是错误的：一个元素同时修改字号与字重（面板上很常见）会计算出两次 `class` 值，两者
     * 都基于源码中的旧值，写入时又都指向同一段源码，结果要么后一条被判为重叠而丢弃，要么在
     * 元素上插入两个 `class` 属性。同一元素上的 `translate` 与 `--u-base` 同理。
     */
    for (const { info, classes, style } of patches.values()) {
      const write = (
        attribute: "class" | "style",
        existing: ElementInfo["classAttr"],
        value: string,
      ): void => {
        if (!existing) {
          if (!value) return;
          if (info.attrInsert < 0) {
            refused.push(`<${info.tag}> 的开标签形态不认识，不敢往里插属性`);
            stuck.push(info.key);
            return;
          }
          inserts.set(info.attrInsert, [
            ...(inserts.get(info.attrInsert) ?? []),
            `${attribute}="${value}"`,
          ]);
          return;
        }
        if (!value) {
          // 清空时连同属性一并移除（含前面的空格），这样设置后再清除能回到完全相同的源码。
          const from =
            text[existing.offset - 1] === " "
              ? existing.offset - 1
              : existing.offset;
          splices.push({ at: from, to: existing.end, text: "" });
          return;
        }
        splices.push({
          at: existing.valueOffset,
          to: existing.valueEnd,
          text: value,
        });
      };
      if (classes.length) {
        let value = info.classAttr?.value ?? "";
        for (const [group, tier] of classes)
          value = classValue(value, group, tier);
        write("class", info.classAttr, value);
      }
      if (Object.keys(style).length)
        write(
          "style",
          info.styleAttr,
          styleValue(info.styleAttr?.value ?? "", style),
        );
    }
    /**
     * 删除的范围会整段覆盖落在其中的改动（同一元素内的一句文案、它自身的工具类）。
     * 那些改动已无意义，直接丢弃，但需要相应扣减计数，否则写回 3 处中会有两处
     * 实际来自同一次删除。AST 范围要么包含要么互斥，因此只需判断包含关系。
     * 嵌套删除同理：删除父级后无需再删子级，只保留最外层的那一个。
     */
    const outer = removals.filter(
      (each) =>
        !removals.some(
          (other) =>
            other !== each &&
            other.at <= each.at &&
            each.to <= other.to &&
            (other.at !== each.at || other.to !== each.to),
        ),
    );
    const eaten = (at: number, to: number): boolean =>
      outer.some((each) => each.at <= at && to <= each.to);
    const kept: Splice[] = [];
    for (const splice of splices) {
      if (eaten(splice.at, splice.to)) applied -= 1;
      else kept.push(splice);
    }
    for (const [at, parts] of inserts) {
      if (eaten(at, at)) applied -= parts.length;
      else kept.push({ at, to: at, text: ` ${parts.join(" ")}` });
    }
    for (const each of outer) kept.push({ at: each.at, to: each.to, text: "" });
    applied -= removals.length - outer.length;
    let next = text;
    let floor = text.length;
    for (const splice of kept.sort((a, b) => b.at - a.at || b.to - a.to)) {
      if (splice.to > floor) {
        refused.push(`${file}: 两处改动落在同一段源码上，后一处跳过`);
        continue;
      }
      next = `${next.slice(0, splice.at)}${splice.text}${next.slice(splice.to)}`;
      floor = splice.at;
    }
    if (next === text) continue;
    before[file] = text;
    writeFileSync(file, next);
  }
  return { applied, refused, stuck, before };
}

/** 撤销上次保存：将整批文件按快照写回。 */
export function restore(snapshot: Record<string, string>): string[] {
  const done: string[] = [];
  for (const [file, text] of Object.entries(snapshot)) {
    if (!BROWSER_FILES.includes(file) && !file.startsWith("packages/"))
      continue;
    writeFileSync(file, text);
    done.push(file);
  }
  return done;
}
