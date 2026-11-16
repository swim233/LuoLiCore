import { useState } from 'react';
import { Checkbox, Input, NumberInput, PasswordInput, Textarea } from '../../../src/forms';
import { IconSearch } from '../../../src/icons';
import { Block, Force, SizeRows, StateGrid } from './shared';
import type { StateCell } from './shared';

/* 「单行输入」「密码输入」「数字输入」「多行输入」四块：各状态摆一排、三档尺寸摆三行，加几个能真的用的 */

/** 平时、悬停、焦点这三个格子要强制样子，别的格子是真的状态 */
function cells(
  make: (kind: string) => React.ReactNode,
  ids: readonly (readonly [string, string])[],
) {
  return ids.map(([id, label]): StateCell => {
    const node = make(id);
    return {
      id,
      label,
      node:
        id === 'hover' ? (
          <Force hover=".ll-input, .ll-dd">{node}</Force>
        ) : id === 'focus' ? (
          <Force focus=".ll-input-el, .ll-dd">{node}</Force>
        ) : (
          node
        ),
    };
  });
}

const STATES = [
  ['rest', '平时'],
  ['hover', '悬停'],
  ['focus', '焦点'],
  ['filled', '有值'],
  ['placeholder', '占位'],
  ['disabled', '禁用'],
  ['readonly', '只读'],
  ['invalid', '出错'],
] as const;

