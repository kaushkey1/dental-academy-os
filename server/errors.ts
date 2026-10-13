export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'INVALID_REQUEST',
  ) {
    super(message);
  }
}
export function requireValue<T>(value: T | null | undefined, message = 'Record not found'): T {
  if (value == null) throw new AppError(404, message, 'NOT_FOUND');
  return value;
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, message);
}
