import { Badge, Button, Chevron, Dot, Spinner, Tag } from '../../../src/controls';
import type { DotTone } from '../../../src/controls';
import { LegacySpin } from '../../legacy/parts';
import { Stage } from '../../components/Stage';
import { Group, Items, Matrix, probe, useStageKind } from './shared';
import type { Item } from './shared';

/* 「标签」「数字徽标」「状态点」「转圈」「小箭头」五块 */

/* 洛璃的状态对到点的色调上：库里只认色调（现在的 .sdot[data-s=…] 用状态名） */
const DOT_STATES: readonly (readonly [string, string, DotTone | undefined])[] = [
  ['offline', '离线', undefined],
  ['idle', '空闲', 'ok'],
  ['waiting', '等待合并', 'accent'],
  ['thinking', '思考中', 'quote'],
  ['replying', '回复中', 'star'],
  ['tool', '调用工具', 'tool'],
  ['retry', '重试中', 'warning'],
  ['error', '出错', 'danger'],
];

const TAG_ITEMS: Item[] = [
  {
    id: 'pchip',
    title: '平台标记（.pchip）',
    now: (
      <div className="sc-row">
        <span className="pchip" {...probe('now', 'pchip')}>
          Telegram 群
        </span>
        <span className="pchip">CLI</span>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Tag {...probe('merged', 'pchip')}>Telegram 群</Tag>
        <Tag>CLI</Tag>
      </div>
    ),
    note: '不变：字号 11、左右内边距 8、高 18（现在靠行高 18）、一圈细线都一样。',
  },
  {
    id: 'task-count',
    title: '会话头部的「N 个任务」（.pchip.task-count）',
    now: (
      <div className="sc-row">
        <button
          className="pchip task-count"
          type="button"
          aria-expanded="false"
          {...probe('now', 'task-count')}
        >
          3 个任务
          <span className="chev" aria-hidden="true" />
        </button>
        <button
          className="pchip task-count"
          type="button"
          aria-expanded="true"
          {...probe('now', 'task-count', 'expanded')}
        >
          3 个任务
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Button variant="ghost" size="xs" aria-expanded="false" {...probe('merged', 'task-count')}>
          3 个任务
          <Chevron />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-expanded="true"
          {...probe('merged', 'task-count', 'expanded')}
        >
          3 个任务
          <Chevron />
        </Button>
      </div>
    ),
    note: '这个是点得开的，不能用不能点的 Tag，换成 ghost 的小按钮（xs）：那一圈细线没有了，展开着时仍是亮的底；字号 11→12；箭头两边的空隙并进 gap。',
  },
  {
    id: 'ribbon',
    title: '设置里的提示小条（.ribbon）',
    now: (
      <span className="ribbon" {...probe('now', 'ribbon')}>
        还不能在这里修改设置：这里以后放表单
      </span>
    ),
    merged: (
      <Tag variant="soft" tone="star" size="md" {...probe('merged', 'ribbon')}>
        还不能在这里修改设置：这里以后放表单
      </Tag>
    ),
    note: '字号 12 不变，左右内边距 11→10；现在靠行高加上下内边距 3（约 23），换成 md：高 22。底和字色（点睛色混 75%）不变。',
  },
  {
    id: 'fold-tag',
    title: '思考被中止的小条（.fold-tag）',
    ctxStyle: { lineHeight: 1.6 },
    now: (
      <div className="fold is-think">
        <span className="fold-tag" {...probe('now', 'fold-tag')}>
          思考被中止
        </span>
      </div>
    ),
    merged: (
      <div className="fold is-think">
        <Tag
          variant="soft"
          tone="accent"
          style={{ fontStyle: 'italic' }}
          {...probe('merged', 'fold-tag')}
        >
          思考被中止
        </Tag>
      </div>
    ),
    note: '字号 11.5→11，左右内边距 9→8，高约 18.4→18；底（强调色 14%）、字色、斜体都不变（斜体留在面板里）。',
  },
];

