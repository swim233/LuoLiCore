import { useRef } from 'react';
import { Button } from '../../../src/controls';
import { toast } from '../../../src/overlay';
import { Seg } from '../../components/Seg';
import { Stage } from '../../components/Stage';
import {
  TOAST_DURATIONS,
  chooseToastDuration,
  setToasterOn,
  useToastDuration,
} from '../../lib/overlay-prefs';
import { Group } from '../controls/shared';

/* 「toast」一块：停留时间的试用、各种 toast、连发五条、原地更新、全部关掉、Toaster 挂上之前发的补得出来 */
export function ToastBlock() {
  const duration = useToastDuration();
  const n = useRef(0);
  const pre = () => {
    /* 卸掉 Toaster，在它不在的时候连发两条，再挂回去：这两条要补得出来 */
    setToasterOn(false);
    setTimeout(() => {
      toast('Toaster 还没挂上时发的第 1 条');
      toast('Toaster 还没挂上时发的第 2 条', { tone: 'danger' });
      setTimeout(() => setToasterOn(true), 500);
    }, 100);
  };
  return (
    <Group id="ov-toast" title="toast" sub="toast() · Toaster · .ll-toast">
      <p className="sc-note">
        操作结果的一句话提示，出现在底部居中，过一会儿自己消失。
        <code>toast(message, options?)</code> 是普通函数，React
        外面也能调（面板现在就是在普通模块里调的），返回 id；页面里只挂一次{' '}
        <code>&lt;Toaster /&gt;</code>（挂两个，每条会显示两遍）。最多同时显示 3
        条（从下往上一条条排开，每条都看得全，最新的在最下面），再来就把最旧的顶掉；鼠标移上去、焦点在里面时全部暂停计时；能往下划掉；带按钮的按钮能点；出错的（
        <code>tone="danger"</code>）读屏会马上念。
      </p>
      <p className="sc-note">
        options：<code>tone</code>（'danger' 或不写）、<code>title</code>（有它时 message
        是下面的说明）、<code>action</code>（<code>{'{ label, onClick }'}</code>，点了先调 onClick
        再关）、<code>duration</code>（毫秒，0 不自动消失）、<code>id</code>
        （给已有的 id 就原地更新）。<code>
          toast.dismiss(id?)
        </code> 关一条或全部。离底的距离是变量 <code>--ll-toast-bottom</code>（默认 24）。
        <code>&lt;Toaster /&gt;</code> 挂上之前调的 <code>toast()</code>{' '}
        不会丢：库里先存着，挂上时补发（下面有演示）。
      </p>
      <div className="sc-ov-lookbar">
        <b>停留时间：</b>
        <Seg<number>
          label="toast 的停留时间"
          value={duration}
          items={TOAST_DURATIONS.map((d) => [d, `${d / 1000} 秒`] as const)}
          onPick={chooseToastDuration}
        />
        <span className="sc-ov-cap">面板现在是 2.6 秒；默认 4 秒（Base UI 默认 5 秒）。</span>
      </div>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="toast-buttons">
          <Button onClick={() => toast('布局恢复成默认的了')} data-toast="short">
            一句话
          </Button>
          <Button
            onClick={() =>
              toast(
                '这是很长的一句话，用来看多行的 toast 是什么样子：文字折成几行，圆角从胶囊变成圆角的块，最宽是 420 像素或者视口减 32。',
              )
            }
            data-toast="long"
          >
            很长的一句
          </Button>
          <Button
            onClick={() => toast('请求失败（429），已重试 2 次', { tone: 'danger' })}
            data-toast="danger"
          >
            出错的
          </Button>
          <Button
            onClick={() =>
              toast('已删除这个会话', {
                action: { label: '撤销', onClick: () => toast('已撤销') },
              })
            }
            data-toast="action"
          >
            带按钮的
          </Button>
          <Button
            onClick={() => toast('部件的位置和大小回到默认的样子。', { title: '布局已恢复' })}
            data-toast="title"
          >
            带标题的
          </Button>
          <Button
            onClick={() => {
              for (let i = 1; i <= 5; i++) toast(`连发的第 ${i} 条`);
            }}
            data-toast="five"
          >
            连发五条（一口气）
          </Button>
          <Button
            onClick={() => {
              for (let i = 1; i <= 5; i++) setTimeout(() => toast(`陆续来的第 ${i} 条`), i * 450);
            }}
            data-toast="five-slow"
          >
            陆续来五条
          </Button>
          <Button
            onClick={() => {
              n.current += 1;
              toast(`原地更新的这一条：第 ${n.current} 次`, { id: 'demo-update', duration: 0 });
            }}
            data-toast="update"
          >
            原地更新一条
          </Button>
          <Button onClick={() => toast.dismiss()} data-toast="dismiss">
            全部关掉
          </Button>
          <Button onClick={pre} data-toast="pre">
            挂上之前发的补得出来
          </Button>
        </div>
      </Stage>
      <p className="sc-note">
        「原地更新一条」不自动消失（<code>duration: 0</code>
        ），多点几次看文字原地换、计时重来；用「全部关掉」或划掉它。
      </p>
    </Group>
  );
}
