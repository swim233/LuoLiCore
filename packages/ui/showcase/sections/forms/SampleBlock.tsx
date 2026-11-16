import { useState } from 'react';
import { Button } from '../../../src/controls';
import {
  CheckboxGroup,
  Checkbox,
  Form,
  FormField,
  Input,
  ListEdit,
  NumberInput,
  PasswordInput,
  Radio,
  RadioGroup,
  Select,
  Slider,
  Textarea,
} from '../../../src/forms';
import type { FormLayout } from '../../../src/forms';
import { Stage } from '../../components/Stage';
import { Block } from './shared';

/* 「设置表单」样例：照第十阶段大概会有的样子拼一张表单，让控件放在真实的场景里看。夜空窗口的底（Stage sky），半透明面板（.ll-inset）分组，
   竖排和横排各摆一份。数据都是假的（没有真的 key、地址）。底下的「保存」会把必填没填的、填错的标出来（Base UI 的 Form）。 */
const MODELS = [
  { value: 'demo-chat', label: 'demo-chat' },
  { value: 'demo-chat-fast', label: 'demo-chat-fast' },
  { value: 'demo-reason', label: 'demo-reason' },
  { value: 'demo-vision', label: 'demo-vision' },
];
const TOOLS = [
  ['fetch', '抓取网页'],
  ['tasks', '定时任务'],
  ['search', '搜索'],
] as const;

const need = (msg: string) => (v: unknown) => (v == null || String(v).trim() === '' ? msg : null);
const checkUrl = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (s === '') return '请填写接口地址';
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? null : '只支持 http 或 https 开头的地址';
  } catch {
    return '这不是一个网址（要以 http:// 或 https:// 开头）';
  }
};

function SettingsForm({ layout }: { layout?: FormLayout }) {
  const [saved, setSaved] = useState(false);
  /* 重置：换一个 key，整张表单重新挂上，回到初始值 */
  const [round, setRound] = useState(0);
  return (
    <Form
      key={round}
      layout={layout}
      onFormSubmit={() => setSaved(true)}
      onChange={() => setSaved(false)}
      data-demo={layout === 'row' ? 'settings-row' : 'settings-column'}
    >
      <div className="ll-inset sc-fm-group">
        <p className="sc-fm-group-title">模型</p>
        <FormField name="model" label="模型名" required validate={need('请填写模型名')}>
          <Input name="model" required defaultValue="demo-chat" placeholder="例如 demo-chat" />
        </FormField>
        <FormField
          name="baseUrl"
          label="接口地址"
          description="OpenAI 兼容的接口，填到版本号那一层"
          required
          validate={checkUrl}
        >
          <Input name="baseUrl" required placeholder="https://example.invalid/v1" />
        </FormField>
        <FormField name="apiKey" label="API key" required validate={need('请填写 API key')}>
          <PasswordInput name="apiKey" required placeholder="粘贴 key" />
        </FormField>
        <FormField
          name="pick"
          label="用哪个模型"
          nativeLabel={false}
          required
          validate={need('请选一个模型')}
        >
          <Select
            name="pick"
            required
            aria-label="用哪个模型"
            options={MODELS}
            placeholder="选一个模型"
          />
        </FormField>
      </div>
      <div className="ll-inset sc-fm-group">
        <p className="sc-fm-group-title">回复</p>
        <FormField
          name="steps"
          label="最多几步"
          description="一次回复里调工具的步数上限，1 到 200"
          required
          validate={(x) => (x == null ? '请填写步数' : null)}
        >
          <NumberInput name="steps" required defaultValue={50} min={1} max={200} />
        </FormField>
        <FormField name="timeout" label="回复超时" description="超过这个时间还没答完就算失败">
          <NumberInput name="timeout" defaultValue={600} min={10} max={3600} step={10} unit="秒" />
        </FormField>
        <FormField name="fetchMode" label="抓取方式" group>
          <RadioGroup name="fetchMode" aria-label="抓取方式" defaultValue="article">
            <Radio value="article">正文模式（只取文章部分）</Radio>
            <Radio value="page">整页模式（连评论区一起）</Radio>
          </RadioGroup>
        </FormField>
        <FormField name="tools" label="启用的工具" group>
          <CheckboxGroup aria-label="启用的工具" defaultValue={['fetch', 'tasks']}>
            {TOOLS.map(([id, label]) => (
              <Checkbox key={id} value={id}>
                {label}
              </Checkbox>
            ))}
          </CheckboxGroup>
        </FormField>
        <FormField name="keepDays" label="请求记录保留几天" group>
          <Slider
            aria-label="请求记录保留几天"
            name="keepDays"
            min={0}
            max={90}
            defaultValue={30}
            renderValue={(n) => (n === 0 ? '永久' : `${n} 天`)}
          />
        </FormField>
      </div>
      <div className="ll-inset sc-fm-group">
        <p className="sc-fm-group-title">对话</p>
        <FormField label="唤醒词" description="群里说到这些词，洛璃就会回复" group>
          <ListEdit aria-label="唤醒词" defaultValue={['nori', '洛璃']} placeholder="一个唤醒词" />
        </FormField>
        <FormField label="白名单的群" description="只在这些群里工作" group>
          <ListEdit aria-label="白名单的群" defaultValue={['-100000000001']} placeholder="群 id" />
        </FormField>
        <FormField name="persona" label="人设" description="写给洛璃看的一段话">
          <Textarea
            name="persona"
            count
            maxLength={2000}
            minRows={4}
            defaultValue="你是一个温和、爱开玩笑的群聊助手。（演示用的假人设）"
          />
        </FormField>
      </div>
      <div className="sc-fm-actions">
        <Button size="lg" variant="primary" type="submit">
          保存
        </Button>
        <Button
          size="lg"
          type="button"
          onClick={() => {
            setSaved(false);
            setRound((n) => n + 1);
          }}
        >
          重置
        </Button>
        {saved && <span className="sc-fm-saved">已保存（演示，什么也没存）</span>}
      </div>
    </Form>
  );
}

export function SampleBlock() {
  return (
    <Block id="fm-sample" title="设置表单样例" sub="第十阶段设置大概的样子">
      <p className="sc-note">
        照第十阶段设置大概会有的样子拼的一张表单：夜空窗口里，半透明面板分组。模型名、接口地址、API
        key、用哪个模型、最多几步、回复超时、抓取方式、启用的工具、请求记录保留几天、唤醒词、白名单的群、人设都有。竖排和横排各摆一份。
        <b>点「保存」</b>：必填没填的（接口地址、API
        key、用哪个模型）、填错的（接口地址不是网址）都会标出来，焦点给第一个出错的；改成对的以后再保存就通过了。
        数据都是假的。
      </p>
      <div className="sc-fm-two">
        <Stage kind="sky">
          <div className="sc-fm-win">
            <p className="sc-fm-win-title">竖排（标签在上）</p>
            <SettingsForm />
          </div>
        </Stage>
        <Stage kind="sky">
          <div className="sc-fm-win">
            <p className="sc-fm-win-title">横排（标签在左）</p>
            <SettingsForm layout="row" />
          </div>
        </Stage>
      </div>
    </Block>
  );
}
