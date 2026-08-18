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
