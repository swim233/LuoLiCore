import { useState } from 'react';
import { Checkbox, CheckboxGroup, Radio, RadioGroup, Slider } from '../../../src/forms';
import { Block, Force, SizeRows, StateGrid } from './shared';
import type { StateCell } from './shared';

/* 「复选框」「单选」「滑块」三块 */
const TOOLS = ['fetch', 'search', 'calc', 'clock'];

export function CheckBlock() {
  const [picked, setPicked] = useState<string[]>(['fetch']);
  const cell = (
    id: string,
    label: string,
    props: Record<string, unknown>,
    force?: 'hover' | 'focus',
  ): StateCell => {
    const node = <Checkbox {...props}>选项</Checkbox>;
    return {
      id,
      label,
      node:
        force === 'hover' ? (
          <Force hover=".ll-check">{node}</Force>
        ) : force === 'focus' ? (
          <Force focus=".ll-check-box">{node}</Force>
        ) : (
          node
        ),
    };
  };
  return (
    <Block id="fm-check" title="复选框、复选组" sub="Checkbox · CheckboxGroup">
      <p className="sc-note">
        Base UI 的 <code>Checkbox</code>（空格切换、读屏的 checkbox 角色、接 Field
        和表单提交都是它给的）。一个选项是一个 <code>&lt;label&gt;</code>：框（16×16，sm 14、lg
        18）加文字，点文字也能切换。有<b>半选</b>（<code>indeterminate</code>
        ，横线）。选中是强调色实心，里面的勾（点）是深色。
      </p>
      <StateGrid
        name="check-states"
        cells={[
          cell('rest', '平时', { 'aria-label': '平时' }),
          cell('hover', '悬停', { 'aria-label': '悬停' }, 'hover'),
          cell('focus', '焦点', { 'aria-label': '焦点' }, 'focus'),
          cell('checked', '选中', { 'aria-label': '选中', defaultChecked: true }),
          cell('indeterminate', '半选', { 'aria-label': '半选', indeterminate: true }),
          cell('disabled', '禁用', { 'aria-label': '禁用', disabled: true }),
          cell('disabled-on', '禁用且选中', {
            'aria-label': '禁用且选中',
            disabled: true,
            defaultChecked: true,
          }),
          cell('readonly', '只读', { 'aria-label': '只读', readOnly: true, defaultChecked: true }),
        ]}
      />
      <h4 className="sc-h4">复选组：启用的工具（带「全选」，半选是它算出来的）</h4>
      <StateGrid
        name="check-group"
        cells={[
          {
            id: 'group',
            label: '竖着排',
            node: (
              <CheckboxGroup
                aria-label="启用的工具"
                value={picked}
                onValueChange={setPicked}
                allValues={TOOLS}
              >
                <Checkbox parent>全选</Checkbox>
                {TOOLS.map((t) => (
                  <Checkbox key={t} value={t}>
                    {t}
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ),
          },
          {
            id: 'group-row',
            label: '排成一行',
            node: (
              <CheckboxGroup aria-label="一行" orientation="row" defaultValue={['calc']}>
                {TOOLS.map((t) => (
                  <Checkbox key={t} value={t}>
                    {t}
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ),
          },
          {
            id: 'group-out',
            label: '选中的',
            node: (
              <span className="sc-fm-out" data-out="check">
                {JSON.stringify(picked)}
              </span>
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="check-sizes"
        withButton={false}
        render={(size) => (
          <div className="sc-fm-row">
            <Checkbox size={size} defaultChecked>
              选中
            </Checkbox>
            <Checkbox size={size} indeterminate>
              半选
            </Checkbox>
            <Checkbox size={size}>没选</Checkbox>
          </div>
        )}
      />
    </Block>
  );
}

export function RadioBlock() {
  const [v, setV] = useState('article');
  const radio = (
    id: string,
    label: string,
    props: Record<string, unknown>,
    force?: 'hover' | 'focus',
  ): StateCell => {
    const node = (
      <RadioGroup
        aria-label={label}
        defaultValue={id === 'rest' || id === 'hover' || id === 'focus' ? undefined : 'a'}
      >
        <Radio value="a" {...props}>
          选项
        </Radio>
      </RadioGroup>
    );
    return {
      id,
      label,
      node:
        force === 'hover' ? (
          <Force hover=".ll-check">{node}</Force>
        ) : force === 'focus' ? (
          <Force focus=".ll-check-box">{node}</Force>
        ) : (
          node
        ),
    };
  };
  return (
    <Block id="fm-radio" title="单选组" sub="RadioGroup · Radio">
      <p className="sc-note">
        Base UI 的 <code>RadioGroup</code>、<code>Radio</code>（一组里只有一个在 Tab
        顺序里，方向键在选项之间走、走到就选中，读屏的 radio 角色）。框是圆的，选中的点 42%
        大；选中的样子同复选框（强调色实心）。<code>orientation</code> 是 column（默认）或 row。
      </p>
      <StateGrid
        name="radio-states"
        cells={[
          radio('rest', '平时', {}),
          radio('hover', '悬停', {}, 'hover'),
          radio('focus', '焦点', {}, 'focus'),
          radio('checked', '选中', {}),
          radio('disabled', '禁用', { disabled: true }),
        ]}
      />
      <h4 className="sc-h4">抓取方式（竖着排、排成一行、一项禁用）</h4>
      <StateGrid
        name="radio-live"
        cells={[
          {
            id: 'col',
            label: '竖着排',
            node: (
              <RadioGroup aria-label="抓取方式" value={v} onValueChange={setV}>
                <Radio value="article">正文模式</Radio>
                <Radio value="page">整页模式</Radio>
                <Radio value="raw" disabled>
                  原始（还没做）
                </Radio>
              </RadioGroup>
            ),
          },
          {
            id: 'row',
            label: '排成一行',
            node: (
              <RadioGroup aria-label="一行" orientation="row" defaultValue="b">
                <Radio value="a">甲</Radio>
                <Radio value="b">乙</Radio>
                <Radio value="c">丙</Radio>
              </RadioGroup>
            ),
          },
          {
            id: 'out',
            label: '选中的',
            node: (
              <span className="sc-fm-out" data-out="radio">
                {v}
              </span>
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="radio-sizes"
        withButton={false}
        render={(size) => (
          <RadioGroup aria-label="尺寸" orientation="row" size={size} defaultValue="a">
            <Radio value="a">选中</Radio>
            <Radio value="b">没选</Radio>
          </RadioGroup>
        )}
      />
    </Block>
  );
}

export function SliderBlock() {
  const [days, setDays] = useState(30);
  const cell = (
    id: string,
    label: string,
    props: Record<string, unknown>,
    force?: 'hover' | 'focus',
  ): StateCell => {
    const node = <Slider aria-label={label} defaultValue={40} {...props} />;
    return {
      id,
      label,
      node:
        force === 'hover' ? (
          <Force hover=".ll-slider-thumb">{node}</Force>
        ) : force === 'focus' ? (
          <Force focus=".ll-slider-thumb input">{node}</Force>
        ) : (
          node
        ),
    };
  };
  return (
    <Block id="fm-slider" title="滑块" sub="Slider">
      <p className="sc-note">
        Base UI 的 <code>Slider</code>：拖把手、点轨道跳过去；键盘 ← → ↑ ↓
        走一步，PageUp、PageDown（或 Shift 加方向键）走一大步（默认 10），Home、End
        到最小最大；读屏的 slider 角色、<code>aria-valuenow</code>。 单个把手；右边显示当前值（
        <code>renderValue</code> 能自己写，比如 0 写「永久」，这段文字同时给读屏的{' '}
        <code>aria-valuetext</code>
        ）。轨是粗的，填充是强调色到金色的渐变（和能量槽一家），把手是一道竖条。
      </p>
      <StateGrid
        name="slider-states"
        cells={[
          cell('rest', '平时', {}),
          cell('hover', '悬停', {}, 'hover'),
          cell('focus', '焦点', {}, 'focus'),
          cell('min', '最小', { defaultValue: 0 }),
          cell('max', '最大', { defaultValue: 100 }),
          cell('disabled', '禁用', { disabled: true }),
        ]}
      />
      <h4 className="sc-h4">请求记录保留几天（0 到 90，0 是永久）</h4>
      <StateGrid
        name="slider-live"
        cells={[
          {
            id: 'days',
            label: '自己写显示的字',
            node: (
              <Slider
                aria-label="请求记录保留几天"
                min={0}
                max={90}
                value={days}
                onValueChange={setDays}
                renderValue={(n) => (n === 0 ? '永久' : `${n} 天`)}
              />
            ),
          },
          {
            id: 'steps',
            label: '步长 10，带单位',
            node: (
              <Slider aria-label="步长 10" min={0} max={100} step={10} defaultValue={50} unit="%" />
            ),
          },
          {
            id: 'out',
            label: '当前值',
            node: (
              <span className="sc-fm-out" data-out="slider">
                {days}
              </span>
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="slider-sizes"
        render={(size) => <Slider size={size} aria-label="尺寸" defaultValue={40} />}
      />
    </Block>
  );
}
