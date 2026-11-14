import { Badge, Button, Chevron, Tag } from '../../../src/controls';
import { IconSearch } from '../../../src/icons';
import { Stage } from '../../components/Stage';
import { Group, PanelEnv, useStageKind } from './shared';

/* 「小件」一块：面板里几样药丸按钮、小标签，用的是库里已有的控件（不另有样子）：
   选会话的按钮、「＋ 新对话」、时间线上的「摘要」、新部件上的「新」、消息上的「排队中」、收纳盒里的部件按钮 */

export function SmallBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-small" title="小件" sub="Button · Badge · Tag">
      <p className="sc-note">
        面板里几样药丸按钮、小标签，用的都是库里已有的控件，没有另外的样子：选会话的按钮、「＋
        新对话」 → Button（md）；时间线分隔线上的「摘要」→ Button（xs）；新部件上的「新」→
        Badge（accent）； 消息上的「排队中」→ Tag（soft）；收纳盒里的部件按钮 →
        Button（lg）。当「点开一个东西」的按钮用时 （展开的菜单、折叠的摘要），soft 的按钮展开着（
        <code>aria-expanded='true'</code>
        ）保持亮着的底，和悬停一样（ghost 的也是）。
      </p>
      <h4 className="sc-h4">
        选会话的按钮（.chat-pick）和「＋ 新对话」（.chat-new）：平常、悬停、展开着
      </h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-bar">
            <Button size="md" className="sc-m-pick" aria-haspopup="true" aria-expanded="false">
              <span className="sc-m-picklabel">星空观测站</span>
              <Chevron dir="down" />
            </Button>
            <Button size="md" className="sc-m-new">
              ＋ 新对话
            </Button>
          </div>
          <div className="sc-env-bar">
            <Button
              size="md"
              className="sc-m-pick sc-hover"
              aria-haspopup="true"
              aria-expanded="false"
            >
              <span className="sc-m-picklabel">星空观测站</span>
              <Chevron dir="down" />
            </Button>
            <Button size="md" className="sc-m-new sc-hover">
              ＋ 新对话
            </Button>
          </div>
          <div className="sc-env-bar">
            <Button size="md" className="sc-m-pick" aria-haspopup="true" aria-expanded="true">
              <span className="sc-m-picklabel">星空观测站</span>
              <Chevron dir="down" />
            </Button>
          </div>
        </PanelEnv>
      </Stage>
      <h4 className="sc-h4">
        时间线分隔线上的「摘要」按钮（Button xs，soft，Timeline.tsx）：收着、展开着
      </h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-seg">
            <span>新的一段 · 11-12</span>
            <Button size="xs" aria-expanded="false">
              摘要
              <Chevron />
            </Button>
          </div>
          <div className="sc-env-seg">
            <span>新的一段 · 11-12</span>
            <Button size="xs" aria-expanded="true">
              摘要
              <Chevron />
            </Button>
          </div>
        </PanelEnv>
      </Stage>
      <h4 className="sc-h4">新部件上的「新」（.w-new）</h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-whead">
            <h2 className="sc-m-wtitle">会话</h2>
            <Badge tone="accent">新</Badge>
          </div>
        </PanelEnv>
      </Stage>
      <h4 className="sc-h4">消息上的「排队中」（.msg-meta .queued）</h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="msg-meta">
            <b>小明</b>
            <time>11:20</time>
            <Tag variant="soft">排队中</Tag>
          </div>
        </PanelEnv>
      </Stage>
      <h4 className="sc-h4">收纳盒里的部件按钮（.tray-item）</h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-bar">
            <Button size="lg" className="sc-m-traybtn">
              <span className="sc-m-trayico">
                <IconSearch />
              </span>
              会话
            </Button>
            <Button size="lg" className="sc-m-traybtn sc-hover">
              <span className="sc-m-trayico">
                <IconSearch />
              </span>
              会话
            </Button>
          </div>
        </PanelEnv>
      </Stage>
    </Group>
  );
}
