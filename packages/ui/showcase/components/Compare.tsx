import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Seg } from './Seg';
import { Stage } from './Stage';
import type { StageKind } from './Stage';

/* 对比块：左边「现在」、右边「归并后」，各自一个舞台，舞台的底可以选页面底或夜空窗口的底，下面一行说明。
   以后各批控件都用它新旧对照给用户看（第 4 步起）。两种看法，右上角的「看法」可以切（mode 是一开始的，默认并排）：
   - 并排：左右各一个舞台（现在的样子）；
   - 原地切换：只有一个舞台，上面一个「现在 / 归并后」的分段选择，点一下在同一个位置换内容（不做过渡，直接换，
     差得少的（半号字只差 0.5px）并排看不出来，原地换才看得出）；键盘左右键也能换。
   stage 是舞台一开始的底（page 页面底 / sky 夜空窗口的底），右上角的切换可以改 */
export type CompareMode = 'side' | 'switch';
type View = 'now' | 'merged';

export function Compare({
  title,
  now,
  merged,
  nowLabel = '现在',
  mergedLabel = '归并后',
  note,
  stage = 'sky',
  mode: initialMode = 'side',
}: {
  title: ReactNode;
  now: ReactNode;
  merged: ReactNode;
  nowLabel?: ReactNode;
  mergedLabel?: ReactNode;
  note?: ReactNode;
  stage?: StageKind;
  mode?: CompareMode;
}) {
  const [kind, setKind] = useState<StageKind>(stage);
  const [mode, setMode] = useState<CompareMode>(initialMode);
  const [view, setView] = useState<View>('now');
  /* 原地切换时：左键是「现在」，右键是「归并后」（焦点在分段选择的按钮上或舞台上都行） */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setView('now');
    else if (e.key === 'ArrowRight') setView('merged');
    else return;
    e.preventDefault();
  };
  return (
    <figure className="sc-cmp" data-compare="" data-mode={mode}>
      <header className="sc-cmp-head">
        <h4 className="sc-cmp-title">{title}</h4>
        <div className="sc-cmp-heads">
          <Seg<CompareMode>
            label="看法"
            value={mode}
            items={[
              ['side', '并排'],
              ['switch', '原地切换'],
            ]}
            onPick={setMode}
          />
          <Seg<StageKind>
            label="舞台的底"
            value={kind}
            items={[
              ['page', '页面底'],
              ['sky', '夜空窗口'],
            ]}
            onPick={setKind}
          />
        </div>
      </header>
      {mode === 'side' ? (
        <div className="sc-cmp-pair">
          <div className="sc-cmp-side" data-side="now">
            <div className="sc-cmp-label">{nowLabel}</div>
            <Stage kind={kind}>{now}</Stage>
          </div>
          <div className="sc-cmp-side" data-side="merged">
            <div className="sc-cmp-label is-merged">{mergedLabel}</div>
            <Stage kind={kind}>{merged}</Stage>
          </div>
        </div>
      ) : (
        <div className="sc-cmp-switch" data-view={view} onKeyDown={onKey}>
          <div className="sc-cmp-switchbar">
            <Seg<View>
              label="现在或归并后"
              value={view}
              items={[
                ['now', '现在'],
                ['merged', '归并后'],
              ]}
              onPick={setView}
            />
            <span
              className={`sc-cmp-label ${view === 'merged' ? 'is-merged' : ''}`}
              data-caption=""
            >
              {view === 'now' ? nowLabel : mergedLabel}
            </span>
            <span className="sc-cmp-hint">← → 键也能换</span>
          </div>
          <Stage kind={kind}>
            <div
              className="sc-cmp-view"
              tabIndex={0}
              role="group"
              aria-label={view === 'now' ? '现在' : '归并后'}
              data-view-content={view}
            >
              {view === 'now' ? now : merged}
            </div>
          </Stage>
        </div>
      )}
      {note && <figcaption className="sc-cmp-note">{note}</figcaption>}
    </figure>
  );
}
