/* 浮层：弹出框、下拉菜单、提示气泡、对话框和确认框、toast（Base UI 打底，薄薄的一层：加类名和样子）。
   入口只做转出，加载时不碰 DOM（node 里能 import）。样式在这个目录下的 css 文件里，由 ../styles.css 引。
   用的地方要做的两件事：根元素加 isolation: isolate（Base UI 的建议：浮层总在页面内容上面，页面里的 z-index 干扰不到它）；
   toast 要在页面里挂一次 <Toaster />。 */
export {
  Popover,
  PopoverButton,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  createPopoverHandle,
} from './Popover';
export type {
  PopoverButtonProps,
  PopoverContentProps,
  PopoverDescriptionProps,
  PopoverProps,
  PopoverTitleProps,
} from './Popover';
export type { DropdownKind, DropdownSize } from './grow';
export {
  Menu,
  MenuButton,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  createMenuHandle,
} from './Menu';
export type {
  MenuButtonProps,
  MenuCheckboxItemProps,
  MenuContentProps,
  MenuGroupLabelProps,
  MenuGroupProps,
  MenuItemProps,
  MenuRadioGroupProps,
  MenuRadioItemProps,
  MenuSeparatorProps,
} from './Menu';
export { Tooltip, TooltipProvider } from './Tooltip';
export type { TooltipProps, TooltipProviderProps } from './Tooltip';
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  createDialogHandle,
} from './Dialog';
export type {
  DialogBodyProps,
  DialogContentProps,
  DialogDescriptionProps,
  DialogFooterProps,
  DialogSize,
  DialogTitleProps,
} from './Dialog';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';
export { Toaster, toast } from './toast';
export type { ToastOptions, ToasterProps } from './toast';
