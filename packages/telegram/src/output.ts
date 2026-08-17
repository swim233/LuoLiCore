import type { Api } from 'grammy';
import type { Message } from 'grammy/types';

const SPECIAL = /[_*\[\]()~`>#+\-=|{}.!]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

export function safeRender(markdown: string): string {
  let text = markdown;
  const fences = (text.match(/```/g) ?? []).length;
  if (fences % 2) text += '\n```';
  const protectedBlocks: string[] = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, body: string) => {
    const marker = `\u0000${protectedBlocks.length}\u0000`;
    protectedBlocks.push(`\`\`\`${body.replace(/[\\`]/g, '\\$&')}\`\`\``);
    return marker;
  });
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  const lines = text.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[index + 1]!)) {
      const table: string[] = [line, lines[index + 1]!];
      index += 2;
      while (index < lines.length && lines[index]!.includes('|')) { table.push(lines[index]!); index += 1; }
      index -= 1;
      output.push(`\`\`\`\n${table.join('\n').replace(/[\\`]/g, '\\$&')}\n\`\`\``);
      continue;
    }
    output.push(line.replace(SPECIAL, '\\$&').replace(/\\\*\\\*([^*]+)\\\*\\\*/g, '*$1*'));
  }
  text = output.join('\n');
  return text.replace(/\u0000(\d+)\u0000/g, (_, raw: string) => protectedBlocks[Number(raw)] ?? '');
}

/**
 * 秒回读起来像自动应答机，流式模式下第一帧还几乎是空的。距离用户那条消息不足
 * `output.replyDelayMs` 就先压住不发；期间 typing 动作照常，所以看起来是在打字而不是卡住。
 */
export async function holdReply(since: number, delayMs: number): Promise<void> {
  // setTimeout 可以比 Date.now() 的读数早醒 1ms，单次 sleep 会让「至少等这么久」这条下限偶发地
  // 差一毫秒不成立（tests/output.pacing.test.ts 因此约 8% 概率变红）。补睡到真的过线为止。
  for (let remaining = delayMs - (Date.now() - since); remaining > 0; remaining = delayMs - (Date.now() - since)) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * MarkdownV2 渲染失败时退回纯文本重发一次。所有投递路径共用它：`safeRender` 已经很细，但按字符数
 * 切分仍可能把 `*bold*` 的配对切开，而裸调 `sendMessage` 抛出去会把整轮打成 failed —— 用户明明
 * 已经看到前半段回复，却又收到一句「出了点问题」（docs/20 · W-TG-03 / W-TG-04）。
 */
export async function sendWithFallback(api: Api, chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<Message> {
  try { return await api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...extra }); }
  catch (error) {
    if (!/parse entities/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return api.sendMessage(chatId, text, extra);
  }
}

/** 码点数组上的 `lastIndexOf('\n\n')`。见下方 splitTelegramText 里为什么不能用 String 版。 */
function lastIndexOfPair(haystack: readonly string[], first: string, second: string): number {
  for (let start = haystack.length - 2; start >= 0; start -= 1) if (haystack[start] === first && haystack[start + 1] === second) return start;
  return -1;
}

export function splitTelegramText(text: string, max = 3900): string[] {
  const parts: string[] = [];
  let remaining = [...safeRender(text)];
  let reopenFence = false;
  while (remaining.length > max) {
    const prefix: string = reopenFence ? '```\n' : '';
    const budget = max - [...prefix].length - 4;
    const window = remaining.slice(0, budget);
    // 断点只在码点数组上找。String#lastIndexOf 给的是 UTF-16 下标，一条 emoji 就让它比码点下标大 1；
    // 拿它去切码点数组，body 取不满而 remaining 多跳，中间那段直接消失（实测 5001 码点丢 1105 个，
    // docs/24 · R-TG-01）。boundary 由此恒 ≤ budget，也就不会切出超长的 part。
    const candidates = [lastIndexOfPair(window, '\n', '\n'), window.lastIndexOf('\n'),
      Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？')), window.lastIndexOf(' ')];
    const boundary = candidates.find((value) => value >= Math.floor(budget * 0.5)) ?? budget;
    const body = window.slice(0, boundary).join('').trimEnd();
    const open: boolean = ((prefix + body).match(/```/g) ?? []).length % 2 === 1;
    parts.push(`${prefix}${body}${open ? '\n```' : ''}`);
    remaining = remaining.slice(boundary);
    while (remaining[0]?.trim() === '') remaining.shift();
    reopenFence = open;
  }
  if (remaining.length) parts.push(`${reopenFence ? '```\n' : ''}${remaining.join('')}`);
  return parts;
}
