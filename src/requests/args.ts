import { parseArgs } from 'node:util';
import { parseTime, timeFormats } from './time.js';

/** 导出的条件与去处 */
export type ExportOptions = {
  /** --conversation 的文字，按给出的顺序；空数组表示不按会话筛 */
  conversations: string[];
  since?: Date;
  until?: Date;
  /** 没给 --since、--until、--reply，用了默认的最近 24 小时 */
  defaultRange: boolean;
  replyId?: string;
  failedOnly: boolean;
  embedImages: boolean;
  /** 输出文件；不给时写到标准输出 */
  output?: string;
};

export type ParsedArgs =
  | { ok: true; help: true }
  | { ok: true; help?: false; options: ExportOptions }
  | { ok: false; error: string };

export const usage = `用法：pnpm requests [选项]

导出发给模型的请求与响应（请求记录，ADR-0008），输出一个 JSON 数组。
请求记录与主库都只读打开，bot 运行时也能用。路径与 bot 相同：主库 LUOLI_DB（默认 data/luoli.db），
请求记录 LUOLI_REQUESTS_DB（默认主库旁边的 requests.db），图片 LUOLI_FILES_DIR（默认主库旁边的 files/）。

选项：
  --conversation <文字>  只看这些会话，可以给多次。依次按会话 id、Telegram 群 id 完全相同，
                         或会话标题包含这段文字（不分大小写）来认；一段文字匹配到的会话全部算上
  --since <时间>         开始时间不早于它（含）
  --until <时间>         开始时间早于它（不含）
  --reply <回复 id>      只看这次回复的全部请求
  --failed               只看结果是 failed 的请求
  --embed-images         把图片引用（luoli-file:）嵌回 base64，请求体可以直接重放；
                         文件读不到的图片照旧是引用，这一项带 missingImages
  -o, --output <文件>    写到文件（所在目录须已存在）；不给时写到标准输出
  -h, --help             显示这段说明

时间的写法：
${indent(timeFormats)}

默认的时间范围：没给 --since、--until、--reply 时导出最近 24 小时；给了 --reply 时不限时间。

输出：按开始时间升序的 JSON 数组，每项依次有
  time         开始时间（本机时区，YYYY-MM-DD HH:mm:ss）
  conversation 会话：id、platform、title（主库里找不到这个会话时只有 id）
  purpose      reply 或 summary
  replyId      回复 id（摘要没有）
  step         回复的第几步（摘要没有）
  attempt      这一步的第几次尝试
  durationMs   耗时
  outcome      completed、failed 或 aborted
  request      实际发出的完整请求体（不是 JSON 的原样为字符串）
  response     status、text、reasoning、toolCalls、finishReason、usage、error（有的才写）
  missingImages  --embed-images 时读不到的图片（有才写）
摘要一行写到标准错误；标准输出只有 JSON。`;

// 带值的参数。值是负数（Telegram 群 id 如 -1001234）时 parseArgs 会当成另一个参数报错，
// 先并成 --conversation=-1001234 的写法
const valueOptions = new Map([
  ['--conversation', '--conversation'],
  ['--since', '--since'],
  ['--until', '--until'],
  ['--reply', '--reply'],
  ['--output', '--output'],
  ['-o', '--output'],
]);

/**
 * `--since 2026-11-04 19:00` 没加引号：日期之后多出一个像时间的参数。parseArgs 只会报
 * 「Unexpected argument」，这里先认出来，提示加引号
 */
function unquotedDateTime(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const inline = /^--(since|until)=(.*)$/.exec(arg);
    const name = inline ? inline[1] : /^--(since|until)$/.exec(arg)?.[1];
    if (name === undefined) continue;
    const date = inline ? inline[2] : argv[i + 1];
    const time = inline ? argv[i + 1] : argv[i + 2];
    if (
      date !== undefined &&
      time !== undefined &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      /^\d{1,2}:\d{2}(:\d{2})?$/.test(time)
    ) {
      return `--${name} 的日期和时间之间有空格，要加引号：--${name} '${date} ${time}'`;
    }
  }
  return undefined;
}

function joinNegativeValues(argv: string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = valueOptions.get(argv[i]!);
    const next = argv[i + 1];
    if (name !== undefined && next !== undefined && /^-\d+$/.test(next)) {
      joined.push(`${name}=${next}`);
      i++;
    } else {
      joined.push(argv[i]!);
    }
  }
  return joined;
}

/** 解析命令行参数。now 用来算相对时间与默认的最近 24 小时 */
export function parseExportArgs(argv: string[], now: Date): ParsedArgs {
  const unquoted = unquotedDateTime(argv);
  if (unquoted) return { ok: false, error: unquoted };
  let values;
  try {
    ({ values } = parseArgs({
      args: joinNegativeValues(argv),
      options: {
        conversation: { type: 'string', multiple: true },
        since: { type: 'string' },
        until: { type: 'string' },
        reply: { type: 'string' },
        failed: { type: 'boolean' },
        'embed-images': { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    return { ok: false, error: `参数错误：${(error as Error).message}` };
  }
  if (values.help) return { ok: true, help: true };

  const conversations = values.conversation ?? [];
  if (conversations.some((text) => text.trim() === '')) {
    return { ok: false, error: '--conversation 不能为空' };
  }
  if (values.reply === '') return { ok: false, error: '--reply 不能为空' };
  if (values.output === '') return { ok: false, error: '--output 不能为空' };

  const times: { since?: Date; until?: Date } = {};
  for (const key of ['since', 'until'] as const) {
    const text = values[key];
    if (text === undefined) continue;
    const time = parseTime(text, now);
    if (!time) {
      return {
        ok: false,
        error: `--${key} 的时间写法不对：「${text}」。接受这些写法：\n${timeFormats}`,
      };
    }
    times[key] = time;
  }
  if (times.since && times.until && times.since >= times.until) {
    return { ok: false, error: '--since 必须早于 --until' };
  }

  // 默认最近 24 小时（ADR-0008）；按回复导出时不限时间
  const defaultRange = !times.since && !times.until && values.reply === undefined;
  return {
    ok: true,
    options: {
      conversations,
      since: defaultRange ? new Date(now.getTime() - 24 * 3_600_000) : times.since,
      until: times.until,
      defaultRange,
      replyId: values.reply,
      failedOnly: values.failed ?? false,
      embedImages: values['embed-images'] ?? false,
      output: values.output,
    },
  };
}

function indent(text: string): string {
  return text.replace(/^/gm, '  ');
}
