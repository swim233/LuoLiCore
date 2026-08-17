import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { FileTools, PathJail, SKILL_NARROWING_EXEMPT, Sandbox, SkillLoader, ToolRegistry, citeArchivedMessages, htmlToText } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 第八轮：工具系统专项复审的回归用例。每一条钉的都是一个**实测过的**失败形态，而不是
 * 「读代码觉得不对」—— 用例名写的就是那个形态。
 */

function jail(name: string, maxRead = 1024): { root: string; files: FileTools } {
  const root = resolve(`data/round8-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { root, files: new FileTools(new PathJail(root, []), maxRead, 4096) };
}

describe('R8-FS-01 · 目录遍历：软链成环与越界软链都不该毁掉整次调用', () => {
  it('list_dir 按 realpath 去重，且显示软链名那一侧的路径而不是空串', () => {
    const { root, files } = jail('list-loop');
    mkdirSync(`${root}/a/b`, { recursive: true });
    writeFileSync(`${root}/a/b/f.txt`, 'x');
    symlinkSync('.', `${root}/loop`);
    // 旧实现：depth 只挡层数不挡重复 —— 这棵三条目的树列出 17 条，其中 5 条 path 是空串
    // （`loop` 的 realpath 就是搜索根，`relative(root, root)` = ''），而模型拿空串去 read_file
    // 就读到了目录本身。
    const out = files.list('.', 5) as { entries: Array<{ path: string; type: string }>; truncated: boolean; skipped: number };
    expect(out.entries.map((entry) => entry.path).sort()).toEqual(['a', 'a/b', 'a/b/f.txt', 'loop']);
    expect(out.entries.find((entry) => entry.path === 'loop')).toMatchObject({ type: 'directory' });
    expect(out.truncated).toBe(false);
  });

  it('一个指向 workspace 外的软链只让自己被跳过，同目录其它条目照旧交回', () => {
    const { root, files } = jail('escape-link');
    writeFileSync(`${root}/keep.txt`, 'needle');
    symlinkSync('/etc', `${root}/escape`);
    symlinkSync('/nowhere-at-all', `${root}/broken`);
    // 旧实现：`jail.resolve` 对越界软链抛 path_outside_workspace，而遍历里那一抛没人接 ——
    // 整次 list/glob/grep 返回 ok:false，同目录另外几百个好文件一并看不见。docs/22 · I-03
    // 只修了断链（statSync 抛 ENOENT）那半边。
    expect(files.list('.', 1)).toMatchObject({ ok: true, entries: [{ path: 'keep.txt' }], skipped: 2 });
    expect(files.glob('*.txt', '.')).toMatchObject({ ok: true, matches: ['keep.txt'], skipped: 2 });
    expect(files.grep('needle', '.')).toMatchObject({ ok: true, matches: [{ path: 'keep.txt', line: 1 }], skipped: 2 });
  });

  it('glob 与 grep 恰好命中上限而后面没有了，就不是 truncated', () => {
    const { root, files } = jail('exact-cap');
    for (let index = 0; index < 500; index += 1) writeFileSync(`${root}/f${index}.txt`, 'hit');
    const globbed = files.glob('*.txt', '.') as { matches: string[]; truncated: boolean };
    expect(globbed.matches).toHaveLength(500);
    // 旧实现：`truncated: matches.length >= 500` —— 恰好 500 条也报截断，模型于是去缩范围
    // 重查一次本来已经完整的结果，而且会以为自己没看全。
    expect(globbed.truncated).toBe(false);
    writeFileSync(`${root}/f500.txt`, 'hit');
    expect(files.glob('*.txt', '.')).toMatchObject({ truncated: true });
  });
});

describe('R8-FS-02 · grep：跳过的条数必须交出去', () => {
  it('超过读取预算的文件计入 skipped，而不是静静消失', () => {
    const { root, files } = jail('grep-skip', 64);   // 预算 64B ⇒ 上限 256B
    writeFileSync(`${root}/big.txt`, 'needle\n'.repeat(200));
    writeFileSync(`${root}/small.txt`, 'needle\n');
    // 旧实现：skipped 恒为 0，模型据此判断「这就是全部命中」—— 而 §3.1 立的规矩是
    // 「条数必须交出去，否则模型会以为自己看全了」。
    expect(files.grep('needle', '.')).toMatchObject({ ok: true, matches: [{ path: 'small.txt' }], skipped: 1 });
  });

  it('glob 按相对搜索根的路径筛文件，contextLines 附带前后行', () => {
    const { root, files } = jail('grep-args');
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/a.ts`, 'one\ntwo\nneedle\nfour\nfive');
    writeFileSync(`${root}/src/a.md`, 'needle');
    expect(files.grep('needle', '.', false, '**/*.ts')).toMatchObject({ matches: [{ path: 'src/a.ts', line: 3 }] });
    expect(files.grep('needle', '.', false, undefined, 1)).toMatchObject({
      matches: expect.arrayContaining([{ path: 'src/a.ts', line: 3, text: 'needle', before: ['two'], after: ['four'] }]) });
  });
});

