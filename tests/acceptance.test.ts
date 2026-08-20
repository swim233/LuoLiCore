import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 让 `docs/13` 的勾选**说话算数**。
 *
 * 那份文档从第二轮起就没更新过：372 条全是 `[ ]`、签署表 12 行全空（docs/24 §4）。
 * 光把框勾上没有意义 —— 下一轮谁也不知道那个 `[x]` 背后是真有用例还是有人手快。
 * 所以勾选的形式被定死成「`[x]` + `〔用例文件〕`」，由下面几条断言逐条核对：
 *
 * - 勾了就必须点名用例文件，而且文件真的存在；
 * - 没勾的不许挂用例注记（防「注记先写上、框以后再勾」那种半状态）；
 * - 只有标 `(自动)` 的条目能勾（人工条目要人签字，不是测试的事）；
 * - 签署表里每个模块的分母与分子必须等于文档里真实数出来的条数。
 *
 * 最后一条是这份文档此前最容易腐烂的地方：条目改了、表格没改，两个数字从此各说各话。
 */

const DOC = 'docs/13-acceptance-criteria.md';
// 编号可能带小写后缀（`AC-TOOL-001a`、`AC-WEB-011b` 那种拆细的子项）；`★` 出现在
// `(自动)` 前后都有先例，两种顺序都得认 —— 正则太紧的话那些行会被静静漏掉，
// 而「漏掉」在这份文档里等于「没人核对过」。
const CHECKED = /^\| \[x\] (AC-[A-Z]+-\d+[a-z]?)((?: ★| \(自动\))+) \|(.*)$/;
const UNCHECKED = /^\| \[ \] (AC-[A-Z]+-\d+[a-z]?)/;

interface Row { id: string; module: string; checked: boolean; annotation: string | null; line: number }

function rows(): Row[] {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const out: Row[] = [];
  for (const [index, line] of lines.entries()) {
    const checked = CHECKED.exec(line);
    const unchecked = UNCHECKED.exec(line);
    const id = checked?.[1] ?? unchecked?.[1];
    if (!id) continue;
    const annotation = /〔([^〕]+)〕\s*$/.exec(line)?.[1] ?? null;
    out.push({ id, module: id.split('-')[1]!, checked: Boolean(checked), annotation, line: index + 1 });
  }
  return out;
}

