import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_UNIMPLEMENTED_CONFIG_KEYS, MAIN_AGENT_TOOLS, TOOL_POLICY, configJsonSchema, configSchemaLeafPaths } from '@luoli/core';
import { describe, expect, it } from 'vitest';

/**
 * 使文档库的活层与冻结层分层真正生效。
 *
 * 背景：`docs/reviews/` 那十轮复审是历史快照，但它们不可删除，因为大量源码注释以条目编号
 * （如 `docs/20 · W-SEC-02`）作为某段实现为何如此的溯源凭据。凭据的问题在于没有任何机制
 * 保证它仍能指向有效目标：删除一条、更改一次编号、移动一个文件，注释就静默变为空引用，而空引用
 * 与真实凭据在外观上完全相同。前两条断言固定这一点。
 *
 * 第三条针对另一个方向：🚧 表示尚未接线，运维与下一轮复审都依靠 grep 它来统计欠账。
 * 一旦历史快照中也保留 🚧，grep 结果就会把活账与九轮历史混在一起：第七轮正因此被迫
 * 逐条清查 25 份文档中的所有 🚧（`docs/reviews/25`）。因此状态标记位置的 🚧
 * 只允许出现在活文档中，复审层要么不写，要么写成过去时。
 */

const SRC_ROOTS = ['packages', 'apps', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/**
 * 状态标记位置的 🚧：行首，或任意表格单元格的开头。行内出现的（如在 docs/11 标 🚧 这类叙述）不计入。
 *
 * 原先只识别行首与第一格，导致 `docs/21` 那四条未接线缺口因写在表格最后一格，整份文档的活账
 * 实际上不在任何判据的覆盖范围内；一道判据覆盖不到它应覆盖的位置，与不存在该判据等价。
 */
const STATUS_MARKER = /(?:^|\|)\s*🚧/;
/** `🚧「…」` 是引文（复审报告引用当时文档的原话，见 `reviews/25 §1`），不是活标记。 */
const MARKER_QUOTED = /🚧\s*[「"“]/;
/** 活文档中允许出现 🚧 的三处：配置手册的未接线表、当前态清单、WebUI 缺口台账。 */
const MARKER_ALLOWED = new Set([
  'docs/00-state.md',
  'docs/11-config-reference.md',
  'docs/21-webui-coverage-gaps.md',
]);
const FROZEN_HEADER = '❄️ **已冻结（';
/** 复审条目编号的形态：`W-CFG-02`、`L-OPS-01`、`AC-SEC-011`，至少含一个连字符。 */
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
    // 只解析 `· ` 之后的编号，那是既有的引用约定（`docs/22 · V-SSRF-01`）。不要求编号位于
    // 紧邻的那份文档中：`docs/05 §5.2 · W-SBX-02` 是规格出处加复审条目的混合形态，
    // `docs/22 · N-CFG-02 一脉` 是跨轮旁引，两者都合法。需要保证的只是条目仍然存在。
    //
    // 判据按词比对而非按子串。此前使用 `corpus.includes(id)`，导致 `S-01` 被 `L-OPS-01` 满足、
    // `I-01` 被 `D-UI-01` 满足、`T-02`–`T-05` 被 `L-EXT-02`–`05` 满足，`reviews/27` 的整个
    // `S-*`/`T-*` 家族与 `reviews/22` 的整个 `I-*` 家族因此完全未被保护：删除它们判据依然通过，
    // 而注释已指向空。改为词边界后当天悬空数为零（既有引用全部有效），收紧没有任何代价，
    // 换来的是删除时会触发失败。
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
   * 缺口台账的编号唯一性。这条是事后补上的而非预防性的：`G-API-15` 与 `G-API-16` 曾各自定义两次，
   * 指向毫不相干的两件事，而 `app.ts` / `SchedulesCard.vue` / `schedule.api.test.ts` 三处注释都写着
   * `G-API-16`，仅凭编号无法区分指向哪一条。
   *
   * 只在 `docs/21` 内部判定：跨文件重号绝大多数是跨轮复列（`16` 复列 `15` 的批次、`23`/`24`
   * 复核 `22` 的条目），属于既定工作流，按重号处理会产生 78 条噪声。而冻结层中真正的重号
   * （`R-TG-01` 出现在 `19` 与 `24`、`G-EXT-0x` 出现在 `15` 与 `21`）既不能修改也无法测试，只能记录：
   * 记在 `docs/README §0.1` 的警示表中，引用时必须带文档号。
   */
  /**
   * 台账正文（`## 1.` 之后）。`## 0.` 那几节是索引，按定义即副本，不参与唯一性判定：
   * 把副本当作定义时，一张为便于查阅而添加的索引表反而会让整道闸失败。
   */
  const ledgerBody = (): string => {
    const ledger = docs.find((doc) => doc.path === 'docs/21-webui-coverage-gaps.md');
    expect(ledger, 'docs/21 不见了').toBeTruthy();
    const at = ledger!.text.indexOf('\n## 1.');
    expect(at, 'docs/21 里找不到 `## 1.` —— 索引与台账的分界线没了，判据坏了').toBeGreaterThan(0);
    return ledger!.text.slice(at);
  };
  /** 台账中的定义行：表格第一格即编号。返回编号到该行状态格的映射。 */
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
   * `docs/21 §0` 的当前未闭合项索引表必须等于台账中所有未闭合的行。
   *
   * 索引是副本，而这份文档自身的教训就是同一事实存在两份副本必然漂移。添加索引是为了
   * 让最新的缺口不再排在第 800 多行而无人查阅（`G-UI-05` 与 `G-UI-06` 都出现过该问题），
   * 但一张会过期的索引比没有索引更糟：它看起来具有权威性。因此由这条断言维持其正确性。
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
 * `docs/10 §2` 的 kind 表与实现之间的双向固定。
 *
 * 背景：上一轮实测表中记录而源码从未发出的有 19 个、源码在发出而表中缺失的约 35 个（含全库 78% 的
 * `tg.api`），而 `docs/13` 的 `AC-LOG-001` 按字面永远无法通过（docs/28 · L-LOG-01）。
 * 两个方向都要拦截：只拦一侧时，文档记录而未实现与已实现而未记录各能漂移回去一半。
 */
const LOG_DOC = 'docs/10-logging-and-observability.md';
/** 表格所在的那一节。`## 3.` 之后是落盘格式，不再有 kind 表。 */
const KIND_SECTION = /^## 2\. 事件种类[\s\S]*?(?=^## 3\.)/m;
/**
 * 从 `at` 处的引号开始，返回字符串或模板串结束引号的下标。
 * 模板串中的 `${...}` 可嵌入任意代码（括号、花括号、其他引号），整段跳过。
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

/** 从 `index` 起应跳过的长度：字符串、行注释、块注释各自的长度；不属于这三类时返回 0。 */
function skippable(text: string, index: number): number {
  const char = text[index]!;
  if (char === '"' || char === "'" || char === '`') return skipString(text, index) - index + 1;
  if (char === '/' && text[index + 1] === '/') { const nl = text.indexOf('\n', index); return nl < 0 ? text.length - index : nl - index; }
  if (char === '/' && text[index + 1] === '*') { const close = text.indexOf('*/', index); return close < 0 ? text.length - index : close + 2 - index; }
  return 0;
}

/**
 * `open` 处的 `{` 所对应的对象字面量全文。
 * 单纯计数花括号会被字符串中的括号干扰（`summary: \`Turn ${id} started (queued)\`` 就含有一对），
 * 因此字符串、模板串与两种注释都要跳过。
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

/** 对象字面量的顶层属性到属性值原文的映射。嵌套在 `data: {...}` 中的同名键不计入。 */
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
 * 一段 `kind:` 取值中所有可能落库的字符串。
 *
 * 只收取处于三元表达式结果位的那些，判据是前一个非空白字符为 `?`、`:` 或不存在。
 * 否则 `event.kind === "send" ? "tg.send" : …` 中的比较操作数 `"send"` 也会被当作
 * 一个日志 kind（这正是重做该闸时第一版误报的两条）。嵌套三元自然被覆盖：每一支的结果
 * 都紧跟在 `?` 或 `:` 之后。
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
    // 只解析第一列：其余列的正文中大量引用其他 kind（`model.error` 那行就提到了 `provider.fallback`）。
    const first = line.slice(1).split('|')[0] ?? '';
    for (const match of first.matchAll(/`([^`]+)`/g)) kinds.add(match[1]!);
  }
  return kinds;
}

/**
 * 源码中实际发出的 `LogEvent.kind`。
 *
 * 判据是对象的形状而非调用点的名称：顶层同时具有 `level` 与 `kind` 的对象字面量即一条
 * `LogEvent`。先前尝试过锚定 `.event({` / `.span({`，遗漏了 `alerts.ts` 中的 `this.#log({...})`，
 * 而那正属于换一种写法即绕过该闸的形态。形状判据不受调用点写法影响。
 *
 * 此前是全文扫描 `kind: '...'`，存在两个问题：一是捞出大量并非日志的 kind（`principals.kind`、
 * `messages.kind`、`ApprovalOutcome.kind`、`WakewordKind` 等），需要一份手写排除名单弥补，
 * 而该名单自身又需要一条断言保证不失效；二是引号写死为单引号，于是 `b7e24ae` 把源码
 * 格式化为双引号之后差集恒等于整张表，该闸从此不再拦截任何内容（补 `M-LOG-01` 时测得，docs/29）。
 * 改为按形状提取后排除名单整份废除：非日志的 `kind:` 根本不会进入。
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
      // 不跳过整个对象：`LogEvent` 也可能嵌套在其他对象中，内层那个需要被单独扫描到。
      const props = topLevelProps(objectAt(text, index));
      const kind = props.get('kind');
      if (kind === undefined) continue;
      // 两个判据取并集，各自弥补对方的盲区：
      // - 形状判据（顶层同时具有 `level` 与 `kind`）能识别 `alerts.ts` 的 `this.#log({...})`；
      // - 发出点判据能识别 `main.ts` 的 `log.event({ kind: 'sandbox.container.created', ...shared })`，
      //   那里的 `level` 位于展开对象中，形状判据无法识别。
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

  // 此前这里还有第三条断言，要求排除名单中的每一条仍在源码中出现，用于保证手写的 `NON_LOG_KINDS`
  // 不失效。改为锚定 `.event({` / `.span({` 之后该名单整份废除：非日志的 `kind:` 根本不会进入，
  // 因此也不再需要一条断言去维护排除名单。少一份需人工维护的名单，即少一处会静默过期的判据。
});

/**
 * `docs/05 §4` 的权限矩阵（权威表）与 `TOOL_POLICY` 之间的双向固定（`docs/13` · AC-TOOL-001a）。
 *
 * 背景：表尾曾声明 CI 有一致性测试（AC-TOOL-001），而那条测试从未存在。声称存在的保证
 * 比没有保证更糟：这张表一度遗漏九个工具（`context_stats` `memory_list` `list_agents`
 * `read_agent_result` `ask_parent` `report_progress` `load_skill` `install_skill` `spawn_harness`）
 * 而未被任何人发现。它是权威表，运维与下一轮复审都将其视为工具全集，遗漏一行即意味着该工具的
 * 权限档从未被复核。另一侧（`TOOL_POLICY` 与实际注册表）由 `main.ts` 的启动断言负责。
 *
 * 判据有意收窄：只解析 §4 那一节、只读取表格第一列。放宽任一侧断言即失效：
 * 对整份文件 grep 会让 §3.x 正文中的一次提及也算作表中存在；而六条脚注同样位于该节内，它们逐条引用
 * 工具名（`TOOL_POLICY.bash.minRole`、`tools.overrides.stay_silent.minRole`），第一列判据将
 * 这些排除。同类的 kind 表断言（见上）出于同一理由。
 */
const TOOL_DOC = 'docs/05-tools-and-permissions.md';
const MATRIX_SECTION = /^## 4\. 权限矩阵（权威表）[\s\S]*?(?=^## 5\.)/m;
/**
 * 表中的写法到 `TOOL_POLICY` 键的映射。只有记忆这一族，三条出于同一理由：公开与私有记忆的权限档
 * 不同（私有多一道仅私聊且仅本人的限制，公开写另受 `memory.pubWriteMinRole` 约束），表中因此按
 * 作用域分三行书写；而策略表只有 `memory_read` 与 `memory_write` 两个键，那层差异位于 `available()`
 * 中，不在这一栏上。向该映射添加条目前需谨慎：每增加一条，断言就少覆盖一个工具名，
 * 用它让测试通过等同于拆除这条断言。
 */
const MATRIX_ALIASES = new Map<string, readonly string[]>([
  ['memory_read(pub)', ['memory_read']],
  ['memory_write(pub)', ['memory_write']],
  ['memory_read/write(pri)', ['memory_read', 'memory_write']],
]);
/** 工具名的形态。第一列中不符合该形态的是斜杠命令与通配（`/grant`、`/revoke`、`custom_*`）。 */
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
    // 反方向只判定形态符合工具名的单元格：同一列中还有 `custom_*` 这类通配、`/grant` 与 `/revoke`
    // 这类斜杠命令，而 `Skill`、`Plugin 工具`、`MCP 工具` 以及任何工具、任何回复几行连
    // 反引号都没有，本就不进入判据。分类行是这张表的既有形态（同时也是非内建工具如何判定
    // 的说明），因此该方向依靠形态容忍它们，而不是依靠一份可被随意添加名字的白名单。
    const stray = [...matrixTools()].filter((name) => TOOL_NAME.test(name) && !(name in TOOL_POLICY)).sort();
    expect(stray, `${TOOL_DOC} §4 列了这些工具，但 TOOL_POLICY 里没有 —— 删工具或改名时表要一起改`).toEqual([]);
  });

  it('别名映射里的每一条表里都还写着', () => {
    // 与 NON_LOG_KINDS 那条同理：一条已无人使用的别名会静默放过一个本应被列出的工具名。
    const section = matrixSection();
    const stale = [...MATRIX_ALIASES.keys()].filter((alias) => !section.includes(`\`${alias}\``));
    expect(stale, '这些写法已从 §4 消失，从 MATRIX_ALIASES 里删掉').toEqual([]);
  });

  /**
   * 「主 agent」那一列与 `MAIN_AGENT_TOOLS` 双向一致（worker 重构）。
   *
   * 这一列不是排版而是本次重构的权限边界本身：工具下沉给 worker 之后，「主 agent 调不调得到」
   * 由 `toolCallableBy()` 判定，而 `#eligible()` 与 `admit()` 共用它。表与代码分叉的表现是
   * 运维照着表以为主 agent 还能读文件 —— 而 §4 开头就写着这张表是权威表。
   *
   * 只判 ✓/✗ 那一位，不判 `△`（「仅主 agent」）：`memory_read/write(pri)` 这类分作用域的行一格
   * 对应两个策略键，两个键在 `MAIN_ONLY_TOOLS` 里的归属并不相同（读两侧都给、写只给主 agent），
   * 那一位靠散文表达，判它需要一份把格子拆开的映射 —— 而每加一条映射，断言就少覆盖一个工具名
   * （同 MATRIX_ALIASES 那段注释）。✓/✗ 这一位对同格的每个键必须一致，因此判得动。
   */
  it('主 agent 那一列与 MAIN_AGENT_TOOLS 一致', () => {
    const wrong: string[] = [];
    for (const line of matrixSection().split('\n')) {
      if (!line.startsWith('|')) continue;
      const [first, main] = line.slice(1).split('|');
      if (first === undefined || main === undefined) continue;
      const cell = main.trim();
      // 表头、分隔行与「任何工具 / 任何回复」那行的这一格是空的：它说的是角色而不是这根轴。
      if (!cell.startsWith('✓') && !cell.startsWith('✗')) continue;
      const callable = cell.startsWith('✓');
      for (const match of first.matchAll(/`([^`]+)`/g)) {
        for (const name of MATRIX_ALIASES.get(match[1]!) ?? [match[1]!]) {
          if (!TOOL_NAME.test(name)) continue;
          if (MAIN_AGENT_TOOLS.has(name as never) !== callable)
            wrong.push(`${name}: 表里 ${cell.slice(0, 12)}，代码里 ${MAIN_AGENT_TOOLS.has(name as never) ? '可调' : '不可调'}`);
        }
      }
    }
    expect(wrong.sort(), `${TOOL_DOC} §4 的「主 agent」列与 MAIN_AGENT_TOOLS 对不上 —— `
      + '那一列是工具下沉之后的权限边界，判据在 toolCallableBy()，改一侧必须改另一侧').toEqual([]);
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
 * `docs/21 §1` 的复算表与代码之间的一致性。
 *
 * 这一条同样是事后补上的：`KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 的条数在 `docs/21` 中曾有三个版本
 * （§1 为 67、§5 为 70、§7 为 67），而代码中是 10，相差 6.7 倍并持续九天，没有任何判据覆盖。
 * 对照组就在同一仓库：`docs/11 §2.0.1` 的同一份清单被 `tests/config.test.ts` 双向固定，
 * 同期从 65 条压缩到 10 条，每次增减都保持一致。差别不在于执行纪律，而在于有没有断言。
 *
 * 计数快照写入文档就必须可核对。无法核对的（历史快照）折叠进 `<details>` 并标注固定日期，不要放在当前值的位置。
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
 * `docs/00 §2`（未完成事项）的活性探针。
 *
 * 这一条补的是一次真实的遗漏：`M-WEB-05` / `M-LOG-02` / `M-MEM-02` 三条缺陷修复完成后，`docs/00 §2`
 * 中仍标注为未完成并持续三天，而没有任何判据会因此失败。`tests/acceptance.test.ts` 只核对
 * 本文的两个数字（勾选分子分母），§2 那张表完全是手工维护区，而它恰恰是全库最需要保持时效的一节：
 * 其他人开工前读的正是它。
 *
 * 探针的形式是一句必须无命中的 grep：`⟨探针：<路径> !~ <正则>⟩`。一条欠账被补齐后，该模式就会
 * 出现在源码中，探针立即失败，于是已修复但忘记从 §2 删除不再可能发生。它是绊线而非证明：
 * 失败只说明该条可能已完成、需要回来确认，并不说明完成得正确。误报的代价是重新查看一行，
 * 而静默过期的代价是他人依据一份失效的清单决定工作内容。
 *
 * 写不出探针的（纯语义欠账、跨文件的未接线，以及有意为之或无法修复的那几条）写作
 * `⟨探针：无 —— 理由⟩`，测试放行但要求理由非空。不允许任何一条静默跳过：写不出探针与
 * 忘记编写在判据层面必须有区别，这正是上一轮 `NON_LOG_KINDS` 手写排除名单的教训。
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
 * 文档之间的相对链接不得指向不存在的目标。
 *
 * 这条是事后补上的：实测存在四条断链且都不是新增的，包括 `./05-tools.md`（实际文件名为 `05-tools-and-permissions.md`）、
 * `./07-skills-and-extensions.md`（实际文件名为 `07-skills-plugins-mcp.md`）、
 * `./reviews/24-review-round9.md`（该文件是 round6-verification，不存在 round9）。文件早已改名，
 * 而链接仍保持原样。
 *
 * 此前无法拦截的原因：源码注释中的 `docs/NN` 均可解析那条断言只检查源码，且只识别两位数编号，
 * 文档之间的 markdown 链接完全不在其覆盖范围内。而删除一份文档正是最容易造成此类断链的操作：
 * 本轮删除实施计划那份文档时，四份文档中的入站链接全靠手工 grep 才清理干净。
 *
 * 只判定 `.md` 的相对链接：外链无法验证，锚点（`#节名`）的解析规则各实现不一，均不进入判据。
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
