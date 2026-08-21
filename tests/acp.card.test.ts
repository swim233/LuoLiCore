import type { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramTools, openAcpProgressCard, toPlainText, type AcpCardOptions } from '@luoli/telegram';

/**
 * ACP 运行的进度卡片（`docs/08 §6.1`）。这一组盯的不是「好看」，是四条不变量：
 *
 * - **一次 run = 一条消息**：`sendMessage` 恰好一次，其余全是对那一条的编辑；
 * - **节流真的在节流**：`intervalMs` 是编辑次数的上界，即时刷新有 2 秒地板；
 * - **超预算整段丢、绝不切半行**（`docs/02 §9` 红线 11 搬到 UI 上）；
 * - **观测不许打断投递**：`push()` 永不 throw，`close()` 在中途全失败之后照样渲染出终帧。
 *
 * 照 `tests/output.pacing.test.ts` 的形状自己实现一个假 bot —— 全仓没有 mock 层。
 */

interface Call { method: 'send' | 'edit'; at: number; text: string; messageId: number; parseMode?: string }

function fakeBot(calls: Call[], broken: { send?: boolean; edit?: boolean } = {}): Bot {
  let nextId = 500;
  const api = {
    sendMessage: (_chat: string, text: string, extra?: { parse_mode?: string }) => {
      if (broken.send) return Promise.reject(new Error('429: Too Many Requests: retry after 30'));
      nextId += 1;
      calls.push({ method: 'send', at: Date.now(), text, messageId: nextId, ...(extra?.parse_mode ? { parseMode: extra.parse_mode } : {}) });
      return Promise.resolve({ message_id: nextId, date: 0 });
    },
    editMessageText: (_chat: string, messageId: number, text: string, extra?: { parse_mode?: string }) => {
      if (broken.edit) return Promise.reject(new Error('400: Bad Request: message to edit not found'));
      calls.push({ method: 'edit', at: Date.now(), text, messageId, ...(extra?.parse_mode ? { parseMode: extra.parse_mode } : {}) });
      return Promise.resolve(true);
    },
  };
  return { api } as unknown as Bot;
}

const target = { chatId: '4242', threadId: null };
const options = (overrides: Partial<AcpCardOptions> = {}): AcpCardOptions =>
  ({ parseMode: 'none', maxMessageChars: 3900, intervalMs: 5000, agent: 'omp', dir: '/home/swim/code/LuoLiCore', ...overrides });

/** `SessionNotification` 的外壳。入参故意是 `unknown` —— 卡片不许信这个形状（下面有一条专门灌坏东西的）。 */
const note = (update: Record<string, unknown>): unknown => ({ sessionId: 's1', update });
const toolCall = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}): unknown =>
  note({ sessionUpdate: 'tool_call', toolCallId: id, kind, title, status: 'pending', ...extra });
const toolUpdate = (id: string, status: string, extra: Record<string, unknown> = {}): unknown =>
  note({ sessionUpdate: 'tool_call_update', toolCallId: id, status, ...extra });
const chunk = (text: string): unknown => note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const thought = (text: string, messageId = 'm1'): unknown =>
  note({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } });
const plan = (entries: Array<{ content: string; status: string }>): unknown => note({ sessionUpdate: 'plan', entries });

/** MarkdownV2 的转义不变量：正文里每个特殊字符前面都得有反斜杠，否则 Telegram 判解析失败。 */
const MARKDOWN_SPECIAL = '_*[]()~`>#+-=|{}.!';
function markdownV2Safe(text: string): string[] {
  const points = [...text];
  const bare: string[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (points[index] === '\\') { index += 1; continue; }
    if (MARKDOWN_SPECIAL.includes(points[index]!)) bare.push(`${index}:${points[index]!}`);
  }
  return bare;
}

afterEach(() => { vi.useRealTimers(); });

