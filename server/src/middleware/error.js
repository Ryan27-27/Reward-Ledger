import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../logger.js';

/** One error contract for everything: { error: { code, message, requestId, details? } } */
export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const requestId = req.id;
  let status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong', details;

  if (err instanceof AppError) ({ status, code, message, details } = err);
  else if (err instanceof ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = 'Some fields are invalid';
    details = { fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.') || '_', i.message])) };
  } else if (err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'Malformed JSON body'; }
  else if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large'; }
  else if (err.code === '55000') { status = 409; code = 'LEDGER_IMMUTABLE'; message = 'Ledger records cannot be modified'; }
  else if (err.code === '23514' || err.code === '23505') { status = 409; code = 'CONSTRAINT_VIOLATION'; message = 'The request conflicts with current data'; }

  if (status >= 500) logger.error({ err, requestId }, 'unhandled error');
  else logger.debug({ code, requestId }, message);
  res.status(status).json({ error: { code, message, requestId, ...(details ? { details } : {}) } });
}