describe('R8-FS-03 · read_file 的行号与 edit_file 的对照', () => {
  it('行号从 1 起，分页第二段接着往下数而不是重新从 1 开始', () => {
    const { root, files } = jail('numbered', 8);
    writeFileSync(`${root}/f.txt`, 'aaa\nbbb\nccc\nddd\n');
    expect(files.read('f.txt', 0, 8)).toMatchObject({ content: '1\taaa\n2\tbbb', firstLine: 1, truncated: true, nextOffset: 8 });
    // 起点按 offset 之前的换行数算。旧实现没有行号，接上之后若从 1 重数，模型据此定位就全错了。
    expect(files.read('f.txt', 8, 8)).toMatchObject({ content: '3\tccc\n4\tddd', firstLine: 3 });
  });

  it('oldString 里带着行号前缀时，edit_file 明说要去掉它', () => {
    const { root, files } = jail('edit-hint');
    writeFileSync(`${root}/f.txt`, 'alpha\nbeta\n');
    const failed = files.edit('f.txt', '2\tbeta', 'gamma') as { ok: boolean; error: string; hint?: string };
    expect(failed).toMatchObject({ ok: false, error: 'old_string_not_found' });
    expect(failed.hint).toContain('行号');
    expect(files.edit('f.txt', 'beta', 'gamma')).toMatchObject({ ok: true });
  });

  it('oldString 出现两次时要求唯一上下文，不做修改（AC-TOOL-007）', () => {
    const { root, files } = jail('edit-unique');
    writeFileSync(`${root}/f.txt`, 'x\nsame\ny\nsame\n');
    expect(files.edit('f.txt', 'same', 'other')).toMatchObject({ ok: false, error: 'old_string_not_unique', hint: 'matched 2 times' });
    expect(files.read('f.txt')).toMatchObject({ content: '1\tx\n2\tsame\n3\ty\n4\tsame' });
    expect(files.edit('f.txt', 'same', 'other', true)).toMatchObject({ ok: true });
    expect(files.read('f.txt')).toMatchObject({ content: '1\tx\n2\tother\n3\ty\n4\tother' });
  });
});

