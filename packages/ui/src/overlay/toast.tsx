import { Toast as BaseToast } from '@base-ui/react/toast';
import { useEffect } from 'react';
import { Dot } from '../controls/Dot';
import { IconX } from '../icons';
import { createToastBus } from './toast-bus';
import type { ToastCommand } from './toast-bus';

/* toast：Base UI 的 Toast 打底（最多同时几条、超出的淡出、悬停和焦点在里面时暂停计时、往下划掉、Esc 关聚焦的那条、F6 跳进通知区、
   出错的用高优先级让读屏马上念）。这里做的：一个普通函数 toast()、一个挂一次的 <Toaster />、样子。
   - toast(message, options?)：普通函数，React 外面也能调，返回 id。options：tone（'danger' 或不写）、title（有它时 message 是下面的说明）、
     action（{ label, onClick }：一个按钮，点了先调 onClick 再关掉这一条）、duration（毫秒，0 是不自动消失，不写用 Toaster 的）、
     id（给已有的 id 就原地更新那一条：换字、重新计时；不是已有的就用这个 id 新建）。读屏念的是 title 和 message，别把重要的信息只放在别处；
   - toast.dismiss(id?)：关一条，不给 id 关全部；
   - <Toaster />：页面里只挂一次（挂两个，每条会显示两遍：两个都订阅同一个管理器；卸掉一个，另一个照常收得到）。limit（最多同时显示几条，默认 3，超出的最旧的淡出）、
     duration（默认停留多久，毫秒，默认 4000）；几条一条条排开，最新的在最下面；
     位置在底部居中，离底的距离是变量 --ll-toast-bottom（默认 24）；容器自己不接鼠标，每条 toast 接。通知区的 aria-label 是「通知」；
   - <Toaster /> 挂上之前调的 toast() 不会丢：Base UI 的管理器没有缓冲（还没人订阅时发的指令就没了），所以 toast() 把指令交给 toast-bus.ts 的总线，
     Toaster 挂上时按顺序补发（同一个 id 合并、先发后关的撤掉，见 toast-bus.ts）；
   - 入口加载时不碰 DOM：Base UI 的管理器第一次要用（Toaster 挂上）时才建。
   样子见 toast.css。 */
export interface ToastOptions {
  /** danger：出错的，左边一个危险色的点，读屏马上念 */
  tone?: 'danger';
  /** 标题；有标题时 message 是下面的说明 */
  title?: string;
  /** 一个按钮：点了先调 onClick 再关掉这一条 */
  action?: { label: string; onClick: () => void };
  /** 停留多久（毫秒）；0 是不自动消失；不写用 <Toaster duration> */
  duration?: number;
  /** 给已有的 id 就原地更新那一条；不是已有的就用这个 id 新建 */
  id?: string;
}

interface Item {
  message: string;
  options: ToastOptions;
}

const bus = createToastBus<Item>();
let manager: ReturnType<typeof BaseToast.createToastManager> | undefined;
const getManager = () => (manager ??= BaseToast.createToastManager());

let seq = 0;
export function toast(message: string, options: ToastOptions = {}): string {
  const id = options.id ?? `ll-toast-${++seq}`;
  bus.post({ type: 'put', id, item: { message, options } });
  return id;
}
/** 关一条；不给 id 关全部 */
toast.dismiss = (id?: string): void => bus.post({ type: 'close', id });

/* 总线上的指令送给 Base UI 的管理器 */
function send(cmd: ToastCommand<Item>) {
  const m = getManager();
  if (cmd.type === 'close') {
    m.close(cmd.id);
    return;
  }
  const { message, options } = cmd.item;
  const { id } = cmd;
  const { action } = options;
  m.add({
    id,
    title: options.title,
    description: message,
    type: options.tone,
    priority: options.tone === 'danger' ? 'high' : 'low',
    timeout: options.duration,
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            action.onClick();
            m.close(id);
          },
        }
      : undefined,
  });
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((t) => (
    <BaseToast.Root
      key={t.id}
      toast={t}
      className="ll-glass ll-toast"
      data-block={t.title || t.actionProps ? '' : undefined}
    >
      <BaseToast.Content className="ll-toast-content">
        {t.type === 'danger' && <Dot tone="danger" />}
        <div className="ll-toast-text">
          {t.title && <BaseToast.Title className="ll-toast-title" />}
          <BaseToast.Description className="ll-toast-msg" />
        </div>
        {t.actionProps && (
          <BaseToast.Action
            className="ll-btn ll-toast-action"
            data-variant="ghost"
            data-size="sm"
          />
        )}
        <BaseToast.Close className="ll-icon-btn ll-toast-close" aria-label="关闭">
          <IconX />
        </BaseToast.Close>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

export interface ToasterProps {
  /** 最多同时显示几条，默认 3；超出的最旧的淡出 */
  limit?: number;
  /** 默认停留多久（毫秒），默认 4000 */
  duration?: number;
}

export function Toaster({ limit = 3, duration = 4000 }: ToasterProps) {
  /* 挂上时接总线（先补发挂上之前存着的）。Provider 在下面，它订阅管理器的 effect 比这一个先跑，补发的指令不会落空 */
  /* 每次挂上包一个新的函数：总线按函数撤各自这一次接上，几个 Toaster 同时挂着时（本来不该）谁先卸掉都不影响剩下的 */
  useEffect(() => bus.attach((cmd) => send(cmd)), []);
  return (
    <BaseToast.Provider toastManager={getManager()} limit={limit} timeout={duration}>
      <BaseToast.Portal>
        <BaseToast.Viewport className="ll-toaster" aria-label="通知">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}
