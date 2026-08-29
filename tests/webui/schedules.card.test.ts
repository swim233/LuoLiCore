import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import SchedulesCard from '../../packages/webui/src/components/tasks/SchedulesCard.vue';
import ConfirmHost from '../../packages/webui/src/ui/ConfirmHost.vue';
import { confirmBox, dismissConfirm, runConfirmed } from '../../packages/webui/src/ui/confirm';
import { toasts } from '../../packages/webui/src/ui/toast';

/**
 * 定时任务卡的判据防线（`.vue` 模板不进 `tsc --noEmit`，这些分支只能在这里约束）。
 *
 * 这张卡上有一处两次操作各自都不报错、结果却错误的路径：`GET /api/schedules` 发的 `at` 是
 * `toISOString()` 的 UTC 瞬时，而 `POST`/`PATCH` 接收的是任务行所记时区的墙钟。
 * 直接把 ISO 回填进输入框时，`Asia/Shanghai` 上一个早八点的任务显示为 `…T00:00:00.000Z`，
 * 运维改成 `08:00` 再保存，任务被静默推后 8 小时。第一条用例覆盖的就是它。
 *
 * 其余几条约束的是编辑弹窗不得引入提权入口：会话 / 模式 / 时区 / 创建者四格只读，
 * `PATCH` 的 body 里不得出现 `key`/`chatId`/`mode`。
 */

const CHATS = [{ key: 'chat:c1' }, { key: 'chat:c2' }];

/** 三行覆盖三种形态：cron 且不静默 / 一次性且静默并超过连续静默阈值 / 已停用。 */
function jobs(): unknown[] {
  return [
    { id: 'j1', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '555', name: '每日早报', mode: 'agent', state: 'active',
      chatLabel: '阿离', creatorLabel: '主人', cron: '0 8 * * *', timezone: 'UTC', payload: '汇总昨天群里聊了什么', runCount: 2,
      nextRun: '2026-08-22T00:00:00.000Z', lastRunAt: 1_787_000_000_000, lastState: 'committed', silent: false, silentStreak: 0 },
    // `at` 是 UTC 瞬时，行上的时区是 Asia/Shanghai，因此回填必须是 2026-08-19T08:00。
    { id: 'j2', key: 'chat:c2', chatId: 'c2', threadId: null, createdBy: '555', name: '中午查一次更新', mode: 'agent', state: 'active',
      chatLabel: '隆福饭搭子', creatorLabel: '主人', at: '2026-08-19T00:00:00.000Z', timezone: 'Asia/Shanghai',
      payload: '有更新就说，没有就静默', runCount: 12, silent: true, silentStreak: 12,
      nextRun: '2026-08-19T00:00:00.000Z', lastRunAt: 1_787_000_000_000, lastState: 'silent' },
    { id: 'j3', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '555', name: '停掉的那条', mode: 'notify', state: 'cancelled',
      chatLabel: '阿离', creatorLabel: '主人', cron: '*/30 * * * *', timezone: 'UTC', payload: '该喝水了', runCount: 7,
      lastRunAt: 1_787_000_000_000, lastState: 'cancelled', silent: false, silentStreak: 0 },
  ];
}
const ENVELOPE = (): unknown => ({ available: true, enabled: true, timezone: 'UTC',
  settings: { maxPerChat: 20, minIntervalMinutes: 5, maxPayloadChars: 2000 }, jobs: jobs(), total: 3, truncated: false });

/** 写操作只需返回保存后的那一行：卡片只用它的 `name` / `nextRun` 拼提示。 */
function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const data = url === '/api/schedules' && (init?.method ?? 'GET') === 'GET' ? ENVELOPE()
      : url.endsWith('/purge') ? { removed: true, name: '每日早报', wasActive: true }
        : { id: 'j2', name: '中午查一次更新', nextRun: '2026-08-19T00:00:00.000Z', cancelled: true, started: true };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}
