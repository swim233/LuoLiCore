// 监听任务的描述（ADR-0014）的规则，只在这里写一份：字段表、比法表、上限。描述的校验、试跑的工具、
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
  /** 到点的事件里最多写几条的内容，其余只列标题 */
  maxEventItems: 5,
  /** 整条事件最多几个字，写不下时从后面的条目起改成只列标题 */
  maxEventChars: 6000,
} as const;

const limits = monitorLimits;

/** 描述的字段，按这个先后：yes 必填；task 建任务时必填，试跑时可以不写；no 可以不写 */
export const monitorFields = [
  { name: 'service', required: 'yes', text: '服务名，见 read_docs 工具说明里的「当前可用服务」' },
  { name: 'endpoint', required: 'yes', text: '接口 id（详见服务的文档）' },
  {
    name: 'params',
    required: 'no',
    text: '接口的参数，写法同 call_service（路径参数和查询参数都写在这里，值是字符串、数字或布尔值）',
  },
  {
    name: 'interval_minutes',
    required: 'task',
    text: `监听间隔，单位分钟，整数；不得小于此服务的最短间隔，最长 ${limits.maxIntervalMinutes}（7 天）`,
  },
  {
    name: 'items',
    required: 'yes',
    text: '条目列表在返回数据中的路径；返回数据本身就是列表时填空字符串',
  },
  {
    name: 'key',
    required: 'yes',
    text: '每个条目中用作编号的字段的路径，用于判断新旧（未出现过的编号即为新条目）；其值须为字符串或数字',
  },
  {
    name: 'where',
    required: 'no',
    text: '监听范围：一个条件，仅符合条件的新条目才触发；未填写时所有新条目都触发',
  },
  { name: 'title', required: 'yes', text: '用作条目标题的字段（路径）' },
  {
    name: 'show',
    required: 'yes',
    text: `触发时写入事件的字段，填 1 到 ${limits.maxShow} 个路径`,
  },
  {
    name: 'mode',
    required: 'task',
    text: '处理方式：reply 触发你回复一次；record 仅写入会话，不触发回复',
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
  task: '创建任务时必填，测试时可选',
  no: '可选',
} as const;

const compareRule =
  '两边都能当作数字时按数值比较（写成字符串的数字，如 "12"，也算）；否则两边都是字符串时按字典序比较（格式相同的时间可以这样比较）；其他情况不成立';

/** 比法 */
export const monitorOps = [
  {
    op: 'eq',
    name: '等于',
    rule: '字段的值与 value 按文本比较，数字、布尔值、字符串均可（200 等于 "200"），区分大小写；字段不存在时不成立',
  },
  { op: 'ne', name: '不等于', rule: '与 eq 相反；字段不存在时成立' },
  {
    op: 'in',
    name: '是这几个值之一',
    rule: `value 填数组（1 到 ${limits.maxInValues} 个值），字段的值与其中任意一个 eq 即成立`,
  },
  { op: 'gt', name: '大于', rule: compareRule },
  { op: 'gte', name: '大于等于', rule: compareRule },
  { op: 'lt', name: '小于', rule: compareRule },
  { op: 'lte', name: '小于等于', rule: compareRule },
  {
    op: 'contains',
    name: '包含',
    rule: '字段为字符串时，判断其中是否包含 value 这段文本，不区分大小写；字段为列表时，判断是否有元素与 value eq；其他情况不成立',
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

/** 元文档里 {{limits}}：层数、个数这些上限（元文档里它单独一节，有自己的标题） */
export function limitsText(): string {
  return [
    `- all、any 最多嵌套 ${limits.maxDepth} 层（\`{ "all": [ { "any": [ … ] } ] }\` 算 2 层），其中至少包含一个条件。`,
    `- 一个 where 中的比较（含 field、op、value 的条件）总数最多 ${limits.maxComparisons} 个。`,
    `- value 只能是字符串、数字或布尔值，字符串最多 ${limits.maxValueChars} 个字；in 的 value 是 1 到 ${limits.maxInValues} 个此类值组成的数组。gt、gte、lt、lte 的 value 不能是布尔值，contains 的 value 不能是空字符串。`,
    `- 路径最多 ${limits.maxPathChars} 个字，每一段都不能为空，不支持数组下标（如 \`alerts[0]\`）。`,
    `- show 填 1 到 ${limits.maxShow} 个路径；interval_minutes 最长 ${limits.maxIntervalMinutes}（7 天）。`,
    `- 每次请求最多处理 ${limits.maxItems} 个条目，超出的丢弃；写入事件的每个值最多 ${limits.maxShownChars} 个字，超出的部分截断。`,
    `- 一次新条目较多时，触发的事件里只写前 ${limits.maxEventItems} 条的内容，其余仅列标题；整条事件最多 ${limits.maxEventChars} 个字，超出时从靠后的条目起改为仅列标题。`,
  ].join('\n');
}
