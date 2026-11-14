import { useLayoutEffect, useRef } from 'react';
import { Button, Seg } from '@luoli/ui/controls';
import { Star4 } from '@luoli/ui/icons';
import { motionOn, useMotionOn } from '@luoli/ui/motion';
import { EASE_OUT_CSS } from '@luoli/ui/easing';
import { setGlass, useGlassMode } from '../lib/glass';
import type { Glass } from '../lib/glass';
import { chooseMotion, usePrefs } from '../lib/prefs';
import type { Prefs } from '../lib/prefs';
import { useBusRev } from '../model/rev';
import { setAutoNow, setCollapse, setFps, setHover } from '../state/appearance';
import { hasDef, useDefsRev } from '../state/desk';
import { BadgeLab } from './BadgeLab';
import { mockStatus } from './mock-live';
import { mockServer } from './mock-server';
import { ACTIONS, setData } from './demo';
import { toggleDemo, useDevUi } from './demo-state';
import type { Dataset } from './demo-state';

/* 右下角一个可以收起的小面板，用模拟事件检验自适应和动画。「外观」一节的几项和设置部件里的「外观」组是同一份状态（「气泡的毛玻璃」例外：它只在这里，
   设置里没有，状态在 lib/glass.ts，只存内存）。点演示控制不抢焦点（pointerdown 里 preventDefault）：
   比如在对话里打字时点「洛璃被触发」，焦点仍留在输入框里，模拟的就是「正在打字时有人叫洛璃」 */
