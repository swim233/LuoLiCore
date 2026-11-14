import { Switch } from '../../../src/controls';
import { useMotionOn } from '../../../src/motion';
import { Stage } from '../../components/Stage';
import { useWheelEase, setWheelEase } from '../../lib/wheel-demo';
import { Group } from '../controls/shared';

/* 「滚轮缓动」一块：installWheel() 整个页面装一份，鼠标滚轮滚一格时内容带着缓动滑过去；下面的开关能拆掉，对着浏览器原生的滚动比 */
const LINES = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`);

export function WheelBlock() {
  const on = useWheelEase();
  const motion = useMotionOn();
  return (
    <Group
      id="scr-wheel"
      title="滚轮缓动与滚动条"
      sub="installWheel · .ll-scrollbar · --ll-scrollbar"
    >
      <p className="sc-note">
        <code>installWheel(&#123; busy &#125;)</code> 在 document
        上挂一份监听，按滚轮事件的位置找到该滚的竖向滚动区（从目标往外，第一个 overflow-y 是
        auto/scroll、内容真的超出的元素；找到页面根就用
        scrollingElement），新加的滚动区不用单独接。鼠标滚轮滚一格时内容带着缓动滑过去（约 0.3
        秒，走的距离和浏览器原生的一样）。<code>busy</code>{' '}
        是用的地方给的函数，返回真表示此刻有大动画在走，这时不接管（面板传形变、让位动画的判断）。
      </p>
      <p className="sc-note">
        <b>不接管、交给浏览器的：</b>触控板一类的小步连续事件、按着 Ctrl/Shift/Alt/Meta
        的滚轮、动画关掉时、<code>busy()</code> 为真时、输入框（textarea、input、select）里、带{' '}
        <code>data-native-wheel</code>{' '}
        的元素里（下面那一排）；键盘、按下鼠标、触屏会让还没走完的缓动立刻放手。
        滚到头以后接着滚谁和原生一样：设了 <code>overscroll-behavior: contain</code>{' '}
        的停在这里，没设的接着滚外面一层。现在动画是{motion ? '开着' : '关着'}的。
      </p>
      <div className="sc-pill-row sc-scr-ctl">
        <Switch
          checked={on}
          onChange={setWheelEase}
          label="滚轮缓动（installWheel）"
          data-demo="wheel-switch"
        />
        <span className="sc-stage-tag">关掉就是浏览器原生的滚动（整个展示页都跟着变）</span>
      </div>
      <Stage kind="sky">
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }}>
          <div className="sc-scr-box ll-scrollbar" data-demo="wheel-box-contain" tabIndex={0}>
            <b>
              设了 overscroll-behavior: contain：滚到头停在这里（加了
              .ll-scrollbar：细滚动条加库的颜色）
            </b>
            {LINES.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </div>
          <div
            className="sc-scr-box sc-scr-loose ll-scrollbar"
            data-demo="wheel-box-loose"
            tabIndex={0}
          >
            <b>没设：滚到头接着滚外面一层</b>
            {LINES.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </div>
          <div className="sc-scr-strip ll-scrollbar" data-native-wheel="" data-demo="wheel-native">
            <span>带 data-native-wheel：里面的滚轮不接管 → </span>
            {LINES.map((t) => (
              <i key={t}>{t}</i>
            ))}
          </div>
        </div>
      </Stage>
    </Group>
  );
}
