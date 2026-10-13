import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ApiError, type FieldErrors } from '../core/ApiError';

export interface ValidationTargets {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function toFieldErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Parses AND replaces req.body/query/params with the validated output, so
 * controllers work with coerced, defaulted, stripped values rather than raw
 * strings. Unknown keys are dropped by the schemas, which is the cheapest
 * defence against mass-assignment.
 */
export function validate(targets: ValidationTargets) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: FieldErrors = {};

    for (const key of ['params', 'query', 'body'] as const) {
      const schema = targets[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (result.success) {
        // req.query is a getter in Express 5; assigning through defineProperty
        // keeps this working under both 4 and 5.
        Object.defineProperty(req, key, { value: result.data, writable: true, configurable: true });
      } else {
        Object.assign(errors, toFieldErrors(result.error));
      }
    }

    if (Object.keys(errors).length > 0) {
      next(ApiError.validation(errors));
      return;
    }
    next();
  };
}