describe('ACP 进度卡片 · 一条消息与节流', () => {
  /**
   * 实测量级：6 秒的琐碎任务 82–131 条 update，86 秒那次 263 条。**节流不是可选项** ——
   * 私聊那个桶只有 `{minTime: 1000}`（没有 per-minute reservoir），一秒一拍约 60 次/分钟，
   * 而这里灌的 300 条里有 200 次 `tool_call`。
   */
  it('300 条 update 只发一条消息，编辑次数被 intervalMs 焊住', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    // 1 条 plan + 200 条 tool_call + 99 条 chunk = 300 条，摊在 30 秒里。
    card.push(plan([{ content: '读那 628 行', status: 'in_progress' }, { content: '补接线与用例', status: 'pending' }]));
    for (let index = 0; index < 200; index += 1) {
      card.push(toolCall(`t${index}`, index % 2 ? 'read' : 'edit', `处理第 ${index} 个文件`,
        { locations: [{ path: `/repo/src/f${index}.ts` }], status: index % 3 ? 'completed' : 'in_progress' }));
      if (index % 2 && index < 199) card.push(chunk(`第 ${index} 段正文。`));
      await vi.advanceTimersByTimeAsync(150);
    }
    const finalText = await card.close({ stopReason: 'end_turn', files: 8, failures: 0, toolCalls: 200 });
    const sends = calls.filter((call) => call.method === 'send');
    const edits = calls.filter((call) => call.method === 'edit');
    // 一次 run = 一条消息，这是不变量：一次都不发第二条。
    expect(sends).toHaveLength(1);
    expect(new Set(edits.map((call) => call.messageId))).toEqual(new Set([sends[0]!.messageId]));
    // 上界：⌈时长/间隔⌉ + 3（首帧不算编辑，即时刷新与终帧各留一格余量）。
    expect(edits.length).toBeLessThanOrEqual(Math.ceil(30_000 / 5000) + 3);
    expect(edits.length).toBeGreaterThan(1); // 也不许退化成「压根不刷」
    expect(finalText).toContain('工具 200 次');
    expect(finalText).toContain('✅ 完成');
  });

  /**
   * 「渲染与上帧逐字节相同就不发」—— 不靠 Telegram 回 `message is not modified` 兜：那一跳照样
   * 占掉一个槽位，还排在真正要发的东西前面。规则 6（`agent_message_chunk` 不驱动刷新）就是靠
   * 这一条实现的：有工具在跑时正文尾不显示，于是那些 chunk 渲染出来的帧与上帧一模一样。
   */
  it('帧与上帧相同就不占槽位，chunk 因此不驱动刷新', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    card.push(toolCall('t1', 'execute', '跑 pnpm test'));
    card.push(toolUpdate('t1', 'in_progress'));
    await vi.advanceTimersByTimeAsync(6000);
    const afterTool = calls.filter((call) => call.method === 'edit').length;
    expect(afterTool).toBe(1);
    for (let index = 0; index < 40; index += 1) card.push(chunk(`第 ${index} 个 token`));
    await vi.advanceTimersByTimeAsync(30_000); // 六个间隔过去，一次编辑都不该有
    expect(calls.filter((call) => call.method === 'edit')).toHaveLength(afterTool);
    // 工具收尾之后正文尾才露出来，那时才值一次编辑。
    card.push(toolUpdate('t1', 'completed'));
    await vi.advanceTimersByTimeAsync(6000);
    const shown = calls.at(-1)!.text;
    expect(shown).toContain('💬');
    expect(shown).toContain('第 39 个 token');
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
  });

  /**
   * 失败是这一趟花了十五分钟的原因，只显示「当前在干什么」会把它冲掉。所以 `failed` 一条
   * ⚠ 行**在后续每一帧里留着**，且带累计次数；它同时值一次绕过间隔的即时刷新 —— 但那个绕过
   * 有 2 秒地板，否则一个 200 次调用全失败的 agent 能把它变成 200 次编辑。
   */
  it('失败粘住并即时刷新，但即时刷新有 2 秒地板', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    // 间隔调到 60 秒：这一组里出现的每一次编辑都只可能来自即时刷新。
    const card = await openAcpProgressCard(fakeBot(calls), target, options({ intervalMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(3000);
    card.push(toolCall('t1', 'edit', '改 packages/core/src/acp/manager.ts'));
    card.push(toolUpdate('t1', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    let edits = calls.filter((call) => call.method === 'edit');
    expect(edits).toHaveLength(1); // 3 秒就刷了，而间隔是 60 秒
    expect(edits[0]!.text).toContain('⚠ 失败 1 次');
    expect(edits[0]!.text).toContain('最近：改 packages/core/src/acp/manager.ts');
    await vi.advanceTimersByTimeAsync(3000);
    card.push(toolCall('t2', 'execute', '跑 pnpm typecheck'));
    card.push(toolUpdate('t2', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    edits = calls.filter((call) => call.method === 'edit');
    expect(edits).toHaveLength(2);
    expect(edits[1]!.text).toContain('⚠ 失败 2 次');
    // 地板：500ms 之后的第三次失败不值一次编辑（前一帧已经说了「有东西变了」）。
    await vi.advanceTimersByTimeAsync(500);
    card.push(toolCall('t3', 'edit', '再改一次'));
    card.push(toolUpdate('t3', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.method === 'edit')).toHaveLength(2);
    // 终帧不受节流约束，而 ⚠ 行还在，计数是累计的。
    const finalText = await card.close({ stopReason: 'end_turn', files: 1, failures: 3, toolCalls: 3 });
    expect(finalText).toContain('⚠ 失败 3 次');
    expect(calls.at(-1)!.text).toContain('⚠ 失败 3 次');
  });
});

describe('ACP 进度卡片 · 预算与渲染', () => {
  /**
   * `title` 与 `locations[0].path` 都是外部 agent 递过来的字段，长度与内容都不受我们控制。
   * 一段 4000 字的路径照样只占一行（按**尾部**收：`…/tools/builtins.ts` 认得出是哪个文件，
   * `/home/swim/code/Luo…` 认不出），而正文整体逐字符转义 —— 卡片里一个字符都不许被当成标记。
   */
  it('4000 字的路径与满是标记的标题：仍是一条 ≤ 预算的消息，且过得了 MarkdownV2', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const path = `/${'deep/'.repeat(800)}file.ts`;
    expect(path.length).toBeGreaterThan(4000);
    const title = '修 _foo_ 里的 *bug* [见 #12] (1.5x)';
    const card = await openAcpProgressCard(fakeBot(calls), target, options({ parseMode: 'MarkdownV2' }));
    card.push(toolCall('t1', 'edit', title, { locations: [{ path }], status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    const finalText = await card.close({ stopReason: 'end_turn', files: 1, failures: 0, toolCalls: 1 });
    expect(calls.filter((call) => call.method === 'send')).toHaveLength(1);
    for (const call of calls) {
      expect([...call.text].length).toBeLessThanOrEqual(3500); // min(maxMessageChars, 3500)
      expect(markdownV2Safe(call.text)).toEqual([]);
      expect(call.text).not.toContain(path); // 原样的 4000 字路径一次都没进消息
    }
    expect(calls[0]!.parseMode).toBe('MarkdownV2');
    // 转义是可逆的：反推回纯文本之后，标题一个字符都没丢，路径按**尾部**收所以认得出是哪个文件。
    const progress = toPlainText(calls.filter((call) => call.method === 'edit')[0]!.text, 'MarkdownV2');
    expect(progress).toContain(`现在 · ✏️ ${title}`);
    expect(progress).toMatch(/· …\/deep\/.*\/file\.ts$/m);
    expect(finalText).toContain('改动 1 个文件');
  });

  /**
   * 超预算**按段整块丢，绝不切半行**（`docs/02 §9` 红线 11：不透明单元要么原样保留、要么整体
   * 换成占位）。判据是「小预算那一帧的每一行，都在大预算那一帧里逐字节存在」—— 切了半行、
   * 或按字符硬截过，这条就不成立。
   */
  it('超预算按段整块丢：每一行都还是完整的那一行，计数行留着', async () => {
    vi.useFakeTimers();
    const feed = (card: { push(notification: unknown): void }): void => {
      card.push(plan([{ content: '读 acp-card.ts 与 stream-output.ts', status: 'completed' },
        { content: '补 openProgressCard 与用例', status: 'completed' },
        { content: '更新 docs/08 的新节', status: 'in_progress' },
        { content: '跑 typecheck 与 lint', status: 'pending' },
        { content: '贴一份真实渲染输出', status: 'pending' }]));
      for (const [index, name] of ['tools.ts', 'index.ts', 'acp-card.ts', 'output.ts'].entries()) {
        card.push(toolCall(`t${index}`, 'edit', `编辑 packages/telegram/src/${name}`, { locations: [{ path: `/repo/packages/telegram/src/${name}` }] }));
        card.push(toolUpdate(`t${index}`, 'completed'));
      }
      card.push(toolCall('bad', 'execute', '跑 pnpm lint'));
      card.push(toolUpdate('bad', 'failed'));
      card.push(thought('先把边界想清楚再动手'));
      card.push(chunk('已经把接线补完了。'));
    };
    const wide: Call[] = [];
    const wideCard = await openAcpProgressCard(fakeBot(wide), target, options());
    feed(wideCard);
    const wideText = await wideCard.close({ stopReason: 'end_turn', files: 4, failures: 1, toolCalls: 5 });
    const narrow: Call[] = [];
    const narrowCard = await openAcpProgressCard(fakeBot(narrow), target, options({ maxMessageChars: 260 }));
    feed(narrowCard);
    const narrowText = await narrowCard.close({ stopReason: 'end_turn', files: 4, failures: 1, toolCalls: 5 });
    const wideLines = wideText.split('\n');
    const narrowLines = narrowText.split('\n');
    expect([...narrowText].length).toBeLessThanOrEqual(260);
    expect(narrowLines.length).toBeLessThan(wideLines.length); // 真的丢了东西
    expect(narrowLines.filter((line) => !wideLines.includes(line))).toEqual([]);
    // 明细丢了，**计数行留着**；表头、失败行、三个计数行永不进丢弃梯。
    expect(wideLines.some((line) => line.startsWith('  ± '))).toBe(true);
    expect(narrowLines.some((line) => line.startsWith('  ± '))).toBe(false);
    expect(narrowText).toContain('改动 4 个文件');
    expect(narrowText).toContain('⚠ 失败 1 次');
    expect(narrowText).toContain('工具 5 次');
    expect(narrowLines[0]!.startsWith('🔧 omp')).toBe(true);
  });

  /**
   * **diff 绝不进消息**，只显示 `± path +A −B`。两条硬理由：① 4096 上限，一份真实 diff 一条就
   * 顶满；② 终帧那份文本要被归档、下一轮进模型上下文 —— 让外部 agent 生成的 diff 原文走这条路，
   * 等于给注入开一条不经 `untrusted()` 的门。
   */
  it('Diff 只留 ± path +A −B，patch 全文一个字节都不在消息里', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options({ dir: '/repo' }));
    const oldText = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const newText = 'const a = 1;\nconst b = 22;\nconst c = 3;\nSECRET_INJECTED_LINE\n';
    card.push(toolCall('t1', 'edit', '改 config.ts', { content: [{ type: 'diff', path: '/repo/src/config.ts', oldText, newText }] }));
    card.push(toolUpdate('t1', 'completed'));
    const finalText = await card.close({ stopReason: 'end_turn', files: 1, failures: 0, toolCalls: 1 });
    for (const call of calls) {
      expect(call.text).not.toContain('SECRET_INJECTED_LINE');
      expect(call.text).not.toContain('const b = 22;');
      expect(call.text).not.toContain('const a = 1;');
    }
    expect(finalText).toContain('改动 1 个文件');
    // 路径去掉了工作目录前缀（`/repo/`）：目录已经在表头上，每行再重复一遍只是花掉预算。
    expect(finalText).toContain('± src/config.ts +2 −1');
  });

  /**
   * 规则 7：思考只一行、只在空闲时、**永不归档**。终帧那份文本要进 `messages` 与下一轮上下文，
   * 而思考链是 agent 的内心戏（同 `docs/02` 对不透明 part 的口径）—— 显示给人看可以，钉进历史不行。
   */
  it('思考只在过程帧出现，终帧不带它；关掉之后一帧都没有', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    for (const piece of ['先把', '边界', '想清楚']) card.push(thought(piece));
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.at(-1)!.text).toContain('💭 先把边界想清楚'); // 滚动窗口，不是最后一片碎片
    const finalText = await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 0 });
    expect(finalText).not.toContain('💭');
    expect(calls.at(-1)!.text).not.toContain('💭');
    const off: Call[] = [];
    const quiet = await openAcpProgressCard(fakeBot(off), target, options({ thoughts: false }));
    quiet.push(thought('这一句不该出现'));
    await vi.advanceTimersByTimeAsync(6000);
    await quiet.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 0 });
    expect(off.every((call) => !call.text.includes('💭'))).toBe(true);
  });
});

