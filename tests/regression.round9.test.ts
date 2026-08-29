import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase, readAppKv } from '@luoli/db';
import { ApprovalRules, ContextEngine, FileTools, LogSink, MaintenanceService, ModelRegistry, PathJail, PromptDocuments, ProviderStore, QuotaGuard, Secrets, ToolRegistry, TurnRegistry, UsageLedger, configSchema, createStepObservers, jsonSchemaToZod, readSlice, type StepFacts } from '@luoli/core';
import { capMentions, safeRender } from '@luoli/telegram';
import { elideMiddleBytes, parsePrincipal, type RuntimeTurnContext } from '@luoli/shared';

/**
 * 第九轮（`docs/27`）整改的回归用例。判据来自那一轮替换的三条外部标准（OWASP / SOLID / JS·TS
 * 实践），因此这里固定的多为同一件事只保留一套判据，而不是功能正确性本身。
 * `S-01`（登录限流桶键）与 `S-05`（请求体上界）位于 `tests/server.test.ts`，
 * `R-02`/`R-03`/`C-01` 这类位于各自模块的用例文件中。
 */

describe('S-03 · 审批规则的正则走 RE2', () => {
  it('嵌套量词在长输入上是线性的，不再指数回溯', () => {
    const rules = new ApprovalRules([{ tool: 'bash', pattern: '(a+)+$', risk: 'high' }]);
    const tool = { name: 'bash' } as never;
    const context = {} as never;
    // 26 个 a 加 `!` 是报告中实测的形状：JS 引擎下每增加一个字符耗时翻倍，而求值对象
    //（`JSON.stringify(input)`）由模型决定，阻塞的是整个单线程进程。
    const evaluate = (length: number): number => {
      const started = performance.now();
      rules.evaluate(tool, `${'a'.repeat(length)}!`, context);
      return performance.now() - started;
    };
    evaluate(8);
    expect(evaluate(34)).toBeLessThan(200);
  });

  it('匹配语义没变：高危命令照样要审批', () => {
    const rules = new ApprovalRules([{ tool: 'bash', pattern: '(?i)\\brm\\s+-rf\\b', risk: 'high' }]);
    const tool = { name: 'bash' } as never;
    const context = {} as never;
    expect(rules.evaluate(tool, { command: 'RM  -rf /' }, context)).toMatchObject({ needed: true, risk: 'high' });
    expect(rules.evaluate(tool, { command: 'ls -la' }, context)).toMatchObject({ needed: false });
  });

  it('写入端与运行时同一套判据：不兼容 RE2 的模式与超长模式都当场拒收', () => {
    const parse = (pattern: string) => configSchema.safeParse({ access: { bootstrapOwnerId: '1' }, approval: { rules: [{ tool: 'bash', pattern }] } });
    // RE2 不支持反向引用：无法编译的规则在运行时永不命中，接受这类规则等同于提供一个无效开关。
    expect(parse('(a)\\1').success).toBe(false);
    expect(parse(`^${'a'.repeat(200)}$`).success).toBe(false);
    expect(parse('(?i)\\brm\\s+-rf\\b').success).toBe(true);
  });
});

describe('C-05 · 主体 id 的形态校验只有一份', () => {
  it('@username 一律拒收，三种写法都解析成同一个主体', () => {
    expect(parsePrincipal('user @alice')).toBeNull();
    expect(parsePrincipal('@alice')).toBeNull();
    expect(parsePrincipal('bot 123')).toBeNull();
    expect(parsePrincipal('user 123 owner')).toBeNull();
    expect(parsePrincipal('user 123')).toEqual({ id: 'user:123', kind: 'user', tgId: '123' });
    expect(parsePrincipal('user:123')).toEqual({ id: 'user:123', kind: 'user', tgId: '123' });
    // 群与频道为负数。裸 id 不指定 kind：`/whois` 与 `/revoke` 两种主体都覆盖。
    expect(parsePrincipal(' -1002492583774 ')).toEqual({ id: '-1002492583774', kind: null, tgId: '-1002492583774' });
  });
});