export function DemoPanel() {
  const open = useDevUi((s) => s.open);
  const dataset = useDevUi((s) => s.dataset);
  const p = usePrefs((x) => x);
  const motion = useMotionOn();
  const glass = useGlassMode();
  useDefsRev();
  useBusRev(['bot:online', 'bot:offline', 'status', 'data:reset', 'tasks:update']);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /* 展开：240 ms，从下面 10px、缩放 .98、透明度 0 */
  useLayoutEffect(() => {
    if (open && motionOn() && panelRef.current)
      panelRef.current.animate(
        [
          { opacity: 0, transform: 'translateY(10px) scale(.98)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 240, easing: EASE_OUT_CSS },
      );
  }, [open]);
  const act = (e: React.MouseEvent) => {
    const b = (e.target as Element).closest('[data-act]') as HTMLElement | null;
    if (b && ACTIONS[b.dataset.act!]) ACTIONS[b.dataset.act!]();
  };
  return (
    <div
      className="demo"
      id="demo"
      data-dev=""
      ref={ref}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button')) e.preventDefault();
      }}
    >
      {open && (
        <div className="demo-panel" id="demo-panel" ref={panelRef} onClick={act}>
          <section>
            <h4>群聊事件</h4>
            <div className="demo-grid">
              <button className="dbtn" type="button" data-act="plain" title="不触发洛璃">
                普通消息（不触发）
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="trigger"
                title="读书会：等待合并 → 思考 → 逐字回复"
              >
                洛璃被触发
              </button>
              <button className="dbtn" type="button" data-act="tool" title="工具结果带一张图">
                调用工具（带图）
              </button>
              <button className="dbtn" type="button" data-act="error" title="周末打球">
                回复出错
              </button>
              <button className="dbtn" type="button" data-act="retry" title="失败一次后成功">
                重试一次后成功
              </button>
              <button className="dbtn" type="button" data-act="two">
                两个群同时在回复
              </button>
              <button className="dbtn" type="button" data-act="online" id="demo-online">
                {mockStatus.connected ? '连不上 Telegram' : '连上 Telegram'}
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="tg"
                id="demo-tg"
                title="没设 token：徽记显示空闲，弹出框写 Telegram 服务未启动"
              >
                {mockStatus.enabled ? 'Telegram 未启动' : '启动 Telegram'}
              </button>
              <button
                className="dbtn is-wide"
                type="button"
                data-act="reconnect"
                id="demo-reconnect"
                title="断开 3 秒，服务照常推进，重连后按现场重建「此刻」"
              >
                断线重连（按现场重建）
              </button>
            </div>
          </section>
          <section>
            <h4>任务</h4>
            <div className="demo-grid">
              <button
                className="dbtn"
                type="button"
                data-act="task-new"
                title="模拟 SSE 的 task 事件"
              >
                新建任务
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="task-due"
                title="读书会：事件 → 等待合并 → 带任务的回复"
              >
                任务到点（群）
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="task-due-web"
                title="网页会话：没有请求接流，对话里写「正在回复」，「此刻」不自动展开"
              >
                任务到点（网页）
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="task-due-busy"
                title="先触发一次回复，回复中再到点"
              >
                回复中到点
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="task-due-two"
                title="星空观测站：两个任务一起"
              >
                同时到点两个
              </button>
              <button
                className="dbtn"
                type="button"
                data-act="task-missed"
                title="只写事件，不回复"
              >
                任务超时
              </button>
              <button
                className="dbtn is-wide"
                type="button"
                data-act="task-fail"
                id="demo-task-fail"
                title="取任务失败：404（服务版本旧）→ 500 → 恢复；只有任务部件、全屏会话头部的任务数、胶囊受影响"
              >
                {`取任务失败：${mockServer.tasksFail ?? '正常'}（点一下切换）`}
              </button>
            </div>
          </section>
          <BadgeLab />
          <section>
            <h4>部件与数据</h4>
            <div className="demo-grid">
              <button className="dbtn is-wide" type="button" data-act="widget" id="demo-widget">
                {hasDef('today') ? '移除部件：今日概况' : '新增部件：今日概况'}
              </button>
              <button className="dbtn" type="button" data-act="conv-add">
                新增会话
              </button>
              <button className="dbtn" type="button" data-act="conv-del">
                删掉会话
              </button>
            </div>
            <div className="demo-row" style={{ marginTop: 8 }}>
              <span>数据</span>
              <Seg
                id="demo-data"
                value={dataset}
                items={[
                  ['empty', '空'],
                  ['normal', '正常'],
                  ['big', '大量'],
                ]}
                onPick={(v) => {
                  if (v !== dataset) setData(v as Dataset);
                }}
              />
            </div>
          </section>
          <section>
            <h4>外观</h4>
            <div className="demo-row">
              <span>动画</span>
              <Seg
                id="demo-motion"
                value={motion ? 'on' : 'off'}
                items={[
                  ['on', '开'],
                  ['off', '关'],
                ]}
                onPick={(v) => chooseMotion(v === 'on')}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>帧率显示</span>
              <Seg
                id="demo-fps"
                value={p.fps ? 'on' : 'off'}
                items={[
                  ['on', '开', '在左下角显示当前帧率，以及最近一次转场的最长帧和掉帧数'],
                  ['off', '关'],
                ]}
                onPick={(v) => setFps(v === 'on')}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>悬停效果</span>
              <Seg
                id="demo-hover"
                value={p.hover}
                items={[
                  ['B', 'B 流光', '边缘流光'],
                  ['C', 'C 边光', '边缘发光：鼠标附近的那段边框被照亮'],
                  ['D', 'D 倾斜', '卡牌倾斜'],
                ]}
                onPick={(v) => setHover(v as Prefs['hover'])}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>气泡的毛玻璃</span>
              <Seg
                id="demo-glass"
                value={glass}
                items={[
                  ['live', '实时模糊', '正式页面用的：气泡自己 backdrop-filter，开销在 GPU 上'],
                  [
                    'baked',
                    '预先糊好',
                    '垫一层预先糊好的星空，滚动时脚本要跟着对位，主线程开销大。只存在内存里，刷新后回到实时模糊',
                  ],
                ]}
                onPick={(v) => setGlass(v as Glass)}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>有回复时自动展开「此刻」</span>
              <Seg
                id="demo-autonow"
                value={p.autoNow ? 'on' : 'off'}
                items={[
                  ['on', '开'],
                  ['off', '关'],
                ]}
                onPick={(v) => setAutoNow(v === 'on')}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>「此刻」自动缩回</span>
              <Seg
                id="demo-collapse"
                value={String(p.collapse)}
                items={[
                  ['30', '30 秒'],
                  ['5', '5 秒'],
                ]}
                onPick={(v) => setCollapse(Number(v) as Prefs['collapse'])}
              />
            </div>
            <div className="demo-row" style={{ marginTop: 6 }}>
              <span>布局</span>
              <Button data-act="reset-layout">恢复默认布局</Button>
            </div>
          </section>
        </div>
      )}
      <button
        className="demo-toggle"
        id="demo-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="demo-panel"
        onClick={() => toggleDemo()}
      >
        <i>
          <Star4 className="st4" />
        </i>
        <span>演示控制</span>
      </button>
    </div>
  );
}
