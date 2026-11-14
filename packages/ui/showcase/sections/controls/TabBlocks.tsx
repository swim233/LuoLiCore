import { useState } from 'react';
import { Dot, Tab, TabList, TabPanel, Tabs } from '../../../src/controls';
import { IconArrange, IconEye, IconSearch } from '../../../src/icons';
import { Compare } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import { Group, Matrix, Merged, Now, useStageKind } from './shared';

/* 「标签页」一块（带和面板现在写法的对比）：「此刻」的会话标签、全屏的部件切换栏、设置的侧栏 */

const SESSIONS = [
  ['a', '星空观测站'],
  ['b', '周末打球'],
  ['c', '读书会'],
] as const;
const NAV = ['外观', '人设', '内置提示词', '白名单'] as const;
const FS_TABS = [
  ['会话', IconSearch],
  ['对话', IconEye],
  ['整理', IconArrange],
] as const;

export function TabsBlock() {
  const kind = useStageKind();
  const [on, setOn] = useState('a');
  const [off, setOff] = useState('a');
  return (
    <Group id="ctl-tabs" title="标签页" sub="Tabs · .ll-tabs-list、.ll-tab">
      <p className="sc-note">
        React 的 <code>Tabs</code>、<code>TabList</code>、<code>Tab</code>、<code>TabPanel</code> 用
        Base UI 打底：方向键在标签之间走（横排左右、<code>orientation="vertical"</code>{' '}
        时上下），Home、End 到两头，只有选中的那个在 Tab
        键的顺序里；默认方向键只挪焦点、回车或空格才选中（<code>TabList</code> 的{' '}
        <code>activateOnFocus</code> 原样透出，走到就选中）。样子是纯 CSS：<code>.ll-tab</code>
        选中认 <code>aria-selected</code>，也认 <code>aria-current</code>
        （给不是标签页的导航用，比如全屏的部件切换栏， 不用 React 的
        Tabs，写类名就行）。药丸（默认）两个尺寸：sm（高 26、字 12）、md（高 34、字
        13，左边留给图标）； 侧栏（<code>TabList</code> 的 <code>variant="side"</code>
        ）：竖排，一项一整行，悬停 <code>--ll-ctl-bg</code>，选中 <code>--ll-item-bg-on</code>
        。药丸选中的底用 <code>--ll-ctl-bg-on</code>（和按钮按下、分段选中同一个颜色）。
        换不换行、要不要滚动、窄屏怎么排由用的地方定；Tabs 根多包的那一层 div 没有任何样式。
      </p>
      <Stage kind={kind}>
        <div className="sc-tabs-demos">
          <div data-demo="tabs-focus-off-wrap">
            <span className="sc-stage-tag">
              默认：方向键只挪焦点，回车、空格才选中。选中的是{' '}
              <b data-demo-count="tabs-off">{off}</b>
            </span>
            <Tabs value={off} onValueChange={(v) => setOff(String(v))}>
              <TabList aria-label="默认" data-demo="tabs-focus-off">
                {SESSIONS.map(([v, t]) => (
                  <Tab key={v} value={v}>
                    {t}
                  </Tab>
                ))}
              </TabList>
              {SESSIONS.map(([v, t]) => (
                <TabPanel key={v} value={v} className="sc-tab-panel">
                  {t}的内容
                </TabPanel>
              ))}
            </Tabs>
          </div>
          <div data-demo="tabs-focus-on-wrap">
            <span className="sc-stage-tag">
              activateOnFocus：方向键走到就选中。选中的是 <b data-demo-count="tabs-on">{on}</b>
            </span>
            <Tabs value={on} onValueChange={(v) => setOn(String(v))}>
              <TabList activateOnFocus aria-label="走到就选中" data-demo="tabs-focus-on">
                {SESSIONS.map(([v, t]) => (
                  <Tab key={v} value={v}>
                    <Dot tone="ok" />
                    {t}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
          </div>
          <div data-demo="tabs-md-wrap">
            <span className="sc-stage-tag">md 加图标（全屏的部件切换栏的样子）</span>
            <Tabs defaultValue="会话">
              <TabList aria-label="md" data-demo="tabs-md">
                {FS_TABS.map(([t, Icon]) => (
                  <Tab key={t} value={t} size="md">
                    <Icon />
                    {t}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
          </div>
          <div data-demo="tabs-side-wrap">
            <span className="sc-stage-tag">侧栏（竖排，方向键上下）</span>
            <div className="sc-m-sidebox">
              <Tabs defaultValue="外观" orientation="vertical">
                <TabList variant="side" aria-label="侧栏" data-demo="tabs-side">
                  {NAV.map((t) => (
                    <Tab key={t} value={t}>
                      {t}
                    </Tab>
                  ))}
                </TabList>
              </Tabs>
            </div>
          </div>
          <div data-demo="tabs-nav-wrap">
            <span className="sc-stage-tag">
              不用 React、不是标签页：nav 里的按钮加 .ll-tab，选中写 aria-current
            </span>
            <nav className="ll-tabs-list" aria-label="切换部件" data-demo="tabs-nav">
              <button type="button" className="ll-tab" data-size="md" aria-current="true">
                <IconSearch />
                会话
              </button>
              <button type="button" className="ll-tab" data-size="md" aria-current="false">
                <IconEye />
                对话
              </button>
            </nav>
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">各种样子和状态（悬停和键盘焦点是强制显示的）</h4>
      <Matrix
        name="tabs"
        rows={[
          ['sm', '药丸 sm'],
          ['md', '药丸 md'],
          ['side', '侧栏'],
        ]}
        cols={[
          ['normal', '平常'],
          ['hover', '悬停'],
          ['selected', '选中'],
          ['focus', '键盘焦点'],
        ]}
        render={(row, col) => (
          <div
            className="ll-tabs-list"
            data-variant={row === 'side' ? 'side' : undefined}
            style={row === 'side' ? { width: 140 } : undefined}
          >
            <button
              type="button"
              className={`ll-tab ${col === 'hover' ? 'sc-hover' : ''} ${col === 'focus' ? 'sc-focus' : ''}`}
              data-size={row === 'md' ? 'md' : undefined}
              aria-selected={col === 'selected'}
              role="tab"
            >
              {row === 'md' && <IconSearch />}
              {row === 'side' ? '外观' : '星空观测站'}
            </button>
          </div>
        )}
      />
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="tabs-now"
        title="标签页：「此刻」的会话标签（.now-tab），平常、选中、悬停"
        note="换成库的 Tabs（sm）：多了方向键、悬停变亮和颜色过渡（现在没有悬停、没有过渡）；左右内边距 11 → 10；选中的底现在是「强调色 22% 叠在 --ll-ctl-bg 上」（A，左边），库里用 --ll-ctl-bg-on（B，右边，强调色 30%，和按钮按下、分段选中同一个颜色）——建议 B：选中的控件只有一种颜色；要留 A 就在面板里留一条选中色的覆盖。换行（flex-wrap）留在面板。这里的标签靠左排；面板里「此刻」这一排靠右，窄出来的 2px 落在最左边，位移的方向和这里相反（变化表里写了）。"
        now={
          <Now>
            <div className="now-tabs" role="tablist" aria-label="进行中的对话">
              <button
                type="button"
                className="now-tab"
                role="tab"
                aria-selected="false"
                data-item="tab"
                data-state="normal"
              >
                <Dot tone="ok" />
                星空观测站
              </button>
              <button
                type="button"
                className="now-tab sc-hover"
                role="tab"
                aria-selected="false"
                data-item="tab"
                data-state="hover"
              >
                <Dot tone="ok" />
                周末打球
              </button>
              <button
                type="button"
                className="now-tab"
                role="tab"
                aria-selected="true"
                data-item="tab"
                data-state="selected"
              >
                <Dot tone="ok" />
                读书会
              </button>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <Tabs defaultValue="c">
              <TabList className="sc-m-nowtabs" aria-label="进行中的对话">
                <Tab value="a" data-item="tab" data-state="normal">
                  <Dot tone="ok" />
                  星空观测站
                </Tab>
                <Tab value="b" className="sc-hover" data-item="tab" data-state="hover">
                  <Dot tone="ok" />
                  周末打球
                </Tab>
                <Tab value="c" data-item="tab" data-state="selected">
                  <Dot tone="ok" />
                  读书会
                </Tab>
              </TabList>
            </Tabs>
          </Merged>
        }
      />
      <Compare
        id="tabs-fs"
        title="标签页：全屏的部件切换栏（.fs-tab，nav 里的 aria-current），平常、悬停、选中"
        note="只换样子：类名换成 ll-tab（md），仍然是 nav 里的按钮、不用 React 的 Tabs（它切的是整个全屏窗口、带形变，选中项变了要重建按钮的做法留在外壳里）。选中的底从「强调色 22% 叠在 ctl-bg 上」换成 --ll-ctl-bg-on（建议，同上）；这一处现在就有悬停和过渡，样子不变。flex: none、居中、横向滚动、内边距 2 4 是布局，留在面板。"
        now={
          <Now>
            <nav className="fs-switch" aria-label="切换部件">
              {FS_TABS.map(([t, Icon], i) => (
                <button
                  key={t}
                  type="button"
                  className={`fs-tab ${i === 1 ? 'sc-hover' : ''}`}
                  aria-current={i === 0}
                  data-item="tab"
                  data-state={['selected', 'hover', 'normal'][i]}
                >
                  <span className="w-icon">
                    <Icon />
                  </span>
                  <span className="fs-tab-name">{t}</span>
                </button>
              ))}
            </nav>
          </Now>
        }
        merged={
          <Merged>
            <nav className="ll-tabs-list sc-m-fsswitch" aria-label="切换部件">
              {FS_TABS.map(([t, Icon], i) => (
                <button
                  key={t}
                  type="button"
                  className={`ll-tab sc-m-fstab ${i === 1 ? 'sc-hover' : ''}`}
                  data-size="md"
                  aria-current={i === 0}
                  data-item="tab"
                  data-state={['selected', 'hover', 'normal'][i]}
                >
                  <span className="w-icon">
                    <Icon />
                  </span>
                  <span className="fs-tab-name">{t}</span>
                </button>
              ))}
            </nav>
          </Merged>
        }
      />
      <Compare
        id="tabs-set"
        title="标签页：设置全屏的侧栏（.set-nav，宽屏竖排），平常、悬停、选中"
        note="换成库的 Tabs（侧栏样子），变成真的标签页（role=tab），多了方向键。字号：现在是继承来的 14px（不在刻度里），并到 13px（最近的一档，一样近取小）；选中的底 accent 15% 现在也是，换成变量 --ll-item-bg-on（数一样）；过渡、悬停的底不变。内边距 8 12、圆角 10 一样。内边距 padding-inline 10 是版面，留在面板。"
        now={
          <Now>
            <div className="sc-env-setnav">
              <nav className="set-nav" aria-label="设置分组">
                {NAV.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    className={i === 2 ? 'sc-hover' : ''}
                    aria-current={i === 0}
                    data-item="tab"
                    data-state={['selected', 'normal', 'hover', 'normal'][i] + (i === 3 ? '2' : '')}
                  >
                    {t}
                  </button>
                ))}
              </nav>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-setnav">
              <Tabs defaultValue="外观" orientation="vertical">
                <TabList variant="side" className="sc-m-setnav" aria-label="设置分组">
                  {NAV.map((t, i) => (
                    <Tab
                      key={t}
                      value={t}
                      className={i === 2 ? 'sc-hover' : ''}
                      data-item="tab"
                      data-state={
                        ['selected', 'normal', 'hover', 'normal'][i] + (i === 3 ? '2' : '')
                      }
                    >
                      {t}
                    </Tab>
                  ))}
                </TabList>
              </Tabs>
            </div>
          </Merged>
        }
      />
      <Compare
        id="tabs-set-narrow"
        title="标签页：设置的侧栏在窄屏（横过来排，横向滚动）"
        note="窄屏时面板把这一栏改成横排（flex-direction: row、只横向滚），留在面板；方向键跟着换成左右（Tabs 的 orientation 在窄屏传 horizontal）。其余同上。"
        now={
          <Now>
            <div className="sc-env-setnav sc-env-setnav-narrow">
              <nav className="set-nav" aria-label="设置分组">
                {NAV.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    aria-current={i === 0}
                    data-item="tab"
                    data-state={i === 0 ? 'selected' : 'normal' + i}
                  >
                    {t}
                  </button>
                ))}
              </nav>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-setnav sc-env-setnav-narrow">
              <Tabs defaultValue="外观" orientation="horizontal">
                <TabList variant="side" className="sc-m-setnav" aria-label="设置分组">
                  {NAV.map((t, i) => (
                    <Tab
                      key={t}
                      value={t}
                      data-item="tab"
                      data-state={i === 0 ? 'selected' : 'normal' + i}
                    >
                      {t}
                    </Tab>
                  ))}
                </TabList>
              </Tabs>
            </div>
          </Merged>
        }
      />
    </Group>
  );
}