function jail(name: string, maxRead = 1024, maxWrite = 4096): { root: string; files: FileTools } {
  const root = resolve(`data/round9-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { root, files: new FileTools(new PathJail(root, []), maxRead, maxWrite) };
}

describe('R-02 · read / edit 不再无视文件大小整份读盘', () => {
  it('read 只把要的那一段读进内存，分页与行号语义不变', () => {
    const { root, files } = jail('read-slice', 32);
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n');
    writeFileSync(`${root}/big.txt`, lines);
    const first = files.read('big.txt') as { content: string; firstLine: number; truncated: boolean; nextOffset: number | null };
    expect(first.firstLine).toBe(1);
    expect(first.truncated).toBe(true);
    expect(first.content.startsWith('1\tline-1')).toBe(true);
    // 第二页的行号连续递增，而不是从 1 重新计数。
    const second = files.read('big.txt', first.nextOffset!) as { content: string; firstLine: number };
    expect(second.firstLine).toBeGreaterThan(1);
    expect(second.content.startsWith(`${second.firstLine}\t`)).toBe(true);
    // 定位读取本身：只访问 [offset, offset+limit)，不将整份内容读入内存。
    const slice = readSlice(`${root}/big.txt`, 7, 6);
    expect(slice.read).toBe(6);
    expect(slice.size).toBe(Buffer.byteLength(lines));
  });

  it('edit 对超过写入预算的文件直接 ok:false 并说清原因', () => {
    const { root, files } = jail('edit-large', 32, 64);
    writeFileSync(`${root}/huge.txt`, 'x'.repeat(200));
    expect(files.edit('huge.txt', 'x', 'y')).toMatchObject({ ok: false, error: 'file_too_large_to_edit', hint: expect.stringContaining('maxWriteBytes') });
    writeFileSync(`${root}/small.txt`, 'hello');
    expect(files.edit('small.txt', 'hello', 'world')).toMatchObject({ ok: true });
  });
});

describe('R-03 · context_stats 默认不带整段历史', () => {
  it('摘要里没有 messages / commits，显式要时才有', () => {
    const path = './data/round9-stats.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const engine = new ContextEngine(db, new ArchiveRepository(db));
    const summary = engine.stats('chat:1');
    // 固定键集是这条断言的关键：R-03 防止的是把整段历史重新写回摘要。
    // lastPrune / lastRebase 是 `/ctx` 需要的两个标记（AC-CTX-027），各自只含 seq 与时间戳。
    expect(Object.keys(summary).sort()).toEqual(['claimWatermark', 'commit', 'key', 'lastPrune', 'lastRebase', 'messageCount', 'tokens']);
    const timeline = engine.stats('chat:1', { timeline: true });
    expect(timeline).toHaveProperty('messages');
    expect(timeline).toHaveProperty('commits');
    closeDatabase(db);
  });
});

describe('C-01 · 一行坏数据不该让全部别名消失', () => {
  it('headers_json 是坏 JSON 的 provider 被跳过并记成 down，其余别名照常可用', () => {
    const path = './data/round9-rebuild.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const providers = new ProviderStore(db, new Secrets('x'.repeat(32)));
    const insert = db.prepare(`INSERT INTO providers(id,name,kind,base_url,headers_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`);
    insert.run('bad', 'bad', 'openai', 'https://a.example', '{not json', Date.now(), Date.now());
    insert.run('good', 'good', 'openai', 'https://b.example', null, Date.now(), Date.now());
    const model = db.prepare(`INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,?,128000,4096,'{}',1,0,?,?)`);
    model.run('m-bad', 'bad', 'gpt-x', 'x', Date.now(), Date.now());
    model.run('m-good', 'good', 'gpt-y', 'y', Date.now(), Date.now());
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run('main', JSON.stringify(['m-good']), Date.now());
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run('high', JSON.stringify(['m-bad']), Date.now());
    const skipped: string[] = [];
    const registry = new ModelRegistry(db, providers, (providerId) => skipped.push(providerId));
    // 旧实现：注册表已清空导致 JSON.parse 抛出，异常向上传播，main 与 high 一并丢失、调用端点返回 500。
    expect(() => registry.rebuild()).not.toThrow();
    expect(registry.aliases()).toContain('main');
    expect(registry.aliases()).not.toContain('high');
    expect(skipped).toEqual(['bad']);
    expect(db.prepare('SELECT health_state FROM providers WHERE id=?').pluck().get('bad')).toBe('down');
    closeDatabase(db);
  });
});

describe('S-08 · 身份字符串当路径段用之前先校验形态', () => {
  it('LUOLI_OWNER_ID 里的 ../ 一律拒收，数字与空串放行', () => {
    const parse = (id: string) => configSchema.safeParse({ access: { bootstrapOwnerId: id } });
    // 该值会被拼接为 memory/private/<id>/PRIMEMORY.md，`../../etc` 会使私有记忆写到目录之外。
    expect(parse('../../etc').success).toBe(false);
    expect(parse('owner').success).toBe(false);
    expect(parse('123456').success).toBe(true);
    expect(parse('').success).toBe(true);
  });
});

describe('R-04 · 并发上限按在途轮次数而不是 turns 表', () => {
  it('turns 表里一行都没有时，注册表里的在途轮次照样能挡住第二条', () => {
    const path = './data/round9-quota.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const quota = new QuotaGuard(db, 'UTC');
    const registry = new TurnRegistry();
    const limits = { chatId: 'c', userId: 'u', turnsPerUserPerHour: 100, turnsPerChatPerHour: 100, concurrentPerUser: 1 };
    // 旧实现：`turns` 对应行在 openTurn 之后才写入，因此此处统计结果为 0，同一用户的两条
    // 并发消息都能通过检查，`concurrentPerUser` 失效。
    expect(quota.canStart({ ...limits, inFlight: registry.countForUser('u') })).toBe(true);
    registry.register({ id: 't1', key: 'chat:c', chatId: 'c', userId: 'u', role: 'trusted' }, 60_000);
    expect(registry.countForUser('u')).toBe(1);
    expect(quota.canStart({ ...limits, inFlight: registry.countForUser('u') })).toBe(false);
    expect(quota.lastStartRejection).toBe('concurrent');
    // 其他主体不受影响。
    expect(quota.canStart({ ...limits, userId: 'other', inFlight: registry.countForUser('other') })).toBe(true);
    registry.finish('t1');
    expect(quota.canStart({ ...limits, inFlight: registry.countForUser('u') })).toBe(true);
    closeDatabase(db);
  });
});

describe('R-05 · 四张派生数据表有保留期，且 0 = 不清', () => {
  it('按保留期删过期行，天数为 0 时一行都不动', () => {
    const path = './data/round9-retention.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const now = Date.now();
    const old = now - 500 * 86_400_000;
    db.prepare('INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,0,0,?,?)')
      .run('assist:global', 'assist', null, './memory/ASSIST.md', 'hash', now);
    const seed = (): void => {
      db.exec('DELETE FROM usage_ledger; DELETE FROM quota_counters; DELETE FROM config_revisions; DELETE FROM memory_revisions');
      db.prepare(`INSERT INTO usage_ledger(ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,ok)
        VALUES (?,?,'c','u','p','m','main',1,1,0,0,0,0,1,1)`).run(old, 't-old');
      db.prepare('INSERT INTO quota_counters(scope,subject,window,bucket,cost_usd,reserved_usd,turns,updated_at) VALUES (?,?,?,?,0,0,0,?)').run('user', 'u', 'day', '2024-01-01', old);
      db.prepare('INSERT INTO config_revisions(id,ts,actor,key,new_json) VALUES (?,?,?,?,?)').run('r-old', old, 'webui', 'general.name', '"x"');
      db.prepare('INSERT INTO memory_revisions(id,doc_id,ts,actor,op,diff,bytes_after) VALUES (?,?,?,?,?,?,?)').run('m-old', 'assist:global', old, 'webui', 'manual', '', 0);
    };
    const counts = (): number[] => ['usage_ledger', 'quota_counters', 'config_revisions', 'memory_revisions']
      .map((table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number);

    seed();
    // 0 表示不清理。默认静默删除数据的风险远高于不删除，因此缺省值与 0 都必须保持数据不变。
    new MaintenanceService(db, path, 2, 30, './data/round9-logs', {}, 0, 30,
      { usage: 0, quotaCounters: 0, configRevisions: 0, memoryRevisions: 0 }).cleanup(now);
    expect(counts()).toEqual([1, 1, 1, 1]);
    new MaintenanceService(db, path, 2, 30, './data/round9-logs').cleanup(now);
    expect(counts()).toEqual([1, 1, 1, 1]);

    const result = new MaintenanceService(db, path, 2, 30, './data/round9-logs', {}, 0, 30,
      { usage: 400, quotaCounters: 400, configRevisions: 180, memoryRevisions: 180 }).cleanup(now);
    expect(counts()).toEqual([0, 0, 0, 0]);
    expect(result).toMatchObject({ usage: 1, quotaCounters: 1, configRevisions: 1, memoryRevisions: 1 });

    // 保留期内的行不做处理。
    seed();
    db.prepare('UPDATE usage_ledger SET ts=?').run(now - 86_400_000);
    new MaintenanceService(db, path, 2, 30, './data/round9-logs', {}, 0, 30, { usage: 400 }).cleanup(now);
    expect(db.prepare('SELECT COUNT(*) FROM usage_ledger').pluck().get()).toBe(1);
    closeDatabase(db);
  });
});

describe('C-02 · 用量报表与总览趋势按同一个时区分日', () => {
  it('东八区里跨 UTC 午夜的调用归到本地那一天', () => {
    const path = './data/round9-usage-tz.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const ledger = new UsageLedger(db);
    // 取两天前的 20:30Z：加八小时即跨入下一个本地日。按 UTC 分日归为前一天，而总览趋势与
    // 配额窗口按 general.timezone 归为后一天，同一天出现两个数字（docs/27 · C-02）。
    // 相对当前时间取值而不是写死日期：总览趋势只覆盖近 7 天，固定日期一周后会滑出窗口。
    const base = new Date(Date.now() - 2 * 86_400_000);
    const ts = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 20, 30);
    // 参照值独立计算：`Intl` 的结果即 `quotaBucket` 的口径，这条断言验证的是报表与之一致。
    const utcDay = new Date(ts).toISOString().slice(0, 10);
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    expect(localDay).not.toBe(utcDay);
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,state,started_at) VALUES ('t','chat:c','c','u','trusted',1,'mention','committed',?)`).run(ts);
    db.prepare(`INSERT INTO usage_ledger(ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,ok)
      VALUES (?,'t','c','u','p','m','main',10,10,0,0,0,0.5,1,1)`).run(ts);
    const buckets = (timezone: string): string[] => (ledger.report(ts - 86_400_000, ts + 86_400_000, 'day', timezone) as Array<{ bucket: string }>).map((row) => row.bucket);
    expect(buckets('UTC')).toEqual([utcDay]);
    expect(buckets('Asia/Shanghai')).toEqual([localDay]);
    // 总览趋势使用同一份口径：两个页面对同一天必须给出相同数值。
    const trend = (new OperationsRepository(db).dashboard('Asia/Shanghai', 7) as { trend: Array<{ day: string; turns: number }> }).trend;
    expect(trend.find((row) => row.turns > 0)?.day).toBe(localDay);
    closeDatabase(db);
  });
});

