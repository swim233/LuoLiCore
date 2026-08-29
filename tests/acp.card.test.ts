import type { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramTools, openAcpProgressCard, toPlainText, type AcpCardOptions } from '@luoli/telegram';

/**
 * ACP 运行的进度卡片（`docs/08 §6.1`）。本组验证的不是外观，而是五条不变量：
 *
 * - 一次 run 对应一条消息：`sendMessage` 恰好一次，其余全部是对该条消息的编辑；
 * - 节流确实生效：`intervalMs` 是编辑次数的上界，即时刷新有 2 秒下限；
 * - 超出预算时整段丢弃、不切分单行（`docs/02 §9` 红线 11 在 UI 上的对应）；
 * - 观测不得中断投递：`push()` 永不抛错，`close()` 在中途全部失败后仍渲染出终帧；
 * - 取消按钮走既有的 `c:<turnId>` 通道：过程帧每一帧都携带，终帧撤销。
 *
 * 参照 `tests/output.pacing.test.ts` 的形式自行实现一个伪 bot，全仓没有 mock 层。
 */

interface Markup { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
interface Extra { parse_mode?: string; reply_markup?: Markup }
/** `markup` 缺失表示该次调用未提供 `reply_markup`，而 Bot API 将其视为撤销键盘。 */
interface Call { method: 'send' | 'edit'; at: number; text: string; messageId: number; parseMode?: string; markup?: Markup }

function fakeBot(calls: Call[], broken: { send?: boolean; edit?: boolean } = {}): Bot {
  let nextId = 500;
  const api = {
    sendMessage: (_chat: string, text: string, extra?: Extra) => {
      if (broken.send) return Promise.reject(new Error('429: Too Many Requests: retry after 30'));
      nextId += 1;
      calls.push({ method: 'send', at: Date.now(), text, messageId: nextId, ...(extra?.parse_mode ? { parseMode: extra.parse_mode } : {}), ...(extra?.reply_markup ? { markup: extra.reply_markup } : {}) });
      return Promise.resolve({ message_id: nextId, date: 0 });
    },
    editMessageText: (_chat: string, messageId: number, text: string, extra?: Extra) => {
      if (broken.edit) return Promise.reject(new Error('400: Bad Request: message to edit not found'));
      calls.push({ method: 'edit', at: Date.now(), text, messageId, ...(extra?.parse_mode ? { parseMode: extra.parse_mode } : {}), ...(extra?.reply_markup ? { markup: extra.reply_markup } : {}) });
      return Promise.resolve(true);
    },
  };
  return { api } as unknown as Bot;
}

const target = { chatId: '4242', threadId: null };
/** 真实形态是 ULID（`context/engine.ts` 中的 `ulid()`），26 个字符，`c:` 加 26 即 28 字节。 */
const TURN_ID = '01JZ8QK9V4N7Y2M5B3C6D8E0F1';
const options = (overrides: Partial<AcpCardOptions> = {}): AcpCardOptions =>
  ({ parseMode: 'none', maxMessageChars: 3900, intervalMs: 5000, agent: 'omp', dir: '/home/swim/code/LuoLiCore', ...overrides });

/** `SessionNotification` 的外壳。入参有意声明为 `unknown`：卡片不得信任该结构（下面有一条专门注入异常数据的用例）。 */
const note = (update: Record<string, unknown>): unknown => ({ sessionId: 's1', update });
const toolCall = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}): unknown =>
  note({ sessionUpdate: 'tool_call', toolCallId: id, kind, title, status: 'pending', ...extra });
const toolUpdate = (id: string, status: string, extra: Record<string, unknown> = {}): unknown =>
  note({ sessionUpdate: 'tool_call_update', toolCallId: id, status, ...extra });
const chunk = (text: string): unknown => note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const thought = (text: string, messageId = 'm1'): unknown =>
  note({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } });
const plan = (entries: Array<{ content: string; status: string }>): unknown => note({ sessionUpdate: 'plan', entries });

