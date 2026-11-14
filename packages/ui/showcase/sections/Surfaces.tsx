import { Button } from '../../src/controls';
import { Compare } from '../components/Compare';
import { SectionHead } from '../components/SectionHead';
import { Stage } from '../components/Stage';
import { useSkyCheck } from '../lib/sky-check';
import { Group, Merged, Now } from './controls/shared';

/* 第五节「面」：三种面（玻璃面板、半透明面板、夜空窗口的底），纯 CSS，没有 React 组件（直接写类名）。
   玻璃要垫在有东西的底上才看得出模糊，所以摆在夜空窗口（带星点）上。每样都有和面板现在写法的对比。 */

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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="surf-tray"
        title="玻璃面板：收纳盒（.tray）"
        note="圆角 18 → 16（玻璃统一的 --ll-radius-xl）；底、边光、模糊（16px 加饱和度）、内边距 10 / 14 都一样。固定在窗口底部居中、进出场、拖进去时的高亮留在面板（「现在」那边只去掉了固定位置和藏起来的状态，别的一个字没动）。"
        now={
          <Now>
            <div className="tray is-on" data-item="tray">
              收纳盒：整理时把部件拖进来
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="ll-glass sc-m-tray" data-item="tray">
              收纳盒：整理时把部件拖进来
            </div>
          </Merged>
        }
      />
      <Compare
        id="surf-glassbtn"
        title="玻璃的模糊：现在库里的按钮 glass（blur 12px）和统一后的（--ll-glass-blur）"
        note="库里的按钮 glass 样子这一段先不改（面板的「回到最新」正在用它，改了面板马上就变）；右边那一侧用展示页自己的样式临时盖成新变量，给你看会差多少：模糊从 12px 变成 16px 并加上 1.2 的饱和度。第二段再改库里的按钮。"
        now={
          <Now>
            <Button variant="glass" data-item="glass-btn">
              回到最新
            </Button>
          </Now>
        }
        merged={
          <Merged className="sc-glass16">
            <Button variant="glass" data-item="glass-btn">
              回到最新
            </Button>
          </Merged>
        }
      />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="surf-segsum"
        title="半透明面板：时间线里分段的摘要（.seg-sum）"
        note="底、细线、圆角 12、内边距、字都一样（这一条没有差别）。设置里的两种分组外框（.skel-live、.skel-group）在「骨架条」「表单项」两块里对比，统计方格在「统计格」里对比。"
        now={
          <Now>
            <div className="seg-sum" data-item="seg-sum">
              <b data-item="seg-sum-b">之前的对话摘要</b>
              小明和小红在讨论周末去哪里露营，最后定了周六早上八点在北门集合，小明负责订营地，小红带帐篷。
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="ll-inset sc-m-seg-sum" data-item="seg-sum">
              <b data-item="seg-sum-b">之前的对话摘要</b>
              小明和小红在讨论周末去哪里露营，最后定了周六早上八点在北门集合，小明负责订营地，小红带帐篷。
            </div>
          </Merged>
        }
      />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="surf-card"
        title="夜空窗口：部件窗口（.w-card 和它里面的 .w-vig）"
        note="底、外阴影、圆角 22、裁切、层叠上下文、暗边和细线都一样（没有差别）。位置、高、盒模型、暗边在第几层（z-index 3）留在面板；激活、浮起、全屏、整理、悬停的阴影和过渡也留在面板。形变时面板靠 background-color: transparent !important 去掉底色那一层，换成库的以后同样成立（底还是同一条多层背景，最后一层是颜色）。"
        stage="page"
        now={
          <Now>
            <div className="sc-env-wc">
              <div className="w-card" data-item="card">
                <div style={{ padding: 24 }}>窗口：夜空的底，加四周的暗边。</div>
                <i className="w-vig" aria-hidden="true" data-item="vig" />
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-wc">
              <div className="ll-sky sc-m-wcard" data-item="card">
                <div style={{ padding: 24 }}>窗口：夜空的底，加四周的暗边。</div>
                <i className="ll-sky-vig sc-m-vig" aria-hidden="true" data-item="vig" />
              </div>
            </div>
          </Merged>
        }
      />
      <Compare
        id="surf-cap"
        title="夜空窗口：胶囊（.cap）"
        note="底、细线、阴影、圆角（999）、裁切、层叠上下文都一样；高 44、内边距、里面的排列、光标、悬停和呼唤时的光留在面板。"
        stage="page"
        now={
          <Now>
            <button type="button" className="cap" data-item="cap">
              <span style={{ fontSize: 13, color: 'var(--ll-fg-2)' }}>此刻</span>
            </button>
          </Now>
        }
        merged={
          <Merged>
            <button type="button" className="ll-sky sc-m-cap" data-shape="pill" data-item="cap">
              <span style={{ fontSize: 13, color: 'var(--ll-fg-2)' }}>此刻</span>
            </button>
          </Merged>
        }
      />
      <Compare
        id="surf-ghost"
        title="夜空窗口：部件消失时留下的空壳（.ghost）"
        note="底、圆角、裁切一样；阴影比窗口多一圈光（状态带出来的），留在面板。"
        stage="page"
        now={
          <Now>
            <div className="ghost" style={{ width: 240, height: 100 }} data-item="ghost" />
          </Now>
        }
        merged={
          <Merged>
            <div
              className="ll-sky sc-m-ghost"
              style={{ width: 240, height: 100 }}
              data-item="ghost"
            />
          </Merged>
        }
      />
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
