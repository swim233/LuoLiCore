import { createHash } from "node:crypto";
import { watch } from "chokidar";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { Role } from "@luoli/shared";
import { estimateTextTokens, roleRank } from "@luoli/shared";
import type { Sqlite } from "@luoli/db";
import type { LogSink } from "../log/sink.js";

const VALID_ROLES: Record<Role, true> = {
  blocked: true,
  limited: true,
  trusted: true,
  owner: true,
};

/**
 * 随包提交在 `skills/` 中的四份说明文档 —— 模型编写 plugin / 定义工具 / 安装 MCP 前需阅读的文档。
 * 它们经 `load_skill` 渐进披露，平时只占目录中四行。`write_skill` 与 `install_skill`
 * 均拒绝覆写它们，WebUI 也只放行启停：模型改写自身说明文档后，后续将依据被改坏的版本工作。
 *
 * 定义在 loader 而非 `tools/authoring.ts`：`persist()` 依赖它把 `source` 判定为 `bundled`，
 * 而 authoring 反向 import loader —— 放在那边会形成 import 环。
 */
export const BUNDLED_SKILLS = [
  "writing-tools",
  "writing-skills",
  "writing-plugins",
  "installing-mcp",
] as const;
/** 安装包时留下的记录（来源、时间、原档 sha256）。其存在与否决定 `source` 取 `package` 还是 `local`。 */
export const SKILL_PACKAGE_MARKER = ".package.json";

export const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(500),
  "allowed-tools": z.array(z.string()).optional(),
  "requires-tools": z.array(z.string()).optional(),
  "min-role": z.enum(["blocked", "limited", "trusted", "owner"]).optional(),
  model: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
  enabled: z.boolean().default(true),
});

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  dir: string;
  /** 仅在声明且非空时出现：`allowed-tools: []` 归入未声明一档（docs/07 §2.2）。 */
  allowedTools?: string[];
  /**
   * 该 skill 讲解的是若干工具的用法。这些工具不在本轮可用集内时，整份 skill 不出现在目录中。
   *
   * `allowed-tools` 表示载入后收窄到这些工具，方向相反。缺少本字段的实测代价：四份自撰写说明文档
   * 仅被 `min-role: owner` 拦截，而其讲解的 `install_mcp` / `define_tool` 受
   * `tools.selfExtend.*` 控制且出厂关闭 —— 模型读到说明文档却找不到工具，随后耗费八分钟
   * 用 `bash` 逆向代码库、取 sessions 表中的 owner 会话直接调用 WebUI API 完成任务。
   * 目录中出现一份讲解不可用工具的说明文档，劣于没有这份说明文档。
   */
  requiresTools?: string[];
  minRole: Role;
  model?: string;
  enabled: boolean;
  files: string[];
  loadError?: string;
}
export interface SkillWriteInput {
  description?: string | undefined;
  body?: string | undefined;
  allowedTools?: string[] | undefined;
  /**
   * 装载侧一直完整（写入 frontmatter，并据此把所需工具不在本轮工具集内的 skill 排除出目录），
   * 而此处此前缺少该字段 —— WebUI 表单有对应栏位、请求体也确实发送，服务端返回 200 已保存，
   * 文件中却没有：表现为用户未填写（docs/29 · M-WEB-11）。它是门控字段，丢失即意味着
   * WebUI 建出的 skill 永远能进目录，即便其讲解的工具本轮完全不可用。
   */
  requiresTools?: string[] | undefined;
  minRole?: Role | undefined;
  model?: string | null | undefined;
  enabled?: boolean | undefined;
}
interface NormalizedSkillWriteInput {
  description: string;
  body: string;
  /** 空数组表示不声明（`write()` 不写该行），而非收窄到零个工具 —— docs/07 §2.2。 */
  allowedTools: string[];
  /** 缺省时沿用已有值 —— 编辑既有 skill 时若不回传，一次编辑即会清空该字段。 */
  requiresTools: string[];
  minRole: Role;
  model: string | null;
  enabled: boolean;
}

export class SkillLoader {
  readonly #skills = new Map<string, SkillDefinition>();

