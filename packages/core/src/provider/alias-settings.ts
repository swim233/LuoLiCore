import { z } from 'zod';

/**
 * 别名采样参数白名单（docs/04 §5.2.1）。写入端点与 ModelRegistry 共用这一份：
 * 白名单外的键在 PUT 时就报错，不能让人以为写进去了、其实运行时被丢掉。
 * 字段名与 AI SDK 的 LanguageModelCallOptions 对齐，才能整份摊进 prepareStep 的返回值。
 */
export const aliasSettingsSchema = z.object({
  temperature: z.number().min(0, '不能小于 0').max(2, '不能大于 2').optional(),
  topP: z.number().min(0, '不能小于 0').max(1, '不能大于 1').optional(),
  topK: z.number().int('必须是整数').min(1, '至少为 1').optional(),
  maxOutputTokens: z.number().int('必须是整数').min(1, '至少为 1').optional(),
  reasoning: z.enum(['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  presencePenalty: z.number().min(-1, '不能小于 -1').max(1, '不能大于 1').optional(),
  frequencyPenalty: z.number().min(-1, '不能小于 -1').max(1, '不能大于 1').optional(),
  stopSequences: z.array(z.string().min(1, '不能是空字符串')).max(8, '最多 8 条').optional(),
  seed: z.number().int('必须是整数').optional(),
}).strict();

/** zod 推出来的可选属性带 `| undefined`，在 exactOptionalPropertyTypes 下摊不进 AI SDK 的调用选项。 */
type ParsedAliasSettings = z.infer<typeof aliasSettingsSchema>;
export type AliasSettings = { [K in keyof ParsedAliasSettings]?: NonNullable<ParsedAliasSettings[K]> };

/** 别名名同时是 URL path 段和模型的 `/model <alias>` 参数，控制在保守字符集内。 */
export const ALIAS_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const BUILTIN_ALIASES = [
  { alias: 'main', purpose: '主 Agent 的默认模型，日常对话都走它', tier: '中高档，对话质量优先' },
  { alias: 'high', purpose: '复杂推理、代码类子 agent', tier: '最强模型' },
  { alias: 'low', purpose: '批量归纳、摘要、记忆压缩，以及超过 downgradeAfterStep 后的自动降档', tier: '最便宜可用' },
  { alias: 'vision', purpose: '含图片的轮次；当前模型不支持看图时自动切到这里', tier: '支持 vision' },
  { alias: 'title', purpose: '生成任务标题、会话摘要', tier: '最便宜' },
  { alias: 'embed', purpose: '（预留）向量检索，目前没有代码路径使用', tier: 'embedding 模型' },
] as const;

/** 解析落库的 `settings_json`；写入端点已经挡过一道，这里解析不出来就当没配。 */
export function parseAliasSettings(json: string | null): AliasSettings | null {
  if (!json) return null;
  try {
    const parsed = aliasSettingsSchema.safeParse(JSON.parse(json) as unknown);
    // zod 的输出里不存在的键是真的不存在，只是类型上带了 `| undefined`。
    return parsed.success ? parsed.data as AliasSettings : null;
  } catch { return null; }
}

/** 落库前把空值抹掉：留空 = 不下发该字段，而不是下发一个 0 或空数组。 */
export function pruneAliasSettings(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) =>
    value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)));
}
