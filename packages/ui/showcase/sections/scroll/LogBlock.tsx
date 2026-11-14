import { useState } from 'react';
import { Pane, VirtualLog } from '../../../src/scroll';
import type { LogItem, ScrollState } from '../../../src/scroll';
import { Button, Seg } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「长列表」一块：能加条目、贴底时上推、往上翻着时不被拉回、滚到底、停在某一条、顶上补条目后位置不动 */
const text = (n: number) =>
  `这是第 ${n} 条消息。${n % 3 === 0 ? '这一条长一点，会多占几行，用来看行高是估的、量到真实高度以后位置照样对。'.repeat((n % 2) + 1) : ''}`;
const msg = (key: string, n: number): LogItem => ({
  key,
  est: 56,
  node: (
    <div className="sc-scr-msg" data-msg={key}>
      {text(n)}
    </div>
  ),
});
const base = (conv: 'a' | 'b') =>
  Array.from({ length: 40 }, (_, i) => msg(`${conv}${i + 1}`, i + 1));

export function LogBlock() {
  const [conv, setConv] = useState<'a' | 'b'>('a');
  const [epoch, setEpoch] = useState(0);
  const [items, setItems] = useState(() => base('a'));
  const [next, setNext] = useState(41);
  const [older, setOlder] = useState(0);
  const [jump, setJump] = useState(0);
  const [st, setSt] = useState<ScrollState>({ atBottom: true, nearTop: false });
  const add = (k: number) => {
    setItems((v) => [
      ...v,
      ...Array.from({ length: k }, (_, i) => msg(`${conv}${next + i}`, next + i)),
    ]);
    setNext(next + k);
  };
  const prepend = () => {
    const k = older + 3;
    setItems((v) => [...[3, 2, 1].map((i) => msg(`${conv}old${older + i}`, -(older + i))), ...v]);
    setOlder(k);
  };
  const choose = (c: 'a' | 'b') => {
    setConv(c);
    setEpoch((e) => e + 1);
    setItems(base(c));
    setNext(41);
    setOlder(0);
  };
  return (
    <Group id="scr-log" title="长列表" sub="VirtualLog">
      <p className="sc-note">
        虚拟滚动的时间线（@tanstack/react-virtual，动态高度）：它自己就是窗格的滚动区。贴底时新条目进来内容平滑上推；往上翻着时新条目不把人拉回；{' '}
        <code>jumpKey</code> 加一滚到最底下（离得远先跳到两屏内再滑）；<code>resetKey</code>{' '}
        变了算「切换」，给了 <code>anchorKey</code> 就停在那一条（会话 B 停在第 20
        条），不给就到底；顶上补条目后位置不动。
        <code>onScrollState</code>{' '}
        报「在不在最底下」「是不是快到顶了」（每次渲染后、滚动时都会调，在里面设状态要先比一下，值没变就别设，不然会循环渲染）；
        <code>onRowsMoved</code>、<code>onPositioned</code>{' '}
        是两个回调（面板用它们让气泡里垫的星空重新对位），这里没用。
      </p>
      <div className="sc-pill-row sc-scr-ctl">
        <Seg<'a' | 'b'>
          label="会话"
          value={conv}
          onPick={choose}
          items={[
            ['a', '会话 A（到底）'],
            ['b', '会话 B（停在第 20 条）'],
          ]}
        />
        <Button onClick={() => add(1)} data-demo="log-add">
          加一条
        </Button>
        <Button onClick={() => add(4)} data-demo="log-add4">
          加四条
        </Button>
        <Button onClick={() => setJump((j) => j + 1)} data-demo="log-jump">
          滚到底（jumpKey）
        </Button>
        <Button onClick={prepend} data-demo="log-prepend">
          顶上补三条
        </Button>
        <span className="sc-stage-tag" data-demo="log-state">
          在最底下：{st.atBottom ? '是' : '否'} · 离顶不到 160px：{st.nearTop ? '是' : '否'}
        </span>
      </div>
      <Stage kind="page">
        <div className="sc-scr-win ll-sky" data-demo="log-window">
          <div className="sc-scr-title">时间线</div>
          <Pane
            top={<div className="sc-scr-bar">浮着的一行</div>}
            bottom={<div className="sc-scr-composer">输入框浮在下面</div>}
          >
            <VirtualLog
              className="sc-scr-log"
              items={items}
              resetKey={`${conv}${epoch}`}
              label="演示的长列表"
              anchorKey={conv === 'b' ? 'b20' : null}
              jumpKey={jump}
              onScrollState={(n) =>
                setSt((p) => (p.atBottom === n.atBottom && p.nearTop === n.nearTop ? p : n))
              }
            />
          </Pane>
          <i className="ll-sky-vig" aria-hidden="true" style={{ zIndex: 3 }} />
        </div>
      </Stage>
    </Group>
  );
}
