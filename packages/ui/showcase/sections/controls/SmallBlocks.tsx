import { Badge, Button, Chevron, Tag } from '../../../src/controls';
import { IconSearch } from '../../../src/icons';
import { Compare } from '../../components/Compare';
import { Group, Merged, Now } from './shared';

/* 「第 4 步漏掉的小件」一块：面板自己写的几样小按钮、小标签，对到库里已有的控件上（不给库加新样子）：
   选会话的按钮、「＋ 新对话」、新部件上的「新」、消息上的「排队中」、收纳盒里的部件按钮 */

export function SmallBlock() {
  return (
    <Group id="ctl-small" title="对到库里已有控件的小件" sub="Button · Badge · Tag">
      <p className="sc-note">
        第 4
        步漏掉的几样：面板里自己写的药丸按钮和小标签，量过以后对到库里已有的控件上，不给库加新样子。
        选会话的按钮 <code>.chat-pick</code>、「＋ 新对话」<code>.chat-new</code> → Button（md）；
        新部件上的「新」<code>.w-new</code> → Badge（accent）；消息上的「排队中」
        <code>.queued</code> → Tag（soft）； 收纳盒里的部件按钮 <code>.tray-item</code> →
        Button（lg）。每样一个对比块，差别进变化表。 其中一处要在库里加一条：soft 的按钮展开着（
        <code>aria-expanded='true'</code>
        ）时和悬停一样亮着（现在只有 ghost 有），选会话的按钮靠它（下面「展开着」一组）；面板里别的
        soft 的、带 <code>aria-expanded</code>{' '}
        的按钮也会跟着变，只有时间线分隔线上的「摘要」一个，见再下面那一块。这一条改的是库的
        button.css，b 段改库的按钮时再加（现在不改库，展示页里用自己的一条规则演示）。
      </p>
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="small-pick"
        title="选会话的按钮（.chat-pick）和「＋ 新对话」（.chat-new）：平常、悬停、展开着"
        note="都换成库的 Button（md，高 28、全圆角、soft，悬停变亮，和现在的悬停一样）：字号 12.5 → 12；选会话的按钮左右内边距 11 → 12（宽度窄多少随标题长短变：每个字 0.5px 再加 1.58px，这里的例子窄 4.08px，真面板里 6 个字的标题窄 4.58px），「新对话」12 一样；向下的小箭头换成 Chevron（dir=down，展开时不转，和现在一样），颜色现在是 fg-3、换了以后跟着字（fg-2），大小 0.4em → 0.38em；展开着时现在是悬停那样亮着的底，库的 soft 按钮展开着没有这个样子，归并要在库的 button.css 里加一条（soft 的按钮 `aria-expanded='true'` 时和悬停一样亮着，ghost 本来就有）：右边展开着的这一组就是加了这一条以后的样子，和现在一样；这一条是 b 段改库的按钮时才加，现在展示页里用自己的一条规则演示。行高现在继承页面的 1.55，Button 写 1，文字下移 0.69px。min-width: 0、margin-left: auto、flex: none、省略号是布局，留在面板。"
        now={
          <Now>
            <div className="sc-env-bar">
              <button
                type="button"
                className="chat-pick"
                aria-haspopup="true"
                aria-expanded="false"
                data-item="pick"
                data-state="normal"
              >
                <span>星空观测站</span>
              </button>
              <button type="button" className="chat-new" data-item="new" data-state="normal">
                ＋ 新对话
              </button>
            </div>
            <div className="sc-env-bar">
              <button
                type="button"
                className="chat-pick sc-hover"
                aria-haspopup="true"
                aria-expanded="false"
                data-item="pick"
                data-state="hover"
              >
                <span>星空观测站</span>
              </button>
              <button
                type="button"
                className="chat-new sc-hover"
                data-item="new"
                data-state="hover"
              >
                ＋ 新对话
              </button>
            </div>
            <div className="sc-env-bar">
              <button
                type="button"
                className="chat-pick"
                aria-haspopup="true"
                aria-expanded="true"
                data-item="pick"
                data-state="expanded"
              >
                <span>星空观测站</span>
              </button>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-bar">
              <Button
                size="md"
                className="sc-m-pick"
                aria-haspopup="true"
                aria-expanded="false"
                data-item="pick"
                data-state="normal"
              >
                <span className="sc-m-picklabel">星空观测站</span>
                <Chevron dir="down" />
              </Button>
              <Button size="md" className="sc-m-new" data-item="new" data-state="normal">
                ＋ 新对话
              </Button>
            </div>
            <div className="sc-env-bar">
              <Button
                size="md"
                className="sc-m-pick sc-hover"
                aria-haspopup="true"
                aria-expanded="false"
                data-item="pick"
                data-state="hover"
              >
                <span className="sc-m-picklabel">星空观测站</span>
                <Chevron dir="down" />
              </Button>
              <Button size="md" className="sc-m-new sc-hover" data-item="new" data-state="hover">
                ＋ 新对话
              </Button>
            </div>
            <div className="sc-env-bar">
              <Button
                size="md"
                className="sc-m-pick"
                aria-haspopup="true"
                aria-expanded="true"
                data-item="pick"
                data-state="expanded"
              >
                <span className="sc-m-picklabel">星空观测站</span>
                <Chevron dir="down" />
              </Button>
            </div>
          </Merged>
        }
      />
      <Compare
        id="small-sumbtn"
        title="时间线分隔线上的「摘要」按钮（Button xs，soft，Timeline.tsx）：收着、展开着"
        note="这是面板里现在用库的 soft 按钮、带 aria-expanded 的唯一一处（ghost 的「N 个任务」本来就有这个样子，不算；选会话的按钮换进来以后是第二处，见上一块）。库的 button.css 加了上面说的那一条以后，它展开着时从平常的底（白 8%、字 --ll-fg-2）变成亮着的底（白 13%、字 --ll-fg，和悬停一样）；收着的时候不变；小箭头展开着转向下，两边一样。"
        now={
          <Now>
            <div className="sc-env-seg">
              <span>新的一段 · 11-12</span>
              <Button size="xs" aria-expanded="false" data-item="sumbtn" data-state="closed">
                摘要
                <Chevron />
              </Button>
            </div>
            <div className="sc-env-seg">
              <span>新的一段 · 11-12</span>
              <Button size="xs" aria-expanded="true" data-item="sumbtn" data-state="open">
                摘要
                <Chevron />
              </Button>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-seg">
              <span>新的一段 · 11-12</span>
              <Button size="xs" aria-expanded="false" data-item="sumbtn" data-state="closed">
                摘要
                <Chevron />
              </Button>
            </div>
            <div className="sc-env-seg">
              <span>新的一段 · 11-12</span>
              <Button size="xs" aria-expanded="true" data-item="sumbtn" data-state="open">
                摘要
                <Chevron />
              </Button>
            </div>
          </Merged>
        }
      />
      <Compare
        id="small-new"
        title="新部件上的「新」（.w-new）"
        note="换成库的 Badge（accent）：底色、字色、11px、全圆角都一样；左右内边距 7 → 4（Badge 自己的）、字重 600 → 700、字距 0.1em 没有了、高 18 一样，所以「新」字这一枚窄 7px。"
        now={
          <Now>
            <div className="sc-env-whead">
              <h2 className="sc-m-wtitle">会话</h2>
              <span className="w-new" data-item="wnew">
                新
              </span>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-whead">
              <h2 className="sc-m-wtitle">会话</h2>
              <Badge tone="accent" data-item="wnew">
                新
              </Badge>
            </div>
          </Merged>
        }
      />
      <Compare
        id="small-queued"
        title="消息上的「排队中」（.msg-meta .queued）"
        note="换成库的 Tag（soft，sm）：底（--ll-ctl-bg）、字色（fg-2）、11px、全圆角、左右内边距 8 都一样；高 16 → 18（药丸里的字下移 1px）；药丸比这一行的字（17.81）高，所以这一行（.msg-meta）高 17.81 → 18.81，多 1px，同一行里的名字和这一行下面的气泡各下移 1px，只在有排队的消息上。"
        now={
          <Now>
            <div className="msg-meta" data-item="meta">
              <b>小明</b>
              <time>11:20</time>
              <span className="queued" data-item="queued">
                排队中
              </span>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="msg-meta" data-item="meta">
              <b>小明</b>
              <time>11:20</time>
              <Tag variant="soft" data-item="queued">
                排队中
              </Tag>
            </div>
          </Merged>
        }
      />
      <Compare
        id="small-tray"
        title="收纳盒里的部件按钮（.tray-item）"
        note="换成库的 Button（lg，高 32、字 13、gap 6）：样子（底、字色、全圆角）一样；多了悬停变亮和底、字色的过渡（现在没有悬停、没有过渡）；文字的行高从继承来的 1.55 变成 1（文字下移 0.58px，按钮的宽、高、图标位置不变）；左右内边距（0 12 0 6，左边留给圆形图标）、cursor: grab、touch-action: none 是这个按钮自己的，留在面板。"
        now={
          <Now>
            <div className="sc-env-bar">
              <button type="button" className="tray-item" data-item="tray" data-state="normal">
                <span className="cap-icon">
                  <IconSearch />
                </span>
                会话
              </button>
              <button
                type="button"
                className="tray-item sc-hover"
                data-item="tray"
                data-state="hover"
              >
                <span className="cap-icon">
                  <IconSearch />
                </span>
                会话
              </button>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-bar">
              <Button size="lg" className="sc-m-traybtn" data-item="tray" data-state="normal">
                <span className="sc-m-trayico">
                  <IconSearch />
                </span>
                会话
              </Button>
              <Button
                size="lg"
                className="sc-m-traybtn sc-hover"
                data-item="tray"
                data-state="hover"
              >
                <span className="sc-m-trayico">
                  <IconSearch />
                </span>
                会话
              </Button>
            </div>
          </Merged>
        }
      />
    </Group>
  );
}
