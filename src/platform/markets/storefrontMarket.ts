import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { logger } from '../../core/logger';
import { MissingRateError } from './fx';
import { marketContext, markets } from './markets';

/**
 * Prices a storefront request in the shopper's market.
 *
 * The country comes from `X-Veylog-Country` (the storefront's country picker)
 * or `?country=`. A country the store does not sell to, or one whose
 * currency has no rate yet, is shown the store's own prices — browsing never
 * fails over a currency; buying there is refused at the cart. Carts and
 * checkout carry their own country and do not rely on this.
 */
export async function storefrontMarket(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requested = (req.header('X-Veylog-Country') ?? (typeof req.query.country === 'string' ? req.query.country : '')).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(requested)) {
    next();
    return;
  }
  try {
    const market = await markets.forCountry(requested);
    if (!market) {
      res.setHeader('X-Veylog-Market', 'unavailable');
      next();
      return;
    }
    res.setHeader('X-Veylog-Currency', market.currency);
    marketContext.run(market, () => next());
  } catch (error) {
    if (error instanceof MissingRateError) {
      logger.warn('markets.rate_missing', { currency: error.currency });
      res.setHeader('X-Veylog-Market', 'unavailable');
      next();
      return;
    }
    next(error);
  }
}

/** The storefront's country picker: every country the store sells to, and its currency. */
export const storefrontMarketRoutes = Router();

storefrontMarketRoutes.get(
  '/markets',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ countries: await markets.catalogue(), current: marketContext.current().currency });
  }),
);
