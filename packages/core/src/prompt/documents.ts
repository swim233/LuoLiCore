import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ulid } from "ulid";
import {
  applyPatch,
  createTwoFilesPatch,
  parsePatch,
  reversePatch,
} from "diff";
import type { Sqlite } from "@luoli/db";
import { estimateTextTokens } from "@luoli/shared";

interface PromptPaths {
  character: string;
  assist: string;
  publicMemory: string;
  privateMemory: string;
}

/** 纯文件名、`.md` 结尾、不含路径分隔符与 `..`。不合格返回 null（调用方退回全局那份）。 */
const CHARACTER_FILE = /^[\w.-]{1,96}\.md$/;
function safeCharacterName(value: unknown): string | null {
  return typeof value === "string" &&
    CHARACTER_FILE.test(value) &&
    !value.includes("..")
    ? value
    : null;
}

export class PromptDocuments {
  constructor(
    private readonly db: Sqlite,
    private readonly directory: string,
  ) {}
  ensure(): void {
    for (const scope of ["character", "assist", "pubmemory"] as const) {
      const paths = this.paths("");
      const path =
        scope === "character"
          ? paths.character
          : scope === "assist"
            ? paths.assist
            : paths.publicMemory;
      const content = this.read(path);
      const id = `${scope}:global`;
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
        )
        .run(
          id,
          scope,
          null,
          path,
          Buffer.byteLength(content),
          estimateTextTokens(content),
          createHash("sha256").update(content).digest("hex"),
          now,
        );
    }
  }

  /**
   * @param characterOverride `perChat.<key>.character`：会话级人格文件名（`memory/` 下的相对
   *   文件名，不含目录）。这里是用户可配的自由字符串被当作路径段使用的位置，与 `S-08` 同类：
   *   `../../etc/passwd` 会让人格块读到目录之外。因此只放行纯文件名加 `.md`，其余一律退回
   *   `CHARACTER.md`。静默退回而非抛错：一个拼写错误的文件名不应让整个会话无法开轮，
   *   而人格块退回全局那份是安全的默认（docs/27 · C-08）。
   */
  paths(userId: string, characterOverride?: string): PromptPaths {
    return {
      character: resolve(
        this.directory,
        safeCharacterName(characterOverride) ?? "CHARACTER.md",
      ),
      assist: resolve(this.directory, "ASSIST.md"),
      publicMemory: resolve(this.directory, "PUBMEMORY.md"),
      privateMemory: resolve(this.directory, "private", userId, "PRIMEMORY.md"),
    };
  }

  readForPrompt(input: {
    userId: string;
    isPrivate: boolean;
    characterOverride?: string;
  }): {
    character: string;
    assist: string;
    publicMemory: string;
    privateMemory?: string;
  } {
    const paths = this.paths(input.userId, input.characterOverride);
    const output: {
      character: string;
      assist: string;
      publicMemory: string;
      privateMemory?: string;
    } = {
      character: this.read(paths.character),
      assist: this.read(paths.assist),
      publicMemory: this.read(paths.publicMemory),
    };
    if (input.isPrivate) output.privateMemory = this.read(paths.privateMemory);
    return output;
  }

  save(
    scope: "character" | "assist" | "pubmemory" | "primemory",
    userId: string | null,
    content: string,
    actor: string,
  ): void {
    const paths = this.paths(userId ?? "");
    const pathByScope: Record<string, string> = {
      character: paths.character,
      assist: paths.assist,
      pubmemory: paths.publicMemory,
      primemory: paths.privateMemory,
    };
    const path = pathByScope[scope]!;
    const old = this.read(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    const id = `${scope}:${userId ?? "global"}`;
    const now = Date.now();
    const tokens = estimateTextTokens(content);
    const hash = createHash("sha256").update(content).digest("hex");
    this.db
      .prepare(
        `INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        scope,
        userId,
        path,
        Buffer.byteLength(content),
        tokens,
        hash,
        now,
      );
    const diff = createTwoFilesPatch("before", "after", old, content, "", "", {
      context: 3,
    });
    this.db
      .prepare(
        "INSERT INTO memory_revisions(id,doc_id,ts,actor,op,diff,bytes_after) VALUES (?,?,?,?,?,?,?)",
      )
      .run(ulid(), id, now, actor, "manual", diff, Buffer.byteLength(content));
  }
  rollback(
    id: string,
    revisionId: string,
    actor: string,
  ): { id: string; bytes: number } {
    const row = this.db
      .prepare("SELECT scope,subject,path FROM memory_docs WHERE id=?")
      .get(id) as
      | {
          scope: "character" | "assist" | "pubmemory" | "primemory";
          subject: string | null;
          path: string;
        }
      | undefined;
    const revisions = this.db
      .prepare(
        "SELECT id,diff FROM memory_revisions WHERE doc_id=? ORDER BY ts DESC,id DESC",
      )
      .all(id) as Array<{ id: string; diff: string }>;
    const targetIndex = revisions.findIndex((entry) => entry.id === revisionId);
    if (!row || targetIndex < 0) throw new Error("prompt_revision_not_found");
    let content = this.read(row.path);
    for (const revision of revisions.slice(0, targetIndex)) {
      const patch = parsePatch(revision.diff)[0];
      if (!patch) throw new Error("prompt_revision_invalid");
      const restored = applyPatch(content, reversePatch(patch));
      if (restored === false) throw new Error("prompt_revision_conflict");
      content = restored;
    }
    this.save(row.scope, row.subject, content, actor);
    return { id, bytes: Buffer.byteLength(content) };
  }

  private read(path: string): string {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
}

export class AgentResultStore {
  constructor(private readonly directory: string) {}

  /**
   * 返回值即写入 `agent_runs.result_full_ref` 的那个 ref，相对 `directory`，
   * 与 `attachments.local_path` 同一套（docs/28 · L-OPS-06）。存绝对路径的代价是：
   * `LUOLI_DATA_DIR` 变更过，或未设置该变量而以另一个 cwd 启动进程后，库中记录的是旧根、文件在新根，
   * 于是 `gcFiles()` 把新根下的全文整批当作孤儿删除（实测删除 74 份）。绝对路径记录的是
   * 写入时的位置，而这一列要回答的是当前从何处读取，后者只能相对当前配置解析。
   */
  put(runId: string, value: string): string {
    const ref = `${runId}.txt`;
    const path = join(this.directory, ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 });
    return ref;
  }

  /** 文件可能已被 `MaintenanceService` 按 `logs.retentionDays` 清理，或在读取前被 gc 回收。
   *  直接抛出只会得到一句与原因无关的 ENOENT，应明确告知已过期。
   *  `ref` 相对 `directory`；存量绝对路径行（归一化时指向另一个根而原样保留的那些）
   *  仍可读取，因为 `resolve` 对绝对路径是恒等的。 */
  read(
    ref: string,
    offset: number,
    limit: number,
  ): { content: string; nextOffset: number | null } {
    const path = resolve(this.directory, ref);
    if (!existsSync(path))
      return {
        content: "[子 agent 的完整结果已按日志保留期清理，仅保留摘要]",
        nextOffset: null,
      };
    const buffer = readFileSync(path);
    const content = buffer.subarray(offset, offset + limit).toString("utf8");
    return {
      content,
      nextOffset: offset + limit < buffer.length ? offset + limit : null,
    };
  }
}
