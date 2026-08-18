import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CustomToolRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { BUNDLED_SKILLS, CustomToolManager, PluginManager, Sandbox, SkillLoader, ToolRegistry, configSchema, registerAuthoringTools, type Config, type LogSink } from '@luoli/core';
import { zipFixture } from './fixtures/zip.js';

const log = { event: () => undefined, publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as unknown as LogSink;

function harness(name: string, selfExtend: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const root = resolve(`./data/${name}-root`);
  rmSync(root, { recursive: true, force: true });
  for (const dir of ['workspace', 'skills', 'plugins']) mkdirSync(`${root}/${dir}`, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  // `media.dir` 必须指到用例自己的根下：默认是 `./data/files`，也就是**真实的附件库** ——
  // `install_skill` 的 source 白名单里有它，用例往那儿写 fixture 等于污染真实数据。
  let config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, sandbox: { mode: 'jail' }, media: { dir: `${root}/files` },
    tools: { selfExtend: { enabled: true, customTools: { enabled: true }, skills: { enabled: true }, plugins: { enabled: true }, mcp: { enabled: true }, ...selfExtend } } }) as Config;
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  const sandbox = new Sandbox(() => ({ mode: 'jail', bypassRoles: ['owner'], dockerBin: 'docker', image: 'x', network: 'none',
    memoryMb: 256, cpus: 1, pidsLimit: 64, readOnlyRoot: false, tmpfsMb: 16, workspaceDir: `${root}/workspace`, hostWorkspaceDir: '',
    defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 65_536 }));
  const skills = new SkillLoader(db, `${root}/skills`);
  const plugins = new PluginManager(db, `${root}/plugins`, 1000, 3);
  plugins.bindRegistry(registry);
  const customTools = new CustomToolManager(new CustomToolRepository(db), () => config.tools.selfExtend, sandbox, log, () => config.tools.exec.maxTimeoutMs);
  customTools.bindRegistry(registry);
  const emitted: string[][] = [];
  registerAuthoringTools(registry, { customTools, skills, plugins, reservedSkills: BUNDLED_SKILLS,
    mcp: { db, config: () => config, apply: (next) => { config = next as Config; }, emit: (keys) => emitted.push(keys) } });
  registry.bindOverrides(() => config.tools.overrides);
  const turn = { turnId: 't1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2',
    effectiveRole: 'owner' as 'owner' | 'trusted' | 'limited',
    isPrivate: true, baseCommitId: null, config, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal };
  // `turn.config` 是每轮的快照，`install_mcp` 之后要拿新的那份才能看到刚写进去的 server。
  const contextFor = (patch: Partial<typeof turn> = {}) => ({ turn: { ...turn, ...patch, config }, workspace: `${root}/workspace`, agentKind: 'main' }) as never;
  const relax = (tool: string, minRole: string): void => {
    config = { ...config, tools: { ...config.tools, overrides: { ...config.tools.overrides, [tool]: { enabled: true, minRole } } } } as Config;
  };
  return { db, registry, skills, plugins, root, emitted, contextFor, relax, config: () => config };
}

