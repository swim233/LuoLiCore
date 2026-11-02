import type { TextStreamPart, ToolExecutionOptions, ToolSet } from 'ai';
import type { z } from 'zod';
import { errorKind } from './errors.js';
import type { Logger } from './logger.js';
import type { ToolCall } from './storage/types.js';

/**
 * 工具执行时拿到的上下文。只往里加字段：以后的能力（触发者、读本会话、平台操作……）都作为新字段
 * 加进来，已有的工具不用改（ADR-0006）
 */
export type ToolContext<ENV extends string = string> = {
  /**
   * 这次回复所在的会话：id 是存储里的会话 id（创建会话时没给就没有），
   * title 是这次回复所在段的会话名称（与 system 里的一致，没有名称时没有）
   */
  conversation: { id?: string; title?: string };
  /** 回复被中止、等模型输出超时、或这次调用超时时触发。核心不等工具停下，有副作用的工具要响应它 */
  abortSignal: AbortSignal;
  /** 日志，每条自动带上会话 id、回复 id、工具名与 toolCallId。不要记参数与结果里的对话内容 */
  logger: Logger;
  /** 工具声明的环境变量，只含这几个，值都不为空 */
  env: Readonly<Record<ENV, string>>;
};

/**
 * 以后的回复（和摘要）里怎么呈现这个工具的结果（ADR-0006）：完整、不保留（只留调用和那次的回答）、
 * 截短到 maxChars 字、或自定义的呈现函数（返回能转成 JSON 的值，字符串也行）。
 * 当次回复的循环里模型看到的总是完整结果
 */
export type ToolHistory<INPUT = unknown, OUTPUT = unknown> =
  'full' | 'omit' | { maxChars: number } | ((call: { input: INPUT; output: OUTPUT }) => unknown);

/**
 * defineTool 的结果，清单里列的就是它。各工具的参数类型在这里抹成 unknown：
 * 执行前 SDK 已按 input 校验过参数
 */
export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly env: readonly string[];
  readonly timeoutMs?: number;
  readonly history?: ToolHistory;
  readonly execute: (input: unknown, ctx: ToolContext) => unknown;
};

/** 定义一个工具。一个工具一个文件，放在 src/tools/，再列进 src/tools/index.ts 的清单 */
export function defineTool<SCHEMA extends z.ZodType, OUTPUT, ENV extends string = never>({
  env = [],
  history,
  execute,
  ...rest
}: {
  /** 给模型看的名字：小写字母、数字、下划线，以字母开头，清单里不能重复 */
  name: string;
  /** 给模型看的说明：做什么、什么时候用 */
  description: string;
  /** 参数结构（zod）。execute 收到的是按它解析过的值 */
  input: SCHEMA;
  /** 需要的环境变量。缺少任何一个（或为空）时不装这个工具 */
  env?: readonly ENV[];
  /** 一次调用的时限（毫秒）；不给时用会话的默认值 */
  timeoutMs?: number;
  /** 以后的回复里怎么呈现结果，见 ToolHistory */
  history?: ToolHistory<z.output<SCHEMA>, Awaited<OUTPUT>>;
  /** 执行：返回能转成 JSON 的值（字符串也行）；抛错即这次调用失败，模型会看到错误说明 */
  execute: (input: z.output<SCHEMA>, ctx: ToolContext<ENV>) => OUTPUT;
}): ToolDefinition {
  return {
    ...rest,
    env,
    history:
      typeof history === 'function'
        ? (call) => history(call as { input: z.output<SCHEMA>; output: Awaited<OUTPUT> })
        : history,
    execute: (input, ctx) => execute(input as z.output<SCHEMA>, ctx),
  };
}

/** 装上的一个工具：定义，加上它声明的环境变量的值 */
export type InstalledTool = {
  readonly definition: ToolDefinition;
  readonly env: Readonly<Record<string, string>>;
};

/** 装配的结果：装上的工具（按清单顺序），以及缺环境变量没装的（缺哪些） */
export type ToolSetup = {
  tools: InstalledTool[];
  skipped: Array<{ name: string; missing: string[] }>;
};

/** 清单里的工具定义有误（名字不合规、重名等）。信息里列出每个工具与它的问题 */
export class ToolDefinitionError extends Error {
  constructor(readonly problems: Array<{ tool: string; problems: string[] }>) {
    const list = problems.map(
      (entry) => `${entry.tool || '（空）'}（${entry.problems.join('，')}）`,
    );
    super(`工具定义有误：${list.join('；')}`);
    this.name = 'ToolDefinitionError';
  }
}

const toolName = /^[a-z][a-z0-9_]*$/;
// setTimeout 超过 2^31-1 毫秒会被当成 1 毫秒，立刻超时
const maxTimeoutMs = 2 ** 31 - 1;

/**
 * 装配工具清单：先检查全部定义，有误时抛 ToolDefinitionError（前端据此退出）；
 * 再按环境变量决定装哪些。env 由调用方给（核心不读 process.env），空字符串算缺。
 * 每个工具执行时只拿到自己声明的那几个变量
 */
