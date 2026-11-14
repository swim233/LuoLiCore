import { useState } from 'react';
import { Button, Meter, Roll, Stat } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, useStageKind } from './shared';

/* 「统计格」「数字滚动」「能量槽」三块 */

const pct = (v: number) => v.toFixed(1) + '%';

export function StatBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-stat" title="统计格" sub="Stat · .ll-stat">
      <p className="sc-note">
        三种样子（data-variant）。不写（方格）：半透明的底加细线、圆角 12、内边距 14 /
        16，小标题（12px、字距 0.06em）在上、大数字（28px、粗
        600）在下，下面可以放能量槽；hero（头条）：没有底，大数字（42px）后面跟一个单位（13px）；row（一行）：标签在左、数字在右（字
        12px、数字等宽），下面可以放能量槽。 数字（value）是任意内容，面板里传
        Roll。几格怎么排由用的地方定。
      </p>
      <Stage kind={kind}>
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }}>
          <div className="sc-m-grid" style={{ width: 460 }} data-demo="stat-tiles">
            <Stat label="今天的回复" value={<Roll value={128} />} />
            <Stat label="缓存命中率" value={<Roll value={62.5} fmt={pct} />}>
              <Meter value={0.625} label="缓存命中率" />
            </Stat>
          </div>
          <div className="sc-env-today" data-demo="stat-window">
            <Stat variant="hero" value={<Roll value={128} />} unit="次回复" />
            <Stat
              variant="row"
              label="token"
              value={
                <>
                  输入 <b>12,345</b> · 输出 <b>3,210</b>
                </>
              }
            />
            <Stat
              variant="row"
              label="失败"
              value={
                <>
                  <b>3</b> 次
                </>
              }
            >
              <Meter value={0.08} tone="danger" label="失败率" />
            </Stat>
          </div>
        </div>
      </Stage>
    </Group>
  );
}

export function RollBlock() {
  const kind = useStageKind();
  const [v, setV] = useState(1234);
  const bump = () => setV(Math.round(Math.random() * 90000));
  return (
    <Group id="ctl-roll" title="数字滚动" sub="Roll · .ll-roll">
      <p className="sc-note">
        值变了就从旧值滚到新值（0.9 秒，曲线 EASE_OUT，库里自己用 requestAnimationFrame 走，不用
        Motion）；滚动期间根上有
        data-rolling，颜色变白，滚完半秒后还原；等宽数字；中途换值从当前数接着滚；首次挂上直接显示；动画关掉时直接到位。接口：value、fmt。
      </p>
      <Stage kind={kind}>
        <div className="sc-pill-row" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--ll-text-figure)', fontWeight: 600 }} data-demo="roll-big">
            <Roll value={v} data-demo="roll" />
          </span>
          <Roll value={v / 10} fmt={pct} data-demo="roll-pct" />
          <Button onClick={bump} data-demo="roll-bump">
            改数
          </Button>
          <Button onClick={() => setV(0)} data-demo="roll-zero">
            归零
          </Button>
        </div>
      </Stage>
    </Group>
  );
}

export function MeterBlock() {
  const kind = useStageKind();
  const [v, setV] = useState(0.45);
  return (
    <Group id="ctl-meter" title="能量槽" sub="Meter · .ll-meter">
      <p className="sc-note">
        细的一条（高 6、全圆角）。value 是 0 到 1；默认是强调色到点睛色的渐变，data-tone="danger"
        是危险色。宽度的变化有 0.9 秒的过渡（动画关掉时 0.12
        秒）；数值变大时一道光从左扫到右（动画关掉时不放）。role="meter"，aria-valuenow
        是百分数，label 是念出来的名字。
      </p>
      <Stage kind={kind}>
        <div className="sc-env-stack" style={{ maxWidth: 360 }}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(v * 100)}
            aria-label="能量槽的值"
            onChange={(e) => setV(Number(e.target.value) / 100)}
            data-demo="meter-range"
          />
          <Meter value={v} label="缓存命中率" data-demo="meter" />
          <Meter value={v} tone="danger" label="失败率" data-demo="meter-danger" />
          <div className="sc-pill-row">
            <Button onClick={() => setV(Math.min(1, v + 0.1))} data-demo="meter-plus">
              加 10%
            </Button>
            <Button onClick={() => setV(Math.max(0, v - 0.1))} data-demo="meter-minus">
              减 10%
            </Button>
          </div>
        </div>
      </Stage>
    </Group>
  );
}
