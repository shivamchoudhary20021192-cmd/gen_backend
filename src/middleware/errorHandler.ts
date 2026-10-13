import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ApiError, type ErrorCode } from '../core/ApiError';
import { logger } from '../core/logger';
import { env } from '../config/env';
import { TenantContextError } from '../platform/tenancy/context';
import { TenantIsolationError } from '../platform/tenancy/guard';

interface MysqlError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

/**
 * The single exit point for every failure in the process. Nothing else in the
 * codebase writes an error response.
 *
 * Two jobs: map known infrastructure errors onto the public contract, and make
 * absolutely sure an unknown error never leaks a stack trace, a SQL string or a
 * table name to the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = 500;
  let code: ErrorCode = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side.';
  let details: unknown;
  let retryAfter: number | undefined;

  if (err instanceof ApiError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
    retryAfter = err.retryAfterSeconds;
  } else if (err instanceof MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds the ${Math.round(env.storage.maxUploadBytes / 1024 / 1024)}MB limit.`
        : `Upload rejected: ${err.message}`;
  } else if (err instanceof SyntaxError && 'body' in err) {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON.';
  } else if (err instanceof TenantIsolationError || err instanceof TenantContextError) {
    // A 500 to the client like any other bug — but its own event, because a
    // query that tried to cross shops is the one bug that is also a breach.
    logger.error('tenancy.isolation_blocked', {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      shop_id: req.shop?.id ?? null,
      reason: err.message,
      statement: err instanceof TenantIsolationError ? err.sql : undefined,
    });
  } else if (isMysqlError(err)) {
    const mapped = mapMysqlError(err);
    status = mapped.status;
    code = mapped.code;
    message = mapped.message;
  }

  // 5xx is a bug in our code; log everything we have. 4xx is the client's
  // problem; log it at warn without the stack so the logs stay readable.
  if (status >= 500) {
    logger.error('request.failed', {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      admin_id: req.admin?.id ?? null,
      shop_id: req.shop?.id ?? null,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger.warn('request.rejected', {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      admin_id: req.admin?.id ?? null,
      shop_id: req.shop?.id ?? null,
      status,
      code,
    });
  }

  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));

  res.status(status).json({
    error: {
      code,
      message,
      request_id: req.requestId,
      ...(details ? { details } : {}),
    },
  });
}

function isMysqlError(err: unknown): err is MysqlError {
  return err instanceof Error && typeof (err as MysqlError).code === 'string' && (err as MysqlError).code!.startsWith('ER_');
}

function mapMysqlError(err: MysqlError): { status: number; code: ErrorCode; message: string } {
  switch (err.code) {
    case 'ER_DUP_ENTRY': {
      // "Duplicate entry 'x' for key 'products.uq_products_slug'"
      const keyMatch = /for key '(?:[^.]+\.)?([^']+)'/.exec(err.sqlMessage ?? '');
      const key = keyMatch?.[1] ?? '';
      if (key.includes('slug')) return { status: 409, code: 'SLUG_TAKEN', message: 'That slug is already in use.' };
      if (key.includes('sku')) return { status: 409, code: 'SKU_TAKEN', message: 'That SKU is already in use.' };
      if (key.includes('email')) return { status: 409, code: 'EMAIL_TAKEN', message: 'That email address is already registered.' };
      return { status: 409, code: 'CONFLICT', message: 'That record already exists.' };
    }
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return { status: 422, code: 'VALIDATION_FAILED', message: 'A referenced record does not exist.' };
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return { status: 409, code: 'IN_USE', message: 'This record is still referenced by other data.' };
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return { status: 422, code: 'VALIDATION_FAILED', message: 'A value fell outside its allowed range.' };
    case 'ER_DATA_TOO_LONG':
      return { status: 422, code: 'VALIDATION_FAILED', message: 'A value is too long for its field.' };
    case 'ER_LOCK_DEADLOCK':
      return { status: 409, code: 'CONFLICT', message: 'The request conflicted with another write. Please retry.' };
    default:
      return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' };
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl.split('?')[0]}`,
      request_id: req.requestId,
    },
  });
}
