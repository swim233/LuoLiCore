import { useState } from 'react';
import { Button } from '../../../src/controls';
import { ChatBubble, ChatMentions } from '../../../src/chat';
import type { ChatRole, ChatSide } from '../../../src/chat';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「角色和靠哪边」一块：角色（别人、自己、助手）决定底色和名字的颜色，靠哪边（start、end）决定靠左靠右和哪个下角收尖，两样互不相干 */
const ROLES: readonly (readonly [ChatRole, string, string])[] = [
  ['other', '别人', '星河'],
  ['self', '自己', '月亮不睡'],
  ['assistant', '助手', '洛璃'],
];
const SIDES: readonly ChatSide[] = ['start', 'end'];
const TEXT: Record<ChatRole, string> = {
  other: '周末去植物园扫街，有人一起吗',
  self: '我可以！几点出发',
  assistant: '上午九点在门口见～',
};

export function RoleBlock() {
  // 「再来一条」：新出现的消息放出现动画（淡入在气泡自己身上，外框只做位移）
  const [added, setAdded] = useState<number[]>([]);
  return (
    <Group id="chat-role" title="角色和靠哪边" sub="ChatBubble · role / side">
      <p className="sc-note">
        <code>role</code>（<code>other</code>、<code>self</code>、<code>assistant</code>
        ）管底色和名字的颜色，<code>side</code>（<code>start</code>、<code>end</code>
        ）管靠哪边、靠近说话人的那个下角收尖。外面的容器要是纵向的 flex（气泡的外框靠{' '}
        <code>align-self</code> 靠边）。气泡默认实时模糊（<code>backdrop-filter</code>
        ），后面要有画面才看得出毛玻璃；新消息出现时放一下出现动画（<code>isNew</code>）。
      </p>
      <ChatMentions value={{ name: '洛璃', wakeWords: ['nori'], username: 'luoli_bot' }}>
        <Stage kind="sky">
          <div className="sc-chat-grid" data-demo="chat-roles">
            <span />
            {SIDES.map((s) => (
              <span className="sc-ctl-col" key={s}>
                {s}
              </span>
            ))}
            {ROLES.map(([role, label, name]) => (
              <div className="sc-chat-row" key={role}>
                <span className="sc-ctl-rowlabel">{label}</span>
                {SIDES.map((side) => (
                  <div className="sc-chat-col" key={side} data-cell={`${role}-${side}`}>
                    <ChatBubble
                      role={role}
                      side={side}
                      name={name}
                      colorKey={
                        role === 'other' ? 'u-1001' : role === 'self' ? 'u-1003' : undefined
                      }
                      label="11:20"
                      parts={[{ kind: 'text', text: TEXT[role] }]}
                      abortMark="（已中止）"
                      isNew={false}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Stage>
      </ChatMentions>
      <div className="sc-pill-row sc-chat-ctl">
        <Button data-demo="chat-add" onClick={() => setAdded((a) => [...a, a.length])}>
          再来一条新消息
        </Button>
        {added.length > 0 && (
          <Button variant="ghost" onClick={() => setAdded([])}>
            清掉
          </Button>
        )}
      </div>
      {added.length > 0 && (
        <Stage kind="sky">
          <div className="sc-chat-col sc-chat-wide" data-demo="chat-added">
            {added.map((n) => (
              <ChatBubble
                key={n}
                role={n % 2 ? 'self' : 'other'}
                side={n % 2 ? 'end' : 'start'}
                name={n % 2 ? '月亮不睡' : '星河'}
                colorKey={n % 2 ? 'u-1003' : 'u-1001'}
                label="刚刚"
                parts={[{ kind: 'text', text: `第 ${n + 1} 条新消息，出现时从下面淡入上来` }]}
                abortMark="（已中止）"
                isNew
              />
            ))}
          </div>
        </Stage>
      )}
    </Group>
  );
}
