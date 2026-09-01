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
    expect(css).toContain(code('.auth-page::before, .auth-copy, .auth-card { animation: none !important; }'));
  });
});
