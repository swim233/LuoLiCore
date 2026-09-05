import { ulid } from "ulid";
import type { Sqlite } from "./database.js";

export interface SourceRow {
  id: string;
  kind: "telegram" | "sdk";
  name: string;
  characterFile: string | null;
  assistFile: string | null;
  createdAt: number;
  disabledAt: number | null;
}

const COLUMNS = `id,kind,name,character_file AS characterFile,assist_file AS assistFile,
  created_at AS createdAt,disabled_at AS disabledAt`;

/**
 * `sources` 的唯一访问入口（docs/12-sdk.md T3.2）。`telegram` 行由 `0019` 种子写入，
 * 此处不提供建它或删它的方法——内建来源没有仓储层创建路径，也没有删除路径。
 */
export class SourceRepository {
  constructor(private readonly db: Sqlite) {}

  /** 含已停用行：运维面板需要区分「停用」与「不存在」。 */
  list(): SourceRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM sources ORDER BY created_at`)
      .all() as SourceRow[];
  }

  /**
   * id 由此处生成的 ulid 承担，方法签名不接受调用方指定 id。A3 要求的「不含 `:` 与路径字符」
   * 因此是结构性保证而非运行时校验：ulid 字母表恒为 Crockford Base32（`[0-9A-Z]`），
   * 见 `tests/db.sdk.test.ts` 对 `ulid()` 输出形态的断言。
   */
  create(name: string): SourceRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO sources(id,kind,name,created_at) VALUES (?,'sdk',?,?)`,
      )
      .run(id, name, Date.now());
    return this.get(id)!;
  }

  get(id: string): SourceRow | null {
    return (
      (this.db.prepare(`SELECT ${COLUMNS} FROM sources WHERE id=?`).get(id) as
        SourceRow | undefined) ?? null
    );
  }

  /**
   * 内建 `telegram` 行不可停用——`kind<>'telegram'` 写进 WHERE 而非先查后判：判据只有一份，
   * 停用它会让存量 Telegram 会话的人格与 ASSIST 配置一并失效。已停用的行再次调用保持幂等。
   */
  disable(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE sources SET disabled_at=COALESCE(disabled_at,?) WHERE id=? AND kind<>'telegram'",
        )
        .run(Date.now(), id).changes === 1
    );
  }

  /**
   * 只落两列，文件名本身的合法性由读侧 `safeCharacterName` 判据兜底
   * （`packages/core/src/prompt/documents.ts`），此处不重复校验。传 `undefined` 表示该列不改。
   */
  setFiles(
    id: string,
    files: { characterFile?: string | null; assistFile?: string | null },
  ): SourceRow | null {
    const assignments: string[] = [];
    const values: Record<string, unknown> = { id };
    if (files.characterFile !== undefined) {
      assignments.push("character_file=@characterFile");
      values.characterFile = files.characterFile;
    }
    if (files.assistFile !== undefined) {
      assignments.push("assist_file=@assistFile");
      values.assistFile = files.assistFile;
    }
    if (!assignments.length) return this.get(id);
    const changed = this.db
      .prepare(`UPDATE sources SET ${assignments.join(",")} WHERE id=@id`)
      .run(values).changes;
    return changed === 1 ? this.get(id) : null;
  }
}
