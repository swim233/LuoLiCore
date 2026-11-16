import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from '../controls/cx';
import { IconButton } from '../controls/IconButton';
import { IconX } from '../icons';

/* 对话框：Base UI 的 Dialog 打底（模态：焦点锁在里面、关了回到触发的按钮、页面滚动锁住、外面不接指针、Esc 和点遮罩关、role="dialog"、
   aria-labelledby / aria-describedby 都是它给的），这里只加类名和样子。
   - Dialog（根）、DialogTrigger、DialogClose：原样转出（要库的按钮就 render={<Button … />}）；createDialogHandle：触发按钮不在根里面时用；
   - DialogContent：Portal、遮罩、定位容器、窗体合成一个。size：sm 360、md 480（默认）、lg 640，宽度不超过视口减 32；closable：右上角一个关闭的图标按钮；
     container 指到某个元素里，对话框就留在里面；其余 props（initialFocus、finalFocus、className……）给窗体；
   - DialogTitle、DialogDescription：标题和说明（Base UI 把它们接到 aria-labelledby / aria-describedby）；
   - DialogBody：内容多时在这里面滚（标题和按钮不动）；内容真的超出时它自己进 Tab 键的顺序、键盘能滚（方向键、翻页）；
   - DialogFooter：按钮区，靠右，用库的 Button；
   - 嵌套：对话框里再开对话框（含 ConfirmDialog）时，后面那层稍微退后、变暗（Base UI 给的 --nested-dialogs、data-nested-dialog-open）；
   - 对话框里再开菜单、弹出框、提示气泡：不用传 container（Base UI 把它们的 Portal 放进对话框的 Portal 里，层级盖在窗体上面）；要传就传对话框里面的元素，
     不要传挂在 <body> 上的（层级 1000 对对话框的 1100，会被对话框盖在下面）。传对话框里面的元素也有后果：浮层被那个元素和 DialogBody 的 overflow 裁掉，
     长的菜单、弹出框会被裁；所以一般什么都不传；
   - 页面滚动锁住时和库的滚轮缓动（installWheel）一起用没问题：遮罩上的滚轮不带着后面的页面走，DialogBody 里照常有缓动。
   样子：窗体是夜空窗口的底（.ll-sky，圆角 --ll-radius-window，四周一圈细线和暗边），遮罩只压暗、不模糊。
   样子见 dialog.css。入口加载时不碰 DOM。 */
export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
export const createDialogHandle = BaseDialog.createHandle;

export type DialogSize = 'sm' | 'md' | 'lg';

export type DialogContentProps = Omit<BaseDialog.Popup.Props, 'className'> &
  Pick<BaseDialog.Portal.Props, 'container'> & {
    className?: string;
    /** 宽度：sm 360、md 480（默认）、lg 640 */
    size?: DialogSize;
    /** 右上角一个关闭的图标按钮 */
    closable?: boolean;
  };

export function DialogContent({
  container,
  size = 'md',
  closable,
  className,
  children,
  ...rest
}: DialogContentProps) {
  return (
    <BaseDialog.Portal container={container} className="ll-dialog-portal">
      <BaseDialog.Backdrop className="ll-dialog-dim" />
      <BaseDialog.Viewport className="ll-dialog-view">
        <BaseDialog.Popup
          className={cx('ll-sky ll-dialog', className)}
          data-size={size}
          data-closable={closable ? '' : undefined}
          {...rest}
        >
          {closable && (
            <BaseDialog.Close
              className="ll-dialog-close"
              render={
                <IconButton aria-label="关闭">
                  <IconX />
                </IconButton>
              }
            />
          )}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export type DialogTitleProps = Omit<BaseDialog.Title.Props, 'className'> & { className?: string };
export function DialogTitle({ className, ...rest }: DialogTitleProps) {
  return <BaseDialog.Title className={cx('ll-dialog-title', className)} {...rest} />;
}

export type DialogDescriptionProps = Omit<BaseDialog.Description.Props, 'className'> & {
  className?: string;
};
export function DialogDescription({ className, ...rest }: DialogDescriptionProps) {
  return <BaseDialog.Description className={cx('ll-dialog-desc', className)} {...rest} />;
}

/* 内容真的超出（有滚动条）时才让 DialogBody 进 Tab 键的顺序：键盘用户要能滚它。没超出时不进，免得抢了对话框打开时的初始焦点 */
function useScrollable(ref: { current: HTMLElement | null }) {
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrollable(el.scrollHeight > el.clientHeight + 1));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return scrollable;
}

export type DialogBodyProps = HTMLAttributes<HTMLDivElement>;
export function DialogBody({ className, ...rest }: DialogBodyProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollable = useScrollable(ref);
  return (
    <div
      ref={ref}
      className={cx('ll-dialog-body ll-scrollbar', className)}
      tabIndex={scrollable ? 0 : undefined}
      {...rest}
    />
  );
}

export type DialogFooterProps = HTMLAttributes<HTMLDivElement>;
export function DialogFooter({ className, ...rest }: DialogFooterProps) {
  return <div className={cx('ll-dialog-footer', className)} {...rest} />;
}
