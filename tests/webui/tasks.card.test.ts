import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { confirmBox, dismissConfirm, runConfirmed } from '../../packages/webui/src/ui/confirm';
import { toasts } from '../../packages/webui/src/ui/toast';

/**
 * 任务卡的行为防线。
 *
 * `.vue` 模板**不进 `tsc --noEmit`**（根 tsconfig 里那条 `packages/**\/*.vue` 是空转，
 * `ConsoleView.vue` 开头那段注释自陈过这件事害过人），所以这一张卡上所有说话算数的判据
 * —— 哪一行给〔取消〕、点行内按钮会不会顺带弹出详情、翻页发的是第几页 —— 只能在这里焊住。
 *
 * 尤其是 `@click.stop`：`DataGrid` 的 `row-click` 挂在 `<tr>` 上，漏掉 stop 的表现是「点取消的
 * 同时弹出详情框」—— 界面上两件事都发生了，看起来像随机抽风。全站只有 Agent 表那个〔试跑〕
 * （`components/workers/WorkerRunsCard.vue` 里的轮次跳转）是同样的 clickable + 行内按钮组合。
 */

const NOW = 1_760_000_000_000;
const RUNNING = { id: 't1', turn_id: 'turn_aaaaaaaaaaaa', agent_run_id: 'run1', chat_id: '-1001', user_id: '555',
  title: '查一下今天的更新', state: 'running', result_summary: null,
  created_at: NOW - 120_000, updated_at: NOW - 30_000, finished_at: null, chatLabel: '隆福饭搭子', userLabel: '主人' };
const DONE = { id: 't2', turn_id: 'turn_bbbbbbbbbbbb', agent_run_id: null, chat_id: '8899001', user_id: '555',
  title: '整理昨天的群聊', state: 'done', result_summary: '一共 12 条，主要在聊周末去哪。',
  created_at: NOW - 86_400_000, updated_at: NOW - 86_000_000, finished_at: NOW - 86_000_000, chatLabel: '阿离', userLabel: '主人' };

/** `GET /api/tasks/:id` 的两份详情。列表行不带 `progress`/`placeholder_tg_message_id`，详情才带。 */
const DETAILS: Record<string, unknown> = {
  t1: { ...RUNNING, placeholder_tg_message_id: 4242, progress: { step: 3, note: '正在读第 3 个仓库' },
    turn: { state: 'running', steps: 3, toolCalls: 5, costUsd: 0.0123, error: null },
    agentRun: { workerKind: 'lw', agentName: 'worker', modelAlias: 'fast', state: 'running', resultSummary: null } },
  t2: { ...DONE, placeholder_tg_message_id: null, progress: null,
    turn: { state: 'done', steps: 7, toolCalls: 11, costUsd: 0.2, error: null },
    agentRun: null },
};

/** 每个用例自己调 `stubFetch()` 决定这一次的列表形状与写操作的结果。删成功时夹具真的少一行。 */
interface Fixture { items: Array<{ id: string }>; total: number; deleteFails?: { status: number; code: string; message: string } }
let calls: Array<{ url: string; method: string }> = [];

function stubFetch(fixture: Fixture): void {
  calls = [];
  const ok = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const [path, query] = url.split('?');
    if (path === '/api/tasks') {
      const size = Number(new URLSearchParams(query ?? '').get('size') ?? 20);
      const page = Number(new URLSearchParams(query ?? '').get('page') ?? 1);
      return ok({ items: fixture.items.slice((page - 1) * size, page * size), total: fixture.total, page, size });
    }
    if (path?.startsWith('/api/tasks/')) {
      const id = path.slice('/api/tasks/'.length);
      if (method === 'DELETE') {
        if (fixture.deleteFails) return fail(fixture.deleteFails.status, fixture.deleteFails.code, fixture.deleteFails.message);
        const index = fixture.items.findIndex((item) => item.id === id);
        if (index >= 0) { fixture.items.splice(index, 1); fixture.total -= 1; }
        return ok({ removed: true });
      }
      return DETAILS[id] ? ok(DETAILS[id]) : fail(404, 'not_found', '任务不存在');
    }
    if (/^\/api\/turns\/.+\/cancel$/.test(path ?? '')) return ok({ cancelled: true });
    return ok({});
  }));
}

async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}
async function mountCard(): Promise<VueWrapper> {
  const { default: TasksCard } = await import('../../packages/webui/src/components/tasks/TasksCard.vue');
  const wrapper = mount(TasksCard, { props: { tick: 0 }, attachTo: document.body });
  await settle(wrapper);
  return wrapper as VueWrapper;
}
/** 弹窗走 `Teleport to="body"`，`wrapper.find` 够不着 —— 直接问 DOM。 */
const modalFootLabels = (): string[] => [...document.body.querySelectorAll('.modal-foot button')]
  .map((button) => (button.textContent ?? '').trim()).filter((text) => text.length > 0);
