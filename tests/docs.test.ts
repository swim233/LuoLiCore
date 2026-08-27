import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_UNIMPLEMENTED_CONFIG_KEYS, TOOL_POLICY, configJsonSchema, configSchemaLeafPaths } from '@luoli/core';
import { describe, expect, it } from 'vitest';

/**
 * 让文档库的「活 / 死」分层说话算数。
 *
 * 背景：`docs/reviews/` 那十轮复审是历史快照，但它们**删不掉** —— 大量源码注释拿条目编号
 * （`docs/20 · W-SEC-02` 那种）当「这行为什么长这样」的凭据。凭据的问题在于它没有任何东西
 * 保证还指得着：删一条、改一次编号、挪一个文件，注释就静静变成一句空话，而空话看起来和
 * 真凭据一模一样。前两条断言把这件事焊住。
 *
 * 第三条管的是另一个方向：🚧 是「还没接线」的信号，运维和下一轮复审都靠 grep 它来数账。
 * 一旦历史快照里也留着 🚧，grep 出来的就是活账混着九轮的鬼影 —— 第七轮就是这么被迫
 * 「把 25 份文档里所有 🚧 逐条查干净」的（`docs/reviews/25`）。所以状态标记位置的 🚧
 * 只允许出现在活文档里，复审层要么不写，要么写成过去时。
 */

