export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (code, msg, d) => new AppError(400, code, msg, d);
export const unauthorized = (msg = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, msg);
export const forbidden = (code, msg) => new AppError(403, code, msg);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, msg, d) => new AppError(409, code, msg, d);
export const tooMany = (code, msg) => new AppError(429, code, msg);