describe('C-04 · MCP 的 schema 转换有深度上界', () => {
  it('超深 inputSchema 降级成宽松放行而不是 RangeError', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < 5000; level += 1) deep = { type: 'object', properties: { child: deep } };
    expect(() => jsonSchemaToZod(deep)).not.toThrow();
    // 上界之内的结构仍精确转换。
    const parsed = jsonSchemaToZod({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }).safeParse({ name: 'x' });
    expect(parsed.success).toBe(true);
  });
});

describe('S-10 · mention 护栏的判据跟 Telegram 一致', () => {
  it('前置字符是标点时照样算 mention', () => {
    // 实测三种情况在旧判据（前一个字符为空白或左括号）下 max=1 时全部漏判，而 Telegram 对这些
    // 前置字符同样解析为 mention。
    expect(capMentions('@alicexx ,@bobbyxx .@cindyxx ;@daisyxx', 1)).toBe('@alicexx ,bobbyxx .cindyxx ;daisyxx');
    // 前一个字符为 \w 或 @ 时不计入：`foo@bar` 与 `@@name` 在 Telegram 侧同样不是 mention。
    expect(capMentions('mail:foo@barbaz @alicexx', 1)).toBe('mail:foo@barbaz @alicexx');
    // `@@alicexx` 不计入（第二个 @ 的前一个字符是 @），因此 `@bobbyxx` 为第 1 个，max=1 时保留。
    expect(capMentions('@@alicexx @bobbyxx', 1)).toBe('@@alicexx @bobbyxx');
    expect(capMentions('@@alicexx @bobbyxx @cindyxx', 1)).toBe('@@alicexx @bobbyxx cindyxx');
    expect(capMentions('@alicexx @bobbyxx', 0)).toBe('@alicexx @bobbyxx');
  });
});

