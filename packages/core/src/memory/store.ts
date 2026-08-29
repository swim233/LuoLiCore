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
import type { Sqlite } from "@luoli/db";

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
   * 查看他人私有记忆会被记录（D11 的问责设计，`docs/06 §425`）这条约束的唯一发出点。
   *
   * 单独提取是因为 WebUI 那条路不经过 `read()`：`GET /api/prompts/:id` 按 `memory_docs.path`
   * 直接读文件，绕过整个 MemoryStore，于是那条路上没有任何日志，而提示词页那张卡的副标题
   * 正写着这句话（docs/29 · `M-MEM-01`）。修改该约束时只需改这一处。
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
        "SELECT ts,data_json AS data FROM log_events WHERE kind='memory.owner_read_private' AND user_id=? ORDER BY ts DESC LIMIT 1",
      )
      .get(userId) as { ts: number; data: string | null } | undefined;
    if (!row) return null;
    let op = "read";
    try {
      op = String(
        (JSON.parse(row.data ?? "{}") as { op?: unknown }).op ?? "read",
      );
    } catch {
      /* 历史行没有 op */
    }
    return { ts: row.ts, op };
  }

  read(
    scope: "assist" | "character" | "pubmemory" | "primemory",
    subject: string | null,
    actorRole: Role,
    actorUserId?: string,
    isPrivate = false,
  ): MemoryDocument {
    if (scope === "primemory") {
      if (!isPrivate) throw new Error("private_memory_forbidden");
      if (subject !== actorUserId && actorRole !== "owner")
        throw new Error("private_memory_forbidden");
      if (subject !== actorUserId)
        this.auditPrivateAccess(subject, actorUserId ?? "unknown", "read");
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
    if (
      input.scope === "primemory" &&
      (!isPrivate || input.subject !== input.userId)
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
   * 其他轮次完全可能已把同一条写入同一份文档（PUBMEMORY 是全局单份）。`flush` 自身是同步的，
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
        const pending = resolve(
          this.directory,
          ".pending",
          `${first.scope}-${first.subject ?? "global"}.md`,
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
      id: `${scope}:${subject ?? "global"}`,
      scope,
      subject,
      path,
      content,
    };
  }

  private path(scope: string, subject: string | null): string {
    const paths: Record<string, string> = {
      assist: join(this.directory, "ASSIST.md"),
      character: join(this.directory, "CHARACTER.md"),
      pubmemory: join(this.directory, "PUBMEMORY.md"),
      primemory: join(
        this.directory,
        "private",
        subject ?? "invalid",
        "PRIMEMORY.md",
      ),
    };
    return paths[scope]!;
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
