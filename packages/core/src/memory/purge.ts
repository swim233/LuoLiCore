import { rmSync } from "node:fs";
import type { SdkSessionPurgeResult, SdkSessionRepository } from "@luoli/db";

/**
 * SDK 会话硬删的磁盘落地（docs/12-sdk.md T3.2）。`SdkSessionRepository.purge()` 只清库、
 * 回传该会话 primemory 文档的磁盘路径——db 层不碰文件系统，磁盘删除在这里完成。
 * `rmSync(..., { force: true })` 吞掉 ENOENT：文档从未写过（该会话没写过 primemory）
 * 与文件已被手工清理是同一种「删了等于没有」的结果，不需要调用方区分。
 */
export function purgeSdkSession(
  sessions: SdkSessionRepository,
  sourceId: string,
  key: string,
): SdkSessionPurgeResult | null {
  const result = sessions.purge(sourceId, key);
  if (!result) return null;
  for (const path of result.memoryDocPaths) rmSync(path, { force: true });
  return result;
}
