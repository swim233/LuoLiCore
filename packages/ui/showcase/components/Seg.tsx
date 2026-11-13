/* 展示页自己的分段选择（工具栏、对比块的舞台切换、曲线的时长用）：一排互斥的按钮，aria-pressed 表示当前项。
   这是展示页版面用的，不是库的控件（库的分段选择在第 4 步） */
export function Seg<T extends string | number>({
  label,
  value,
  items,
  onPick,
}: {
  label: string;
  value: T;
  items: readonly (readonly [T, string])[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="sc-seg" role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          data-v={String(v)}
          aria-pressed={v === value}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
