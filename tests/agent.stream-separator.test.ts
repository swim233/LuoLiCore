import { describe, expect, it } from 'vitest';
import { stepSeparatedText } from '@luoli/core';

/**
 * 回归：一轮 10 步里六步各吐一句旁白，用户收到的是**没有任何换行**的六句话，落库也是单个
 * text part（logs/2026-08-18 · turn 01M09QBZVK…）。`result.textStream` 把 step 边界丢了，
 * 投递侧那一行 `text +=`（`stream-output.ts`）于是无缝粘接。人格里「一句话一行」只管单步内。
 */
async function* parts(...items: Array<{ type: string; text?: string }>): AsyncGenerator<{ type: string; text?: string }> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

describe('stepSeparatedText', () => {
  it('inserts a blank line between two steps that both produced text', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '好呀，先看看怎么装 MCP。' },
      { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '先确认这边有没有装 MCP 的入口。' },
      { type: 'finish-step' },
    )));
    expect(text).toBe('好呀，先看看怎么装 MCP。\n\n先确认这边有没有装 MCP 的入口。');
  });

  // 模型自己收尾的换行**不再决定间距**：步边界恒等于一个空行。此前这里是「已经换过行就不补」，
  // 于是同一条回复里段间距时而 `\n` 时而 `\n\n`，取决于模型那一步碰巧写没写换行。
  it('normalizes the gap to exactly one blank line even if the model already ended its line', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '第一步说完了。\n' },
      { type: 'finish-step' },
      { type: 'text-delta', text: '第二步接着说。' },
    )));
    expect(text).toBe('第一步说完了。\n\n第二步接着说。');
  });

  // 回归（logs/2026-08-18 · turn 01M0AKMXG4…）：KERNEL 那条「段间空一行」把模型教成每一步都以
  // `\n\n\n` 收尾，纯工具步的「正文」就是 `\n\n\n`。这些空白此前被原样透传 —— 一条 11 步的回复
  // 开头 10 个换行、中段 12 连换行，落库的 assistant part 也带着它们。
  it('collapses model-authored trailing blank lines and drops whitespace-only steps', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '\n\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: 'Nori 先看一眼这张图~ 稍等哦。\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '浏览器不吃 file:// 协议，Nori 开个本地小服务器喂给它看~\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '\n\n\n' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: 'Nori 看到图啦~\n\n图里是一个电脑屏幕。' }, { type: 'finish-step' },
    )));
    expect(text).toBe('Nori 先看一眼这张图~ 稍等哦。\n\n浏览器不吃 file:// 协议，Nori 开个本地小服务器喂给它看~\n\nNori 看到图啦~\n\n图里是一个电脑屏幕。');
  });

  // 步**内**的空白一个字都不动：围栏代码块里的空行是合法内容，不能跟着步间距一起被收窄。
  it('leaves whitespace inside one step untouched', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '```\nconst a = 1;\n\n\n\nconst b = 2;\n```' },
      { type: 'finish-step' },
      { type: 'text-delta', text: '改好了。' },
    )));
    expect(text).toBe('```\nconst a = 1;\n\n\n\nconst b = 2;\n```\n\n改好了。');
  });

  it('surfaces error parts instead of silently dropping them', async () => {
    const seen: unknown[] = [];
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '先查一下。' }, { type: 'finish-step' },
      { type: 'error', error: new Error('upstream 502') } as { type: string },
    ), undefined, undefined, (error) => seen.push(error)));
    expect(text).toBe('先查一下。');
    expect((seen[0] as Error).message).toBe('upstream 502');
  });

  it('keeps deltas inside one step glued together', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '同一' }, { type: 'text-delta', text: '步的' }, { type: 'text-delta', text: '增量' },
    )));
    expect(text).toBe('同一步的增量');
  });

  it('never leads with a separator when only later steps speak', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'reasoning', text: '想一想' }, { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'tool-call' }, { type: 'finish-step' },
      { type: 'text-delta', text: '查完了，结果是这样。' },
    )));
    expect(text).toBe('查完了，结果是这样。');
  });

  it('separates the wrap-up retry from the last narration', async () => {
    // 最后一步只有 reasoning、0 个 text token 时补跑的那一次（runtime 的 `wrapUpIfNeeded`）
    // 必须同样带分隔，否则结论会直接贴在最后一句旁白后面。
    const text = await collect(stepSeparatedText(
      parts({ type: 'text-delta', text: '接下来改开关。' }, { type: 'finish-step' }),
      async () => '开关都打开了，但 agent-browser 还是禁用状态。',
    ));
    expect(text).toBe('接下来改开关。\n\n开关都打开了，但 agent-browser 还是禁用状态。');
  });

  // 回归：判据曾是「保留末尾 4 个字符再跑 /\n\s*$/」，末尾窗口被空白填满时那个换行就看不见了。
  // 现在换成「扣住尾部空白、跨过 step 边界就丢掉」——末尾有多少空白、含不含换行都不再影响结果。
  it('drops a step trailing whitespace run of any shape', async () => {
    const text = await collect(stepSeparatedText(parts(
      { type: 'text-delta', text: '接下来改开关。\n     ' },
      { type: 'finish-step' },
      { type: 'text-delta', text: '开关改好了。' },
    )));
    expect(text).toBe('接下来改开关。\n\n开关改好了。');
  });

  it('reports every chunk it emitted, separators included', async () => {
    // `final` 要解析成**整条发出去的文本**（旁白 + 分隔 + 结论），不是只用结论那一段：归档与
    // 上下文存的必须是用户屏幕上那条消息。
    const seen: string[] = [];
    await collect(stepSeparatedText(
      parts({ type: 'text-delta', text: '先看看。' }, { type: 'finish-step' }),
      async () => '看完了。',
      (chunk) => seen.push(chunk),
    ));
    expect(seen.join('')).toBe('先看看。\n\n看完了。');
  });

  it('emits nothing extra when the wrap-up produced nothing', async () => {
    const text = await collect(stepSeparatedText(
      parts({ type: 'text-delta', text: '就这样。' }, { type: 'finish-step' }),
      async () => '',
    ));
    expect(text).toBe('就这样。');
  });

  /**
   * 已经吐出去的部分留着、收尾回调抛出去 —— `streamMainAgent` 用这一跳把「轮次被 abort / 步骤级
   * 失败」告诉投递侧（`TelegramOutput.consume` 的 `interrupted`）。`result.stream` 自己是不抛的：
   * AI SDK 把步骤级失败吞进内部 onError，流照常正常结束（logs/2026-08-18 · B8F92Z 就是这么以
   * committed 收尾的）。
   */
  it('surfaces a throwing wrap-up to the consumer without losing what was already emitted', async () => {
    const seen: string[] = [];
    const stream = stepSeparatedText(
      parts({ type: 'text-delta', text: '先查一下。' }, { type: 'finish-step' }),
      async () => { throw new Error('timeout'); },
      (chunk) => seen.push(chunk),
    );
    await expect(collect(stream)).rejects.toThrow('timeout');
    expect(seen.join('')).toBe('先查一下。');
  });
});