const SRC_ROOTS = ['packages', 'apps', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/**
 * 状态标记位置的 🚧：行首，或**任意**表格单元格的开头。行内的（「在 docs/11 标 🚧」这类叙述）不算。
 *
 * 原来只认行首与第一格，于是 `docs/21` 那四条未接线缺口因为写在表格**最后一格**，整份文档的活账
 * 事实上不在任何判据的视野里 —— 一道判据管不到它本该管的地方，和没有这道判据是同一个答案。
 */
const STATUS_MARKER = /(?:^|\|)\s*🚧/;
/** `🚧「…」` 是**引文**（复审报告引当时文档的原话，见 `reviews/25 §1`），不是活标记。 */
const MARKER_QUOTED = /🚧\s*[「"“]/;
/** 活文档里允许挂 🚧 的三处：配置手册的未接线表、当前态清单、WebUI 缺口台账。 */
const MARKER_ALLOWED = new Set([
  'docs/00-state.md',
  'docs/11-config-reference.md',
  'docs/21-webui-coverage-gaps.md',
]);
const FROZEN_HEADER = '❄️ **已冻结（';
/** 复审条目编号的形状：`W-CFG-02` `L-OPS-01` `AC-SEC-011` —— 至少一个连字符。 */
const ENTRY_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

const sources = SRC_ROOTS.flatMap(walk).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const docs = [
  ...readdirSync('docs').filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  ...readdirSync('docs/reviews').filter((name) => name.endsWith('.md')).map((name) => `docs/reviews/${name}`),
].map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** `docs/20` → 实际文件，无论它在 `docs/` 还是 `docs/reviews/`。编号即身份，位置可以变。 */
const byNumber = new Map(docs.flatMap((doc) => {
  const number = /(?:^|\/)(\d{2})-/.exec(doc.path)?.[1];
  return number ? [[number, doc.path] as const] : [];
}));

describe('文档溯源', () => {
  it('源码注释里的 docs/NN 都指得着', () => {
    const dangling: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/docs\/(\d{2})/g)) {
        if (!byNumber.has(match[1]!)) dangling.push(`${path} → docs/${match[1]}`);
      }
    }
    expect(dangling, '这些注释引用了不存在的文档编号').toEqual([]);
  });

  it('源码注释里引用的复审条目编号都还在文档里', () => {
    // 只认 `· ` 之后的编号——那是既有的引用约定（`docs/22 · V-SSRF-01`）。不要求编号落在
    // 紧邻的那份文档里：`docs/05 §5.2 · W-SBX-02` 是「规格出处 · 复审条目」的混合形态，
    // `docs/22 · N-CFG-02 一脉` 是跨轮旁引，两种都合法。要保证的只是**条目还存在**。
    //
    // 判据按**词**比，不是按子串。此前用 `corpus.includes(id)`，于是 `S-01` 被 `L-OPS-01` 满足、
    // `I-01` 被 `D-UI-01` 满足、`T-02`–`T-05` 被 `L-EXT-02`–`05` 满足 —— `reviews/27` 整个
    // `S-*`/`T-*` 家族与 `reviews/22` 整个 `I-*` 家族因此一条都没被保护住：删掉它们判据照样绿，
    // 而注释已经指空。改成词边界之后当天零悬空（既有引用全部真的指得着），**收紧不花任何代价**，
    // 买的是「哪天真删了会响」。
    const defined = new Set<string>();
    for (const { text } of docs) for (const match of text.matchAll(ENTRY_ID)) defined.add(match[0]);
    const dangling: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/·\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/g)) {
        if (!defined.has(match[1]!)) dangling.push(`${path} → ${match[1]}`);
      }
    }
    expect(dangling, '这些条目编号已从文档里消失，注释成了空凭据').toEqual([]);
  });

  /**
   * 缺口台账的编号唯一性。**这条是补的，不是预防的** —— `G-API-15` 与 `G-API-16` 曾各自定义两次，
   * 指着毫不相干的两件事，而 `app.ts` / `SchedulesCard.vue` / `schedule.api.test.ts` 三处注释写着
   * `G-API-16`、光看编号分不出指哪一条。
   *
   * 只判 `docs/21` 内部：跨文件「撞号」绝大多数是**跨轮复列**（`16` 复列 `15` 的批次、`23`/`24`
   * 复核 `22` 的条目），那是既定工作流，拿去当撞号会报出 78 条噪声。而冻结层里真正的撞号
   * （`R-TG-01` 在 `19` 与 `24`、`G-EXT-0x` 在 `15` 与 `21`）**改不了也测不了**，只能记 ——
   * 记在 `docs/README §0.1` 的警示表里，引用时必须带文档号。
   */
  /**
   * 台账正文（`## 1.` 之后）。`## 0.` 那几节是**索引**，按定义就是副本，不参与「唯一性」判据 ——
   * 拿副本当定义的话，一张为了「不必从头翻」而加的索引表反而会把整道闸判红。
   */
  const ledgerBody = (): string => {
    const ledger = docs.find((doc) => doc.path === 'docs/21-webui-coverage-gaps.md');
    expect(ledger, 'docs/21 不见了').toBeTruthy();
    const at = ledger!.text.indexOf('\n## 1.');
    expect(at, 'docs/21 里找不到 `## 1.` —— 索引与台账的分界线没了，判据坏了').toBeGreaterThan(0);
    return ledger!.text.slice(at);
  };
  /** 台账里的定义行：表格第一格就是编号。返回 编号 → 该行的状态格。 */
  const ledgerRows = (): Map<string, { lines: number[]; last: string }> => {
    const rows = new Map<string, { lines: number[]; last: string }>();
    for (const [index, line] of ledgerBody().split('\n').entries()) {
      const id = /^\|\s*\*{0,2}`?(G-[A-Z]+-\d+)`?\*{0,2}\s*\|/.exec(line)?.[1];
      if (!id) continue;
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      const entry = rows.get(id) ?? { lines: [], last: cells.at(-1) ?? '' };
      entry.lines.push(index + 1);
      rows.set(id, entry);
    }
    return rows;
  };

  it('docs/21 的缺口编号在文档内唯一', () => {
    const rows = ledgerRows();
    expect(rows.size, '一个 G-* 表行都没解析出来，判据坏了').toBeGreaterThan(40);
    const dup = [...rows].filter(([, r]) => r.lines.length > 1).map(([id, r]) => `${id} → 行 ${r.lines.join(', ')}`);
    expect(dup, '同一个缺口编号登记了两次 —— 源码注释引它时分不出指哪一条，给后来那条换个新号').toEqual([]);
  });

  /**
   * `docs/21 §0`「现在还开着什么」那张索引表必须等于台账里所有**未闭合**的行。
   *
   * 索引是副本，而这份文档自己的教训就是「同一个事实有两份副本，迟早会漂」—— 加索引是为了
   * 让最新的缺口不再排在第 800 多行没人翻得到（`G-UI-05` / `G-UI-06` 都出过这事），
   * 但一张会过期的索引比没有索引更坏：它看起来权威。所以它由这条断言维持。
   */
  it('docs/21 §0 的「还开着」索引与台账一致', () => {
    const open = [...ledgerRows()].filter(([, r]) => !r.last.includes('✅')).map(([id]) => id).sort();
    const ledger = docs.find((doc) => doc.path === 'docs/21-webui-coverage-gaps.md')!.text;
    const index = ledger.slice(0, ledger.indexOf('\n## 1.'));
    const listed = [...new Set([...index.matchAll(/^\|\s*`(G-[A-Z]+-\d+)`\s*\|/gm)].map((m) => m[1]!))].sort();
    expect(listed, 'docs/21 §0 那张「现在还开着什么」与台账对不上 —— '
      + `台账里未闭合的是 [${open.join(', ')}]。闭合一条就要从 §0 摘掉，新增一条就要加进去`).toEqual(open);
  });
});

