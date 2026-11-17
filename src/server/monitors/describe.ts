import { ServiceError, type ServiceLayer } from '../services/layer.js';
import { monitorFields, monitorLimits, monitorOps, type MonitorOp } from './rules.js';

// 监听任务的描述（ADR-0014）：洛璃写的一份数据。这里是它的样子和「静态」的检查（不发请求）：
// 字段齐不齐、服务装没装、接口有没有、参数过不过得了服务层的检查、间隔够不够长、路径和条件的写法。
// 规则（字段表、比法表、上限）在 rules.ts

/** 条件里的值 */
export type Scalar = string | number | boolean;

/** 一个比较：字段（路径）、比法、值（in 是数组） */
export type Comparison = { field: string; op: MonitorOp; value: Scalar | Scalar[] };

/** 条件：一个比较；或者 all（都要满足）、any（满足一个就行），可以互相套 */
export type Condition = Comparison | { all: Condition[] } | { any: Condition[] };

/** 处理方式：reply 触发回复，record 只记录，decide 触发回复、由洛璃判断说不说（不说时回约定的标记） */
export type MonitorMode = 'reply' | 'record' | 'decide';

/** 一份检查过的描述，字段按 rules.ts 的先后，只有认得的字段 */
export type MonitorDescription = {
  service: string;
  endpoint: string;
  params?: Record<string, Scalar>;
  interval_minutes?: number;
  items: string;
  key: string;
  where?: Condition;
  title: string;
  show: string[];
  mode?: MonitorMode;
};

/** 用途：试跑时 interval_minutes、mode 可以不写（写了照样检查）；建任务时必填 */
export type MonitorPurpose = 'try' | 'task';

export type CheckResult =
  { ok: true; monitor: MonitorDescription } | { ok: false; problems: string[] };

const fieldNames: readonly string[] = monitorFields.map(({ name }) => name);
const opNames: readonly string[] = monitorOps.map(({ op }) => op);
const limits = monitorLimits;

/**
 * 检查一份描述，不发请求。问题都列出来（哪个字段、哪里不对、该怎么写），她靠它改。
 * services 是服务层：服务、接口、参数交给它的 check；间隔按服务的最短间隔（向上取整到分钟）
 */
export function checkMonitor(
  input: unknown,
  {
    services,
    purpose,
  }: { services: Pick<ServiceLayer, 'services' | 'check'>; purpose: MonitorPurpose },
): CheckResult {
  if (!isPlainObject(input)) {
    return { ok: false, problems: ['monitor 须为对象，各字段的写法见 read_docs 的 monitor'] };
  }
  const problems: string[] = [];
  const problem = (text: string) => problems.push(text);

  for (const name of Object.keys(input)) {
    if (!fieldNames.includes(name)) {
      problem(`monitor 不支持字段 ${name}（可用的字段：${fieldNames.join('、')}）`);
    }
  }
  for (const { name, required, text } of monitorFields) {
    const missing = input[name] === undefined;
    if (missing && (required === 'yes' || (required === 'task' && purpose === 'task'))) {
      problem(`缺少 ${name}${required === 'task' ? '（创建任务时必填）' : ''}：${text}`);
    }
  }

  // 服务、接口、参数：交给服务层检查，说明和 call_service 的一样
  const { service, endpoint, params } = input;
  if (service !== undefined && typeof service !== 'string') problem('service 须为字符串：服务名');
  if (endpoint !== undefined && typeof endpoint !== 'string') {
    problem('endpoint 须为字符串：接口 id');
  }
  if (typeof service === 'string' && typeof endpoint === 'string') {
    try {
      services.check(service, endpoint, params ?? {});
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      problem(error.message);
    }
  }

  const interval = input.interval_minutes;
  if (interval !== undefined) {
    const info = services.services.find(({ name }) => name === service);
    const shortest = info ? Math.max(1, Math.ceil(info.minIntervalSeconds / 60)) : 1;
    if (typeof interval !== 'number' || !Number.isInteger(interval)) {
      problem('interval_minutes 须为整数（分钟）');
    } else if (interval < shortest) {
      problem(
        info
          ? `interval_minutes 不得小于 ${shortest} 分钟（服务 ${info.name} 的最短间隔）`
          : `interval_minutes 至少为 ${shortest} 分钟`,
      );
    } else if (interval > limits.maxIntervalMinutes) {
      problem(`interval_minutes 最长 ${limits.maxIntervalMinutes}（7 天）`);
    }
  }

  const items = input.items;
  if (items !== undefined) {
    if (typeof items !== 'string') {
      problem('items 须为字符串：条目列表在返回数据中的路径，返回数据本身就是列表时填空字符串');
    } else if (items !== '') {
      checkPath(items, 'items', problem);
    }
  }
  for (const name of ['key', 'title'] as const) {
    if (input[name] !== undefined) checkPath(input[name], name, problem);
  }

  const show = input.show;
  if (show !== undefined) {
    if (!Array.isArray(show) || show.length === 0 || show.length > limits.maxShow) {
      problem(`show 须为 1 到 ${limits.maxShow} 个路径组成的数组`);
    } else {
      show.forEach((path, index) => checkPath(path, `show[${index}]`, problem));
      const repeated = show.find((path, index) => show.indexOf(path) !== index);
      if (repeated !== undefined) problem(`show 中「${String(repeated)}」重复出现`);
    }
  }

  if (input.where !== undefined) {
    const state = { comparisons: 0, tooDeep: false };
    checkCondition(input.where, 'where', 0, state, problem);
    if (state.tooDeep) problem(`where 嵌套过深：all、any 最多嵌套 ${limits.maxDepth} 层`);
    if (state.comparisons > limits.maxComparisons) {
      problem(
        `where 中的比较过多：最多 ${limits.maxComparisons} 个，当前有 ${state.comparisons} 个`,
      );
    }
  }

  const mode = input.mode;
  if (mode !== undefined && mode !== 'reply' && mode !== 'record' && mode !== 'decide') {
    problem('mode 只能是 reply（触发回复）、record（仅记录）或 decide（自行决定）');
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, monitor: normalize(input) };
}

