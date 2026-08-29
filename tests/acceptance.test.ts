import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 让 `docs/13` 的勾选具备约束力。
 *
 * 那份文档从第二轮起就没有更新：372 条全是 `[ ]`、签署表 12 行全空（docs/24 §4）。
 * 仅把框勾上没有意义：下一轮无人能判断那个 `[x]` 背后是确有用例还是随手勾的。
 * 因此勾选形式被固定为 `[x]` 加一份可重跑或可复查的凭据，由下面几条断言逐条核对：
 *
 * - `(自动)` 勾选必须指明用例文件，且该文件确实存在；
 * - `(手动)` 勾选必须指明日期与场次，且 `docs/29` 里确有该条的台账小节；
 * - 未勾选的不得带注记（防止先写注记、后补勾选的半完成状态）；
 * - `[x]` 必须带 `(自动)` 或 `(手动)` 其一，不得同时带两个或一个都不带；
 * - 签署表里每个模块的分母与分子必须等于文档中实际统计出的条数。
 *
 * 最后一条是这份文档此前最易失效的地方：条目改了、表格没改，两个数字从此互不一致。
 *
 * `(手动)` 这一档是 2026-08-25 加入的。此前的规则是只有 `(自动)` 能勾选：当时没有实际手测，
 * `[x]` 只能由用例背书，该规则是成立的；其副作用是一次人工验收无法让文档里任何一个数字发生
 * 变化，145 条手动项完成后仍是 145 个空框。开放这一档等于把举证责任从存在可重跑的用例，换成
 * 有人在某一天记录了实测值，因此下面三条附加约束不是修饰：日期要能解析、场次号要对得上、
 * `docs/29` 里必须确有该条的小节。它们是这道闸放开之后仅存的约束。
 */

const DOC = 'docs/13-acceptance-criteria.md';
// 编号可能带小写后缀（`AC-TOOL-001a`、`AC-WEB-011b` 这类拆细的子项），后缀还可能再带一位数字
// 继续细分（`AC-WEB-016b1` / `016b2`）；`★` 出现在 `(自动)` 前后都有先例，两种顺序都要识别：
// 正则过严时那些行会被静默漏掉，而在这份文档里漏掉等同于无人核对。
// 末尾那个 `\d*` 不能省：缺它时 `AC-WEB-016b1` 会被截成 `AC-WEB-016b`，于是三条互不相同的
// 条目在下面编号不重复那条里被报成一组重号；而真给它打上 `[x]` 时，CHECKED 又会因剩下的
// `1 (自动)` 无法匹配而整行落空，该条从此不进入任何计数。
const CHECKED = /^\| \[x\] (AC-[A-Z]+-\d+[a-z]?\d*)((?: ★| \(自动\)| \(手动\))+) \|(.*)$/;
const UNCHECKED = /^\| \[ \] (AC-[A-Z]+-\d+[a-z]?\d*)/;
// 手测注记：`〔手测 2026-08-26 · S5〕`。日期这一格必须能解析：它是何人于何日验证这件事的唯一
// 锚点，写成 `〔手测 · S5〕` 等同于没写。
const MANUAL_NOTE = /^手测 (\d{4}-\d{2}-\d{2}) · (S\d+)$/;
const LEDGER = 'docs/29-manual-acceptance-log.md';

interface Row { id: string; module: string; checked: boolean; kind: 'auto' | 'manual' | null; annotation: string | null; line: number }

function rows(): Row[] {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const out: Row[] = [];
  for (const [index, line] of lines.entries()) {
    const checked = CHECKED.exec(line);
    const unchecked = UNCHECKED.exec(line);
    const id = checked?.[1] ?? unchecked?.[1];
    if (!id) continue;
    const marks = checked?.[2] ?? line.slice(0, line.indexOf('|', 2));
    const kind = marks.includes('(手动)') ? 'manual' : marks.includes('(自动)') ? 'auto' : null;
    const annotation = /〔([^〕]+)〕\s*$/.exec(line)?.[1] ?? null;
    out.push({ id, module: id.split('-')[1]!, checked: Boolean(checked), kind, annotation, line: index + 1 });
  }
  return out;
}

/**
 * `docs/29` 里每场是一个 `## S<n> · <场次名>`，场内每条是一个 `### <AC 编号>`。
 * 返回一张条目到所属场次的映射表；`§4 豁免登记` / `§5 缺陷` 这些不以 `S<n>` 开头的二级标题
 * 会清空当前场次，否则记在缺陷清单里的失败条目也能为 `docs/13` 的勾选背书。
 */
function ledgerSessions(): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(LEDGER)) return found;
  let session: string | null = null;
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    const heading = /^## (S\d+) · /.exec(line);
    if (line.startsWith('## ')) session = heading?.[1] ?? null;
    const entry = session && /^### (AC-[A-Z]+-\d+[a-z]?\d*)\b/.exec(line);
    if (entry) found.set(entry[1]!, session!);
  }
  return found;
}

