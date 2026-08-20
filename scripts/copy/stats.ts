/**
 * 数一遍用户可见文案：多少条、分布在哪些面上、多少条被文档或测试钉住。
 *
 * 只读，不写任何文件。改文案走 dev 文案面板（`COPY_EDIT=1 pnpm webui:dev`，见
 * `docs/copy/README.md`）—— 这里纯粹是「现在一共有多少字要管」的体检报告。
 *
 *   pnpm copy:stats
 */
import { extractAll, type Entry } from './extract.js';

const entries = extractAll();
const bySurface = new Map<string, Entry[]>();
for (const entry of entries) bySurface.set(entry.surface, [...(bySurface.get(entry.surface) ?? []), entry]);

for (const [surface, rows] of [...bySurface].sort((a, b) => b[1].length - a[1].length)) {
  const kinds = new Map<string, number>();
  for (const row of rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
  process.stdout.write(`${String(rows.length).padStart(4)}  ${surface.padEnd(24)} ${[...kinds].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}×${count}`).join(' ')}\n`);
}
const pinned = entries.filter((entry) => entry.pinned.length).length;
process.stdout.write(`\n合计 ${entries.length} 条，${bySurface.size} 个面；其中被文档或测试钉住 ${pinned} 条\n`);
