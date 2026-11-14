import { useState } from 'react';
import { ConfirmButton, Field, Link, Seg } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, useStageKind } from './shared';

/* 「表单项」「链接」两块 */

const MOTION_ITEMS = [
  ['system', '跟随系统'],
  ['on', '开'],
  ['off', '关'],
] as const;
const MOTION_HINT = '跟随系统的「减少动态效果」，或者手动一直开、一直关';

export function FieldBlock() {
  const kind = useStageKind();
  const [v, setV] = useState('system');
  return (
    <Group id="ctl-field" title="表单项" sub="Field · .ll-field">
      <p className="sc-note">
        标签 + 控件 + 说明。默认竖排：标签（12px、fg-3）在上，说明（12px、行高 1.5）在下，隔
        6；data-layout="row"
        横排：标签（fg-2）在左、控件在右、放不下就折行，说明不显示（说明同时写在根元素的 title
        里，悬停看）。给了 htmlFor 标签就是 &lt;label&gt;，没给是
        &lt;span&gt;。最大宽、控件靠哪边由用的地方定。
      </p>
      <Stage kind={kind}>
        <div className="sc-pill-row sc-m-fields" style={{ alignItems: 'flex-start' }}>
          <div className="sc-env-fields" style={{ width: 300 }} data-demo="field-col">
            <Field label="动画" hint={MOTION_HINT}>
              <Seg label="动画" value={v} items={MOTION_ITEMS} onPick={setV} />
            </Field>
            <Field label="布局" hint="恢复成默认的部件和大小">
              <ConfirmButton onConfirm={() => {}} armedLabel="再点一次恢复">
                恢复默认布局
              </ConfirmButton>
            </Field>
          </div>
          <div style={{ width: 340 }} data-demo="field-row">
            <div className="ll-inset sc-m-skel-live">
              <b>外观（横排）</b>
              <Field layout="row" label="动画" hint={MOTION_HINT}>
                <Seg label="动画" value={v} items={MOTION_ITEMS} onPick={setV} />
              </Field>
            </div>
          </div>
        </div>
      </Stage>
    </Group>
  );
}

export function LinkBlock() {
  const kind = useStageKind();
  const [clicks, setClicks] = useState(0);
  return (
    <Group id="ctl-link" title="链接" sub="Link · .ll-link">
      <p className="sc-note">
        强调色的字、1px
        的下划线（下划线淡一档）、悬停变亮；data-variant="auto"：自动认出来的网址，下划线是虚线。键盘焦点环用库统一的那一条。
        链接的样子（颜色、下划线、折行）对任何元素都生效；手型和悬停变亮只给真的链接（带 href 的
        a，样式里写成
        :any-link）。所以还不能点的（比如逐字输出时还没写完的链接，只有方括号里的字）写成{' '}
        {'<span className="ll-link">'}：长得和链接一样，不是手型、悬停也不变。React 的
        Link：新标签页打开、rel 带 noopener noreferrer、title
        是地址；点它、按下它、双击它都不往外冒（会话列表的行、整理模式的拖动不会被连带触发），用的地方自己传的
        onClick 等照常调（先调它，再停止冒泡）。
      </p>
      <Stage kind={kind}>
        <div className="sc-env-text" onClick={() => setClicks((c) => c + 1)} data-demo="link-text">
          群里有人发了{' '}
          <Link href="https://example.com/notes" data-demo="link">
            一篇笔记
          </Link>
          ，原地址是{' '}
          <Link
            href="https://example.com/very/long/path/that/keeps/going"
            variant="auto"
            data-demo="link-auto"
          >
            https://example.com/very/long/path/that/keeps/going
          </Link>
          。（点链接，外面这段的点击数不会涨：<b data-demo-count="link-outer">{clicks}</b>
          ；点别处会涨）
        </div>
        <div className="sc-env-text" style={{ marginTop: 10 }} data-demo="link-spans">
          还不能点的写成 span：
          <span className="ll-link" data-demo="link-span">
            还没写完的链接
          </span>
          、
          <span className="ll-link" data-variant="auto" data-demo="link-span-auto">
            https://example.com/not-yet
          </span>
          （样子一样，悬停不变、不是手型）
        </div>
      </Stage>
    </Group>
  );
}
