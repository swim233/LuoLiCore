import { styleText } from "node:util";
import type { LogEvent } from "./sink.js";

/**
 * `console: pretty` 这一路的行格式。**只这一路着色** —— `json` 一路要保持可被 jq 逐行解析，
 * 混进转义序列即不可解析；写库失败时那两行走的是 stderr，见本文件末尾。
 *
 * 不引入着色库：`styleText` 每次调用先由 Node 判定目标流是否支持颜色
 * （TTY、`NO_COLOR`、`FORCE_COLOR`、`TERM=dumb`），不支持时原样返回。重定向到文件、
 * journald 与 `docker logs` 收到的因而是纯文本，无需在此另判一次。
 */
type Style = Parameters<typeof styleText>[0];

const LEVEL_STYLE: Record<LogEvent["level"], Style> = {
  debug: "gray",
  info: "green",
  warn: "yellow",
  error: ["bold", "red"],
};
const LEVEL_LABEL: Record<LogEvent["level"], string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

/**
 * 命名空间（`kind` 的第一段）决定色相：`model.*` 与 `tool.*` 各自成色，密集刷屏时按颜色
 * 分组快于读文字。全为冷色，与级别列的绿 / 黄 / 红不重合 —— 级别是唯一表示严重程度的位置，
 * 别处出现同色会读成告警。取值只求稳定：两个命名空间撞色没有其他后果。
 */
const KIND_STYLES: Style[] = [
  "cyan",
  "magenta",
  "blue",
  "cyanBright",
  "magentaBright",
  "blueBright",
];
const kindStyle = (kind: string): Style => {
  const namespace = kind.slice(0, kind.indexOf(".") + 1 || kind.length);
  let hash = 0;
  for (let i = 0; i < namespace.length; i++)
    hash = (hash * 31 + namespace.charCodeAt(i)) >>> 0;
  return KIND_STYLES[hash % KIND_STYLES.length]!;
};

/** 超过这个耗时的 span 用黄色标出。阈值不设为配置项：它只影响一行文本的颜色。 */
const SLOW_MS = 1000;
const KIND_WIDTH = 18;

const clock = (ts: number): string => {
  const at = new Date(ts);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
};

/**
 * 只用行本身的五个字段，不碰 `data` —— 载荷单条可达几 MB（`model.call` 携带请求体），
 * 整块打进终端会把上面几屏顶掉，而它在库里那一行上完整存着（docs/10 §3）。
 *
 * 传入的 `event` 须为已脱敏的那份：pretty 与 json 两路同源，只有一路脱敏是曾经出过的缺陷。
 */
export function formatPretty(
  ts: number,
  event: Pick<
    LogEvent,
    "level" | "kind" | "summary" | "traceId" | "durationMs"
  >,
): string {
  const parts = [
    styleText("gray", clock(ts)),
    styleText(LEVEL_STYLE[event.level], LEVEL_LABEL[event.level]),
    styleText(kindStyle(event.kind), event.kind.padEnd(KIND_WIDTH)),
    event.summary,
  ];
  if (event.durationMs !== undefined)
    parts.push(
      styleText(
        event.durationMs >= SLOW_MS ? "yellow" : "gray",
        `${event.durationMs}ms`,
      ),
    );
  if (event.traceId)
    parts.push(styleText("gray", `#${event.traceId.slice(-6)}`));
  return parts.join(" ");
}

/**
 * 启动与关停期直写终端的 `[tag] 正文` 行：配置被拒、实例锁、crash handler、Telegram 入口失败。
 * 这些点位于 LogSink 之外或之前，没有级别列，因此严重程度落在 `[tag]` 的颜色上。
 *
 * **只着色行首的 `[tag]`，正文一个字节不动**：正文里是 SQL 清理命令、路径与 pid，
 * 着色对判读无帮助。
 *
 * `stream` 必须传实际写入的那条流：能力校验的默认目标是 stdout，而两条流的重定向去处可以不同。
 */
export function tagged(
  level: LogEvent["level"],
  text: string,
  stream: NodeJS.WriteStream = process.stderr,
): string {
  return text.replace(/^\[[a-z]+\]/gm, (tag) =>
    styleText(level === "info" ? kindStyle(tag) : LEVEL_STYLE[level], tag, {
      stream,
    }),
  );
}

/** 首启时的 setup token 那一段：整个部署此刻只等这一行被人看见。 */
export const highlight = (
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string => styleText(["bold", "cyan"], text, { stream });
