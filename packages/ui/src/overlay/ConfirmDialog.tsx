import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '../controls/Button';
import { DialogContent, DialogDescription, DialogFooter, DialogTitle } from './Dialog';

/* 确认框：Base UI 的 AlertDialog 打底（和对话框同一套窗体，区别：点遮罩不关、role="alertdialog"，Esc 照样能关），样子和进出场同 DialogContent。
   - 受控：open + onOpenChange(open, details)；不受控：defaultOpen，加 trigger（一个 React 元素，它自己就是打开的按钮）；
   - 点「确认」先调 onConfirm 再关；点「取消」、按 Esc 只关；
   - 打开时的焦点：危险的（tone="danger"）落在「取消」上，普通的落在「确认」上（误按回车不会删东西）；关了回到触发的按钮；
   - 库已有的两步确认按钮（ConfirmButton）不动，两样并存：行内的小操作用两步按钮，要说清后果的用确认框；
   - 在对话框里再开确认框（嵌套）能用，下面那层会退后变暗；
   - container 同 DialogContent；children 是标题、说明下面多放的内容。 */
export interface ConfirmDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: BaseAlertDialog.Root.ChangeEventDetails) => void;
  /** 不受控时的触发按钮：它自己就是打开的那个元素 */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  /** 默认「确定」 */
  confirmLabel?: ReactNode;
  /** 默认「取消」 */
  cancelLabel?: ReactNode;
  /** danger：危险的操作，确认按钮是危险色，初始焦点在「取消」上 */
  tone?: 'danger';
  onConfirm?: () => void;
  container?: HTMLElement | null;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone,
  onConfirm,
  container,
  children,
}: ConfirmDialogProps) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const confirm = useRef<HTMLButtonElement | null>(null);
  return (
    <BaseAlertDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger && <BaseAlertDialog.Trigger render={trigger} />}
      <DialogContent
        size="sm"
        container={container}
        initialFocus={tone === 'danger' ? cancel : confirm}
      >
        <DialogTitle>{title}</DialogTitle>
        {description != null && <DialogDescription>{description}</DialogDescription>}
        {children}
        <DialogFooter>
          <BaseAlertDialog.Close render={<Button ref={cancel} />}>
            {cancelLabel}
          </BaseAlertDialog.Close>
          <BaseAlertDialog.Close
            render={<Button ref={confirm} variant={tone === 'danger' ? 'danger' : 'primary'} />}
            onClick={() => onConfirm?.()}
          >
            {confirmLabel}
          </BaseAlertDialog.Close>
        </DialogFooter>
      </DialogContent>
    </BaseAlertDialog.Root>
  );
}
