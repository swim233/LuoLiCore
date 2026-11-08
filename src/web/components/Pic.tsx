import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ImageInfo } from '../model/types';

/* 真实的图片：用服务给的地址（/api/files/…）显示，按原图比例占位（宽高已知时不会在加载后把列表顶开）。
   文件已经不在了（服务给 null）、或者加载失败，显示「图片已丢失」。
   box：放得下它的方框的边长（默认 260；「此刻」的终端里用小的）；宽高不知道时用 fallback（宽, 高） */
const BOX = 260;

export function Pic({
  info,
  name,
  box = BOX,
  fallback,
}: {
  info: ImageInfo | null | undefined;
  name?: string;
  box?: number;
  fallback?: [number, number];
}) {
  const [bad, setBad] = useState(false);
  if (!info || bad)
    return (
      <span className="pic is-lost" role="img" aria-label="图片已丢失">
        <span>图片已丢失</span>
      </span>
    );
  const style: CSSProperties = {};
  if (info.width && info.height) {
    const k = Math.min(1, box / info.width, box / info.height);
    style.width = Math.max(1, Math.round(info.width * k));
    style.height = Math.max(1, Math.round(info.height * k));
  } else if (fallback) {
    style.width = fallback[0];
    style.height = fallback[1];
  }
  return (
    <span className="pic" style={style}>
      <img
        src={info.src}
        alt={name || '图片'}
        decoding="async"
        draggable={false}
        onError={() => setBad(true)}
      />
    </span>
  );
}
