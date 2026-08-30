import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toasts } from '../../packages/webui/src/ui/toast';

/**
 * Worker 运行记录卡的行为防线。
 *
 * `.vue` 模板**不进 `tsc --noEmit`**（根 tsconfig 里那条 `packages/**\/*.vue` 是空转），所以这张卡上
 * 所有说话算数的判据 —— 三档徽标、外部自报那一格与「花费」分不分得开、翻页发的是第几页、
 * 过滤器落到哪个查询串、读不到与一个都没有怎么区分 —— 只能在这里焊住。
 *
 * 尤其是外部自报那一格：把它并进「花费」是 `docs/21 · G-API-25` 明确警告的做法（那个数是外部
 * agent 自报的、口径由它定、我们无法核对，结构上被挡在每一个聚合之外，见迁移 `0014`）。
 * 合并显示读起来像修好了一个缺口，实际是把一条有意为之的边界抹掉。
 */

const NOW = 1_760_000_000_000;
const LW = { id: 'run-l1', turnId: 'turn_aaaaaaaaaaaa', parentRunId: null, depth: 1, workerKind: 'lw', agentName: 'worker',
  modelAlias: 'low', effectiveRole: 'trusted', state: 'done', steps: 3, toolCalls: 4, inputTokens: 900, outputTokens: 120,
  costUsd: 0.0123, externalCostUsd: null, taskLine: '查一下今天的更新', resultSummary: '查完了', error: null,
  startedAt: NOW - 120_000, finishedAt: NOW - 60_000 };
const HARNESS = { ...LW, id: 'run-h1', workerKind: 'harness', agentName: 'harness:claude', modelAlias: 'external',
  state: 'running', steps: 0, toolCalls: 0, costUsd: 0, taskLine: '改一下那个仓库的 parser', resultSummary: null,
  startedAt: NOW - 1_200_000, finishedAt: null };
const ACP = { ...LW, id: 'run-a1', turnId: 'turn_bbbbbbbbbbbb', workerKind: 'acp', agentName: 'acp:omp', modelAlias: 'external',
  costUsd: 0, externalCostUsd: 1.25, taskLine: '重构 parser', resultSummary: '改完了' };

/** `GET /api/worker-runs/:id` 的两份详情。列表行不带 `taskInput` / `externalUsageJson`，详情才带。 */
const DETAILS: Record<string, unknown> = {
  'run-l1': { ...LW, providerId: 'p1', modelId: 'claude-haiku', taskInput: '查一下今天的更新\n顺带看看有没有新 issue',
    externalUsageJson: null, resultFullRef: 'agent-results/run-l1.txt',
    turn: { key: 'chat:-1001', chatId: '-1001', state: 'committed', error: null }, chatLabel: '隆福饭搭子' },
  'run-a1': { ...ACP, providerId: null, modelId: null, taskInput: '重构 parser',
    externalUsageJson: '{"source":"omp","model":"gpt-5","costUsd":1.25}', resultFullRef: null,
    turn: { key: 'chat:8899001', chatId: '8899001', state: 'committed', error: null }, chatLabel: '阿离' },
};

interface Fixture { items: Array<Record<string, unknown>>; total: number; listFails?: { status: number; code: string; message: string } }
let calls: Array<{ url: string; method: string }> = [];

function stubFetch(fixture: Fixture): void {
  calls = [];
  const ok = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const [path, query] = url.split('?');
    if (path === '/api/worker-runs') {
      if (fixture.listFails) return fail(fixture.listFails.status, fixture.listFails.code, fixture.listFails.message);
      const params = new URLSearchParams(query ?? '');
      const size = Number(params.get('size') ?? 20);
      const page = Number(params.get('page') ?? 1);
      const kind = params.get('workerKind');
      const rows = kind ? fixture.items.filter((row) => row.workerKind === kind) : fixture.items;
      return ok({ items: rows.slice((page - 1) * size, page * size), total: kind ? rows.length : fixture.total, page, size });
    }
    if (path?.startsWith('/api/worker-runs/')) {
      const id = path.slice('/api/worker-runs/'.length);
      return DETAILS[id] ? ok(DETAILS[id]) : fail(404, 'not_found', '这条 worker 运行记录不存在');
    }
    return ok({});
  }));
}

async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}
async function mountCard(): Promise<VueWrapper> {
  const { default: WorkerRunsCard } = await import('../../packages/webui/src/components/workers/WorkerRunsCard.vue');
  const wrapper = mount(WorkerRunsCard, { props: { tick: 0 }, attachTo: document.body });
  await settle(wrapper);
  return wrapper as VueWrapper;
}
const modalText = (): string => document.body.querySelector('.ui-modal')?.textContent ?? '';
const modalFootLabels = (): string[] => [...document.body.querySelectorAll('.modal-foot button')]
  .map((button) => (button.textContent ?? '').trim()).filter((text) => text.length > 0);
