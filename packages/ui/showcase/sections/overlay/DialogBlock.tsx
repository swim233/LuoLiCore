import { useState } from 'react';
import { Button } from '../../../src/controls';
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../../../src/overlay';
import type { DialogSize } from '../../../src/overlay';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「对话框和确认框」一块：三种大小、内容很长、里面再开确认框、普通确认和危险确认（窗体是夜空窗口的底，和部件窗口一个样） */
const SIZES: readonly (readonly [DialogSize, string])[] = [
  ['sm', '小 360'],
  ['md', '中 480'],
  ['lg', '大 640'],
];

function Sized({ size }: { size: DialogSize }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" />} data-dlg={`size-${size}`}>
        {SIZES.find(([s]) => s === size)?.[1]}
      </DialogTrigger>
      <DialogContent size={size} closable>
        <DialogTitle>设置分组</DialogTitle>
        <DialogDescription>
          宽度 {size === 'sm' ? 360 : size === 'md' ? 480 : 640}，不超过视口减 32。
        </DialogDescription>
        <DialogBody>
          <p>
            对话框打开后，焦点进到里面，Tab
            在里面转圈出不去；Esc、点遮罩、右上角的关闭都能关，关了焦点回到打开它的按钮。
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>关闭</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Long() {
  return (
    <Dialog>
      <DialogTrigger render={<Button />} data-dlg="long">
        内容很长
      </DialogTrigger>
      <DialogContent closable>
        <DialogTitle>用户协议</DialogTitle>
        <DialogDescription>标题和按钮不动，只有中间这一块滚。</DialogDescription>
        <DialogBody data-demo="dlg-body">
          {Array.from({ length: 40 }, (_, i) => (
            <p key={i}>
              第 {i + 1}{' '}
              条：这里是很长的一段文字，用来让内容超出对话框的高度。滚轮在这一块里滚、带缓动；在遮罩上滚，后面的页面不会跟着走。
            </p>
          ))}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>不同意</DialogClose>
          <DialogClose render={<Button variant="primary" />}>同意</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Nested() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div className="sc-ov-cell">
      <Dialog>
        <DialogTrigger render={<Button />} data-dlg="nested">
          里面再开确认框
        </DialogTrigger>
        <DialogContent closable>
          <DialogTitle>会话设置</DialogTitle>
          <DialogDescription>
            在对话框里再开确认框：后面这一层稍微退后、变暗，确认框落在它上面。
          </DialogDescription>
          <DialogBody>
            <p>删除这个会话会连它的任务一起删掉。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="danger" onClick={() => setOpen(true)} data-dlg="nested-open">
              删除会话…
            </Button>
            <DialogClose render={<Button />}>关闭</DialogClose>
          </DialogFooter>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            tone="danger"
            title="真的删除吗？"
            description="删了就找不回来了。"
            confirmLabel="删除"
            onConfirm={() => setNote('在嵌套的确认框里点了「删除」')}
          />
        </DialogContent>
      </Dialog>
      <span className="sc-ov-cap" data-demo="dlg-nested-note">
        {note}
      </span>
    </div>
  );
}

function Confirms() {
  const [note, setNote] = useState('');
  return (
    <div className="sc-ov-cell">
      <div className="sc-ov-icons">
        <ConfirmDialog
          trigger={<Button data-dlg="confirm">普通确认</Button>}
          title="恢复默认布局？"
          description="部件的位置和大小会回到默认的样子。"
          confirmLabel="恢复"
          onConfirm={() => setNote('普通确认：点了「恢复」')}
          onOpenChange={(o, d) =>
            !o && d.reason !== 'close-press' && setNote(`普通确认：关了（${d.reason}）`)
          }
        ></ConfirmDialog>
        <ConfirmDialog
          trigger={
            <Button variant="danger" data-dlg="confirm-danger">
              危险确认
            </Button>
          }
          tone="danger"
          title="清空这个会话？"
          description="全部消息会一起删掉，删掉以后找不回来。点遮罩关不掉，Esc 能关。"
          confirmLabel="清空"
          onConfirm={() => setNote('危险确认：点了「清空」')}
          onOpenChange={(o, d) =>
            !o && d.reason !== 'close-press' && setNote(`危险确认：关了（${d.reason}）`)
          }
        />
      </div>
      <span className="sc-ov-cap" data-demo="dlg-confirm-note">
        {note || '（点了以后这里写结果）'}
      </span>
    </div>
  );
}

export function DialogBlock() {
  return (
    <Group id="ov-dialog" title="对话框和确认框" sub="Dialog · ConfirmDialog · .ll-dialog">
      <p className="sc-note">
        要人停下来处理的一块浮层：窗体是夜空窗口的底（和部件窗口一个样），遮罩只压暗、不模糊；模态，焦点锁在里面，后面的页面不能点、不能滚；Esc、点遮罩、关闭按钮都能关，关了焦点回到打开它的按钮。
        <b>确认框</b>（<code>ConfirmDialog</code>）是对话框的一种：点遮罩不关、Esc
        能关；点「确认」先调 <code>onConfirm</code>{' '}
        再关；打开时危险的确认框焦点落在「取消」上、普通的落在「确认」上。库已有的两步确认按钮（
        <code>ConfirmButton</code>）不动，两样并存：行内的小操作用两步按钮，要说清后果的用确认框。
      </p>
      <p className="sc-note">
        用法：
        <code>
          &lt;Dialog&gt;&lt;DialogTrigger render={'{<Button />}'}&gt;…&lt;DialogContent size
          closable&gt;&lt;DialogTitle&gt;
          &lt;DialogDescription&gt;&lt;DialogBody&gt;&lt;DialogFooter&gt;…
        </code>
        。<code>size</code> 小 360、中 480（默认）、大 640，宽度不超过视口减 32；
        <code>closable</code> 右上角加关闭按钮；内容多时只有 <code>DialogBody</code>{' '}
        滚（超出时它自己进 Tab 顺序，键盘能滚）；<code>container</code>{' '}
        同别的浮层。对话框里再开菜单、弹出框、提示气泡：不用传 <code>container</code>
        （它们会挂在对话框里面，盖在窗体上面）；要传就传对话框里面的元素，别传挂在{' '}
        <code>&lt;body&gt;</code>{' '}
        上的（会被对话框盖在下面）。传对话框里面的元素也有后果：浮层被那个元素和{' '}
        <code>DialogBody</code> 的 overflow
        裁掉，长的菜单、弹出框会被裁，所以一般什么都不传。确认框：
        <code>
          &lt;ConfirmDialog open onOpenChange title description confirmLabel cancelLabel tone
          onConfirm /&gt;
        </code>
        ，或不受控时给 <code>trigger</code>。
      </p>
      <Stage kind="page">
        <div className="sc-ov-row-demo" data-demo="dlg-real">
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">三种大小</span>
            <div className="sc-ov-icons">
              {SIZES.map(([s]) => (
                <Sized key={s} size={s} />
              ))}
            </div>
          </div>
          <div className="sc-ov-cell">
            <span className="sc-ov-cap">内容很长（DialogBody 里滚）</span>
            <Long />
          </div>
          <Nested />
          <Confirms />
        </div>
      </Stage>
    </Group>
  );
}