function calls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}
function lastWrite(method: string): { url: string; body: Record<string, unknown> } {
  const hit = calls().filter(([, init]) => init?.method === method).at(-1);
  expect(hit, `没有发出任何 ${method} 请求`).toBeDefined();
  return { url: hit![0], body: JSON.parse(String(hit![1]!.body ?? '{}')) as Record<string, unknown> };
}

async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}
/** `UiModal` / `UiSelect` 都 Teleport 到 body，需摊平回组件树才查得到。 */
async function open(): Promise<VueWrapper> {
  const wrapper = mount(SchedulesCard, { props: { tick: 0, chats: CHATS }, global: { stubs: { teleport: true } } });
  await settle(wrapper);
  return wrapper;
}
function rowOf(wrapper: VueWrapper, name: string) {
  const row = wrapper.findAll('tbody tr').find((entry) => entry.text().includes(name));
  expect(row, `「${name}」那一行没渲染出来`).toBeDefined();
  return row!;
}
async function edit(wrapper: VueWrapper, name: string): Promise<void> {
  const button = rowOf(wrapper, name).findAll('button').find((entry) => entry.text() === '编辑');
  expect(button, `「${name}」那一行没有〔编辑〕入口`).toBeDefined();
  await button!.trigger('click');
  await settle(wrapper);
}
const fieldValue = (wrapper: VueWrapper, field: string): string =>
  (wrapper.find(`[data-field="${field}"]`).element as HTMLInputElement).value;

