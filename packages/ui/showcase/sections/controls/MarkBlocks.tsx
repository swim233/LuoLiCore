import { Badge, Chevron, Dot, Spinner, Tag } from '../../../src/controls';
import type { DotTone } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, Matrix, useStageKind } from './shared';

/* 「标签」「数字徽标」「状态点」「转圈」「小箭头」五块 */

export function TagBlock() {
  return (
    <Group id="ctl-tag" title="标签" sub="Tag · .ll-tag">
      <p className="sc-note">
        一小条不能点的字。data-variant：outline（默认，一圈细线）、soft（半透明底）；data-tone：默认、accent、star；data-size：sm（默认，高
        18）、md（高 22）。
      </p>
      <Matrix
        name="tag"
        rows={[
          ['outline', 'outline'],
          ['soft', 'soft'],
        ]}
        cols={[
          ['d-sm', '默认 · sm'],
          ['a-sm', 'accent · sm'],
          ['s-sm', 'star · sm'],
          ['d-md', '默认 · md'],
          ['s-md', 'star · md'],
        ]}
        render={(v, c) => (
          <Tag
            variant={v as 'outline' | 'soft'}
            tone={c.startsWith('a') ? 'accent' : c.startsWith('s') ? 'star' : undefined}
            size={c.endsWith('md') ? 'md' : undefined}
          >
            标签
          </Tag>
        )}
      />
      <p className="sc-note">
        点得开的小条（比如会话头部的「N 个任务」）用 ghost 的小按钮，不用标签：标签是不能点的。
      </p>
    </Group>
  );
}

export function BadgeBlock() {
  return (
    <Group id="ctl-badge" title="数字徽标" sub="Badge · .ll-badge">
      <p className="sc-note">
        最小 18×18、等宽数字、粗
        700；没有内容时留着位置、不显示。色调：star（默认，点睛色）、accent、neutral。
      </p>
      <Matrix
        name="badge"
        rows={[['badge', '徽标']]}
        cols={[
          ['star', 'star（默认）'],
          ['accent', 'accent'],
          ['neutral', 'neutral'],
          ['many', '三位数'],
          ['empty', '没有内容'],
        ]}
        render={(_, c) =>
          c === 'many' ? (
            <Badge>99+</Badge>
          ) : c === 'empty' ? (
            <Badge />
          ) : (
            <Badge tone={c === 'star' ? undefined : (c as 'accent' | 'neutral')}>3</Badge>
          )
        }
      />
    </Group>
  );
}

export function DotBlock() {
  return (
    <Group id="ctl-dot" title="状态点" sub="Dot · .ll-dot">
      <p className="sc-note">
        7px 的圆点，色调
        data-tone：默认（灰）、accent、quote、star（带光晕）、tool、warning、danger（带光晕）、ok。库里只认色调；状态名（等待、思考、回复……）对到哪种色调，是用它的项目自己的事。
      </p>
      <Matrix
        name="dot"
        rows={[['dot', '点']]}
        cols={[
          ['', '默认'],
          ['accent', 'accent'],
          ['quote', 'quote'],
          ['star', 'star'],
          ['tool', 'tool'],
          ['warning', 'warning'],
          ['danger', 'danger'],
          ['ok', 'ok'],
        ]}
        render={(_, c) => <Dot tone={(c || undefined) as DotTone | undefined} />}
      />
    </Group>
  );
}

export function SpinnerBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-spin" title="转圈" sub="Spinner · .ll-spin">
      <p className="sc-note">
        一个字符轮着换，所有转圈共用一个定时器；动画关掉时显示「⋯」。颜色默认点睛色，data-tone
        可以换。
      </p>
      <Stage kind={kind}>
        <div className="sc-row" data-demo="spinner">
          <span>
            默认 <Spinner />
          </span>
          <span>
            accent <Spinner tone="accent" />
          </span>
          <span>
            tool <Spinner tone="tool" />
          </span>
          <span>
            dim <Spinner tone="dim" />
          </span>
        </div>
      </Stage>
    </Group>
  );
}

export function ChevronBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-chev" title="小箭头" sub="Chevron · .ll-chev">
      <p className="sc-note">
        CSS 画的（不靠字体），颜色跟着文字，大小跟着字号。默认朝右，父元素
        aria-expanded=&quot;true&quot; 时转向下；data-dir 可以直接指定四个方向。
      </p>
      <Stage kind={kind}>
        <div className="sc-row" data-demo="chevrons">
          {(['right', 'down', 'left', 'up'] as const).map((d) => (
            <span key={d} className="sc-chev-demo">
              <Chevron dir={d} /> {d}
            </span>
          ))}
          <button
            className="sc-chev-btn"
            type="button"
            aria-expanded="false"
            onClick={(e) => {
              const b = e.currentTarget;
              b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true'));
            }}
          >
            点一下转向
            <Chevron />
          </button>
        </div>
      </Stage>
    </Group>
  );
}
