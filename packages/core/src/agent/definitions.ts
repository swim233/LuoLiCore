import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { AgentDefinition } from "./manager.js";

/**
 * `agents/<name>.md`：子 agent 的文件定义（docs/14 §2 Q5，2026-08-18 决定实现）。
 *
 * A8 原本把子 agent 固定为配置数据（YAML 加 WebUI）。文件定义的价值不在于多一种写法，而在于
 * 可纳入 git 版本管理、可直接复用 Claude Code 生态中的现成定义。
 *
 * 两个来源的优先级固定写死、不做成配置项：文件是只读来源，`agent.agents`（DB 与 WebUI）中的
 * 同名定义覆盖它。两个来源静默冲突远比只有一个来源更糟，优先级必须能一句话说清。
 */

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 与 `agent.agents` 的 zod 默认值保持一致：那边变更时此处同步，否则同一个 agent 的两种写法行为不同。 */
const frontmatterSchema = z.object({
  name: z.string().regex(NAME),
  description: z.string().min(1).max(500),
  model: z.string().default("low"),
  "max-steps": z.number().int().positive().default(8),
  "min-role": z
    .enum(["blocked", "limited", "trusted", "owner"])
    .default("limited"),
  tools: z.array(z.string()).default([]),
  "result-max-chars": z.number().int().positive().default(4000),
  "inject-memory": z.boolean().default(false),
});

export interface AgentFileError {
  file: string;
  error: string;
}
export interface AgentFileScan {
  definitions: AgentDefinition[];
  /** 解析失败的文件。调用方必须上报：frontmatter 写错的 agent 静默不存在时，
   *  表现为已添加的 agent 在模型侧不可见，比启动失败更难排查（Q5-c）。 */
  errors: AgentFileError[];
}

/** 目录不存在表示没有文件定义，不属于错误（该特性默认不启用）。 */
export function scanAgentFiles(directory: string): AgentFileScan {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { definitions: [], errors: [] };
    throw error;
  }

  const definitions: AgentDefinition[] = [];
  const errors: AgentFileError[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const path = join(directory, entry);
    const stem = entry.slice(0, -3);
    try {
      const parsed = matter(readFileSync(path, "utf8"));
      const meta = frontmatterSchema.parse(parsed.data);
      // 名字必须等于文件名：否则 `agents/researcher.md` 中写着 `name: coder` 的定义
      // 无法与任何一侧对应（skills 的 SKILL.md 遵循同一规则）。
      if (meta.name !== stem)
        throw new Error(
          `frontmatter name "${meta.name}" must equal file name "${stem}"`,
        );
      const instructions = parsed.content.trim();
      if (!instructions)
        throw new Error("body is empty — 正文即该 agent 的 instructions");
      definitions.push({
        name: meta.name,
        description: meta.description,
        modelAlias: meta.model,
        maxSteps: meta["max-steps"],
        minRole: meta["min-role"],
        tools: meta.tools,
        resultMaxChars: meta["result-max-chars"],
        instructions,
        injectMemory: meta["inject-memory"],
      });
    } catch (error) {
      errors.push({
        file: path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { definitions, errors };
}

/**
 * 文件定义在前、配置定义在后，同名时配置优先（Q5-a）。返回顺序为文件定义按名称排序，
 * 其后是仅出现在配置中的定义；稳定顺序使 `list_agents` 的输出不会因新增一个文件而整体重排。
 */
export function mergeAgentDefinitions(
  fromFiles: readonly AgentDefinition[],
  fromConfig: readonly AgentDefinition[],
): AgentDefinition[] {
  const overrides = new Map(
    fromConfig.map((definition) => [definition.name, definition]),
  );
  const merged = fromFiles.map(
    (definition) => overrides.get(definition.name) ?? definition,
  );
  const seen = new Set(merged.map((definition) => definition.name));
  return [
    ...merged,
    ...fromConfig.filter((definition) => !seen.has(definition.name)),
  ];
}

/** 哪些名称来自文件（供 WebUI 标注来源为文件并禁用编辑）。被配置覆盖的仍然计入，因为该条目两侧都存在。 */
export function agentFileNames(
  fromFiles: readonly AgentDefinition[],
): string[] {
  return fromFiles.map((definition) => definition.name);
}
