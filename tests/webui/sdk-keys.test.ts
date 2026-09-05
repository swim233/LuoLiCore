import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { confirmBox, dismissConfirm, runConfirmed } from '../../packages/webui/src/ui/confirm';
import { toasts } from '../../packages/webui/src/ui/toast';

/**
 * SDK 接入页 · 密钥管理（docs/12-sdk.md T3.11 验收 2–4）。
 *
 * 密钥的签发 / 回显 / 停用都发生在点开来源之后的详情弹窗里（`SourcesCard.vue`），弹窗走
 * `Teleport to="body"`，`wrapper.find` 够不着，判据全部改问 `document.body`
 * （同 `tasks.card.test.ts` 的先例）。核心是三条：签发后列表出现新密钥且表格 DOM 不含明文、
 * 回显二次确认且未确认不发请求、停用后状态在列表里原地变化。
 */

const NOW = 1_760_000_000_000;
const SOURCE = { id: '01SOURCE0000000000000001', kind: 'sdk', name: '示例接入方', createdAt: NOW - 3_600_000, disabledAt: null };
const TELEGRAM = { id: 'telegram', kind: 'telegram', name: 'Telegram', createdAt: NOW - 90_000_000, disabledAt: null };
const DISABLED_SOURCE = { id: '01DEAD0000000000000000001', kind: 'sdk', name: '已停用来源', createdAt: NOW - 7_200_000, disabledAt: NOW - 1_000 };

const EXISTING_KEY_ID = 'KEY0000000000001';
/** 工厂而不是共用常量：DELETE 的 mock 会原地改 `disabledAt`，多个用例共用同一个对象引用会串状态。 */
const existingKey = (): Record<string, unknown> => ({ id: EXISTING_KEY_ID, sourceId: SOURCE.id, label: '旧密钥', createdAt: NOW - 100_000, expiresAt: null, disabledAt: null, lastUsedAt: null });
const ISSUED_TOKEN = 'sk-KEY0000000000002PLAINTEXTSECRETVALUE0000000000';

interface Fixture {
  sources: Array<Record<string, unknown>>;
  keysBySource: Record<string, Array<Record<string, unknown>>>;
  revealFails?: { status: number; code: string; message: string };
}
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
    const keysMatch = /^\/api\/sdk\/sources\/([^/]+)\/keys$/.exec(url);
    if (keysMatch && method === 'GET') return ok({ keys: fixture.keysBySource[keysMatch[1]!] ?? [] });
    if (keysMatch && method === 'POST') {
      const sourceId = keysMatch[1]!;
      const created = { id: 'KEY0000000000002', sourceId, label: (body as { label?: string })?.label ?? null,
        createdAt: NOW, expiresAt: (body as { expiresAt?: number })?.expiresAt ?? null, disabledAt: null, lastUsedAt: null };
      (fixture.keysBySource[sourceId] ??= []).push(created);
      return ok({ token: ISSUED_TOKEN, key: created });
    }
    const revealMatch = /^\/api\/sdk\/keys\/([^/]+)\/reveal$/.exec(url);
    if (revealMatch && method === 'GET') {
      if (fixture.revealFails) return fail(fixture.revealFails.status, fixture.revealFails.code, fixture.revealFails.message);
      return ok({ token: `sk-${revealMatch[1]}REVEALEDSECRETVALUE00000000000` });
    }
    const disableMatch = /^\/api\/sdk\/keys\/([^/]+)$/.exec(url);
    if (disableMatch && method === 'DELETE') {
      for (const list of Object.values(fixture.keysBySource))
        for (const key of list) if (key.id === disableMatch[1]) key.disabledAt = NOW;
      return ok({ disabled: true });
    }
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
const keysModal = (): Element | null => document.body.querySelector('.ui-modal[aria-label^="密钥"]');
const keysTable = (): Element | null => keysModal()?.querySelector('table') ?? null;
async function openKeys(wrapper: VueWrapper, needle: string): Promise<void> {
  await rowFor(wrapper, needle).trigger('click');
  await settle(wrapper);
}