export function installTools(
  definitions: readonly ToolDefinition[],
  env: Readonly<Record<string, string | undefined>>,
): ToolSetup {
  // 按名字归并问题，按清单里第一次出现的顺序列出
  const problems = new Map<string, string[]>();
  const report = (name: string, problem: string) => {
    const list = problems.get(name) ?? [];
    if (!list.includes(problem)) list.push(problem);
    problems.set(name, list);
  };
  const counts = new Map<string, number>();
  for (const { name } of definitions) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const definition of definitions) {
    const { name, timeoutMs, history } = definition;
    if (!toolName.test(name)) report(name, '名字只能用小写字母、数字和下划线，以字母开头');
    if (counts.get(name)! > 1) report(name, '重名');
    if (
      timeoutMs !== undefined &&
      !(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maxTimeoutMs)
    ) {
      report(name, `timeoutMs 必须是 1 到 ${maxTimeoutMs} 之间的整数（毫秒）`);
    }
    if (history !== undefined && !isHistory(history)) {
      report(name, 'history 只能是 full、omit、{ maxChars: 正整数 } 或函数');
    }
  }
  if (problems.size > 0) {
    throw new ToolDefinitionError([...problems].map(([tool, list]) => ({ tool, problems: list })));
  }

  const setup: ToolSetup = { tools: [], skipped: [] };
  for (const definition of definitions) {
    const missing = definition.env.filter((name) => !env[name]);
    if (missing.length > 0) {
      setup.skipped.push({ name: definition.name, missing });
      continue;
    }
    setup.tools.push({
      definition,
      env: Object.fromEntries(definition.env.map((name) => [name, env[name]!])),
    });
  }
  return setup;
}

function isHistory(value: unknown): boolean {
  if (value === 'full' || value === 'omit' || typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null || !('maxChars' in value)) return false;
  const { maxChars } = value;
  return typeof maxChars === 'number' && Number.isSafeInteger(maxChars) && maxChars > 0;
}

/**
 * 一次工具调用以错误结束。message 就是交给模型的错误说明，写进历史的 errorText 也是它。
 * SDK 把工具的错误交给模型时取 toString()，这里只返回 message，不带类型名
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }

  override toString(): string {
    return this.message;
  }
}

/**
 * 模型看到的错误说明，与 SDK 相同（@ai-sdk/provider 的 getErrorMessage）：字符串原样，
 * Error 取 toString()（如 `TypeError: fetch failed`），其他转成 JSON
 */
