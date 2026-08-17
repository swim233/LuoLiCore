import { minimatch } from 'minimatch';
import type { RegisteredTool, ToolExecutionContext } from '../tools/registry.js';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalDecision {
  needed: boolean;
  risk: ApprovalRisk;
}

interface ApprovalRule {
  tool: string | string[];
  pattern?: string;
  when?: 'target_exists';
  always?: boolean;
  risk?: ApprovalRisk;
}

function compilePattern(source: string): RegExp | null {
  try {
    const insensitive = source.startsWith('(?i)');
    return new RegExp(insensitive ? source.slice(4) : source, insensitive ? 'i' : undefined);
  } catch {
    return null;
  }
}

function isRule(value: unknown): value is ApprovalRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.tool === 'string' || (Array.isArray(rule.tool) && rule.tool.every((item) => typeof item === 'string'));
}

export class ApprovalRules {
  readonly #rules: Array<{ rule: ApprovalRule; pattern: RegExp | null }>;
  /** 试跑要按同一份编译结果逐条报告命中原因；`evaluate` 只回最终判定，说不出「为什么没命中」。 */
  get compiled(): ReadonlyArray<{ rule: ApprovalRule; pattern: RegExp | null }> { return this.#rules; }

  constructor(rules: readonly unknown[]) {
    this.#rules = rules.filter(isRule).map((rule) => ({ rule, pattern: rule.pattern ? compilePattern(rule.pattern) : null }));
  }

  evaluate(tool: RegisteredTool, input: unknown, context: ToolExecutionContext): ApprovalDecision {
    let decision: ApprovalDecision = { needed: false, risk: 'low' };
    for (const compiled of this.#rules) {
      const names = Array.isArray(compiled.rule.tool) ? compiled.rule.tool : [compiled.rule.tool];
      if (!names.some((name) => minimatch(tool.name, name))) continue;
      if (compiled.rule.pattern && (!compiled.pattern || !compiled.pattern.test(JSON.stringify(input)))) continue;
      if (compiled.rule.when === 'target_exists' && tool.approvalTargetExists?.(input, context) !== true) continue;
      const risk = compiled.rule.risk ?? 'medium';
      decision = { needed: true, risk: riskRank(risk) > riskRank(decision.risk) ? risk : decision.risk };
    }
    return decision;
  }
}

function riskRank(risk: ApprovalRisk): number {
  return risk === 'high' ? 2 : risk === 'medium' ? 1 : 0;
}

/**
 * 规则试跑：拿一条样例输入过一遍规则表，逐条回报命中与否和**为什么没命中**。
 * 与 `evaluate` 共用 `#rules` 的编译结果（同一个 `ApprovalRules` 实例），所以界面上看到的
 * 判定就是运行时的判定 —— 在前端再实现一份匹配必然漂移，而「以为配了审批其实永不命中」
 * 正是这条配置最容易出的错（docs/09 §3.7）。
 *
 * `when: 'target_exists'` 在试跑里一律记成「取决于运行时」：它要问工具「这个目标现在存在吗」，
 * 而试跑没有真实的执行上下文。含糊其辞比编一个答案好。
 */
export function testApprovalRules(rules: readonly unknown[], toolName: string, input: unknown):
{ needed: boolean; risk: ApprovalRisk; runtimeDependent: boolean; rules: Array<{ index: number; matched: boolean; reason: string }> } {
  const compiled = new ApprovalRules(rules);
  const serialized = JSON.stringify(input);
  const report: Array<{ index: number; matched: boolean; reason: string }> = [];
  let risk: ApprovalRisk = 'low';
  let needed = false;
  let runtimeDependent = false;
  for (const [index, entry] of compiled.compiled.entries()) {
    const names = Array.isArray(entry.rule.tool) ? entry.rule.tool : [entry.rule.tool];
    if (!names.some((name) => minimatch(toolName, name))) { report.push({ index, matched: false, reason: `工具名不匹配（${names.join(' / ')}）` }); continue; }
    if (entry.rule.pattern && !entry.pattern) { report.push({ index, matched: false, reason: '正则编译失败，这条规则在运行时永不命中' }); continue; }
    if (entry.rule.pattern && !entry.pattern!.test(serialized)) { report.push({ index, matched: false, reason: `正则不匹配输入 ${serialized.slice(0, 120)}` }); continue; }
    if (entry.rule.when === 'target_exists') {
      runtimeDependent = true;
      report.push({ index, matched: true, reason: '命中，但最终是否需要审批取决于运行时「目标是否存在」' });
    } else report.push({ index, matched: true, reason: '命中' });
    needed = true;
    const entryRisk = entry.rule.risk ?? 'medium';
    if (riskRank(entryRisk) > riskRank(risk)) risk = entryRisk;
  }
  return { needed, risk, runtimeDependent, rules: report };
}
