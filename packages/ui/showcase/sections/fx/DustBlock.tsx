import { useRef, useState } from 'react';
import { Button } from '../../../src/controls';
import { edgeRun, fx } from '../../../src/fx';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「星尘」一块：对着一个矩形迸发、汇聚、消散。三样都只收「屏幕上的矩形或点」，不认识窗口；动画关了什么也不放 */
export function DustBlock() {
  const rectRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  const rect = () => rectRef.current!.getBoundingClientRect();
  const centre = () => {
    const r = rect();
    return [r.left + r.width / 2, r.top + r.height / 2] as const;
  };
  return (
    <Group id="fx-dust" title="星尘" sub="fx · particleMessage">
      <p className="sc-note">
        <code>fx.start(canvas, {'{ worker }'})</code>：星尘的 Worker 由用的地方建好传进来（Worker
        里调 <code>particleMessage</code>，展示页的在 <code>showcase/fx.worker.ts</code>
        ；面板里它还要先问徽记的小画布认不认，所以两边共用一个）。
        <code>fx.burst(x, y)</code> 迸发（回复完成时从光标散开，新增部件完成时迸一小团）、
        <code>fx.assemble(rect)</code> 星点从四周汇聚成矩形的轮廓和内部（返回的 Promise 在时间走到
        80% 时完成，调的人接着把东西显出来）、<code>fx.scatter(rect)</code> 散开（消失）。粒子数按{' '}
        <code>scale</code> 缩放（窄屏、性能低时少一点）；窗口大小变了调 <code>fx.size()</code>
        ，和这个 Worker 共用的东西用 <code>fx.onResize</code> 登记。
      </p>
      <div className="sc-pill-row sc-fx-ctl">
        <Button
          data-demo="fx-burst"
          onClick={() => {
            const [x, y] = centre();
            fx.burst(x, y);
          }}
        >
          迸发
        </Button>
        <Button
          data-demo="fx-assemble"
          onClick={() => {
            const r = rect();
            setShown(false);
            void fx.assemble(r).then(() => {
              setShown(true);
              edgeRun(rectRef.current);
              fx.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 14, speed: 80 });
            });
          }}
        >
          汇聚
        </Button>
        <Button
          data-demo="fx-scatter"
          onClick={() => {
            fx.scatter(rect());
            setShown(false);
            setTimeout(() => setShown(true), 1600);
          }}
        >
          消散
        </Button>
      </div>
      <Stage kind="page">
        <div className="sc-fx-stage">
          <div
            ref={rectRef}
            className="ll-sky sc-fx-win sc-fx-rect"
            data-demo="fx-rect"
            style={{ visibility: shown ? 'visible' : 'hidden' }}
          >
            <i className="ll-edge" />
            <span>对着这个矩形（汇聚、消散时它藏起来，等星尘落完再回来）</span>
          </div>
        </div>
      </Stage>
    </Group>
  );
}
