export class LuoLiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LuoLiError';
  }
}

export const assertNever = (value: never): never => {
  throw new LuoLiError('unreachable', `Unhandled value: ${String(value)}`);
};
