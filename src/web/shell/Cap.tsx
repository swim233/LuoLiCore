import { memo, useLayoutEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Badge } from '../components/Badge';
import { SLOW } from '../lib/debug';
import { desk, getDef, useDesk, useWidgetRefresh } from '../state/desk';
import { expand, hideWidget } from '../state/actions';
import { PopoverTrigger } from '@luoli/ui/overlay';
import { popHandle } from '../state/ui';
import { setFace } from './faces';
import { dragStart, wasDragged } from './drag';

/* 胶囊（缩略）：图标（「此刻」是状态徽记）、部件名、缩略文字 */
export const Cap = memo(function Cap({ id, island = false }: { id: string; island?: boolean }) {
  const def = getDef(id)!;
  useWidgetRefresh(def);
  const calling = useDesk((s) => id === 'now' && s.calling);
  const placeholder = useDesk((s) => id === 'now' && s.nowFloat && !island);
  const flip = useDesk((s) => s.flip);
  const ad = useDesk((s) => s.stagger[id]);
  const textRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const thumb = def.thumb();
  useLayoutEffect(() => {
    if (btnRef.current && textRef.current)
      btnRef.current.setAttribute(
        'aria-label',
        `${def.name}：${textRef.current.textContent}。单击展开`,
      );
  });
  const capBtn = (
    <button
      ref={(el) => {
        btnRef.current = el;
        if (!island) setFace(id, 'capBtn')(el);
      }}
      className={'cap ll-sky' + (id === 'now' ? ' cap-now' : '') + (calling ? ' is-calling' : '')}
      data-shape="pill"
      type="button"
      title="单击展开"
      onClick={() => {
        if (desk.get().arranging || wasDragged()) return;
        expand(id);
      }}
      onPointerDown={(ev) => {
        dragStart(ev, id, 'cap');
      }}
    >
      <i className="w-edge" />
      <span className="cap-icon">{id === 'now' ? <Badge size={26} /> : def.icon}</span>
      <span className="cap-name">{def.name}</span>
      <span className="cap-text" ref={textRef}>
        {thumb}
      </span>
    </button>
  );
  const inner = (
    <>
      {id === 'now' ? (
        <PopoverTrigger handle={popHandle} openOnHover delay={0} closeDelay={0} render={capBtn} />
      ) : (
        capBtn
      )}
      <button
        className="cap-x"
        type="button"
        title="收进收纳盒"
        aria-label={'把' + def.name + '收进收纳盒'}
        onClick={() => hideWidget(id)}
      >
        ×
      </button>
    </>
  );
  const props = {
    className: 'cap-wrap' + (placeholder ? ' is-placeholder-float' : ''),
    'data-id': id,
    ...(placeholder ? { 'data-placeholder': '' } : {}),
    style: ad != null ? { '--ad': ad + 'ms' } : undefined,
  };
  if (island) {
    return (
      <div ref={setFace(id, 'cap')} {...props}>
        {inner}
      </div>
    );
  }
  return (
    <motion.div
      ref={setFace(id, 'cap')}
      layout="position"
      transition={{ layout: { duration: flip.dur * SLOW, ease: flip.ease } }}
      {...props}
    >
      {inner}
    </motion.div>
  );
});
