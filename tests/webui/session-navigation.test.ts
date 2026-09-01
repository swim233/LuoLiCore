import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../packages/webui/src/App.vue';
import { api, AUTH_REQUIRED_EVENT } from '../../packages/webui/src/api/client';

const unauthorized = (): Response => new Response(JSON.stringify({
  ok: false,
  error: { code: 'unauthenticated', message: '需要登录' },
}), { status: 401, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('会话失效导航', () => {
  it('401 只发送站内登录事件，不创建第二次文档导航', async () => {
    window.history.replaceState({}, '', '/');
    const onRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    vi.stubGlobal('fetch', vi.fn(async () => unauthorized()));

    await expect(api('/api/auth/me')).rejects.toMatchObject({ code: 'unauthenticated' });

    expect(onRequired).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/');
    window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  });

  it('App 合并重复失效事件，经 Vue Router 替换为登录页', async () => {
    const Page = defineComponent({ template: '<div />' });
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: Page },
      { path: '/login', component: Page },
    ] });
    await router.push('/');
    await router.isReady();
    const replace = vi.spyOn(router, 'replace');
    const wrapper = mount(App, { global: { plugins: [router], stubs: {
      AmbientField: true, ToastHost: true, ConfirmHost: true, RouterView: true,
    } } });

    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/login');
    expect(replace).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('控制台首个鉴权请求失败后停止批量加载与 SSE', async () => {
    window.history.replaceState({}, '', '/');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => unauthorized());
    const EventSourceMock = vi.fn(function EventSourceStub() {
      return { close(): void { /* noop */ }, addEventListener(): void { /* noop */ } };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', EventSourceMock);
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/me');
    expect(EventSourceMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
