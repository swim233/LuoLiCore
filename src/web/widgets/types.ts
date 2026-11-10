import type { ComponentType, ReactNode } from 'react';
import type { BusEventName, BusEvents } from '../model/bus';

/* 全屏时带给部件的参数：现在只有会话里要选中哪个会话 */
export interface FullParams {
  convId?: string;
}

/* 部件注册表：新增部件 = 注册一个定义。桌面、胶囊栏、全屏图标条、收纳盒都自动适配 */
export type SizeKey = '1x1' | '2x1' | '1x2' | '2x2' | 'full';
export interface WidgetHandle {
  id: string;
  /** 订阅总线事件（部件卸载时自动取消） */
  on<K extends BusEventName>(type: K, fn: (payload: BusEvents[K]) => void): void;
  /** 边缘流光（'stream'）或红色脉冲（'error'） */
  flash(kind: 'stream' | 'error'): void;
  openFull(targetId?: string, params?: FullParams): void;
  readonly isFull: boolean;
  /** 等这个部件自己的形变（从胶囊展开、打开全屏、全屏里切换）结束以后再调 fn；现在没有形变就马上调。返回取消函数。
      形变期间看到的是挂上那一刻的画面（桌面上是冻结的副本），数字滚动这类一次性的入场动画要等它结束才开始，用户才看得到整段 */
  afterMorph(fn: () => void): () => void;
}
export interface ViewProps {
  mode: 'normal' | 'full';
  params: FullParams;
  handle: WidgetHandle;
}
export interface WidgetDef {
  id: string;
  name: string;
  /** 18×18 的线条图标 */
  icon: ReactNode;
  defaultSize: SizeKey;
  /** 自带夜空（「此刻」）：卡片背景是一层小星空，不用面板底色 */
  sky?: boolean;
  /** 这些总线事件会让缩略文字（thumb、sub）重算；另外每 30 秒重算一次 */
  refreshOn?: BusEventName[];
  /** 订阅事件、放特效等副作用；返回的函数在部件被移除时调用 */
  init?(w: WidgetHandle): void | (() => void);
  /** 缩略（胶囊）右边那一行字，可以带 <em>（金色） */
  thumb(): ReactNode;
  /** 普通和全屏的标题栏里，标题旁边的小字 */
  sub?(): string;
  /** 普通（'normal'）或全屏（'full'）的内容。普通视图只在部件以卡片形式显示在桌面上时才存在；全屏视图每次进全屏新建 */
  View: ComponentType<ViewProps>;
}