describe('docs/13 的勾选是可核对的', () => {
  it('每个 [x] 都点名了真实存在的用例文件', () => {
    const broken: string[] = [];
    for (const row of rows().filter((entry) => entry.checked)) {
      if (!row.annotation) { broken.push(`${row.id}（第 ${row.line} 行）勾了但没写用例文件`); continue; }
      for (const file of row.annotation.split('、').map((name) => name.trim())) {
        if (!existsSync(`tests/${file}`)) broken.push(`${row.id} 指向的 tests/${file} 不存在`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('没勾的条目不许挂用例注记', () => {
    // 反方向同样要挡：注记写上了、框没勾，下一个人会以为「已经验过只是忘了勾」而顺手勾上。
    const dangling = rows().filter((row) => !row.checked && row.annotation).map((row) => `${row.id}（第 ${row.line} 行）`);
    expect(dangling, `这些条目挂着用例注记却没有勾选：${dangling.join('、')}`).toEqual([]);
  });

  it('只有标 (自动) 的条目能被勾选', () => {
    const lines = readFileSync(DOC, 'utf8').split('\n');
    // 人工条目要人去签，不是测试能替它勾的。`[x]` 却不带 `(自动)` 一律视为错勾。
    const manual = lines.filter((line) => /^\| \[x\] AC-/.test(line) && !line.includes('(自动)'))
      .map((line) => line.slice(0, 40));
    expect(manual, `这些被勾选的条目不是 (自动)：\n${manual.join('\n')}`).toEqual([]);
  });

  it('签署表的分子分母与文档里数出来的一致', () => {
    const text = readFileSync(DOC, 'utf8');
    const all = rows();
    // 签署表行形如 `| 配置与 DB | | 10 / 24 | | | |`：分子是已验证的自动条目数，分母是该模块总条数。
    const MODULES: Array<[string, string[]]> = [
      ['配置与 DB', ['CFG', 'DB']],
      ['**上下文引擎**', ['CTX']],
      ['Telegram 与准入', ['TG', 'ACL', 'OUT']],
      ['Agent 与 Provider', ['AGENT', 'PROV', 'PROMPT']],
      ['工具/沙箱/审批', ['TOOL', 'SBX', 'APV']],
      ['Subagent 与任务', ['SUB', 'TASK']],
      ['记忆', ['MEM']],
      // 配额条目一直和日志成本合在同一行（原表的分母 23 = LOG 11 + QUOTA 12）。
      ['日志与成本', ['LOG', 'QUOTA']],
      ['扩展生态', ['SKL', 'PLG', 'MCP']],
      ['WebUI', ['WEB']],
      ['安全', ['SEC']],
      ['运维', ['OPS']],
    ];
    const problems: string[] = [];
    let expectedChecked = 0;
    let expectedTotal = 0;
    for (const [label, prefixes] of MODULES) {
      const mine = all.filter((row) => prefixes.includes(row.module));
      const checked = mine.filter((row) => row.checked).length;
      expectedChecked += checked;
      expectedTotal += mine.length;
      const row = new RegExp(`^\\| ${label.replace(/[*]/g, '\\*')} \\|[^|]*\\| *(\\d+) */ *(\\d+) *\\|`, 'm').exec(text);
      if (!row) { problems.push(`签署表里找不到「${label}」这一行`); continue; }
      if (Number(row[1]) !== checked || Number(row[2]) !== mine.length) {
        problems.push(`${label}：表里写 ${row[1]} / ${row[2]}，实际数出来 ${checked} / ${mine.length}`);
      }
    }
    // 用 new RegExp 而不是字面量：模式里那个 `/` 分隔符会把正则字面量提前收掉。
    const total = new RegExp('\\*\\*合计\\*\\* \\|[^|]*\\| *\\*\\*(\\d+) */ *(\\d+)\\*\\* \\|').exec(text);
    if (!total) problems.push('签署表里找不到合计行');
    else if (Number(total[1]) !== expectedChecked || Number(total[2]) !== expectedTotal) {
      problems.push(`合计：表里写 ${total[1]} / ${total[2]}，实际数出来 ${expectedChecked} / ${expectedTotal}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('docs/00 与 CLAUDE.md 引用的条数与文档里数出来的一致', () => {
    // 同一个数字抄在三处，而此前只有签署表被断言焊住 —— 于是加了 10 条的那一轮改了表、
    // 另外两处没人管，三处各说各话（表 199/476、docs/00 189/466、CLAUDE.md 466）。
    // docs/00 是「现在还欠什么」的唯一入口，它写着的数字比签署表更常被人当真。
    const all = rows();
    const total = all.length;
    const checked = all.filter((row) => row.checked).length;
    const problems: string[] = [];
    const cite = (file: string, pattern: RegExp, expected: number[], label: string) => {
      const found = pattern.exec(readFileSync(file, 'utf8'));
      if (!found) { problems.push(`${file} 里找不到${label}那句（正则：${pattern.source}）`); return; }
      const actual = expected.map((_, index) => Number(found[index + 1]));
      if (actual.some((value, index) => value !== expected[index])) {
        problems.push(`${file} 的${label}写 ${actual.join(' / ')}，实际数出来 ${expected.join(' / ')}`);
      }
    };
    cite('docs/00-state.md', /当前 \*\*(\d+) *\/ *(\d+)\*\*/, [checked, total], '勾选状态');
    cite('docs/00-state.md', /验收条目 (\d+) 条未勾/, [total - checked], '未勾条数');
    cite('CLAUDE.md', /是 (\d+) 条可逐条勾选/, [total], '总条数');
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
