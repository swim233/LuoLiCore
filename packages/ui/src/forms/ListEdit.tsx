import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnimationEvent, KeyboardEvent } from 'react';
import { Button } from '../controls/Button';
import { cx } from '../controls/cx';
import { IconPlus, IconX } from '../icons';
import { useFormConfig } from './config';
import type { FormSize } from './config';
import { Input } from './Input';
import { blurAction, RELEASE_WAIT_MAX_MS, shouldPruneAfterRelease } from './list-blur';
import {
  defaultItemLabel,
  insertBlankAt,
  isDuplicateAt,
  normalizeItem,
  removeAt,
  updateAt,
} from './list-edit';
import type { ListRules } from './list-edit';
import {
  dropRow,
  firstBlankRow,
  initRows,
  insertRow,
  leaveRow,
  liveIndexOf,
  newRowId,
  pruneBlankRows,
  reconcileRows,
  settleRow,
} from './list-rows';
import type { Row } from './list-rows';

/* 列表编辑 ListEdit：一组能增、删的文字（以后设置里的唤醒词、白名单的群和用户）。值是 string[]，受控（value、onChange）、不受控（defaultValue）都认。
   一行一个输入框加删除钮，末尾「添加」：
   - 点「添加」多出一个空行并聚焦它（已经有一个空行时不再多加，回到那个空行）；在行里按回车，下面多出一个空行（这一行是空的就不加）；
     焦点离开整个列表时，空着的行自己消失（在行之间切换、点「添加」「删除」都不算离开）；删除钮删掉这一行；重复的行标红；
   - 空行消失的时机（list-blur.ts）：键盘 Tab 出去的马上消失；鼠标按下带走焦点的（点了保存钮、别的输入框、页面空白处……），等这一下鼠标抬起、click 走完再消失
     （不然空行一收起下面的东西往上挪，抬起时指针已经不在原来要点的东西上，这一下点击就丢了），拖着鼠标移开再抬起（不算点击）也一样消失；窗口失焦（切到别的窗口）不消失；
   - 增、删有动画：新的一行从 0 高长出来、同时淡入，下面的被平滑地推下去；删的那一行淡出、同时收到 0 高，下面的平滑地补上来。
     用的是纯 CSS 的关键帧（高度走 grid-template-rows 的 0fr 到 1fr，不引 JS 动画库；时长曲线同折叠，见 list-edit.css），初次渲染已有的行不播；
     关动画时（根上有 still 类，或系统减弱动画而根上没有 motion 类）不长不收，直接出现、消失；
   - 数据老实：点删除的那一刻 onChange 就把新数组给出去，不等动画；那一行在画面上多留一会儿（list-rows.ts 里的 leaving），期间不能点、不能聚焦、读屏读不到（inert、aria-hidden）；
     每一行有自己的 id，删的是被点的那一行（两行内容一样也不会删错）；连着快点（连加、连删、加了马上删、删到一半再加）每一步都认 id，不会乱；
   - 每一行的输入框有读屏的名字（itemLabel，默认「第 1 项」「第 2 项」……）；
   - 焦点：添加以后进新的那一行；删除以后到下一行的输入框，没有下一行就到上一行，都没有就到「添加」钮；
   规则（rules）：unique 不许重复（默认）、max 最多几项（满了「添加」变灰）、caseSensitive 区分大小写；规则在 list-edit.ts（纯函数）。
   编辑中的 value 里可能有空串（刚点了「添加」还没填的那一行），存下来、拿去用之前过一遍 list-edit.ts 的 cleanList。 */
export interface ListEditProps {
  value?: string[];
  defaultValue?: string[];
  onChange?: (items: string[]) => void;
  size?: FormSize;
  rules?: ListRules;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  addLabel?: string;
  /** 每一行输入框的读屏名字（第 i 项，i 从 0 数起）：默认「第 1 项」「第 2 项」…… */
  itemLabel?: (index: number) => string;
  /** 删除钮的读屏名字，给了这一项的文字：默认「删除 xxx」 */
  removeLabel?: (item: string) => string;
}

