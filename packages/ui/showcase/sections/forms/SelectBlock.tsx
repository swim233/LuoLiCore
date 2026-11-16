import { useState } from 'react';
import { Select } from '../../../src/forms';
import type { SelectItems } from '../../../src/forms';
import { Block, Force, SizeRows, StateGrid } from './shared';
import type { StateCell } from './shared';

/* 「下拉选择」一块：打开用「长开」（钮的底长成浮层的底），和选会话的菜单一个样子；当前项打勾；选项多了里面滚；能分组、能禁用某一项 */
const MODELS: SelectItems = [
  { value: 'demo-chat', label: 'demo-chat' },
  { value: 'demo-chat-fast', label: 'demo-chat-fast', hint: '快' },
  { value: 'demo-reason', label: 'demo-reason', hint: '会想' },
  { value: 'demo-old', label: 'demo-old（停用）', disabled: true },
  { value: 'demo-vision', label: 'demo-vision' },
];
const GROUPED: SelectItems = [
  {
    label: '对话',
    options: [
      { value: 'demo-chat', label: 'demo-chat' },
      { value: 'demo-chat-fast', label: 'demo-chat-fast' },
    ],
  },
  {
    label: '推理',
    options: [
      { value: 'demo-reason', label: 'demo-reason' },
      { value: 'demo-reason-pro', label: 'demo-reason-pro', disabled: true },
    ],
  },
  {
    label: '看图',
    options: [{ value: 'demo-vision', label: 'demo-vision' }],
  },
];
const LONG: SelectItems = Array.from({ length: 36 }, (_, i) => ({
  value: `item-${i + 1}`,
  label: `第 ${i + 1} 个选项`,
}));

export function SelectBlock() {
  const [v, setV] = useState<string | null>('demo-chat');
  const cells: StateCell[] = (
    [
      ['rest', '平时（有值）'],
      ['hover', '悬停'],
      ['focus', '焦点'],
      ['placeholder', '占位'],
      ['disabled', '禁用'],
      ['invalid', '出错'],
    ] as const
  ).map(([id, label]) => {
    const node = (
      <Select
        aria-label={id}
        options={MODELS}
        defaultValue={id === 'placeholder' ? null : 'demo-chat'}
        placeholder="选一个模型"
        disabled={id === 'disabled'}
        invalid={id === 'invalid'}
      />
    );
    return {
      id,
      label,
      node:
        id === 'hover' ? (
          <Force hover=".ll-dd">{node}</Force>
        ) : id === 'focus' ? (
          <Force focus=".ll-dd">{node}</Force>
        ) : (
          node
        ),
    };
  });
  return (
    <Block id="fm-select" title="下拉选择" sub="Select · 长开">
      <p className="sc-note">
        Base UI 的 <code>Select</code>（键盘、输入首字母跳到那一项、读屏的 listbox 角色、接 Field
        和表单提交都是它给的）。打开它的钮就是下拉钮的槽加小箭头，<b>打开用「长开」</b>
        ：钮的底长成浮层的底（约 0.5
        秒），钮那一行留在浮层最上面当头，项按顺序落下来；当前项底亮一档、右边打勾；选项多了里面滚；
        能分组（组名加细线）、能禁用某一项。和选会话的菜单共用同一套零件，所以是一个样子。点开试试，Esc、点外面、↑
        ↓ Enter 都能用。
      </p>
      <StateGrid name="select-states" cells={cells} />
      <h4 className="sc-h4">能真的用：平常的、分组加禁用、选项很多</h4>
      <StateGrid
        name="select-live"
        cells={[
          {
            id: 'flat',
            label: '平常的（带右边的小字、一项禁用）',
            node: (
              <Select
                aria-label="用哪个模型"
                options={MODELS}
                value={v}
                onValueChange={setV}
                placeholder="选一个模型"
              />
            ),
          },
          {
            id: 'grouped',
            label: '分组',
            node: <Select aria-label="分组" options={GROUPED} placeholder="选一个模型" />,
          },
          {
            id: 'long',
            label: '36 个选项（里面滚）',
            node: <Select aria-label="很多" options={LONG} defaultValue="item-3" />,
          },
        ]}
      />
      <p className="sc-fm-out" data-out="select">
        上面第一个选的：{v ?? '没选'}
      </p>
      <h4 className="sc-h4">三档尺寸，旁边是同档的按钮</h4>
      <SizeRows
        name="select-sizes"
        render={(size) => (
          <Select size={size} aria-label="尺寸" options={MODELS} defaultValue="demo-chat" />
        )}
      />
    </Block>
  );
}
