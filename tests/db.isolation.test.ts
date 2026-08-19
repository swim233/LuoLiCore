import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

/**
 * `AC-DB-001` / `AC-DB-002` / `AC-DB-003`。
 *
 * `AC-DB-003` 尤其不能缺：[14](../docs/14-open-questions.md) T7 那条取舍写的是
 * 「**单库单文件 ⇒ 隔离靠代码纪律，不是物理边界**」，而它列出的缓解手段之一就是
 * 「CI 的 SQL 扫描测试（AC-DB-003）」——那条测试此前**根本不存在**。
 * 于是「跨会话不串数据」这件事没有任何自动化保障，全靠每次 review 时人眼看。
 */

describe('AC-DB-001 / AC-DB-002 · 迁移', () => {
  it('空库建齐表与 FTS，journal_mode=wal，且重复迁移幂等', () => {
    const path = './data/db-init.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    expect(String((db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]!.journal_mode).toLowerCase()).toBe('wal');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[]));
    for (const name of ['messages', 'messages_fts', 'context_messages', 'context_commits', 'refs', 'turns', 'principals',
      'approvals', 'config_kv', 'config_revisions', 'log_events', 'usage_ledger', 'quota_counters', 'attachments', 'agent_runs']) {
      expect(tables.has(name), `缺表 ${name}`).toBe(true);
    }
    // 幂等：再迁一次不该报错、也不该多出表。
    const before = tables.size;
    migrateDatabase(db);
    expect((db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").pluck().get() as number)).toBe(before);
    closeDatabase(db);
  });
});

describe('AC-DB-003 ★ · 跨会话隔离由 SQL 扫描兜住', () => {
  /**
   * 扫的是 `packages/db/src/**` 里**每一个作用域化仓库方法**的 SQL：除白名单（`admin*` /
   * `report*` / 明确的全局表）之外，凡是碰 `messages` / `context_*` / `turns` / `attachments`
   * 这些按会话分区的表的语句，都必须带 `chat_id` 或 `key` 的过滤。
   *
   * 判据是**语句文本**而不是运行时行为：跨会话泄漏一旦发生就是把别人的私聊读给模型听，
   * 那种 bug 不能靠「等它出现」来发现。
   */
  const PARTITIONED = ['messages', 'context_messages', 'context_commits', 'refs', 'contexts', 'turns', 'attachments', 'sandbox_containers'];
  /**
   * **按设计跨会话**的方法，逐条写明理由。这张表是这条断言的全部弹性所在 ——
   * 新出现的无过滤查询会让用例变红，直到有人在这里把「为什么它可以是全局的」写下来。
   * 白名单是「显式许可」，不是「碰巧漏掉」。
   */
  const GLOBAL_BY_DESIGN: Record<string, string> = {
    adminSearchAll: '跨会话检索，调用点是仅 owner 的 admin_search_messages 工具',
    adminSearchCount: '同上，配套的命中总数',
    dashboard: '总览页的全局聚合，端点仅 owner 可见（docs/22 · V-INFO-01）',
    recomputeMessageTokens: '一次性数据修复：按新估算器重算全部会话的 tokens，本来就要扫全表',
    list: '持久容器的回收对账与运维面板要看全部容器；容器管理工具整族 owner-only（docs/05 §3.11）',
    count: '同上：撞没撞 sandbox.persistent.maxContainers 是个全局判据',
  };

  it('作用域化仓库里碰分区表的 SQL 都带 chat_id 或 key 过滤', () => {
    const sources = ['archive.ts', 'context.ts', 'operations.ts', 'principals.ts', 'config.ts', 'sandbox.ts']
      .map((name) => ({ name, text: readFileSync(`packages/db/src/${name}`, 'utf8') }));
    const offenders: string[] = [];
    const globalsSeen = new Set<string>();
    for (const { name, text } of sources) {
      // 逐个函数/方法切开：顶层 `export function f(` 与类里 `  m(` 都要覆盖。
      const methods = [...text.matchAll(/^(?:export function ([a-zA-Z][\w]*)|  (?:private |readonly )*(?:async )?([a-zA-Z#][\w]*))\s*(?:<[^>]*>)?\([^)]*\)[^{]*\{/gm)];
      for (const [index, match] of methods.entries()) {
        const method = match[1] ?? match[2]!;
        const start = match.index! + match[0].length;
        const end = index + 1 < methods.length ? methods[index + 1]!.index! : text.length;
        const body = text.slice(start, end);
        for (const statement of body.match(/(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)[\s\S]{0,900}?(?=`|'\)|"\))/g) ?? []) {
          if (!PARTITIONED.some((table) => new RegExp(`\\b${table}\\b`).test(statement))) continue;
          // 合格的作用域形态：显式 chat_id / context key、按 turn 认领（一个 turn 只属于一个会话）、
          // 或按主键取单行（那个 id 是调用方从作用域化查询里拿到的）。
          const scoped = /chat_id\s*(=|IN)/i.test(statement) || /\bkey\s*=/i.test(statement)
            || /claimed_by_turn\s*=/i.test(statement)
            || /\b(id|rowid|turn_id|message_id|doc_id|commit_id|update_id)\s*(=|IN)/i.test(statement)
            || /INSERT INTO (messages|context_messages|context_commits|refs|contexts|turns|attachments|sandbox_containers)\b/i.test(statement);
          if (scoped) continue;
          if (method in GLOBAL_BY_DESIGN) { globalsSeen.add(method); continue; }
          offenders.push(`${name} · ${method} · ${statement.replace(/\s+/g, ' ').slice(0, 110)}`);
        }
      }
    }
    expect(offenders, `这些语句碰了按会话分区的表却没有会话过滤，也不在「按设计跨会话」的名单里：\n${offenders.join('\n')}`).toEqual([]);
    // 反向：白名单里的每一项都得真的还在扫描结果里。留着一条早已收紧的豁免，
    // 下一次真的出现无过滤查询时它可能刚好顶上那个名字，断言就白了。
    const stale = Object.keys(GLOBAL_BY_DESIGN).filter((method) => !globalsSeen.has(method));
    expect(stale, `这些豁免已经不需要了，从 GLOBAL_BY_DESIGN 里删掉：${stale.join('、')}`).toEqual([]);
  });

  it('实际读写也确实隔离：另一个会话的消息读不到', () => {
    const path = './data/db-isolation.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db);
    const append = (chatId: string, id: number, text: string) => archive.scope(chatId, null).append({ chatId, messageThreadId: null,
      tgMessageId: id, direction: 'in', fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text,
      tgDate: Date.now(), raw: {}, triggered: false });
    append('chat-a', 1, '甲群的秘密');
    append('chat-b', 1, '乙群的秘密');
    // 作用域化查询只看得到自己那一份 —— 两个群用了同一个 tgMessageId，串了就会立刻看出来。
    expect(archive.scope('chat-a').recent(50).map((row) => row.text)).toEqual(['甲群的秘密']);
    expect(archive.scope('chat-b').recent(50).map((row) => row.text)).toEqual(['乙群的秘密']);
    expect(archive.scope('chat-a').search('秘密', 50).map((row) => row.text)).toEqual(['甲群的秘密']);
    // `admin*` 按设计跨会话（调用点限 owner），所以它该看到两条 —— 这一条同时钉住白名单的语义。
    expect(archive.adminSearchAll('秘密', 50)).toHaveLength(2);
    closeDatabase(db);
  });
});

describe('AC-DB-004 · 中文检索与短词回退', () => {
  it('≥3 字走 FTS trigram，<3 字回退 LIKE，两条路都带 chat 过滤', () => {
    const path = './data/db-fts.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const archive = new ArchiveRepository(db);
    const append = (chatId: string, id: number, text: string) => archive.scope(chatId, null).append({ chatId, messageThreadId: null,
      tgMessageId: id, direction: 'in', fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text,
      tgDate: Date.now(), raw: {}, triggered: false });
    append('chat-a', 1, '今天去隆福寺吃卤煮');
    append('chat-b', 2, '乙群也提到隆福寺');
    // ≥3 字：走 FTS（trigram 对中文可用，docs/14 A19），而且只在本会话内命中。
    expect(archive.scope('chat-a').search('隆福寺', 20).map((row) => row.text)).toEqual(['今天去隆福寺吃卤煮']);
    // <3 字：trigram 匹配不了，`archiveQuery` 回退 LIKE —— 回退路径同样必须带 chat 过滤。
    expect(archive.scope('chat-a').search('卤煮', 20).map((row) => row.text)).toEqual(['今天去隆福寺吃卤煮']);
    expect(archive.scope('chat-b').search('卤煮', 20)).toEqual([]);
    closeDatabase(db);
  });
});
