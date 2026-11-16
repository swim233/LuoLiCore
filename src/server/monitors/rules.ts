// 监视任务的描述（ADR-0014）的规则，只在这里写一份：字段表、比法表、上限。描述的校验、试跑的工具、
// 元文档里的 {{fields}}、{{ops}}、{{limits}} 都从这里取，改了规则，文档跟着变

/** 上限 */
export const monitorLimits = {
  /** interval_minutes 最长多少分钟（7 天） */
  maxIntervalMinutes: 10_080,
  /** show 最多几个路径 */
  maxShow: 12,
  /** all、any 最多套几层 */
  maxDepth: 4,
  /** 一个 where 里最多几个比较 */
  maxComparisons: 20,
  /** in 的 value 最多几个值 */
  maxInValues: 50,
  /** where 里字符串的 value 最多几个字 */
  maxValueChars: 200,
  /** 路径最多几个字 */
  maxPathChars: 200,
  /** 一次查到的条目最多处理几条 */
  maxItems: 500,
  /** 条目写成文字时，每个值最多几个字 */
  maxShownChars: 1000,
} as const;

const limits = monitorLimits;

/** 描述的字段，按这个先后：yes 必填；task 建任务时必填，试跑时可以不写；no 可以不写 */
export const monitorFields = [
  { name: 'service', required: 'yes', text: '服务名，见 read_docs 的说明里「现在能用的服务」' },
  { name: 'endpoint', required: 'yes', text: '接口 id，服务的文档里写着' },
  {
    name: 'params',
    required: 'no',
    text: '接口的参数，写法同 call_service（路径参数和查询参数都写在这里，值是字符串、数字或布尔值）',
  },
  {
    name: 'interval_minutes',
    required: 'task',
    text: `多久查一次，整数分钟；不能短于这个服务的最短间隔，最长 ${limits.maxIntervalMinutes}（7 天）`,
  },
  {
    name: 'items',
    required: 'yes',
    text: '条目在哪，也就是返回里那个列表的路径；返回本身就是列表时写空字符串',
  },
  {
    name: 'key',
    required: 'yes',
    text: '每条里当编号用的字段的路径，用来认新旧（没见过的编号就是新的）；那个值要是字符串或数字',
  },
  { name: 'where', required: 'no', text: '只要哪些，一个条件；不写就是全都要' },
  { name: 'title', required: 'yes', text: '每条的标题用哪个字段（路径）' },
  {
    name: 'show',
    required: 'yes',
    text: `到点时写进事件、给你看的字段，1 到 ${limits.maxShow} 个路径`,
  },
  {
    name: 'mode',
    required: 'task',
    text: '处理方式，reply 触发你回复一次，record 只写进会话、不触发你',
  },
] as const satisfies ReadonlyArray<{
  name: string;
  required: 'yes' | 'task' | 'no';
  text: string;
}>;

export type MonitorField = (typeof monitorFields)[number]['name'];

/** 「必填」那一列的说法 */
export const requiredText = {
  yes: '必填',
  task: '建任务时必填，试跑时可以不写',
  no: '可以不写',
} as const;

const compareRule =
  '两边都能当成数字时按数字比（写成字符串的数字，如 "12"，也算）；不然两边都是字符串时按字典序比（同一种格式的时间可以这样比）；别的情况不成立';

/** 比法 */
export const monitorOps = [
  {
    op: 'eq',
    name: '等于',
    rule: '字段的值和 value 按文字比，数字、布尔值、字符串都行（200 等于 "200"），分大小写；没有这个字段时不成立',
  },
  { op: 'ne', name: '不等于', rule: '和 eq 相反；没有这个字段时成立' },
  {
    op: 'in',
    name: '是这几个值之一',
    rule: `value 写成数组（1 到 ${limits.maxInValues} 个值），和其中任何一个 eq 就成立`,
  },
  { op: 'gt', name: '大于', rule: compareRule },
  { op: 'gte', name: '大于等于', rule: compareRule },
  { op: 'lt', name: '小于', rule: compareRule },
  { op: 'lte', name: '小于等于', rule: compareRule },
  {
    op: 'contains',
    name: '包含',
    rule: '字段是字符串时看里面有没有 value 这段字，不分大小写；字段是列表时看有没有一个元素和 value eq；别的情况不成立',
  },
] as const satisfies ReadonlyArray<{ op: string; name: string; rule: string }>;

export type MonitorOp = (typeof monitorOps)[number]['op'];

/** 元文档里 {{fields}}：每个字段一行 */
export function fieldsText(): string {
  return monitorFields
    .map(({ name, required, text }) => `- ${name}（${requiredText[required]}）：${text}`)
    .join('\n');
}

/** 元文档里 {{ops}}：每个比法一行 */
export function opsText(): string {
  return monitorOps.map(({ op, name, rule }) => `- ${op}（${name}）：${rule}`).join('\n');
}

/** 元文档里 {{limits}}：层数、个数这些上限 */
export function limitsText(): string {
  return [
    '上限：',
    `- all、any 最多套 ${limits.maxDepth} 层（\`{ "all": [ { "any": [ … ] } ] }\` 算 2 层），里面至少要有一个条件。`,
    `- 一个 where 里的比较（写着 field、op、value 的那种）总共最多 ${limits.maxComparisons} 个。`,
    `- value 只能是字符串、数字或布尔值，字符串最多 ${limits.maxValueChars} 个字；in 的 value 是 1 到 ${limits.maxInValues} 个这样的值组成的数组。gt、gte、lt、lte 的 value 不能是布尔值，contains 的 value 不能是空的字符串。`,
    `- 路径最多 ${limits.maxPathChars} 个字，每一段都不能是空的，不支持数组下标（如 \`alerts[0]\`）。`,
    `- show 写 1 到 ${limits.maxShow} 个路径；interval_minutes 最长 ${limits.maxIntervalMinutes}（7 天）。`,
    `- 一次查到的条目最多处理 ${limits.maxItems} 条，多出来的不要；写进事件的每个值最多 ${limits.maxShownChars} 个字，超出的截短。`,
  ].join('\n');
}