describe('self-authoring tools', () => {
  it('registers all eight regardless of config, and gates them with available()', () => {
    const on = harness('author-on');
    const family = ['define_tool', 'delete_tool', 'list_tools', 'write_skill', 'install_skill', 'write_plugin', 'install_mcp', 'list_mcp'];
    expect(family.filter((name) => on.registry.has(name))).toEqual(family);
    expect(family.filter((name) => on.registry.activeNames('owner', on.contextFor()).includes(name))).toEqual(family);
    closeDatabase(on.db);

    // 关掉总开关时它们仍然**注册着**（否则 `main.ts` 那条 `TOOL_POLICY ↔ 注册表` 的启动断言会抛），
    // 但一个都不进目录。
    const off = harness('author-off', { enabled: false } as Record<string, unknown>);
    expect(family.filter((name) => off.registry.has(name))).toEqual(family);
    expect(family.filter((name) => off.registry.activeNames('owner', off.contextFor()).includes(name))).toEqual([]);
    closeDatabase(off.db);
  });

  it('keeps the owner floor even when an operator relaxes minRole in tools.overrides', () => {
    const h = harness('author-floor');
    const trusted = h.contextFor({ effectiveRole: 'trusted' });
    // 覆盖层改得动 `effectivePolicy().minRole`，改不动 `available()`。少了后者那道地板，一次
    // `PATCH /api/tools/write_plugin {minRole:'trusted'}` 就等于让任意受信会话里的成员往本进程
    // 里写全信任代码（docs/14 A27）。目录与准入两侧都要挡。
    h.relax('write_plugin', 'trusted');
    expect(h.registry.activeNames('trusted', trusted)).not.toContain('write_plugin');
    expect(h.registry.admit('write_plugin', trusted)).toMatchObject({ ok: false });
    h.relax('define_tool', 'limited');
    const limited = h.contextFor({ effectiveRole: 'limited' });
    expect(h.registry.activeNames('limited', limited)).not.toContain('define_tool');
    expect(h.registry.admit('define_tool', limited)).toMatchObject({ ok: false });
    closeDatabase(h.db);
  });

  it('writes a skill, honours the min-role floor, and refuses to overwrite the bundled manuals', async () => {
    const h = harness('author-skill');
    const context = h.contextFor();
    expect(await h.registry.execute('write_skill', { name: 'my-flow', description: '一套做法', body: '正文' }, context))
      .toMatchObject({ ok: true, created: true, minRole: 'trusted' });
    expect(h.skills.read('my-flow')).toMatchObject({ description: '一套做法', minRole: 'trusted' });
    // 只能写得更严，不能更松：写松了等于把这段正文推给更多人的上下文。
    expect(await h.registry.execute('write_skill', { name: 'wide', description: 'x', body: 'y', minRole: 'limited' }, context))
      .toMatchObject({ ok: false, error: 'min_role_too_low' });
    // 随包发的说明书是模型下一次写工具时要读的那份文档，改坏了它就照着改坏的写。
    expect(await h.registry.execute('write_skill', { name: 'writing-tools', description: 'x', body: 'y' }, context))
      .toMatchObject({ ok: false, error: 'skill_reserved' });
    // 同名再写一次 = 更新，不是新建。退休靠 enabled:false（没有删除工具）。
    expect(await h.registry.execute('write_skill', { name: 'my-flow', description: '改过', body: '正文', enabled: false }, context))
      .toMatchObject({ ok: true, created: false, enabled: false });
    closeDatabase(h.db);
  });

  it('writes plugin.js disabled, and a source change knocks an enabled plugin back down', async () => {
    const h = harness('author-plugin');
    const context = h.contextFor();
    expect(await h.registry.execute('write_plugin', { name: 'demo', source: 'export default { name: "demo" };\n' }, context))
      .toMatchObject({ ok: true, created: true, enabled: false });
    expect(existsSync(`${h.root}/plugins/demo/plugin.js`)).toBe(true);
    const row = () => h.db.prepare('SELECT enabled FROM plugins WHERE name=?').get('demo') as { enabled: number } | undefined;
    expect(row()?.enabled).toBe(0);
    // 运维复审后启用；此后模型再改源码必须重新走复审，否则改一个已启用 plugin 的文件
    // 就是不经复审直接拿到 root（进程内全信任，docs/14 A27）。
    h.db.prepare('UPDATE plugins SET enabled=1 WHERE name=?').run('demo');
    expect(await h.registry.execute('write_plugin', { name: 'demo', source: 'export default { name: "demo", version: "2" };\n' }, context))
      .toMatchObject({ ok: true, created: false });
    expect(row()?.enabled).toBe(0);
    expect(readFileSync(`${h.root}/plugins/demo/plugin.js`, 'utf8')).toContain('version: "2"');
    expect(await h.registry.execute('write_plugin', { name: 'Bad Name', source: 'x' }, context)).toMatchObject({ ok: false, error: 'invalid_plugin_name' });
    closeDatabase(h.db);
  });

  it('installs an MCP server as disabled and enforces the transport allowlist', async () => {
    const h = harness('author-mcp', { mcp: { enabled: true, allowTransports: ['http'] } } as Record<string, unknown>);
    const context = h.contextFor();
    expect(await h.registry.execute('install_mcp', { name: 'local', transport: 'stdio', command: 'npx' }, context))
      .toMatchObject({ ok: false, error: 'transport_not_allowed' });
    expect(await h.registry.execute('install_mcp', { name: 'docs', transport: 'http', url: 'https://example.com/mcp' }, context))
      .toMatchObject({ ok: true, enabled: false });
    // 落地即禁用是写死的，不接受入参：这条记录会以 bot 进程的身份长期存在，必须有人看过。
    expect(h.config().mcp.servers).toMatchObject([{ name: 'docs', transport: 'http', enabled: false }]);
    expect(h.emitted).toEqual([['mcp.servers']]);
    // 重名要在工具这一侧就拒掉，否则 `mcp.servers` 里会出现两条同名记录。
    expect(await h.registry.execute('install_mcp', { name: 'docs', transport: 'http', url: 'https://example.com/other' }, h.contextFor()))
      .toMatchObject({ ok: false, error: 'already_exists' });
    expect(await h.registry.execute('list_mcp', {}, h.contextFor())).toMatchObject({ ok: true, servers: [{ name: 'docs', enabled: false }] });
    // **同一轮里连装两台**：`turn.config` 是开轮时冻结的快照，工具必须读活的那份配置。读快照的话
    // 第二次看到的 `current` 还是空的，整份 `mcp.servers` 被覆写成只剩第二台 —— 第一台连同它的
    // revision 一起消失。所以这里刻意复用**同一个** context，不重建。
    expect(await h.registry.execute('install_mcp', { name: 'second', transport: 'http', url: 'https://example.com/two' }, context))
      .toMatchObject({ ok: true });
    expect(h.config().mcp.servers.map((server) => server.name)).toEqual(['docs', 'second']);
    closeDatabase(h.db);
  });

  /**
   * `install_skill` 的 source 只认两处：本轮 workspace，与本会话在附件库里的那个子目录。
   * `media.dir` 底下是**按 chatId 分目录存着所有会话的附件** —— 不限定到本会话，一个
   * `install_skill` 就是一条跨会话读文件的路。
   */
  it('installs a skill package from the workspace or this chat’s attachments, and nowhere else', async () => {
    const h = harness('author-install-skill');
    const body = '---\nname: packaged\ndescription: 装进来的\n---\n照说明跑 scripts/invoke.sh\n';
    const pack = zipFixture([{ name: 'packaged/SKILL.md', content: body }, { name: 'packaged/scripts/invoke.sh', content: 'echo hi', mode: 0o100755 }]);
    writeFileSync(`${h.root}/workspace/pack.zip`, pack);

    const installed = await h.registry.execute('install_skill', { source: 'pack.zip' }, h.contextFor());
    // **落地即停用**，且提示里必须说清「现在还用不了、要去点启用」—— 不说的话模型会紧接着
    // load_skill 然后报「skill 不存在」，而真实原因是它在等人审。
    expect(installed).toMatchObject({ ok: true, name: 'packaged', enabled: false, files: expect.arrayContaining(['scripts/invoke.sh']) });
    expect((installed as { hint: string }).hint).toContain('停用');
    expect(h.skills.read('packaged')).toMatchObject({ enabled: false });
    expect(h.skills.catalog('owner')).toEqual([]);

    // 本会话的附件目录：chatId 是 '1'（见 harness 的 turn），走绝对路径。
    const attachments = resolve(h.config().media.dir, '1');
    mkdirSync(attachments, { recursive: true });
    writeFileSync(`${attachments}/sent.zip`, zipFixture([{ name: 'from-chat/SKILL.md', content: body.replace('packaged', 'from-chat') }]));
    expect(await h.registry.execute('install_skill', { source: `${attachments}/sent.zip` }, h.contextFor()))
      .toMatchObject({ ok: true, name: 'from-chat', enabled: false });

    // 别的会话的附件目录、以及 workspace 之外的任意路径：一律拒。
    const other = resolve(h.config().media.dir, '999');
    mkdirSync(other, { recursive: true });
    writeFileSync(`${other}/secret.zip`, pack);
    for (const source of [`${other}/secret.zip`, `${h.root}/skills`, '../skills', '/etc/hostname']) {
      expect(await h.registry.execute('install_skill', { source }, h.contextFor()), source).toMatchObject({ ok: false, error: 'skill_source_forbidden' });
    }
    // workspace 里的软链接同样不算「在 workspace 里」：判据走 realpath，不是 resolve。
    symlinkSync(other, `${h.root}/workspace/escape`);
    expect(await h.registry.execute('install_skill', { source: 'escape/secret.zip' }, h.contextFor())).toMatchObject({ ok: false, error: 'skill_source_forbidden' });

    // 解包器的错误码要原样交给模型（带 candidates），别压成一句「装失败了」。
    writeFileSync(`${h.root}/workspace/two.zip`, zipFixture([{ name: 'a/SKILL.md', content: body }, { name: 'b/SKILL.md', content: body }]));
    expect(await h.registry.execute('install_skill', { source: 'two.zip' }, h.contextFor()))
      .toMatchObject({ ok: false, error: 'skill_ambiguous_root', candidates: expect.arrayContaining(['a', 'b']) });
    closeDatabase(h.db);
  });

  it('hides install_skill when the skills channel is off', () => {
    const off = harness('author-install-off', { skills: { enabled: false } } as Record<string, unknown>);
    expect(off.registry.has('install_skill')).toBe(true);
    expect(off.registry.activeNames('owner', off.contextFor())).not.toContain('install_skill');
    // 与 write_skill 共用一个开关：两件事都是「往 skills/ 里写东西」，分成两个只会多出
    // 一种「开了一半」的状态。
    expect(off.registry.activeNames('owner', off.contextFor())).not.toContain('write_skill');
    closeDatabase(off.db);
  });
});
