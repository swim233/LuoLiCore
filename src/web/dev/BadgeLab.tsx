import { isWork, lookView, setManualLook, getLook } from '../components/badge/appearance';
import type { Look, Main } from '../components/badge/appearance';
import { setTimeRate, timeRate } from '../components/badge/timescale';
import { Badge } from '../components/Badge';
import { Seg } from '../components/Seg';
import { createStore, useStore } from '@luoli/ui/store';
import type { EndKind } from '../model/status';

/* 演示面板里的「徽记」一节：切换实验台。手动切状态（接管徽记的「样子」，顶栏文字等仍是实时的）、中止回复、离线、会话数、慢放。
   手动切换和真实状态走同一条路：经过 0.8 秒停留、回复完留 3 秒这些规则。「回到实时」退出接管。
   从工作状态点「待机」是正常回复完（闪一下、留 3 秒）；「中止回复」不闪，直接散回弯月。 */
type Pick = Exclude<Main, 'linger'>;
const STATES: [Pick, string][] = [
  ['idle', '待机'],
  ['waiting', '等待合并'],
  ['thinking', '思考'],
  ['replying', '回复'],
  ['tool', '工具'],
  ['retry', '重试'],
  ['error', '出错'],
];
const NAME: Record<Main, string> = {
  idle: '空闲',
  waiting: '等待合并',
  thinking: '思考中',
  replying: '回复中',
  tool: '调用工具',
  retry: '重试中',
  error: '出错',
  linger: '回复完（星星浮着留 3 秒）',
};
const lookText = (l: Look) =>
  (l.offline ? '离线（云遮月）' : NAME[l.main]) + (l.comps ? ` · ${l.comps + 1} 个会话` : '');

const lab = createStore<{
  on: boolean;
  st: Pick;
  off: boolean;
  count: number;
  end: EndKind | null;
  rate: number;
}>({
  rate: timeRate(),
  on: false,
  st: 'idle',
  off: false,
  count: 1,
  end: null,
});
function push() {
  const L = lab.get();
  if (!L.on) lab.set({ on: true });
  const comps = isWork(L.st) ? Math.min(3, L.count - 1) : 0;
  setManualLook(
    L.off
      ? { main: 'idle', comps: 0, offline: true, end: null }
      : { main: L.st, comps, offline: false, end: L.st === 'idle' ? L.end : null },
  );
}
/** 第一次接管：从此刻画出来的样子接着走，不先跳回待机 */
function enter() {
  if (lab.get().on) return;
  const l = getLook();
  lab.set({
    on: true,
    st: l.main === 'linger' ? 'idle' : l.main,
    off: l.offline,
    count: l.comps + 1,
    end: null,
  });
}
const pickState = (st: Pick) => {
  enter();
  lab.set({ st, end: st === 'idle' ? 'end' : null });
  push();
};
const abort = () => {
  enter();
  const L = lab.get();
  if (!isWork(L.st)) return;
  lab.set({ st: 'idle', end: 'abort' });
  push();
};
const toggleOff = () => {
  enter();
  lab.set({ off: !lab.get().off });
  push();
};
const stepCount = (d: number) => {
  enter();
  lab.set({ count: Math.min(4, Math.max(1, lab.get().count + d)) });
  push();
};
const backToLive = () => {
  lab.set({ on: false });
  setManualLook(null);
};

export function BadgeLab() {
  const L = useStore(lab, (s) => s);
  const v = useStore(lookView, (s) => s);
  return (
    <section data-badge-lab="">
      <h4>徽记</h4>
      <div className="demo-sky" title="放大到 96px 看">
        <Badge size={96} />
      </div>
      <div className="demo-grid">
        {STATES.map(([st, text]) => (
          <button
            key={st}
            className="dbtn"
            type="button"
            data-act={'badge-' + st}
            aria-pressed={L.on && !L.off && L.st === st}
            title={st === 'idle' ? '从工作状态点这里：正常回复完（闪一下、留 3 秒）' : undefined}
            onClick={() => pickState(st)}
          >
            {text}
          </button>
        ))}
        <button
          className="dbtn"
          type="button"
          data-act="badge-abort"
          title="从工作状态直接回空闲，不闪"
          onClick={abort}
        >
          中止回复
        </button>
        <button
          className="dbtn"
          type="button"
          data-act="badge-offline"
          aria-pressed={L.on && L.off}
          title="连不上 Telegram：云遮月，优先于其他状态"
          onClick={toggleOff}
        >
          离线
        </button>
        <button className="dbtn" type="button" data-act="badge-live" onClick={backToLive}>
          回到实时
        </button>
      </div>
      <div className="demo-row" style={{ marginTop: 8 }}>
        <span>会话数</span>
        <div className="demo-stepper">
          <button
            className="dbtn"
            type="button"
            data-act="badge-minus"
            onClick={() => stepCount(-1)}
          >
            −
          </button>
          <output id="badge-count">{L.on ? L.count : '—'}</output>
          <button className="dbtn" type="button" data-act="badge-plus" onClick={() => stepCount(1)}>
            +
          </button>
        </div>
      </div>
      <div className="demo-row" style={{ marginTop: 6 }}>
        <span>慢放</span>
        <Seg
          id="badge-rate"
          value={String(L.rate)}
          items={[
            ['1', '1×'],
            ['0.5', '½×'],
            ['0.25', '¼×'],
          ]}
          onPick={(x) => {
            setTimeRate(Number(x));
            lab.set({ rate: Number(x) });
          }}
        />
      </div>
      <p className="demo-line" id="badge-line">
        {L.on ? '手动接管中' : '实时'} · 现在：<b>{lookText(v.look)}</b>
        {v.pending && (
          <>
            <br />
            <span className="q">排队：{lookText(v.pending)}（前一个样子还没停满 0.8 秒）</span>
          </>
        )}
      </p>
    </section>
  );
}
