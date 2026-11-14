import { useState } from 'react';
import { Badge, Button, Row, RowButton } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, Matrix, PanelEnv, useStageKind } from './shared';

/* 「列表行」一块：会话列表的行、任务的行。悬停高亮（glide）在特效那一步，这里的行自己没有悬停的样子 */

interface Conv {
  id: string;
  p: string;
  ico: string;
  title: string;
  last: string;
  time: string;
  n?: number;
  event?: boolean;
}
const CONVS: Conv[] = [
  {
    id: 'a',
    p: 'group',
    ico: '群',
    title: '星空观测站',
    last: '洛璃：好的，周六早上八点北门集合',
    time: '11:20',
    n: 3,
  },
  { id: 'b', p: 'private', ico: '私', title: '小明', last: '周五提醒我交周报', time: '昨天' },
  {
    id: 'c',
    p: 'web',
    ico: '网',
    title: '这是一个特别特别特别长的会话标题用来看超出省略',
    last: '任务到点 · 提醒小明交周报',
    time: '周一',
    event: true,
  },
];

function MergedConv({ c, st, sel }: { c: Conv; st: string; sel?: boolean }) {
  return (
    <div className="sc-m-liwrap">
      <RowButton
        className={`sc-m-conv ${st === 'focus' ? 'sc-focus' : ''}`}
        selected={sel ?? false}
        lead={
          <span className="conv-ico" data-p={c.p} aria-hidden="true">
            {c.ico}
          </span>
        }
        title={c.title}
        sub={c.event ? <span className="sc-m-event">{c.last}</span> : c.last}
        side={
          <>
            <span className="ll-row-meta">{c.time}</span>
            <Badge>{c.n ? String(c.n) : ''}</Badge>
          </>
        }
      />
    </div>
  );
}
const CONV_STATES: readonly (readonly [string, Conv, boolean | undefined])[] = [
  ['normal', CONVS[1], undefined],
  ['new', CONVS[0], undefined],
  ['selected', CONVS[0], true],
  ['focus', CONVS[1], undefined],
  ['long', CONVS[2], undefined],
];

const TASKS = [
  {
    id: 't1',
    action: '每天 08:00 提醒小明吃早餐，顺便说说今天的天气和空气质量',
    meta: '每天 08:00 · 小明 让建的 · 星空观测站',
    next: '明天 08:00',
  },
  { id: 't2', action: '提醒交周报', meta: '周五 18:00 · 小红 让建的', next: '周五 18:00' },
];
function MergedTask({ st, ended, ask }: { st: string; ended?: boolean; ask?: boolean }) {
  const t = TASKS[st === 'long' ? 0 : 1];
  return (
    <div className="sc-m-liwrap">
      <Row
        wrap
        className={`sc-m-task ${ended ? 'is-ended' : ''}`}
        title={t.action}
        sub={t.meta}
        side={
          ended ? (
            <>
              <span className="sc-m-state">已完成</span>
              <span className="sc-m-at">昨天 08:00</span>
            </>
          ) : (
            <>
              <span className="sc-m-next">{t.next}</span>
              {!ask && (
                <Button size="sm" className="task-cancel">
                  取消
                </Button>
              )}
            </>
          )
        }
      >
        {ask && (
          <div className="ll-row-full sc-m-ask" role="group" aria-label="取消这个任务？">
            <span>取消这个任务？</span>
            <Button size="sm" variant="danger" data-armed>
              确认
            </Button>
            <Button size="sm">算了</Button>
          </div>
        )}
      </Row>
    </div>
  );
}
const TASK_STATES: readonly (readonly [string, boolean, boolean])[] = [
  ['live', false, false],
  ['long', false, false],
  ['ended', true, false],
  ['asking', false, true],
];