const BADGE_ITEMS: Item[] = [
  {
    id: 'badge',
    title: '会话列表的未读数（.conv-unread）',
    now: (
      <div className="sc-row">
        <span className="conv-unread" {...probe('now', 'badge', 'one')}>
          3
        </span>
        <span className="conv-unread" {...probe('now', 'badge', 'many')}>
          99+
        </span>
        <span className="conv-unread" {...probe('now', 'badge', 'empty')} />
        <span className="sc-dim">（最右边没有数字，留着位置、不显示）</span>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Badge {...probe('merged', 'badge', 'one')}>3</Badge>
        <Badge {...probe('merged', 'badge', 'many')}>99+</Badge>
        <Badge {...probe('merged', 'badge', 'empty')} />
        <span className="sc-dim">（最右边没有数字，留着位置、不显示）</span>
      </div>
    ),
    note: '左右内边距 5→4（一位数时被最小宽 18 盖住，看不出；「99+」窄约 2px）；颜色、字号 11、粗 700、等宽数字、没有内容时不显示都不变。',
  },
];

const DOT_ITEMS: Item[] = [
  {
    id: 'dot',
    title: '各群的状态点（.sdot[data-s]）',
    mode: 'switch',
    now: (
      <div className="sc-dots">
        {DOT_STATES.map(([s, text]) => (
          <div className="sc-row" key={s}>
            <span className="sdot" data-s={s} {...probe('now', 'dot', s)} />
            <span>{text}</span>
          </div>
        ))}
      </div>
    ),
    merged: (
      <div className="sc-dots">
        {DOT_STATES.map(([s, text, tone]) => (
          <div className="sc-row" key={s}>
            <Dot tone={tone} {...probe('merged', 'dot', s)} />
            <span>{text}</span>
          </div>
        ))}
      </div>
    ),
    note: '不变：7px、颜色、回复中和出错带光晕都一样。库里只认色调，面板把状态对上去：离线→默认灰、空闲→ok、等待合并→accent、思考中→quote、回复中→star、调用工具→tool、重试中→warning、出错→danger。',
  },
];

const SPIN_ITEMS: Item[] = [
  {
    id: 'spin',
    title: '转圈（.spin）',
    now: (
      <div className="sc-row">
        <span>
          洛璃正在回复
          <LegacySpin {...probe('now', 'spin')} />
        </span>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <span>
          洛璃正在回复
          <Spinner style={{ marginLeft: '0.6ch' }} {...probe('merged', 'spin')} />
        </span>
      </div>
    ),
    note: '不变：同样的字符、同样的 80 毫秒、同样的点睛色，动画关掉时都是「⋯」。左边的空隙（0.6ch）留在面板里。',
  },
];

const CHEV_ITEMS: Item[] = [
  {
    id: 'chev',
    title: '文字按钮里的小箭头（.chev）',
    now: (
      <div className="sc-row">
        <button className="task-more" type="button" aria-expanded="false" {...probe('now', 'chev')}>
          已结束（3）
          <span className="chev" aria-hidden="true" />
        </button>
        <button
          className="task-more"
          type="button"
          aria-expanded="true"
          {...probe('now', 'chev', 'expanded')}
        >
          已结束（3）
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <button
          className="task-more"
          type="button"
          aria-expanded="false"
          {...probe('merged', 'chev')}
        >
          已结束（3）
          <Chevron style={{ margin: '0 0.2em 0 0.5em' }} />
        </button>
        <button
          className="task-more"
          type="button"
          aria-expanded="true"
          {...probe('merged', 'chev', 'expanded')}
        >
          已结束（3）
          <Chevron style={{ margin: '0 0.2em 0 0.5em' }} />
        </button>
      </div>
    ),
    note: '大小 0.38em、线宽 1.5px、转向的过渡都不变；原来的箭头为了贴着文字的基线往上挪了一点（朝右 0.12em，朝下 0.22em），在居中对齐的按钮里偏高，库里改成居中：朝右的往下挪约 1.4px、朝下的往下挪约 0.5px（看起来都是真正居中）。两边的空隙（margin）留在面板里（这里的按钮是面板自己的 .task-more，不是库的按钮）。',
  },
];

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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={TAG_ITEMS} />
      <p className="sc-note">
        会话头部的「N 个任务」是点得开的，所以用 ghost 的小按钮，不用标签（见上面第二个对比块）。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={BADGE_ITEMS} />
    </Group>
  );
}

export function DotBlock() {
  return (
    <Group id="ctl-dot" title="状态点" sub="Dot · .ll-dot">
      <p className="sc-note">
        7px 的圆点，色调
        data-tone：默认（灰）、accent、quote、star（带光晕）、tool、warning、danger（带光晕）、ok。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={DOT_ITEMS} />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={SPIN_ITEMS} />
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={CHEV_ITEMS} />
    </Group>
  );
}
