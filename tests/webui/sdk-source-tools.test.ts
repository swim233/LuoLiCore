import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toasts } from '../../packages/webui/src/ui/toast';
import { dismissConfirm } from '../../packages/webui/src/ui/confirm';

/**
 * SDK 接入页 · 来源详情里的工具白名单（docs/12-sdk.md §8，docs/09 §3.9a）。
 *
 * `.vue` 模板不进 `tsc --noEmit`，这几条判据只能在这里焊住：候选来自 `/api/tools` 而不是前端
 * 写死的一份名单；结构性禁止的那几件不可勾选；「用默认」与「显式配置」是两种状态，保存时
 * 分别发 `null` 与数组。
 */

const NOW = 1_760_000_000_000;
const SOURCE = {
  id: '01EXAMPLE0000000000000001',
  kind: 'sdk',
  name: '示例接入方',
  createdAt: NOW - 3_600_000,
  disabledAt: null,
  tools: null as string[] | null,
};

interface Fixture { source: Record<string, unknown> }
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function stubFetch(fixture: Fixture): void {
  calls = [];
  const ok = (data: unknown): Response =>
    new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/sdk/sources' && method === 'GET') return ok({ sources: [fixture.source] });
    if (url === '/api/tools' && method === 'GET')
      return ok({
        memory_read: { sdkForbidden: false },
        memory_list: { sdkForbidden: false },
        memory_write: { sdkForbidden: false },
        grep: { sdkForbidden: false },
        // 本部署自己装的 MCP 工具：前端写死一份名单的话，这一件就勾不到。
        mcp__screenshot: { sdkForbidden: false },
        spawn_worker: { sdkForbidden: true },
        send_message: { sdkForbidden: true },
      });
    if (/^\/api\/sdk\/sources\/.+\/keys$/.test(url) && method === 'GET') return ok({ keys: [] });
    if (/^\/api\/sdk\/sources\/.+\/tools$/.test(url) && method === 'PATCH') {
      Object.assign(fixture.source, { tools: (body as { tools?: string[] | null }).tools });
      return ok({ source: fixture.source });
    }
    return ok({});
  }));
}

async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}

async function openDetail(): Promise<VueWrapper> {
  const { default: SourcesCard } = await import('../../packages/webui/src/components/sdk/SourcesCard.vue');
  const wrapper = mount(SourcesCard, { attachTo: document.body }) as VueWrapper;
  await settle(wrapper);
  const row = wrapper.findAll('tbody tr').find((item) => item.text().includes('示例接入方'))!;
  await row.trigger('click');
  await settle(wrapper);
  return wrapper;
}

function toolBox(name: string): HTMLInputElement | undefined {
  return [...document.body.querySelectorAll('.tools-grid .ui-check')]
    .filter((label) => label.textContent?.trim() === name)
    .map((label) => label.querySelector('input') as HTMLInputElement)[0];
}

const patches = (): Array<{ body: unknown }> => calls.filter((call) => call.url.endsWith('/tools') && call.method === 'PATCH');

describe('SDK 接入 · 工具白名单', () => {
  beforeEach(() => { document.body.innerHTML = ''; dismissConfirm(); toasts.splice(0, toasts.length); vi.unstubAllGlobals(); });

  it('候选来自 /api/tools，含本部署自己装的工具', async () => {
    stubFetch({ source: { ...SOURCE } });
    await openDetail();

    expect(toolBox('mcp__screenshot')).toBeTruthy();
    expect(toolBox('grep')).toBeTruthy();
  });

  it('未配置时显示默认三件已勾选，且摘要说明是默认', async () => {
    stubFetch({ source: { ...SOURCE, tools: null } });
    await openDetail();

    expect(toolBox('memory_read')?.checked).toBe(true);
    expect(toolBox('grep')?.checked).toBe(false);
    expect(document.body.querySelector('.tools-block')?.textContent).toContain('默认');
  });

  /** 配了也不生效的那几件必须点不动，而不是点了保存再被 400 打回来。 */
  it('结构性禁止的工具不可勾选', async () => {
    stubFetch({ source: { ...SOURCE } });
    await openDetail();

    expect(toolBox('spawn_worker')?.disabled).toBe(true);
    expect(toolBox('send_message')?.disabled).toBe(true);
    expect(toolBox('grep')?.disabled).toBe(false);
  });

  /** 从「用默认」切过去时以默认三件起步：从空开始等于一键关掉这个来源。 */
  it('勾一件之后保存，发出的是完整数组而不是增量', async () => {
    stubFetch({ source: { ...SOURCE, tools: null } });
    const wrapper = await openDetail();

    const box = toolBox('grep')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle(wrapper);

    const save = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('保存'))!;
    save.click();
    await settle(wrapper);

    expect(patches()).toHaveLength(1);
    expect((patches()[0]!.body as { tools: string[] }).tools.sort()).toEqual(
      ['grep', 'memory_list', 'memory_read', 'memory_write'],
    );
  });

  it('恢复默认发出的是 null，不是空数组', async () => {
    stubFetch({ source: { ...SOURCE, tools: ['grep'] } });
    const wrapper = await openDetail();

    const reset = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('恢复默认'))!;
    reset.click();
    await settle(wrapper);
    const save = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('保存'))!;
    save.click();
    await settle(wrapper);

    expect((patches()[0]!.body as { tools: unknown }).tools).toBeNull();
  });

  it('取消掉全部勾选后保存，发出的是空数组（显式的「一件都不给」）', async () => {
    stubFetch({ source: { ...SOURCE, tools: ['grep'] } });
    const wrapper = await openDetail();

    const box = toolBox('grep')!;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await settle(wrapper);
    const save = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('保存'))!;
    save.click();
    await settle(wrapper);

    expect((patches()[0]!.body as { tools: unknown }).tools).toEqual([]);
  });
});