describe('C-06 · LIKE 分支转义通配符', () => {
  it('a_b 不再命中 axb', () => {
    const path = './data/round9-like.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const scoped = new ArchiveRepository(db).scope('c');
    const add = (text: string, id: number): void => void scoped.append({ chatId: 'c', messageThreadId: null, tgMessageId: id, direction: 'in',
      fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text, tgDate: Date.now(), raw: {}, triggered: false, triggerReason: null });
    add('a_b', 1);
    add('axb', 2);
    // 分词正则将 `_` 视为词内字符保留，因此查询变为 LIKE '%a_b%'：下划线在 LIKE 中表示
    // 任意单个字符，旧实现两条均命中。
    const hits = scoped.search('a_b', 10).map((row) => row.text);
    expect(hits).toEqual(['a_b']);
    closeDatabase(db);
  });
});

describe('C-07 · 占位符字符不可伪造', () => {
  it('正文里自带的 NUL 不会换掉代码块', () => {
    // 代码块被替换为 `\u0000<n>\u0000`，而 SPECIAL 不含 NUL：正文中自带 `\u00000\u0000`
    // 的消息在旧实现下会被替换成该代码块，或在下标越界时整段丢失。
    const rendered = safeRender('前\u00000\u0000后\n```\ncode\n```');
    expect(rendered).toContain('code');
    expect(rendered).not.toContain('\u0000');
    expect(rendered.startsWith('前0后')).toBe(true);
  });
});

