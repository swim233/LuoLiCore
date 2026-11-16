import { useState } from 'react';
import { Button } from '../../../src/controls';
import { Form, FormField, Input, NumberInput, Select, Textarea } from '../../../src/forms';
import { Stage } from '../../components/Stage';
import { Block } from './shared';

/* 「表单项和错误提示」一块：标签、控件、说明、错误信息摆在一起的壳（接 Base UI 的 Field），竖排和横排各摆几个；
   出错是红线、一点红底、下面一行带图标的红字；下面一张小表单，点「校验」看提交时把没填的、填错的标出来 */
const isUrl = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (s === '') return '请填写接口地址';
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? null : '只支持 http 或 https 开头的地址';
  } catch {
    return '这不是一个网址（要以 http:// 或 https:// 开头）';
  }
};

export function FieldBlock() {
  const [done, setDone] = useState(false);
  return (
    <Block id="fm-field" title="表单项和错误提示" sub="FormField · Form">
      <p className="sc-note">
        <code>FormField</code> 接 Base UI 的 <code>Field</code>
        ：标签、控件、说明、错误信息摆在一起；校验（
        <code>validate</code>、控件自己的 <code>required</code>、<code>min</code>、<code>max</code>
        ……）、出错状态、<code>aria-describedby</code>、点标签聚焦控件都是它给的。样子沿用库的{' '}
        <code>Field</code>（标签 12px 的 <code>--ll-fg-3</code>），多了出错和横排。<b>竖排</b>
        标签在上、说明在下；
        <b>横排</b>标签（带说明）在左、控件在右，容器窄于 360
        自动折成竖排。出错时控件的细线变红、底带一点红，下面一行红字前面有警告图标。
      </p>
      <div className="sc-fm-two">
        <Stage kind="sky">
          <p className="sc-fm-cap">竖排</p>
          <Form data-demo="field-column">
            <FormField label="模型名" description="接口里 model 字段填的名字" required>
              <Input defaultValue="demo-chat" />
            </FormField>
            <FormField label="接口地址" error="这不是一个网址（要以 http:// 或 https:// 开头）">
              <Input defaultValue="example" />
            </FormField>
            <FormField label="最多几步" error="最少 1 步">
              <NumberInput defaultValue={0} min={1} max={200} />
            </FormField>
            <FormField label="用哪个模型" nativeLabel={false} error="请选一个模型">
              <Select
                aria-label="用哪个模型"
                options={[{ value: 'demo-chat', label: 'demo-chat' }]}
                placeholder="选一个模型"
              />
            </FormField>
          </Form>
        </Stage>
        <Stage kind="sky">
          <p className="sc-fm-cap">横排</p>
          <Form layout="row" data-demo="field-row">
            <FormField label="模型名" description="接口里 model 字段填的名字" required>
              <Input defaultValue="demo-chat" />
            </FormField>
            <FormField label="接口地址" error="这不是一个网址（要以 http:// 或 https:// 开头）">
              <Input defaultValue="example" />
            </FormField>
            <FormField label="最多几步" description="1 到 200" error="最少 1 步">
              <NumberInput defaultValue={0} min={1} max={200} />
            </FormField>
            <FormField label="人设" description="写给洛璃看的">
              <Textarea minRows={2} placeholder="一段话" />
            </FormField>
          </Form>
        </Stage>
      </div>
      <h4 className="sc-h4">真的校验：点「校验」，没填的、填错的都标出来（焦点给第一个出错的）</h4>
      <Stage kind="sky">
        <Form
          data-demo="field-live"
          onFormSubmit={() => setDone(true)}
          onChange={() => setDone(false)}
        >
          <FormField
            name="model"
            label="模型名（必填，至少 3 个字）"
            required
            validate={(v) => (String(v ?? '').trim().length < 3 ? '模型名至少 3 个字' : null)}
          >
            <Input name="model" required placeholder="例如 demo-chat" />
          </FormField>
          <FormField name="url" label="接口地址（填的不是网址时报错）" required validate={isUrl}>
            <Input name="url" required placeholder="https://example.invalid/v1" />
          </FormField>
          <div className="sc-fm-actions">
            <Button size="lg" variant="primary" type="submit">
              校验
            </Button>
            {done && <span className="sc-fm-saved">都对（演示，什么也没发）</span>}
          </div>
        </Form>
      </Stage>
    </Block>
  );
}
