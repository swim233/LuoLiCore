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
import { TELEGRAM_SOURCE_ID, splitPrimemorySubject } from "../memory/scope.js";

interface PromptPaths {
  character: string;
  assist: string;
  publicMemory: string;
  privateMemory: string;
}

interface SourceRow {
  id: string;
  characterFile: string | null;
  assistFile: string | null;
}

/** 纯文件名、`.md` 结尾、不含路径分隔符与 `..`。不合格返回 null（调用方退回该来源目录下的默认文件）。 */
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

  /**
   * 三个来源级文档（character / assist / pubmemory）按来源逐行 upsert（`docs/12-sdk.md` T2.5，
   * A4）。取代旧的 `<scope>:global` 单例形态——`id` 改为 `${scope}:${source.id}`，与
   * `MemoryStore`（T2.3）写入的形态一致，`ON CONFLICT` 才命中同一行、`path` 列才会被刷新
   * （连带收敛 T2.2 遗留的旧路径）。每次启动调用，幂等。
   *
   * 来源目录下缺 CHARACTER.md / ASSIST.md（含自定义文件名）时，从根目录模板复制一份
   * （A4：根目录两份永久保留作模板）。PUBMEMORY.md 不在此列——它是移动而非复制，缺失时
   * 按空文档处理，不回填内容，与改造前的行为一致。
   */
  ensure(): void {
    const sources = this.db
      .prepare(
        "SELECT id, character_file AS characterFile, assist_file AS assistFile FROM sources WHERE disabled_at IS NULL",
      )
      .all() as SourceRow[];
    for (const source of sources) {
      const paths = this.paths("", undefined, source.id);
      this.seedFromTemplate(paths.character, "CHARACTER.md");
      this.seedFromTemplate(paths.assist, "ASSIST.md");
      for (const scope of ["character", "assist", "pubmemory"] as const) {
        const path =
          scope === "character"
            ? paths.character
            : scope === "assist"
              ? paths.assist
              : paths.publicMemory;
        const content = this.read(path);
        const id = `${scope}:${source.id}`;
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
          )
          .run(
            id,
            scope,
            source.id,
            path,
            Buffer.byteLength(content),
            estimateTextTokens(content),
            createHash("sha256").update(content).digest("hex"),
            now,
          );
      }
    }
  }

  /** `path` 已存在则不覆盖（不重新拷贝、不覆盖已有编辑）。缺失时从根目录同名模板复制内容，
   *  模板本身缺失时按空文档处理（不抛错——新部署根目录模板由仓库自带，这里只防手工删除）。 */
  private seedFromTemplate(
    path: string,
    template: "CHARACTER.md" | "ASSIST.md",
  ): void {
    if (existsSync(path)) return;
    let content = "";
    try {
      content = readFileSync(join(this.directory, template), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }

  /** 按来源查 `sources.character_file` / `assist_file`。来源行不存在时按两个文件名皆未设置
   *  处理（`paths()` 侧退回默认文件名），不抛错——`sources` 表由 T3.2 起才有仓储层维护，
   *  这里直接查询是当前唯一的读取点。 */
  private sourceFiles(sourceId: string): {
    characterFile: string | null;
    assistFile: string | null;
  } {
    const row = this.db
      .prepare(
        "SELECT character_file AS characterFile, assist_file AS assistFile FROM sources WHERE id=?",
      )
      .get(sourceId) as
      | { characterFile: string | null; assistFile: string | null }
      | undefined;
    return row ?? { characterFile: null, assistFile: null };
  }

  /**
   * @param sessionId `primemory` 的会话段（Telegram 为发起用户 id）；其余三个来源级 scope 不用它。
   * @param characterOverride `perChat.<key>.character`：会话级人格文件名，相对 `memory/` 根目录
   *   （不随来源迁移——per-chat 覆盖此前即落根目录，A4 的搬迁范围只覆盖三个来源级文件与
   *   PRIMEMORY，docs/06 §2 的路径表同一行仍是 `memory/CHARACTER.<chatId>.md`）。优先级高于
   *   `sources.character_file`。这里是用户可配的自由字符串被当作路径段使用的位置，与 `S-08`
   *   同类：`../../etc/passwd` 会让人格块读到目录之外。因此只放行纯文件名加 `.md`，其余一律
   *   静默退回该来源目录下的 `CHARACTER.md`——一个拼写错误的文件名不应让整个会话无法开轮。
   * @param sourceId 本轮的来源 id，缺省 Telegram。决定 `sources/<sourceId>/` 前缀，以及
   *   `sources.character_file` / `assist_file`（同一 `safeCharacterName` 判据校验，非法值同样
   *   静默退回该来源目录下的 `CHARACTER.md` / `ASSIST.md`）的取值来源。
   */
  paths(
    sessionId: string,
    characterOverride?: string,
    sourceId: string = TELEGRAM_SOURCE_ID,
  ): PromptPaths {
    const overrideName = safeCharacterName(characterOverride);
    const sourceRow = this.sourceFiles(sourceId);
    const characterPath = overrideName
      ? resolve(this.directory, overrideName)
      : resolve(
          this.directory,
          "sources",
          sourceId,
          safeCharacterName(sourceRow.characterFile) ?? "CHARACTER.md",
        );
    return {
      character: characterPath,
      assist: resolve(
        this.directory,
        "sources",
        sourceId,
        safeCharacterName(sourceRow.assistFile) ?? "ASSIST.md",
      ),
      publicMemory: resolve(this.directory, "sources", sourceId, "PUBMEMORY.md"),
      privateMemory: resolve(
        this.directory,
        "sources",
        sourceId,
        "private",
        sessionId,
        "PRIMEMORY.md",
      ),
    };
  }

  readForPrompt(input: {
    userId: string;
    isPrivate: boolean;
    characterOverride?: string;
    sourceId?: string;
  }): {
    character: string;
    assist: string;
    publicMemory: string;
    privateMemory?: string;
  } {
    const paths = this.paths(
      input.userId,
      input.characterOverride,
      input.sourceId ?? TELEGRAM_SOURCE_ID,
    );
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

  /** 从 `(scope, subject)` 还原 `paths()` 需要的 (sessionId, sourceId)。三个来源级 scope 的
   *  subject 就是 sourceId 本身；`primemory` 的 subject 是复合键，拆开取两段
   *  （`splitPrimemorySubject`，与 `MemoryStore.path()` 同一判据，唯一实现点仍是
   *  `memoryScopeSubjects` 那一组函数）。`subject` 为 `null` 时按内建来源解释——尚未跑过
   *  一次 `ensure()` 的历史行，或调用方还没来得及传值。 */
  private resolveScopeLocation(
    scope: "character" | "assist" | "pubmemory" | "primemory",
    subject: string | null,
  ): { sourceId: string; sessionId: string } {
    if (scope === "primemory") {
      if (!subject) throw new Error("primemory_subject_required");
      return splitPrimemorySubject(subject);
    }
    return { sourceId: subject ?? TELEGRAM_SOURCE_ID, sessionId: "" };
  }

  save(
    scope: "character" | "assist" | "pubmemory" | "primemory",
    subject: string | null,
    content: string,
    actor: string,
  ): void {
    const { sourceId, sessionId } = this.resolveScopeLocation(scope, subject);
    const paths = this.paths(sessionId, undefined, sourceId);
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
    const id = `${scope}:${subject ?? TELEGRAM_SOURCE_ID}`;
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
        subject,
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
    // 次键用 rowid 而非 id：id 是 ulid，同一毫秒内的生成序与字典序不保证一致（实测同进程
    // 连生成 5 个即可能乱序），会把同毫秒内更早写入的修订排到更后面，rollback() 退化为空操作。
    // memory_revisions 是普通 rowid 表（`id TEXT PRIMARY KEY` 不是 INTEGER，不别名 rowid），
    // 插入顺序单调递增，可以直接借用。
    const revisions = this.db
      .prepare(
        "SELECT id,diff FROM memory_revisions WHERE doc_id=? ORDER BY ts DESC,rowid DESC",
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
