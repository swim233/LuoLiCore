import { describe, expect, it } from 'vitest';
import { code, source } from '../support/source';

/** happy-dom 不执行 CSS 动画。这里约束登录动效的作用域、时长与首帧底色。 */
describe('WebUI 登录页进入动效', () => {
  it('控制台首次挂载不执行长入场动画', () => {
    const view = source('packages/webui/src/views/ConsoleView.vue');
    expect(view).toContain(code('<Transition name="page" mode="out-in">'));
    expect(view).not.toContain(code('<Transition name="page" mode="out-in" appear>'));
  });

  it('登录背景与两组组件在约 1.5 秒内完成纵深上浮', () => {
    const css = source('packages/webui/src/styles.css');
    expect(css).toContain(code('@keyframes login-backdrop-reveal { from { opacity: .86; } to { opacity: 0; } }'));
    expect(css).toContain(code('from { opacity: 0; transform: perspective(1100px) translate3d(0, 58px, -140px) scale(.96); }'));
    expect(css).toContain(code('animation: login-backdrop-reveal 1500ms cubic-bezier(.22, .61, .36, 1) both;'));
    expect(css).toContain(code('animation: login-surface-rise 1500ms cubic-bezier(.16, 1, .3, 1) both;'));
    expect(css).toContain(code('animation: login-surface-rise 1450ms cubic-bezier(.16, 1, .3, 1) 50ms both;'));
    expect(css).not.toContain(code('.console-shell > .sidebar { animation:'));
  });

  it('首字节带深色画布，减少动态效果时取消登录入场', () => {
    const html = source('packages/webui/index.html');
    const css = source('packages/webui/src/styles.css');
    expect(html).toContain(code('<html lang="zh-CN" class="dark">'));
    expect(html).toContain(code('html, body { min-height: 100%; margin: 0; background: #050c11; color: #e9f6f6; }'));
    // 站点自带深浅两套主题，Dark Reader 再改一遍会在刷新首帧闪一次浅色（docs/09 §7）。
    // 这一行是它官方的停手开关，删掉即恢复那次闪烁，而扩展侧的闪烁在本仓库里没有别的拦法。
    expect(html).toContain(code('<meta name="darkreader-lock" />'));
    expect(css).toContain(code('.auth-page::before, .auth-copy, .auth-card { animation: none !important; }'));
  });
});

/** 白闪的判据长在源码里、无法以行为断言表达：低延迟画布只在 GPU 合成路径上出问题（docs/09 §7）。 */
describe('WebUI 环境光画布', () => {
  it('画布不申请低延迟上下文', () => {
    const field = source('packages/webui/src/components/AmbientField.vue');
    expect(field).toContain(code('element.getContext("2d", { alpha: true })'));
    // 加回来即恢复刷新首帧的白闪：低延迟画布的独立 swap chain 首帧是未初始化的缓冲。
    expect(field).not.toContain(code('desynchronized: true'));
  });
});
