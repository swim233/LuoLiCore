import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { ulid } from "ulid";
import type { Role } from "@luoli/shared";
import { estimateTextTokens, roleRank } from "@luoli/shared";
import { type Sqlite, decodeLogPayload } from "@luoli/db";
import {
  TELEGRAM_SOURCE_ID,
  memoryScopeSubjects,
  splitPrimemorySubject,
} from "./scope.js";

interface MemoryDocument {
  id: string;
  scope: "assist" | "character" | "pubmemory" | "primemory";
  subject: string | null;
  path: string;
  content: string;
}

interface PendingWrite {
  scope: "pubmemory" | "primemory";
  subject: string | null;
  section: string;
  lines: string[];
  actor: string;
  turnId: string;
  chatId: string;
  userId: string;
  /** `memory.requireSourceTag`（默认 true）：每条写入是否带 `<!-- src: … -->` 来源标注。
   *  关闭可节省 token，代价是该条记忆的来源人与场景无法再追溯（docs/14 A10）。 */
  requireSourceTag?: boolean;
  /**
   * 本轮的来源 id，缺省 `"telegram"`。仅用于 `primemory` 的访问闸——按 `(sourceId, userId)`
   * 重新算出调用者本人的作用域键，与 `subject` 比较（唯一实现点 [[memoryScopeSubjects]]）。
   * 不参与路径与来源标注。
   */
  sourceId?: string;
}

// 与上下文、提示词共用同一套度量：记忆的软硬上限是按 token 配置的，估算器不一致时
// 剩余额度会在两个页面上给出两个数值（docs/06 §3）。
const estimateTokens = estimateTextTokens;