describe('ACP 进度卡片 · 永不打断投递', () => {
  /**
   * 取消与超时**一定要留终帧**（`docs/00`「收尾那一条消息还是要发出去」）：屏幕上停着一张
   * 「现在 · ✏️ 改 …」的卡片而进程已经没了，用户没有任何办法判断它是死了还是还在跑。
   * 首帧发不出去时终帧走 `sendMessage` 而不是 `editMessageText`。
   */
  it('中途全失败之后 close() 照样渲染出终帧，且不 throw', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls, { send: true, edit: true }), target, options());
    card.push(toolCall('t1', 'edit', '改一个文件', { locations: [{ path: '/repo/a.ts' }], status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]); // 一条都没发出去
    const finalText = await card.close({ error: 'acp_cancelled', files: 2, failures: 0, toolCalls: 1 });
    expect(finalText).toContain('⛔ 已取消');
    expect(finalText).toContain('已改动 2 个文件');
  });

  it('终帧在首帧没发出去时走 sendMessage，而不是拿 null 当 message_id 去编辑', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    let broken = true;
    const api = {
      sendMessage: (_chat: string, text: string) => {
        if (broken) return Promise.reject(new Error('429: Too Many Requests: retry after 30'));
        calls.push({ method: 'send', at: Date.now(), text, messageId: 777 });
        return Promise.resolve({ message_id: 777, date: 0 });
      },
      editMessageText: (_chat: string, messageId: number, text: string) => {
        calls.push({ method: 'edit', at: Date.now(), text, messageId });
        return Promise.resolve(true);
      },
    };
    const card = await openAcpProgressCard({ api } as unknown as Bot, target, options());
    broken = false;
    await card.close({ stopReason: 'cancelled', files: 0, failures: 0, toolCalls: 0 });
    expect(calls.map((call) => call.method)).toEqual(['send']);
    expect(calls[0]!.text).toContain('已取消');
  });

  /**
   * `push()` 跑在收 `session/update` 那条路上：呈现层的任何异常都不许冒出去（同
   * `TelegramOutput.#emit` 对 `onDelivery` 的口径）。灌的这些都是真实可能的形状 —— SDK 换版本、
   * agent 不守规矩、或者一个 getter 就抛的代理。
   */
  it('push() 里任何异常都不冒出去', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    const evil = new Proxy({}, { get() { throw new Error('这个字段一读就炸'); } });
    for (const bad of [null, undefined, 42, 'plan', {}, { update: null }, { update: 'plan' },
      note({ sessionUpdate: 'plan' }), note({ sessionUpdate: 'plan', entries: 'nope' }),
      note({ sessionUpdate: 'agent_message_chunk' }), note({ sessionUpdate: 'tool_call' }),
      note({ sessionUpdate: 'tool_call', kind: 'constructor', title: {} }),
      note({ sessionUpdate: 'tool_call_update', content: 'nope' }),
      note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'image' } }),
      note({ sessionUpdate: 'usage_update', cost: 'free' }), note({ sessionUpdate: '未来的新档' }), evil]) {
      expect(() => card.push(bad)).not.toThrow();
    }
    // 灌完垃圾之后卡片照样活着，而且没有把 `undefined` / `[object Object]` 之类渲染进去。
    card.push(toolCall('t1', 'read', '读 README', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    const finalText = await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 3 });
    expect(finalText).not.toContain('undefined');
    expect(finalText).not.toContain('object Object');
    expect(finalText).toContain('✅ 完成');
    expect(calls.at(-1)!.text).toContain('✅ 完成');
  });

  it('onDelivery 抛出来也不许打断投递', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options(), { onDelivery: () => { throw new Error('日志挂了'); } });
    card.push(toolCall('t1', 'read', '读 README', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
    expect(calls.filter((call) => call.method === 'send')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'edit').length).toBeGreaterThanOrEqual(1);
  });

  /** `close()` 之后再来的 update 一律吃掉：ACP 的收尾是「最后一次编辑」，不是「还能再改一次」。 */
  it('close() 幂等，之后的 push 不再动那条消息', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    const first = await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 0 });
    const after = calls.length;
    card.push(toolCall('late', 'edit', '迟到的工具调用'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 0 })).toBe(first);
    expect(calls).toHaveLength(after);
  });

  /** `openProgressCard` 交回 `null` = 没有 Telegram 入口。ACP 照跑，只是没有卡片。 */
  it('没有 Telegram 入口时交回 null', async () => {
    // 卡片这条路不碰归档（归档只在终帧、且由调用方做），所以这里不需要一个真的库。
    const tools = new TelegramTools({ bot: () => null, archive: {} as never, maxMessageChars: () => 3900, maxMentions: () => 3, parseMode: () => 'MarkdownV2' });
    expect(await tools.openProgressCard(target, { parseMode: 'MarkdownV2', maxMessageChars: 3900, intervalMs: 5000 })).toBeNull();
  });
});
