import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toasts } from '../../packages/webui/src/ui/toast';
import { dismissConfirm } from '../../packages/webui/src/ui/confirm';

/**
 * SDK 接入页 · 来源卡（docs/12-sdk.md T3.11）。
 *
 * `.vue` 模板不进 `tsc --noEmit`（`tasks.card.test.ts` 开头的注释同一个理由），列表/新建这两块
 * 的判据只能在这里焊住：无来源时的空态字数（验收 4）、新建只填名称、id 由服务端生成后原样显示、
 * 失败时不关闭弹窗。密钥管理（签发 / 回显 / 停用）在 `sdk-keys.test.ts`。
 */

const NOW = 1_760_000_000_000;
const TELEGRAM = { id: 'telegram', kind: 'telegram', name: 'Telegram', createdAt: NOW - 90_000_000, disabledAt: null };
const EXAMPLE = { id: '01EXAMPLE0000000000000001', kind: 'sdk', name: '示例接入方', createdAt: NOW - 3_600_000, disabledAt: null };

interface Fixture { sources: Array<Record<string, unknown>>; createFails?: { status: number; code: string; message: string } }
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function stubFetch(fixture: Fixture): void {
  calls = [];
  const ok = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/sdk/sources' && method === 'GET') return ok({ sources: fixture.sources });
    if (url === '/api/sdk/sources' && method === 'POST') {
      if (fixture.createFails) return fail(fixture.createFails.status, fixture.createFails.code, fixture.createFails.message);
      const name = (body as { name?: string })?.name ?? '';
      const created = { id: `01NEW${fixture.sources.length}`, kind: 'sdk', name, createdAt: NOW, disabledAt: null };
      fixture.sources.push(created);
      return ok({ source: created });
    }
    if (/^\/api\/sdk\/sources\/.+\/keys$/.test(url) && method === 'GET') return ok({ keys: [] });
    return ok({});
  }));
}

async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}
async function mountCard(): Promise<VueWrapper> {
  const { default: SourcesCard } = await import('../../packages/webui/src/components/sdk/SourcesCard.vue');
  const wrapper = mount(SourcesCard, { attachTo: document.body });
  await settle(wrapper);
  return wrapper as VueWrapper;
}
const rowFor = (wrapper: VueWrapper, needle: string) => wrapper.findAll('tbody tr').find((row) => row.text().includes(needle))!;
const createModal = (): Element | null => document.body.querySelector('.ui-modal[aria-label="新建来源"]');

describe('SDK 接入 · 来源卡', () => {
  beforeEach(() => { document.body.innerHTML = ''; dismissConfirm(); toasts.splice(0, toasts.length); });

  it('来源行渲染：telegram 与 sdk 两类都出现，类型与状态走中文标签', async () => {
    stubFetch({ sources: [TELEGRAM, EXAMPLE] });
    const wrapper = await mountCard();
    const tgRow = rowFor(wrapper, 'Telegram');
    const sdkRow = rowFor(wrapper, '示例接入方');
    expect(tgRow.text()).toContain('内建');
    expect(tgRow.text()).toContain('启用中');
    expect(sdkRow.text()).toContain('接入方');
    expect(sdkRow.text()).toContain('启用中');
    wrapper.unmount();
  });

  it('无来源时空态 2-6 字（验收 4）', async () => {
    stubFetch({ sources: [] });
    const wrapper = await mountCard();
    const empty = wrapper.find('.grid-note').text().trim();
    expect(empty.length, `空态文案「${empty}」长度应在 2-6 字`).toBeGreaterThanOrEqual(2);
    expect(empty.length).toBeLessThanOrEqual(6);
    wrapper.unmount();
  });

  it('新建来源：只填名称，id 由服务端生成并原样显示在列表里', async () => {
    stubFetch({ sources: [TELEGRAM] });
    const wrapper = await mountCard();
    // UiButton 渲染为 <button>，用文本定位而不是特定 class（避免与 DataGrid 内部按钮耦合）。
    const openButton = wrapper.findAll('button').find((button) => button.text() === '新建来源')!;
    await openButton.trigger('click');
    await settle(wrapper);
    expect(createModal(), '新建来源弹窗没打开').not.toBeNull();
    const input = createModal()!.querySelector('input') as HTMLInputElement;
    input.value = '第二个接入方';
    input.dispatchEvent(new Event('input'));
    await settle(wrapper);
    const submit = [...createModal()!.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('创建')) as HTMLButtonElement;
    submit.click();
    await settle(wrapper);
    const posted = calls.find((call) => call.url === '/api/sdk/sources' && call.method === 'POST');
    expect(posted?.body).toEqual({ name: '第二个接入方' });
    expect(createModal(), '成功后弹窗应关闭').toBeNull();
    expect(rowFor(wrapper, '第二个接入方'), '新来源没有出现在列表里').toBeDefined();
    wrapper.unmount();
  });

  it('新建来源失败：弹窗不关闭，toast 给出服务端原因', async () => {
    stubFetch({ sources: [TELEGRAM], createFails: { status: 400, code: 'invalid_name', message: '名称不能为空，且不超过 64 个字符' } });
    const wrapper = await mountCard();
    const openButton = wrapper.findAll('button').find((button) => button.text() === '新建来源')!;
    await openButton.trigger('click');
    await settle(wrapper);
    const input = createModal()!.querySelector('input') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await settle(wrapper);
    const submit = [...createModal()!.querySelectorAll('.modal-foot button')].find((button) => button.textContent?.includes('创建')) as HTMLButtonElement;
    submit.click();
    await settle(wrapper);
    expect(createModal(), '失败后弹窗应保持打开').not.toBeNull();
    expect(toasts.at(-1)).toMatchObject({ severity: 'error' });
    expect(toasts.at(-1)?.detail).toContain('名称不能为空');
    wrapper.unmount();
  });

  it('点一行来源，请求该来源的密钥列表', async () => {
    stubFetch({ sources: [TELEGRAM, EXAMPLE] });
    const wrapper = await mountCard();
    await rowFor(wrapper, '示例接入方').trigger('click');
    await settle(wrapper);
    expect(calls.some((call) => call.url === `/api/sdk/sources/${EXAMPLE.id}/keys` && call.method === 'GET')).toBe(true);
    const modal = document.body.querySelector('.ui-modal[aria-label^="密钥"]');
    expect(modal, '密钥详情弹窗没打开').not.toBeNull();
    expect(modal!.getAttribute('aria-label')).toContain('示例接入方');
    wrapper.unmount();
  });
});
