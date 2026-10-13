import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tenancy } from '../platform/tenancy/context';

/**
 * Express 4 does not catch rejected promises from async handlers — an
 * unhandled rejection there silently hangs the request. Every controller and
 * async middleware is wrapped in this so failures reach the error handler.
 *
 * The request type is a parameter so a handler mounted behind `authenticate`
 * can declare `AuthRequest` and read `req.admin` without a non-null assertion on
 * every line. Express itself only ever hands us a plain `Request`, so the
 * narrowing is asserted here, once, where the reason it is safe can be written
 * down: the route that mounts the handler is what guarantees the middleware ran.
 *
 * It also re-enters the request's shop. The resolver puts the shop into async
 * context, but middleware that finishes on a stream event — multer, notably —
 * calls `next()` from a callback that belongs to the socket rather than to the
 * request, and the context does not survive that hop. `req.shop` does, so the
 * handler is always run inside it.
 */
export function asyncHandler<R extends Request = Request>(
  fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const run = () => Promise.resolve(fn(req as R, res, next)).catch(next);
    const shop = req.shop;
    if (shop && tenancy.currentOrNull()?.id !== shop.id) {
      tenancy.run(shop, run);
      return;
    }
    run();
  };
}
