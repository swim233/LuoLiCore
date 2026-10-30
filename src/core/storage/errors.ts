/**
 * 同一会话里已经有这条平台消息（platform_message_id 相同）。平台重发已处理过的更新时会遇到，
 * 前端据此认出重复，不当成错误
 */
export class DuplicateMessageError extends Error {
  constructor(readonly platformMessageId: string) {
    super(`平台消息 ${platformMessageId} 已经写入过`);
    this.name = 'DuplicateMessageError';
  }
}