export function InputBlock() {
  const [v, setV] = useState('星空观测站');
  return (
    <Block id="fm-input" title="单行输入" sub="Input · .ll-input">
      <p className="sc-note">
        Base UI 的 <code>Input</code>（接 Field：校验、出错状态、aria-describedby
        都是它给的）加「槽」的外壳：
        <code>--ll-inset-bg</code> 的底加 <code>--ll-inset-line</code>{' '}
        的细线，和下拉钮的槽是一家。前后各有一个位置（<code>leading</code>、<code>trailing</code>
        ）放图标、单位、小按钮；<code>clearable</code> 有字时右边出清除按钮。三档尺寸（高
        22、28、32）和按钮同档对齐。点前后缀的空白处也聚焦输入框。
      </p>
      <StateGrid
        name="input-states"
        cells={cells(
          (id) => (
            <Input
              aria-label={id}
              value={
                id === 'filled' || id === 'readonly' || id === 'invalid' || id === 'disabled'
                  ? '一段文字'
                  : undefined
              }
              onValueChange={() => {}}
              placeholder={id === 'placeholder' ? '占位的字' : undefined}
              disabled={id === 'disabled'}
              readOnly={id === 'readonly'}
              invalid={id === 'invalid'}
            />
          ),
          STATES,
        )}
      />
      <h4 className="sc-h4">前后缀、清除（点点看）</h4>
      <StateGrid
        name="input-affix"
        cells={[
          {
            id: 'lead',
            label: '前缀：图标',
            node: <Input aria-label="搜索" leading={<IconSearch />} placeholder="搜索" />,
          },
          {
            id: 'unit',
            label: '后缀：单位',
            node: <Input aria-label="超时" defaultValue="30" trailing="秒" />,
          },
          {
            id: 'clear',
            label: '可清除',
            node: (
              <Input
                aria-label="可清除"
                clearable
                value={v}
                onValueChange={setV}
                placeholder="输入点什么"
              />
            ),
          },
          {
            id: 'both',
            label: '前缀加可清除',
            node: (
              <Input
                aria-label="前缀加清除"
                leading={<IconSearch />}
                clearable
                defaultValue="读书会"
              />
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸，旁边是同档的按钮</h4>
      <SizeRows
        name="input-sizes"
        render={(size) => <Input size={size} aria-label="尺寸" defaultValue="一段文字" />}
      />
    </Block>
  );
}

export function PasswordBlock() {
  return (
    <Block id="fm-password" title="密码输入" sub="PasswordInput">
      <p className="sc-note">
        <code>Input</code>{' '}
        加右边的眼睛按钮，切换显示、隐藏。按钮不抢输入框的焦点（鼠标点它时光标还在原处）；键盘用户
        Tab 到它按空格或回车切换，<code>aria-pressed</code> 说现在是不是显示着。
        <code>autoComplete</code> 默认关掉、不检查拼写。
      </p>
      <StateGrid
        name="password-states"
        cells={cells(
          (id) => (
            <PasswordInput
              aria-label={id}
              defaultValue={
                id === 'filled' || id === 'invalid' || id === 'disabled' || id === 'readonly'
                  ? 'demo-key-0000'
                  : undefined
              }
              placeholder={id === 'placeholder' ? '粘贴 API key' : undefined}
              disabled={id === 'disabled'}
              readOnly={id === 'readonly'}
              invalid={id === 'invalid'}
            />
          ),
          STATES,
        )}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="password-sizes"
        render={(size) => (
          <PasswordInput size={size} aria-label="尺寸" defaultValue="demo-key-0000" />
        )}
      />
    </Block>
  );
}

export function NumberBlock() {
  const [scrub, setScrub] = useState(false);
  const [wheel, setWheel] = useState(false);
  const [val, setVal] = useState<number | null>(50);
  return (
    <Block id="fm-number" title="数字输入" sub="NumberInput · NumberField">
      <p className="sc-note">
        Base UI 的 <code>NumberField</code>：键盘 ↑ ↓ 加减一步，Shift 加大步（10），Alt
        小步，Home、End 到最小最大；输入时按 <code>min</code>、<code>max</code> 夹住；
        <code>unit</code> 是数字后面的单位；数字默认不加千分位（1200 就是「1200」，要的话{' '}
        <code>format</code> 里写 <code>useGrouping: true</code>
        ）。加减是两头各一个钮（减在左、加在右，数字居中）。 拖动改值（
        <code>scrub</code>）和滚轮改值（<code>wheel</code>
        ）默认关，下面两个开关打开看看：拖动是按住单位（没有单位时是把手）左右拖；滚轮要输入框聚焦时才改。
      </p>
      <StateGrid
        name="number-states"
        cells={cells(
          (id) => (
            <NumberInput
              aria-label={id}
              defaultValue={
                id === 'rest' || id === 'hover' || id === 'focus' || id === 'placeholder'
                  ? undefined
                  : 50
              }
              placeholder={id === 'placeholder' ? '1 到 200' : undefined}
              min={1}
              max={200}
              disabled={id === 'disabled'}
              readOnly={id === 'readonly'}
              invalid={id === 'invalid'}
            />
          ),
          STATES,
        )}
      />
      <h4 className="sc-h4">单位、最小最大、能真的用</h4>
      <div className="sc-fm-row" style={{ marginBottom: 10 }}>
        <Checkbox checked={scrub} onCheckedChange={setScrub}>
          拖动改值（scrub）
        </Checkbox>
        <Checkbox checked={wheel} onCheckedChange={setWheel}>
          滚轮改值（wheel）
        </Checkbox>
        <span className="sc-fm-out" data-out="number">
          当前值：{val === null ? '空' : val}
        </span>
      </div>
      <StateGrid
        name="number-live"
        cells={[
          {
            id: 'steps',
            label: '最多几步（1 到 200）',
            node: (
              <NumberInput
                aria-label="最多几步"
                value={val}
                onValueChange={setVal}
                min={1}
                max={200}
                scrub={scrub}
                wheel={wheel}
              />
            ),
          },
          {
            id: 'timeout',
            label: '回复超时（单位秒，步长 10）',
            node: (
              <NumberInput
                aria-label="回复超时"
                defaultValue={600}
                min={10}
                max={3600}
                step={10}
                unit="秒"
                scrub={scrub}
                wheel={wheel}
              />
            ),
          },
          {
            id: 'decimal',
            label: '小数（步长 0.1）',
            node: (
              <NumberInput
                aria-label="温度"
                defaultValue={0.7}
                min={0}
                max={2}
                step={0.1}
                format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                scrub={scrub}
                wheel={wheel}
              />
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="number-sizes"
        render={(size) => (
          <NumberInput size={size} aria-label="尺寸" defaultValue={12} unit="秒" min={0} max={99} />
        )}
      />
    </Block>
  );
}

export function TextareaBlock() {
  const [text, setText] = useState('');
  return (
    <Block id="fm-textarea" title="多行输入" sub="Textarea · autosize.ts">
      <p className="sc-note">
        外壳同单行输入，里面是 <code>&lt;textarea&gt;</code>。随内容长高：最少 3 行、最多 8 行（
        <code>minRows</code>、<code>maxRows</code>
        ），超过以后停在上限、里面滚（细滚动条）；宽度变了折行变了会重新量。 右下角可选字数（
        <code>count</code>，给了 <code>maxLength</code> 写「12 /
        200」）。量高度、夹上下限的算法是纯函数（
        <code>autosize.ts</code>，有测试）。不能手动拖大小。
      </p>
      <StateGrid
        name="textarea-states"
        cells={cells(
          (id) => (
            <Textarea
              aria-label={id}
              minRows={2}
              defaultValue={
                id === 'filled' || id === 'invalid' || id === 'disabled' || id === 'readonly'
                  ? '第一行\n第二行'
                  : undefined
              }
              placeholder={id === 'placeholder' ? '写点什么' : undefined}
              disabled={id === 'disabled'}
              readOnly={id === 'readonly'}
              invalid={id === 'invalid'}
            />
          ),
          STATES,
        )}
      />
      <h4 className="sc-h4">自动长高、字数（多打几行试试）</h4>
      <StateGrid
        name="textarea-live"
        cells={[
          {
            id: 'auto',
            label: '3 到 8 行，带字数（上限 200）',
            node: (
              <Textarea
                aria-label="自动长高"
                value={text}
                onChange={(e) => setText(e.target.value)}
                count
                maxLength={200}
                placeholder="一直打下去，长到 8 行就停住、里面滚"
              />
            ),
          },
          {
            id: 'fixed',
            label: '不长高（autosize 关，固定 3 行）',
            node: (
              <Textarea
                aria-label="固定高度"
                autosize={false}
                minRows={3}
                defaultValue={'一\n二\n三\n四\n五'}
              />
            ),
          },
        ]}
      />
      <h4 className="sc-h4">三档尺寸</h4>
      <SizeRows
        name="textarea-sizes"
        withButton={false}
        render={(size) => (
          <Textarea size={size} aria-label="尺寸" minRows={2} defaultValue={'两行字\n第二行'} />
        )}
      />
    </Block>
  );
}
