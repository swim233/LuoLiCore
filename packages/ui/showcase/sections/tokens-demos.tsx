import type { ReactNode } from 'react';
import { Stage } from '../components/Stage';

/* 「变量」一节里几组需要「画成真的一小块面」的示例：文字四档、控件的底、嵌进去的面、玻璃、夜空窗口、气泡、每人一色、字体。
   全部引用库的变量，不另写一套数字；只是示意变量，不是控件、气泡组件 */

const TEXT_LINES: [string, string, string][] = [
  ['--ll-fg', 'var(--ll-fg)', '主要文字：星空观测站，今晚 22:30 集合 Stargazing 0123'],
  ['--ll-fg-2', 'var(--ll-fg-2)', '次要文字：英仙座流星雨极大期在 8 月 12 日前后'],
  ['--ll-fg-3', 'var(--ll-fg-3)', '三级文字：没选中的标签、辅助的说明 Perseids 12–13 Aug'],
  ['--ll-fg-dim', 'var(--ll-fg-dim)', '最淡的字：时间 11:46、条数 10 条消息、id -1001288362002'],
];
export function TextDemo() {
  return (
    <div className="sc-demo-2">
      {(['page', 'sky'] as const).map((kind) => (
        <Stage key={kind} kind={kind}>
          <div className="sc-stage-tag">
            {kind === 'page' ? '垫在页面底上' : '垫在夜空窗口的底上'}
          </div>
          {TEXT_LINES.map(([name, color, text]) => (
            <p key={name} className="sc-textline" style={{ color }}>
              <code>{name}</code>
              {text}
            </p>
          ))}
        </Stage>
      ))}
    </div>
  );
}

export function CtlDemo() {
  return (
    <Stage kind="sky">
      <div className="sc-faces">
        <div className="sc-face" style={{ background: 'var(--ll-ctl-bg)' }}>
          平时
        </div>
        <div className="sc-face" style={{ background: 'var(--ll-ctl-bg-hover)' }}>
          悬停
        </div>
        <div className="sc-face" style={{ background: 'var(--ll-ctl-bg-on)' }}>
          选中
        </div>
        <div className="sc-face is-pill" style={{ background: 'var(--ll-ctl-bg)' }}>
          药丸
        </div>
      </div>
      <div className="sc-stage-note">没有边框，只靠底色。这只是几块面，不是按钮、开关。</div>
    </Stage>
  );
}

export function InsetDemo() {
  return (
    <Stage kind="sky">
      <div className="sc-inset">
        <div className="sc-inset-title">设置的分组</div>
        <div className="sc-inset-row">
          <span>动画</span>
          <span className="sc-inset-input">跟随系统</span>
        </div>
        <div className="sc-inset-row">
          <span>折叠的内容</span>
          <span className="sc-inset-fold">思考了 4 秒 ›</span>
        </div>
      </div>
    </Stage>
  );
}

export function GlassDemo() {
  return (
    <div className="sc-glass-stage">
      <i className="sc-blob" style={{ left: '4%', top: '30px', background: 'var(--ll-accent)' }} />
      <i className="sc-blob" style={{ left: '34%', top: '48px', background: 'var(--ll-star)' }} />
      <i
        className="sc-blob"
        style={{ left: '62%', top: '24px', background: 'var(--ll-sky-glow-a)' }}
      />
      <i
        className="sc-blob"
        style={{ left: '84%', top: '60px', background: 'var(--ll-ok)', width: 90 }}
      />
      <div className="sc-glass">
        <div className="sc-glass-item is-on">星空观测站</div>
        <div className="sc-glass-item">周末打球</div>
        <div className="sc-glass-item">读书会</div>
      </div>
      <div className="sc-glass is-toast">已复制</div>
    </div>
  );
}

export function SkyDemo() {
  return (
    <div className="sc-sky-demo">
      <div className="sc-skywin">
        <div className="sc-skywin-side">全屏会话左边的列表（--ll-side-bg）</div>
        <div className="sc-skywin-main">
          <div className="sc-skywin-title">夜空窗口</div>
          <div className="sc-dim">
            底、外阴影、四周的细线和暗边、两层星点贴图（startSkyStars() 画好写进变量）。
          </div>
        </div>
        <div className="sc-skywin-tint">窗格渐变的底（--ll-pane-tint）</div>
      </div>
      <div className="sc-skycap">胶囊 · 只有细线（--ll-sky-line-cap）</div>
    </div>
  );
}

function Bubble({
  role,
  name,
  children,
}: {
  role: 'other' | 'self' | 'assistant';
  name: string;
  children: ReactNode;
}) {
  return (
    <div className={`sc-msg is-${role}`}>
      <div className="sc-msg-name">{name}</div>
      <div
        className="sc-bubble"
        style={{ background: `var(--ll-bubble-${role}-bg)`, color: `var(--ll-bubble-${role}-fg)` }}
      >
        {children}
      </div>
    </div>
  );
}

export function BubbleDemo() {
  return (
    <Stage kind="sky">
      <div className="sc-chat">
        <Bubble role="other" name="月亮不睡">
          @洛璃 帮我看看这张对焦准不准
        </Bubble>
        <Bubble role="self" name="自己">
          那 17 号一起去水库吗？
        </Bubble>
        <Bubble role="assistant" name="洛璃">
          对焦挺准的！环形山的边缘很锐利，后期拉一下就好～ 试试{' '}
          <code className="sc-code-in" style={{ background: 'var(--ll-bubble-code-inline)' }}>
            ISO 800
          </code>
          ：
          <pre className="sc-code-bk" style={{ background: 'var(--ll-bubble-code-block)' }}>
            {'exposure = 15s\niso = 800'}
          </pre>
        </Bubble>
      </div>
    </Stage>
  );
}

const WHO = [
  '小明',
  '小雨',
  '月亮不睡',
  '观星人老周',
  '胖虎',
  '阿尔吉侬',
  'Lyra',
  'Orion',
  '书虫',
  '洛璃之友',
];
export function WhoDemo() {
  return (
    <Stage kind="page">
      <div className="sc-who">
        {WHO.map((n, i) => (
          <span key={n} style={{ color: `var(--ll-who-${i})` }}>
            {n}
          </span>
        ))}
      </div>
    </Stage>
  );
}

export function FontDemo() {
  return (
    <div className="sc-demo-2">
      <Stage kind="page">
        <div className="sc-stage-tag">--ll-font-ui</div>
        <div className="sc-fontdemo" style={{ fontFamily: 'var(--ll-font-ui)' }}>
          <p>中文：星空观测站，今晚的英仙座流星雨很不错。</p>
          <p>English: The Perseids peak on the night of 12–13 August.</p>
          <p>数字：0123456789 · 12:30 · 3.14159 · 1,024 tokens</p>
        </div>
      </Stage>
      <Stage kind="page">
        <div className="sc-stage-tag">--ll-font-mono</div>
        <div className="sc-fontdemo" style={{ fontFamily: 'var(--ll-font-mono)' }}>
          <p>中文：星空观测站，今晚的英仙座流星雨很不错。</p>
          <p>English: const stars = await fetch(&apos;/sky&apos;);</p>
          <p>数字：0123456789 · 12:30 · 3.14159 · 1,024 tokens</p>
        </div>
      </Stage>
    </div>
  );
}