/** MarkdownV2 的转义不变量：正文中每个特殊字符前必须有反斜杠，否则 Telegram 会判定解析失败。 */
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
   * 实测量级：6 秒的简单任务产生 82 至 131 条 update，86 秒那次产生 263 条。节流不是可选项：
   * 私聊那个桶只有 `{minTime: 1000}`（没有 per-minute reservoir），每秒一次约合 60 次每分钟，
   * 而本用例注入的 300 条中有 200 次 `tool_call`。
   */
  it('300 条 update 只发一条消息，编辑次数被 intervalMs 焊住', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    // 1 条 plan、200 条 tool_call 与 99 条 chunk 合计 300 条，分布在 30 秒内。
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
    // 一次 run 对应一条消息，这是不变量：不会发送第二条。
    expect(sends).toHaveLength(1);
    expect(new Set(edits.map((call) => call.messageId))).toEqual(new Set([sends[0]!.messageId]));
    // 上界为 ⌈时长/间隔⌉ + 3（首帧不计入编辑，即时刷新与终帧各预留一次余量）。
    expect(edits.length).toBeLessThanOrEqual(Math.ceil(30_000 / 5000) + 3);
    expect(edits.length).toBeGreaterThan(1); // 同样不允许退化为完全不刷新
    expect(finalText).toContain('工具调用 200 次');
    expect(finalText).toContain('✅ 完成');
  });

  /**
   * 渲染结果与上一帧逐字节相同时不发送，不依赖 Telegram 返回 `message is not modified` 兜底：
   * 那次调用同样占用一个槽位，且排在真正需要发送的内容之前。规则 6（`agent_message_chunk` 不驱动刷新）
   * 正是依此实现：有工具在执行时不显示正文尾部，因此那些 chunk 渲染出的帧与上一帧完全相同。
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
    await vi.advanceTimersByTimeAsync(30_000); // 经过六个间隔，不应产生任何编辑
    expect(calls.filter((call) => call.method === 'edit')).toHaveLength(afterTool);
    // 工具执行结束后正文尾部才显示，此时才需要一次编辑。
    card.push(toolUpdate('t1', 'completed'));
    await vi.advanceTimersByTimeAsync(6000);
    const shown = calls.at(-1)!.text;
    expect(shown).toContain('💬');
    expect(shown).toContain('第 39 个 token');
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
  });

  /**
   * 失败是本次执行耗时十五分钟的原因，只显示当前正在执行的内容会把它覆盖。因此 `failed` 对应的
   * ⚠ 行在后续每一帧中保留，并带累计次数；它同时触发一次绕过间隔的即时刷新，但该绕过
   * 有 2 秒下限，否则一个 200 次调用全部失败的 agent 会产生 200 次编辑。
   */
  it('失败粘住并即时刷新，但即时刷新有 2 秒地板', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    // 间隔设为 60 秒：本组中出现的每一次编辑都只可能来自即时刷新。
    const card = await openAcpProgressCard(fakeBot(calls), target, options({ intervalMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(3000);
    card.push(toolCall('t1', 'edit', '改 packages/core/src/acp/manager.ts'));
    card.push(toolUpdate('t1', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    let edits = calls.filter((call) => call.method === 'edit');
    expect(edits).toHaveLength(1); // 3 秒即刷新，而间隔为 60 秒
    expect(edits[0]!.text).toContain('⚠ 失败 1 次');
    expect(edits[0]!.text).toContain('最近：改 packages/core/src/acp/manager.ts');
    await vi.advanceTimersByTimeAsync(3000);
    card.push(toolCall('t2', 'execute', '跑 pnpm typecheck'));
    card.push(toolUpdate('t2', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    edits = calls.filter((call) => call.method === 'edit');
    expect(edits).toHaveLength(2);
    expect(edits[1]!.text).toContain('⚠ 失败 2 次');
    // 下限约束：500ms 之后的第三次失败不触发编辑（前一帧已经反映了变化）。
    await vi.advanceTimersByTimeAsync(500);
    card.push(toolCall('t3', 'edit', '再改一次'));
    card.push(toolUpdate('t3', 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.method === 'edit')).toHaveLength(2);
    // 终帧不受节流约束，⚠ 行仍然保留，计数为累计值。
    const finalText = await card.close({ stopReason: 'end_turn', files: 1, failures: 3, toolCalls: 3 });
    expect(finalText).toContain('⚠ 失败 3 次');
    expect(calls.at(-1)!.text).toContain('⚠ 失败 3 次');
  });
});

describe('ACP 进度卡片 · 预算与渲染', () => {
  /**
   * `title` 与 `locations[0].path` 都是外部 agent 传入的字段，长度与内容均不受本方控制。
   * 一段 4000 字的路径同样只占一行（按尾部截断：`…/tools/builtins.ts` 可辨识具体文件，
   * `/home/swim/code/Luo…` 则不能），而正文整体逐字符转义，卡片中不允许任何字符被当作标记解析。
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
      expect(call.text).not.toContain(path); // 原始的 4000 字路径未进入任何消息
    }
    expect(calls[0]!.parseMode).toBe('MarkdownV2');
    // 转义可逆：还原为纯文本后标题没有丢失任何字符，路径按尾部截断因而仍可辨识具体文件。
    const progress = toPlainText(calls.filter((call) => call.method === 'edit')[0]!.text, 'MarkdownV2');
    expect(progress).toContain(`当前 · ✏️ ${title}`);
    expect(progress).toMatch(/· …\/deep\/.*\/file\.ts$/m);
    expect(finalText).toContain('改动 1 个文件');
  });

  /**
   * 超出预算时按段整块丢弃，不切分单行（`docs/02 §9` 红线 11：不透明单元要么原样保留，要么整体
   * 替换为占位）。判据是小预算帧中的每一行都在大预算帧中逐字节存在；一旦切分了单行
   * 或按字符硬截断，该判据即不成立。
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
    expect(narrowLines.length).toBeLessThan(wideLines.length); // 确实丢弃了内容
    expect(narrowLines.filter((line) => !wideLines.includes(line))).toEqual([]);
    // 明细被丢弃而计数行保留；表头、失败行与三个计数行永不进入丢弃序列。
    expect(wideLines.some((line) => line.startsWith('  ± '))).toBe(true);
    expect(narrowLines.some((line) => line.startsWith('  ± '))).toBe(false);
    expect(narrowText).toContain('改动 4 个文件');
    expect(narrowText).toContain('⚠ 失败 1 次');
    expect(narrowText).toContain('工具调用 5 次');
    expect(narrowLines[0]!.startsWith('🔧 omp')).toBe(true);
  });

  /**
   * diff 不进入消息，只显示 `± path +A −B`。两条理由：其一，4096 字符上限下一份真实 diff 即可
   * 占满；其二，终帧文本会被归档并在下一轮进入模型上下文，让外部 agent 生成的 diff 原文走这条路径
   * 等于开放一条不经 `untrusted()` 的注入入口。
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
    // 路径去除了工作目录前缀（`/repo/`）：该目录已在表头显示，每行重复只会消耗预算。
    expect(finalText).toContain('± src/config.ts +2 −1');
  });

  /**
   * 规则 7：思考内容只占一行、只在空闲时显示、永不归档。终帧文本会进入 `messages` 与下一轮上下文，
   * 而思考链属于 agent 的内部推理（与 `docs/02` 对不透明 part 的口径一致），可以展示给用户，但不应写入历史。
   */
  it('思考只在过程帧出现，终帧不带它；关掉之后一帧都没有', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), target, options());
    for (const piece of ['先把', '边界', '想清楚']) card.push(thought(piece));
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.at(-1)!.text).toContain('💭 先把边界想清楚'); // 采用滚动窗口，而非只保留最后一个片段
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
   * 取消与超时必须保留终帧（`docs/00` 中收尾消息仍要发出这条要求）：屏幕上停留一张
   * 显示当前正在编辑的卡片而进程已退出时，用户无法判断它是已终止还是仍在运行。
   * 首帧发送失败时终帧走 `sendMessage` 而非 `editMessageText`。
   */
  it('中途全失败之后 close() 照样渲染出终帧，且不 throw', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls, { send: true, edit: true }), target, options());
    card.push(toolCall('t1', 'edit', '改一个文件', { locations: [{ path: '/repo/a.ts' }], status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]); // 未发送任何消息
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
   * `push()` 位于接收 `session/update` 的路径上：呈现层的任何异常都不得向外抛出（与
   * `TelegramOutput.#emit` 对 `onDelivery` 的口径一致）。注入的这些都是实际可能出现的结构：SDK 版本变更、
   * agent 不遵守约定，或一个在 getter 中即抛错的代理对象。
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
    // 注入异常数据之后卡片仍然可用，且没有把 `undefined` 或 `[object Object]` 之类渲染进去。
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

  /** `close()` 之后到达的 update 一律丢弃：ACP 的收尾是最后一次编辑，而非允许再次修改。 */
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

  /** `openProgressCard` 返回 `null` 表示没有 Telegram 入口。ACP 照常执行，只是不显示卡片。 */
  it('没有 Telegram 入口时交回 null', async () => {
    // 卡片这条路径不涉及归档（归档只在终帧进行且由调用方执行），因此这里无需真实数据库。
    const tools = new TelegramTools({ bot: () => null, archive: {} as never, maxMessageChars: () => 3900, maxMentions: () => 3, parseMode: () => 'MarkdownV2' });
    expect(await tools.openProgressCard(target, { parseMode: 'MarkdownV2', maxMessageChars: 3900, intervalMs: 5000 })).toBeNull();
  });
});

describe('ACP 进度卡片 · 取消按钮', () => {
  /**
   * 一次 ACP 执行可长达十五分钟（`agent.acp.agents[].timeoutMs` 默认 900000），而这整段时间内用户面前
   * 只有这一张卡片，此前要终止它需另外发送一条 `/cancel`。按钮走的是 `bot.ts` 中既有的
   * `c:<turnId>` 通道（`docs/08 §6`：那里已判定点击者是发起人或 owner），不属于新的
   * callback 类型，因此适配层这一侧的不变量只有两条：payload 恰好为 `c:` 加本轮 turnId，
   * 且每一帧都重新附加，因为 `editMessageText` 不带 `reply_markup` 即等同撤销键盘。
   */
  it('过程帧每一帧都带按钮，callback_data 恰好是 c:<turnId>', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), { ...target, turnId: TURN_ID }, options());
    const keyboard = { inline_keyboard: [[{ text: '⛔ 取消', callback_data: `c:${TURN_ID}` }]] };
    expect(calls[0]!.markup).toEqual(keyboard);
    card.push(toolCall('t1', 'edit', '改 packages/telegram/src/acp-card.ts', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    card.push(toolCall('t2', 'execute', '跑 pnpm typecheck', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    const edits = calls.filter((call) => call.method === 'edit');
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.every((call) => call.markup !== undefined)).toBe(true);
    for (const call of calls) expect(call.markup).toEqual(keyboard); // 64 字节上界：`c:` 加 ULID(26) 合计 28
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 2 });
  });

  /**
   * 终帧撤销键盘与修改正文在同一次调用中完成（参照 `TelegramPromptChannel.settle` 的口径：拆成两次
   * 会在节流器中排队两轮，而表达的是同一件事）。若保留按钮，点击后 `registry.cancel` 判定为 false，
   * 因为该轮早已通过 `finish()` 退出注册表，而用户看到的提示是只有发起人或管理员可以取消，
   * 与真实原因完全无关，比不提供按钮更糟。
   */
  it('close() 之后键盘没了，且撤键盘没有多占一次编辑', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), { ...target, turnId: TURN_ID }, options());
    card.push(toolCall('t1', 'edit', '改一个文件', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    const before = calls.length;
    await card.close({ stopReason: 'end_turn', files: 1, failures: 0, toolCalls: 1 });
    expect(calls.length).toBe(before + 1); // 一次编辑，而非撤销键盘与修改正文两次
    expect(calls.at(-1)!.method).toBe('edit');
    expect(calls.at(-1)!.markup).toBeUndefined();
    expect(calls.at(-1)!.text).toContain('✅ 完成');
    // 取消档位同理：终帧文案改变，按钮同样撤销。
    const cancelled: Call[] = [];
    const other = await openAcpProgressCard(fakeBot(cancelled), { ...target, turnId: TURN_ID }, options());
    await other.close({ error: 'acp_cancelled', files: 2, failures: 0, toolCalls: 3 });
    expect(cancelled.at(-1)!.text).toContain('⛔ 已取消');
    expect(cancelled.at(-1)!.markup).toBeUndefined();
  });

  /**
   * `turnId` 在类型上为可选，缺失时不附加任何按钮。空 payload（`c:`）在
   * `TurnRegistry.cancel` 侧必然判定为 false，而一个点击后必然给出错误响应的按钮比没有按钮更糟。
   * 64 字节是 Bot API 对 `callback_data` 的硬上界，超限时 Telegram 拒绝的是整条 `sendMessage`，
   * 那样连卡片都不存在，因此同样退化为不附加按钮。
   */
  it('turnId 缺席或超过 64 字节上界时一帧都不带按钮', async () => {
    vi.useFakeTimers();
    for (const turnId of [undefined, '', 'x'.repeat(63)]) {
      const calls: Call[] = [];
      const card = await openAcpProgressCard(fakeBot(calls), { ...target, ...(turnId === undefined ? {} : { turnId }) }, options());
      card.push(toolCall('t1', 'read', '读 README', { status: 'in_progress' }));
      await vi.advanceTimersByTimeAsync(6000);
      await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((call) => call.markup === undefined)).toBe(true);
    }
  });

  /**
   * 附加按钮不得改变节流行为。判据是同一串 update 输入两张卡片（一张带按钮、一张不带）后，
   * 编辑次数与逐帧正文完全一致。键盘纳入快照比较判据（见下一条）之后，最容易出错的是
   * 让它额外触发几次刷新：过程帧的键盘恒定，因此它对判据的影响也必须恒定。
   */
  it('挂上按钮之后编辑次数与逐帧正文都不变', async () => {
    vi.useFakeTimers();
    const feed = async (card: { push(notification: unknown): void }): Promise<void> => {
      card.push(plan([{ content: '读那 700 行', status: 'in_progress' }, { content: '补用例', status: 'pending' }]));
      for (let index = 0; index < 30; index += 1) {
        card.push(toolCall(`t${index}`, index % 2 ? 'read' : 'edit', `处理第 ${index} 个文件`, { status: index % 3 ? 'completed' : 'in_progress' }));
        card.push(chunk(`第 ${index} 段。`));
        await vi.advanceTimersByTimeAsync(400);
      }
    };
    const bare: Call[] = [];
    const bareCard = await openAcpProgressCard(fakeBot(bare), target, options());
    await feed(bareCard);
    await bareCard.close({ stopReason: 'end_turn', files: 3, failures: 0, toolCalls: 30 });
    const withButton: Call[] = [];
    const buttonCard = await openAcpProgressCard(fakeBot(withButton), { ...target, turnId: TURN_ID }, options());
    await feed(buttonCard);
    await buttonCard.close({ stopReason: 'end_turn', files: 3, failures: 0, toolCalls: 30 });
    expect(withButton.map((call) => `${call.method}:${call.text}`)).toEqual(bare.map((call) => `${call.method}:${call.text}`));
    expect(bare.every((call) => call.markup === undefined)).toBe(true);
    expect(withButton.filter((call) => call.markup !== undefined)).toHaveLength(withButton.length - 1); // 只有终帧那一次不带键盘
  });

  /**
   * 键盘从有到无是一次真实变化，因此它纳入快照比较的判据。若不计入，存在一种正文确实未变的收尾：
   * 表头本身超出预算时，丢弃序列执行完之后那道按码点硬截断的兜底会把每一帧都截成表头的同一段
   * （计时器与终帧的 verdict 行都位于截断点之后），于是逐字节相同即不发送会吞掉整个终帧，
   * 那排按钮就会永久留在一张已结束的卡片上。
   */
  it('正文被硬收成同一串时终帧照旧发出去，键盘撤得掉', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const card = await openAcpProgressCard(fakeBot(calls), { ...target, turnId: TURN_ID },
      options({ maxMessageChars: 64, agent: 'a'.repeat(200), dir: '' }));
    card.push(toolCall('t1', 'execute', '跑 pnpm test', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1); // 每一帧都截成同一段，过程中不应产生任何编辑
    expect(calls[0]!.markup).toBeDefined();
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
    expect(calls.map((call) => call.method)).toEqual(['send', 'edit']);
    expect(calls[1]!.text).toBe(calls[0]!.text); // 正文没有任何字节变化
    expect(calls[1]!.markup).toBeUndefined();
  });

  /**
   * parse-entities 降级是另一次 `editMessageText`（正文替换为 `toPlainText`）。若遗漏
   * `reply_markup`，按钮会在第一次渲染被拒之后静默消失，而卡片正文中的每个变量都是
   * 外部 agent 传入的字符串，该降级属于常态而非异常。
   */
  it('parse-entities 降级重编辑照旧带着按钮', async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const api = {
      sendMessage: (_chat: string, text: string, extra?: Extra) => {
        calls.push({ method: 'send', at: Date.now(), text, messageId: 901, ...(extra?.reply_markup ? { markup: extra.reply_markup } : {}) });
        return Promise.resolve({ message_id: 901, date: 0 });
      },
      editMessageText: (_chat: string, messageId: number, text: string, extra?: Extra) => {
        if (extra?.parse_mode) return Promise.reject(new Error("400: Bad Request: can't parse entities: unexpected end of input"));
        calls.push({ method: 'edit', at: Date.now(), text, messageId, ...(extra?.reply_markup ? { markup: extra.reply_markup } : {}) });
        return Promise.resolve(true);
      },
    };
    const card = await openAcpProgressCard({ api } as unknown as Bot, { ...target, turnId: TURN_ID }, options({ parseMode: 'MarkdownV2' }));
    card.push(toolCall('t1', 'edit', '改 config.ts', { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(6000);
    const fallback = calls.filter((call) => call.method === 'edit');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.markup?.inline_keyboard[0]![0]!.callback_data).toBe(`c:${TURN_ID}`);
    await card.close({ stopReason: 'end_turn', files: 0, failures: 0, toolCalls: 1 });
    expect(calls.at(-1)!.markup).toBeUndefined();
  });
});