export function RowBlock() {
  const kind = useStageKind();
  const [cur, setCur] = useState('a');
  const [clicks, setClicks] = useState(0);
  const [ask, setAsk] = useState(false);
  return (
    <Group id="ctl-row" title="列表行" sub="Row · .ll-row">
      <p className="sc-note">
        一行：可选的头（<code>.ll-row-lead</code>，左边的图标位）、主区（标题{' '}
        <code>.ll-row-title</code>、下面的次要文字 <code>.ll-row-sub</code>）、右边的一列（
        <code>.ll-row-side</code>，竖着排、靠右，里面的小字用 <code>.ll-row-meta</code>
        ）；行后面可以接占满整行的东西（<code>.ll-row-full</code>）。内边距 9 10、圆角
        12、平常没有底。 两种排法：默认一行一行截断（上下居中，会话的行）、<code>data-wrap</code>{' '}
        能折行（顶对齐、行高 1.55，任务的行）。 选中（<code>aria-current="true"</code>
        ）：左边一道强调色的光条加向右淡出的底，标题变白。 根可以是 button（<code>RowButton</code>
        ，整行能点、手型）也可以是 div（<code>Row</code>，行里另有按钮）。
        键盘焦点环画在行里面。字号：标题 13、次要文字 12、右边的小字 11；头、主区、右列之间隔 12。
        <b>
          {' '}
          悬停高亮（跟着鼠标滑的那块）在「特效」那一步
        </b>，这一批的行自己没有悬停的样子；行是 <code>position: relative</code>
        、自成一个层叠上下文、自己没有不透明的底，不会挡住它。
      </p>
      <Stage kind={kind}>
        <div className="sc-fold-demos">
          <div>
            <span className="sc-stage-tag">
              RowButton：点、回车、空格都能选中（点了 <b data-demo-count="row">{clicks}</b> 次）
            </span>
            <div className="sc-m-list" data-demo="row-list" role="list">
              {CONVS.map((c) => (
                <div role="listitem" className="sc-m-liwrap" key={c.id}>
                  <RowButton
                    className="sc-m-conv"
                    selected={cur === c.id}
                    data-demo={`row-${c.id}`}
                    onClick={() => {
                      setCur(c.id);
                      setClicks((n) => n + 1);
                    }}
                    lead={
                      <span className="conv-ico" data-p={c.p} aria-hidden="true">
                        {c.ico}
                      </span>
                    }
                    title={c.title}
                    sub={c.event ? <span className="sc-m-event">{c.last}</span> : c.last}
                    side={
                      <>
                        <span className="ll-row-meta">{c.time}</span>
                        <Badge>{c.n ? String(c.n) : ''}</Badge>
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <span className="sc-stage-tag">
              Row（div）：行里另有按钮，能折行，后面接占满整行的确认
            </span>
            <div className="sc-m-list" data-demo="row-tasks">
              <div className="sc-m-liwrap">
                <Row
                  wrap
                  className="sc-m-task"
                  data-demo="row-task"
                  title="每天 08:00 提醒小明吃早餐，顺便说说今天的天气和空气质量"
                  sub="每天 08:00 · 小明 让建的"
                  side={
                    <>
                      <span className="sc-m-next">明天 08:00</span>
                      {!ask && (
                        <Button size="sm" onClick={() => setAsk(true)} data-demo="row-task-cancel">
                          取消
                        </Button>
                      )}
                    </>
                  }
                >
                  {ask && (
                    <div className="ll-row-full sc-m-ask" role="group" aria-label="取消这个任务？">
                      <span>取消这个任务？</span>
                      <Button size="sm" variant="danger" data-armed data-demo="row-task-ok">
                        确认
                      </Button>
                      <Button size="sm" onClick={() => setAsk(false)} data-demo="row-task-no">
                        算了
                      </Button>
                    </div>
                  )}
                </Row>
              </div>
            </div>
          </div>
        </div>
      </Stage>
      <h4 className="sc-h4">各种状态（键盘焦点是强制显示的）</h4>
      <Matrix
        name="row"
        rows={[
          ['conv', '会话的行（RowButton）'],
          ['task', '任务的行（Row wrap）'],
        ]}
        cols={[
          ['normal', '平常'],
          ['selected', '选中'],
          ['focus', '键盘焦点'],
        ]}
        render={(row, col) => (
          <div style={{ width: 230 }} className="sc-m-list">
            {row === 'conv' ? (
              <RowButton
                className={`sc-m-conv ${col === 'focus' ? 'sc-focus' : ''}`}
                selected={col === 'selected'}
                lead={
                  <span className="conv-ico" aria-hidden="true">
                    群
                  </span>
                }
                title="星空观测站"
                sub="洛璃：周六八点集合"
                side={<span className="ll-row-meta">11:20</span>}
              />
            ) : (
              <Row
                wrap
                tabIndex={0}
                className={`sc-m-task ${col === 'focus' ? 'sc-focus' : ''}`}
                selected={col === 'selected'}
                title="提醒交周报"
                sub="周五 18:00 · 小红 让建的"
                side={<span className="sc-m-next">周五</span>}
              />
            )}
          </div>
        )}
      />
      <h4 className="sc-h4">
        列表行：会话的行（.conv-item），平常、有新消息、选中、键盘焦点、标题很长
      </h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-list">
            <div className="sc-m-list">
              {CONV_STATES.map(([st, c, sel]) => (
                <MergedConv key={st} c={c} st={st} sel={sel} />
              ))}
            </div>
          </div>
        </PanelEnv>
      </Stage>
      <h4 className="sc-h4">列表行：任务的行（.task-row），进行中、标题很长、已结束、取消确认</h4>
      <Stage kind={kind}>
        <PanelEnv>
          <div className="sc-env-list">
            <div className="sc-m-list">
              {TASK_STATES.map(([st, ended, ask]) => (
                <MergedTask key={st} st={st} ended={ended} ask={ask} />
              ))}
            </div>
          </div>
        </PanelEnv>
      </Stage>
    </Group>
  );
}
