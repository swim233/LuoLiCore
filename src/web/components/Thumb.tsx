import type { CSSProperties } from 'react';
import type { ImagePart } from '../model/types';

/* 缩略图：生成的色块代替图片（真实的图片只出现在网页对话里用户自己拖进来的） */
export function Thumb({
  part,
  w,
  h,
}: {
  part: Partial<ImagePart> & { blob?: string };
  w?: number;
  h?: number;
}) {
  const style: CSSProperties = {};
  if (w) {
    style['--tw'] = w + 'px';
    style['--th'] = h + 'px';
  }
  if (part.blob) {
    style['--img'] = `url("${part.blob}")`;
    return (
      <span className="thumb is-real" role="img" aria-label={part.name || '图片'} style={style} />
    );
  }
  const d = part.demo || { h1: 230, h2: 40, label: '图片' };
  style['--h1'] = d.h1;
  style['--h2'] = d.h2;
  return (
    <span className="thumb" role="img" aria-label={'图片 ' + d.label} style={style}>
      <span>{d.label}</span>
    </span>
  );
}
