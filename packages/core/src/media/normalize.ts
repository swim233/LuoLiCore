import sharp from "sharp";

export interface NormalizedImage {
  path: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * 进入上下文之前的图片归一化：修正 EXIF 方向、按 `maxEdge` 缩放至框内、统一转为 JPEG。
 *
 * 单独抽出以保证只有一份实现。此前它只存在于 `telegram/media.ts`，于是 Telegram 发来的图片
 * 已归一化而 `web_fetch` 抓取的图片未归一化必然成为第二种形态，而不归一化的代价是实际存在的：
 * 一张 6000×4000 的原图按 provider 的分块计价可占用半个上下文窗口，`media.maxImageEdge`
 * （1568）正是依据 Anthropic 不再细分的那个边长设定的。
 *
 * 输入接收 `Buffer` 而不仅是路径：调用方通常已持有字节（`web_fetch` 的响应体、MCP 的
 * base64），先写盘再读回是无谓开销。同时这在结构上规避了 W-MEDIA-01：那次是
 * 输入输出同名，sharp 直接抛出 `Cannot use same file for input and output`，catch 将其记为
 * 处理失败，导致多模态输入完全不可用。
 */
export async function normalizeImage(
  source: Buffer | string,
  target: string,
  maxEdge: number,
): Promise<NormalizedImage> {
  const info = await sharp(source)
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toFile(target);
  return {
    path: target,
    bytes: info.size,
    width: info.width,
    height: info.height,
  };
}