function normalized(content: string): string {
  return content.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 来源标注不参与相似度计算：`jaccard` 统计的是字符集合，`<!-- src: chat … -->` 中的
 *  字母数字会撑大并集，使内容相同的两条相似度降到六七成。 */
function stripSource(line: string): string {
  return line.replace(/<!--[^]*?-->/g, "").trim();
}

function jaccard(a: string, b: string): number {
  const left = new Set([...normalized(a)]);
  const right = new Set([...normalized(b)]);
  const intersection = [...left].filter((char) => right.has(char)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 1;
}
function parseSections(content: string): {
  title: string;
  sections: Map<string, string[]>;
} {
  const lines = content.split("\n");
  const title = lines.find((line) => line.startsWith("# ")) ?? "# 记忆";
  const sections = new Map<string, string[]>();
  let current = "其他";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (line.startsWith("- ")) {
      const values = sections.get(current) ?? [];
      values.push(line);
      sections.set(current, values);
    }
  }
  return { title, sections };
}

function serializeSections(
  title: string,
  sections: Map<string, string[]>,
): string {
  return `${title}\n\n${[...sections].map(([name, lines]) => `## ${name}\n${lines.join("\n")}`).join("\n\n")}\n`;
}

export class MemoryStore {
  readonly #pending = new Map<string, PendingWrite[]>();

  constructor(
    private readonly db: Sqlite,
    readonly directory: string,
    private readonly softLimit: number,
    private readonly hardLimit: number,
    private readonly maxSections = 12,
    private readonly log?: {
      event(input: {
        level: "info" | "warn";
        kind: string;
        summary: string;
        data?: unknown;
      }): number;
    },
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /**
   * 查看他人私有记忆会被记录（D11 的问责设计，`docs/06 §425`）这条约束的唯一发出点——
   * 现在唯一的调用方是 WebUI（`app.ts:3692` 的 `auditPrimemoryAccess`）。`read()` 内部不再
   * 调用它：owner 例外整条删除后（Q-C，`docs/12-sdk.md` T2.4），越过闸读他人私有记忆这件事本身
   * 在工具路径上不再发生，也就没有「越过之后记一笔」的分支；owner 读他人私有记忆的通道只剩
   * `GET /api/prompts/:id` 这一条，它按 `memory_docs.path` 直接读文件，绕过整个 MemoryStore。
   *
   * `userId` 记录的是被查看者而非查看者：`lastOwnerRead()` 与用户自己的 `/memory`
   * 都按它查询。查看者记录在 `data.actor` 中。
   */
  auditPrivateAccess(
    targetUserId: string | null,
    actor: string,
    op: "read" | "write",
  ): void {
    this.log?.event({
      level: "warn",
      kind: "memory.owner_read_private",
      summary: `Owner ${op === "read" ? "read" : "edited"} another user private memory`,
      ...(targetUserId ? { userId: targetUserId } : {}),
      data: { targetUserId, actor, op },
    });
  }

  /**
   * 最近被 owner 查看时间的数据源。问责要求被查看者本人可见，因此 `/memory`
   * 读取它；若只落一条日志且仅 owner 能在控制台查看，那是记录而非问责。
   * 按日志查询而不给 `memory_docs` 加一列：该数据本就有保留期，而迁移不可回退。
   */
  lastOwnerRead(userId: string): { ts: number; op: string } | null {
    const row = this.db
      .prepare(
        "SELECT ts,data,data_codec AS codec FROM log_events WHERE kind='memory.owner_read_private' AND user_id=? ORDER BY ts DESC LIMIT 1",
      )
      .get(userId) as
      { ts: number; data: Buffer | null; codec: string | null } | undefined;
    if (!row) return null;
    let op = "read";
    try {
      op = String(
        (JSON.parse(decodeLogPayload(row.data, row.codec) ?? "{}") as {
          op?: unknown;
        }).op ?? "read",
      );
    } catch {
      /* 历史行没有 op */
    }
    return { ts: row.ts, op };
  }

  /**
   * `sourceId`（缺省 `"telegram"`）只用于重算调用者本人在 `primemory` 下的作用域键
   * （`memoryScopeSubjects(sourceId, actorUserId).primemory`），不参与路径计算——`subject`
   * 参数本身已是调用方（`builtins.ts`）按同一函数算好的复合键。
   *
   * `primemory` 唯一的放行条件是 `subject === ownSubject`：调用者只能读自己在
   * `(sourceId, actorUserId)` 下算出的那一份。角色不参与判定——owner 例外整条删除
   * （Q-C，`docs/12-sdk.md` T2.4），owner 读他人私有记忆的通道只剩 WebUI
   * （`app.ts:3692` 的 `auditPrimemoryAccess`，不经过这里）。唯一实现点仍是
   * [[memoryScopeSubjects]]。`actorRole` 保留在签名里只为不改动既有调用点的位置参数，
   * 本方法内不再读取它。
   */
  read(
    scope: "assist" | "character" | "pubmemory" | "primemory",
    subject: string | null,
    actorRole: Role,
    actorUserId?: string,
    isPrivate = false,
    sourceId = TELEGRAM_SOURCE_ID,
  ): MemoryDocument {
    if (scope === "primemory") {
      if (!isPrivate) throw new Error("private_memory_forbidden");
      const ownSubject = actorUserId
        ? memoryScopeSubjects(sourceId, actorUserId).primemory
        : undefined;
      if (subject !== ownSubject) throw new Error("private_memory_forbidden");
    }
    const document = this.readRaw(scope, subject);
    this.log?.event({
      level: "info",
      kind: "memory.read",
      summary: `Read ${scope}`,
      data: { scope, subject, bytes: Buffer.byteLength(document.content) },
    });
    return document;
  }

  queueWrite(
    input: PendingWrite,
    role: Role,
    isPrivate: boolean,
    pubWriteMinRole: Role,
  ): Record<string, unknown> {
    // 与 `read()` 同一条闸：`input.subject` 是复合键，`input.userId` 是裸 id，直接比较恒不
    // 相等——重算 `input.userId` 本人的复合键再比较（同一实现点）。写侧从未有过角色例外，
    // Q-C（`docs/12-sdk.md` T2.4）删的是 `read()` 那条。
    if (
      input.scope === "primemory" &&
      (!isPrivate ||
        input.subject !==
          memoryScopeSubjects(input.sourceId ?? TELEGRAM_SOURCE_ID, input.userId)
            .primemory)
    )
      return { ok: false, error: "primemory_scope_forbidden" };
    if (
      input.scope === "pubmemory" &&
      roleRank(role) < roleRank(pubWriteMinRole)
    )
      return { ok: false, error: "权限不足" };
    const document = this.read(
      input.scope,
      input.subject,
      role,
      input.userId,
      isPrivate,
      input.sourceId,
    );
    const existing = document.content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map(stripSource);
    const unique = input.lines.filter(
      (line) =>
        !existing.some(
          (candidate) => jaccard(candidate, stripSource(line)) > 0.85,
        ),
    );
    if (!unique.length)
      return { ok: true, skipped: true, reason: "已存在相似条目" };
    const source =
      input.requireSourceTag === false
        ? ""
        : `  <!-- src: chat ${input.chatId} by ${input.userId} at ${new Date().toISOString()} -->`;
    const annotated = unique.map(
      (line) => `- ${line.replace(/^\s*-\s*/, "")}${source}`,
    );
    const projected = `${document.content}\n\n## ${input.section}\n${annotated.join("\n")}\n`;
    if (estimateTokens(projected) > this.hardLimit)
      return {
        ok: false,
        error: "memory_hard_limit",
        hint: "请先整理现有记忆",
      };
    const list = this.#pending.get(input.turnId) ?? [];
    list.push({ ...input, lines: annotated });
    this.#pending.set(input.turnId, list);
    return {
      ok: true,
      pending: true,
      softLimitExceeded: estimateTokens(projected) > this.softLimit,
    };
  }

  /**
   * `queueWrite` 的去重与硬上限判据取自工具调用那一刻的快照，而落盘发生在轮末：这段时间内
   * 其他轮次完全可能已把同一条写入同一份文档（PUBMEMORY 按来源分区，同来源内的轮次共享
   * 同一份文档）。`flush` 自身是同步的，
   * `readRaw` → 修改 → `persist` 之间没有 await，事件循环无法插入，因此不会丢失更新
   * （`docs/22 · I-05` 所说的锁不是这里需要的）。真正会失效的是那两条判据：重复条目照样落盘，
   * 硬上限也会被越过。两条都在这里按新读到的内容重新执行一遍。
   */
  flush(turnId: string): Record<string, unknown> {
    const writes = this.#pending.get(turnId) ?? [];
    const grouped = new Map<string, PendingWrite[]>();
    for (const write of writes) {
      const key = `${write.scope}:${write.subject ?? "global"}`;
      const list = grouped.get(key) ?? [];
      list.push(write);
      grouped.set(key, list);
    }
    let written = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const group of grouped.values()) {
      const first = group[0]!;
      const document = this.readRaw(first.scope, first.subject);
      const parsed = parseSections(
        document.content ||
          (first.scope === "pubmemory" ? "# 公开记忆\n" : "# 私有记忆\n"),
      );
      const landed = document.content
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map(stripSource);
      for (const write of group) {
        const fresh = write.lines.filter((line) => {
          if (
            !landed.some(
              (candidate) => jaccard(candidate, stripSource(line)) > 0.85,
            )
          ) {
            landed.push(stripSource(line));
            return true;
          }
          duplicates += 1;
          return false;
        });
        if (!fresh.length) continue;
        const lines = parsed.sections.get(write.section) ?? [];
        lines.push(...fresh);
        parsed.sections.delete(write.section);
        parsed.sections.set(write.section, lines);
      }
      while (parsed.sections.size > this.maxSections) {
        // 其他分组自身不能作为合并来源：它与目标是同一个数组，会把整段条目复制一份（docs/19 · R-MEM-01）。
        const oldest = [...parsed.sections.keys()].find(
          (name) => name !== "其他",
        );
        if (!oldest) break;
        const merged = [
          ...(parsed.sections.get("其他") ?? []),
          ...(parsed.sections.get(oldest) ?? []),
        ];
        parsed.sections.delete(oldest);
        parsed.sections.delete("其他");
        parsed.sections.set("其他", merged);
      }
      const content = serializeSections(parsed.title, parsed.sections);
      if (content === document.content) continue;
      // 硬上限是最后一道闸：`queueWrite` 放行时文档还小，落盘时可能已被其他轮次写大。
      // 越过它写入会让这份文档从此无法裁剪回来。
      if (estimateTokens(content) > this.hardLimit) {
        rejected += 1;
        this.log?.event({
          level: "warn",
          kind: "memory.hard_limit",
          summary: `Skipped ${first.scope} at hard limit`,
          data: {
            scope: first.scope,
            subject: first.subject,
            tokens: estimateTokens(content),
            hardLimit: this.hardLimit,
          },
        });
        continue;
      }
      this.persist(document, content, first);
      written += 1;
      if (estimateTokens(content) > this.softLimit) {
        // `first.subject` 对 primemory 是复合键（含 `:`），文件名不按来源分目录——
        // 用 `-` 替掉 `:` 而不是拆两段建子目录：`.pending/` 不按来源分区（T2.2 明确留答，
        // `memory/.pending/` 是写入暂存区，不动），保持扁平即可，只是不能让 `:` 落进文件名。
        const pending = resolve(
          this.directory,
          ".pending",
          `${first.scope}-${(first.subject ?? TELEGRAM_SOURCE_ID).replace(/:/g, "-")}.md`,
        );
        mkdirSync(dirname(pending), { recursive: true, mode: 0o700 });
        writeFileSync(pending, content, { mode: 0o600 });
      }
    }
    this.#pending.delete(turnId);
    // 仅在确有内容时附加字段：`documents: 0` 那条断言（tests/memory.operations.test.ts）验证的是
    // abort 之后未写入任何内容，恒定多出两个 0 会让它退化为核对计数器而非核对该事实。
    return {
      ok: true,
      documents: written,
      ...(duplicates ? { duplicates } : {}),
      ...(rejected ? { rejected } : {}),
    };
  }
  discard(turnId: string): number {
    const count = this.#pending.get(turnId)?.length ?? 0;
    this.#pending.delete(turnId);
    return count;
  }

  list(): Array<{
    scope: string;
    subject: string | null;
    path: string;
    bytes: number;
    tokens: number;
  }> {
    return this.db
      .prepare(
        "SELECT scope,subject,path,bytes,tokens FROM memory_docs ORDER BY updated_at DESC",
      )
      .all() as Array<{
      scope: string;
      subject: string | null;
      path: string;
      bytes: number;
      tokens: number;
    }>;
  }
  private readRaw(
    scope: MemoryDocument["scope"],
    subject: string | null,
  ): MemoryDocument {
    const path = this.path(scope, subject);
    let content = "";
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      // `subject` 缺省回退到 `TELEGRAM_SOURCE_ID` 而非字面 `"global"`：0019 迁移之后
      // `memory_docs.id` 恒为 `<scope>:telegram`（三个来源级 scope）或
      // `primemory:telegram:<userId>`，两侧不一致会在 `persist()` 的 `ON CONFLICT(id)` 处
      // 走失——命中不到迁移后的行，多插入一行永远读不到的旧 id。
      id: `${scope}:${subject ?? TELEGRAM_SOURCE_ID}`,
      scope,
      subject,
      path,
      content,
    };
  }

  /**
   * 新布局（`docs/12-sdk.md` T2.2/T2.3，A4）：四个 scope 全部按来源分路径，
   * `memory/sources/<sourceId>/{ASSIST,CHARACTER,PUBMEMORY}.md`，
   * `memory/sources/<sourceId>/private/<sessionId>/PRIMEMORY.md`。与
   * `packages/core/src/memory/layout.ts` 的搬迁目标路径逐字一致——那边搬文件，这边算路径，
   * 算出来对不上，`migrateMemoryLayout()` 搬完的文件就成了永远读不到的孤儿。
   *
   * `assist` / `character` / `pubmemory` 的 subject 就是 sourceId 本身；`primemory` 的 subject
   * 是复合键 `<sourceId>:<sessionId>`，用 `splitPrimemorySubject` 拆回两段——复合 subject
   * 只作 `memory_docs` 里的键，不直接当目录名（含 `:` 的目录名在部分文件系统上不合法）。
   */
  private path(scope: string, subject: string | null): string {
    if (scope === "primemory") {
      const { sourceId, sessionId } = splitPrimemorySubject(subject ?? "");
      return join(
        this.directory,
        "sources",
        sourceId,
        "private",
        sessionId,
        "PRIMEMORY.md",
      );
    }
    const filenames: Record<string, string> = {
      assist: "ASSIST.md",
      character: "CHARACTER.md",
      pubmemory: "PUBMEMORY.md",
    };
    const filename = filenames[scope];
    if (!filename) throw new Error(`invalid_scope: ${scope}`);
    // 缺省回退到 telegram：批二仅此一个来源，历史调用点（`tests/regression.*`）传 `null`
    // subject 时按内建来源解释，而不是拒绝——那些用例测的是别的行为，不是来源隔离。
    return join(this.directory, "sources", subject ?? TELEGRAM_SOURCE_ID, filename);
  }

  private persist(
    document: MemoryDocument,
    content: string,
    write: PendingWrite,
    operation = "append",
  ): void {
    mkdirSync(dirname(document.path), { recursive: true, mode: 0o700 });
    const old = document.content;
    const temporary = `${document.path}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, document.path);
    const now = Date.now();
    const hash = createHash("sha256").update(content).digest("hex");
    this.db
      .prepare(
        `INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
      )
      .run(
        document.id,
        document.scope,
        document.subject,
        document.path,
        Buffer.byteLength(content),
        estimateTokens(content),
        hash,
        now,
      );
    const diff = createTwoFilesPatch("before", "after", old, content, "", "", {
      context: 3,
    });
    this.db
      .prepare(
        "INSERT INTO memory_revisions(id,doc_id,ts,actor,turn_id,chat_id,user_id,op,diff,bytes_after) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ulid(),
        document.id,
        now,
        write.actor,
        write.turnId || null,
        write.chatId,
        write.userId,
        operation,
        diff,
        statSync(document.path).size,
      );
    this.log?.event({
      level: "info",
      kind: "memory.write",
      summary: `${operation} ${document.scope}`,
      data: {
        scope: document.scope,
        subject: document.subject,
        op: operation,
        bytesAfter: Buffer.byteLength(content),
      },
    });
  }
}
