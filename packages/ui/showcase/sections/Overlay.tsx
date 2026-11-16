import { SectionHead } from '../components/SectionHead';
import { DialogBlock } from './overlay/DialogBlock';
import { DropdownBlock } from './overlay/DropdownBlock';
import { MenuBlock } from './overlay/MenuBlock';
import { PopoverBlock } from './overlay/PopoverBlock';
import { ToastBlock } from './overlay/ToastBlock';
import { TooltipBlock } from './overlay/TooltipBlock';
import { WindowBlock } from './overlay/WindowBlock';

/* 「浮层」一节：弹出框、下拉菜单、「在窗口里」、提示气泡、对话框和确认框、toast（@luoli/ui/overlay） */
const INDEX: readonly (readonly [string, string])[] = [
  ['ov-dd', '下拉钮'],
  ['ov-menu', '下拉菜单'],
  ['ov-popover', '弹出框'],
  ['ov-window', '在窗口里'],
  ['ov-tooltip', '提示气泡'],
  ['ov-dialog', '对话框和确认框'],
  ['ov-toast', 'toast'],
];

export function Overlay() {
  return (
    <>
      <SectionHead title="浮层">
        画在页面最上层的几样：弹出框、下拉菜单、提示气泡、对话框和确认框、toast。入口是{' '}
        <code>@luoli/ui/overlay</code>；Base UI 打底（焦点、键盘、Esc、点外面关、aria
        都是它给的），库只加类名和样子；样式在库的 <code>@layer ll.controls</code>{' '}
        里。用的地方要做两件事：根元素加 <code>isolation: isolate</code>
        （Base UI 的建议，浮层总在页面内容上面），toast 要在页面里挂一次{' '}
        <code>&lt;Toaster /&gt;</code>。
      </SectionHead>
      <div className="sc-ctl-bar">
        <nav className="sc-ctl-index" aria-label="这一节里的块" data-index="">
          {INDEX.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {name}
            </button>
          ))}
        </nav>
      </div>
      <DropdownBlock />
      <MenuBlock />
      <PopoverBlock />
      <WindowBlock />
      <TooltipBlock />
      <DialogBlock />
      <ToastBlock />
    </>
  );
}
