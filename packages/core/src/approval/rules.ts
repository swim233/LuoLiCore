import { minimatch } from 'minimatch';
import { RE2 } from 're2-wasm';
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

/**
 * 上界与 `checkWakeword` 对齐（`config/wakeword.ts`）。求值对象是模型给的工具参数，
 * 长模式在 RE2 下也要多花编译时间，而审批规则从来不需要一条 128 字符以上的正则。
 */
export const APPROVAL_PATTERN_MAX_CHARS = 128;
/**
 * **RE2 而不是 `new RegExp`。** `pattern` 来自配置（owner 面），但求值对象是模型/用户内容：
 * 一条形状不巧的规则（`(a+)+`、`(\w+\s?)*$`）撞上一段合适的输入就是指数回溯，而这是单线程
 * 进程 —— 卡住的是整个 bot（所有会话的轮次、WebUI、SSE 心跳）。同一条教训在 `grep`
 * （docs/19 · T-TOOL-01）与唤醒词（`config/wakeword.ts`）两处都已经换成 RE2，这里是最后一处
 * （docs/27 · S-03）。`(?i)` 前缀 RE2 原生支持，所以不再自己剥。
 */
export function compilePattern(source: string): RE2 | null {
  if ([...source].length > APPROVAL_PATTERN_MAX_CHARS) return null;
  try { return new RE2(source, 'u'); } catch { return null; }
}
/**
 * 写入端校验（`configSchema` 的 `approvalRuleSchema`）用的判据，与 `compilePattern` 共用一份实现：
 * 分成两份必然漂移，而漂移的表现是面板收下一条运行时永不命中的规则 —— 门看着是关的，其实开着。
 */
export function checkApprovalPattern(source: string): { ok: true } | { ok: false; reason: string } {
  if ([...source].length > APPROVAL_PATTERN_MAX_CHARS) return { ok: false, reason: `超过 ${APPROVAL_PATTERN_MAX_CHARS} 个字符` };
  try { new RE2(source, 'u'); return { ok: true }; }
  catch (error) { return { ok: false, reason: `不是 RE2 兼容正则：${error instanceof Error ? error.message : String(error)}` }; }
}

function isRule(value: unknown): value is ApprovalRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.tool === 'string' || (Array.isArray(rule.tool) && rule.tool.every((item) => typeof item === 'string'));
}

export class ApprovalRules {
  readonly #rules: Array<{ rule: ApprovalRule; pattern: RE2 | null }>;
  /** 试跑要按同一份编译结果逐条报告命中原因；`evaluate` 只回最终判定，说不出「为什么没命中」。 */
  get compiled(): ReadonlyArray<{ rule: ApprovalRule; pattern: RE2 | null }> { return this.#rules; }

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
