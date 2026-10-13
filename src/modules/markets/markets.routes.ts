import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { execute, insert, query, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { exchangeRate, fx, hasRate } from '../../platform/markets/fx';
import { markets, type MarketRow } from '../../platform/markets/markets';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';

/**
 * Settings → Markets, at /admin/api/:version/markets: the countries a store
 * sells to beyond its own, grouped into markets with a currency each.
 *
 * The primary market is the store's own country in its own currency; it can
 * gain countries but not be deleted, switched off, or change currency.
 */
export const marketsRoutes = Router();
marketsRoutes.use(authenticate);

const country = z.string().trim().length(2).transform((value) => value.toUpperCase()).refine((value) => /^[A-Z]{2}$/.test(value), 'Use a two-letter country code.');
const marketBody = z.object({
  name: z.string().trim().min(1).max(120),
  countries: z.array(country).min(1, 'A market needs at least one country.').max(250),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  price_adjustment_percent: z.coerce.number().min(-50).max(200).default(0),
  rounding: z.enum(['none', 'whole', 'ninety_nine']).default('none'),
  is_active: z.boolean().default(true),
});
const id = z.object({ id: z.coerce.number().int().positive() });

function who(req: Request) {
  return { actorId: req.admin!.id, actorLabel: req.admin!.email, ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null };
}

async function rows() {
  const [list, countries] = await Promise.all([
    query<MarketRow>('SELECT id, name, currency, price_adjustment_percent, rounding, is_primary, is_active FROM markets WHERE shop_id = ? ORDER BY is_primary DESC, name', [shopId()]),
    query<RowDataPacket & { market_id: number; country_code: string }>('SELECT market_id, country_code FROM market_countries WHERE shop_id = ? ORDER BY country_code', [shopId()]),
  ]);
  const shop = tenancy.current();
  return Promise.all(
    list.map(async (row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      price_adjustment_percent: Number(row.price_adjustment_percent),
      rounding: row.rounding,
      is_primary: row.is_primary === 1,
      is_active: row.is_active === 1,
      countries: countries.filter((entry) => Number(entry.market_id) === row.id).map((entry) => entry.country_code),
      // What one unit of the store's currency is worth here; null: no rate yet.
      rate: (await hasRate(row.currency)) ? await exchangeRate(shop.currency, row.currency) : row.currency === shop.currency ? 1 : null,
    })),
  );
}

/** Countries already in another market, for a clear refusal. */
async function assertCountriesFree(codes: string[], exceptMarketId: number | null, exec?: Parameters<typeof query>[2]) {
  if (codes.length === 0) return;
  const taken = await query<RowDataPacket & { country_code: string; name: string }>(
    `SELECT mc.country_code, m.name FROM market_countries mc JOIN markets m ON m.id = mc.market_id AND m.shop_id = mc.shop_id
      WHERE mc.shop_id = ? AND mc.country_code IN (${codes.map(() => '?').join(', ')}) AND (? IS NULL OR mc.market_id <> ?)`,
    [shopId(), ...codes, exceptMarketId, exceptMarketId],
    exec,
  );
  if (taken.length > 0) {
    throw ApiError.conflict(`${taken.map((row) => `${row.country_code} is in "${row.name}"`).join('; ')}. A country is in one market.`);
  }
}

async function assertSellableCurrency(currency: string) {
  if (currency !== tenancy.current().currency && !(await hasRate(currency))) {
    throw ApiError.validation({ currency: [`There is no exchange rate for ${currency} yet, so prices cannot be shown in it.`] });
  }
}

async function replaceCountries(marketId: number, codes: string[], exec: Parameters<typeof execute>[2]) {
  await execute('DELETE FROM market_countries WHERE shop_id = ? AND market_id = ?', [shopId(), marketId], exec);
  for (const code of [...new Set(codes)]) {
    await execute('INSERT INTO market_countries (shop_id, market_id, country_code) VALUES (?, ?, ?)', [shopId(), marketId, code], exec);
  }
}

marketsRoutes.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ markets: await rows() });
  }),
);

/** The currencies a market can be priced in: those with an exchange rate. */
marketsRoutes.get(
  '/currencies',
  requirePermission('settings.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    const shop = tenancy.current();
    const table = await fx.list();
    const own = table.find((row) => row.currency === shop.currency);
    res.json({
      store_currency: shop.currency,
      currencies: table.map((row) => ({
        currency: row.currency,
        // One unit of the store's currency in this one.
        rate: own ? Number(row.per_usd) / Number(own.per_usd) : row.currency === shop.currency ? 1 : null,
        source: row.source,
        updated_at: row.updated_at,
      })),
    });
  }),
);