/**
 * `docs/10 §2` 那张 kind 表与实现的**双向**焊接。
 *
 * 背景：上一轮实测「表里写了源码零发出 19 个、源码在发表里没有约 35 个（含全库 78% 的
 * `tg.api`）」，而 `docs/13` 的 `AC-LOG-001` 按字面永远不可能通过（docs/28 · L-LOG-01）。
 * 两个方向都要挡：只挡一边的话，「文档写了没实现」和「实现了没写」各能漂回去一半。
 */
const LOG_DOC = 'docs/10-logging-and-observability.md';
/** 表格所在的那一节。`## 3.` 之后是落盘格式，不再有 kind 表。 */
const KIND_SECTION = /^## 2\. 事件种类[\s\S]*?(?=^## 3\.)/m;
/**
 * 从 `at` 处那个引号开始，返回字符串 / 模板串结束引号的下标。
 * 模板串里的 `${...}` 能嵌任意代码（括号、花括号、别的引号），整段跳过。
 */
function skipString(text: string, at: number): number {
  const quote = text[at];
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === quote) return index;
    if (quote === '`' && text[index] === '$' && text[index + 1] === '{') {
      let depth = 1; index += 2;
      for (; index < text.length && depth; index += 1) {
        if (text[index] === '{') depth += 1;
        else if (text[index] === '}') depth -= 1;
        else if (text[index] === '"' || text[index] === "'" || text[index] === '`') index = skipString(text, index);
      }
      index -= 1;
    }
  }
  return text.length;
}

/** 从 `index` 起该跳过多少：字符串、行注释、块注释各自的长度；不是这三种回 0。 */
function skippable(text: string, index: number): number {
  const char = text[index]!;
  if (char === '"' || char === "'" || char === '`') return skipString(text, index) - index + 1;
  if (char === '/' && text[index + 1] === '/') { const nl = text.indexOf('\n', index); return nl < 0 ? text.length - index : nl - index; }
  if (char === '/' && text[index + 1] === '*') { const close = text.indexOf('*/', index); return close < 0 ? text.length - index : close + 2 - index; }
  return 0;
}

/**
 * `open` 处那个 `{` 对应的对象字面量全文。
 * 裸数花括号会被字符串里的括号带偏（`summary: \`Turn ${id} started (queued)\`` 就有一对），
 * 所以字符串、模板串、两种注释都要跳过。
 */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const skip = skippable(text, index);
    if (skip) { index += skip - 1; continue; }
    const char = text[index]!;
    if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (!depth) return text.slice(open, index + 1); }
  }
  return '';
}

/** 对象字面量的**顶层**属性 → 属性值原文。嵌到 `data: {...}` 里的同名键不算。 */
function topLevelProps(object: string): Map<string, string> {
  const props = new Map<string, string>();
  let depth = 0;
  for (let index = 0; index < object.length; index += 1) {
    const skip = skippable(object, index);
    if (skip) { index += skip - 1; continue; }
    const char = object[index]!;
    if (char === '{' || char === '[' || char === '(') { depth += 1; continue; }
    if (char === '}' || char === ']' || char === ')') { depth -= 1; continue; }
    if (depth !== 1) continue;
    const name = /^([A-Za-z_$][\w$]*)\s*:/.exec(object.slice(index));
    if (!name) continue;
    const from = index + name[0].length;
    let cursor = from;
    let inner = 0;
    for (; cursor < object.length; cursor += 1) {
      const nested = skippable(object, cursor);
      if (nested) { cursor += nested - 1; continue; }
      const at = object[cursor]!;
      if (at === '{' || at === '[' || at === '(') inner += 1;
      else if (at === '}' || at === ']' || at === ')') { if (!inner) break; inner -= 1; }
      else if (at === ',' && !inner) break;
    }
    props.set(name[1]!, object.slice(from, cursor));
    index = cursor - 1;
  }
  return props;
}