function modelErrorText(error: unknown): string {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.toString();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 装上的工具换成 streamText 的工具集。按清单顺序：发给模型的工具定义每次都一样，利于前缀缓存。
 * run 执行一次调用（摘要请求不执行工具，给一个不会被调用的 run）
 */
export function toToolSet(
  tools: readonly InstalledTool[],
  run: (
    tool: InstalledTool,
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => Promise<unknown>,
): ToolSet {
  return Object.fromEntries(
    tools.map((installed) => [
      installed.definition.name,
      {
        description: installed.definition.description,
        inputSchema: installed.definition.input,
        execute: (input: unknown, options: ToolExecutionOptions<unknown>) =>
          run(installed, input, options),
      },
    ]),
  );
}

/** 一次工具调用结束时交给调用方写进工具调用表的一行（回复 id 由调用方补上） */
export type RecordToolCall = (call: Omit<ToolCall, 'replyId'>) => Promise<void>;

/**
 * 执行一次工具调用：限时，结束时记一条 tool.end，并用同一份数据在工具调用表写一行
 * （都不记参数与结果的内容）。
 * 时限到或回复被中止时立即结束这次调用，不等工具停下（它的 ctx.abortSignal 已触发）。
 * 出错都换成 ToolError：工具抛的错照 SDK 的写法转成文字，超时是「工具执行超时（N 秒）」
 */
export async function runTool(
  { definition, env }: InstalledTool,
  input: unknown,
  {
    toolCallId,
    abortSignal,
    timeoutMs,
    step,
    conversation,
    logger,
    logFields,
    record,
  }: {
    toolCallId: string;
    /** SDK 交给这次调用的中止信号：回复被中止、等模型输出超时 */
    abortSignal?: AbortSignal;
    /** 默认时限（毫秒）；工具自己声明了 timeoutMs 时用它的 */
    timeoutMs: number;
    /** 第几步（从 1 数） */
    step: number;
    conversation: ToolContext['conversation'];
    logger: Logger;
    logFields: object;
    /** 写工具调用表；出错由它自己处理，不抛出 */
    record: RecordToolCall;
  },
): Promise<unknown> {
  const fields = { ...logFields, tool: definition.name, toolCallId };
  const limitMs = definition.timeoutMs ?? timeoutMs;
  const startedAt = Date.now();
  const end = async (
    level: 'info' | 'warn',
    outcome: ToolCall['outcome'],
    { errorType, resultLength }: { errorType?: string; resultLength?: number } = {},
  ) => {
    const durationMs = Date.now() - startedAt;
    const details = {
      ...(errorType === undefined ? {} : { errorType }),
      ...(resultLength === undefined ? {} : { resultLength }),
    };
    logger[level]({ ...fields, step, durationMs, outcome, ...details }, 'tool.end');
    await record({
      tool: definition.name,
      step,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      outcome,
      ...(errorType === undefined ? {} : { error: errorType }),
      ...(resultLength === undefined ? {} : { outputChars: resultLength }),
    });
  };

  const limit = new AbortController();
  // 怎么结束的：时限到、回复被中止；按它记结果，不看是哪个 promise 先落定
  let ended: 'timeout' | 'aborted' | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ended ??= 'timeout';
      limit.abort(new DOMException(`工具执行超时（${limitMs / 1000} 秒）`, 'TimeoutError'));
      reject(limit.signal.reason);
    }, limitMs);
    onAbort = () => {
      ended ??= 'aborted';
      reject(abortSignal?.reason);
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
  const ctx: ToolContext = {
    conversation,
    abortSignal: abortSignal ? AbortSignal.any([abortSignal, limit.signal]) : limit.signal,
    logger: withFields(logger, fields),
    env,
  };
  const running = Promise.resolve().then(() => definition.execute(input, ctx));
  // 时限到、被中止之后没人再等它们；工具晚些抛的错不算未处理的 rejection
  running.catch(() => {});
  stopped.catch(() => {});

  let output: unknown;
  try {
    output = await Promise.race([running, stopped]);
  } catch (error) {
    if (ended === 'timeout') {
      await end('warn', 'timeout');
      throw new ToolError(`工具执行超时（${limitMs / 1000} 秒）`);
    }
    if (ended === 'aborted' || abortSignal?.aborted) {
      await end('info', 'aborted');
      throw new ToolError('工具调用被中止');
    }
    await end('warn', 'failed', { errorType: errorKind(error) });
    throw new ToolError(modelErrorText(error));
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onAbort);
  }

  // 交给模型的文字：字符串原样，其他转成 JSON（undefined 是 null）。转不了按失败处理，
  // 免得之后整次回复出错。结果长度记的是这段文字的字符数
  let text: string;
  try {
    text = typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null');
  } catch (error) {
    await end('warn', 'failed', { errorType: errorKind(error) });
    throw new ToolError(`工具的结果无法转成 JSON：${modelErrorText(error)}`);
  }
  await end('info', 'completed', { resultLength: text.length });
  return output;
}

/** 每条日志都带上 fields；同名时以 fields 为准 */
function withFields(logger: Logger, fields: object): Logger {
  return {
    info: (own, msg) => logger.info({ ...own, ...fields }, msg),
    warn: (own, msg) => logger.warn({ ...own, ...fields }, msg),
    error: (own, msg) => logger.error({ ...own, ...fields }, msg),
  };
}

type Part = TextStreamPart<ToolSet>;

/**
 * 包在一次回复的 streamText 流上（转成 UI 流之前）：数工具调用；参数不合结构、调了不存在的工具的
 * 调用（SDK 不执行，直接以错误交给模型）记一条 tool.end，在工具调用表写一行；工具的错误都换成
 * ToolError，转 UI 流时据此与回复失败区分，写进历史的 errorText 与模型看到的相同
 */
export function watchToolCalls({
  logger,
  logFields,
  record,
}: {
  logger: Logger;
  logFields: object;
  record: RecordToolCall;
}): {
  stream: TransformStream<Part, Part>;
  /** 到目前为止的工具调用次数，含不合规的 */
  count: () => number;
} {
  let calls = 0;
  // 第几步（从 1 数），按流里的 start-step 数
  let step = 0;
  const stream = new TransformStream<Part, Part>({
    async transform(part, controller) {
      if (part.type === 'start-step') step++;
      if (part.type === 'tool-call') {
        calls++;
        if (part.invalid) {
          const errorType = errorKind(part.error);
          logger.warn(
            {
              ...logFields,
              tool: part.toolName,
              toolCallId: part.toolCallId,
              step,
              // SDK 不执行，没有耗时
              durationMs: 0,
              outcome: 'failed',
              errorType,
            },
            'tool.end',
          );
          await record({
            tool: part.toolName,
            step,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            outcome: 'failed',
            error: errorType,
          });
          controller.enqueue({ ...part, error: new ToolError(modelErrorText(part.error)) });
          return;
        }
      }
      // 不合规的调用随后还有一个 tool-error，SDK 已把错误转成文字；执行出错的已是 ToolError
      if (
        part.type === 'tool-error' &&
        !part.providerExecuted &&
        !(part.error instanceof ToolError)
      ) {
        controller.enqueue({ ...part, error: new ToolError(modelErrorText(part.error)) });
        return;
      }
      controller.enqueue(part);
    },
  });
  return { stream, count: () => calls };
}