describe('定时任务卡', () => {
  beforeEach(() => { stubFetch(); dismissConfirm(); toasts.splice(0, toasts.length); });

  /**
   * 本批改动中最易出错的一处。回填走 `toWallClock(job.at, job.timezone)`：
   * UTC 的 `2026-08-19T00:00Z` 在 `Asia/Shanghai` 上是 `2026-08-19T08:00`。
   * 直接填入 ISO 时这一格会显示 `2026-08-19T00:00:00.000Z`，而两次操作各自都不报错。
   */
  it('编辑一次性任务时，at 按行上的时区折算成墙钟回填', async () => {
    const wrapper = await open();
    await edit(wrapper, '中午查一次更新');
    expect(fieldValue(wrapper, 'at')).toBe('2026-08-19T08:00');
    // 反向断言：不能是 ISO 瞬时那一串。
    expect(fieldValue(wrapper, 'at')).not.toContain('Z');
    wrapper.unmount();
  });

  it('编辑时会话 / 模式 / 时区三格只读，创建者也只读', async () => {
    const wrapper = await open();
    await edit(wrapper, '中午查一次更新');
    for (const field of ['chat', 'mode', 'timezone', 'creator']) {
      const control = wrapper.find(`[data-field="${field}"]`);
      expect(control.exists(), `编辑弹窗里没有 ${field} 这一格`).toBe(true);
      expect(control.attributes('disabled'), `${field} 这一格是可写的`).toBeDefined();
    }
    // 会话那一格显示的是 chatLabel 而不是裸 key：辨认不出会话时，这条只读说明就失去意义。
    expect(fieldValue(wrapper, 'chat')).toBe('隆福饭搭子');
    expect(fieldValue(wrapper, 'timezone')).toBe('Asia/Shanghai');
    expect(fieldValue(wrapper, 'creator')).toBe('主人');
    // 新建时这三格反过来：会话可选、模式可选、没有时区与创建者。
    await wrapper.findAll('button').find((entry) => entry.text().includes('新建定时任务'))!.trigger('click');
    await settle(wrapper);
    expect(wrapper.find('[data-field="chat"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-field="mode"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-field="timezone"]').exists()).toBe(false);
    expect(wrapper.find('[data-field="creator"]').exists()).toBe(false);
    wrapper.unmount();
  });

  /**
   * `PATCH` 的 body 只发送实际修改的字段，且不得出现 `key`/`chatId`/`mode`。
   * 全字段重发不只是冗余：服务端会连带重新校验触发时间，于是运维把 `minIntervalMinutes`
   * 从 5 调到 60 之后，只改正文的请求会以 `interval_too_short` 失败。
   */
  it('保存走 PATCH，body 里没有 key / chatId / mode，且只带改动过的字段', async () => {
    const wrapper = await open();
    await edit(wrapper, '中午查一次更新');
    await wrapper.find('[data-field="name"]').setValue('改个名字');
    await wrapper.findAll('.modal-foot button').find((entry) => entry.text() === '保存')!.trigger('click');
    await settle(wrapper);
    const { url, body } = lastWrite('PATCH');
    expect(url).toBe('/api/schedules/j2');
    expect(Object.keys(body).sort()).toEqual(['name']);
    for (const forbidden of ['key', 'chatId', 'threadId', 'createdBy', 'mode']) {
      expect(body, `PATCH 的 body 里出现了 ${forbidden}`).not.toHaveProperty(forbidden);
    }
    wrapper.unmount();
  });

  it('改了时间就发墙钟串本身，不发 ISO 瞬时', async () => {
    const wrapper = await open();
    await edit(wrapper, '中午查一次更新');
    await wrapper.find('[data-field="at"]').setValue('2026-08-20T09:30');
    await wrapper.findAll('.modal-foot button').find((entry) => entry.text() === '保存')!.trigger('click');
    await settle(wrapper);
    expect(lastWrite('PATCH').body).toEqual({ at: '2026-08-20T09:30' });
    wrapper.unmount();
  });

  /** 格式校验只做非空与形状检查，且不发请求。cron 一律不解析。 */
  it('时间格式不对时不发请求，只出一条提示', async () => {
    const wrapper = await open();
    await edit(wrapper, '中午查一次更新');
    await wrapper.find('[data-field="at"]').setValue('明天早上八点');
    await wrapper.findAll('.modal-foot button').find((entry) => entry.text() === '保存')!.trigger('click');
    await settle(wrapper);
    expect(calls().some(([, init]) => init?.method === 'PATCH'), '格式不对却把请求发出去了').toBe(false);
    expect(toasts.at(-1)?.severity).toBe('warn');
    wrapper.unmount();
  });

  it('已停用的行：弹窗表单整体只读，只剩看和删', async () => {
    const wrapper = await open();
    const row = rowOf(wrapper, '停掉的那条');
    // 非 active 行只有〔编辑〕这一个入口。
    expect(row.findAll('button').map((entry) => entry.text())).toEqual(['编辑']);
    await edit(wrapper, '停掉的那条');
    for (const field of ['name', 'trigger', 'cron', 'text']) {
      expect(wrapper.find(`[data-field="${field}"]`).attributes('disabled'), `${field} 这一格在已停用的任务上还能改`).toBeDefined();
    }
    expect((wrapper.find('[data-field="silent"] input').element as HTMLInputElement).disabled).toBe(true);
    const footer = wrapper.findAll('.modal-foot button');
    expect(footer.find((entry) => entry.text() === '保存')!.attributes('disabled')).toBeDefined();
    expect(footer.map((entry) => entry.text())).toContain('永久删除');
    wrapper.unmount();
  });

  it('静默那一行带「静默」标签，连续静默超过阈值时行上常驻一条提示', async () => {
    const wrapper = await open();
    const silent = rowOf(wrapper, '中午查一次更新');
    // 模式列（第 3 格）：`lastState='silent'` 在「上一次」那一列同样显示静默，因此必须精确定位这一格。
    expect(silent.findAll('td')[2]!.text()).toContain('静默');
    expect(rowOf(wrapper, '每日早报').findAll('td')[2]!.text()).not.toContain('静默');
    expect(silent.text()).toContain('12');
    expect(silent.find('.detail-truncated').exists(), '连续静默 12 次的行上没有常驻提示').toBe(true);
    // 阈值以下不提示（`每日早报` 的 streak 是 0）。
    expect(rowOf(wrapper, '每日早报').find('.detail-truncated').exists()).toBe(false);
    wrapper.unmount();
  });

  /**
   * 硬删只出现在弹窗 footer 中，行内不得有任何删除入口：与「停掉」两个红按钮并排必然误触，
   * 而两者差别很大：停用后行仍在，删除会连同运行历史一并清除。
   */
  it('硬删走 /purge，且行内没有任何删除入口', async () => {
    const wrapper = await open();
    for (const row of wrapper.findAll('tbody tr')) {
      for (const label of row.findAll('button').map((entry) => entry.text())) {
        expect(label, `行内出现了删除入口：${label}`).not.toContain('删除');
      }
    }
    await edit(wrapper, '每日早报');
    await wrapper.findAll('.modal-foot button').find((entry) => entry.text() === '永久删除')!.trigger('click');
    await settle(wrapper);
    expect(confirmBox.value.open, '硬删没有走二次确认').toBe(true);
    // 二次确认必须与「停掉」明确区分：文案说明运行历史一并删除，而不是行仍保留。
    expect(confirmBox.value.title).toContain('永久删除');
    expect(confirmBox.value.detail).toContain('运行历史');
    expect(confirmBox.value.detail).not.toContain('retentionDays');
    await runConfirmed();
    await settle(wrapper);
    const { url, body } = lastWrite('POST');
    expect(url).toBe('/api/schedules/j1/purge');
    expect(body).toEqual({});
    wrapper.unmount();
  });

  /**
   * 两层弹窗的层级。所有遮罩都是同一个 `.ui-overlay`（同一个 z-index），同层只能由 DOM 顺序
   * 决定先后；而 `ConfirmHost` 在 `App.vue` 里最先挂载，teleport 锚点排在所有页内弹窗之前。
   * 于是在编辑弹窗里点〔永久删除〕弹出的确认框反被那张编辑弹窗遮住，表现为点击后没有反应。
   *
   * 修法是在 `styles.css` 里给确认框的遮罩单独提升一层，而不是先关闭编辑弹窗再询问（关闭后
   * 用户看不到要删除的是哪一条）。两侧都要约束：DOM 上确认框带该钩子，CSS 上该钩子层级更高。
   */
  it('编辑弹窗开着时点〔永久删除〕，确认框在最上层', async () => {
    document.body.innerHTML = '';
    // 顺序照 `App.vue`：ConfirmHost 先挂，它的 teleport 锚点因此排在卡片弹窗之前。
    const host = mount(ConfirmHost);
    const wrapper = mount(SchedulesCard, { props: { tick: 0, chats: CHATS } });
    await settle(wrapper);
    await edit(wrapper, '每日早报');
    const purge = [...document.body.querySelectorAll('.modal-foot button')].find((entry) => entry.textContent?.includes('永久删除'));
    expect(purge, '编辑弹窗的 footer 里没有〔永久删除〕').toBeDefined();
    (purge as HTMLButtonElement).click();
    await settle(wrapper);

    const overlays = [...document.body.querySelectorAll('.ui-overlay')];
    expect(overlays.length, '编辑弹窗被提前关掉了 —— 这是在绕开层级问题，不是解决它').toBe(2);
    const box = overlays.find((entry) => entry.querySelector('.confirm-detail'));
    expect(box, '确认框的遮罩上没有那个用来抬层的钩子（`.confirm-detail`）').toBeDefined();
    const editor = overlays.find((entry) => entry !== box)!;
    expect(editor.textContent, '底下那张应该还是「每日早报」的编辑弹窗').toContain('每日早报');
    // 复现：确认框在 DOM 里排在前面，所以同 z-index 时它就是被盖住的那一张。
    expect(box!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
      '确认框已经排在编辑弹窗之后了 —— 这条用例的前提没了，下面那半 CSS 断言要重写').toBeTruthy();
    // 另一半在 CSS 里：钩子命中的那条规则的层级必须高于普通遮罩。
    const css = readFileSync('packages/webui/src/styles.css', 'utf8');
    const base = /^\.ui-overlay\s*\{[^}]*z-index:\s*(\d+)/m.exec(css);
    const raised = /^\.ui-overlay:has\(\.confirm-detail\)\s*\{[^}]*z-index:\s*(\d+)/m.exec(css);
    expect(base, 'styles.css 里找不到 `.ui-overlay` 的 z-index').not.toBeNull();
    expect(raised, 'styles.css 里没有给确认框抬层的那条规则').not.toBeNull();
    expect(Number(raised![1]), '确认框的遮罩没有比普通弹窗高').toBeGreaterThan(Number(base![1]));

    // 删除成功之后编辑弹窗才关闭：失败时保持打开，用户仍可改为执行「停掉」。
    await runConfirmed();
    await settle(wrapper);
    expect(lastWrite('POST').url).toBe('/api/schedules/j1/purge');
    expect(document.body.querySelectorAll('.ui-overlay').length, '删成功之后两张弹窗都该收掉').toBe(0);
    wrapper.unmount();
    host.unmount();
  });

  /** 「停掉」「立即触发」同样改用共享确认框：`window.confirm` 在这套控制台上不可控，happy-dom 里未实现。 */
  it('停掉与立即触发都走共享确认框，不用 window.confirm', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const wrapper = await open();
    const button = (label: string) => rowOf(wrapper, '每日早报').findAll('button').find((entry) => entry.text() === label)!;
    await button('停掉').trigger('click');
    await settle(wrapper);
    expect(confirmBox.value.open).toBe(true);
    expect(confirmBox.value.detail).toContain('retentionDays');
    await runConfirmed();
    await settle(wrapper);
    expect(lastWrite('DELETE').url).toBe('/api/schedules/j1');

    await button('立即触发').trigger('click');
    await settle(wrapper);
    // agent 模式的代价要写进确认框：点击一次即产生一次真实模型调用。
    expect(confirmBox.value.detail).toContain('产生费用');
    await runConfirmed();
    await settle(wrapper);
    expect(lastWrite('POST').url).toBe('/api/schedules/j1/trigger');
    expect(nativeConfirm).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  /** 新建那条路径未作改动：`key` / `mode` 照常发送，`silent` 是本次新增的一项。 */
  it('新建仍然发 POST，body 带 key / mode / silent', async () => {
    const wrapper = await open();
    await wrapper.findAll('button').find((entry) => entry.text().includes('新建定时任务'))!.trigger('click');
    await settle(wrapper);
    await wrapper.find('[data-field="name"]').setValue('每天中午看一眼');
    await wrapper.find('[data-field="text"]').setValue('有更新就说');
    await wrapper.findAll('.modal-foot button').find((entry) => entry.text() === '创建')!.trigger('click');
    await settle(wrapper);
    const { url, body } = lastWrite('POST');
    expect(url).toBe('/api/schedules');
    expect(body).toEqual({ key: 'chat:c1', name: '每天中午看一眼', mode: 'notify', text: '有更新就说', silent: false, cron: '0 8 * * *' });
    wrapper.unmount();
  });

  /** `notify` 不调用模型，没有调用方能声明不投递，因此该开关必须置灰，而不是可写入但运行时不读取。 */
  it('notify 模式下静默开关置灰', async () => {
    const wrapper = await open();
    await wrapper.findAll('button').find((entry) => entry.text().includes('新建定时任务'))!.trigger('click');
    await settle(wrapper);
    const box = (): HTMLInputElement => wrapper.find('[data-field="silent"] input').element as HTMLInputElement;
    expect(box().disabled, 'notify 下静默开关还能点').toBe(true);
    const mode = wrapper.findAllComponents({ name: 'UiSelect' }).find((entry) => entry.attributes('data-field') === 'mode');
    mode!.vm.$emit('update:modelValue', 'agent');
    await settle(wrapper);
    expect(box().disabled).toBe(false);
    wrapper.unmount();
  });
});
