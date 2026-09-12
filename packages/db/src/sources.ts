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
  /**
   * 这个来源的 SDK 会话能调哪些工具。`null` 表示用默认（`SDK_AGENT_TOOLS`），空数组表示
   * 一件都不给——两者不同，后者是显式配置的一种取值。
   *
   * 合法性不在这一层判：仓储只负责存取，工具名是否存在、是否属于结构性禁止的那两族，
   * 由 `sdkToolsFromConfig()`（`packages/core/src/tools/policy.ts`）在读侧与管理面写入前判。
   */
  tools: string[] | null;
}

const COLUMNS = `id,kind,name,character_file AS characterFile,assist_file AS assistFile,
  created_at AS createdAt,disabled_at AS disabledAt,tools`;

/**
 * `sources` 的唯一访问入口（docs/12-sdk.md T3.2）。`telegram` 行由 `0019` 种子写入，
 * 此处不提供建它或删它的方法——内建来源没有仓储层创建路径，也没有删除路径。
 */
/** 库里的原始行形态：`tools` 是一段 JSON 文本或 NULL。 */
type RawSourceRow = Omit<SourceRow, "tools"> & { tools: string | null };

/**
 * 把 `tools` 列解成数组。
 *
 * 解不开时按 `null`（用默认）处理而不是抛：这一列由管理面写入，但库文件是运维可以直接编辑的，
 * 一段坏 JSON 不该让整个来源读不出来——那会连带 Telegram 的人格配置一起失效。
 */
function hydrate(row: RawSourceRow): SourceRow {
  let tools: string[] | null = null;
  if (row.tools !== null) {
    try {
      const parsed: unknown = JSON.parse(row.tools);
      if (Array.isArray(parsed))
        tools = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      tools = null;
    }
  }
  return { ...row, tools };
}

export class SourceRepository {
  constructor(private readonly db: Sqlite) {}

  /** 含已停用行：运维面板需要区分「停用」与「不存在」。 */
  list(): SourceRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM sources ORDER BY created_at`)
        .all() as RawSourceRow[]
    ).map(hydrate);
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
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM sources WHERE id=?`)
      .get(id) as RawSourceRow | undefined;
    return row ? hydrate(row) : null;
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
   * 这个来源的 SDK 工具白名单。`null` 写回默认，空数组写「一件都不给」。
   *
   * 不在此校验工具名：仓储层不认识工具注册表，而管理面写入前已用
   * `sdkToolsFromConfig()` 判过一次；真正的边界是读侧那一次同样的判定
   * （`toolCallableBy()` 的取数口），一个失效的工具名在那里被滤掉，不会因为存进来过就放行。
   */
  setTools(id: string, tools: string[] | null): SourceRow | null {
    const changed = this.db
      .prepare("UPDATE sources SET tools=? WHERE id=?")
      .run(tools === null ? null : JSON.stringify(tools), id).changes;
    return changed === 1 ? this.get(id) : null;
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