/**
 * 一段 `kind:` 取值里所有**可能落库**的字符串。
 *
 * 只收处在三元**结果位**上的那些 —— 判据是前一个非空白字符是 `?` / `:` / 什么都没有。
 * 不这样收的话，`event.kind === "send" ? "tg.send" : …` 里的比较操作数 `"send"` 也会被当成
 * 一个日志 kind（这正是重做这道闸时第一版误报的两条）。嵌套三元天然被覆盖：每一支的结果
 * 都紧跟着 `?` 或 `:`。
 */
function kindsIn(value: string): string[] {
  const kinds: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== '"' && char !== "'" && char !== '`') continue;
    const close = skipString(value, index);
    const before = value.slice(0, index).trimEnd();
    if (!before || before.endsWith('?') || before.endsWith(':')) kinds.push(value.slice(index + 1, close));
    index = close;
  }
  return kinds;
}

function documentedKinds(): Set<string> {
  const section = KIND_SECTION.exec(readFileSync(LOG_DOC, 'utf8'))?.[0];
  expect(section, `${LOG_DOC} 里找不到「## 2. 事件种类」那一节`).toBeTruthy();
  const kinds = new Set<string>();
  for (const line of section!.split('\n')) {
    if (!line.startsWith('|')) continue;
    // 只认**第一列**：其余列的正文里大量引用别的 kind（`model.error` 那行就提到 `provider.fallback`）。
    const first = line.slice(1).split('|')[0] ?? '';
    for (const match of first.matchAll(/`([^`]+)`/g)) kinds.add(match[1]!);
  }
  return kinds;
}

/**
 * 源码里真正发出去的 `LogEvent.kind`。
 *
 * 判据是**对象的形状**而不是调用点的名字：顶层同时有 `level` 与 `kind` 的对象字面量就是一条
 * `LogEvent`。先试过锚到 `.event({` / `.span({`，漏掉了 `alerts.ts` 里的 `this.#log({...})` ——
 * 而那正是「换个写法就绕过这道闸」的形状。形状判据对调用点写法免疫。
 *
 * 此前是全文扫 `kind: '...'`，两个毛病：一是捞到一堆根本不是日志的 kind（`principals.kind`、
 * `messages.kind`、`ApprovalOutcome.kind`、`WakewordKind`……），要靠一份手写的排除名单擦屁股，
 * 而那份名单自己又要一条断言去保它不腐烂；二是**引号写死成单引号**，于是 `b7e24ae` 把源码
 * 格式化成双引号之后差集恒等于整张表，这道闸从此什么都不挡（docs/29 · 补 `M-LOG-01` 时量出来的）。
 * 按形状取之后排除名单整份废掉了：不是日志的 `kind:` 压根进不来。
 */
function emittedKinds(): Map<string, string> {
  const found = new Map<string, string>();
  const roots = ['packages', 'apps'];
  const files = roots.flatMap(walk).filter((path) => path.endsWith('.ts') && /^(packages|apps)\/[^/]+\/src\//.test(path));
  expect(files.length, '没扫到任何源文件，路径判据坏了').toBeGreaterThan(20);
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (let index = 0; index < text.length; index += 1) {
      const skip = skippable(text, index);
      if (skip) { index += skip - 1; continue; }
      if (text[index] !== '{') continue;
      // 不跳过整个对象：`LogEvent` 也可能嵌在别的对象里，里层那个要单独被扫到。
      const props = topLevelProps(objectAt(text, index));
      const kind = props.get('kind');
      if (kind === undefined) continue;
      // 两个判据取并集，各自补对方的盲点：
      // - **形状**（顶层同时有 `level` 与 `kind`）认得出 `alerts.ts` 的 `this.#log({...})`；
      // - **发出点**认得出 `main.ts` 的 `log.event({ kind: 'sandbox.container.created', ...shared })`
      //   —— 那里的 `level` 藏在展开里，形状判据看不见。
      const emitter = /[.#]?\b(?:event|span|log)\(\s*$/.test(text.slice(Math.max(0, index - 40), index));
      if (!props.has('level') && !emitter) continue;
      for (const one of kindsIn(kind)) if (!found.has(one)) found.set(one, path);
    }
  }
  expect(found.size, '一个发出点都没解析出来 —— 判据坏了').toBeGreaterThan(20);
  return found;
}

describe('日志 kind 与 docs/10 §2 双向一致', () => {
  it('表里的每个 kind 源码都真的在发', () => {
    const emitted = emittedKinds();
    const missing = [...documentedKinds()].filter((kind) => !emitted.has(kind)).sort();
    expect(missing, `${LOG_DOC} §2 写了这些 kind，但 packages/*/src 与 apps/*/src 里一处都没发 ——`
      + '要么实现它，要么把这一行从表里删掉（"摘除比伪造安全"）').toEqual([]);
  });

  it('源码发的每个 kind 表里都有一行', () => {
    const documented = documentedKinds();
    const stray = [...emittedKinds()].filter(([kind]) => !documented.has(kind))
      .map(([kind, path]) => `${kind}（${path}）`).sort();
    expect(stray, `这些 kind 作为 LogEvent 发出去了（顶层同时有 level 与 kind），但 ${LOG_DOC} §2 没写 ——`
      + '补一行（level + 关键字段）').toEqual([]);
  });

  // 此前这里还有第三条「排除名单里的每一条都还在源码里出现」，保的是那份手写的 `NON_LOG_KINDS`
  // 不腐烂。锚到 `.event({` / `.span({` 之后名单整份废掉了 —— 不是日志的 `kind:` 压根进不来，
  // 于是也不再需要一条断言去保一份排除名单。**少一份要人维护的名单，就少一处会悄悄过期的判据。**
});

/**
 * `docs/05 §4` 那张「权限矩阵（权威表）」与 `TOOL_POLICY` 的双向焊接（`docs/13` · AC-TOOL-001a）。
 *
 * 背景：表尾曾写着「CI 有一致性测试（AC-TOOL-001）」，而那条测试从来没有存在过 —— 声称的保证
 * 比没有保证更糟：这张表一度漏掉九个工具（`context_stats` `memory_list` `list_agents`
 * `read_agent_result` `ask_parent` `report_progress` `load_skill` `install_skill` `spawn_harness`）
 * 而没有任何人被绊倒。它是**权威表**，运维和下一轮复审都拿它当工具全集读，漏一行等于那个工具的
 * 权限档从此没人复核过。另一条（`TOOL_POLICY` ↔ 实际注册表）由 `main.ts` 的启动断言管。
 *
 * 判据故意收得很窄：**只解析 §4 那一节、只看表格的第一列**。放宽任何一头断言就废掉 ——
 * 整份文件 grep 会让 §3.x 散文里的一次提名就算「表里有」；而六条脚注也落在节内，它们逐条引用
 * 工具名（`TOOL_POLICY.bash.minRole`、`tools.overrides.stay_silent.minRole`），第一列判据把
 * 这些排掉。同族的 kind 表断言（上面）是同一个理由。
 */
const TOOL_DOC = 'docs/05-tools-and-permissions.md';
const MATRIX_SECTION = /^## 4\. 权限矩阵（权威表）[\s\S]*?(?=^## 5\.)/m;
/**
 * 表里的写法 → `TOOL_POLICY` 的键。**只有记忆这一族**，三条同一个理由：公开与私有记忆的权限档
 * 不同（私有多一道「仅私聊·仅本人」，公开写另受 `memory.pubWriteMinRole` 约束），表里因此按
 * 作用域分三行写；而策略表只有 `memory_read` / `memory_write` 两个键，那层差异在 `available()`
 * 里，不在这一栏上。**往这张映射里加东西之前先想清楚**：它每多一条，断言就少认一个工具名 ——
 * 用它去把测试弄绿等于把这条断言拆掉。
 */
const MATRIX_ALIASES = new Map<string, readonly string[]>([
  ['memory_read(pub)', ['memory_read']],
  ['memory_write(pub)', ['memory_write']],
  ['memory_read/write(pri)', ['memory_read', 'memory_write']],
]);
/** 工具名的形状。第一列里不合形状的是斜杠命令与通配（`/grant` `/revoke` `custom_*`）。 */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function matrixSection(): string {
  const section = MATRIX_SECTION.exec(readFileSync(TOOL_DOC, 'utf8'))?.[0];
  expect(section, `${TOOL_DOC} 里找不到「## 4. 权限矩阵（权威表）」那一节`).toBeTruthy();
  return section!;
}

function matrixTools(): Set<string> {
  const names = new Set<string>();
  for (const line of matrixSection().split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = line.slice(1).split('|')[0] ?? '';
    for (const match of first.matchAll(/`([^`]+)`/g)) {
      for (const name of MATRIX_ALIASES.get(match[1]!) ?? [match[1]!]) names.add(name);
    }
  }
  expect(names.size, '§4 的表几乎没解析出东西，第一列判据坏了').toBeGreaterThan(40);
  return names;
}

describe('TOOL_POLICY 与 docs/05 §4 双向一致', () => {
  it('每个 TOOL_POLICY 键在表里都有一格', () => {
    const documented = matrixTools();
    const missing = Object.keys(TOOL_POLICY).filter((name) => !documented.has(name)).sort();
    expect(missing, `这些工具不在 ${TOOL_DOC} §4 的权限矩阵里 —— 那是权威表，缺一行等于这个工具的`
      + '权限档没有任何人复核过（分作用域写的行请走 MATRIX_ALIASES，并在那里写清为什么）').toEqual([]);
  });

  it('表里的每个工具名都是 TOOL_POLICY 的键', () => {
    // 反方向只判「形状像工具名」的格子：同一列里还有 `custom_*` 这种通配、`/grant` `/revoke`
    // 这种斜杠命令，而 `Skill` / `Plugin 工具` / `MCP 工具` /「（任何工具 / 任何回复）」几行连
    // 反引号都没有，本来就不进判据。分类行是这张表的既有形态（它同时也是「非内建工具怎么判」
    // 的说明），所以这一向靠形状容忍它们，而不是靠一份会被人往里塞名字的白名单。
    const stray = [...matrixTools()].filter((name) => TOOL_NAME.test(name) && !(name in TOOL_POLICY)).sort();
    expect(stray, `${TOOL_DOC} §4 列了这些工具，但 TOOL_POLICY 里没有 —— 删工具或改名时表要一起改`).toEqual([]);
  });

  it('别名映射里的每一条表里都还写着', () => {
    // 与 NON_LOG_KINDS 那条同一个道理：一条没人再用的别名会静静放过一个真该被列出的工具名。
    const section = matrixSection();
    const stale = [...MATRIX_ALIASES.keys()].filter((alias) => !section.includes(`\`${alias}\``));
    expect(stale, '这些写法已从 §4 消失，从 MATRIX_ALIASES 里删掉').toEqual([]);
  });
});

describe('文档分层', () => {
  it('复审层每份都带 frozen header', () => {
    const missing = docs
      .filter((doc) => doc.path.startsWith('docs/reviews/'))
      .filter((doc) => !doc.text.slice(0, 600).includes(FROZEN_HEADER))
      .map((doc) => doc.path);
    expect(missing, '复审报告是历史快照，开头必须声明冻结日期').toEqual([]);
  });

  it('🚧 状态标记只出现在活文档里', () => {
    const stray: string[] = [];
    for (const { path, text } of docs) {
      if (MARKER_ALLOWED.has(path)) continue;
      for (const [index, line] of text.split('\n').entries()) {
        if (STATUS_MARKER.test(line) && !MARKER_QUOTED.test(line)) stray.push(`${path}:${index + 1}`);
      }
    }
    expect(stray, `🚧 是活账；历史文档要写成过去时，新的未接线项归到 ${[...MARKER_ALLOWED].join(' / ')}`).toEqual([]);
  });
});

/**
 * `docs/21 §1` 那张复算表与代码的一致性。
 *
 * 这一条也是补的：`KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 的条数在 `docs/21` 里曾有**三个版本**
 * （§1 的 67、§5 的 70、§7 的 67），而代码里是 10 —— 差 6.7 倍，持续了九天，没有一处判据在看。
 * 对照组就在同一个仓库：`docs/11 §2.0.1` 的同一份清单被 `tests/config.test.ts` 双向焊着，
 * 同期从 65 条压到 10 条、每次增减都对得上。**差别不是纪律，是有没有闸。**
 *
 * 计数快照写进文档就得可核对。核不了的（历史快照）折进 `<details>` 并标死日期，别摆在现值的位置上。
 */
describe('docs/21 §1 的复算表与代码一致', () => {
  const ledger = readFileSync('docs/21-webui-coverage-gaps.md', 'utf8');
  const claim = (label: string): number => {
    const row = new RegExp(`\\|\\s*${label}[^|]*\\|\\s*\\*\\*(\\d+)\\*\\*\\s*〔实测〕`).exec(ledger);
    expect(row, `docs/21 §1 找不到「${label}」那一行的 \`**<数>** 〔实测〕\` 形态`).toBeTruthy();
    return Number(row![1]);
  };

  it('未接线配置键的条数与 KNOWN_UNIMPLEMENTED_CONFIG_KEYS 相等', () => {
    expect(claim('运行时从不读')).toBe(KNOWN_UNIMPLEMENTED_CONFIG_KEYS.length);
  });

  it('schema 叶子总数与 configSchemaLeafPaths 相等', () => {
    expect(claim('schema 叶子总数')).toBe(configSchemaLeafPaths(configJsonSchema()).length);
  });

  it('已接线数 = 叶子 − 未接线 − perChat', () => {
    const leaves = configSchemaLeafPaths(configJsonSchema());
    const perChat = leaves.filter((path) => path.startsWith('perChat')).length;
    expect(claim('\\*\\*已接线\\*\\*')).toBe(leaves.length - KNOWN_UNIMPLEMENTED_CONFIG_KEYS.length - perChat);
  });
});

/**
 * `docs/00 §2`（还欠什么）的**活性探针**。
 *
 * 这一条补的是一次真实的漏删：`M-WEB-05` / `M-LOG-02` / `M-MEM-02` 三条缺陷修完之后，`docs/00 §2`
 * 里仍然写着「还欠着」，挂了三天 —— **而没有任何判据会因此变红**。`tests/acceptance.test.ts` 只核
 * 本文的两个数字（勾选分子分母），§2 那张表整个是裸的手工区，而它恰恰是全库最需要保鲜的一节：
 * 别人开工前读的就是它。
 *
 * 探针的形状是一句**必须无命中**的 grep：`⟨探针：<路径> !~ <正则>⟩`。一条欠账被补完，那个模式就会
 * 出现在源码里，探针当场变红 —— 于是「修好了但忘了从 §2 删掉」不再可能。它是**绊线不是证明**：
 * 报红只说明「这条可能已经补完了，回来看一眼」，不说明补得对。误报的代价是重看一行，
 * 而沉默腐烂的代价是别人照着一份过期的清单决定做什么。
 *
 * 写不出探针的（纯语义欠账、跨文件的「没接线」、以及「有意为之 / 修不了」那几条）写
 * `⟨探针：无 —— 理由⟩`，测试放行但要求理由不为空。**一条都不许沉默地跳过** —— 「写不出探针」和
 * 「忘了写」在判据眼里必须长得不一样，这正是上一轮 `NON_LOG_KINDS` 那份手写排除名单的教训。
 */
describe('docs/00 §2 的每一条都带活性探针', () => {
  const text = readFileSync('docs/00-state.md', 'utf8');
  const section = /\n## 2\. 还欠什么\n[\s\S]*?(?=\n## 3\.)/.exec(text)?.[0];
  const rows = (section ?? '')
    .split('\n')
    .map((line, index) => ({ line, no: index }))
    .filter(({ line }) => line.startsWith('| ') && !/^\|\s*-{3}/.test(line) && !/^\|\s*(?:编号|欠什么)\s*\|/.test(line));
  const PROBE = /⟨探针：(?:无\s*——\s*(?<why>[^⟩]+)|(?<path>[^\s|!⟩]+)\s*!~\s*(?<pattern>[^⟩]+))⟩/;

  it('§2 那一节找得到，且行数没有塌掉', () => {
    expect(section, 'docs/00 里找不到「## 2. 还欠什么」那一节 —— 判据坏了或标题改了').toBeTruthy();
    expect(rows.length, '§2 一行表格都没解析出来，判据坏了').toBeGreaterThan(5);
  });

  it('每一行要么有探针，要么写明为什么写不出探针', () => {
    const naked = rows.filter(({ line }) => !PROBE.test(line)).map(({ line }) => line.slice(0, 60));
    expect(naked, '这些欠账没挂探针 —— 补完之后没有任何东西会提醒你把它从 §2 删掉。'
      + '写 ⟨探针：<路径> !~ <正则>⟩，或 ⟨探针：无 —— 理由⟩').toEqual([]);
  });

  it('探针指的文件都还在', () => {
    const missing: string[] = [];
    for (const { line } of rows) {
      const path = PROBE.exec(line)?.groups?.path;
      if (path && !existsSync(path)) missing.push(path);
    }
    expect(missing, '探针指着不存在的文件 —— 代码挪过位置了，探针要跟着走').toEqual([]);
  });

  it('探针全部无命中 —— 有命中说明那条欠账可能已经补完了', () => {
    const tripped: string[] = [];
    for (const { line } of rows) {
      const { path, pattern } = PROBE.exec(line)?.groups ?? {};
      if (!path || !pattern || !existsSync(path)) continue;
      if (new RegExp(pattern.trim()).test(readFileSync(path, 'utf8'))) {
        tripped.push(`${path} 里已经有 /${pattern.trim()}/ —— ${line.split('|')[1]?.trim().slice(0, 50)}`);
      }
    }
    expect(tripped, '探针响了：这几条欠账看起来已经被补完，回 docs/00 §2 核一遍 —— '
      + '真补完了就整行删掉（§4 的规矩），没补完就把探针改准').toEqual([]);
  });

  it('「无探针」的理由不许敷衍', () => {
    const thin = rows
      .map(({ line }) => PROBE.exec(line)?.groups?.why?.trim())
      .filter((why): why is string => why !== undefined && why.length < 8);
    expect(thin, '「写不出探针」得说清楚为什么 —— 一句话，不是一个词').toEqual([]);
  });
});

/**
 * 文档之间的相对链接不许指空。
 *
 * 这条是补的：实测四条断链，且都不是新的 —— `./05-tools.md`（真名是 `05-tools-and-permissions.md`）、
 * `./07-skills-and-extensions.md`（真名是 `07-skills-plugins-mcp.md`）、
 * `./reviews/24-review-round9.md`（那份是 round6-verification，压根没有 round9）。文件早就改过名，
 * 而链接留在原地。
 *
 * 为什么此前挡不住：「源码注释里的 `docs/NN` 都指得着」那条只看**源码**，且只看两位数编号；
 * 文档之间的 markdown 链接一条都不在它的视野里。而删一份文档正是最容易制造这种断链的动作 ——
 * 本轮删掉实施计划那份时，四份文档里的入站链接全靠手工 grep 才清干净。
 *
 * 只判 `.md` 的相对链接：外链验不了，锚点（`#节名`）的解析规则各家不同，都不进判据。
 */
describe('文档之间的链接都指得着', () => {
  it('相对 markdown 链接没有指空的', () => {
    const dangling: string[] = [];
    for (const { path, text } of docs) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      for (const [index, line] of text.split('\n').entries()) {
        for (const match of line.matchAll(/\]\((\.\/[^)#\s]+\.md)/g)) {
          if (!existsSync(join(dir, match[1]!))) dangling.push(`${path}:${index + 1} → ${match[1]}`);
        }
      }
    }
    expect(dangling, '这些链接指着不存在的文档 —— 文件改过名或被删了，链接要跟着走').toEqual([]);
  });
});