describe('docs/13 的勾选是可核对的', () => {
  it('每个勾上的 (自动) 都点名了真实存在的用例文件', () => {
    const broken: string[] = [];
    for (const row of rows().filter((entry) => entry.checked && entry.kind === 'auto')) {
      if (!row.annotation) { broken.push(`${row.id}（第 ${row.line} 行）勾了但没写用例文件`); continue; }
      for (const file of row.annotation.split('、').map((name) => name.trim())) {
        if (!existsSync(`tests/${file}`)) broken.push(`${row.id} 指向的 tests/${file} 不存在`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('每个勾上的 (手动) 都点名了日期与场次，且 docs/29 里真有那一条', () => {
    // 手测这一档没有可重跑的凭据，全部依据是某人某天在某一场里完成了验证。因此三项缺一不可：
    // 日期能解析、场次号形如 `S<n>`、`docs/29` 的那一场里确有一个 `### <编号>` 小节。
    // 缺最后一条时，`〔手测 2026-08-26 · S9〕` 可以指向一个并不存在的场次，勾选就退化成单纯
    // 打勾，而这份文档存在的理由正是阻止这种退化。
    const ledger = ledgerSessions();
    const broken: string[] = [];
    for (const row of rows().filter((entry) => entry.checked && entry.kind === 'manual')) {
      const note = row.annotation && MANUAL_NOTE.exec(row.annotation);
      if (!note) {
        broken.push(`${row.id}（第 ${row.line} 行）的注记不是〔手测 YYYY-MM-DD · S<n>〕：${row.annotation ?? '（没有注记）'}`);
        continue;
      }
      if (Number.isNaN(Date.parse(note[1]!))) broken.push(`${row.id} 的日期 ${note[1]} 解析不出来`);
      const session = ledger.get(row.id);
      if (!session) broken.push(`${row.id} 勾了，但 ${LEDGER} 的任何一场里都没有它的 ### 小节`);
      else if (session !== note[2]) broken.push(`${row.id} 注记写 ${note[2]}，而 ${LEDGER} 把它记在 ${session}`);
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('编号不重复', () => {
    // 重号会使 AC-WEB-035 是否通过这一问题没有确定答案：一条勾着、一条没勾，签署表照样能算平
    // （两条各计一次），上面几条断言也全部通过，因为它们逐行检查、从不横向比对。而这份文档的
    // 用途正是按编号逐条勾选，编号不唯一等于该动作失去指代对象。
    const seen = new Map<string, number[]>();
    for (const row of rows()) (seen.get(row.id) ?? seen.set(row.id, []).get(row.id)!).push(row.line);
    const dup = [...seen].filter(([, lines]) => lines.length > 1)
      .map(([id, lines]) => `${id} 出现 ${lines.length} 次：第 ${lines.join('、')} 行`);
    expect(dup, `这些编号被用了不止一次：\n${dup.join('\n')}`).toEqual([]);
  });

  it('没勾的条目不许挂用例注记', () => {
    // 反方向同样要拦：写了注记但没勾选时，后续人员会认为已验证只是漏勾而直接补勾。
    const dangling = rows().filter((row) => !row.checked && row.annotation).map((row) => `${row.id}（第 ${row.line} 行）`);
    expect(dangling, `这些条目挂着用例注记却没有勾选：${dangling.join('、')}`).toEqual([]);
  });

  it('勾选的条目必须标 (自动) 或 (手动)，且只能标一个', () => {
    const lines = readFileSync(DOC, 'utf8').split('\n');
    // 使用这条宽松正则而不是 `CHECKED`：两个标记都不带的 `[x]` 行既不匹配 `CHECKED` 也不匹配
    // `UNCHECKED`，会从 `rows()` 里整行漏出，于是不进入任何一处计数，签署表照样能算平。
    // 这一条专门用于捕获它。
    const bad = lines.filter((line) => {
      if (!/^\| \[x\] AC-/.test(line)) return false;
      const marks = line.slice(0, line.indexOf('|', 2));
      return marks.includes('(自动)') === marks.includes('(手动)');
    }).map((line) => line.slice(0, 48));
    expect(bad, `这些勾选行的标记不对（要么两个都没有，要么两个都有）：\n${bad.join('\n')}`).toEqual([]);
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
    // 使用 new RegExp 而不是字面量：模式里的 `/` 分隔符会提前终止正则字面量。
    const total = new RegExp('\\*\\*合计\\*\\* \\|[^|]*\\| *\\*\\*(\\d+) */ *(\\d+)\\*\\* \\|').exec(text);
    if (!total) problems.push('签署表里找不到合计行');
    else if (Number(total[1]) !== expectedChecked || Number(total[2]) !== expectedTotal) {
      problems.push(`合计：表里写 ${total[1]} / ${total[2]}，实际数出来 ${expectedChecked} / ${expectedTotal}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('docs/00 与 CLAUDE.md 引用的条数与文档里数出来的一致', () => {
    // 同一个数字出现在三处，而此前只有签署表被断言约束，于是新增 10 条的那一轮只改了表，
    // 另外两处未同步，三处互不一致（表 199/476、docs/00 189/466、CLAUDE.md 466）。
    // docs/00 是当前欠项的唯一入口，其中的数字比签署表更常被直接采信。
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
