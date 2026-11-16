import { SectionHead } from '../components/SectionHead';
import { DustBlock } from './fx/DustBlock';
import { HoverBlock } from './fx/HoverBlock';
import { SkyBlock } from './fx/SkyBlock';

/* 「特效」一节：背景星空、星尘（迸发、汇聚、消散）、三种悬停的效果和流光（@luoli/ui/fx）。
   样式是单独的一份 @luoli/ui/fx.css，展示页入口另引一次 */
const INDEX: readonly (readonly [string, string])[] = [
  ['fx-sky', '背景星空'],
  ['fx-dust', '星尘'],
  ['fx-hover', '悬停和流光'],
];

export function Fx() {
  return (
    <>
      <SectionHead title="特效">
        窗口和背景上的特效：背景星空（整页垫在最底下的画布，星点会漂会闪）、星尘（迸发、汇聚成形、散开，画在最上面的整屏画布上）、三种悬停的效果（流光、边光、倾斜）、流光。入口是{' '}
        <code>@luoli/ui/fx</code>，样式是单独的 <code>@luoli/ui/fx.css</code>
        （放在总样式后面）。画布的活在 Worker
        里（OffscreenCanvas），不占主线程。库不认识外壳：窄屏、性能低、全屏时要不要停住、星尘的
        Worker 怎么建，都由用的地方传进来或调用。
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
      <SkyBlock />
      <DustBlock />
      <HoverBlock />
    </>
  );
}