describe('R8-FS-04 · delete_file 删目录 = rm -r，要两道闸', () => {
  it('目录不给 recursive 就拒绝，二级以下才允许递归', () => {
    const { root, files } = jail('delete-dir');
    mkdirSync(`${root}/one/two/three`, { recursive: true });
    writeFileSync(`${root}/one/two/three/f.txt`, 'x');
    // 旧实现：schema 里压根没有 recursive，而 rename 一个目录就是把整棵树搬走 —— 一次
    // 已批准的 delete_file 能搬掉半个工作目录，审批弹窗上只看得到一个路径。
    expect(files.remove('one')).toMatchObject({ ok: false, error: 'path_is_directory' });
    expect(files.remove('one', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(files.remove('one/two', true)).toMatchObject({ ok: true, recursive: true });
    expect(files.exists('one/two')).toBe(false);
  });

  it('单个文件照旧只要一次调用，且进回收站不真删', () => {
    const { root, files } = jail('delete-file');
    writeFileSync(`${root}/f.txt`, 'x');
    const out = files.remove('f.txt') as { ok: boolean; trashedTo: string; recursive: boolean };
    expect(out).toMatchObject({ ok: true, recursive: false });
    expect(out.trashedTo).toMatch(/^\.luoli-trash\//);
    expect(files.exists(out.trashedTo)).toBe(true);
  });
});

const log = { span: () => ({ id: 's', end: () => undefined }), event: () => undefined } as unknown as LogSink;
const turnOf = (extra: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext => ({ turnId: 't', key: 'k', chatId: 'c', threadId: null,
  initiatorUserId: 'u', effectiveRole: 'owner', isPrivate: true, baseCommitId: null,
  snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
  abortSignal: new AbortController().signal, config: {}, ...extra } as RuntimeTurnContext);
const policy = { minRole: 'limited' as const, approval: 'never' as const, scope: 'global' as const, source: 'builtin' as const };
const limits = { maxRegistered: 10, maxCallsPerTurn: 20, maxConsecutiveErrors: 2 };

describe('R8-REG-01 · 熔断计数要覆盖最常见的两种失败', () => {
  it('参数写错连续两次就停用该工具', async () => {
    const registry = new ToolRegistry(log, { request: async () => true } as ApprovalBroker, limits);
    registry.register({ name: 'strict', description: '', inputSchema: z.object({ n: z.number() }), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    const context = { turn: turnOf(), workspace: '.', agentKind: 'main' as const };
    // 旧实现：invalid_input 一次都不计 —— 实测同一个错误的调用连发 5 次全部照收，唯一的
    // 边界是 maxSteps，而那对用户就是「bot 忙了半分钟然后说做不到」。
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'tool_disabled_after_errors' });
    // 门槛是**连续**失败：熔断前成功一次就该清零。
    const fresh = { turn: turnOf({ turnId: 't2' }), workspace: '.', agentKind: 'main' as const };
    expect(await registry.execute('strict', { n: 'bad' }, fresh)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 1 }, fresh)).toMatchObject({ ok: true });
    expect(await registry.execute('strict', { n: 'bad' }, fresh)).toMatchObject({ error: 'invalid_input' });
  });

  it('审批被拒连续两次就停用该工具', async () => {
    const registry = new ToolRegistry(log, { request: async () => false } as ApprovalBroker, limits);
    registry.register({ name: 'gated', description: '', inputSchema: z.object({}), policy: { ...policy, approval: 'always' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const context = { turn: turnOf(), workspace: '.', agentKind: 'main' as const };
    // 每一次被拒的重试都是一条推给 owner 的审批通知。旧实现连发 6 次全部照收。
    expect(await registry.execute('gated', {}, context)).toMatchObject({ error: '未获批准' });
    expect(await registry.execute('gated', {}, context)).toMatchObject({ error: '未获批准' });
    expect(await registry.execute('gated', {}, context)).toMatchObject({ error: 'tool_disabled_after_errors' });
  });
});

describe('R8-SKILL-01 · skill 的 allowed-tools 收窄不到核心工具集', () => {
  it('收窄生效时 send_message / report_progress / context_stats 仍然可调', async () => {
    const registry = new ToolRegistry(log, { request: async () => true } as ApprovalBroker, limits);
    for (const name of ['bash', 'send_message', 'read_file']) {
      registry.register({ name, description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true, ran: name }) });
    }
    const context = { turn: turnOf({ skillAllowedTools: new Set(['bash']) }), workspace: '.', agentKind: 'main' as const };
    expect(await registry.execute('bash', {}, context)).toMatchObject({ ok: true, ran: 'bash' });
    // 旧实现：只豁免 load_skill，于是一个 `allowed-tools: [bash]` 的 skill 让模型跑完之后
    // 连一句话都追发不出去。
    expect(await registry.execute('send_message', {}, context)).toMatchObject({ ok: true, ran: 'send_message' });
    expect(await registry.execute('read_file', {}, context)).toMatchObject({ error: 'tool_not_in_allowlist' });
    expect(SKILL_NARROWING_EXEMPT).toContain('send_message');
  });

  it('未声明 allowed-tools 的 skill 交回 narrows:false，不该被并进允许集', () => {
    const path = './data/round8-skills.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const directory = resolve('data/round8-skills');
    rmSync(directory, { recursive: true, force: true });
    for (const [name, frontmatter] of [['narrow', 'allowed-tools: [read_file]\n'], ['open', '']] as const) {
      mkdirSync(`${directory}/${name}`, { recursive: true });
      writeFileSync(`${directory}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\nmin-role: limited\n${frontmatter}---\nbody\n`);
    }
    const db = openDatabase(path); migrateDatabase(db);
    const loader = new SkillLoader(db, directory, 'limited');
    loader.scan();
    expect(loader.load('narrow', 'limited', ['read_file', 'bash'])).toMatchObject({ narrows: true, allowedTools: ['read_file'] });
    // 旧实现：这一档交回的 allowedTools 等于「当前全部可用工具」，而调用方无条件并进本轮
    // 允许集 —— 先载入 narrow 再载入 open，narrow 的收窄就被整个抹掉了。
    expect(loader.load('open', 'limited', ['read_file', 'bash'])).toMatchObject({ narrows: false });
    closeDatabase(db);
  });
});

describe('R8-WEB-01 · web_fetch 抓回来的 HTML 要抽成正文', () => {
  it('剥掉 script / style / 注释，块级标签换行，实体解码', () => {
    const extracted = htmlToText(`<!doctype html><html><head><title>t</title><style>a{color:red}</style></head>
      <body><script>var x = "<p>not text</p>";</script><!-- 注释 --><h1>标题</h1><p>第一段 &amp; 实体</p>
      <ul><li>甲</li><li>乙</li></ul><div>末尾</div></body></html>`);
    expect(extracted).not.toContain('color:red');
    expect(extracted).not.toContain('var x');
    expect(extracted).not.toContain('注释');
    expect(extracted).toContain('标题');
    expect(extracted).toContain('第一段 & 实体');
    expect(extracted).toContain('- 甲');
    expect(extracted).toContain('末尾');
    expect(extracted).not.toMatch(/<[a-z]/i);
  });

  it('一堆开标签而没有闭标签时仍是线性的，不回溯', () => {
    // 正则版（`<script[^>]*>[\s\S]*?</script>`）在这个形状上是 O(n²)：25 万个起点各扫到结尾。
    // 与 docs/24 · R-SEC-01（grep 换 RE2）同一条教训 —— 接受任意输入就必须有线性上界。
    const started = performance.now();
    expect(htmlToText(`${'<script>'.repeat(80_000)}tail`)).toBe('');
    expect(htmlToText(`${'<div><p><span>'.repeat(60_000)}tail`)).toContain('tail');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('R8-EXEC-01 · python 落成临时文件再跑', () => {
  it('正文里有一行 PY 也照样跑完，且脚本路径在沙箱的 cwd 下解析得到', async () => {
    const workspace = resolve('data/round8-python');
    rmSync(workspace, { recursive: true, force: true });
    const sandbox = new Sandbox({ mode: 'none', bypassRoles: ['owner'], dockerBin: 'docker', workspaceDir: workspace, hostWorkspaceDir: '',
      image: 'x', network: 'none', memoryMb: 256, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 16,
      defaultTimeoutMs: 20_000, maxTimeoutMs: 20_000, maxOutputBytes: 65_536 });
    // `python` 工具做的两件事，按同一顺序：脚本写进 workspace 内的 .luoli-tmp/，命令里给的是
    // **workspace 内的相对路径**。路径这一步曾经差点写成走 FileTools —— 而 allowHostFsForOwner
    // 打开时 owner 的 jail 根是 `/`，文件会落到 /.luoli-tmp/ 而沙箱 cwd 仍是 workspace。
    const code = 'import sys\nheredoc_killer = """\nPY\n"""\nprint("ran", sys.argv[0])\n';
    mkdirSync(join(workspace, '.luoli-tmp'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, '.luoli-tmp/script.py'), code, { mode: 0o600 });
    const result = await sandbox.run('python3 ".luoli-tmp/script.py"', 'owner', workspace, new AbortController().signal, 20_000, 'round8');
    expect(result.stderr).toBe('');
    // 旧实现拼的是 `python3 - <<'PY'`：正文里那一行 `PY` 把脚本从那里截断（于是 `"""` 不闭合，
    // SyntaxError），而 argv[0] 是 `-`、traceback 里的文件名是 `<stdin>` 且没有源码行。
    expect(result.stdout.trim()).toBe('ran .luoli-tmp/script.py');
    expect(result.ok).toBe(true);
  });
});

describe('R8-ARCH-01 · read_messages 要能往前翻，search_messages 要能过滤', () => {
  function archive(): { db: ReturnType<typeof openDatabase>; scoped: ReturnType<ArchiveRepository['scope']> } {
    const path = './data/round8-archive.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const scoped = new ArchiveRepository(db).scope('c', null);
    // Telegram 编号刻意与归档 id 错开：两者相等时「回复标记换没换过来」这条断言什么都测不到。
    for (let index = 1; index <= 10; index += 1) {
      scoped.append({ chatId: 'c', messageThreadId: null, tgMessageId: index + 100, direction: 'in', fromKind: 'user',
        fromUserId: index % 2 ? '111' : '222', fromName: 'n', fromUsername: index % 2 ? 'alice' : 'bob',
        kind: index === 4 ? 'photo' : 'text', text: `记录 ${index} needle`, tgDate: index * 1000, raw: {} });
    }
    return { db, scoped };
  }

  it('anchor + direction 三种方向都按 id 升序交回', () => {
    const { db, scoped } = archive();
    const all = scoped.recent(10).reverse();
    const anchor = all[5]!.id;
    const before = scoped.window({ anchorId: anchor, direction: 'before', limit: 3 });
    expect(before.map((row) => row.text)).toEqual(['记录 4', '记录 5', '记录 6'].map((text) => `${text} needle`));
    const after = scoped.window({ anchorId: anchor, direction: 'after', limit: 3 });
    expect(after.map((row) => row.text)).toEqual(['记录 6', '记录 7', '记录 8'].map((text) => `${text} needle`));
    const around = scoped.window({ anchorId: anchor, direction: 'around', limit: 5 });
    expect(around.map((row) => row.text)).toEqual(['记录 4', '记录 5', '记录 6', '记录 7', '记录 8'].map((text) => `${text} needle`));
    // 不给 anchor 就是最近若干条，同样按时间顺序（旧实现是唯一的形态）。
    expect(scoped.window({ limit: 2 }).map((row) => row.text)).toEqual(['记录 9 needle', '记录 10 needle']);
    closeDatabase(db);
  });

  it('ISO 时间锚点落到该时刻起的第一条消息上', () => {
    const { db, scoped } = archive();
    expect(scoped.window({ anchorDate: 7000, direction: 'after', limit: 2 }).map((row) => row.text)).toEqual(['记录 7 needle', '记录 8 needle']);
    // 时刻晚于最后一条：落到最后一条，而不是空手而归。
    expect(scoped.window({ anchorDate: 99_000, direction: 'before', limit: 1 }).map((row) => row.text)).toEqual(['记录 10 needle']);
    closeDatabase(db);
  });

  it('渲染成 doc §3.2 的一行一条，回复标记换成归档 id', () => {
    const { db, scoped } = archive();
    scoped.append({ chatId: 'c', messageThreadId: null, tgMessageId: 200, direction: 'in', fromKind: 'user', fromUserId: '111',
      fromName: '张三', fromUsername: 'zhangsan', kind: 'text', text: '多行\n正文', tgDate: 20_000, raw: {}, replyToTgMessageId: 107 });
    const rows = scoped.window({ limit: 1 });
    const [line] = citeArchivedMessages(rows, { timezone: 'Asia/Shanghai', resolveReplies: (ids) => scoped.archiveIdsByTgMessageIds(ids) });
    const replied = scoped.recent(20).find((row) => row.tgMessageId === 107)!;
    // 归档 id 与 Telegram 编号不是一套：原样渲染 `↩︎#107` 的话模型 get_message(107) 什么都取不到。
    expect(replied.id).toBe(7);
    expect(line).toBe(`#${rows[0]!.id} [1970-01-01 08:00] 张三(@zhangsan): 多行 ⏎ 正文   ↩︎#7`);
    // 一行一条：多行正文不能在结果里伪造出别人的发言。
    expect(line).not.toContain('\n');
    closeDatabase(db);
  });

  it('from / after / before / kind 四个过滤条件各自生效，也能叠加', () => {
    const { db, scoped } = archive();
    expect(scoped.search('needle', 50, { from: '@alice' }).every((row) => row.fromUsername === 'alice')).toBe(true);
    expect(scoped.search('needle', 50, { from: '222' }).every((row) => row.fromUserId === '222')).toBe(true);
    expect(scoped.search('needle', 50, { kind: 'photo' }).map((row) => row.text)).toEqual(['记录 4 needle']);
    expect(scoped.search('needle', 50, { after: 8000 }).map((row) => row.tgDate).sort((left, right) => left - right)).toEqual([8000, 9000, 10_000]);
    expect(scoped.search('needle', 50, { after: 3000, before: 5000, from: '111' }).map((row) => row.tgDate)).toEqual([5000, 3000]);
    // 一个都不传就是原来的行为。
    expect(scoped.search('needle', 50)).toHaveLength(10);
    closeDatabase(db);
  });
});
