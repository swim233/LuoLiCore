import { parseJson, type JsonValue } from '../services/json.js';
import { ServiceError, type ServiceErrorKind, type ServiceLayer } from '../services/layer.js';
import { checkMonitor, type MonitorDescription, type MonitorPurpose } from './describe.js';
import { extractItems, type MonitorItem } from './items.js';
import { matches } from './where.js';

// 照描述真的查一次（ADR-0014）：经服务层调接口（算进当天的请求数）→ 正文解析成 JSON（数字不走样）→
// 取条目。试跑、建监视任务、引擎每次查都走这一段

/**
 * 查一次的结果。不通过时 step 说是哪一步：call 调接口出错（kind、status 是服务层的类别与状态码，
 * 引擎据此决定多久以后再试）；parse 正文不是 JSON；items 返回的样子和描述对不上。error 是给她看的说明
 */
export type FetchResult =
  | { ok: true; items: MonitorItem[]; warnings: string[] }
  | {
      ok: false;
      step: 'call' | 'parse' | 'items';
      error: string;
      kind?: ServiceErrorKind;
      status?: number;
    };

/** 照描述查一次，取出条目。服务层以外的错误（程序的毛病）照样抛出 */
export async function fetchItems(
  layer: Pick<ServiceLayer, 'call'>,
  monitor: Pick<MonitorDescription, 'service' | 'endpoint' | 'params' | 'items' | 'key'>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<FetchResult> {
  let response;
  try {
    response = await layer.call(monitor.service, monitor.endpoint, monitor.params ?? {}, {
      signal,
    });
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return {
      ok: false,
      step: 'call',
      error: error.message,
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  let data: JsonValue;
  try {
    data = parseJson(response.body);
  } catch {
    const type = response.mimeType ?? '没写类型';
    const cut = response.truncated ? '，而且太长、只读了前 1 MB' : '';
    return {
      ok: false,
      step: 'parse',
      error: `服务返回的正文不是 JSON（${type}${cut}）。监视只能盯返回 JSON 的接口`,
    };
  }
  const extracted = extractItems(data, monitor);
  if (!extracted.ok) return { ok: false, step: 'items', error: extracted.error };
  return extracted;
}

/** 试跑的结果：通过时有描述、条目、每条符不符合 where、提醒 */
export type TrialResult =
  | {
      ok: true;
      monitor: MonitorDescription;
      items: MonitorItem[];
      /** 和 items 一一对应：符不符合 where（没写 where 时都符合） */
      matched: boolean[];
      warnings: string[];
    }
  | { ok: false; step: 'describe' | FetchFailure['step']; error: string };

type FetchFailure = Extract<FetchResult, { ok: false }>;

/**
 * 试跑：静态检查 → 真的查一次 → 取条目 → 对每条算条件。不通过时说是哪一步、为什么
 * （描述的问题逐条列出；服务层的说明原样带上）
 */
export async function runTrial(
  layer: Pick<ServiceLayer, 'services' | 'check' | 'call'>,
  input: unknown,
  { purpose, signal }: { purpose: MonitorPurpose; signal?: AbortSignal },
): Promise<TrialResult> {
  const checked = checkMonitor(input, { services: layer, purpose });
  if (!checked.ok) {
    return { ok: false, step: 'describe', error: checked.problems.join('\n') };
  }
  const { monitor } = checked;
  const fetched = await fetchItems(layer, monitor, { signal });
  if (!fetched.ok) return { ok: false, step: fetched.step, error: fetched.error };
  return {
    ok: true,
    monitor,
    items: fetched.items,
    matched: fetched.items.map((item) => matches(item.data, monitor.where)),
    warnings: fetched.warnings,
  };
}