marketsRoutes.post(
  '/',
  requirePermission('settings.manage'),
  validate({ body: marketBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof marketBody>;
    const shop = tenancy.current();
    if (body.countries.includes(shop.countryCode)) throw ApiError.validation({ countries: [`${shop.countryCode} is the store's own country, in its primary market.`] });
    const currency = body.currency ?? shop.currency;
    await assertSellableCurrency(currency);
    let marketId: number;
    try {
      marketId = await withTransaction(async (tx) => {
        await assertCountriesFree(body.countries, null, tx);
        const created = await insert(
          'INSERT INTO markets (shop_id, name, currency, price_adjustment_percent, rounding, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [shopId(), body.name, currency, body.price_adjustment_percent, body.rounding, body.is_active ? 1 : 0],
          tx,
        );
        await replaceCountries(created, body.countries, tx);
        return created;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw ApiError.conflict(`There is already a market called "${body.name}".`);
      throw error;
    }
    markets.invalidate();
    await auditService.log({ ...who(req), action: 'markets.created', entityType: 'market', entityId: marketId, summary: `Selling to ${body.countries.join(', ')} in ${currency}`, changes: body });
    res.status(201).json({ market: (await rows()).find((market) => market.id === marketId) });
  }),
);

marketsRoutes.patch(
  '/:id',
  requirePermission('settings.manage'),
  validate({ params: id, body: marketBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    const marketId = Number(req.params.id);
    const body = req.body as Partial<z.infer<typeof marketBody>>;
    const shop = tenancy.current();
    const existing = (await rows()).find((market) => market.id === marketId);
    if (!existing) throw ApiError.notFound('Market');
    if (existing.is_primary) {
      if (body.currency && body.currency !== shop.currency) throw ApiError.validation({ currency: ['The primary market is priced in the store\'s own currency.'] });
      if (body.is_active === false) throw ApiError.validation({ is_active: ['The primary market cannot be switched off.'] });
      if (body.countries && !body.countries.includes(shop.countryCode)) throw ApiError.validation({ countries: [`The primary market always includes ${shop.countryCode}.`] });
    } else if (body.countries?.includes(shop.countryCode)) {
      throw ApiError.validation({ countries: [`${shop.countryCode} is the store's own country, in its primary market.`] });
    }
    if (body.currency) await assertSellableCurrency(body.currency);
    try {
      await withTransaction(async (tx) => {
        await execute(
          `UPDATE markets SET name = COALESCE(?, name), currency = COALESCE(?, currency),
                  price_adjustment_percent = COALESCE(?, price_adjustment_percent), rounding = COALESCE(?, rounding),
                  is_active = COALESCE(?, is_active)
            WHERE shop_id = ? AND id = ?`,
          [
            body.name ?? null,
            body.currency ?? null,
            body.price_adjustment_percent ?? null,
            body.rounding ?? null,
            body.is_active === undefined ? null : body.is_active ? 1 : 0,
            shopId(),
            marketId,
          ],
          tx,
        );
        if (body.countries) {
          await assertCountriesFree(body.countries, marketId, tx);
          await replaceCountries(marketId, body.countries, tx);
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw ApiError.conflict(`There is already a market called "${body.name}".`);
      throw error;
    }
    markets.invalidate();
    await auditService.log({ ...who(req), action: 'markets.updated', entityType: 'market', entityId: marketId, summary: `Updated market "${existing.name}"`, changes: body });
    res.json({ market: (await rows()).find((market) => market.id === marketId) });
  }),
);

marketsRoutes.delete(
  '/:id',
  requirePermission('settings.manage'),
  validate({ params: id }),
  asyncHandler(async (req: Request, res: Response) => {
    const marketId = Number(req.params.id);
    const existing = (await rows()).find((market) => market.id === marketId);
    if (!existing) throw ApiError.notFound('Market');
    if (existing.is_primary) throw ApiError.conflict('The primary market cannot be deleted.');
    await execute('DELETE FROM markets WHERE shop_id = ? AND id = ?', [shopId(), marketId]);
    markets.invalidate();
    await auditService.log({ ...who(req), action: 'markets.deleted', entityType: 'market', entityId: marketId, summary: `Stopped selling to ${existing.countries.join(', ')}` });
    res.json({ deleted: true });
  }),
);
