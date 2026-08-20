import sharp from 'sharp';

export interface NormalizedImage {
  path: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * 进上下文之前的图片归一化：转正 EXIF 方向、按 `maxEdge` 缩到框内、统一转 JPEG。
 *
 * **抽出来是为了只有一份。** 此前它只长在 `telegram/media.ts` 里，于是「Telegram 发来的图
 * 归一化了、`web_fetch` 抓回来的图没有」是必然会发生的第二种形状 —— 而不归一化的代价是真的：
 * 一张 6000×4000 的原图按 provider 的分块计价能顶掉半个上下文窗口，`media.maxImageEdge`
 * （1568）正是照 Anthropic 那条不再细分的边长定的。
 *
 * 输入收 `Buffer` 而不只是路径：调用方手里往往已经有字节了（`web_fetch` 的响应体、MCP 的
 * base64），先写一遍盘再读回来纯属白费。而且**这样结构性地避开了 W-MEDIA-01**：那次是
 * 输入输出同名，sharp 直接抛 `Cannot use same file for input and output`，catch 把它记成
 * 「处理失败」，多模态输入 100% 不可用。
 */
export async function normalizeImage(source: Buffer | string, target: string, maxEdge: number): Promise<NormalizedImage> {
  const info = await sharp(source).rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toFile(target);
  return { path: target, bytes: info.size, width: info.width, height: info.height };
}
