/* 分段选择：一排互斥的按钮（aria-pressed 表示当前项）。设置里的「外观」和开发模式的演示面板共用 */
export function Seg({
  id,
  value,
  items,
  onPick,
  label,
  labelledBy,
}: {
  id?: string;
  value: string;
  /** [值, 按钮文字, 悬停说明] */
  items: [string, string, string?][];
  onPick: (v: string) => void;
  label?: string;
  labelledBy?: string;
}) {
  return (
    <div className="seg-ctl" id={id} role="group" aria-label={label} aria-labelledby={labelledBy}>
      {items.map(([v, text, title]) => (
        <button
          key={v}
          type="button"
          data-v={v}
          title={title}
          aria-pressed={String(value) === v}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