const rowFor = (wrapper: VueWrapper, needle: string) => wrapper.findAll('tbody tr').find((row) => row.text().includes(needle))!;
const listCalls = (): string[] => calls.filter((call) => call.url.startsWith('/api/worker-runs?')).map((call) => call.url);

describe('Worker 运行记录卡', () => {
  beforeEach(() => { document.body.innerHTML = ''; toasts.splice(0, toasts.length); });

  it('三档 worker 各有自己的徽标，状态走中文档而不是裸英文', async () => {
    stubFetch({ items: [HARNESS, ACP, LW], total: 3 });
    const wrapper = await mountCard();
    expect(rowFor(wrapper, '改一下那个仓库的 parser').text()).toContain('harness');
    expect(rowFor(wrapper, '重构 parser').text()).toContain('acp');
    expect(rowFor(wrapper, '查一下今天的更新').text()).toContain('lw');
    // 裸 running / done 是这一列此前的样子 —— 换成 UiTag 之后不该再出现。
    expect(rowFor(wrapper, '改一下那个仓库的 parser').text()).toContain('进行中');
    expect(rowFor(wrapper, '改一下那个仓库的 parser').text()).not.toContain('running');
    expect(rowFor(wrapper, '查一下今天的更新').text()).toContain('已完成');
    wrapper.unmount();
  });

  /**
   * 这一条是本文件的重点。`external_cost_usd` 与 `cost_usd` 必须落在两个不同的格子里，
   * 且页面上要有一句说明它未经核对、不进任何聚合（docs/21 · G-API-25 的后半条一个字都不推翻）。
   */
  it('外部自报与花费各占一格，绝不相加，且旁边写明它不进聚合', async () => {
    stubFetch({ items: [ACP, LW], total: 2 });
    const wrapper = await mountCard();
    const acp = rowFor(wrapper, '重构 parser');
    const cells = acp.findAll('td').map((cell) => cell.text());
    // 两个数字分别出现在自己的格子里；任何一格都不该是两者之和（1.2500 ≠ 1.2500+0）。
    expect(cells, 'costUsd 那一格不见了').toContain('$0.0000');
    expect(cells, 'externalCostUsd 那一格不见了').toContain('$1.2500');
    expect(cells.join('|')).not.toContain('$1.2623');
    // 「没报过」必须与「报了 0」分得开：前者是一条外部 agent 从未发过 usage_update 的行。
    expect(rowFor(wrapper, '查一下今天的更新').text()).not.toContain('$1.2500');
    expect(wrapper.text()).toContain('不进任何聚合');
    expect(wrapper.text()).toContain('未经核对');
    wrapper.unmount();
  });

  it('这张卡不给「取消这条 run」，并把没有独立句柄这件事写在页面上', async () => {
    stubFetch({ items: [HARNESS], total: 1 });
    const wrapper = await mountCard();
    // 一条跑了 20 分钟的 harness 摆在那儿，运维必须能从页面上读出该去哪儿取消。
    expect(rowFor(wrapper, '改一下那个仓库的 parser').findAll('button').map((button) => button.text())).not.toContain('取消');
    expect(wrapper.text()).toContain('这里没有取消');
    expect(wrapper.text()).toContain('父轮');
    wrapper.unmount();
  });

  it('点一行弹出只读详情，任务正文与外部用量原样 JSON', async () => {
    stubFetch({ items: [ACP, LW], total: 2 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '重构 parser').trigger('click');
    await settle(wrapper);
    expect(calls.filter((call) => call.url === '/api/worker-runs/run-a1').length, '点行没有去拉详情').toBe(1);
    const text = modalText();
    expect(text).toContain('任务正文');
    expect(text).toContain('外部用量');
    // 原样 JSON：缩进渲染，且给出复制入口（照日志详情弹窗那条先例）。
    expect(text).toContain('"source": "omp"');
    expect([...document.body.querySelectorAll('button')].map((button) => button.textContent?.trim())).toContain('复制 JSON');
    wrapper.unmount();
  });

  it('lw 那条详情里没有外部用量，两处都显示暂无而不是编一个 0', async () => {
    stubFetch({ items: [LW], total: 1 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '查一下今天的更新').trigger('click');
    await settle(wrapper);
    const text = modalText();
    expect(text).toContain('顺带看看有没有新 issue');
    expect(text).toContain('查完了');
    // 外部自报那一格必须是 `—` 而不是 `$0.0000`：编一个 0 等于替外部 agent 报了个数。
    expect(text).not.toContain('$0.0000');
    expect(text).toContain('—');
    wrapper.unmount();
  });

  it('详情 footer 给两个跳转，emit 出去并关掉弹窗', async () => {
    stubFetch({ items: [ACP], total: 1 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '重构 parser').trigger('click');
    await settle(wrapper);
    expect(modalFootLabels()).toEqual(expect.arrayContaining(['查看该轮详情', '在日志页查看该 trace']));
    const click = async (label: string): Promise<void> => {
      ([...document.body.querySelectorAll('.modal-foot button')].find((entry) => entry.textContent?.includes(label)) as HTMLButtonElement).click();
      await settle(wrapper);
    };
    await click('查看该轮详情');
    expect(wrapper.emitted('open-turn')).toEqual([['turn_bbbbbbbbbbbb']]);
    expect(document.body.querySelector('.modal-foot'), '跳转之后详情弹窗该关掉').toBeNull();
    wrapper.unmount();
  });

  /** 轮次那一格是行内按钮：`DataGrid` 的 row-click 挂在 `<tr>` 上，漏掉 `@click.stop`
   *  的表现是「点跳转的同时弹出详情框」—— 界面上两件事都发生了，看起来像随机抽风。 */
  it('点行内的轮次跳转不会顺带弹出详情', async () => {
    stubFetch({ items: [LW], total: 1 });
    const wrapper = await mountCard();
    await rowFor(wrapper, '查一下今天的更新').find('button').trigger('click');
    await settle(wrapper);
    expect(wrapper.emitted('open-turn')).toEqual([['turn_aaaaaaaaaaaa']]);
    expect(calls.filter((call) => call.url === '/api/worker-runs/run-l1').length, '点行内按钮顺带把详情也拉了').toBe(0);
    expect(document.body.querySelector('.ui-modal'), '点行内按钮顺带把详情弹窗也打开了').toBeNull();
    wrapper.unmount();
  });

  it('两个过滤器落到查询串上，换筛选条件回到第 1 页', async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({ ...LW, id: `p${index}`, taskLine: `历史任务 ${index}` }));
    stubFetch({ items: [...many, ACP], total: 21 });
    const wrapper = await mountCard();
    await wrapper.find('.grid-pager button[aria-label="下一页"]').trigger('click');
    await settle(wrapper);
    expect(listCalls().at(-1)).toContain('page=2');
    const vm = wrapper.vm as unknown as { kindFilter: string; applyFilters(): void };
    vm.kindFilter = 'acp';
    vm.applyFilters();
    await settle(wrapper);
    const last = listCalls().at(-1)!;
    expect(last).toContain('workerKind=acp');
    // 留在第 3 页换筛选条件，绝大多数时候得到的是一页空列表。
    expect(last).toContain('page=1');
    expect(wrapper.findAll('tbody tr').length).toBe(1);
    wrapper.unmount();
  });

  it('服务端分页：出分页条，点「下一页」发的是 page=2 与固定的 size', async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({ ...LW, id: `p${index}`, taskLine: `历史任务 ${index}` }));
    stubFetch({ items: [...many, ...many, ...many.slice(0, 5)], total: 45 });
    const wrapper = await mountCard();
    const pager = wrapper.find('.grid-pager');
    expect(pager.exists(), 'total 有 45 条却没有分页条').toBe(true);
    expect(pager.text()).toContain('共 45 条');
    await pager.find('button[aria-label="下一页"]').trigger('click');
    await settle(wrapper);
    expect(listCalls().at(-1)).toContain('size=20');
    expect(wrapper.find('.grid-pager').text()).toContain('第 2 / 3 页');
    wrapper.unmount();
  });

  /** 「读不到」和「一个都没有」必须分得开：请求失败时只留一句「暂无」，运维会以为这个部署
   *  从来没派过 worker，而真实情况可能是迁移没跑、端点 500。 */
  it('拉不到时给红条与原因，不冒充一页空列表', async () => {
    stubFetch({ items: [], total: 0, listFails: { status: 500, code: 'internal', message: '服务端出错，已记录（ref: 42）' } });
    const wrapper = await mountCard();
    expect(wrapper.find('.callout.error').exists(), '读不到时没有红条').toBe(true);
    expect(wrapper.find('.callout.error').text()).toContain('读不到');
    expect(wrapper.find('.callout.error').text()).toContain('ref: 42');
    expect(toasts.at(-1)).toMatchObject({ severity: 'error' });
    wrapper.unmount();

    // 对照组：真的一条都没有时不出红条，只留空态。
    stubFetch({ items: [], total: 0 });
    const empty = await mountCard();
    expect(empty.find('.callout.error').exists(), '一条都没有时不该出红条').toBe(false);
    expect(empty.text()).toContain('暂无');
    empty.unmount();
  });

  it('父层的 tick 变化会原地重拉，且不把页码复位', async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({ ...LW, id: `p${index}`, taskLine: `历史任务 ${index}` }));
    stubFetch({ items: [...many, ACP], total: 21 });
    const wrapper = await mountCard();
    await wrapper.find('.grid-pager button[aria-label="下一页"]').trigger('click');
    await settle(wrapper);
    const before = listCalls().length;
    await wrapper.setProps({ tick: 1 });
    await settle(wrapper);
    expect(listCalls().length, 'tick 变了没有重拉').toBeGreaterThan(before);
    // SSE 让列表原地重拉，跟着复位等于运维翻到第 2 页就被弹回第 1 页。
    expect(listCalls().at(-1)).toContain('page=2');
    wrapper.unmount();
  });
});