  readonly #defaultMinRole: () => Role;
  readonly #onChange: (() => void) | undefined;
  /** 上一次扫描的 `name → content_hash`，用于判定本次是否实际发生变更（见 `scan()` 末尾）。 */
  #signature = new Map<string, string>();
  /**
   * @param log 可选。`scan()` 的 per-skill catch 此前只写 `skills.load_error` 列，而该列
   *   仅扩展页读取 —— 新增的 skill 未生效这一问题在日志中没有任何记录，与
   *   `agent.file_invalid` 不对称（docs/28 · L-LOG-01）。
   */
  constructor(
    private readonly db: Sqlite,
    readonly directory: string,
    defaultMinRole: Role | (() => Role) = "trusted",
    onChange?: () => void,
    private readonly log?: LogSink,
  ) {
    this.#defaultMinRole =
      typeof defaultMinRole === "function"
        ? defaultMinRole
        : () => defaultMinRole;
    this.#onChange = onChange;
  }
  #watcher: ReturnType<typeof watch> | null = null;

  scan(): SkillDefinition[] {
    this.#skills.clear();
    let entries: Dirent[] = [];
    // ENOENT 与其余错误必须区分：目录不存在表示没有任何 skill，而权限错误 / EIO 表示读取失败 ——
    // 后者绝不能进入下方的清理逻辑，否则等于按磁盘为空的结论清空整张表。
    let readable = true;
    try {
      entries = readdirSync(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      readable = false;
    }
    // 只接受真正的子目录，且跳过点号开头的项。`.staging-*` / `.backups/` 依赖此条才能置于
    // `skills/` 内（安装包需同分区 `renameSync` 落位，docs/07 §2.5）；同时修复了一个既有问题：
    // 此前 `skills/` 下任一 `.DS_Store` 都会被当作 skill 目录并产生一行 `load_error`。
    // 符号链接同样不接受（`Dirent.isDirectory()` 对其为假）：`resolveResource()` 的包含判断走
    // `resolve()` 而非 `realpath`，指向外部的符号链接等于为 `skill://` 开出一条逃逸路径。
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    for (const directory of directories) {
      const path = join(this.directory, directory, "SKILL.md");
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = matter(raw);
        const meta = frontmatterSchema.parse(parsed.data);
        if (meta.name !== directory)
          throw new Error("skill name must equal directory name");
        const files = readdirSync(join(this.directory, directory), {
          recursive: true,
          withFileTypes: true,
        })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(
              join(this.directory, directory),
              join(entry.parentPath, entry.name),
            ),
          );
        const skill: SkillDefinition = {
          name: meta.name,
          description: meta.description,
          body: parsed.content.trim(),
          dir: join(this.directory, directory),
          minRole: meta["min-role"] ?? this.#defaultMinRole(),
          enabled: meta.enabled,
          files,
        };
        // 用 `?.length` 而非真值判断：`allowed-tools: []` 表示未声明，而非收窄到零个工具
        // （docs/07 §2.2）。空数组在 JS 中为 truthy，写成 `if (meta[...])` 会落入已声明一档，
        // 导致 `load()` 中的交集恒为空、任何角色都无法载入。
        if (meta["allowed-tools"]?.length)
          skill.allowedTools = meta["allowed-tools"];
        if (meta["requires-tools"]?.length)
          skill.requiresTools = meta["requires-tools"];
        if (meta.model) skill.model = meta.model;
        this.#skills.set(skill.name, skill);
        this.persist(skill, path, raw, meta);
      } catch (error) {
        const skill: SkillDefinition = {
          name: directory,
          description: "",
          body: "",
          dir: dirname(path),
          minRole: "owner",
          enabled: false,
          files: [],
          loadError: error instanceof Error ? error.message : String(error),
        };
        this.#skills.set(directory, skill);
        this.persist(skill, path, "", {});
      }
    }
    // `skills` 表是磁盘文件的读模型而非真相来源（docs/03 §2.10）。`persist()` 只做 upsert，
    // 因此此前直接删除磁盘上的 skill 目录时，对应行会长期留在表中并持续显示在扩展页 ——
    // 唯一删除行的是 `remove()`，而它只覆盖从 WebUI 或工具删除这一条路径。
    if (readable) this.prune([...this.#skills.keys()]);
    const signature = new Map(
      [...this.#skills].map(([name, skill]) => [
        name,
        `${skill.enabled}:${skill.loadError ?? ""}:${this.hashOf(name)}`,
      ]),
    );
    const changed =
      signature.size !== this.#signature.size ||
      [...signature].some(
        ([name, value]) => this.#signature.get(name) !== value,
      );
    // 仅在该 skill 实际变更时落 `skill.load`：watcher 一次保存会连发多个事件，
    // 而安装一个包需写入数十个文件 —— 逐次记录会把一次 `install_skill` 放大为数十行（`docs/10 §2`）。
    // 签名取磁盘内容 + 启停状态 + 解析结果，与广播使用同一份判据。
    for (const [name, value] of signature) {
      if (this.#signature.get(name) === value) continue;
      const skill = this.#skills.get(name)!;
      this.log?.event({
        level: skill.loadError ? "error" : "info",
        kind: "skill.load",
        summary: skill.loadError
          ? `skill ${name} 解析失败：${skill.loadError}`.slice(0, 300)
          : `skill ${name} 已装载`,
        data: {
          name,
          tokens: estimateTextTokens(skill.body),
          minRole: skill.minRole,
          enabled: skill.enabled,
          allowedTools: skill.allowedTools ?? null,
          requiresTools: skill.requiresTools ?? null,
          error: skill.loadError ?? null,
        },
      });
    }
    this.#signature = signature;
    // 在 watcher 的 100ms 去抖之外再加一层：安装一个包需写入数十个文件，若每次写盘都广播，
    // 一次安装会产生数十条 SSE 及数十轮 WebUI 端点重拉。
    if (changed) this.#onChange?.();
    return [...this.#skills.values()];
  }

  private prune(keep: readonly string[]): void {
    const stale = this.db.prepare("SELECT name FROM skills").all() as Array<{
      name: string;
    }>;
    const alive = new Set(keep);
    for (const row of stale)
      if (!alive.has(row.name))
        this.db.prepare("DELETE FROM skills WHERE name=?").run(row.name);
  }

  private hashOf(name: string): string {
    return (
      (
        this.db
          .prepare("SELECT content_hash FROM skills WHERE name=?")
          .get(name) as { content_hash: string } | undefined
      )?.content_hash ?? ""
    );
  }
  startWatching(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.directory, { ignoreInitial: true });
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.#watcher.on("all", () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        this.scan();
      }, 100);
    });
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = null;
  }
  read(name: string): SkillDefinition | null {
    const skill = this.#skills.get(name);
    return skill
      ? {
          ...skill,
          files: [...skill.files],
          ...(skill.allowedTools
            ? { allowedTools: [...skill.allowedTools] }
            : {}),
          ...(skill.requiresTools
            ? { requiresTools: [...skill.requiresTools] }
            : {}),
        }
      : null;
  }

  create(name: string, input: SkillWriteInput): SkillDefinition {
    this.validateInput(input);
    this.assertName(name);
    if (this.#skills.has(name) || existsSync(join(this.directory, name)))
      throw new Error("skill_already_exists");
    if (typeof input.description !== "string" || typeof input.body !== "string")
      throw new Error("skill_description_and_body_required");
    return this.write(name, {
      description: input.description,
      body: input.body,
      allowedTools: input.allowedTools ?? [],
      requiresTools: input.requiresTools ?? [],
      minRole: input.minRole ?? this.#defaultMinRole(),
      model: input.model ?? null,
      enabled: input.enabled ?? true,
    });
  }

  update(name: string, input: SkillWriteInput): SkillDefinition {
    this.validateInput(input);
    this.assertName(name);
    const current = this.#skills.get(name);
    if (!current || current.loadError) throw new Error("skill_not_found");
    return this.write(name, {
      description: input.description ?? current.description,
      body: input.body ?? current.body,
      allowedTools: input.allowedTools ?? current.allowedTools ?? [],
      requiresTools: input.requiresTools ?? current.requiresTools ?? [],
      minRole: input.minRole ?? current.minRole,
      model: input.model === undefined ? (current.model ?? null) : input.model,
      enabled: input.enabled ?? current.enabled,
    });
  }

  remove(name: string): boolean {
    this.assertName(name);
    const path = join(this.directory, name);
    if (!existsSync(path) && !this.#skills.has(name)) return false;
    if (existsSync(path)) rmSync(path, { recursive: true });
    this.#skills.delete(name);
    this.db.prepare("DELETE FROM skills WHERE name=?").run(name);
    return true;
  }

  private assertName(name: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("invalid_skill_name");
  }

  private validateInput(input: SkillWriteInput): void {
    if (
      input.description !== undefined &&
      typeof input.description !== "string"
    )
      throw new Error("invalid_skill_description");
    if (input.body !== undefined && typeof input.body !== "string")
      throw new Error("invalid_skill_body");
    if (
      input.allowedTools !== undefined &&
      (!Array.isArray(input.allowedTools) ||
        input.allowedTools.some((entry) => typeof entry !== "string"))
    )
      throw new Error("invalid_skill_allowed_tools");
    if (
      input.requiresTools !== undefined &&
      (!Array.isArray(input.requiresTools) ||
        input.requiresTools.some((entry) => typeof entry !== "string"))
    )
      throw new Error("invalid_skill_requires_tools");
    if (input.minRole !== undefined && !(input.minRole in VALID_ROLES))
      throw new Error("invalid_skill_min_role");
    if (
      input.model !== undefined &&
      input.model !== null &&
      typeof input.model !== "string"
    )
      throw new Error("invalid_skill_model");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new Error("invalid_skill_enabled");
  }

  private write(
    name: string,
    input: NormalizedSkillWriteInput,
  ): SkillDefinition {
    const directory = join(this.directory, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "SKILL.md");
    const data: Record<string, unknown> = {
      name,
      description: input.description,
      "min-role": input.minRole,
      enabled: input.enabled,
    };
    // 与 `requires-tools` 规则一致：空列表不写该行。此前为无条件写入，导致
    // WebUI 扩展页留空的「允许工具」输入框（placeholder：留空表示沿用当前角色全部可用工具）
    // 与省略该参数的 `write_skill` 都会把 `allowed-tools: []` 写进 frontmatter ——
    // 已安装的 skill 在扩展页点一次保存即失效，而模型自行编写的那份自落盘起从未载入。
    // 传 `[]` 仍表示清空既有收窄：省略该行表达的正是不再收窄。
    if (input.allowedTools.length) data["allowed-tools"] = input.allowedTools;
    if (input.requiresTools.length)
      data["requires-tools"] = input.requiresTools;
    if (input.model) data.model = input.model;
    const raw = matter.stringify(`${input.body.trim()}\n`, data);
    const temporary = join(directory, `.SKILL.md.${process.pid}.tmp`);
    writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    this.scan();
    const written = this.#skills.get(name);
    if (!written || written.loadError)
      throw new Error(written?.loadError ?? "skill_write_failed");
    return this.read(name)!;
  }

  /**
   * @param availableTools 本轮实际可用的工具名。提供时按 `requires-tools` 过滤；缺省时
   *   （除 WebUI 预览外无此类调用点）不过滤 —— 少一个参数不应使整份目录消失。
   */
  catalog(
    role: Role,
    availableTools?: readonly string[],
  ): Array<{ name: string; description: string }> {
    const available = availableTools ? new Set(availableTools) : null;
    return [...this.#skills.values()]
      .filter(
        (skill) =>
          skill.enabled &&
          !skill.loadError &&
          roleRank(role) >= roleRank(skill.minRole),
      )
      .filter(
        (skill) =>
          !available ||
          !skill.requiresTools ||
          skill.requiresTools.every((tool) => available.has(tool)),
      )
      .map(({ name, description }) => ({ name, description }));
  }

  load(name: string, role: Role, roleTools: string[]): Record<string, unknown> {
    const skill = this.#skills.get(name);
    if (!skill || !skill.enabled || skill.loadError)
      return { ok: false, error: `Skill 不存在或已禁用: ${name}` };
    if (roleRank(role) < roleRank(skill.minRole))
      return { ok: false, error: "权限不足" };
    // 目录已按 `requires-tools` 过滤过一次，此处再拦一次：模型可凭上一轮记住的名字
    // 直接调用 `load_skill`（与 `admit()` 中目录过滤不构成边界同理）。
    const missing = (skill.requiresTools ?? []).filter(
      (tool) => !roleTools.includes(tool),
    );
    if (missing.length)
      return {
        ok: false,
        error: "skill_requires_unavailable_tools",
        hint: `${name} 描述 ${missing.join(" / ")} 的用法，本轮不可用的原因应为该工具已在设置中禁用，暂不要按其说明操作。`,
      };
    // 同 `scan()`：判据是列表非空而非真值。空列表走 `null` 分支（即不收窄），
    // 否则会被下方空交集的拒绝一并拒掉 —— 而它未声明任何工具，调整配置也无法恢复。
    const narrowed = skill.allowedTools?.length
      ? roleTools.filter((tool) => skill.allowedTools!.includes(tool))
      : null;
    // 交集为空表示该 skill 声明的工具本轮全部不可用，此时必须使载入失败而非返回空集：
    // 下游把空集并入 `turn.skillAllowedTools` 后，`admit()` 的判据是 `skillAllowedTools?.size &&`
    // —— size 0 为 falsy，整条收窄被跳过，收窄到零个工具在运行时等同于完全不收窄，
    // 一个 `allowed-tools: [nonexistent]` 的 skill 反而获得该角色的全部工具。
    if (narrowed !== null && narrowed.length === 0)
      return {
        ok: false,
        error: "skill_tools_unavailable",
        hint: `${name} 声明的 allowed-tools 本轮全部不可用（${skill.allowedTools!.join(" / ")}），请改用其他方式，或先由运维启用这些工具。`,
      };
    // `narrows` 必须单独返回：未声明 `allowed-tools` 的 skill 不收窄（docs/07 §4），而
    // `allowedTools` 在该档等于当前全部可用工具。调用方若无法区分二者，就会将其并入
    // 本轮允许集 —— 后续载入一个未声明的 skill 会抹掉前一个 skill 的收窄。
    return {
      ok: true,
      name,
      body: skill.body,
      dir: skill.dir,
      files: skill.files,
      allowedTools: narrowed ?? roleTools,
      narrows: narrowed !== null,
      modelSuggestion: skill.model ?? null,
    };
  }

  resolveResource(uri: string, role: Role): string {
    const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw new Error("invalid_skill_uri");
    const [, name, relativePath] = match;
    const skill = this.#skills.get(name!);
    if (!skill || !skill.enabled || skill.loadError)
      throw new Error("skill_unavailable");
    if (roleRank(role) < roleRank(skill.minRole))
      throw new Error("skill_forbidden");
    const path = resolve(skill.dir, relativePath!);
    const root = resolve(skill.dir);
    if (path !== root && !path.startsWith(`${root}${sep}`))
      throw new Error("path_outside_skill");
    return path;
  }

  /**
   * `source` 此前是无效列：schema 中存在、此处从不写入、WebUI 从不读取，因而每行都是默认值
   * `local`，界面无法区分随包发布的说明文档、安装的包与手写的 skill。旧取值 `plugin` 从未有过
   * 写入方（plugin 不贡献 skill），一并替换（docs/03 §2.10）。
   */
  private sourceOf(name: string): string {
    if ((BUNDLED_SKILLS as readonly string[]).includes(name)) return "bundled";
    return existsSync(join(this.directory, name, SKILL_PACKAGE_MARKER))
      ? "package"
      : "local";
  }

  private persist(
    skill: SkillDefinition,
    path: string,
    raw: string,
    frontmatter: unknown,
  ): void {
    const hash = createHash("sha256").update(raw).digest("hex");
    this.db
      .prepare(
        `INSERT INTO skills(name,path,description,min_role,allowed_tools_json,model_alias,enabled,source,content_hash,frontmatter_json,load_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path,description=excluded.description,min_role=excluded.min_role,
      allowed_tools_json=excluded.allowed_tools_json,model_alias=excluded.model_alias,enabled=excluded.enabled,source=excluded.source,content_hash=excluded.content_hash,
      frontmatter_json=excluded.frontmatter_json,load_error=excluded.load_error,updated_at=excluded.updated_at`,
      )
      .run(
        skill.name,
        path,
        skill.description,
        skill.minRole,
        skill.allowedTools ? JSON.stringify(skill.allowedTools) : null,
        skill.model ?? null,
        skill.enabled ? 1 : 0,
        this.sourceOf(skill.name),
        hash,
        JSON.stringify(frontmatter),
        skill.loadError ?? null,
        Date.now(),
      );
  }
}
