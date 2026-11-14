import { useState } from 'react';
import { ConfirmButton, Field, Link, Seg } from '../../../src/controls';
import { Compare } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import { Group, Merged, Now, useStageKind } from './shared';

/* 「表单项」「链接」两块（带和面板现在写法的对比） */

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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="field-col"
        title="表单项：竖排（全屏设置里的 .set-field）"
        note='标记换了（标签 <span class="set-label">、说明 <p class="set-hint"> 换成 Field 的），画出来的位置不变；标签、说明的字号对到刻度。最大宽 520、控件靠左（align-self）留在面板。'
        now={
          <Now>
            <div className="sc-env-fields">
              <div className="set-field" title={MOTION_HINT} data-item="field">
                <span className="set-label" data-item="label">
                  动画
                </span>
                <Seg label="动画" value="system" items={MOTION_ITEMS} onPick={() => {}} />
                <p className="set-hint" data-item="hint">
                  {MOTION_HINT}
                </p>
              </div>
            </div>
          </Now>
        }
        merged={
          <Merged className="sc-m-fields">
            <div className="sc-env-fields">
              <Field label="动画" hint={MOTION_HINT} data-item="field">
                <Seg label="动画" value="system" items={MOTION_ITEMS} onPick={() => {}} />
              </Field>
            </div>
          </Merged>
        }
      />
      <Compare
        id="field-row"
        title="表单项：横排（窗口里设置的外观 .skel-live 里的 .set-field）"
        note="现在横排靠外层 .skel-live 的后代选择器；换了以后由面板按窗口还是全屏给 layout。标签 12.5px → 12px（刻度的一档）。"
        now={
          <Now>
            <section className="skel-live" data-item="group">
              <b>外观</b>
              <div className="set-field" title={MOTION_HINT} data-item="field">
                <span className="set-label" data-item="label">
                  动画
                </span>
                <Seg label="动画" value="on" items={MOTION_ITEMS} onPick={() => {}} />
                <p className="set-hint" data-item="hint">
                  {MOTION_HINT}
                </p>
              </div>
              <div className="set-field" title="恢复成默认的部件和大小" data-item="field2">
                <span className="set-label" data-item="label2">
                  布局
                </span>
                <ConfirmButton onConfirm={() => {}} armedLabel="再点一次恢复">
                  恢复默认布局
                </ConfirmButton>
              </div>
            </section>
          </Now>
        }
        merged={
          <Merged className="sc-m-fields">
            <section className="ll-inset sc-m-skel-live" data-item="group">
              <b>外观</b>
              <Field layout="row" label="动画" hint={MOTION_HINT} data-item="field">
                <Seg label="动画" value="on" items={MOTION_ITEMS} onPick={() => {}} />
              </Field>
              <Field layout="row" label="布局" hint="恢复成默认的部件和大小" data-item="field2">
                <ConfirmButton onConfirm={() => {}} armedLabel="再点一次恢复">
                  恢复默认布局
                </ConfirmButton>
              </Field>
            </section>
          </Merged>
        }
      />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Compare
        id="link"
        title="链接：写出来的链接（.md-a）和自动认出的网址（a.hl-url），平常、悬停、键盘焦点"
        note="两种链接都用同一个 Link；键盘焦点环从「偏移 1、圆角 3」并进库统一的那一条（偏移 2）；悬停只在有鼠标时才变（@media (hover: hover)，桌面没有差别）。「自己气泡里的网址用白色」是聊天内容的特例，留在面板；「还没写完的链接」见下一块。"
        now={
          <Now>
            <div className="sc-env-text">
              <a className="md-a" href="https://example.com" data-item="a" data-state="normal">
                一篇笔记
              </a>{' '}
              <a
                className="md-a sc-hover"
                href="https://example.com"
                data-item="a"
                data-state="hover"
              >
                悬停
              </a>{' '}
              <a
                className="md-a sc-focus"
                href="https://example.com"
                data-item="a"
                data-state="focus"
              >
                焦点
              </a>
              <br />
              <a
                className="hl-url"
                href="https://example.com/very/long/path"
                data-item="u"
                data-state="normal"
              >
                https://example.com/very/long/path
              </a>
              <br />
              <a
                className="hl-url sc-hover"
                href="https://example.com"
                data-item="u"
                data-state="hover"
              >
                https://example.com
              </a>{' '}
              <a
                className="hl-url sc-focus"
                href="https://example.com"
                data-item="u"
                data-state="focus"
              >
                https://example.com
              </a>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-text">
              <Link href="https://example.com" data-item="a" data-state="normal">
                一篇笔记
              </Link>{' '}
              <Link
                className="sc-hover"
                href="https://example.com"
                data-item="a"
                data-state="hover"
              >
                悬停
              </Link>{' '}
              <Link
                className="sc-focus"
                href="https://example.com"
                data-item="a"
                data-state="focus"
              >
                焦点
              </Link>
              <br />
              <Link
                variant="auto"
                href="https://example.com/very/long/path"
                data-item="u"
                data-state="normal"
              >
                https://example.com/very/long/path
              </Link>
              <br />
              <Link
                variant="auto"
                className="sc-hover"
                href="https://example.com"
                data-item="u"
                data-state="hover"
              >
                https://example.com
              </Link>{' '}
              <Link
                variant="auto"
                className="sc-focus"
                href="https://example.com"
                data-item="u"
                data-state="focus"
              >
                https://example.com
              </Link>
            </div>
          </Merged>
        }
      />
      <Compare
        id="link-pending"
        title="链接：还没写完的链接（span.md-a.is-pending，不能点），平常、悬停"
        note="现在：.md-a 的样子再用 .is-pending 把手型改回继承、把悬停的颜色改回平常；归并后：span 加 ll-link，样子一样，手型和悬停变亮只给真的链接（:any-link），span 本来就没有，所以面板里 .md-a、.is-pending 的规则整个不用留。面板里的 Hl 不会画出不能点的 span.hl-url（认不出网址、或已经在链接里时画成普通文字），所以没有那一对。"
        now={
          <Now>
            <div className="sc-env-text">
              <span className="md-a is-pending" data-item="pending" data-state="normal">
                还没写完的链接
              </span>{' '}
              <span className="md-a is-pending sc-hover" data-item="pending" data-state="hover">
                悬停
              </span>
            </div>
          </Now>
        }
        merged={
          <Merged>
            <div className="sc-env-text">
              <span className="ll-link" data-item="pending" data-state="normal">
                还没写完的链接
              </span>{' '}
              <span className="ll-link sc-hover" data-item="pending" data-state="hover">
                悬停
              </span>
            </div>
          </Merged>
        }
      />
    </Group>
  );
}
