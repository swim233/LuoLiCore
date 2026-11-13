import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copy';

/* 等宽字的名字，点一下复制；复制了在右边写一下「已复制」 */
export function CopyName({ name, className = '' }: { name: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(name);
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1300);
  };
  return (
    <span className={`sc-name-wrap ${className}`}>
      <button
        type="button"
        className="sc-name"
        data-copy={name}
        title="点一下复制"
        onClick={onClick}
      >
        {name}
      </button>
      <span className="sc-copied" aria-live="polite">
        {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : ''}
      </span>
    </span>
  );
}