/** 受控、不受控都认的列表状态 */
function useList(value: string[] | undefined, defaultValue: string[] | undefined) {
  const [inner, setInner] = useState<string[]>(defaultValue ?? []);
  return [value ?? inner, setInner, value !== undefined] as const;
}

/** 动画没放出来（关动画时 CSS 写了 animation: none）的那些行，不会有 animationend，要自己收尾；动画真放着时不动它们 */
const noAnimation = (el: Element) => getComputedStyle(el).animationName === 'none';
/** 兜底：动画结束的事件万一没来（标签页被冻住之类），过这么久还没收尾的行强制收尾 */
const FALLBACK_MS = 800;

export function ListEdit({
  value,
  defaultValue,
  onChange,
  size,
  rules = {},
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
  addLabel = '添加',
  itemLabel = defaultItemLabel,
  removeLabel = (it) => (it ? `删除 ${it}` : '删除这一行'),
}: ListEditProps) {
  const cfg = useFormConfig({ size });
  const [items, setInner, controlled] = useList(value, defaultValue);
  /* 画面上的行（比数据多出正在离开的）。外面把数据整个换掉（长度对不上，比如「重置」）时在渲染里就地重来 */
  const [rows0, setRows] = useState<readonly Row[]>(() => initRows(items));
  const rows = reconcileRows(rows0, items);
  if (rows !== rows0) setRows(rows);
  const root = useRef<HTMLDivElement | null>(null);
  const addBtn = useRef<HTMLButtonElement | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const setEl = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    [],
  );
  const commit = (next: string[]) => {
    if (!controlled) setInner(next);
    onChange?.(next);
  };
  const full = rules.max !== undefined && items.length >= rules.max;

  /* 新加的行出来以后聚焦它 */
  useEffect(() => {
    if (pendingFocus === null) return;
    els.current.get(pendingFocus)?.querySelector('input')?.focus();
    setPendingFocus(null);
  }, [pendingFocus, rows]);
  /* 关动画时没有动画事件：直接收尾；动画开着时，收尾在 onAnimationEnd，这里的定时器只是兜底 */
  useLayoutEffect(() => {
    for (const r of rows) {
      if (r.phase === 'idle') continue;
      const el = els.current.get(r.id);
      if (el && noAnimation(el)) {
        const id = r.id;
        setRows((prev) => (r.phase === 'leaving' ? dropRow(prev, id) : settleRow(prev, id)));
      }
    }
  }, [rows]);
  useEffect(() => {
    const pending = rows.filter((r) => r.phase !== 'idle');
    if (pending.length === 0) return;
    const t = window.setTimeout(() => {
      setRows((prev) => pending.reduce((acc, r) => settleRow(dropRow(acc, r.id), r.id), prev));
    }, FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [rows]);

  const insertBlank = (liveIndex: number) => {
    if (full) return;
    const id = newRowId();
    setRows((prev) => insertRow(prev, liveIndex, id));
    commit(insertBlankAt(items, liveIndex, rules));
    setPendingFocus(id);
  };
  /* 「添加」钮：已经有一个空行（刚点过「添加」还没填）就回到那个空行，不再多加一行（连点几下也只有一个空行） */
  const addAtEnd = () => {
    const blank = firstBlankRow(rows, items);
    if (blank !== null) setPendingFocus(blank);
    else insertBlank(items.length);
  };
  /* 焦点离开整个列表时，空着的行一起收起来消失（在行之间切换、点「添加」「删除」都不算离开，不然钮会在鼠标按下时被挪走） */
  const pruneBlank = () => {
    const out = pruneBlankRows(rows, items);
    if (!out) return;
    setRows(out.rows);
    commit(out.items);
  };
  /* 鼠标按下带走焦点时，空行要等鼠标抬起、click 走完再收：记着鼠标按没按着（window 上抢在最前面听，按键也算「不是鼠标了」），
     失焦时按下了就登记一个「抬起以后再收」，抬起后过一个宏任务（click 就在抬起那一下里发完）再收；最多等 RELEASE_WAIT_MAX_MS。
     收的时候拿最新的 rows、items（按住期间可能变过），所以经 latest 这个 ref 调最新那一版 pruneBlank */
  const latest = useRef(pruneBlank);
  useLayoutEffect(() => {
    latest.current = pruneBlank;
  });
  const pointerDown = useRef(false);
  const deferPrune = useRef<() => void>(() => {});
  useEffect(() => {
    let waiting = false;
    let after = 0;
    let max = 0;
    const clear = () => {
      waiting = false;
      window.clearTimeout(after);
      window.clearTimeout(max);
    };
    const run = () => {
      if (!waiting) return;
      clear();
      if (shouldPruneAfterRelease(root.current?.contains(document.activeElement) ?? false))
        latest.current();
    };
    const onDown = () => {
      pointerDown.current = true;
    };
    const onUp = () => {
      pointerDown.current = false;
      if (waiting) {
        window.clearTimeout(after);
        after = window.setTimeout(run, 0);
      }
    };
    const onKey = () => {
      pointerDown.current = false;
    };
    deferPrune.current = () => {
      waiting = true;
      window.clearTimeout(max);
      max = window.setTimeout(run, RELEASE_WAIT_MAX_MS);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clear();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  /* 删一行：焦点先挪走（下一行、上一行、「添加」钮），再让这一行离开（离开的行是 inert 的，焦点还在里面会被浏览器丢掉） */
  const remove = (id: string) => {
    const i = liveIndexOf(rows, id);
    if (i < 0) return;
    const live = [
      ...(root.current?.querySelectorAll<HTMLInputElement>(
        '.ll-listedit-item:not([data-phase="leaving"]) input',
      ) ?? []),
    ];
    (live[i + 1] ?? live[i - 1] ?? addBtn.current)?.focus();
    setRows((prev) => leaveRow(prev, id, items[i] ?? ''));
    commit(removeAt(items, i));
  };
  const onEnd = (row: Row) => (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !e.animationName.startsWith('ll-listedit')) return;
    setRows((prev) => (row.phase === 'leaving' ? dropRow(prev, row.id) : settleRow(prev, row.id)));
  };

  let live = 0;
  return (
    <div
      ref={root}
      className={cx('ll-listedit', className)}
      data-size={cfg.size}
      role="group"
      aria-label={ariaLabel}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        const act = blurAction({
          toInside: next !== null && e.currentTarget.contains(next),
          toNothing: next === null,
          windowHasFocus: document.hasFocus(),
          pointerDown: pointerDown.current,
        });
        if (act === 'now') pruneBlank();
        else if (act === 'after-release') deferPrune.current();
      }}
    >
      <div className="ll-listedit-list">
        {rows.map((row, k) => {
          const leaving = row.phase === 'leaving';
          const i = leaving ? -1 : live++;
          const text = leaving ? row.text : (items[i] ?? '');
          const dup = !leaving && isDuplicateAt(items, i, rules);
          return (
            <div
              key={row.id}
              ref={setEl(row.id)}
              className="ll-listedit-item"
              data-phase={row.phase}
              inert={leaving}
              aria-hidden={leaving ? true : undefined}
              onAnimationEnd={onEnd(row)}
            >
              <div className="ll-listedit-item-in">
                <div className="ll-listedit-row">
                  <Input
                    size={cfg.size}
                    value={text}
                    aria-label={itemLabel(leaving ? k : i)}
                    placeholder={placeholder}
                    disabled={disabled}
                    invalid={dup}
                    title={dup ? '已经有了' : undefined}
                    onValueChange={(v) => commit(updateAt(items, i, v))}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (normalizeItem(text) !== null) insertBlank(i + 1);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ll-listedit-del"
                    aria-label={removeLabel(text)}
                    disabled={disabled}
                    onClick={() => remove(row.id)}
                  >
                    <IconX />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Button
        ref={addBtn}
        size={cfg.size}
        variant="ghost"
        className="ll-listedit-add"
        disabled={disabled || full}
        onClick={addAtEnd}
      >
        <IconPlus />
        {addLabel}
      </Button>
    </div>
  );
}
