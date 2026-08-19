import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 让文档库的「活 / 死」分层说话算数。
 *
 * 背景：`docs/reviews/` 那九轮复审是历史快照，但它们**删不掉** —— 大量源码注释拿条目编号
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
/** 状态标记位置的 🚧：行首，或表格单元格开头。行内的（「在 docs/11 标 🚧」这类叙述）不算。 */
const STATUS_MARKER = /^\s*(?:\|\s*)?🚧/;
/** 活文档里允许挂 🚧 的两处：配置手册的未接线表，与当前态清单。 */
const MARKER_ALLOWED = new Set(['docs/00-state.md', 'docs/11-config-reference.md']);
const FROZEN_HEADER = '❄️ **已冻结（';

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
    const corpus = docs.map((doc) => doc.text).join('\n');
    const dangling: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/·\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/g)) {
        if (!corpus.includes(match[1]!)) dangling.push(`${path} → ${match[1]}`);
      }
    }
    expect(dangling, '这些条目编号已从文档里消失，注释成了空凭据').toEqual([]);
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
 * 源码里带 `kind:` 但**不是** `LogEvent.kind` 的那些。每一条都要说清出处 —— 这份名单是
 * 「新增一个非日志 kind 时该往哪加」的唯一说明，而它自己也是判据：不在这里、又不在文档表里，
 * 就是红的。**不要只信这份名单**，加 `kind:` 字面量时自己再穷举一遍。
 */
const NON_LOG_KINDS = new Map<string, string>([
  ['user', 'principals.kind（`PrincipalRepository.upsertSeen`）'],
  ['chat', 'principals.kind（同上）'],
  ['text', 'messages.kind（归档出站消息）'],
  ['photo', 'messages.kind（`media.ts` 的 `fileFrom`）'],
  ['turn', 'context_commits.kind'],
  ['manual', 'context_commits.kind（`insertControl`）'],
  ['reset', 'context_commits.kind（同上）'],
  ['regex', 'WakewordKind'],
  ['contains', 'WakewordKind'],
  ['timeout', 'CandidateFailure.kind（`fallback-model.ts`）'],
  ['status', 'CandidateFailure.kind（同上，嵌套三元）'],
  ['network', 'CandidateFailure.kind（同上，嵌套三元）'],
  ['skill', "`extensions.changed` 的载荷（`events.emit('extensions.changed', { kind: 'skill' })`）"],
  ['quota_global_exceeded', 'AlertKind'],
  ['consecutive_turn_failures', 'AlertKind'],
  ['send', 'TelegramDeliveryEvent.kind（`stream-output.ts`；落库时才映射成 `tg.send`）'],
  ['edit', 'TelegramDeliveryEvent.kind（同上 → `tg.edit`）'],
  ['action', 'TelegramDeliveryEvent.kind（同上 → `tg.action`）'],
]);

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

function emittedKinds(): Map<string, string> {
  const found = new Map<string, string>();
  const roots = ['packages', 'apps'];
  const files = roots.flatMap(walk).filter((path) => path.endsWith('.ts') && /^(packages|apps)\/[^/]+\/src\//.test(path));
  expect(files.length, '没扫到任何源文件，路径判据坏了').toBeGreaterThan(20);
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/kind: '([^']+)'/g)) if (!found.has(match[1]!)) found.set(match[1]!, path);
    // 三元发出点（`bot.ts` 的 `trigger.matched|skipped` 与 `quota.check|exceeded`），
    // 以及 `fallback-model.ts` 那个嵌套三元 —— 两个分支都要被解析出来。
    for (const match of text.matchAll(/kind: [^,}\n]*\? *'([^']+)' *: *'([^']+)'/g)) {
      for (const kind of [match[1]!, match[2]!]) if (!found.has(kind)) found.set(kind, path);
    }
  }
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
    const stray = [...emittedKinds()].filter(([kind]) => !documented.has(kind) && !NON_LOG_KINDS.has(kind))
      .map(([kind, path]) => `${kind}（${path}）`).sort();
    expect(stray, `这些 kind 在发但 ${LOG_DOC} §2 没写。是日志事件就补一行（level + 关键字段），`
      + '不是的话补进 `NON_LOG_KINDS` 并写清出处').toEqual([]);
  });

  it('排除名单里的每一条都还在源码里出现', () => {
    const emitted = emittedKinds();
    const stale = [...NON_LOG_KINDS.keys()].filter((kind) => !emitted.has(kind));
    // 与上面两条同一个道理：一份没人再用的排除名单会静静放过一个真正该被记录的 kind。
    expect(stale, '这些非日志 kind 已经从源码里消失，从 NON_LOG_KINDS 里删掉').toEqual([]);
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
        if (STATUS_MARKER.test(line)) stray.push(`${path}:${index + 1}`);
      }
    }
    expect(stray, `🚧 是活账；历史文档要写成过去时，新的未接线项归到 ${[...MARKER_ALLOWED].join(' / ')}`).toEqual([]);
  });
});