const detailFetches = (id: string): number => calls.filter((call) => call.url === `/api/tasks/${id}` && call.method === 'GET').length;
const rowFor = (wrapper: VueWrapper, needle: string) => wrapper.findAll('tbody tr').find((row) => row.text().includes(needle))!;

describe('任务卡', () => {
  beforeEach(() => { document.body.innerHTML = ''; dismissConfirm(); toasts.splice(0, toasts.length); });

  it('行渲染：状态走 TASK_STATES 的中文档、会话格给显示名，running 有〔取消〕而 done 没有', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    const running = rowFor(wrapper, '查一下今天的更新');
    const done = rowFor(wrapper, '整理昨天的群聊');
    // 裸 `running` / `done` 是这一列此前的样子 —— 换成 UiTag 之后不该再出现。
    expect(running.text()).toContain('进行中');
    expect(running.text()).not.toContain('running');
    expect(done.text()).toContain('已完成');
    // `chat` 那一格：显示名在上、发起人在下，两者都是服务端反查好的（前端不实现第二份规则）。
    expect(running.text()).toContain('隆福饭搭子');
    expect(running.text()).toContain('主人');
    expect(running.findAll('button').map((button) => button.text())).toEqual(['取消']);
    expect(done.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('点一行弹出只读详情，单取一次 GET /api/tasks/:id', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    expect(detailFetches('t2'), '点行没有去拉详情').toBe(1);
    const modal = document.body.querySelector('.ui-modal');
    expect(modal, '详情弹窗没打开').not.toBeNull();
    const text = modal?.textContent ?? '';
    // 结果摘要与「最后一条进度」是这次要补的两块 —— 两列运行时一直在写，界面上从来没露过面。
    expect(text).toContain('结果摘要');
    expect(text).toContain('一共 12 条，主要在聊周末去哪。');
    expect(text).toContain('最后一条进度');
    // 标签必须说清「最后一条」：那一列每报一帧就覆盖一次，跑完的任务不再更新。
    expect(text).toContain('不再更新');
    wrapper.unmount();
  });

  it('点行内按钮不会顺带弹出详情（row-click 挂在 tr 上，容器必须 @click.stop）', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '查一下今天的更新').find('button').trigger('click');
    await settle(wrapper);
    // 按钮自己的活儿照做：弹出二次确认。
    expect(confirmBox.value.open).toBe(true);
    expect(confirmBox.value.detail).toContain('同一轮里的其他 worker 也会一并终止');
    // 而详情**没有**被顺带打开 —— 既没发请求，也没有弹窗。
    expect(detailFetches('t1'), '点行内按钮顺带把详情也拉了').toBe(0);
    expect(document.body.querySelector('.ui-modal'), '点行内按钮顺带把详情弹窗也打开了').toBeNull();
    wrapper.unmount();
  });

  it('取消整轮走 askConfirm，落到 POST /api/turns/:id/cancel', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '查一下今天的更新').find('button').trigger('click');
    await settle(wrapper);
    expect(confirmBox.value.title).toContain('查一下今天的更新');
    await runConfirmed();
    await settle(wrapper);
    expect(calls.some((call) => call.url === '/api/turns/turn_aaaaaaaaaaaa/cancel' && call.method === 'POST')).toBe(true);
    expect(toasts.at(-1)).toMatchObject({ severity: 'success' });
    wrapper.unmount();
  });

  it('服务端分页：出分页条，点「下一页」发的是 page=2', async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({ ...DONE, id: `p${index}`, title: `历史任务 ${index}` }));
    stubFetch({ items: [...many, ...many, ...many.slice(0, 5)], total: 45 });
    const wrapper = await mountCard();
    const pager = wrapper.find('.grid-pager');
    expect(pager.exists(), 'total 有 45 条却没有分页条').toBe(true);
    expect(pager.text()).toContain('共 45 条');
    await pager.find('button[aria-label="下一页"]').trigger('click');
    await settle(wrapper);
    const last = calls.filter((call) => call.url.startsWith('/api/tasks?')).at(-1)!;
    expect(last.url).toContain('page=2');
    expect(last.url).toContain('size=20');
    expect(wrapper.find('.grid-pager').text()).toContain('第 2 / 3 页');
    wrapper.unmount();
  });

  /**
   * 删掉末页最后一行之后服务端会回一页空。`reload()` 一律不复位页码（SSE 会让列表在原地重拉，
   * 跟着复位等于运维翻到第 3 页就被弹回第 1 页），但这一种情况必须回退 —— 否则停在一页空列表上
   * 看起来像「任务全没了」。
   */
  it('删掉末页最后一行之后回退一页，而不是停在一页空列表上', async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({ ...DONE, id: `p${index}`, title: `历史任务 ${index}` }));
    const tail = { ...DONE, id: 't2', title: '整理昨天的群聊' };
    stubFetch({ items: [...many, tail], total: 21 });
    const wrapper = await mountCard();
    await wrapper.find('.grid-pager button[aria-label="下一页"]').trigger('click');
    await settle(wrapper);
    expect(wrapper.find('.grid-pager').text()).toContain('第 2 / 2 页');
    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    ([...document.body.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('永久删除')) as HTMLButtonElement).click();
    await settle(wrapper);
    await runConfirmed();
    await settle(wrapper);
    expect(calls.filter((call) => call.url.startsWith('/api/tasks?')).at(-1)!.url).toContain('page=1');
    expect(wrapper.find('.grid-pager').text()).toContain('共 20 条 · 第 1 / 1 页');
    expect(wrapper.findAll('tbody tr').length).toBe(20);
    wrapper.unmount();
  });

  it('详情 footer：running 与 done 两种状态下按钮集合不同', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '查一下今天的更新').trigger('click');
    await settle(wrapper);
    let labels = modalFootLabels();
    expect(labels).toContain('取消整轮');
    expect(labels).toContain('永久删除');
    // 在跑的任务删不得：删记录不会让那个 agent 停下来，只会让它变成一条谁都看不见的在途任务。
    const remove = [...document.body.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('永久删除'))!;
    expect((remove as HTMLButtonElement).disabled, 'running 的〔永久删除〕应当是灰的').toBe(true);
    wrapper.unmount();

    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const second = await mountCard();
    await rowFor(second, '整理昨天的群聊').trigger('click');
    await settle(second);
    labels = modalFootLabels();
    expect(labels, 'done 的任务不该给〔取消整轮〕').not.toContain('取消整轮');
    expect(labels).toContain('永久删除');
    expect(labels).toContain('查看该轮详情');
    expect(labels).toContain('在日志页查看该 trace');
    const removeDone = [...document.body.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('永久删除'))!;
    expect((removeDone as HTMLButtonElement).disabled).toBe(false);
    second.unmount();
  });

  it('两个跳转 emit 出去并关掉弹窗（父层接到 ConsoleView 的 openDetail / openTrace）', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    const click = async (label: string): Promise<void> => {
      const button = [...document.body.querySelectorAll('.modal-foot button')].find((entry) => entry.textContent?.includes(label))! as HTMLButtonElement;
      button.click();
      await settle(wrapper);
    };
    await click('查看该轮详情');
    expect(wrapper.emitted('open-turn')).toEqual([['turn_bbbbbbbbbbbb']]);
    expect(document.body.querySelector('.modal-foot'), '跳转之后详情弹窗该关掉').toBeNull();

    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    await click('在日志页查看该 trace');
    expect(wrapper.emitted('open-trace')).toEqual([['turn_bbbbbbbbbbbb']]);
    wrapper.unmount();
  });

  it('永久删除：二次确认写清只删记录，成功后关弹窗并重拉列表', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    ([...document.body.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('永久删除')) as HTMLButtonElement).click();
    await settle(wrapper);
    expect(confirmBox.value.open).toBe(true);
    // 「删的是记录，不是取消通道」必须写在人看得见的地方，不能只写在服务端注释里。
    expect(confirmBox.value.detail).toContain('只删除这一条任务记录');
    expect(confirmBox.value.detail).toContain('上下文');
    const before = calls.filter((call) => call.url.startsWith('/api/tasks?')).length;
    await runConfirmed();
    await settle(wrapper);
    expect(calls.some((call) => call.url === '/api/tasks/t2' && call.method === 'DELETE')).toBe(true);
    expect(document.body.querySelector('.modal-foot'), '删完之后详情弹窗还开着').toBeNull();
    expect(calls.filter((call) => call.url.startsWith('/api/tasks?')).length, '删完没有重拉列表').toBeGreaterThan(before);
    wrapper.unmount();
  });

  it('删除撞上 409 task_running 时给一条读得懂的提示，而不是原样抛出去', async () => {
    stubFetch({ items: [RUNNING, DONE], total: 2, deleteFails: { status: 409, code: 'task_running', message: '这条任务还在跑' } });
    const wrapper = await mountCard();
    await rowFor(wrapper, '整理昨天的群聊').trigger('click');
    await settle(wrapper);
    ([...document.body.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('永久删除')) as HTMLButtonElement).click();
    await settle(wrapper);
    await runConfirmed();
    await settle(wrapper);
    const toast = toasts.at(-1)!;
    expect(toast.severity).toBe('warn');
    expect(toast.detail).toContain('删除记录不会终止运行');
    wrapper.unmount();
  });
});
