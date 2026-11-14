import { useState } from 'react';
import { Dot, Tab, TabList, TabPanel, Tabs } from '../../../src/controls';
import { IconArrange, IconEye, IconSearch } from '../../../src/icons';
import { Stage } from '../../components/Stage';
import { Group, Matrix, useStageKind } from './shared';

/* 「标签页」一块：「此刻」的会话标签、全屏的部件切换栏、设置的侧栏 */

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
    </Group>
  );
}
