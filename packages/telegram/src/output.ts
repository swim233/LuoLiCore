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
export function holdReply(since: number, delayMs: number): Promise<void> {
  const remaining = delayMs - (Date.now() - since);
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
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

export function splitTelegramText(text: string, max = 3900): string[] {
  const rendered = safeRender(text);
  const parts: string[] = [];
  let remaining = rendered;
  let reopenFence = false;
  while ([...remaining].length > max) {
    const prefix: string = reopenFence ? '```\n' : '';
    const budget = max - [...prefix].length - 4;
    const chars = [...remaining];
    const slice = chars.slice(0, budget).join('');
    const candidates = [slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？')), slice.lastIndexOf(' ')];
    const boundary = candidates.find((value) => value >= Math.floor(budget * 0.5)) ?? budget;
    const body = slice.slice(0, boundary).trimEnd();
    const open: boolean = ((prefix + body).match(/```/g) ?? []).length % 2 === 1;
    parts.push(`${prefix}${body}${open ? '\n```' : ''}`);
    remaining = `${slice.slice(boundary)}${chars.slice(budget).join('')}`.trimStart();
    reopenFence = open;
  }
  if (remaining) parts.push(`${reopenFence ? '```\n' : ''}${remaining}`);
  return parts;
}
