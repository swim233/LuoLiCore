import { useState } from 'react';
import { Button, Meter, Roll, Stat } from '../../../src/controls';
import { LegacyEnergy, LegacyRoll } from '../../legacy/step5-parts';
import { Compare } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import { Group, Merged, Now, useStageKind } from './shared';

/* 「统计格」「数字滚动」「能量槽」三块（带和面板现在写法的对比） */

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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="stat-lines"
        title="统计格：头条和一行（今日概况窗口里）"
        note="头条：大数字用刻度里的 --ll-text-figure-lg（面板里写的字面 42px，一样大）；一行：字号 12.5px → 12px（刻度的一档），标签、数字的位置和对齐不变。"
        now={
          <Now>
            <div className="sc-env-today">
              <div className="today-hero" data-item="hero">
                <LegacyRoll value={128} data-item="hero-roll" />
                <span data-item="hero-unit">次回复</span>
              </div>
              <div className="stat-row" data-item="token">
                <span data-item="token-label">token</span>
                <span data-item="token-value">
                  输入{' '}
                  <b>
                    <LegacyRoll value={12345} />
                  </b>{' '}
                  · 输出{' '}
                  <b>
                    <LegacyRoll value={3210} />
                  </b>
                </span>
              </div>
              <div className="stat" data-item="row">
                <div className="stat-row" data-item="row-line">
                  <span data-item="row-label">缓存命中率</span>
                  <b data-item="row-b">
                    <LegacyRoll value={62.5} fmt={pct} />
                  </b>
                </div>
                <LegacyEnergy value={0.625} label="缓存命中率" data-item="row-meter" />
              </div>
              <div className="stat" data-item="row2">
                <div className="stat-row" data-item="row2-line">
                  <span data-item="row2-label">失败</span>
                  <span data-item="row2-value">
                    <b>
                      <LegacyRoll value={3} />
                    </b>{' '}
                    次
                  </span>
                </div>
                <LegacyEnergy value={0.08} bad label="失败率" data-item="row2-meter" />
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-today">
              <Stat
                variant="hero"
                data-item="hero"
                value={<Roll value={128} data-item="hero-roll" />}
                unit="次回复"
              />
              <Stat
                variant="row"
                data-item="token-root"
                label="token"
                value={
                  <>
                    输入{' '}
                    <b>
                      <Roll value={12345} />
                    </b>{' '}
                    · 输出{' '}
                    <b>
                      <Roll value={3210} />
                    </b>
                  </>
                }
              />
              <Stat
                variant="row"
                data-item="row"
                label="缓存命中率"
                value={
                  <b data-item="row-b">
                    <Roll value={62.5} fmt={pct} />
                  </b>
                }
              >
                <Meter value={0.625} label="缓存命中率" data-item="row-meter" />
              </Stat>
              <Stat
                variant="row"
                data-item="row2"
                label="失败"
                value={
                  <>
                    <b>
                      <Roll value={3} />
                    </b>{' '}
                    次
                  </>
                }
              >
                <Meter value={0.08} tone="danger" label="失败率" data-item="row2-meter" />
              </Stat>
            </div>
          </Merged>
        }
      />
      <Compare
        id="stat-tile"
        title="统计格：方格（今日概况全屏里的 .tile）"
        note="圆角 14 → 12（半透明面板统一的 --ll-radius-lg）；大数字 28px、小标题 12px、字距 0.06em、内边距 14 / 16 都一样。"
        now={
          <Now>
            <div className="today-grid" style={{ width: '100%', maxWidth: 460 }}>
              <div className="tile" data-item="tile">
                <small data-item="tile-label">今天的回复</small>
                <LegacyRoll value={128} data-item="tile-roll" />
              </div>
              <div className="tile" data-item="tile2">
                <small data-item="tile2-label">缓存命中率</small>
                <LegacyRoll value={62.5} fmt={pct} data-item="tile2-roll" />
                <LegacyEnergy value={0.625} label="缓存命中率" data-item="tile2-meter" />
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-m-grid" style={{ width: '100%', maxWidth: 460 }}>
              <Stat
                data-item="tile"
                label="今天的回复"
                value={<Roll value={128} data-item="tile-roll" />}
              />
              <Stat
                data-item="tile2"
                label="缓存命中率"
                value={<Roll value={62.5} fmt={pct} data-item="tile2-roll" />}
              >
                <Meter value={0.625} label="缓存命中率" data-item="tile2-meter" />
              </Stat>
            </div>
          </Merged>
        }
      />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="roll"
        title="数字滚动：平常和滚动中（变白）"
        note="样子一样：等宽数字、inline-block、滚动中白色。滚动中的标记从类 .is-up 换成属性 data-rolling。"
        now={
          <Now>
            <div className="sc-env-stack">
              <span className="roll" data-item="roll">
                12,345
              </span>
              <span className="roll is-up" data-item="rolling">
                12,345
              </span>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-stack">
              <span className="ll-roll" data-item="roll">
                12,345
              </span>
              <span className="ll-roll" data-rolling="" data-item="rolling">
                12,345
              </span>
            </div>
          </Merged>
        }
      />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="meter"
        title="能量槽：渐变和 danger"
        note="圆角面板写的字面 3px，库里写 --ll-radius-full（高 6 的槽里画出来都是 3px，一样）；那一层 display: none 的刻度是死代码，不搬。"
        now={
          <Now>
            <div className="sc-env-stack">
              <LegacyEnergy value={0.62} label="缓存命中率" data-item="meter" />
              <LegacyEnergy value={0.12} bad label="失败率" data-item="meter-bad" />
              <LegacyEnergy value={0} label="空的" data-item="meter-zero" />
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-stack">
              <Meter value={0.62} label="缓存命中率" data-item="meter" />
              <Meter value={0.12} tone="danger" label="失败率" data-item="meter-bad" />
              <Meter value={0} label="空的" data-item="meter-zero" />
            </div>
          </Merged>
        }
      />
    </Group>
  );
}