describe('SDK 接入 · 密钥管理', () => {
  beforeEach(() => { document.body.innerHTML = ''; dismissConfirm(); toasts.splice(0, toasts.length); });

  it('无密钥时空态 2-6 字', async () => {
    stubFetch({ sources: [SOURCE], keysBySource: { [SOURCE.id]: [] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, '示例接入方');
    const empty = keysModal()!.querySelector('.grid-note')!.textContent!.trim();
    expect(empty.length, `空态文案「${empty}」长度应在 2-6 字`).toBeGreaterThanOrEqual(2);
    expect(empty.length).toBeLessThanOrEqual(6);
    wrapper.unmount();
  });

  it('签发密钥：label/过期时间均可选，列表出现新 key 且表格 DOM 不含明文（验收 2）', async () => {
    stubFetch({ sources: [SOURCE], keysBySource: { [SOURCE.id]: [existingKey()] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, '示例接入方');
    const issueButton = [...keysModal()!.querySelectorAll('button')].find((button) => button.textContent?.includes('签发密钥')) as HTMLButtonElement;
    expect(issueButton.disabled, '未停用的 sdk 来源应该能签发').toBe(false);
    issueButton.click();
    await settle(wrapper);
    const posted = calls.find((call) => call.url === `/api/sdk/sources/${SOURCE.id}/keys` && call.method === 'POST');
    expect(posted, '没有发出签发请求').toBeDefined();
    // 明文只应出现在弹窗顶部的一次性提示区，绝不出现在密钥表格里。
    expect(keysModal()!.textContent, '弹窗里找不到刚签发的明文').toContain(ISSUED_TOKEN);
    expect(keysTable()!.textContent, '密钥表格不应包含明文').not.toContain(ISSUED_TOKEN);
    expect(keysModal()!.textContent).toContain('仅显示一次');
    // 新签发的那一行应当已经出现在表格里（服务端返回的 key 记录，同样不含明文）。
    expect(keysTable()!.textContent).toContain('KEY0000000000002');
    wrapper.unmount();
  });

  it('回显：二次确认，未确认不发请求，确认后才请求 /reveal 并展示明文（验收 2）', async () => {
    stubFetch({ sources: [SOURCE], keysBySource: { [SOURCE.id]: [existingKey()] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, '示例接入方');
    const revealButton = [...keysModal()!.querySelectorAll('tbody tr button')].find((button) => button.textContent?.includes('回显')) as HTMLButtonElement;
    revealButton.click();
    await settle(wrapper);
    expect(confirmBox.value.open, '点〔回显〕应先弹出二次确认').toBe(true);
    expect(confirmBox.value.detail).toContain('记录');
    const before = calls.filter((call) => call.url.includes('/reveal')).length;
    expect(before, '确认前不该发出回显请求').toBe(0);
    await runConfirmed();
    await settle(wrapper);
    const revealCalls = calls.filter((call) => call.url === `/api/sdk/keys/${EXISTING_KEY_ID}/reveal` && call.method === 'GET');
    expect(revealCalls.length, '确认后应当发出恰好一次回显请求').toBe(1);
    expect(keysModal()!.textContent).toContain(`sk-${EXISTING_KEY_ID}REVEALEDSECRETVALUE00000000000`);
    wrapper.unmount();
  });

  /**
   * `admin.ts` 的 `/reveal` 端点有四种失败结论（`reports/T3.3.impl.md` 接口说明 + T3.3 qa 转入
   * 的注记），界面不对 `code` 分支处理，只把 `apiError()` 给出的那句话透传到 toast 详情——
   * 逐条核对四句原文互不相同，等价于「分别提示」，不会因为共用同一段 catch 代码就退化成
   * 一句笼统的「加载失败」。
   */
  const REVEAL_FAILURES: Array<{ status: number; code: string; message: string }> = [
    { status: 404, code: 'not_found', message: '密钥不存在' },
    { status: 500, code: 'not_implemented', message: '这个部署没有装配 SDK 密钥仓储' },
    { status: 500, code: 'secrets_unavailable', message: '未配置 LUOLI_MASTER_KEY，无法回显密钥' },
    { status: 500, code: 'secret_undecryptable', message: '当前主密钥无法解密该密钥，无法回显' },
  ];
  for (const failure of REVEAL_FAILURES) {
    it(`回显失败 · ${failure.code}：给出服务端原文，不合并为「加载失败」`, async () => {
      stubFetch({ sources: [SOURCE], keysBySource: { [SOURCE.id]: [existingKey()] }, revealFails: failure });
      const wrapper = await mountCard();
      await openKeys(wrapper, '示例接入方');
      const revealButton = [...keysModal()!.querySelectorAll('tbody tr button')].find((button) => button.textContent?.includes('回显')) as HTMLButtonElement;
      revealButton.click();
      await settle(wrapper);
      await runConfirmed();
      await settle(wrapper);
      const toast = toasts.at(-1)!;
      expect(toast.severity).toBe('error');
      expect(toast.summary).not.toBe('加载失败');
      expect(toast.detail).toBe(failure.message);
      wrapper.unmount();
    });
  }
  it('四种回显失败文案两两不同（互不合并的前提）', () => {
    expect(new Set(REVEAL_FAILURES.map((failure) => failure.message)).size).toBe(REVEAL_FAILURES.length);
  });

  it('停用：确认后列表状态原地变化，且已停用行不再显示〔停用〕（验收 3）', async () => {
    stubFetch({ sources: [SOURCE], keysBySource: { [SOURCE.id]: [existingKey()] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, '示例接入方');
    let row = [...keysTable()!.querySelectorAll('tbody tr')].find((entry) => entry.textContent?.includes(EXISTING_KEY_ID))!;
    expect(row.textContent).toContain('启用中');
    const disableButton = [...row.querySelectorAll('button')].find((button) => button.textContent?.includes('停用')) as HTMLButtonElement;
    disableButton.click();
    await settle(wrapper);
    expect(confirmBox.value.open).toBe(true);
    expect(confirmBox.value.detail).toContain('无法撤销');
    await runConfirmed();
    await settle(wrapper);
    expect(calls.some((call) => call.url === `/api/sdk/keys/${EXISTING_KEY_ID}` && call.method === 'DELETE')).toBe(true);
    row = [...keysTable()!.querySelectorAll('tbody tr')].find((entry) => entry.textContent?.includes(EXISTING_KEY_ID))!;
    expect(row.textContent, '停用后状态应变为已停用').toContain('已停用');
    expect([...row.querySelectorAll('button')].some((button) => button.textContent?.includes('停用')), '已停用的行不该再有〔停用〕按钮').toBe(false);
    wrapper.unmount();
  });

  it('内建来源不给签发密钥入口，按钮置灰并给出原因', async () => {
    stubFetch({ sources: [TELEGRAM], keysBySource: { [TELEGRAM.id]: [] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, 'Telegram');
    const issueButton = [...keysModal()!.querySelectorAll('button')].find((button) => button.textContent?.includes('签发密钥')) as HTMLButtonElement;
    expect(issueButton.disabled).toBe(true);
    expect(keysModal()!.textContent).toContain('该来源不支持签发密钥');
    wrapper.unmount();
  });

  it('已停用来源不给签发密钥入口，按钮置灰并给出原因', async () => {
    stubFetch({ sources: [DISABLED_SOURCE], keysBySource: { [DISABLED_SOURCE.id]: [] } });
    const wrapper = await mountCard();
    await openKeys(wrapper, '已停用来源');
    const issueButton = [...keysModal()!.querySelectorAll('button')].find((button) => button.textContent?.includes('签发密钥')) as HTMLButtonElement;
    expect(issueButton.disabled).toBe(true);
    expect(keysModal()!.textContent).toContain('来源已停用，无法签发密钥');
    wrapper.unmount();
  });
});
