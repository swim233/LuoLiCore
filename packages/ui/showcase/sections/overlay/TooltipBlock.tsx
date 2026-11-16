import { IconButton } from '../../../src/controls';
import {
  IconArrange,
  IconEye,
  IconMax,
  IconMin,
  IconRestore,
  IconSearch,
} from '../../../src/icons';
import { Tooltip } from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「提示气泡」一块：一排图标按钮各带一个、四个方向、连着扫过去、长文字换行 */
const ICONS: [typeof IconMin, string][] = [
  [IconMin, '缩小到胶囊'],
  [IconMax, '放大到全屏'],
  [IconRestore, '还原'],
  [IconArrange, '整理桌面（Esc 退出）'],
  [IconSearch, '搜索'],
  [IconEye, '显示'],
];

export function TooltipBlock() {
  return (
    <Group id="ov-tooltip" title="提示气泡" sub="Tooltip · .ll-tip">
      <p className="sc-note">
        图标按钮没有文字，悬停或键盘走到它上面时出来的一小块说明。它只是视觉上的补充：触屏上不出，读屏念不到，所以触发的按钮自己要带{' '}
        <code>aria-label</code>（和气泡里的字对得上）。样子：小的深色玻璃块、圆角
        6、没有小箭头；鼠标移不进去；只有透明度的 0.1 秒淡入淡出。延迟默认 500 毫秒（页面根上放一个{' '}
        <code>TooltipProvider</code>）； 连着扫过一排按钮时，一个刚关、马上移到下一个（400
        毫秒以内）立即出现，不再等。
      </p>
      <p className="sc-note">
        用法：
        <code>
          &lt;Tooltip content="缩小到胶囊"&gt;&lt;IconButton aria-label="缩小到胶囊" …
          /&gt;&lt;/Tooltip&gt;
        </code>
        。触发的元素就是那个子元素，不多包一层；<code>side</code> 默认 top、<code>sideOffset</code>{' '}
        6；<code>disabled</code> 不出气泡；<code>delay</code>、<code>closeDelay</code>{' '}
        单独改这一个。面板里的原生 <code>title</code> 这一步不换。
      </p>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="tip-row">
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">一排图标按钮（连着扫过去，第二个起立即出现）</span>
            <div className="sc-ov-icons">
              {ICONS.map(([Icon, text]) => (
                <Tooltip key={text} content={text}>
                  <IconButton aria-label={text}>
                    <Icon />
                  </IconButton>
                </Tooltip>
              ))}
            </div>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">四个方向</span>
            <div className="sc-ov-icons">
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <Tooltip key={side} content={`side=${side}`} side={side}>
                  <IconButton aria-label={`方向 ${side}`} data-tip-side={side}>
                    <IconSearch />
                  </IconButton>
                </Tooltip>
              ))}
            </div>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">长文字（最宽 240，超出换行）</span>
            <Tooltip content="这是一段很长的说明文字，用来看气泡最宽 240 像素、超出就换行是什么样子，它不会撑出视口也不会变成一整行。">
              <IconButton aria-label="长说明" data-tip="long">
                <IconEye />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </Stage>
    </Group>
  );
}
