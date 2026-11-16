import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '../../../src/controls';
import { IconPlus } from '../../../src/icons';
import {
  Menu,
  MenuButton,
  MenuContent,
  MenuItem,
  MenuSeparator,
  Popover,
  PopoverButton,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「在窗口里」一块：夜空窗口（overflow: hidden，带 transform），里面的菜单和弹出框（都用库的下拉钮，长开）用 container 留在窗口里 */
const CONVS = ['星空观测站', '周末打球', '读书会', '推荐几部科幻小说', '周一的例会', '旅行计划'];

function Win({ name, height }: { name: string; height: number }) {
  /* container 要的是元素：用 state 接 ref，窗口挂上以后弹出框才拿得到 */
  const [win, setWin] = useState<HTMLDivElement | null>(null);
  const [moved, setMoved] = useState(false);
  return (
    <div className="sc-ov-wincell">
      <div
        className="sc-ov-win ll-sky"
        ref={setWin}
        data-demo={name}
        data-moved={moved ? '' : undefined}
        style={{ height }}
      >
        <div className="sc-ov-win-bar">
          <b>窗口标题</b>
          <Menu>
            <MenuButton
              kind="slot"
              data-win-menu={name}
              style={{ '--ll-dd-min': '120px' } as CSSProperties}
            >
              {CONVS[0]}
            </MenuButton>
            <MenuContent container={win}>
              {CONVS.map((t, i) => (
                <MenuItem key={t} current={i === 0} hint={i < 2 ? '昨天' : undefined}>
                  {t}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem lead={<IconPlus />}>新对话</MenuItem>
            </MenuContent>
          </Menu>
          <Popover>
            <PopoverButton data-win-pop={name}>3 个任务</PopoverButton>
            <PopoverContent container={win} align="end">
              <PopoverTitle>这个会话的任务</PopoverTitle>
              <PopoverDescription>
                每天 08:00
                说说天气。弹出框留在窗口里：窗口比它小就被窗口裁掉，所以它自己限高、能滚。
              </PopoverDescription>
              {Array.from({ length: 6 }, (_, i) => (
                <p className="sc-ov-p" key={i}>
                  第 {i + 1} 个任务：到点提醒大家做点什么。
                </p>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <div className="sc-ov-win-body">
          {Array.from({ length: 12 }, (_, i) => (
            <p key={i}>
              窗口里的内容：第 {i + 1} 行。浮层的毛玻璃糊开的是这些，不是窗口外面的页面。
            </p>
          ))}
        </div>
        <i className="ll-sky-vig" aria-hidden="true" />
      </div>
      <div className="sc-ov-actions-left">
        <Button size="sm" onClick={() => setMoved(!moved)} data-win-move={name}>
          把窗口挪一挪
        </Button>
        <span className="sc-ov-cap">浮层留在窗口的 DOM 里，窗口怎么动它都跟着走</span>
      </div>
    </div>
  );
}

export function WindowBlock() {
  return (
    <Group id="ov-window" title="在窗口里" sub="container · 夜空窗口">
      <p className="sc-note">
        浮层默认挂在 <code>&lt;body&gt;</code>{' '}
        上。要让它留在某个窗口里（被窗口裁掉、糊开的是窗口里面的东西、窗口被复制或挪动时跟着走），
        给 <code>MenuContent</code>、<code>PopoverContent</code>（对话框、提示气泡也一样）传{' '}
        <code>container</code>（一个元素）。下面两个窗口都是夜空窗口（<code>overflow: hidden</code>
        ，带 <code>transform</code>
        ）：左边够高，右边很矮，浮层限高、里面滚、不伸出窗口。点标题栏里的两个下拉钮试：左边的槽是选会话的菜单（长开，往下、盖在钮上），右边的胶囊是任务的弹出框（靠右对齐，往左长）；长开的浮层也留在窗口里，被窗口裁、窗口挪的时候跟着走。
      </p>
      <Stage kind="page">
        <div className="sc-ov-row-demo">
          <Win name="win-tall" height={300} />
          <Win name="win-short" height={150} />
        </div>
      </Stage>
    </Group>
  );
}
