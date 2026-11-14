import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cx } from './cx';

/* 标签页：Base UI 的 Tabs 打底（键盘走法、roving tabindex、aria-selected / aria-controls / role 都是它给的），这里只加类名和样子。
   - 方向键在标签之间走（横排左右、orientation="vertical" 时上下），Home、End 到两头，只有选中的那个在 Tab 键的顺序里；
   - 默认方向键只挪焦点，回车或空格才选中（Base UI 的做法）；TabList 的 activateOnFocus 原样透出，走到就选中；
   - 根 Tabs 渲染一个 <div>（多包的一层，没有任何样式）；要不要 TabPanel、内容区怎么摆由用的地方定；
   - 入口加载时不碰 DOM。样式见 controls/tabs.css。 */
export type TabsProps = Omit<BaseTabs.Root.Props, 'className'> & { className?: string };
export function Tabs({ className, ...rest }: TabsProps) {
  return <BaseTabs.Root className={cx('ll-tabs', className)} {...rest} />;
}

export type TabListProps = Omit<BaseTabs.List.Props, 'className'> & {
  className?: string;
  /** 不写是药丸一排；side 是侧栏（竖排，一项一整行） */
  variant?: 'side';
};
export function TabList({ variant, className, ...rest }: TabListProps) {
  return (
    <BaseTabs.List className={cx('ll-tabs-list', className)} data-variant={variant} {...rest} />
  );
}

export type TabProps = Omit<BaseTabs.Tab.Props, 'className'> & {
  className?: string;
  /** 不写是 sm（高 26）；md 是高 34、左边留给图标 */
  size?: 'md';
};
export function Tab({ size, className, ...rest }: TabProps) {
  return <BaseTabs.Tab className={cx('ll-tab', className)} data-size={size} {...rest} />;
}

export type TabPanelProps = Omit<BaseTabs.Panel.Props, 'className'> & { className?: string };
export function TabPanel({ className, ...rest }: TabPanelProps) {
  return <BaseTabs.Panel className={cx('ll-tab-panel', className)} {...rest} />;
}
