import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ExtensionsPage from '../../packages/webui/src/views/ExtensionsPage.vue';

/**
 * 扩展页的**两层弹窗层级**。
 *
 * 所有遮罩都是同一个 `.ui-overlay`（同一个 z-index），同层只能靠 DOM 顺序分胜负；而 Teleport
 * 的锚点是组件挂载时按**模板顺序**插进 `body` 的，这一页的确认框在模板里排在 Skill / MCP 弹窗
 * **之前**。于是「Skill 弹窗里点〔永久删除〕」弹出的确认框反而被那张 Skill 弹窗盖住 ——
 * 表现是点了没反应（`styles.css` 那条注释里记的就是这个形态）。
 *
 * 这一页用的还是页内自己那份 `confirmBox`，没迁去共享的 `ui/confirm.ts` 单例，所以它拿不到
 * `ConfirmHost` 上那个 `confirm-detail` 钩子 —— 修法是给它的 detail 段补上同一个类，命中
 * `styles.css` 里已经有的 `.ui-overlay:has(.confirm-detail) { z-index: 55 }`。
 *
 * 两半都要焊，缺一半这条防线就是假的：
 * - DOM 上确认框真的带着那个钩子（少了它 CSS 那条规则永不命中）；
 * - CSS 上那个钩子真的更高（钩子在、规则被删掉同样白搭）。
 *
 * 还要把**前提本身**断言住：确认框在 DOM 里确实排在 Skill 弹窗之前。哪天模板顺序反过来了，
 * 这个 bug 会自己消失，而这条用例的下半段就该重写而不是继续绿着。
 */

const SKILLS = [
  { name: 'writing-tools', description: '写东西时先读这份', min_role: 'trusted', enabled: 1, source: 'local' as const, load_error: null },
];
const DETAIL = { name: 'writing-tools', description: '写东西时先读这份', body: '正文', allowedTools: [], requiresTools: [],
  minRole: 'trusted', model: null, enabled: true, files: [] };

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const data = (init?.method ?? 'GET') === 'GET' && url.startsWith('/api/skills/') ? DETAIL : { removed: true };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}
function calls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}
async function settle(wrapper: VueWrapper): Promise<void> {
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}
function open(): VueWrapper {
  // 不 stub teleport：这条用例要的就是两张遮罩在 `body` 里的**真实先后**。
  return mount(ExtensionsPage, { props: { skills: SKILLS, plugins: [], mcp: [], customTools: [], config: {} } });
}
const buttonIn = (root: ParentNode, selector: string, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll(selector)].find((entry) => entry.textContent?.includes(label)) as HTMLButtonElement | undefined;

describe('扩展页的确认框', () => {
  beforeEach(() => { document.body.innerHTML = ''; stubFetch(); });

  it('Skill 弹窗开着时点〔永久删除〕，确认框带着抬层钩子且排在 Skill 弹窗之前', async () => {
    const wrapper = open();
    await settle(wrapper);
    const edit = wrapper.findAll('[data-ext-tab="skills"] .ext-row button').find((entry) => entry.text() === '编辑');
    expect(edit, 'Skill 那一行没有〔编辑〕入口').toBeDefined();
    await edit!.trigger('click');
    await settle(wrapper);
    expect(document.body.querySelectorAll('.ui-overlay').length, 'Skill 弹窗没打开').toBe(1);

    const purge = buttonIn(document.body, '.modal-foot button', '永久删除');
    expect(purge, 'Skill 弹窗的 footer 里没有〔永久删除〕').toBeDefined();
    purge!.click();
    await settle(wrapper);

    const overlays = [...document.body.querySelectorAll('.ui-overlay')];
    expect(overlays.length, 'Skill 弹窗被提前关掉了 —— 那是在绕开层级问题，不是解决它（人会看不见自己要删的是哪一个）').toBe(2);
    const box = overlays.find((entry) => entry.querySelector('.confirm-detail'));
    expect(box, '确认框的遮罩上没有那个用来抬层的钩子（`.confirm-detail`），它会被 Skill 弹窗盖住 —— 点了没反应').toBeDefined();
    expect(box!.textContent, '带钩子的那张不是确认框').toContain('永久删除 Skill writing-tools');
    const skill = overlays.find((entry) => entry !== box)!;
    expect(skill.querySelector('.ui-modal')?.getAttribute('aria-label'), '底下那张应该还是 Skill 弹窗').toBe('Skill writing-tools');

    // 前提本身：确认框在 DOM 里排在 Skill 弹窗**之前**，所以同 z-index 时它就是被盖住的那一张。
    expect(box!.compareDocumentPosition(skill) & Node.DOCUMENT_POSITION_FOLLOWING,
      '确认框已经排在 Skill 弹窗之后了 —— 这条用例的前提没了，下面那半 CSS 断言要重写').toBeTruthy();

    // 另一半在 CSS 里：钩子命中的那条规则必须真的比普通遮罩高（并且仍在 toast 之下）。
    const css = readFileSync('packages/webui/src/styles.css', 'utf8');
    const base = /^\.ui-overlay\s*\{[^}]*z-index:\s*(\d+)/m.exec(css);
    const raised = /^\.ui-overlay:has\(\.confirm-detail\)\s*\{[^}]*z-index:\s*(\d+)/m.exec(css);
    expect(base, 'styles.css 里找不到 `.ui-overlay` 的 z-index').not.toBeNull();
    expect(raised, 'styles.css 里没有给确认框抬层的那条规则').not.toBeNull();
    expect(Number(raised![1]), '确认框的遮罩没有比普通弹窗高').toBeGreaterThan(Number(base![1]));

    // 点到这里为止一个删除请求都不许发出去 —— 确认框是闸，不是通知。
    expect(calls().some(([, init]) => init?.method === 'DELETE'), '还没确认就把 DELETE 发出去了').toBe(false);
    buttonIn(box!, 'button', '确认')!.click();
    await settle(wrapper);
    expect(calls().filter(([, init]) => init?.method === 'DELETE').at(-1)?.[0]).toBe('/api/skills/writing-tools');
    wrapper.unmount();
  });
});
