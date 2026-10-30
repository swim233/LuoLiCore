/** 核心使用的日志接口，结构与 pino 实例兼容。`msg` 写事件名，如 `reply.end`。 */
export type Logger = {
  info(fields: object, msg: string): void;
  warn(fields: object, msg: string): void;
  error(fields: object, msg: string): void;
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
