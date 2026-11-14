import { SectionHead } from '../components/SectionHead';
import { Stage } from '../components/Stage';
import { useSkyCheck } from '../lib/sky-check';
import { Group } from './controls/shared';

/* 第五节「面」：三种面（玻璃面板、半透明面板、夜空窗口的底），纯 CSS，没有 React 组件（直接写类名）。
   玻璃要垫在有东西的底上才看得出模糊，所以摆在夜空窗口（带星点）上。 */

const INDEX: readonly (readonly [string, string])[] = [
  ['surf-glass', '玻璃面板'],
  ['surf-inset', '半透明面板'],
  ['surf-sky', '夜空窗口的底'],
];

const SAMPLE = '一块面：圆角、底、边光都由类名给。';

function GlassBlock() {
  return (
    <Group id="surf-glass" title="玻璃面板" sub=".ll-glass">
      <p className="sc-note">
        底 --ll-glass-bg、边光和下方的阴影 --ll-glass-edge、背后的模糊 --ll-glass-blur（blur(16px)
        saturate(1.2)，整个库就这一档）。圆角默认 --ll-radius-xl（16）；data-shape="pill"
        是全圆角。位置、大小、内边距、层级、进出场由用的地方定。
      </p>
      <Stage kind="sky">
        <div
          className="sc-pill-row"
          style={{ alignItems: 'flex-start', minHeight: 110 }}
          data-demo="glass"
        >
          <div
            className="ll-glass"
            style={{ width: 240, padding: '12px 16px' }}
            data-demo="glass-default"
          >
            {SAMPLE}
          </div>
          <div
            className="ll-glass"
            data-shape="pill"
            style={{ padding: '8px 18px' }}
            data-demo="glass-pill"
          >
            药丸形
          </div>
        </div>
      </Stage>
    </Group>
  );
}

function InsetBlock() {
  return (
    <Group id="surf-inset" title="半透明面板" sub=".ll-inset">
      <p className="sc-note">
        嵌进去的一块：半透明的底 --ll-inset-bg
        加一圈细线（--ll-inset-line，画在阴影里，不占版面）。圆角默认
        --ll-radius-lg（12）；data-size="sm" 是
        --ll-radius-md（10），给嵌在别的东西里面的小块用。内边距、排版由用的地方定。统计方格（Stat）、占位输入框（Skeleton
        block）是同一个样子。
      </p>
      <Stage kind="sky">
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }} data-demo="inset">
          <div
            className="ll-inset"
            style={{ width: 240, padding: '10px 14px' }}
            data-demo="inset-default"
          >
            {SAMPLE}
          </div>
          <div
            className="ll-inset"
            data-size="sm"
            style={{ width: 240, padding: '8px 10px' }}
            data-demo="inset-sm"
          >
            小一号：嵌在别的东西里面。
          </div>
        </div>
      </Stage>
    </Group>
  );
}

function SkyBlock() {
  return (
    <Group id="surf-sky" title="夜空窗口的底" sub=".ll-sky · .ll-sky-vig">
      <p className="sc-note">
        .ll-sky：底（压暗层、两层星点、左上一团紫、右下一团蓝、底色）、外阴影、窗口的圆角（22）、内容贴着圆角裁掉（overflow:
        hidden）、自成一个层叠上下文（isolation: isolate，里面的玻璃以它为界）。
        .ll-sky-vig：盖在内容上面的一层，画四周的细线和向内压暗；铺满父元素（父元素要有定位）、跟着圆角、不挡鼠标，在第几层由用的地方定。
        data-shape="pill"（胶囊）：全圆角，细线直接画在自己的阴影里，没有压暗那一层。激活、浮起、全屏、整理、悬停带出来的阴影和过渡是外壳的事，不在库里。
        星点贴图由 startSkyStars()（@luoli/ui/sky-stars）启动时画好（按
        devicePixelRatio，缩放后自动重画），这一页的所有夜空舞台用的就是它。
      </p>
      <Stage kind="page">
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }} data-demo="sky">
          <div
            className="ll-sky"
            style={{
              position: 'relative',
              width: 280,
              height: 150,
              padding: 16,
              boxSizing: 'border-box',
            }}
            data-demo="sky-window"
          >
            <div style={{ padding: 8 }}>窗口：夜空的底，加四周的暗边。</div>
            <i className="ll-sky-vig" aria-hidden="true" style={{ zIndex: 3 }} />
          </div>
          <div
            className="ll-sky"
            style={{
              position: 'relative',
              width: 280,
              height: 150,
              padding: 16,
              boxSizing: 'border-box',
            }}
            data-demo="sky-novig"
          >
            没有暗边的窗口：只有底和圆角。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              type="button"
              className="ll-sky sc-m-cap"
              data-shape="pill"
              data-demo="sky-pill"
            >
              <span style={{ fontSize: 13, color: 'var(--ll-fg-2)' }}>胶囊</span>
            </button>
          </div>
        </div>
      </Stage>
    </Group>
  );
}

export function Surfaces() {
  const check = useSkyCheck();
  return (
    <>
      <SectionHead title="面">
        面板里「一块有底的面」的三种样子：玻璃面板（菜单、弹出框、提示条、收纳盒）、半透明面板（设置的分组、摘要、统计方格、占位输入框）、夜空窗口的底（窗口、胶囊、消失的空壳）。
        纯 CSS，直接写类名，没有 React 组件。
      </SectionHead>
      {!check.ok && (
        <div className="sc-alert" role="alert" data-sky-alert="">
          <b>星点贴图的参数两处对不上</b>（tokens.css 的 --ll-sky-bg 里静态写的一份，和 sky-stars.ts
          的 SKY_TILES，按数值比）：
          <ul>
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
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
      <GlassBlock />
      <InsetBlock />
      <SkyBlock />
    </>
  );
}
