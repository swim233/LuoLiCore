import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import LoginView from '../../packages/webui/src/views/LoginView.vue';
import { auth } from '../../packages/webui/src/api/client';

/**
 * Telegram `/webui` 那条一次性登录链接的**前端消费那一跳**（docs/09 §2.3）。
 *
 * 这一跳整条功能死了一轮：`LoginView` 早就把 `route.query.t` 读进了 `token`，但只有 setup 分支
 * 发它，登录分支只 POST `{ password }` —— `grep -rn "auth/token" packages/webui/src/` 零命中，
 * 点开链接看到的是普通口令框（docs/28 · L-WEB-01）。
 *
 * **为什么三条绿灯挡不住**：`tests/webui.gaps.test.ts` 的「C1 · /webui 一次性登录」逐个钉住服务端
 * 那一半（单次使用 / 过期 / 401 / set-cookie），`tests/trigger.test.ts` 钉住命令 + handler +
 * 服务端端点三者，bot 侧发的链接也是对的 —— **没有一条跨过前后端边界**。这个文件就是那道缝：
 * 断言带 `?t=` 打开时真的打了 `POST /api/auth/token`，以及失败时**说得出原因**
 * （token 5 分钟一次性，过期是常态，不能只有一句「请求失败」）。
 */

function testRouter(): Router {
  return createRouter({ history: createMemoryHistory(), routes: [
    { path: '/login', component: LoginView },
    { path: '/setup', component: LoginView, props: { setup: true } },
    { path: '/', component: { template: '<div>console</div>' } },
  ] });
}

/** 只回答 `POST /api/auth/token`，其余一律落空 —— 这个视图不该在挂载时打任何别的端点。 */
function stubFetch(reply: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await Promise.resolve();
}

describe('LoginView 一次性登录链接', () => {
  beforeEach(() => { auth.csrf = ''; auth.authenticated = false; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('带 ?t= 打开时兑换 token，并照口令登录的收尾进控制台', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true, data: { csrf: 'csrf-from-token', expiresAt: Date.now() + 3600_000 } } });
    const router = testRouter();
    await router.push('/login?t=one-time-token');
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [router] } });
    await settle();
    await wrapper.vm.$nextTick();
    // 这一行就是整条功能此前缺的那一跳。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'one-time-token' });
    // 收尾必须和口令登录一致：漏掉 csrf 那一步的表现是进得去、但每个写操作都 403。
    expect(auth.csrf).toBe('csrf-from-token');
    expect(auth.authenticated).toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    wrapper.unmount();
  });

  it('token 过期时落回口令框，并把服务端给的原因显示出来', async () => {
    const fetchMock = stubFetch({ status: 401, body: { ok: false, error: { code: 'invalid_token', message: '登录链接无效或已过期' } } });
    const router = testRouter();
    await router.push('/login?t=stale-token');
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [router] } });
    await settle();
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 过期是常态（5 分钟一次性），所以原因要带上「怎么再拿一条」而不是一句「请求失败」。
    const callout = wrapper.find('.callout.error');
    expect(callout.exists()).toBe(true);
    expect(callout.text()).toContain('登录链接无效或已过期');
    expect(callout.text()).toContain('/webui');
    // fail-closed：降级成普通口令框，而不是卡在 loading 上。
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect(wrapper.find('[data-exchanging]').exists()).toBe(false);
    expect(auth.authenticated).toBe(false);
    expect(router.currentRoute.value.path).toBe('/login');
    wrapper.unmount();
  });

  it('不带 ?t= 的 /login 一个请求都不打', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true, data: {} } });
    const router = testRouter();
    await router.push('/login');
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [router] } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('.callout.error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('setup 分支仍然把 token 发给 /api/setup，不走兑换那条路', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true, data: { csrf: 'csrf-from-setup' } } });
    const router = testRouter();
    await router.push('/setup?t=setup-token');
    await router.isReady();
    const wrapper = mount(LoginView, { props: { setup: true }, global: { plugins: [router] } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    await wrapper.find('form').trigger('submit');
    await settle();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/setup');
    wrapper.unmount();
  });
});
