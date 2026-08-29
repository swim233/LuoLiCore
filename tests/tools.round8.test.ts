import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { FileTools, PathJail, SKILL_NARROWING_EXEMPT, Sandbox, SkillLoader, ToolRegistry, citeArchivedMessages, extractHtml } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 第八轮：工具系统专项复审的回归用例。每一条固定的都是一个实测过的失败形态，而不是
 * 读代码推测出的问题，用例名即那个形态。
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
    // 旧实现：depth 只限层数不去重，这棵三条目的树列出 17 条，其中 5 条 path 是空串
    // （`loop` 的 realpath 即搜索根，`relative(root, root)` 为 ''），模型拿空串调 read_file
    // 会读到目录本身。
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
    // 旧实现：`jail.resolve` 对越界软链抛 path_outside_workspace，而遍历中的这次抛出无人捕获，
    // 整次 list/glob/grep 返回 ok:false，同目录另外几百个正常文件一并不可见。docs/22 · I-03
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
    // 旧实现：`truncated: matches.length >= 500`，恰好 500 条也报截断，模型据此缩小范围
    // 重查一次本已完整的结果，并会认为自己没看全。
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
    // 旧实现：skipped 恒为 0，模型据此判定这就是全部命中，而 §3.1 的规定是条数必须交出去，
    // 否则模型会认为自己已看全。
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
    // 起点按 offset 之前的换行数计算。旧实现没有行号，续读时若从 1 重新计数，模型据此定位会全错。
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
    // 旧实现：schema 里没有 recursive，而 rename 一个目录就是把整棵树移走，一次已批准的
    // delete_file 能移走半个工作目录，而审批弹窗上只显示一个路径。
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
    // 旧实现：invalid_input 完全不计数，实测同一个错误调用连发 5 次全部被接受，唯一的边界是
    // maxSteps，在用户侧表现为 bot 忙了半分钟后回复无法完成。
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 'bad' }, context)).toMatchObject({ error: 'tool_disabled_after_errors' });
    // 门槛是连续失败：熔断前成功一次即应清零。
    const fresh = { turn: turnOf({ turnId: 't2' }), workspace: '.', agentKind: 'main' as const };
    expect(await registry.execute('strict', { n: 'bad' }, fresh)).toMatchObject({ error: 'invalid_input' });
    expect(await registry.execute('strict', { n: 1 }, fresh)).toMatchObject({ ok: true });
    expect(await registry.execute('strict', { n: 'bad' }, fresh)).toMatchObject({ error: 'invalid_input' });
  });

  it('审批被拒连续两次就停用该工具', async () => {
    const registry = new ToolRegistry(log, { request: async () => false } as ApprovalBroker, limits);
    registry.register({ name: 'gated', description: '', inputSchema: z.object({}), policy: { ...policy, approval: 'always' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const context = { turn: turnOf(), workspace: '.', agentKind: 'main' as const };
    // 每一次被拒的重试都会向 owner 推送一条审批通知。旧实现连发 6 次全部被接受。
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
    // 旧实现：只豁免 load_skill，于是一个 `allowed-tools: [bash]` 的 skill 会导致模型执行完成后
    // 无法追发任何一条消息。
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
    // 旧实现：这一档返回的 allowedTools 等于当前全部可用工具，而调用方无条件并入本轮允许集，
    // 于是先载入 narrow 再载入 open 时，narrow 的收窄被整体抹掉。
    expect(loader.load('open', 'limited', ['read_file', 'bash'])).toMatchObject({ narrows: false });
    closeDatabase(db);
  });
});

describe('R8-WEB-01 · web_fetch 抓回来的 HTML 要抽成正文', () => {
  it('剥掉 script / style / 注释，块级标签换行，实体解码', () => {
    const extracted = extractHtml(`<!doctype html><html><head><title>t</title><style>a{color:red}</style></head>
      <body><script>var x = "<p>not text</p>";</script><!-- 注释 --><h1>标题</h1><p>第一段 &amp; 实体</p>
      <ul><li>甲</li><li>乙</li></ul><div>末尾</div></body></html>`).text;
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
    // 与 docs/24 · R-SEC-01（grep 换 RE2）是同一条结论：接受任意输入就必须有线性上界。
    // 属性解析加入之后这条尤其要通过：`attribute` 只允许在已被 `>` 界定的那一个标签内扫描。
    const started = performance.now();
    expect(extractHtml(`${'<script>'.repeat(80_000)}tail`).text).toBe('');
    expect(extractHtml(`${'<div><p><span>'.repeat(60_000)}tail`).text).toContain('tail');
    // 一万个带属性的链接：属性解析是逐标签的，总代价仍与输入线性相关。
    expect(extractHtml(`${'<a href="/x?a=1&b=2" data-href="trap">锚</a>'.repeat(10_000)}`).text).toContain('锚');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/**
 * 抽成纯文本之后仍有三处在丢失信息：模型看不到页面上确实存在的标题、链接地址与图片。
 * 这三条各自对应取回来了但读不到的一个分支，见 `tools/web.ts · extractHtml` 的注释。
 */
describe('web_fetch 抽取层：标题 / 链接 / 图片不能再丢', () => {
  it('`<title>` 要留下来 —— head 整棵被丢，标题此前永远到不了模型', () => {
    const page = extractHtml('<html><head><meta name="x" content="y"><title>洛璃 &amp; 核心</title><script>var a=1</script></head><body><p>正文</p></body></html>');
    expect(page.title).toBe('洛璃 & 核心');
    // head 里其余内容仍属噪声，不得随标题一起进入正文。
    expect(page.text).not.toContain('var a');
    expect(page.text).not.toContain('content="y"');
    expect(page.text).toContain('正文');
    // 标题只走 title 字段，不重复写入正文。
    expect(page.text).not.toContain('洛璃');
  });

  it('没有 title 时是 null，不是空串 —— 「没有标题」和「标题是空的」对模型是两回事', () => {
    expect(extractHtml('<html><body><p>只有正文</p></body></html>').title).toBeNull();
    expect(extractHtml('<html><head><title>   </title></head><body>x</body></html>').title).toBeNull();
  });

  it('`<a href>` 按 baseUrl 解析成绝对地址：相对路径对模型等于没给', () => {
    const page = extractHtml('<p>见 <a href="/docs/a.html">这一页</a> 与 <a href="https://b.example/x">那一页</a></p>', 'https://a.example/blog/index.html');
    expect(page.text).toContain('[这一页](https://a.example/docs/a.html)');
    expect(page.text).toContain('[那一页](https://b.example/x)');
    expect(page.links).toBe(2);
  });

  it('锚点、javascript:、data: 不算链接；data URI 能有几十 KB，够把输出预算吃光', () => {
    const page = extractHtml('<a href="#top">回顶部</a><a href="javascript:void(0)">假链接</a><a href="data:text/html;base64,AAAA">内联</a>', 'https://a.example/');
    expect(page.links).toBe(0);
    expect(page.text).not.toContain('(');
    // 锚文本本身仍需保留：它是页面上真实存在的文字。
    expect(page.text).toContain('回顶部');
    expect(page.text).toContain('假链接');
  });

  it('`data-href` 不许命中 `href` —— 属性名前面必须是空白', () => {
    const page = extractHtml('<a data-href="/trap">文字</a>', 'https://a.example/');
    expect(page.links).toBe(0);
    expect(page.text).not.toContain('trap');
  });

  it('`<img>` 交出 alt 与 src；懒加载站点的 data-src 也认', () => {
    const page = extractHtml('<img src="/a.png" alt="一只猫"><img data-src="/b.png" alt="占位"><img alt="没有地址">', 'https://a.example/p/');
    expect(page.text).toContain('![一只猫](https://a.example/a.png)');
    expect(page.text).toContain('![占位](https://a.example/b.png)');
    // 没有可用地址时至少保留 alt：模型需要知道此处有一张图，才能决定是否再取一次。
    expect(page.text).toContain('[图：没有地址]');
  });

  it('属性值的三种写法都认，未闭合的 `<a>` 也要补上右括号', () => {
    expect(extractHtml(`<a href='/single'>甲</a>`, 'https://a.example/').text).toContain('[甲](https://a.example/single)');
    expect(extractHtml('<a href=/bare>乙</a>', 'https://a.example/').text).toContain('[乙](https://a.example/bare)');
    // 开了 `[` 却未闭合等于交出一份损坏的 markdown。
    expect(extractHtml('<a href="/x">丙', 'https://a.example/').text).toBe('[丙](https://a.example/x)');
  });

  it('撞上链接上限之后只留锚文本，并把省掉的条数交出去', () => {
    const page = extractHtml(`${'<a href="/x">锚</a>'.repeat(500)}`, 'https://a.example/');
    expect(page.links).toBe(200);
    expect(page.linksOmitted).toBe(300);
    // 到达上限后不得再开括号：`[` 开了却没有地址可填就是损坏的 markdown。
    expect([...page.text].filter((char) => char === '[')).toHaveLength(200);
  });
});

describe('R8-EXEC-01 · python 落成临时文件再跑', () => {
  it('正文里有一行 PY 也照样跑完，且脚本路径在沙箱的 cwd 下解析得到', async () => {
    const workspace = resolve('data/round8-python');
    rmSync(workspace, { recursive: true, force: true });
    const sandbox = new Sandbox({ mode: 'none', bypassRoles: ['owner'], dockerBin: 'docker', workspaceDir: workspace, hostWorkspaceDir: '',
      image: 'x', network: 'none', memoryMb: 256, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 16,
      defaultTimeoutMs: 20_000, maxTimeoutMs: 20_000, maxOutputBytes: 65_536 });
    // `python` 工具做的两件事，按同一顺序：脚本写入 workspace 内的 .luoli-tmp/，命令里给出的是
    // workspace 内的相对路径。路径这一步曾差点改成走 FileTools，而 allowHostFsForOwner 打开时
    // owner 的 jail 根是 `/`，文件会落到 /.luoli-tmp/，而沙箱 cwd 仍是 workspace。
    const code = 'import sys\nheredoc_killer = """\nPY\n"""\nprint("ran", sys.argv[0])\n';
    mkdirSync(join(workspace, '.luoli-tmp'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, '.luoli-tmp/script.py'), code, { mode: 0o600 });
    const result = await sandbox.run('python3 ".luoli-tmp/script.py"', 'owner', workspace, new AbortController().signal, 20_000, 'round8');
    expect(result.stderr).toBe('');
    // 旧实现拼的是 `python3 - <<'PY'`：正文里出现的 `PY` 一行会把脚本从该处截断（导致 `"""`
    // 不闭合、报 SyntaxError），且 argv[0] 是 `-`、traceback 里的文件名是 `<stdin>` 并且没有源码行。
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
    // Telegram 编号刻意与归档 id 错开：两者相等时，回复标记是否正确转换这条断言测不到任何东西。
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
    // 时刻晚于最后一条时落到最后一条，而不是返回空结果。
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
    // 归档 id 与 Telegram 编号不是同一套：原样渲染 `↩︎#107` 时模型调 get_message(107) 取不到内容。
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
