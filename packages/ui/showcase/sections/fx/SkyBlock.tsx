import { useState } from 'react';
import { Switch } from '../../../src/controls';
import { sky } from '../../../src/fx';
import { Group } from '../controls/shared';

/* 「背景星空」一块：就是整页垫在最底下的那张画布（展示页的 .sc-sky），在这一块里演示它的两个开关 */
export function SkyBlock() {
  const [held, setHeld] = useState(false);
  return (
    <Group id="fx-sky" title="背景星空" sub="sky · sky.worker.ts">
      <p className="sc-note">
        <code>sky.start(canvas, {'{ narrow, lowPower }'})</code>：把一张画布交给
        Worker（同一张画布只能转移一次，已经启动了就什么也不做，React 严格模式下 effect
        跑两遍也不怕），星空的 Worker 由库自己建（也可以传 <code>worker</code>{' '}
        自己建好的）。星点每颗各自漂移、按正弦闪烁，约 4%
        是带光芒的大星，另有两组淡淡的星座连线；帧率封顶 30；窄屏、性能低时星点更少。 窗口大小变了调{' '}
        <code>sky.size()</code>；<b>页面顶上的「动画」开关</b>变了调 <code>sky.sync()</code>
        ：关掉时停在一帧静态图（星点亮度停在中间值），开了接着动。 全屏之类盖住了整个背景的时候调{' '}
        <code>sky.hold(true)</code> 把它停住，省得白画。
        整页背后现在垫着的就是它，下面的开关能停住它。
      </p>
      <div className="sc-pill-row sc-fx-ctl">
        <Switch
          checked={held}
          onChange={(on) => {
            setHeld(on);
            sky.hold(on);
          }}
          label="停住背景星空（sky.hold）"
          data-demo="sky-hold"
        />
      </div>
    </Group>
  );
}
