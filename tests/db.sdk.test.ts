import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  ApiKeyRepository,
  SdkSessionRepository,
  SourceRepository,
  closeDatabase,
  migrateDatabase,
  openDatabase,
} from "@luoli/db";
import { MemoryStore, memoryScopeSubjects, purgeSdkSession } from "@luoli/core";
import { code, source } from "./support/source";

/**
 * docs/12-sdk.md T3.2：`SourceRepository` / `ApiKeyRepository` / `SdkSessionRepository` 三个仓储，
 * 以及会话硬删 `purge()` 的删除面。
 */
function harness(name: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-memory`;
  for (const suffix of ["", "-wal", "-shm", "-logs", "-logs-wal", "-logs-shm"])
    rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return {
    db,
    directory,
    sources: new SourceRepository(db),
    apiKeys: new ApiKeyRepository(db),
    sessions: new SdkSessionRepository(db),
    memory: new MemoryStore(db, directory, 1500, 3000),
  };
}

describe("SourceRepository", () => {
  it("create 生成 ulid 作 id，kind 恒为 sdk；list 含已停用行；telegram 内建行已在（0019 种子）", () => {
    const { db, sources } = harness("sdk-sources-basic");
    const created = sources.create("Acme 机器人");
    expect(created.kind).toBe("sdk");
    expect(created.name).toBe("Acme 机器人");
    expect(created.disabledAt).toBeNull();
    expect(sources.get(created.id)).toEqual(created);
    const telegram = sources.get("telegram");
    expect(telegram?.kind).toBe("telegram");
    expect(sources.disable(created.id)).toBe(true);
    // list 含已停用行——运维面板需要看到「停用」而非「消失」。
    const listed = sources.list().find((row) => row.id === created.id);
    expect(listed?.disabledAt).not.toBeNull();
    closeDatabase(db);
  });

  it("内建 telegram 行不可停用，不可删（无删除方法）", () => {
    const { db, sources } = harness("sdk-sources-telegram-immutable");
    expect(sources.disable("telegram")).toBe(false);
    expect(sources.get("telegram")?.disabledAt).toBeNull();
    expect(
      (sources as unknown as Record<string, unknown>).remove,
    ).toBeUndefined();
    expect(
      (sources as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
    closeDatabase(db);
  });

  it("setFiles 只落给出的列，undefined 表示不改；文件名合法性不在此层校验", () => {
    const { db, sources } = harness("sdk-sources-files");
    const created = sources.create("带人格的来源");
    const withCharacter = sources.setFiles(created.id, {
      characterFile: "CUSTOM.md",
    });
    expect(withCharacter?.characterFile).toBe("CUSTOM.md");
    expect(withCharacter?.assistFile).toBeNull();
    const withAssist = sources.setFiles(created.id, { assistFile: "HELP.md" });
    expect(withAssist?.characterFile).toBe("CUSTOM.md");
    expect(withAssist?.assistFile).toBe("HELP.md");
    closeDatabase(db);
  });

  it("A3：create 的 id 不接受调用方指定；ulid 字母表恒为 Crockford Base32，结构性排除 : / .. 三种字符", () => {
    // create(name) 的签名只有一个参数——没有 id 可传，源码断言钉住这一点。
    const text = source("packages/db/src/sources.ts");
    expect(text).toContain(code("create(name: string): SourceRow"));
    // ulid() 输出恒匹配 [0-9A-Z]，跑一批采样排除偶然：字母表本身不含 : / . 这三种被禁字符。
    for (let i = 0; i < 200; i += 1) {
      const id = ulid();
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
      expect(id).not.toMatch(/[:/.]/);
    }
  });
});

describe("ApiKeyRepository", () => {
  it("insert 落库、get 含 sourceDisabledAt；source_id 外键在 foreign_keys=ON 下强制", () => {
    const { db, sources, apiKeys } = harness("sdk-keys-basic");
    const src = sources.create("来源甲");
    const row = apiKeys.insert({
      id: "key1",
      sourceId: src.id,
      secretEnc: "enc:abc",
      label: "测试密钥",
    });
    expect(row.sourceId).toBe(src.id);
    expect(row.sourceDisabledAt).toBeNull();
    expect(apiKeys.get("key1")).toEqual(row);
    expect(() =>
      apiKeys.insert({
        id: "key-bad",
        sourceId: "no-such-source",
        secretEnc: "x",
      }),
    ).toThrow(/FOREIGN KEY/);
    sources.disable(src.id);
    expect(apiKeys.get("key1")?.sourceDisabledAt).not.toBeNull();
    closeDatabase(db);
  });

  it("listBySource 不返回 secret_enc，且按来源隔离", () => {
    const { db, sources, apiKeys } = harness("sdk-keys-isolation");
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    apiKeys.insert({ id: "key-a", sourceId: a.id, secretEnc: "enc:a" });
    apiKeys.insert({ id: "key-b", sourceId: b.id, secretEnc: "enc:b" });
    const listedA = apiKeys.listBySource(a.id);
    expect(listedA.map((row) => row.id)).toEqual(["key-a"]);
    expect(listedA[0]).not.toHaveProperty("secretEnc");
    expect(apiKeys.listBySource(b.id).map((row) => row.id)).toEqual(["key-b"]);
    closeDatabase(db);
  });

  it("disable 软停用、幂等；touchLastUsed 更新时间戳", () => {
    const { db, sources, apiKeys } = harness("sdk-keys-lifecycle");
    const src = sources.create("来源甲");
    apiKeys.insert({ id: "key1", sourceId: src.id, secretEnc: "enc:abc" });
    expect(apiKeys.disable("key1")).toBe(true);
    const disabledAt = apiKeys.get("key1")!.disabledAt;
    expect(disabledAt).not.toBeNull();
    expect(apiKeys.disable("key1")).toBe(true); // 幂等：再次停用仍匹配到行
    expect(apiKeys.get("key1")!.disabledAt).toBe(disabledAt); // 不覆盖原时间戳
    apiKeys.touchLastUsed("key1", 123456);
    expect(apiKeys.get("key1")!.lastUsedAt).toBe(123456);
    closeDatabase(db);
  });

  it("listBySource 缺 sourceId 时运行时抛错，不退化为列出全部", () => {
    const { db, apiKeys } = harness("sdk-keys-scope-required");
    expect(() => apiKeys.listBySource("")).toThrow();
    // @ts-expect-error 类型层同样不允许省略 sourceId——这一行本身应当是类型错误。
    expect(() => apiKeys.listBySource()).toThrow();
    closeDatabase(db);
  });
});

describe("SdkSessionRepository · 创建与懒建口径", () => {
  it("createSession 一个事务内建 contexts 行（含 source_id）与 sdk_sessions 行", () => {
    const { db, sources, sessions } = harness("sdk-sessions-create");
    const src = sources.create("来源甲");
    const created = sessions.createSession(src.id, { label: "第一个会话" });
    expect(created.sourceId).toBe(src.id);
    expect(created.outputFormat).toBe("markdown");
    expect(created.label).toBe("第一个会话");
    expect(created.deletedAt).toBeNull();
    expect(created.key).toBe(`chat:${created.chatId}`);
    const contextRow = db
      .prepare(
        "SELECT chat_id AS chatId, source_id AS sourceId, deleted_at AS deletedAt FROM contexts WHERE key=?",
      )
      .get(created.key) as {
      chatId: string;
      sourceId: string;
      deletedAt: number | null;
    };
    expect(contextRow.chatId).toBe(created.chatId);
    expect(contextRow.sourceId).toBe(src.id);
    expect(contextRow.deletedAt).toBeNull();
    const sdkRow = db
      .prepare(
        "SELECT output_format AS outputFormat FROM sdk_sessions WHERE key=?",
      )
      .get(created.key) as { outputFormat: string };
    expect(sdkRow.outputFormat).toBe("markdown");
    closeDatabase(db);
  });

  it("outputFormat 缺省 markdown，可显式建 plain", () => {
    const { db, sources, sessions } = harness("sdk-sessions-output-format");
    const src = sources.create("来源甲");
    const plain = sessions.createSession(src.id, { outputFormat: "plain" });
    expect(plain.outputFormat).toBe("plain");
    closeDatabase(db);
  });
});

describe("SdkSessionRepository · 来源隔离", () => {
  it("listBySource 只列出本来源的会话，不含另一来源、不含已软删的", () => {
    const { db, sources, sessions } = harness("sdk-sessions-list-isolation");
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    const s1 = sessions.createSession(a.id, { label: "甲-1" });
    const s2 = sessions.createSession(a.id, { label: "甲-2" });
    sessions.createSession(b.id, { label: "乙-1" });
    sessions.softDelete(a.id, s2.key);
    const page = sessions.listBySource(a.id);
    expect(page.items.map((row) => row.key)).toEqual([s1.key]);
    expect(sessions.listBySource(b.id).items).toHaveLength(1);
    closeDatabase(db);
  });

  it("listBySource 分页：limit 小于总数时 nextCursor 非空，翻页取到剩余项且不重复", () => {
    const { db, sources, sessions } = harness("sdk-sessions-pagination");
    const src = sources.create("来源甲");
    const created = Array.from({ length: 5 }, () =>
      sessions.createSession(src.id),
    );
    const first = sessions.listBySource(src.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = sessions.listBySource(src.id, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    const third = sessions.listBySource(src.id, {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const seenKeys = [...first.items, ...second.items, ...third.items].map(
      (row) => row.key,
    );
    expect(new Set(seenKeys).size).toBe(5);
    expect(new Set(seenKeys)).toEqual(new Set(created.map((row) => row.key)));
    closeDatabase(db);
  });

  it("getBySource(A, keyOfB) 为 null——跨来源不泄漏存在性", () => {
    const { db, sources, sessions } = harness("sdk-sessions-get-isolation");
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    const sessionOfB = sessions.createSession(b.id);
    expect(sessions.getBySource(a.id, sessionOfB.key)).toBeNull();
    expect(sessions.getBySource(b.id, sessionOfB.key)?.key).toBe(
      sessionOfB.key,
    );
    closeDatabase(db);
  });

  it("softDelete 跨来源不生效、不抛，也不改动该行；同来源生效且幂等", () => {
    const { db, sources, sessions } = harness(
      "sdk-sessions-softdelete-isolation",
    );
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    const sessionOfB = sessions.createSession(b.id);
    expect(() => sessions.softDelete(a.id, sessionOfB.key)).not.toThrow();
    expect(sessions.softDelete(a.id, sessionOfB.key)).toBe(false);
    expect(sessions.getBySource(b.id, sessionOfB.key)?.deletedAt).toBeNull();
    expect(sessions.softDelete(b.id, sessionOfB.key)).toBe(true);
    const deletedAt = sessions.getBySource(b.id, sessionOfB.key)?.deletedAt;
    expect(deletedAt).not.toBeNull();
    expect(sessions.softDelete(b.id, sessionOfB.key)).toBe(true); // 幂等
    expect(sessions.getBySource(b.id, sessionOfB.key)?.deletedAt).toBe(
      deletedAt,
    ); // 不覆盖原时间戳
    closeDatabase(db);
  });

  it("update 跨来源返回 null 且不改动；同来源改 label 生效", () => {
    const { db, sources, sessions } = harness("sdk-sessions-update-isolation");
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    const sessionOfB = sessions.createSession(b.id, { label: "原名" });
    expect(sessions.update(a.id, sessionOfB.key, { label: "改名" })).toBeNull();
    expect(sessions.getBySource(b.id, sessionOfB.key)?.label).toBe("原名");
    expect(
      sessions.update(b.id, sessionOfB.key, { label: "改名" })?.label,
    ).toBe("改名");
    closeDatabase(db);
  });

  it("逐会话方法缺 sourceId/key 时运行时抛错，类型层也没有省略这两者的重载", () => {
    const { db, sources, sessions } = harness("sdk-sessions-scope-required");
    const src = sources.create("来源甲");
    const created = sessions.createSession(src.id);
    expect(() => sessions.getBySource("", created.key)).toThrow();
    expect(() => sessions.getBySource(src.id, "")).toThrow();
    expect(() => sessions.softDelete("", created.key)).toThrow();
    expect(() => sessions.update("", created.key, { label: "x" })).toThrow();
    expect(() => sessions.purge("", created.key)).toThrow();
    // @ts-expect-error 省略 key：类型层不允许只传 sourceId。
    expect(() => sessions.getBySource(src.id)).toThrow();
    // @ts-expect-error 省略 key：类型层不允许只传 sourceId。
    expect(() => sessions.softDelete(src.id)).toThrow();
    // @ts-expect-error 省略 key 与 patch：类型层不允许只传 sourceId。
    expect(() => sessions.update(src.id)).toThrow();
    // @ts-expect-error 省略 key：类型层不允许只传 sourceId。
    expect(() => sessions.purge(src.id)).toThrow();
    closeDatabase(db);
  });
});

describe("SdkSessionRepository.purge · 硬删除面", () => {
  it("跨来源 purge 返回 null，不执行任何删除", () => {
    const { db, sources, sessions } = harness("sdk-sessions-purge-isolation");
    const a = sources.create("来源甲");
    const b = sources.create("来源乙");
    const sessionOfB = sessions.createSession(b.id);
    expect(sessions.purge(a.id, sessionOfB.key)).toBeNull();
    expect(sessions.getBySource(b.id, sessionOfB.key)).not.toBeNull();
    closeDatabase(db);
  });

  it("同来源 purge 删清七类行与磁盘文件，usage_ledger/agent_runs/approvals 保留", () => {
    const { db, directory, sources, sessions, memory } = harness(
      "sdk-sessions-purge-full",
    );
    const src = sources.create("来源甲");
    const created = sessions.createSession(src.id);
    const { chatId, key } = created;

    // 铺一条完整的会话数据：归档消息、context 三件套、turns、primemory 文档。
    db.prepare(
      `INSERT INTO messages(chat_id,tg_message_id,direction,from_kind,kind,text,raw_json,tg_date,received_at,triggered)
      VALUES (?,1,'in','user','text','你好','{}',?,?,1)`,
    ).run(chatId, Date.now(), Date.now());
    db.prepare(
      `INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,started_at)
      VALUES ('turn-1',?,?,?,'trusted','committed',?)`,
    ).run(key, chatId, chatId, Date.now());
    db.prepare(
      `INSERT INTO context_messages(key,ordinal,id,turn_id,role,origin,parts_json,tokens,created_at)
      VALUES (?,1,'m1','turn-1','user','trigger','[]',1,?)`,
    ).run(key, Date.now());
    db.prepare(
      `INSERT INTO context_commits(id,key,seq,parent_id,kind,turn_id,window_start,head_ordinal,created_at)
      VALUES ('c1',?,1,NULL,'turn','turn-1',1,1,?)`,
    ).run(key, Date.now());
    db.prepare(
      "INSERT INTO refs(key,name,commit_id,updated_at) VALUES (?,'done','c1',?)",
    ).run(key, Date.now());
    db.prepare(
      `INSERT INTO agent_runs(id,turn_id,kind,agent_name,model_alias,effective_role,state,started_at)
      VALUES ('run-1','turn-1','main','main','main','trusted','done',?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO approvals(id,turn_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at)
      VALUES ('appr-1','turn-1',?,?,'x','{}','low','pending',?,?)`,
    ).run(chatId, chatId, Date.now(), Date.now() + 60000);
    db.prepare(
      `INSERT INTO usage_ledger(ts,turn_id,chat_id,provider_id,model_id,source_id) VALUES (?, 'turn-1', ?, 'p', 'm', ?)`,
    ).run(Date.now(), chatId, src.id);

    // primemory：SDK 会话的「会话」即 chatId 本身（memory/scope.ts 已定）。
    const subject = memoryScopeSubjects(src.id, chatId).primemory;
    const write = memory.queueWrite(
      {
        scope: "primemory",
        subject,
        section: "备注",
        lines: ["- 测试记忆"],
        actor: "sdk",
        turnId: "turn-1",
        chatId,
        userId: chatId,
        sourceId: src.id,
      },
      "trusted",
      true,
      "trusted",
    );
    expect(write.ok).toBe(true);
    memory.flush("turn-1");
    const docPath = join(
      directory,
      "sources",
      src.id,
      "private",
      chatId,
      "PRIMEMORY.md",
    );
    expect(existsSync(docPath)).toBe(true);

    const result = purgeSdkSession(sessions, src.id, key);
    expect(result?.memoryDocPaths).toEqual([docPath]);

    // 七类行均已不存在。
    expect(
      db.prepare("SELECT 1 FROM sdk_sessions WHERE key=?").get(key),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 FROM memory_docs WHERE id=?")
        .get(`primemory:${subject}`),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 FROM memory_revisions WHERE doc_id=?")
        .get(`primemory:${subject}`),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM messages WHERE chat_id=?").get(chatId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM turns WHERE key=?").get(key),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM context_messages WHERE key=?").get(key),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM context_commits WHERE key=?").get(key),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM refs WHERE key=?").get(key),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM contexts WHERE key=?").get(key),
    ).toBeUndefined();
    // 磁盘文件也已删除。
    expect(existsSync(docPath)).toBe(false);

    // 保留：usage_ledger 行仍在且 source_id 不变；agent_runs / approvals 仍在。
    const ledgerRow = db
      .prepare(
        "SELECT source_id AS sourceId, chat_id AS chatId FROM usage_ledger WHERE turn_id=?",
      )
      .get("turn-1") as { sourceId: string; chatId: string } | undefined;
    expect(ledgerRow?.sourceId).toBe(src.id);
    expect(ledgerRow?.chatId).toBe(chatId);
    expect(
      db.prepare("SELECT 1 FROM agent_runs WHERE id='run-1'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT 1 FROM approvals WHERE id='appr-1'").get(),
    ).toBeTruthy();
    closeDatabase(db);
  });

  it("purgeSdkSession 对未写过 primemory 的会话同样安全（memoryDocPaths 为空数组）", () => {
    const { db, sources, sessions } = harness(
      "sdk-sessions-purge-empty-memory",
    );
    const src = sources.create("来源甲");
    const created = sessions.createSession(src.id);
    const result = purgeSdkSession(sessions, src.id, created.key);
    expect(result?.memoryDocPaths).toEqual([]);
    expect(sessions.getBySource(src.id, created.key)).toBeNull();
    closeDatabase(db);
  });
});

describe("packages/server/src/sdk/** 无裸 SQL（源码断言，目录可能尚不存在）", () => {
  it("若该目录存在，其下任何文件都不出现 .prepare( 与 db.exec(", () => {
    const root = "packages/server/src/sdk";
    if (!existsSync(root)) {
      // 目录尚不存在（T3.6 建立）：这件事本身满足「不出现裸 SQL」，用一条恒真断言留痕，
      // 而不是跳过整条用例——目录一旦出现，下方分支会开始真正扫描。
      expect(existsSync(root)).toBe(false);
      return;
    }
    const offenders: string[] = [];
    for (const entry of readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!entry.endsWith(".ts")) continue;
      const text = source(join(root, entry));
      if (text.includes(code(".prepare(")) || text.includes(code("db.exec(")))
        offenders.push(entry);
    }
    expect(
      offenders,
      `这些文件在 packages/server/src/sdk 下直接写了裸 SQL：${offenders.join("、")}`,
    ).toEqual([]);
  });
});
