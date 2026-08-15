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