describe('C-08 · perChat 的会话级人格真的接上了', () => {
  it('合法文件名生效，越界文件名退回全局那份', () => {
    const root = resolve('data/round9-character');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/CHARACTER.md`, '全局人格');
    writeFileSync(`${root}/CHARACTER.-100.md`, '本群人格');
    const path = './data/round9-character.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const documents = new PromptDocuments(db, root);
    expect(documents.readForPrompt({ userId: '1', isPrivate: true, characterOverride: 'CHARACTER.-100.md' }).character).toBe('本群人格');
    // 用作路径段的自由字符串：越界时一律回退到全局配置，而不是抛出异常导致整个会话无法开启轮次。
    expect(documents.readForPrompt({ userId: '1', isPrivate: true, characterOverride: '../../etc/passwd' }).character).toBe('全局人格');
    expect(documents.readForPrompt({ userId: '1', isPrivate: true, characterOverride: 'sub/dir.md' }).character).toBe('全局人格');
    closeDatabase(db);
  });
});

describe('D-03 · 准入判定能单独测', () => {
  it('运维禁用、角色不足、子 agent 限制三档各自说清原因', () => {
    const path = './data/round9-admit.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' } });
    const log = new LogSink(new OperationsRepository(db), './data/round9-logs');
    let overrides: Record<string, { enabled?: boolean }> = {};
    const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 10, maxCallsPerTurn: 2, maxConsecutiveErrors: 3 });
    registry.bindOverrides(() => overrides);
    registry.register({ name: 'memory_write', description: '', inputSchema: z.object({}), policy: { minRole: 'trusted', approval: 'never', scope: 'private', source: 'builtin' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    const turnOf = (role: 'limited' | 'trusted') => ({ turnId: `t-${role}`, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: role,
      isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext);
    const context = { turn: turnOf('trusted'), workspace: './data', agentKind: 'main' as const };
    expect(registry.admit('memory_write', context)).toMatchObject({ ok: true });
    expect(registry.admit('nope', context)).toMatchObject({ ok: false, error: 'tool_unavailable' });
    expect(registry.admit('memory_write', { ...context, agentKind: 'sub' })).toMatchObject({ ok: false, error: 'tool_unavailable_for_subagent' });
    expect(registry.admit('memory_write', { ...context, turn: turnOf('limited') })).toMatchObject({ ok: false, error: '权限不足' });
    expect(registry.admit('memory_write', { ...context, allow: new Set(['read_file']) })).toMatchObject({ ok: false, error: 'tool_not_in_allowlist' });
    overrides = { memory_write: { enabled: false } };
    // 运维禁用需记录日志：模型调用已关闭的工具是排障线索。
    expect(registry.admit('memory_write', context)).toMatchObject({ ok: false, error: 'tool_disabled_by_operator', warn: true });
    closeDatabase(db);
  });
});

describe('D-05 · onStepEnd 的四件事各自能喂一个假 step', () => {
  it('链内 fallback 时按实际出力的模型计价，别名不跟着变', () => {
    const path = './data/round9-observers.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,state,started_at) VALUES ('t','chat:1','1','2','trusted',1,'mention','running',?)`).run(Date.now());
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' } });
    const published: Array<{ type: string; data: unknown }> = [];
    const appended: unknown[] = [];
    const second = { providerId: 'p2', modelId: 'model-second', priceIn: 2, priceOut: 4, priceCacheRead: null, priceCacheWrite: null };
    const fakeContext = { appendDelta: (_turn: unknown, message: unknown) => appended.push(message), calibrate: () => 1 };
    const fakeLog = { publish: (type: string, data: unknown) => published.push({ type, data }), event: () => 0 };
    const observers = createStepObservers({ turnId: 't', key: 'chat:1', chatId: '1', initiatorUserId: '2' } as never, {
      ledger: new UsageLedger(db),
      // 第二个候选生效：别名保持不变（链内 fallback 更换的是模型，docs/20 · W-LEDGER-01）。
      registry: { infoByModelId: (id) => id === 'model-second' ? second : null, aliasOf: (_id, prefer) => prefer ?? null },
      context: fakeContext as never,
      log: fakeLog as never,
      tokenRatioAlpha: config.context.tokenRatioAlpha,
      fallbackInfo: { providerId: 'p1', modelId: 'model-first', priceIn: 1, priceOut: 1, priceCacheRead: null, priceCacheWrite: null },
      aliasForStep: () => 'main',
    });
    const facts: StepFacts = { stepNumber: 0, servedModelId: 'model-second',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      latencyMs: 10, finishReason: 'stop',
      toolCalls: [{ toolCallId: 'c1', toolName: 'read_file', input: { path: 'x' } }],
      toolResults: [{ toolCallId: 'c1', toolName: 'read_file', part: { type: 'tool-result' }, preview: 'read_file: ok' }],
      requestBody: undefined };
    const resolved = observers.record(facts);
    expect(resolved.info.modelId).toBe('model-second');
    expect(resolved.alias).toBe('main');
    expect(resolved.cost).toBeCloseTo(2, 6);
    observers.broadcast(facts, resolved);
    expect(published.filter((entry) => entry.type === 'usage')).toHaveLength(1);
    expect(published.filter((entry) => entry.type === 'turn.progress')).toHaveLength(1);
    observers.appendContext(facts);
    expect(appended).toHaveLength(2);
    // requestBody 缺失（小样本）时不做校准：相对误差由常数项主导，校准只会引入噪声。
    let calibrated = 0;
    const quiet = createStepObservers({ turnId: 't', key: 'chat:1', chatId: '1', initiatorUserId: '2' } as never, {
      ledger: new UsageLedger(db), registry: { infoByModelId: () => null, aliasOf: () => null },
      context: { appendDelta: () => undefined, calibrate: () => { calibrated += 1; return 1; } } as never,
      log: { publish: () => undefined, event: () => 0 } as never, tokenRatioAlpha: 0.2,
      fallbackInfo: second, aliasForStep: () => 'main' });
    quiet.calibrate(facts);
    expect(calibrated).toBe(0);
    quiet.calibrate({ ...facts, requestBody: { text: 'x'.repeat(4000) } });
    expect(calibrated).toBe(1);
    closeDatabase(db);
  });
});

describe('T-04 · 中间省略式截断按字符边界切且不超预算', () => {
  it('不产出半个字符，也不超过字节预算', () => {
    const text = '漢'.repeat(400);
    const { value, truncated } = elideMiddleBytes(text, 200, (omitted) => `…${omitted}…`);
    expect(truncated).toBe(true);
    expect(value).not.toContain('�');
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(200);
    expect(elideMiddleBytes('短', 200, () => '')).toEqual({ value: '短', truncated: false });
  });
});

describe('T-06 · 库里的坏 JSON 不该抛在没有边界的地方', () => {
  it('app_kv 的坏行当「没有这一行」', () => {
    const path = './data/round9-appkv.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    db.prepare('INSERT INTO app_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)').run('modelAlias:chat:1', '{not json', Date.now(), 'test');
    expect(readAppKv(db, 'modelAlias:chat:1')).toBeUndefined();
    closeDatabase(db);
  });
});