/** 检查过的输入整理成描述：只留认得的字段，按 rules.ts 的先后 */
function normalize(input: Record<string, unknown>): MonitorDescription {
  const monitor: Record<string, unknown> = {};
  for (const name of fieldNames) {
    const value = input[name];
    if (value === undefined) continue;
    monitor[name] =
      name === 'where'
        ? normalizeCondition(value as Condition)
        : (JSON.parse(JSON.stringify(value)) as unknown);
  }
  return monitor as MonitorDescription;
}

function normalizeCondition(condition: Condition): Condition {
  if ('all' in condition) return { all: condition.all.map(normalizeCondition) };
  if ('any' in condition) return { any: condition.any.map(normalizeCondition) };
  const { field, op, value } = condition;
  return { field, op, value: Array.isArray(value) ? [...value] : value };
}

/** 路径的写法：字符串、不空、不太长，每一段不空，不写数组下标 */
function checkPath(path: unknown, label: string, problem: (text: string) => void): void {
  if (typeof path !== 'string') {
    problem(`${label} 须为字符串：一个路径，如 messageType.code`);
  } else if (path === '') {
    problem(`${label} 不能为空：请填写一个路径，如 messageType.code`);
  } else if ([...path].length > limits.maxPathChars) {
    problem(`${label} 过长：路径最多 ${limits.maxPathChars} 个字`);
  } else if (path.split('.').some((segment) => segment === '')) {
    problem(`${label} 填的是「${path}」：每一段都不能为空（不能以点开头或结尾，不能连续两个点）`);
  } else if (/[[\]]/.test(path)) {
    problem(`${label} 填的是「${path}」：路径不支持数组下标，只能逐层进入对象`);
  }
}

/**
 * 检查一个条件（递归）。at 是它在 where 里的位置，如 where.all[1]；groups 是它外面套了几层
 * all、any。比较的个数、是不是套得太深记在 state 里，由调用方最后各说一次
 */
function checkCondition(
  node: unknown,
  at: string,
  groups: number,
  state: { comparisons: number; tooDeep: boolean },
  problem: (text: string) => void,
): void {
  if (!isPlainObject(node)) {
    problem(
      `${at} 须为对象：单个比较写作 { field, op, value }，多个条件用 { all: [...] } 或 { any: [...] } 组合`,
    );
    return;
  }
  const keys = Object.keys(node);
  const group = keys.includes('all') ? 'all' : keys.includes('any') ? 'any' : undefined;
  if (group) {
    if (keys.length > 1) {
      problem(`${at} 中 all、any 只能填一个，且不能与其他字段同时出现`);
      return;
    }
    if (groups + 1 > limits.maxDepth) {
      state.tooDeep = true;
      return;
    }
    const list = node[group];
    if (!Array.isArray(list) || list.length === 0) {
      problem(`${at}.${group} 须为数组，其中至少一个条件`);
      return;
    }
    list.forEach((child, index) =>
      checkCondition(child, `${at}.${group}[${index}]`, groups + 1, state, problem),
    );
    return;
  }

  state.comparisons++;
  for (const key of keys) {
    if (!['field', 'op', 'value'].includes(key)) {
      problem(
        `${at} 不支持字段 ${key}：单个比较写作 { field, op, value }，多个条件用 all、any 组合`,
      );
    }
  }
  if (node.field === undefined) problem(`${at} 缺少 field：要比较的字段（路径）`);
  else checkPath(node.field, `${at}.field`, problem);

  const op = node.op;
  if (op === undefined) {
    problem(`${at} 缺少 op：比较方式，${opNames.join('、')} 之一`);
  } else if (typeof op !== 'string' || !opNames.includes(op)) {
    problem(`${at}.op 填的是「${String(op)}」：比较方式只有 ${opNames.join('、')}`);
  }

  const value = node.value;
  if (value === undefined) {
    problem(`${at} 缺少 value`);
    return;
  }
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > limits.maxInValues) {
      problem(`${at}.value：in 的 value 须为 1 到 ${limits.maxInValues} 个值组成的数组`);
      return;
    }
    value.forEach((item, index) => checkScalar(item, `${at}.value[${index}]`, problem));
    return;
  }
  if (Array.isArray(value)) {
    problem(`${at}.value 是数组：仅 in 的 value 可以是数组，${String(op)} 须填单个值`);
    return;
  }
  if (!checkScalar(value, `${at}.value`, problem)) return;
  if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && typeof value === 'boolean') {
    problem(`${at}.value：${op} 只能与数字或字符串比较，不能是布尔值`);
  }
  if (op === 'contains' && value === '') problem(`${at}.value：contains 的 value 不能为空`);
}

/** 值只收字符串（不太长）、有限的数字、布尔值；不对时说明，返回 false */
function checkScalar(value: unknown, label: string, problem: (text: string) => void): boolean {
  if (typeof value === 'string') {
    if ([...value].length <= limits.maxValueChars) return true;
    problem(`${label} 过长：字符串最多 ${limits.maxValueChars} 个字`);
    return false;
  }
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return true;
  }
  problem(`${label} 只能是字符串、数字或布尔值`);
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
