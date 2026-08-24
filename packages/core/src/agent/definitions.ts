import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { AgentDefinition } from "./manager.js";

/**
 * `agents/<name>.md` —— 子 agent 的文件定义（docs/14 §2 Q5，2026-08-18 拍板要做）。
 *
 * A8 原本把子 agent 定死成配置数据（YAML + WebUI）。文件定义的价值不在「另一种写法」，而在
 * **可以 git 版本化**、可以直接抄 Claude Code 生态里现成的定义。
 *
 * 两个来源的优先级**写死**、不做成配置项：文件是只读来源，`agent.agents`（DB / WebUI）里的
 * 同名定义覆盖它。两个来源静默打架比只有一个来源糟得多 —— 谁赢必须是一句话能说清的。
 */

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 与 `agent.agents` 的 zod 默认值保持一致：改了那边这里要跟着改，否则同一个 agent 两种写法行为不同。 */
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
  /** 解析失败的文件。**调用方必须把它报出去** —— 一个写错 frontmatter 的 agent 悄悄不存在，
   *  表现是「我明明加了这个 agent，模型说没有」，比启动失败难查得多（Q5-c）。 */
  errors: AgentFileError[];
}

/** 目录不存在 = 没有文件定义，不是错误（这个特性默认没人用）。 */
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
      // 名字必须等于文件名：否则 `agents/researcher.md` 里写着 `name: coder` 的那份定义，
      // 谁都对不上号（skills 的 SKILL.md 是同一条规矩）。
      if (meta.name !== stem)
        throw new Error(
          `frontmatter name "${meta.name}" must equal file name "${stem}"`,
        );
      const instructions = parsed.content.trim();
      if (!instructions)
        throw new Error("body is empty — 正文就是这个 agent 的 instructions");
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
 * 文件定义在前、配置定义在后，**同名时配置赢**（Q5-a）。返回的顺序是「文件的按名字排，
 * 然后是只在配置里出现的」—— 稳定顺序让 `list_agents` 的输出不会因为加了一个文件而整体重排。
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

/** 哪些名字来自文件（供 WebUI 标「来自文件」并置灰编辑）。被配置覆盖掉的仍然算 —— 那一行两边都有。 */
export function agentFileNames(
  fromFiles: readonly AgentDefinition[],
): string[] {
  return fromFiles.map((definition) => definition.name);
}
